import {
  CommandId,
  McpServerId,
  ProjectMcpNameConflictError,
  ProjectMcpServer,
  type ProjectId,
  type ProjectMcpCatalog,
  type ProjectMcpCreateInput,
  type ProjectMcpRemoveInput,
  type ProjectMcpUpdateInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

const PROJECT_MCP_SERVER_LIMIT = 50;

const ProjectMcpProjectionRow = Schema.Struct({
  serverId: McpServerId,
  name: Schema.String,
  url: Schema.String,
  enabled: Schema.Number,
  providerInstanceIds: Schema.String,
});

const decodeProjectMcpServer = Schema.decodeUnknownEffect(ProjectMcpServer);
const decodeProviderInstanceIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProviderInstanceId)),
);

const foldName = (name: string): string => name.toLocaleLowerCase();

const isAllowedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.search === ""
    );
  } catch {
    return false;
  }
};

export interface ProjectMcpServiceShape {
  readonly list: (projectId: ProjectId) => Effect.Effect<ProjectMcpCatalog, Error>;
  readonly create: (input: ProjectMcpCreateInput) => Effect.Effect<ProjectMcpServer, Error>;
  readonly update: (input: ProjectMcpUpdateInput) => Effect.Effect<ProjectMcpServer, Error>;
  readonly remove: (input: ProjectMcpRemoveInput) => Effect.Effect<void, Error>;
  readonly resolveForSession: (
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ProjectMcpServer>, Error>;
}

export class ProjectMcpService extends Context.Service<ProjectMcpService, ProjectMcpServiceShape>()(
  "t3/project/ProjectMcpService",
) {}

const makeProjectMcpService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const providerInstances = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;

  const list: ProjectMcpServiceShape["list"] = (projectId) =>
    sql<Schema.Schema.Type<typeof ProjectMcpProjectionRow>>`
      SELECT
        server_id AS "serverId",
        name,
        url,
        enabled,
        provider_instance_ids_json AS "providerInstanceIds"
      FROM projection_project_mcp_servers
      WHERE project_id = ${projectId}
      ORDER BY name COLLATE NOCASE ASC, server_id ASC
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeProviderInstanceIds(row.providerInstanceIds).pipe(
            Effect.flatMap((providerInstanceIds) =>
              decodeProjectMcpServer({
                id: row.serverId,
                name: row.name,
                url: row.url,
                enabled: row.enabled === 1,
                providerInstanceIds,
              }),
            ),
          ),
        ),
      ),
      Effect.map((external) => ({
        external,
        // Adapter capabilities arrive in Task 3. Until then, mode ownership
        // stays on the server and conservatively reports unsupported.
        applications: external.flatMap((entry) =>
          entry.providerInstanceIds.map((providerInstanceId) => ({
            serverId: entry.id,
            providerInstanceId,
            mode: "unsupported" as const,
          })),
        ),
        // Preview MCP is session-scoped and remains outside catalog persistence.
        // Task 3 supplies its concrete managed read-model entry with the
        // session capability matrix.
        managed: [],
      })),
    );

  const validateUrl = (url: string, commandType: string) =>
    isAllowedUrl(url)
      ? Effect.void
      : Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType,
            detail:
              "MCP URLs must use HTTPS or loopback HTTP and cannot include userinfo or a query string.",
          }),
        );

  const validateProviderIds = (
    providerInstanceIds: ReadonlyArray<ProviderInstanceId>,
    previouslyPersistedIds: ReadonlyArray<ProviderInstanceId> = [],
  ) =>
    providerInstances.listInstances.pipe(
      Effect.flatMap((instances) => {
        const knownIds = new Set(instances.map((instance) => instance.instanceId));
        const retainedIds = new Set(previouslyPersistedIds);
        const unknownId = providerInstanceIds.find(
          (instanceId) => !knownIds.has(instanceId) && !retainedIds.has(instanceId),
        );
        return unknownId === undefined
          ? Effect.void
          : Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "project.mcp-server",
                detail: `Provider instance '${unknownId}' is not configured in this environment.`,
              }),
            );
      }),
    );

  const validateName = (projectId: ProjectId, name: string, exceptId: string | undefined) =>
    list(projectId).pipe(
      Effect.flatMap((catalog) => {
        const duplicate = catalog.external.find(
          (entry) => entry.id !== exceptId && foldName(entry.name) === foldName(name),
        );
        return duplicate === undefined
          ? Effect.void
          : Effect.fail(
              new ProjectMcpNameConflictError({
                name,
                message: `Project already contains an MCP server named '${name}'.`,
              }),
            );
      }),
    );

  const create: ProjectMcpServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      yield* validateUrl(input.url, "project.mcp-server.create");
      const catalog = yield* list(input.projectId);
      if (catalog.external.length >= PROJECT_MCP_SERVER_LIMIT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "project.mcp-server.create",
          detail: `Project '${input.projectId}' cannot contain more than ${PROJECT_MCP_SERVER_LIMIT} MCP servers.`,
        });
      }
      yield* validateName(input.projectId, input.name, undefined);
      yield* validateProviderIds(input.providerInstanceIds);
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const serverId = McpServerId.make(yield* crypto.randomUUIDv4);
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      const server: ProjectMcpServer = {
        id: serverId,
        name: input.name,
        url: input.url,
        enabled: input.enabled,
        providerInstanceIds: input.providerInstanceIds,
      };
      yield* engine.dispatch({
        type: "project.mcp-server.create",
        commandId,
        projectId: input.projectId,
        server,
        createdAt: now,
      });
      return server;
    });

  const update: ProjectMcpServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      yield* validateUrl(input.url, "project.mcp-server.update");
      const catalog = yield* list(input.projectId);
      const existing = catalog.external.find((entry) => entry.id === input.id);
      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "project.mcp-server.update",
          detail: `Project '${input.projectId}' does not contain MCP server '${input.id}'.`,
        });
      }
      yield* validateName(input.projectId, input.name, input.id);
      yield* validateProviderIds(input.providerInstanceIds, existing.providerInstanceIds);
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      const server: ProjectMcpServer = {
        id: input.id,
        name: input.name,
        url: input.url,
        enabled: input.enabled,
        providerInstanceIds: input.providerInstanceIds,
      };
      yield* engine.dispatch({
        type: "project.mcp-server.update",
        commandId,
        projectId: input.projectId,
        server,
        updatedAt: now,
      });
      return server;
    });

  const remove: ProjectMcpServiceShape["remove"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      yield* engine.dispatch({
        type: "project.mcp-server.remove",
        commandId,
        projectId: input.projectId,
        id: input.id,
        removedAt: now,
      });
    });

  const resolveForSession: ProjectMcpServiceShape["resolveForSession"] = (
    projectId,
    providerInstanceId,
  ) =>
    list(projectId).pipe(
      Effect.map((catalog) =>
        catalog.external.filter(
          (entry) => entry.enabled && entry.providerInstanceIds.includes(providerInstanceId),
        ),
      ),
    );

  return ProjectMcpService.of({ list, create, update, remove, resolveForSession });
});

export const layer = Layer.effect(ProjectMcpService, makeProjectMcpService);
