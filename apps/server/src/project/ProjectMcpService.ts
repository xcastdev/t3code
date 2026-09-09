import {
  CommandId,
  McpCatalogDefinition,
  McpCatalogOverride,
  McpCatalogSnapshot,
  McpServerId,
  ProjectMcpNameConflictError,
  ProjectMcpCatalogCommittedCleanupPendingError,
  ProjectMcpEnvironmentVariableNameConflictError,
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
  type ProjectMcpTransportDraft,
  type ProjectMcpUpdateInput,
  type ResolvedProjectMcpServer,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
import { forkParked } from "../serverActivation.ts";

const PROJECT_MCP_SERVER_LIMIT = 50;
const MANAGED_PREVIEW_MCP_ID = McpServerId.make("t3-code");
const isCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isCommandPreviouslyRejectedError = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const isCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

const projectMcpCleanupEventTypes = new Set([
  "project.deleted",
  "project.mcp-server.created",
  "project.mcp-server.updated",
  "project.mcp-server.removed",
  "project.mcp-definition.created",
  "project.mcp-definition.updated",
  "project.mcp-definition.removed",
  "environment.mcp-definition.created",
  "environment.mcp-definition.updated",
  "environment.mcp-definition.removed",
  "project.mcp-override.upserted",
  "project.mcp-override.removed",
  "thread.mcp-catalog.initialized",
  "thread.mcp-catalog.updated",
  "thread.mcp-catalog.reset",
  "thread.mcp-catalog.disposed",
]);

const ProjectMcpProjectionRow = Schema.Struct({
  serverId: McpServerId,
  name: Schema.String,
  url: Schema.String,
  transportJson: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  providerInstanceIds: Schema.String,
});
const McpCatalogDefinitionProjectionRow = Schema.Struct({
  serverId: McpServerId,
  transportJson: Schema.String,
});
const McpCatalogOverrideProjectionRow = Schema.Struct({
  serverId: McpServerId,
  patchJson: Schema.String,
});
const McpCatalogSessionProjectionRow = Schema.Struct({
  baselineJson: Schema.String,
  desiredJson: Schema.String,
});

const decodeProjectMcpServer = Schema.decodeUnknownEffect(ProjectMcpServer);
const decodeProjectMcpTransportJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMcpTransport),
);
const decodeProviderInstanceIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProviderInstanceId)),
);
const decodeMcpCatalogDefinition = Schema.decodeUnknownEffect(McpCatalogDefinition);
const decodeMcpCatalogOverride = Schema.decodeUnknownEffect(McpCatalogOverride);
const decodeMcpCatalogDefinitionsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(McpCatalogDefinition)),
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
  readonly oauthStateLeases: ReadonlyMap<
    McpServerId,
    ProjectMcpSecretStore.ProjectMcpOAuthStateLease
  >;
}

export interface ProjectMcpServiceShape {
  /** Subscribe and reconcile before accepting normal operations; owns scoped cleanup fibers. */
  readonly startCleanup: () => Effect.Effect<void, Error, Scope.Scope>;
  /** Serialize catalog secret preparation/dispatch with cleanup and leases. */
  readonly withCatalogMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Wait for events through this sequence and cleanup, reporting unresolved cleanup failures. */
  readonly drainThrough: (sequence: number) => Effect.Effect<void, Error>;
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
  /** Acquire a lease for a durable catalog resolution chosen by the caller. */
  readonly acquireResolvedSessionLease: (
    servers: ReadonlyArray<ResolvedProjectMcpServer>,
  ) => Effect.Effect<AcquiredProjectMcpSessionServers, Error, Scope.Scope>;
}

export class ProjectMcpService extends Context.Service<ProjectMcpService, ProjectMcpServiceShape>()(
  "t3/project/ProjectMcpService",
) {}

export class ProjectMcpCleanupError extends Schema.TaggedErrorClass<ProjectMcpCleanupError>()(
  "ProjectMcpCleanupError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type CatalogMutationOutcome<A, E extends Error> =
  | {
      readonly _tag: "Succeeded";
      readonly id: McpServerId;
      readonly value: A;
      readonly sequence: number;
    }
  | { readonly _tag: "Rejected"; readonly id: McpServerId; readonly cause: Cause.Cause<E> }
  | {
      readonly _tag: "CommittedSecretFailure";
      readonly id: McpServerId;
      readonly value: A;
      readonly sequence: number;
      readonly cause: Cause.Cause<ProjectMcpSecretStore.ProjectMcpSecretError>;
    };

const makeProjectMcpService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const providerInstances = yield* ProviderInstanceRegistry;
  const httpServer = yield* HttpServer.HttpServer;
  const crypto = yield* Crypto.Crypto;
  const mcpSecrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
  const mcpOAuth = yield* Effect.serviceOption(ProjectMcpOAuth.ProjectMcpOAuth);
  const hostPlatform = yield* HostProcessPlatform;
  const catalogMutationLock = yield* Semaphore.make(1);

  const isDefiniteDispatchFailure = (cause: Cause.Cause<unknown>): boolean => {
    const error = Cause.squash(cause);
    return (
      isCommandInvariantError(error) ||
      isCommandPreviouslyRejectedError(error) ||
      isCommandIdConflictError(error)
    );
  };

  const dispatchPrepared = <A, E extends Error>(
    dispatch: Effect.Effect<{ sequence: number }, E, never>,
    id: McpServerId,
    value: A,
    prepared: ProjectMcpSecretStore.PreparedProjectMcpSecrets | undefined,
    secretWork: Effect.Effect<
      void,
      ProjectMcpSecretStore.ProjectMcpSecretError,
      never
    > = Effect.void,
  ): Effect.Effect<CatalogMutationOutcome<A, E>, E | ProjectMcpSecretStore.ProjectMcpSecretError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const dispatchExit = yield* restore(dispatch).pipe(Effect.exit);
        if (Exit.isFailure(dispatchExit)) {
          if (!isDefiniteDispatchFailure(dispatchExit.cause))
            return yield* Effect.failCause(dispatchExit.cause);
          yield* prepared?.rollback ?? Effect.void;
          return {
            _tag: "Rejected",
            id,
            cause: dispatchExit.cause,
          } satisfies CatalogMutationOutcome<A, E>;
        }

        const sequence = dispatchExit.value.sequence;
        const secretExit = yield* (prepared?.commit ?? Effect.void).pipe(
          Effect.andThen(secretWork),
          Effect.exit,
        );
        if (Exit.isFailure(secretExit)) {
          return {
            _tag: "CommittedSecretFailure",
            id,
            value,
            sequence,
            cause: secretExit.cause,
          } satisfies CatalogMutationOutcome<A, E>;
        }
        return { _tag: "Succeeded", id, value, sequence } satisfies CatalogMutationOutcome<A, E>;
      }),
    );

  let recoverCommittedMutation: <A, E extends Error>(
    operation: "create" | "update" | "remove",
    id: McpServerId,
    outcome: Extract<CatalogMutationOutcome<A, E>, { readonly _tag: "CommittedSecretFailure" }>,
  ) => Effect.Effect<void, ProjectMcpCatalogCommittedCleanupPendingError>;

  const finishCatalogMutation = <A, E extends Error>(
    operation: "create" | "update" | "remove",
    id: McpServerId,
    outcome: CatalogMutationOutcome<A, E>,
  ): Effect.Effect<A, E | ProjectMcpCatalogCommittedCleanupPendingError> => {
    switch (outcome._tag) {
      case "Succeeded":
        // The orchestration receipt is emitted after its SQL projection has
        // been written, so reconcile synchronously against every durable
        // catalog reference before returning. This preserves a session's old
        // credential while it is still in baseline/desired state, while also
        // keeping the legacy project mutation path's immediate cleanup
        // guarantee.
        return reconcileCatalog.pipe(
          Effect.map(() => outcome.value),
          Effect.mapError(
            () =>
              new ProjectMcpCatalogCommittedCleanupPendingError({
                operation,
                id,
                sequence: outcome.sequence,
              }),
          ),
        );
      case "Rejected":
        return Effect.failCause(outcome.cause);
      case "CommittedSecretFailure":
        return recoverCommittedMutation(operation, id, outcome).pipe(Effect.as(outcome.value));
    }
  };

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
          ? ProjectMcpOAuth.resolveServerBinding(
              { id: entry.id, transport },
              mcpSecrets.resolve,
            ).pipe(
              Effect.flatMap((server) => mcpOAuth.value.status(entry.id, server)),
              Effect.map((oauthStatus) => ({ ...entry, oauthStatus })),
              Effect.orElseSucceed(() => ({ ...entry, oauthStatus: "error" as const })),
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

  const duplicateWindowsEnvironmentName = (
    transport: ProjectMcpTransport | ProjectMcpTransportDraft,
  ) =>
    transport.type !== "stdio" || hostPlatform !== "win32"
      ? undefined
      : transport.env.find(
          ({ name }, index, entries) =>
            entries.findIndex(
              ({ name: candidate }) => candidate.toLowerCase() === name.toLowerCase(),
            ) !== index,
        )?.name;

  const validateTransport = (
    input: Pick<ProjectMcpCreateInput | ProjectMcpUpdateInput, "url" | "transport">,
    commandType: string,
  ): Effect.Effect<
    void,
    OrchestrationCommandInvariantError | ProjectMcpEnvironmentVariableNameConflictError
  > => {
    const transport = input.transport;
    const urlValidation =
      transport === undefined
        ? validateUrl(input.url!, commandType)
        : transport.type === "stdio"
          ? Effect.void
          : validateUrl(transport.url, commandType);
    const duplicate =
      transport === undefined ? undefined : duplicateWindowsEnvironmentName(transport);
    return duplicate === undefined
      ? urlValidation
      : Effect.fail(
          new ProjectMcpEnvironmentVariableNameConflictError({
            name: duplicate,
            message: `Stdio environment variable '${duplicate}' conflicts with another name on Windows.`,
          }),
        );
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
    Effect.gen(function* () {
      const outcome = yield* catalogMutationLock.withPermits(1)(
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
          return yield* dispatchPrepared(
            engine.dispatch({
              type: "project.mcp-server.create",
              commandId,
              projectId: input.projectId,
              server,
              createdAt: now,
            }),
            serverId,
            server,
            prepared,
          );
        }),
      );
      return yield* finishCatalogMutation("create", outcome.id, outcome);
    });

  const update: ProjectMcpServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      const outcome = yield* catalogMutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (input.patch !== "enabled") {
            yield* validateTransport(input, "project.mcp-server.update");
          }
          const catalog = yield* list(input.projectId);
          const existing = catalog.external.find((entry) => entry.id === input.id);
          if (existing === undefined) {
            return yield* new ProjectMcpServerNotFoundError({ id: input.id });
          }
          if (input.patch === "enabled") {
            const server: ProjectMcpServer = {
              id: existing.id,
              name: existing.name,
              ...(existing.transport === undefined
                ? { url: existing.url! }
                : { transport: existing.transport }),
              enabled: input.enabled,
              providerInstanceIds: existing.providerInstanceIds,
            };
            const receipt = yield* engine.dispatch({
              type: "project.mcp-server.update",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              projectId: input.projectId,
              server,
              updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            });
            return {
              _tag: "Succeeded",
              id: input.id,
              value: server,
              sequence: receipt.sequence,
            } satisfies CatalogMutationOutcome<ProjectMcpServer, Error>;
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
            ...(prepared === undefined ? { url: input.url! } : { transport: prepared.transport }),
            enabled: input.enabled,
            providerInstanceIds: input.providerInstanceIds,
          };
          return yield* dispatchPrepared(
            engine.dispatch({
              type: "project.mcp-server.update",
              commandId,
              projectId: input.projectId,
              server,
              updatedAt: now,
            }),
            input.id,
            server,
            prepared,
            Effect.void,
          );
        }),
      );
      return yield* finishCatalogMutation("update", input.id, outcome);
    });

  const remove: ProjectMcpServiceShape["remove"] = (input) =>
    Effect.gen(function* () {
      const outcome = yield* catalogMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const catalog = yield* list(input.projectId);
          if (!catalog.external.some((entry) => entry.id === input.id)) {
            return yield* new ProjectMcpServerNotFoundError({ id: input.id });
          }
          const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const commandId = CommandId.make(yield* crypto.randomUUIDv4);
          return yield* dispatchPrepared(
            engine.dispatch({
              type: "project.mcp-server.remove",
              commandId,
              projectId: input.projectId,
              id: input.id,
              removedAt: now,
            }),
            input.id,
            undefined,
            undefined,
            // Reconciliation decides whether this server's credentials can be
            // retired after the durable legacy row is gone. A session
            // baseline or desired catalog may still reference the old
            // transport, so removing it eagerly would make a valid session
            // impossible to lease on its next start.
            Effect.void,
          );
        }),
      );
      return yield* finishCatalogMutation("remove", input.id, outcome);
    });

  const resolveForSession: ProjectMcpServiceShape["resolveForSession"] = (
    projectId,
    providerInstanceId,
  ) =>
    list(projectId).pipe(
      Effect.flatMap((catalog) =>
        Effect.forEach(
          catalog.external.filter(
            (entry) =>
              entry.enabled &&
              entry.providerInstanceIds.includes(providerInstanceId) &&
              catalog.applications.some(
                (application) =>
                  application.serverId === entry.id &&
                  application.providerInstanceId === providerInstanceId &&
                  application.mode !== "unsupported",
              ),
          ),
          (server) => {
            const transport = getProjectMcpTransport(server);
            return validateTransport({ transport }, "project.mcp-server.resolve").pipe(
              Effect.as({ id: server.id, name: server.name, transport }),
            );
          },
        ),
      ),
    );

  const acquireResolvedSessionLeaseUnsafe = (servers: ReadonlyArray<ResolvedProjectMcpServer>) =>
    Effect.forEach(
      servers,
      (server) => {
        const oauthStateLease =
          server.transport.type !== "stdio" && server.transport.authorization.type === "oauth"
            ? mcpSecrets.acquireOAuthStateLease(
                ProjectMcpOAuth.storageIdForServer(server.id, server.transportDefinitionId),
              )
            : Effect.succeed(undefined);
        return Effect.flatMap(oauthStateLease, (stateLease) =>
          Effect.flatMap(
            mcpSecrets.acquireLease(
              server.id,
              ProjectMcpSecretStore.credentialIdsForTransport(server.transport),
            ),
            (lease) =>
              Effect.map(
                Effect.forEach(
                  ProjectMcpSecretStore.credentialIdsForTransport(server.transport),
                  (credentialId) =>
                    lease
                      .resolve(credentialId)
                      .pipe(Effect.map((value) => [credentialId, value] as const)),
                ),
                (credentials) => ({ server, credentials, oauthStateLease: stateLease }),
              ),
          ),
        );
      },
      { concurrency: 1 },
    ).pipe(
      Effect.map((leased) => {
        const secretValues = new Map<string, string>();
        const oauthStateLeases = new Map<
          McpServerId,
          ProjectMcpSecretStore.ProjectMcpOAuthStateLease
        >();
        for (const { credentials, oauthStateLease, server } of leased) {
          for (const [credentialId, value] of credentials) secretValues.set(credentialId, value);
          if (oauthStateLease !== undefined) {
            oauthStateLeases.set(
              ProjectMcpOAuth.storageIdForServer(server.id, server.transportDefinitionId),
              oauthStateLease,
            );
          }
        }
        return {
          servers: leased.map(({ server }) => server),
          resolveSecret: (_serverId, credentialId) => secretValues.get(credentialId),
          oauthStateLeases,
        } satisfies AcquiredProjectMcpSessionServers;
      }),
    );

  const acquireResolvedSessionLease: ProjectMcpServiceShape["acquireResolvedSessionLease"] = (
    servers,
  ) => catalogMutationLock.withPermits(1)(acquireResolvedSessionLeaseUnsafe(servers));

  const acquireSessionLease: ProjectMcpServiceShape["acquireSessionLease"] = (
    projectId,
    providerInstanceId,
  ) =>
    catalogMutationLock.withPermits(1)(
      resolveForSession(projectId, providerInstanceId).pipe(
        Effect.flatMap(acquireResolvedSessionLeaseUnsafe),
      ),
    );

  const loadCompleteCatalog = sql<Schema.Schema.Type<typeof ProjectMcpProjectionRow>>`
    SELECT
      server_id AS "serverId",
      name,
      url,
      transport_json AS "transportJson",
      enabled,
      provider_instance_ids_json AS "providerInstanceIds"
    FROM projection_project_mcp_servers
  `;
  const loadDurableCatalogReferences = Effect.gen(function* () {
    const legacyRows = yield* loadCompleteCatalog.pipe(
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
    const definitions = yield* sql<Schema.Schema.Type<typeof McpCatalogDefinitionProjectionRow>>`
      SELECT logical_server_id AS "serverId", transport_json AS "transportJson"
      FROM projection_mcp_definitions
    `;
    const overrides = yield* sql<Schema.Schema.Type<typeof McpCatalogOverrideProjectionRow>>`
      SELECT target_logical_server_id AS "serverId", patch_json AS "patchJson"
      FROM projection_mcp_overrides
      WHERE scope_type = 'project'
    `;
    const sessions = yield* sql<Schema.Schema.Type<typeof McpCatalogSessionProjectionRow>>`
      SELECT sessions.baseline_json AS "baselineJson", sessions.desired_catalog_json AS "desiredJson"
      FROM projection_mcp_catalog_sessions AS sessions
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = sessions.thread_id
      WHERE sessions.disposed_at IS NULL
        AND threads.deleted_at IS NULL
    `;
    const references: Array<{
      readonly id: McpServerId;
      readonly transport?: ProjectMcpTransport;
    }> = legacyRows.map((server) => ({ id: server.id, transport: getProjectMcpTransport(server) }));
    for (const row of definitions) {
      references.push({
        id: row.serverId,
        transport: yield* decodeProjectMcpTransportJson(row.transportJson),
      });
    }
    for (const row of overrides) {
      const override = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(McpCatalogOverride))(
        row.patchJson,
      );
      if (override.transport !== undefined) {
        references.push({ id: row.serverId, transport: override.transport });
      }
    }
    for (const row of sessions) {
      for (const json of [row.baselineJson, row.desiredJson]) {
        const definitions = yield* decodeMcpCatalogDefinitionsJson(json);
        for (const definition of definitions) {
          references.push({ id: definition.logicalServerId, transport: definition.transport });
        }
      }
    }
    return references;
  });
  const reconcileCatalog = catalogMutationLock.withPermits(1)(
    loadDurableCatalogReferences.pipe(Effect.flatMap(mcpSecrets.reconcile)),
  );
  const cleanupFailure = yield* Ref.make<ProjectMcpCleanupError | undefined>(undefined);
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));
  const cleanupStartLock = yield* Semaphore.make(1);
  let cleanupWorker: DrainableWorker<number> | undefined;

  const processCleanup = Effect.fn("ProjectMcpService.processCleanup")(function* (
    sequence: number,
  ) {
    yield* reconcileCatalog.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : reconcileCatalog,
      ),
      Effect.matchCauseEffect({
        onSuccess: () => Ref.set(cleanupFailure, undefined),
        onFailure: (cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          const error = new ProjectMcpCleanupError({
            message: "Project MCP secret cleanup failed.",
            cause: Cause.squash(cause),
          });
          return Ref.set(cleanupFailure, error).pipe(
            Effect.andThen(Effect.logWarning("project MCP cleanup failed", { sequence, cause })),
          );
        },
      }),
    );
  });

  const drainThrough: ProjectMcpServiceShape["drainThrough"] = Effect.fn(
    "ProjectMcpService.drainThrough",
  )(function* (sequence) {
    if (!cleanupWorker)
      return yield* new ProjectMcpCleanupError({ message: "Project MCP cleanup has not started." });
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= sequence),
      Stream.runHead,
    );
    yield* cleanupWorker.drain;
    const failure = yield* Ref.get(cleanupFailure);
    if (failure) return yield* failure;
  });

  recoverCommittedMutation = (operation, id, outcome) => {
    const recovery =
      cleanupWorker === undefined
        ? reconcileCatalog.pipe(Effect.mapError((error) => error as Error))
        : cleanupWorker
            .enqueue(outcome.sequence)
            .pipe(
              Effect.andThen(noteSeen(outcome.sequence)),
              Effect.andThen(drainThrough(outcome.sequence)),
            );
    return recovery.pipe(
      Effect.matchCauseEffect({
        onSuccess: () =>
          Effect.logWarning("project MCP committed mutation recovered", {
            operation,
            id,
            sequence: outcome.sequence,
            originalCause: outcome.cause,
          }),
        onFailure: (recoveryCause) =>
          Effect.logWarning("project MCP committed mutation cleanup pending", {
            operation,
            id,
            sequence: outcome.sequence,
            originalCause: outcome.cause,
            recoveryCause,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProjectMcpCatalogCommittedCleanupPendingError({
                  operation,
                  id,
                  sequence: outcome.sequence,
                }),
              ),
            ),
          ),
      }),
    );
  };

  const startCleanup: ProjectMcpServiceShape["startCleanup"] = Effect.fn(
    "ProjectMcpService.startCleanup",
  )(function* () {
    if (cleanupWorker) return yield* drainThrough(yield* engine.latestSequence);
    // Acquire the subscription before either the head read or reconciliation.
    // Events committed during startup stay buffered until the subscriber runs.
    const subscription = yield* engine.subscribeDomainEvents;
    const worker = yield* makeDrainableWorker(processCleanup);
    cleanupWorker = worker;
    const sequence = yield* engine.latestSequence;
    yield* worker.enqueue(sequence);
    yield* noteSeen(sequence);
    yield* forkParked(
      Stream.runForEach(Stream.fromSubscription(subscription), (event) =>
        (projectMcpCleanupEventTypes.has(event.type)
          ? worker.enqueue(event.sequence)
          : Effect.void
        ).pipe(Effect.andThen(noteSeen(event.sequence))),
      ),
    );
    yield* drainThrough(sequence);
  }, cleanupStartLock.withPermits(1));

  return ProjectMcpService.of({
    startCleanup,
    drainThrough,
    withCatalogMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      catalogMutationLock.withPermits(1)(effect),
    list,
    create,
    update,
    remove,
    resolveForSession,
    acquireSessionLease,
    acquireResolvedSessionLease,
  });
});

export const layer = Layer.effect(ProjectMcpService, makeProjectMcpService);
