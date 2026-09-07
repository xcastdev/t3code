import {
  CommandId,
  McpServerId,
  ProjectMcpNameConflictError,
  ProjectMcpProviderNotFoundError,
  ProjectMcpServer,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
  ProjectMcpTransport,
  getProjectMcpTransport,
  type ProjectId,
  type ProjectMcpCatalog,
  type ProjectMcpCreateInput,
  type ProjectMcpRemoveInput,
  type ProjectMcpUpdateInput,
  type ResolvedProjectMcpServer,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getMcpEndpoint } from "../mcp/McpSessionRegistry.ts";
import * as ProjectMcpSecretStore from "../mcp/ProjectMcpSecretStore.ts";
import * as ProjectMcpOAuth from "../mcp/ProjectMcpOAuth.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

const PROJECT_MCP_SERVER_LIMIT = 50;
const MANAGED_PREVIEW_MCP_ID = McpServerId.make("t3-code");

const ProjectMcpProjectionRow = Schema.Struct({
  serverId: McpServerId,
  name: Schema.String,
  url: Schema.String,
  transportJson: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  providerInstanceIds: Schema.String,
});

const decodeProjectMcpServer = Schema.decodeUnknownEffect(ProjectMcpServer);
const decodeProjectMcpTransportJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMcpTransport),
);
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

export interface AcquiredProjectMcpSessionServers {
  readonly servers: ReadonlyArray<ResolvedProjectMcpServer>;
  readonly resolveSecret: (serverId: McpServerId, credentialId: string) => string | undefined;
}

export interface ProjectMcpServiceShape {
  readonly list: (projectId: ProjectId) => Effect.Effect<ProjectMcpCatalog, Error>;
  readonly create: (input: ProjectMcpCreateInput) => Effect.Effect<ProjectMcpServer, Error>;
  readonly update: (input: ProjectMcpUpdateInput) => Effect.Effect<ProjectMcpServer, Error>;
  readonly remove: (input: ProjectMcpRemoveInput) => Effect.Effect<void, Error>;
  readonly resolveForSession: (
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ResolvedProjectMcpServer>, Error>;
  readonly acquireSessionLease: (
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<AcquiredProjectMcpSessionServers, Error, Scope.Scope>;
}

export class ProjectMcpService extends Context.Service<ProjectMcpService, ProjectMcpServiceShape>()(
  "t3/project/ProjectMcpService",
) {}

const makeProjectMcpService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const providerInstances = yield* ProviderInstanceRegistry;
  const httpServer = yield* HttpServer.HttpServer;
  const crypto = yield* Crypto.Crypto;
  const mcpSecrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
  const mcpOAuth = yield* Effect.serviceOption(ProjectMcpOAuth.ProjectMcpOAuth);
  const catalogMutationLock = yield* Semaphore.make(1);
  const mutationLocks = new Map<McpServerId, Semaphore.Semaphore>();

  const mutationLockFor = (serverId: McpServerId) =>
    Effect.gen(function* () {
      const existing = mutationLocks.get(serverId);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      mutationLocks.set(serverId, created);
      return created;
    });

  const isDefiniteDispatchFailure = (cause: Cause.Cause<unknown>): boolean => {
    const error = Cause.squash(cause);
    return (
      Schema.is(OrchestrationCommandInvariantError)(error) ||
      Schema.is(OrchestrationCommandPreviouslyRejectedError)(error) ||
      Schema.is(OrchestrationCommandIdConflictError)(error)
    );
  };

  const dispatchPrepared = <A, E>(
    dispatch: Effect.Effect<A, E>,
    prepared: ProjectMcpSecretStore.PreparedProjectMcpSecrets | undefined,
  ): Effect.Effect<A, E | ProjectMcpSecretStore.ProjectMcpSecretError> =>
    prepared === undefined
      ? dispatch
      : Effect.uninterruptibleMask((restore) =>
          restore(dispatch).pipe(
            Effect.catchCause((cause) =>
              isDefiniteDispatchFailure(cause)
                ? prepared.rollback.pipe(Effect.andThen(Effect.failCause(cause)))
                : Effect.failCause(cause),
            ),
            Effect.flatMap((result) => prepared.commit.pipe(Effect.as(result))),
          ),
        );

  const list: ProjectMcpServiceShape["list"] = (projectId) =>
    Effect.gen(function* () {
      const [instances, unavailableProviders] = yield* Effect.all([
        providerInstances.listInstances,
        providerInstances.listUnavailable,
      ]);
      const externalApplicationModes = new Map(
        instances.map((instance) => {
          const mode = instance.enabled
            ? (instance.adapter.capabilities.projectMcpProxy ??
              instance.adapter.capabilities.remoteHttpMcp)
            : "unavailable";
          return [instance.instanceId, mode] as const;
        }),
      );
      const externalApplicationReasons = new Map(
        instances.map(
          (instance) =>
            [
              instance.instanceId,
              instance.enabled
                ? instance.adapter.capabilities.projectMcpUnsupportedReason
                : undefined,
            ] as const,
        ),
      );
      const managedApplicationModes = new Map(
        instances.map(
          (instance) =>
            [
              instance.instanceId,
              instance.enabled ? instance.adapter.capabilities.managedPreviewMcp : "unavailable",
            ] as const,
        ),
      );
      const knownProviderInstanceIds = [
        ...instances.map((instance) => instance.instanceId),
        ...unavailableProviders.map((provider) => provider.instanceId),
      ];
      const external = yield* sql<Schema.Schema.Type<typeof ProjectMcpProjectionRow>>`
      SELECT
        server_id AS "serverId",
        name,
        url,
        transport_json AS "transportJson",
        enabled,
        provider_instance_ids_json AS "providerInstanceIds"
      FROM projection_project_mcp_servers
      WHERE project_id = ${projectId}
      ORDER BY name COLLATE NOCASE ASC, server_id ASC
    `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Effect.all([
              decodeProviderInstanceIds(row.providerInstanceIds),
              row.transportJson === null
                ? Effect.void
                : decodeProjectMcpTransportJson(row.transportJson),
            ]).pipe(
              Effect.flatMap(([providerInstanceIds, transport]) =>
                decodeProjectMcpServer({
                  id: row.serverId,
                  name: row.name,
                  ...(transport === undefined ? { url: row.url } : { transport }),
                  enabled: row.enabled === 1,
                  providerInstanceIds,
                }),
              ),
            ),
          ),
        ),
      );
      const externalWithOAuthStatus = yield* Effect.forEach(external, (entry) => {
        const transport = getProjectMcpTransport(entry);
        if (transport.type === "stdio" || transport.authorization.type !== "oauth") {
          return Effect.succeed(entry);
        }
        return mcpOAuth._tag === "Some"
          ? mcpOAuth.value.status(entry.id).pipe(
              Effect.map((oauthStatus) => ({ ...entry, oauthStatus })),
              Effect.orElseSucceed(() => entry),
            )
          : Effect.succeed(entry);
      });
      return {
        external: externalWithOAuthStatus,
        applications: [
          ...externalWithOAuthStatus.flatMap((entry) =>
            entry.providerInstanceIds.map((providerInstanceId) => ({
              serverId: entry.id,
              providerInstanceId,
              mode: externalApplicationModes.get(providerInstanceId) ?? "unavailable",
              ...(externalApplicationReasons.get(providerInstanceId) === undefined
                ? {}
                : { reason: externalApplicationReasons.get(providerInstanceId) }),
            })),
          ),
          ...knownProviderInstanceIds.map((providerInstanceId) => ({
            serverId: MANAGED_PREVIEW_MCP_ID,
            providerInstanceId,
            mode: managedApplicationModes.get(providerInstanceId) ?? "unavailable",
          })),
        ],
        managed: [
          {
            id: MANAGED_PREVIEW_MCP_ID,
            name: "t3-code",
            url: getMcpEndpoint(httpServer),
            providerInstanceIds: knownProviderInstanceIds,
          },
        ],
      };
    });

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

  const validateTransport = (
    input: Pick<ProjectMcpCreateInput | ProjectMcpUpdateInput, "url" | "transport">,
    commandType: string,
  ) => {
    const transport = input.transport;
    if (transport === undefined) return validateUrl(input.url!, commandType);
    return transport.type === "stdio" ? Effect.void : validateUrl(transport.url, commandType);
  };

  const validateProviderIds = (
    providerInstanceIds: ReadonlyArray<ProviderInstanceId>,
    previouslyPersistedIds: ReadonlyArray<ProviderInstanceId> = [],
  ) =>
    Effect.all([providerInstances.listInstances, providerInstances.listUnavailable]).pipe(
      Effect.flatMap(([instances, unavailableProviders]) => {
        const knownIds = new Set([
          ...instances.map((instance) => instance.instanceId),
          ...unavailableProviders.map((provider) => provider.instanceId),
        ]);
        const retainedIds = new Set(previouslyPersistedIds);
        const unknownId = providerInstanceIds.find(
          (instanceId) => !knownIds.has(instanceId) && !retainedIds.has(instanceId),
        );
        return unknownId === undefined
          ? Effect.void
          : Effect.fail(new ProjectMcpProviderNotFoundError({ providerInstanceId: unknownId }));
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
    catalogMutationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* validateTransport(input, "project.mcp-server.create");
        const catalog = yield* list(input.projectId);
        if (catalog.external.length >= PROJECT_MCP_SERVER_LIMIT) {
          return yield* new ProjectMcpServerLimitExceededError({
            limit: PROJECT_MCP_SERVER_LIMIT,
          });
        }
        yield* validateName(input.projectId, input.name, undefined);
        yield* validateProviderIds(input.providerInstanceIds);
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const serverId = McpServerId.make(yield* crypto.randomUUIDv4);
        const commandId = CommandId.make(yield* crypto.randomUUIDv4);
        const prepared =
          input.transport === undefined
            ? undefined
            : yield* mcpSecrets.prepareCreate(serverId, input.transport);
        const server: ProjectMcpServer = {
          id: serverId,
          name: input.name,
          ...(prepared === undefined ? { url: input.url! } : { transport: prepared.transport }),
          enabled: input.enabled,
          providerInstanceIds: input.providerInstanceIds,
        };
        yield* dispatchPrepared(
          engine.dispatch({
            type: "project.mcp-server.create",
            commandId,
            projectId: input.projectId,
            server,
            createdAt: now,
          }),
          prepared,
        );
        return server;
      }),
    );

  const update: ProjectMcpServiceShape["update"] = (input) =>
    catalogMutationLock.withPermits(1)(
      mutationLockFor(input.id).pipe(
        Effect.flatMap((lock) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              yield* validateTransport(input, "project.mcp-server.update");
              const catalog = yield* list(input.projectId);
              const existing = catalog.external.find((entry) => entry.id === input.id);
              if (existing === undefined) {
                return yield* new ProjectMcpServerNotFoundError({ id: input.id });
              }
              yield* validateName(input.projectId, input.name, input.id);
              yield* validateProviderIds(input.providerInstanceIds, existing.providerInstanceIds);
              const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
              const commandId = CommandId.make(yield* crypto.randomUUIDv4);
              const prepared =
                input.transport === undefined
                  ? undefined
                  : yield* mcpSecrets.prepareUpdate(
                      input.id,
                      getProjectMcpTransport(existing),
                      input.transport,
                    );
              const server: ProjectMcpServer = {
                id: input.id,
                name: input.name,
                ...(prepared === undefined
                  ? { url: input.url! }
                  : { transport: prepared.transport }),
                enabled: input.enabled,
                providerInstanceIds: input.providerInstanceIds,
              };
              yield* dispatchPrepared(
                engine.dispatch({
                  type: "project.mcp-server.update",
                  commandId,
                  projectId: input.projectId,
                  server,
                  updatedAt: now,
                }),
                prepared,
              );
              if (prepared === undefined && existing.transport !== undefined) {
                yield* mcpSecrets.retireTransport(input.id, existing.transport);
              }
              return server;
            }),
          ),
        ),
      ),
    );

  const remove: ProjectMcpServiceShape["remove"] = (input) =>
    catalogMutationLock.withPermits(1)(
      mutationLockFor(input.id).pipe(
        Effect.flatMap((lock) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const catalog = yield* list(input.projectId);
              if (!catalog.external.some((entry) => entry.id === input.id)) {
                return yield* new ProjectMcpServerNotFoundError({ id: input.id });
              }
              const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
              const commandId = CommandId.make(yield* crypto.randomUUIDv4);
              yield* engine.dispatch({
                type: "project.mcp-server.remove",
                commandId,
                projectId: input.projectId,
                id: input.id,
                removedAt: now,
              });
              yield* mcpSecrets.removeServer(input.id);
            }),
          ),
        ),
      ),
    );

  const resolveForSession: ProjectMcpServiceShape["resolveForSession"] = (
    projectId,
    providerInstanceId,
  ) =>
    list(projectId).pipe(
      Effect.map((catalog) =>
        catalog.external
          .filter(
            (entry) =>
              entry.enabled &&
              entry.providerInstanceIds.includes(providerInstanceId) &&
              catalog.applications.some(
                (application) =>
                  application.serverId === entry.id &&
                  application.providerInstanceId === providerInstanceId &&
                  application.mode !== "unsupported",
              ),
          )
          .map((server) => ({
            id: server.id,
            name: server.name,
            transport: getProjectMcpTransport(server),
          })),
      ),
    );

  const acquireSessionLease: ProjectMcpServiceShape["acquireSessionLease"] = (
    projectId,
    providerInstanceId,
  ) =>
    catalogMutationLock.withPermits(1)(
      resolveForSession(projectId, providerInstanceId).pipe(
        Effect.flatMap((servers) =>
          Effect.forEach(
            servers,
            (server) =>
              mcpSecrets
                .acquireLease(
                  server.id,
                  ProjectMcpSecretStore.credentialIdsForTransport(server.transport),
                )
                .pipe(
                  Effect.flatMap((lease) =>
                    Effect.forEach(
                      ProjectMcpSecretStore.credentialIdsForTransport(server.transport),
                      (credentialId) =>
                        lease
                          .resolve(credentialId)
                          .pipe(Effect.map((value) => [credentialId, value] as const)),
                    ).pipe(Effect.map((credentials) => ({ server, credentials }))),
                  ),
                ),
            { concurrency: 1 },
          ).pipe(
            Effect.map((leased) => {
              const secretValues = new Map<string, string>();
              for (const { credentials } of leased) {
                for (const [credentialId, value] of credentials)
                  secretValues.set(credentialId, value);
              }
              if (mcpOAuth._tag === "Some") {
                for (const { server } of leased) {
                  if (
                    server.transport.type === "stdio" ||
                    server.transport.authorization.type !== "oauth"
                  )
                    continue;
                  const registration = server.transport.authorization.registration;
                  const clientSecret =
                    registration.type === "pre-registered" &&
                    registration.clientSecret !== undefined
                      ? secretValues.get(registration.clientSecret.id)
                      : undefined;
                  mcpOAuth.value.bindServer?.({
                    serverId: server.id,
                    resource: server.transport.url,
                    ...(registration.type === "pre-registered"
                      ? {
                          clientId: registration.clientId,
                          ...(clientSecret === undefined ? {} : { clientSecret }),
                        }
                      : {}),
                  });
                }
              }
              return {
                servers: leased.map(({ server }) => server),
                resolveSecret: (_serverId, credentialId) => secretValues.get(credentialId),
              } satisfies AcquiredProjectMcpSessionServers;
            }),
          ),
        ),
      ),
    );

  const persistedServers = yield* sql<Schema.Schema.Type<typeof ProjectMcpProjectionRow>>`
    SELECT
      server_id AS "serverId",
      name,
      url,
      transport_json AS "transportJson",
      enabled,
      provider_instance_ids_json AS "providerInstanceIds"
    FROM projection_project_mcp_servers
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Effect.all([
          decodeProviderInstanceIds(row.providerInstanceIds),
          row.transportJson === null
            ? Effect.void
            : decodeProjectMcpTransportJson(row.transportJson),
        ]).pipe(
          Effect.flatMap(([providerInstanceIds, transport]) =>
            decodeProjectMcpServer({
              id: row.serverId,
              name: row.name,
              ...(transport === undefined ? { url: row.url } : { transport }),
              enabled: row.enabled === 1,
              providerInstanceIds,
            }),
          ),
        ),
      ),
    ),
  );
  yield* mcpSecrets.reconcile(persistedServers);

  return ProjectMcpService.of({
    list,
    create,
    update,
    remove,
    resolveForSession,
    acquireSessionLease,
  });
});

export const layer = Layer.effect(ProjectMcpService, makeProjectMcpService);
