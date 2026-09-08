import {
  CommandId,
  McpServerId,
  ProjectMcpNameConflictError,
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
  readonly oauthStateLeases: ReadonlyMap<
    McpServerId,
    ProjectMcpSecretStore.ProjectMcpOAuthStateLease
  >;
}

export interface ProjectMcpServiceShape {
  /** Subscribe and reconcile before accepting normal operations; owns scoped cleanup fibers. */
  readonly startCleanup: () => Effect.Effect<void, Error, Scope.Scope>;
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
          yield* engine.dispatch({
            type: "project.mcp-server.update",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            projectId: input.projectId,
            server,
            updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          });
          return server;
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
    );

  const remove: ProjectMcpServiceShape["remove"] = (input) =>
    catalogMutationLock.withPermits(1)(
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
    );

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

  const acquireSessionLease: ProjectMcpServiceShape["acquireSessionLease"] = (
    projectId,
    providerInstanceId,
  ) =>
    catalogMutationLock.withPermits(1)(
      resolveForSession(projectId, providerInstanceId).pipe(
        Effect.flatMap((servers) =>
          Effect.forEach(
            servers,
            (server) => {
              const oauthStateLease =
                server.transport.type !== "stdio" && server.transport.authorization.type === "oauth"
                  ? mcpSecrets.acquireOAuthStateLease(server.id)
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
                for (const [credentialId, value] of credentials)
                  secretValues.set(credentialId, value);
                if (oauthStateLease !== undefined) oauthStateLeases.set(server.id, oauthStateLease);
              }
              return {
                servers: leased.map(({ server }) => server),
                resolveSecret: (_serverId, credentialId) => secretValues.get(credentialId),
                oauthStateLeases,
              } satisfies AcquiredProjectMcpSessionServers;
            }),
          ),
        ),
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
  const reconcileCatalog = catalogMutationLock.withPermits(1)(
    loadCompleteCatalog.pipe(Effect.flatMap(mcpSecrets.reconcile)),
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
        (event.type === "project.deleted" ? worker.enqueue(event.sequence) : Effect.void).pipe(
          Effect.andThen(noteSeen(event.sequence)),
        ),
      ),
    );
    yield* drainThrough(sequence);
  }, cleanupStartLock.withPermits(1));

  return ProjectMcpService.of({
    startCleanup,
    drainThrough,
    list,
    create,
    update,
    remove,
    resolveForSession,
    acquireSessionLease,
  });
});

export const layer = Layer.effect(ProjectMcpService, makeProjectMcpService);
