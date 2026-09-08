import {
  CommandId,
  McpServerId,
  ProjectId,
  ProjectMcpCatalogCommittedCleanupPendingError,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectMcpSecretStore from "../mcp/ProjectMcpSecretStore.ts";
import * as ProjectMcpOAuth from "../mcp/ProjectMcpOAuth.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

import * as ProjectMcpService from "./ProjectMcpService.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const codexInstance = ProviderInstanceId.make("codex");
const openCodeInstance = ProviderInstanceId.make("opencode");
const disabledCursorInstance = ProviderInstanceId.make("cursor-disabled");
const unavailableInstance = ProviderInstanceId.make("fork-provider");

const unavailableProvider = {
  instanceId: unavailableInstance,
  driver: ProviderDriverKind.make("fork-driver"),
  displayName: "Fork provider",
  enabled: false,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  message: "Provider driver is unavailable.",
  availability: "unavailable",
  unavailableReason: "Provider driver is unavailable.",
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const codexInput = {
  name: "Docs",
  url: "https://docs.example.test/mcp",
  enabled: true,
  providerInstanceIds: [codexInstance],
};

const projectBInput = {
  name: "Project B Docs",
  url: "https://project-b.example.test/mcp",
  enabled: true,
  providerInstanceIds: [codexInstance],
};

const disabledInput = {
  name: "Disabled",
  url: "https://disabled.example.test/mcp",
  enabled: false,
  providerInstanceIds: [codexInstance],
};

const mcpHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const projectMcpOAuthTestLayer = Layer.succeed(
  ProjectMcpOAuth.ProjectMcpOAuth,
  ProjectMcpOAuth.ProjectMcpOAuth.of({
    status: () => Effect.succeed("not-connected"),
    providerFor: () => Effect.die("unused"),
    begin: () => Effect.die("unused"),
    continuePending: () => Effect.die("unused"),
    completeCallback: () => Effect.die("unused"),
    disconnect: () => Effect.die("unused"),
  }),
);

const providerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: () => Effect.die("Unused in ProjectMcpService tests"),
  listInstances: Effect.succeed([
    {
      instanceId: codexInstance,
      enabled: true,
      adapter: {
        capabilities: { remoteHttpMcp: "next-session", managedPreviewMcp: "next-session" },
      },
    },
    {
      instanceId: openCodeInstance,
      enabled: true,
      adapter: {
        capabilities: { remoteHttpMcp: "unsupported", managedPreviewMcp: "next-session" },
      },
    },
    {
      instanceId: disabledCursorInstance,
      enabled: false,
      adapter: {
        capabilities: { remoteHttpMcp: "next-session", managedPreviewMcp: "next-session" },
      },
    },
  ]),
  listUnavailable: Effect.succeed([unavailableProvider]),
  streamChanges: Effect.never,
  subscribeChanges: Effect.die("Unused in ProjectMcpService tests"),
} as never);

const startedServiceLayer = Layer.effectDiscard(
  Effect.flatMap(ProjectMcpService.ProjectMcpService, (service) => service.startCleanup()),
).pipe(Layer.provideMerge(ProjectMcpService.layer));

const makeTestLayer = (
  engineLayer = OrchestrationEngineLive,
  oauthLayer: Layer.Layer<
    ProjectMcpOAuth.ProjectMcpOAuth,
    never,
    ProjectMcpSecretStore.ProjectMcpSecretStore
  > = projectMcpOAuthTestLayer,
  startCleanup = true,
  platform: NodeJS.Platform = "linux",
) =>
  (startCleanup ? startedServiceLayer : ProjectMcpService.layer).pipe(
    Layer.provideMerge(oauthLayer),
    Layer.provideMerge(ProjectMcpSecretStore.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(providerInstanceRegistry),
    Layer.provideMerge(Layer.succeed(HttpServer.HttpServer, mcpHttpServer)),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, platform)),
  );

const testLayer = makeTestLayer();
const isProjectMcpCatalogCommittedCleanupPendingError = Schema.is(
  ProjectMcpCatalogCommittedCleanupPendingError,
);

const makeRestartTestLayer = (
  persistenceLayer: ReturnType<typeof makeSqlitePersistenceLive>,
  config: ServerConfig.ServerConfig["Service"],
  startCleanup = true,
  platform: NodeJS.Platform = "linux",
) =>
  (startCleanup ? startedServiceLayer : ProjectMcpService.layer).pipe(
    Layer.provideMerge(ProjectMcpSecretStore.layer),
    Layer.provideMerge(projectMcpOAuthTestLayer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(OrchestrationEngineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(providerInstanceRegistry),
    Layer.provideMerge(Layer.succeed(HttpServer.HttpServer, mcpHttpServer)),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, platform)),
  );

const createProject = (projectId: ProjectId, commandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(commandId),
      projectId,
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      createdAt: "2026-09-02T20:00:00.000Z",
    });
  });

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const createSecretServer = Effect.fn("createSecretServer")(function* (
  projectId: ProjectId,
  name: string,
) {
  const service = yield* ProjectMcpService.ProjectMcpService;
  const server = yield* service.create({
    projectId,
    name,
    enabled: true,
    providerInstanceIds: [codexInstance],
    transport: {
      type: "stdio",
      command: "node",
      args: [],
      env: [
        {
          name: ProjectMcpEnvironmentVariableName.make("TOKEN"),
          credential: { name: "token", value: `${name}-secret` },
        },
      ],
    },
  });
  const transport = server.transport;
  if (transport?.type !== "stdio") return yield* Effect.die("Expected stdio transport");
  return { server, credentialId: transport.env[0]!.credential.id };
});

const caseDistinctStdio = (upperValue: string, lowerValue: string) => ({
  type: "stdio" as const,
  command: "node",
  args: [],
  env: [
    {
      name: ProjectMcpEnvironmentVariableName.make("HTTP_PROXY"),
      credential: { name: "upper", value: upperValue },
    },
    {
      name: ProjectMcpEnvironmentVariableName.make("http_proxy"),
      credential: { name: "lower", value: lowerValue },
    },
  ],
});

it.effect(
  "cleans deleted projects after durable dispatch while retaining other projects and leased credentials",
  () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const files = yield* ServerSecretStore.ServerSecretStore;
      yield* service.startCleanup();
      yield* createProject(projectA, "cleanup-project-a");
      yield* createProject(projectB, "cleanup-project-b");
      const leased = yield* createSecretServer(projectA, "leased");
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const session = yield* service
        .acquireSessionLease(projectA, codexInstance)
        .pipe(Scope.provide(scope));
      const unleased = yield* createSecretServer(projectA, "unleased");
      const retained = yield* createSecretServer(projectB, "retained");
      const deletion = yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("cleanup-delete-a"),
        projectId: projectA,
      });
      yield* service.drainThrough(deletion.sequence);
      expect(
        Option.isNone(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(unleased.credentialId)),
        ),
      ).toBe(true);
      expect(
        Option.isSome(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(retained.credentialId)),
        ),
      ).toBe(true);
      expect(
        Option.isSome(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(leased.credentialId)),
        ),
      ).toBe(true);
      expect(session.resolveSecret(leased.server.id, leased.credentialId)).toBe("leased-secret");
      yield* Scope.close(scope, Exit.void);
      expect(
        Option.isNone(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(leased.credentialId)),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([1, 2])(
  "retries project cleanup and exposes %s storage failures without losing the subscriber",
  (failures) =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const files = yield* ServerSecretStore.ServerSecretStore;
      yield* createProject(projectA, "failure-project-a");
      yield* createProject(projectB, "failure-project-b");
      const removed = yield* createSecretServer(projectA, "cleanup-failure");
      const secretName = ProjectMcpSecretStore.credentialSecretName(removed.credentialId);
      const originalRemove = files.remove;
      let remaining = failures;
      const remove = vi.spyOn(files, "remove").mockImplementation((name) =>
        Effect.suspend(() => {
          if (name === secretName && remaining > 0) {
            remaining -= 1;
            return Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: name,
                cause: "injected cleanup failure",
              }),
            );
          }
          return originalRemove(name);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => remove.mockRestore()));
      const deletion = yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("failure-delete-a"),
        projectId: projectA,
      });
      const drained = yield* service.drainThrough(deletion.sequence).pipe(Effect.exit);
      expect(Exit.isFailure(drained)).toBe(failures === 2);
      expect(remaining).toBe(0);
      if (failures === 2) {
        expect(Option.isSome(yield* files.get(secretName))).toBe(true);
        expect(
          Exit.isFailure(yield* service.drainThrough(deletion.sequence).pipe(Effect.exit)),
        ).toBe(true);
        const nextDeletion = yield* engine.dispatch({
          type: "project.delete",
          commandId: CommandId.make("failure-delete-b"),
          projectId: projectB,
        });
        yield* service.drainThrough(nextDeletion.sequence);
      }
      expect(Option.isNone(yield* files.get(secretName))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "subscribes before taking the startup cleanup watermark",
  () =>
    Effect.gen(function* () {
      let injectDeletion = false;
      let deletionSequence = 0;
      const engineLayer = Layer.effect(
        OrchestrationEngineService,
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          return {
            ...engine,
            latestSequence: Effect.gen(function* () {
              const head = yield* engine.latestSequence;
              if (injectDeletion) {
                injectDeletion = false;
                deletionSequence = (yield* engine
                  .dispatch({
                    type: "project.delete",
                    commandId: CommandId.make("startup-race-delete"),
                    projectId: projectA,
                  })
                  .pipe(Effect.orDie)).sequence;
              }
              return head;
            }),
          };
        }),
      ).pipe(Layer.provide(OrchestrationEngineLive));
      yield* Effect.gen(function* () {
        const service = yield* ProjectMcpService.ProjectMcpService;
        const files = yield* ServerSecretStore.ServerSecretStore;
        yield* createProject(projectA, "startup-race-project");
        const removed = yield* createSecretServer(projectA, "startup-race");
        injectDeletion = true;
        yield* service.startCleanup();
        expect(deletionSequence).toBeGreaterThan(0);
        yield* service.drainThrough(deletionSequence);
        expect(
          Option.isNone(
            yield* files.get(ProjectMcpSecretStore.credentialSecretName(removed.credentialId)),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(makeTestLayer(engineLayer, projectMcpOAuthTestLayer, false)));
    }),
  { timeout: 3000 },
);

it.effect("startup cleanup recovers a deletion committed while cleanup was offline", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(config.dbPath);
    const removed = yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* createProject(projectA, "offline-project-a");
      yield* createProject(projectB, "offline-project-b");
      const removed = yield* createSecretServer(projectA, "offline-removed");
      const retained = yield* createSecretServer(projectB, "offline-retained");
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("offline-delete"),
        projectId: projectA,
      });
      return { removed, retained };
    }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistenceLayer, config, false))));
    yield* Effect.gen(function* () {
      const files = yield* ServerSecretStore.ServerSecretStore;
      expect(
        Option.isNone(
          yield* files.get(
            ProjectMcpSecretStore.credentialSecretName(removed.removed.credentialId),
          ),
        ),
      ).toBe(true);
      expect(
        Option.isSome(
          yield* files.get(
            ProjectMcpSecretStore.credentialSecretName(removed.retained.credentialId),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistenceLayer, config))));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-cleanup-restart-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "buffers deletion during startup reconciliation and serializes catalog writes with cleanup",
  () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const files = yield* ServerSecretStore.ServerSecretStore;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      yield* createProject(projectA, "reconciliation-project-a");
      yield* createProject(projectB, "reconciliation-project-b");
      const orphan = yield* createSecretServer(projectA, "reconciliation-orphan");
      const removedDuringStart = yield* createSecretServer(projectB, "reconciliation-deleted");
      const projectC = ProjectId.make("reconciliation-project-c");
      yield* createProject(projectC, "reconciliation-project-c");
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("reconciliation-delete-a"),
        projectId: projectA,
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const originalRemove = files.remove;
      const remove = vi
        .spyOn(files, "remove")
        .mockImplementation((name) =>
          name === ProjectMcpSecretStore.credentialSecretName(orphan.credentialId)
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(originalRemove(name)),
              )
            : originalRemove(name),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => remove.mockRestore()));
      const starting = yield* service.startCleanup().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const deletion = yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("reconciliation-delete-b"),
        projectId: projectB,
      });
      const creating = yield* createSecretServer(projectC, "reconciliation-created").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(creating.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(starting);
      const created = yield* Fiber.join(creating);
      yield* service.drainThrough(deletion.sequence);
      expect(
        Option.isNone(
          yield* files.get(
            ProjectMcpSecretStore.credentialSecretName(removedDuringStart.credentialId),
          ),
        ),
      ).toBe(true);
      expect(yield* secrets.resolve(created.server.id, created.credentialId)).toBe(
        "reconciliation-created-secret",
      );
      expect((yield* service.list(projectC)).external.map((server) => server.id)).toEqual([
        created.server.id,
      ]);
    }).pipe(
      Effect.provide(makeTestLayer(OrchestrationEngineLive, projectMcpOAuthTestLayer, false)),
    ),
);

it.effect("startup retries durable retirement intent left by repeated cleanup failures", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const persistence = makeSqlitePersistenceLive(config.dbPath);
    const removed = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const files = yield* ServerSecretStore.ServerSecretStore;
      yield* createProject(projectA, "retirement-restart-a");
      const removed = yield* createSecretServer(projectA, "retirement-restart");
      const secretName = ProjectMcpSecretStore.credentialSecretName(removed.credentialId);
      const originalRemove = files.remove;
      const remove = vi.spyOn(files, "remove").mockImplementation((name) =>
        name === secretName
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: name,
                cause: "injected persistent failure",
              }),
            )
          : originalRemove(name),
      );
      const deletion = yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("retirement-restart-delete"),
        projectId: projectA,
      });
      const drained = yield* service
        .drainThrough(deletion.sequence)
        .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => remove.mockRestore())));
      expect(Exit.isFailure(drained)).toBe(true);
      expect(Option.isSome(yield* files.get(secretName))).toBe(true);
      return removed;
    }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistence, config))));
    yield* Effect.gen(function* () {
      const files = yield* ServerSecretStore.ServerSecretStore;
      expect(
        Option.isNone(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(removed.credentialId)),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistence, config))));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-retirement-restart-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

for (const failure of ["client-secret resolution", "status read"] as const) {
  it.effect(`catalog reports OAuth error after failing ${failure}`, () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      yield* createProject(projectA, `oauth-error-${failure}`);
      const entry = yield* service.create({
        projectId: projectA,
        name: "OAuth error",
        enabled: true,
        providerInstanceIds: [],
        transport: {
          type: "streamable-http",
          url: "https://oauth.example.test/mcp",
          headers: [],
          authorization: {
            type: "oauth",
            registration: {
              type: "pre-registered",
              clientId: "client",
              clientSecret: { name: "client secret", value: "secret" },
            },
          },
        },
      });
      if (failure === "client-secret resolution") yield* secrets.removeServer(entry.id);
      expect((yield* service.list(projectA)).external).toEqual([
        { ...entry, oauthStatus: "error" },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          OrchestrationEngineLive,
          Layer.succeed(
            ProjectMcpOAuth.ProjectMcpOAuth,
            ProjectMcpOAuth.ProjectMcpOAuth.of({
              status: () =>
                failure === "status read"
                  ? Effect.fail(
                      new ProjectMcpOAuth.ProjectMcpOAuthError({
                        operation: "status",
                        cause: "status read failed",
                      }),
                    )
                  : Effect.succeed("not-connected"),
              providerFor: () => Effect.die("unused"),
              begin: () => Effect.die("unused"),
              continuePending: () => Effect.die("unused"),
              completeCallback: () => Effect.die("unused"),
              disconnect: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    ),
  );
}

it.effect("enabled patches preserve another client's replacement and retained credentials", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    yield* createProject(projectA, "patch-create-project-a");
    const displayedByA = yield* service.create({ projectId: projectA, ...codexInput });
    const replacementByB = yield* service.update({
      projectId: projectA,
      id: displayedByA.id,
      name: "Replacement",
      enabled: true,
      providerInstanceIds: [openCodeInstance],
      transport: {
        type: "streamable-http",
        url: "https://replacement.example.test/mcp",
        headers: [
          {
            name: ProjectMcpHeaderName.make("X-Key"),
            credential: { name: "key", value: "patch-retained-secret" },
          },
        ],
        authorization: { type: "none" },
      },
    });
    for (const enabled of [false, true]) {
      const patched = yield* service.update({
        projectId: projectA,
        id: displayedByA.id,
        enabled,
        patch: "enabled",
      });
      expect(patched).toEqual({ ...replacementByB, enabled });
      expect((yield* service.list(projectA)).external[0]).toMatchObject({
        ...replacementByB,
        enabled,
      });
      const transport = patched.transport;
      if (transport?.type !== "streamable-http") return yield* Effect.die("Expected HTTP");
      expect(yield* secrets.resolve(patched.id, transport.headers[0]!.credential.id)).toBe(
        "patch-retained-secret",
      );
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("enabled patches reject foreign-project and missing targets", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    yield* createProject(projectA, "patch-owner-project");
    yield* createProject(projectB, "patch-foreign-project");
    const entry = yield* service.create({ projectId: projectA, ...codexInput });
    for (const id of [entry.id, McpServerId.make("missing-patch-target")]) {
      const error = yield* service
        .update({
          projectId: projectB,
          id,
          enabled: false,
          patch: "enabled",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ProjectMcpServerNotFoundError", id });
    }
    expect((yield* service.list(projectA)).external[0]).toMatchObject(entry);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("enabled patches preserve legacy URLs, SSE, and lossless stdio transports", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    yield* createProject(projectA, "patch-transport-project");
    const transports: ReadonlyArray<ProjectMcpTransportDraft> = [
      {
        type: "legacy-sse",
        url: "https://legacy.example.test/sse",
        headers: [],
        authorization: { type: "none" },
      },
      {
        type: "stdio",
        command: "node",
        args: ["--label", "", "line1\nline2"],
        cwd: "/tmp",
        env: [],
      },
    ];
    const entries = [yield* service.create({ projectId: projectA, ...codexInput })];
    for (const transport of transports) {
      entries.push(
        yield* service.create({
          projectId: projectA,
          name: transport.type,
          enabled: true,
          providerInstanceIds: [],
          transport,
        }),
      );
    }
    for (const entry of entries) {
      yield* service.update({
        projectId: projectA,
        id: entry.id,
        enabled: false,
        patch: "enabled",
      });
      expect(
        (yield* service.list(projectA)).external.find((server) => server.id === entry.id),
      ).toMatchObject({ ...entry, enabled: false });
    }
  }).pipe(Effect.provide(testLayer)),
);

for (const change of [
  "unchanged",
  "client ID",
  "secret",
  "automatic",
  "explicit",
  "resource",
  "legacy",
] as const) {
  it.effect(`catalog OAuth status follows the current ${change} binding`, () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const oauth = yield* ProjectMcpOAuth.ProjectMcpOAuth;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const projectId = ProjectId.make(`oauth-binding-${change}`);
      yield* createProject(projectId, `create-${projectId}`);
      const resource = "https://oauth.example.test/mcp";
      const transport: ProjectMcpTransportDraft = {
        type: "streamable-http",
        url: resource,
        headers: [],
        authorization: {
          type: "oauth",
          registration:
            change === "explicit"
              ? { type: "automatic" }
              : {
                  type: "pre-registered",
                  clientId: "registered-client",
                  clientSecret: { name: "client secret", value: "original-secret" },
                },
        },
      };
      const entry = yield* service.create({
        projectId,
        name: "OAuth binding",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport,
      });
      const originalBinding = {
        serverId: entry.id,
        resource,
        ...(change === "explicit"
          ? {}
          : { clientId: "registered-client", clientSecret: "original-secret" }),
      };
      if (change === "legacy") {
        yield* secrets.createAuxiliarySecret(
          entry.id,
          encodeUnknownJson({
            kind: "project-mcp-oauth",
            serverId: entry.id,
            resource,
            tokens: { access_token: "legacy-token", token_type: "Bearer" },
          }),
        );
        expect((yield* service.list(projectId)).external[0]?.oauthStatus).toBe("not-connected");
        const provider = yield* oauth.providerFor(entry.id, originalBinding);
        expect(yield* Effect.promise(async () => provider.tokens())).toBeUndefined();
        return;
      }
      const original = yield* oauth.providerFor(entry.id, originalBinding);
      yield* Effect.promise(async () =>
        original.saveTokens({ access_token: "grant-token", token_type: "Bearer" }),
      );
      expect((yield* service.list(projectId)).external[0]?.oauthStatus).toBe("connected");

      const nextResource =
        change === "resource" ? "https://replacement.example.test/mcp" : resource;
      const nextClient = change === "client ID" ? "replacement-client" : "registered-client";
      const nextSecret = change === "secret" ? "replacement-secret" : "original-secret";
      yield* service.update({
        projectId,
        id: entry.id,
        name: entry.name,
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: nextResource,
          headers: [],
          authorization: {
            type: "oauth",
            registration:
              change === "automatic"
                ? { type: "automatic" }
                : {
                    type: "pre-registered",
                    clientId: nextClient,
                    clientSecret: { name: "client secret", value: nextSecret },
                  },
          },
        },
      });
      const catalog = yield* service.list(projectId);
      expect(catalog.external[0]?.oauthStatus).toBe(
        change === "unchanged" ? "connected" : "not-connected",
      );
      const current = yield* oauth.providerFor(entry.id, {
        serverId: entry.id,
        resource: nextResource,
        ...(change === "automatic" ? {} : { clientId: nextClient, clientSecret: nextSecret }),
      });
      expect((yield* Effect.promise(async () => current.tokens()))?.access_token).toBe(
        change === "unchanged" ? "grant-token" : undefined,
      );
      expect(encodeUnknownJson(catalog)).not.toContain("original-secret");
      expect(encodeUnknownJson(catalog)).not.toContain("replacement-secret");
      expect(encodeUnknownJson(catalog)).not.toContain("grant-token");
    }).pipe(
      Effect.provide(
        makeTestLayer(OrchestrationEngineLive, ProjectMcpOAuth.layer({ servers: [] })),
      ),
    ),
  );
}

it.effect("restores explicit MCP transports after the service restarts", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const { dbPath } = config;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstServiceLayer = Layer.fresh(makeRestartTestLayer(persistenceLayer, config));
    const secondServiceLayer = Layer.fresh(makeRestartTestLayer(persistenceLayer, config));
    const projectId = ProjectId.make("restart-explicit-transport-project");
    const sentinel = "restart-stdio-sentinel";
    const transport = {
      type: "stdio" as const,
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: [
        {
          name: ProjectMcpEnvironmentVariableName.make("RESTART_TOKEN"),
          credential: { name: "restart token", value: sentinel },
        },
      ],
    };

    const server = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectId, "create-restart-explicit-transport-project");
      return yield* service.create({
        projectId,
        name: "Restarted stdio",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport,
      });
    }).pipe(Effect.provide(firstServiceLayer));
    const serverTransport = server.transport!;
    if (serverTransport.type !== "stdio") return yield* Effect.die("Expected stdio transport");
    const credentialId = serverTransport.env[0]!.credential.id;

    expect(new TextDecoder().decode(yield* fileSystem.readFile(dbPath))).not.toContain(sentinel);

    const restored = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      return {
        catalog: yield* service.list(projectId),
        resolved: yield* service.resolveForSession(projectId, codexInstance),
        credential: yield* secrets.resolve(server.id, credentialId),
      };
    }).pipe(Effect.provide(secondServiceLayer));

    expect(restored.catalog.external).toEqual([server]);
    expect(restored.resolved).toEqual([
      {
        id: server.id,
        name: server.name,
        transport: serverTransport,
      },
    ]);
    expect(restored.credential).toBe(sentinel);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-restart-" }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("accepts case-distinct stdio environment names on a Unix-like host", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    const projectId = ProjectId.make("case-distinct-unix-project");
    yield* createProject(projectId, "case-distinct-unix-project");

    const server = yield* service.create({
      projectId,
      name: "Case-distinct variables",
      enabled: true,
      providerInstanceIds: [codexInstance],
      transport: caseDistinctStdio("upper", "lower"),
    });
    const resolved = yield* service.resolveForSession(projectId, codexInstance);
    const transport = resolved[0]?.transport;
    expect(transport?.type).toBe("stdio");
    if (transport?.type === "stdio")
      expect(transport.env.map(({ name }) => name)).toEqual(["HTTP_PROXY", "http_proxy"]);
    expect(server.transport?.type).toBe("stdio");
  }).pipe(Effect.provide(makeTestLayer(OrchestrationEngineLive, projectMcpOAuthTestLayer, false))),
);

it.effect("rejects case-distinct stdio environment names on Windows before persistence", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("case-distinct-windows-project");
    yield* createProject(projectId, "case-distinct-windows-project");

    const error = yield* service
      .create({
        projectId,
        name: "Case-distinct variables",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: caseDistinctStdio("upper", "lower"),
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "ProjectMcpEnvironmentVariableNameConflictError",
      name: "http_proxy",
    });
    expect(error.message).toContain("conflicts with another name on Windows");
    expect(yield* secrets.listServerIds()).toEqual([]);
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE event_type = 'project.mcp-server.created'
          AND json_extract(payload_json, '$.projectId') = ${projectId}
      `,
    ).toEqual([{ count: 0 }]);
  }).pipe(
    Effect.provide(
      makeTestLayer(OrchestrationEngineLive, projectMcpOAuthTestLayer, false, "win32"),
    ),
  ),
);

it.effect("rejects a restored case-colliding stdio catalog on Windows before session startup", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(config.dbPath);
    const projectId = ProjectId.make("restored-case-collision-project");
    const firstServiceLayer = Layer.fresh(
      makeRestartTestLayer(persistenceLayer, config, false, "linux"),
    );
    const secondServiceLayer = Layer.fresh(
      makeRestartTestLayer(persistenceLayer, config, false, "win32"),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectId, "restored-case-collision-project");
      yield* service.create({
        projectId,
        name: "Restored case collision",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: caseDistinctStdio("upper", "lower"),
      });
    }).pipe(Effect.provide(firstServiceLayer));

    const error = yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      return yield* service.resolveForSession(projectId, codexInstance).pipe(Effect.flip);
    }).pipe(Effect.provide(secondServiceLayer));

    expect(error).toMatchObject({
      _tag: "ProjectMcpEnvironmentVariableNameConflictError",
      name: "http_proxy",
    });
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-case-restart-" }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("rejects a Windows full update before dispatching or preparing new credentials", () =>
  Effect.gen(function* () {
    const service = yield* ProjectMcpService.ProjectMcpService;
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("case-distinct-update-project");
    yield* createProject(projectId, "case-distinct-update-project");
    const initial = yield* service.create({
      projectId,
      name: "Safe variables",
      enabled: true,
      providerInstanceIds: [codexInstance],
      transport: {
        type: "stdio",
        command: "node",
        args: [],
        env: [
          {
            name: ProjectMcpEnvironmentVariableName.make("SAFE_TOKEN"),
            credential: { name: "safe", value: "before" },
          },
        ],
      },
    });
    const initialTransport = initial.transport;
    if (initialTransport?.type !== "stdio") return yield* Effect.die("Expected stdio transport");
    const initialCredentialIds = ProjectMcpSecretStore.credentialIdsForTransport(initialTransport);
    const secretFilesBefore = yield* fileSystem.readDirectory(config.secretsDir);

    const error = yield* service
      .update({
        projectId,
        id: initial.id,
        name: "Safe variables",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: caseDistinctStdio("new-upper", "new-lower"),
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "ProjectMcpEnvironmentVariableNameConflictError",
      name: "http_proxy",
    });
    expect((yield* service.list(projectId)).external).toEqual([initial]);
    const current = (yield* service.list(projectId)).external[0]?.transport;
    if (current?.type !== "stdio") return yield* Effect.die("Expected stdio transport");
    expect(ProjectMcpSecretStore.credentialIdsForTransport(current)).toEqual(initialCredentialIds);
    expect(yield* secrets.listAuxiliarySecrets(initial.id)).toEqual([]);
    expect(yield* fileSystem.readDirectory(config.secretsDir)).toEqual(secretFilesBefore);
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE event_type = 'project.mcp-server.updated'
          AND json_extract(payload_json, '$.server.id') = ${initial.id}
      `,
    ).toEqual([{ count: 0 }]);
  }).pipe(
    Effect.provide(
      makeTestLayer(OrchestrationEngineLive, projectMcpOAuthTestLayer, false, "win32"),
    ),
  ),
);

it.layer(testLayer)("ProjectMcpService", (it) => {
  it.effect("returns the managed preview descriptor without persisting it as an external row", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("managed-preview-project");
      yield* createProject(projectId, "managed-preview-project");
      const external = yield* service.create({ projectId, ...codexInput });

      const catalog = yield* service.list(projectId);

      expect(catalog.external).toEqual([external]);
      expect(catalog.managed).toEqual([
        {
          id: McpServerId.make("t3-code"),
          name: "t3-code",
          url: "http://127.0.0.1:43123/mcp",
          providerInstanceIds: [
            codexInstance,
            openCodeInstance,
            disabledCursorInstance,
            unavailableInstance,
          ],
        },
      ]);
      expect(catalog.applications).toEqual([
        { serverId: external.id, providerInstanceId: codexInstance, mode: "next-session" },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: codexInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: openCodeInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: disabledCursorInstance,
          mode: "unavailable",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: unavailableInstance,
          mode: "unavailable",
        },
      ]);
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_project_mcp_servers
          WHERE project_id = ${projectId}
        `,
      ).toEqual([{ count: 1 }]);
    }),
  );

  it.effect("derives application modes from live provider capabilities", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("application-modes-project");
      yield* createProject(projectId, "application-modes-project");
      const entry = yield* service.create({
        projectId,
        ...codexInput,
        providerInstanceIds: [codexInstance, openCodeInstance, disabledCursorInstance],
      });

      expect((yield* service.list(projectId)).applications).toEqual([
        { serverId: entry.id, providerInstanceId: codexInstance, mode: "next-session" },
        { serverId: entry.id, providerInstanceId: openCodeInstance, mode: "unsupported" },
        { serverId: entry.id, providerInstanceId: disabledCursorInstance, mode: "unavailable" },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: codexInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: openCodeInstance,
          mode: "next-session",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: disabledCursorInstance,
          mode: "unavailable",
        },
        {
          serverId: McpServerId.make("t3-code"),
          providerInstanceId: unavailableInstance,
          mode: "unavailable",
        },
      ]);
    }),
  );

  it.effect("projects a redacted OAuth connection status", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("oauth-status-project");
      yield* createProject(projectId, "oauth-status-project");
      const entry = yield* service.create({
        projectId,
        name: "OAuth server",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://oauth.example.test/mcp",
          headers: [],
          authorization: { type: "oauth", registration: { type: "automatic" } },
        },
      });

      expect((yield* service.list(projectId)).external).toEqual([
        { ...entry, oauthStatus: "not-connected" },
      ]);
    }),
  );

  it.effect("accepts configured unavailable provider instances but rejects truly absent IDs", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const shadowProject = ProjectId.make("shadow-provider-project");
      const absentProviderId = ProviderInstanceId.make("absent-provider");
      yield* createProject(shadowProject, "shadow-provider-project");

      const entry = yield* service.create({
        projectId: shadowProject,
        ...codexInput,
        providerInstanceIds: [unavailableInstance],
      });
      const catalog = yield* service.list(shadowProject);

      expect(catalog.external).toEqual([entry]);
      expect(
        catalog.applications.find(
          (application) =>
            application.serverId === entry.id &&
            application.providerInstanceId === unavailableInstance,
        ),
      ).toEqual({
        serverId: entry.id,
        providerInstanceId: unavailableInstance,
        mode: "unavailable",
      });

      const error = yield* service
        .create({
          projectId: shadowProject,
          ...codexInput,
          name: "Absent",
          providerInstanceIds: [absentProviderId],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ProjectMcpProviderNotFoundError",
        providerInstanceId: absentProviderId,
      });
    }),
  );

  it.effect("resolves only enabled entries for the selected project and provider", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      yield* createProject(projectA, "create-project-a");
      yield* createProject(projectB, "create-project-b");
      const codexEntry = yield* service.create({ projectId: projectA, ...codexInput });
      yield* service.create({ projectId: projectA, ...disabledInput });
      yield* service.create({ projectId: projectB, ...projectBInput });

      expect(yield* service.resolveForSession(projectA, codexInstance)).toEqual([
        {
          id: codexEntry.id,
          name: codexEntry.name,
          transport: {
            type: "streamable-http",
            url: codexEntry.url!,
            headers: [],
            authorization: { type: "none" },
          },
        },
      ]);
    }),
  );

  it.effect("does not resolve project MCP for an unsupported provider instance", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("unsupported-provider-project");
      yield* createProject(projectId, "unsupported-provider-project");
      yield* service.create({
        projectId,
        ...codexInput,
        providerInstanceIds: [openCodeInstance],
      });

      expect(yield* service.resolveForSession(projectId, openCodeInstance)).toEqual([]);
      expect((yield* service.acquireSessionLease(projectId, openCodeInstance)).servers).toEqual([]);
    }),
  );

  it.effect("persists and resolves an explicit stdio server without a URL", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const projectId = ProjectId.make("stdio-project");
      yield* createProject(projectId, "create-stdio-project");

      const server = yield* service.create({
        projectId,
        name: "Filesystem",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: [],
        },
      });

      expect(yield* service.resolveForSession(projectId, codexInstance)).toEqual([
        {
          id: server.id,
          name: "Filesystem",
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: [],
          },
        },
      ]);
    }),
  );

  it.effect(
    "persists only credential references while retaining, rotating, and retiring values",
    () =>
      Effect.gen(function* () {
        const service = yield* ProjectMcpService.ProjectMcpService;
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("secret-lifecycle-project");
        const sentinel = "header-create-sentinel";
        yield* createProject(projectId, "create-secret-lifecycle-project");

        const created = yield* service.create({
          projectId,
          name: "Secret lifecycle",
          enabled: true,
          providerInstanceIds: [codexInstance],
          transport: {
            type: "streamable-http",
            url: "https://secrets.example.test/mcp",
            headers: [
              {
                name: ProjectMcpHeaderName.make("X-Api-Key"),
                credential: { name: "API key", value: sentinel },
              },
            ],
            authorization: {
              type: "oauth",
              registration: {
                type: "pre-registered",
                clientId: "project-mcp-client",
                clientSecret: { name: "client secret", value: "oauth-client-sentinel" },
              },
            },
          },
        });
        const createdTransport = created.transport!;
        if (createdTransport.type !== "streamable-http")
          return yield* Effect.die("Expected HTTP transport");
        const headerId = createdTransport.headers[0]!.credential.id;
        const clientSecretId =
          createdTransport.authorization.type === "oauth" &&
          createdTransport.authorization.registration.type === "pre-registered"
            ? createdTransport.authorization.registration.clientSecret?.id
            : undefined;

        expect(yield* secrets.resolve(created.id, headerId)).toBe(sentinel);
        expect(yield* secrets.resolve(created.id, clientSecretId!)).toBe("oauth-client-sentinel");
        expect(encodeUnknownJson(created)).not.toContain(sentinel);
        expect(encodeUnknownJson(yield* service.list(projectId))).not.toContain(sentinel);
        expect(
          encodeUnknownJson(yield* projectionSnapshotQuery.getCommandReadModel()),
        ).not.toContain(sentinel);
        const persisted = yield* sql<{
          readonly transportJson: string;
          readonly payloadJson: string;
        }>`
        SELECT
          projection.transport_json AS "transportJson",
          event.payload_json AS "payloadJson"
        FROM projection_project_mcp_servers AS projection
        INNER JOIN orchestration_events AS event
          ON event.event_type = 'project.mcp-server.created'
          AND json_extract(event.payload_json, '$.server.id') = projection.server_id
        WHERE projection.server_id = ${created.id}
      `;
        expect(persisted).toHaveLength(1);
        expect(persisted[0]!.transportJson).not.toContain(sentinel);
        expect(persisted[0]!.payloadJson).not.toContain(sentinel);

        const retained = yield* service.update({
          projectId,
          id: created.id,
          name: "Secret lifecycle",
          enabled: true,
          providerInstanceIds: [codexInstance],
          transport: {
            type: "streamable-http",
            url: "https://secrets.example.test/mcp",
            headers: [
              {
                name: ProjectMcpHeaderName.make("X-Api-Key"),
                credential: { id: headerId, name: "renamed API key" },
              },
            ],
            authorization: { type: "none" },
          },
        });
        const retainedTransport = retained.transport!;
        if (retainedTransport.type !== "streamable-http")
          return yield* Effect.die("Expected HTTP transport");
        expect(retainedTransport.headers[0]!.credential.id).toBe(headerId);
        expect(yield* secrets.resolve(created.id, headerId)).toBe(sentinel);

        const rotated = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* secrets.acquireLease(created.id, [headerId]);
            const updated = yield* service.update({
              projectId,
              id: created.id,
              name: "Secret lifecycle",
              enabled: true,
              providerInstanceIds: [codexInstance],
              transport: {
                type: "streamable-http",
                url: "https://secrets.example.test/mcp",
                headers: [
                  {
                    name: ProjectMcpHeaderName.make("X-Api-Key"),
                    credential: {
                      id: headerId,
                      name: "renamed API key",
                      value: "header-rotated-sentinel",
                    },
                  },
                ],
                authorization: { type: "none" },
              },
            });
            const transport = updated.transport!;
            if (transport.type !== "streamable-http")
              return yield* Effect.die("Expected HTTP transport");
            return {
              id: transport.headers[0]!.credential.id,
              oldValue: yield* lease.resolve(headerId),
            };
          }),
        );
        expect(rotated.id).not.toBe(headerId);
        expect(rotated.oldValue).toBe(sentinel);
        expect(yield* secrets.resolve(created.id, rotated.id)).toBe("header-rotated-sentinel");

        yield* service.remove({ projectId, id: created.id });
        const removed = yield* secrets.resolve(created.id, rotated.id).pipe(Effect.flip);
        expect(removed).toMatchObject({
          _tag: "ProjectMcpSecretOwnershipError",
          serverId: created.id,
          credentialId: rotated.id,
        });
      }),
  );

  it.effect("holds every session credential until its provider scope closes", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secretFiles = yield* ServerSecretStore.ServerSecretStore;
      const projectId = ProjectId.make("session-lease-project");
      yield* createProject(projectId, "create-session-lease-project");
      const server = yield* service.create({
        projectId,
        name: "Leased credentials",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://leased.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "key", value: "session-lease-sentinel" },
            },
          ],
          authorization: { type: "none" },
        },
      });
      const transport = server.transport!;
      if (transport.type === "stdio") return yield* Effect.die("Expected HTTP transport");
      const credentialId = transport.headers[0]!.credential.id;
      const scope = yield* Scope.make();

      const acquired = yield* service
        .acquireSessionLease(projectId, codexInstance)
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* service.remove({ projectId, id: server.id });

      expect(acquired.resolveSecret(server.id, credentialId)).toBe("session-lease-sentinel");

      expect(
        Option.isSome(
          yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(credentialId)),
        ),
      ).toBe(true);

      yield* Scope.close(scope, Exit.void);
      expect(
        Option.isNone(
          yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(credentialId)),
        ),
      ).toBe(true);
    }),
  );

  it.effect("leases OAuth state for live sessions through catalog removal", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const secretFiles = yield* ServerSecretStore.ServerSecretStore;
      const projectId = ProjectId.make("oauth-session-lease-project");
      yield* createProject(projectId, "create-oauth-session-lease-project");
      const server = yield* service.create({
        projectId,
        name: "OAuth state lease",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://oauth-session.example.test/mcp",
          headers: [],
          authorization: { type: "oauth", registration: { type: "automatic" } },
        },
      });
      const stateId = yield* secrets.createAuxiliarySecret(server.id, "oauth-session-state");
      const firstScope = yield* Scope.make();
      const first = yield* service
        .acquireSessionLease(projectId, codexInstance)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const stateLease = first.oauthStateLeases.get(server.id);
      expect(stateLease).toBeDefined();
      if (!stateLease) return yield* Effect.die("Expected an OAuth state lease");

      yield* service.remove({ projectId, id: server.id });
      const secondScope = yield* Scope.make();
      const second = yield* service
        .acquireSessionLease(projectId, codexInstance)
        .pipe(Effect.provideService(Scope.Scope, secondScope));
      expect(second.servers.some(({ id }) => id === server.id)).toBe(false);
      expect(yield* stateLease.resolve(stateId)).toBe("oauth-session-state");

      yield* Scope.close(firstScope, Exit.void);
      expect(
        Option.isNone(yield* secretFiles.get(ProjectMcpSecretStore.credentialSecretName(stateId))),
      ).toBe(true);
      yield* Scope.close(secondScope, Exit.void);
    }),
  );

  it.effect("serializes each server mutation through dispatch and secret commit", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const projectId = ProjectId.make("serialized-mutation-project");
      yield* createProject(projectId, "create-serialized-mutation-project");
      const initial = yield* service.create({
        projectId,
        name: "Serialized",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://serialized.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "key", value: "serialized-initial-sentinel" },
            },
          ],
          authorization: { type: "none" },
        },
      });

      yield* Effect.all(
        [
          service.update({
            projectId,
            id: initial.id,
            name: "First update",
            enabled: true,
            providerInstanceIds: [codexInstance],
            transport: {
              type: "streamable-http",
              url: "https://first.example.test/mcp",
              headers: [
                {
                  name: ProjectMcpHeaderName.make("X-Api-Key"),
                  credential: { name: "key", value: "serialized-first-sentinel" },
                },
              ],
              authorization: { type: "none" },
            },
          }),
          service.update({
            projectId,
            id: initial.id,
            name: "Second update",
            enabled: true,
            providerInstanceIds: [codexInstance],
            transport: {
              type: "streamable-http",
              url: "https://second.example.test/mcp",
              headers: [
                {
                  name: ProjectMcpHeaderName.make("X-Api-Key"),
                  credential: { name: "key", value: "serialized-second-sentinel" },
                },
              ],
              authorization: { type: "none" },
            },
          }),
        ],
        { concurrency: "unbounded" },
      );

      const secretFiles = yield* fileSystem.readDirectory(config.secretsDir);
      const contents = yield* Effect.forEach(secretFiles, (file) =>
        fileSystem.readFile(`${config.secretsDir}/${file}`),
      );
      const secretText = contents.map((content) => new TextDecoder().decode(content)).join("\n");
      expect(secretText).not.toContain("serialized-first-sentinel");
      expect(secretText).toContain("serialized-second-sentinel");
      expect((yield* service.list(projectId)).external[0]?.name).toBe("Second update");
    }),
  );

  it.effect("rolls back prepared create credentials when catalog dispatch fails", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const engine = yield* OrchestrationEngineService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const projectId = ProjectId.make("create-rollback-project");
      const missingProjectId = ProjectId.make("missing-create-rollback-project");
      yield* createProject(projectId, "create-create-rollback-project");
      const active = yield* service.create({
        projectId,
        name: "Existing secret",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://existing-secret.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "existing", value: "existing-rollback-sentinel" },
            },
          ],
          authorization: { type: "none" },
        },
      });
      yield* service.drainThrough(yield* engine.latestSequence);
      const activeTransport = active.transport!;
      if (activeTransport.type !== "streamable-http")
        return yield* Effect.die("Expected HTTP transport");
      const activeCredentialId = activeTransport.headers[0]!.credential.id;

      const error = yield* service
        .create({
          projectId: missingProjectId,
          name: "Rejected secret",
          enabled: true,
          providerInstanceIds: [codexInstance],
          transport: {
            type: "streamable-http",
            url: "https://rejected-secret.example.test/mcp",
            headers: [
              {
                name: ProjectMcpHeaderName.make("X-Api-Key"),
                credential: { name: "rejected", value: "rejected-rollback-sentinel" },
              },
            ],
            authorization: { type: "none" },
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "project.mcp-server.create",
      });
      expect(yield* secrets.resolve(active.id, activeCredentialId)).toBe(
        "existing-rollback-sentinel",
      );
      const secretFiles = yield* fileSystem.readDirectory(config.secretsDir);
      const contents = yield* Effect.forEach(secretFiles, (file) =>
        fileSystem.readFile(`${config.secretsDir}/${file}`),
      );
      expect(contents.map((content) => new TextDecoder().decode(content)).join("\n")).not.toContain(
        "rejected-rollback-sentinel",
      );
    }),
  );

  it.effect("reconciles a transient post-dispatch create failure before returning", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const files = yield* ServerSecretStore.ServerSecretStore;
      const projectId = ProjectId.make("post-dispatch-create-project");
      const originalSet = files.set;
      let failures = 1;
      const set = vi.spyOn(files, "set").mockImplementation((name, value) =>
        name === "project-mcp-secret-manifest" && failures > 0
          ? Effect.suspend(() => {
              failures--;
              return Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: "injected manifest failure",
                }),
              );
            })
          : originalSet(name, value),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => set.mockRestore()));
      yield* createProject(projectId, "post-dispatch-create-project");
      const server = yield* service.create({
        projectId,
        name: "Transient create",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://transient-create.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "api key", value: "transient-create-secret" },
            },
          ],
          authorization: { type: "none" },
        },
      });
      const sequence = yield* engine.latestSequence;
      yield* service.drainThrough(sequence);
      expect(failures).toBe(0);
      const transport = server.transport!;
      if (transport.type !== "streamable-http")
        return yield* Effect.die("Expected streamable HTTP transport");
      expect(yield* secrets.resolve(server.id, transport.headers[0]!.credential.id)).toBe(
        "transient-create-secret",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles transient post-dispatch update and remove failures before returning", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const files = yield* ServerSecretStore.ServerSecretStore;
      const projectId = ProjectId.make("post-dispatch-update-remove-project");
      yield* createProject(projectId, "post-dispatch-update-remove-project");
      const initial = yield* service.create({
        projectId,
        name: "Transient update/remove",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://transient-initial.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "initial key", value: "transient-initial-secret" },
            },
          ],
          authorization: { type: "none" },
        },
      });
      const initialTransport = initial.transport;
      if (initialTransport?.type !== "streamable-http")
        return yield* Effect.die("Expected streamable HTTP transport");
      const initialCredentialId = initialTransport.headers[0]!.credential.id;
      const originalSet = files.set;
      let failures = 2;
      const set = vi.spyOn(files, "set").mockImplementation((name, value) =>
        name === "project-mcp-secret-manifest" && failures > 0
          ? Effect.suspend(() => {
              failures--;
              return Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: "injected update/remove manifest failure",
                }),
              );
            })
          : originalSet(name, value),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => set.mockRestore()));

      const updated = yield* service.update({
        projectId,
        id: initial.id,
        name: "Transient update/remove",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http",
          url: "https://transient-updated.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "updated key", value: "transient-updated-secret" },
            },
          ],
          authorization: { type: "none" },
        },
      });
      const updatedTransport = updated.transport;
      if (updatedTransport?.type !== "streamable-http")
        return yield* Effect.die("Expected streamable HTTP transport");
      const updatedCredentialId = updatedTransport.headers[0]!.credential.id;
      expect(yield* secrets.resolve(updated.id, updatedCredentialId)).toBe(
        "transient-updated-secret",
      );
      expect(
        Option.isNone(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(initialCredentialId)),
        ),
      ).toBe(true);

      yield* service.remove({ projectId, id: updated.id });
      expect((yield* service.list(projectId)).external).toEqual([]);
      expect(failures).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports a committed create and repairs it after a persistent manifest failure", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const files = yield* ServerSecretStore.ServerSecretStore;
      const projectId = ProjectId.make("persistent-create-project");
      const originalSet = files.set;
      const set = vi.spyOn(files, "set").mockImplementation((name, _value) =>
        name === "project-mcp-secret-manifest"
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: "injected persistent manifest failure",
              }),
            )
          : originalSet(name, _value),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => set.mockRestore()));
      yield* createProject(projectId, "persistent-create-project");
      const input = {
        projectId,
        name: "Persistent create",
        enabled: true,
        providerInstanceIds: [codexInstance],
        transport: {
          type: "streamable-http" as const,
          url: "https://persistent-create.example.test/mcp",
          headers: [
            {
              name: ProjectMcpHeaderName.make("X-Api-Key"),
              credential: { name: "api key", value: "persistent-create-secret" },
            },
          ],
          authorization: { type: "none" as const },
        },
      };
      const error = yield* service.create(input).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectMcpCatalogCommittedCleanupPendingError);
      expect(error).toMatchObject({ operation: "create" });
      if (!isProjectMcpCatalogCommittedCleanupPendingError(error))
        return yield* Effect.die("Expected a committed cleanup-pending error");
      expect((yield* service.list(projectId)).external).toHaveLength(1);
      const id = error.id;
      set.mockRestore();

      const updated = yield* service.update({
        ...input,
        id,
        name: "Persistent create repaired",
      });
      yield* service.drainThrough(yield* engine.latestSequence);
      const transport = updated.transport!;
      if (transport.type !== "streamable-http")
        return yield* Effect.die("Expected streamable HTTP transport");
      expect(yield* secrets.resolve(id, transport.headers[0]!.credential.id)).toBe(
        "persistent-create-secret",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports a committed remove and repairs it after a persistent cleanup failure", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const files = yield* ServerSecretStore.ServerSecretStore;
      const originalSet = files.set;
      const projectId = ProjectId.make("persistent-remove-project");
      yield* createProject(projectId, "persistent-remove-project");
      const removed = yield* createSecretServer(projectId, "persistent-remove");
      yield* service.drainThrough(yield* engine.latestSequence);
      const set = vi.spyOn(files, "set").mockImplementation((name, _value) =>
        name === "project-mcp-secret-manifest"
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: "injected persistent removal failure",
              }),
            )
          : originalSet(name, _value),
      );
      const error = yield* service.remove({ projectId, id: removed.server.id }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectMcpCatalogCommittedCleanupPendingError);
      expect(error).toMatchObject({ operation: "remove", id: removed.server.id });
      expect((yield* service.list(projectId)).external).toEqual([]);
      set.mockRestore();

      yield* createSecretServer(projectId, "persistent-remove-repaired");
      yield* service.drainThrough(yield* engine.latestSequence);
      expect(
        Option.isNone(
          yield* files.get(ProjectMcpSecretStore.credentialSecretName(removed.credentialId)),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("startup reconciliation repairs a committed MCP create after a failed recovery", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const persistenceLayer = makeSqlitePersistenceLive(config.dbPath);
      const projectId = ProjectId.make("mcp-create-recovery-restart-project");
      const server = yield* Effect.gen(function* () {
        const service = yield* ProjectMcpService.ProjectMcpService;
        const files = yield* ServerSecretStore.ServerSecretStore;
        const originalSet = files.set;
        const set = vi.spyOn(files, "set").mockImplementation((name, _value) =>
          name === "project-mcp-secret-manifest"
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: "injected restart manifest failure",
                }),
              )
            : originalSet(name, _value),
        );
        yield* createProject(projectId, "mcp-create-recovery-restart");
        const input = {
          projectId,
          name: "Restart recovery",
          enabled: true,
          providerInstanceIds: [codexInstance],
          transport: {
            type: "streamable-http" as const,
            url: "https://restart-recovery.example.test/mcp",
            headers: [
              {
                name: ProjectMcpHeaderName.make("X-Api-Key"),
                credential: { name: "api key", value: "restart-recovery-secret" },
              },
            ],
            authorization: { type: "none" as const },
          },
        };
        const error = yield* service.create(input).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProjectMcpCatalogCommittedCleanupPendingError);
        expect(error).toMatchObject({ operation: "create" });
        const catalog = yield* service.list(projectId);
        expect(catalog.external).toHaveLength(1);
        const created = catalog.external[0];
        if (!created) return yield* Effect.die("Expected committed MCP server");
        set.mockRestore();
        return created;
      }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistenceLayer, config, false))));

      const restored = yield* Effect.gen(function* () {
        const service = yield* ProjectMcpService.ProjectMcpService;
        const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
        const catalog = yield* service.list(projectId);
        const transport = catalog.external[0]?.transport;
        if (!transport || transport.type !== "streamable-http")
          return yield* Effect.die("Expected restored streamable HTTP transport");
        return {
          catalog,
          credential: yield* secrets.resolve(server.id, transport.headers[0]!.credential.id),
        };
      }).pipe(Effect.provide(Layer.fresh(makeRestartTestLayer(persistenceLayer, config))));

      expect(restored.catalog.external).toEqual([server]);
      expect(restored.credential).toBe("restart-recovery-secret");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-create-recovery-restart-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("deletes an external entry without affecting another project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const deleteProjectA = ProjectId.make("delete-project-a");
      const deleteProjectB = ProjectId.make("delete-project-b");
      yield* createProject(deleteProjectA, "delete-project-a");
      yield* createProject(deleteProjectB, "delete-project-b");
      const projectAEntry = yield* service.create({ projectId: deleteProjectA, ...codexInput });
      const projectBEntry = yield* service.create({ projectId: deleteProjectB, ...projectBInput });

      yield* service.remove({ projectId: deleteProjectA, id: projectAEntry.id });

      expect((yield* service.list(deleteProjectA)).external).toEqual([]);
      expect(yield* service.resolveForSession(deleteProjectA, codexInstance)).toEqual([]);
      expect((yield* service.list(deleteProjectB)).external).toEqual([projectBEntry]);
    }),
  );

  it.effect("rejects a create that reuses a server ID from another project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const firstProject = ProjectId.make("duplicate-id-project-a");
      const secondProject = ProjectId.make("duplicate-id-project-b");
      yield* createProject(firstProject, "duplicate-id-project-a");
      yield* createProject(secondProject, "duplicate-id-project-b");
      const server = yield* service.create({ projectId: firstProject, ...codexInput });

      const exit = yield* Effect.exit(
        engine.dispatch({
          type: "project.mcp-server.create",
          commandId: CommandId.make("duplicate-mcp-server-id"),
          projectId: secondProject,
          server: { ...server, name: "Other project docs" },
          createdAt: "2026-09-02T20:00:00.000Z",
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "project.mcp-server.create",
          detail: `MCP server ID '${server.id}' is already in use.`,
        });
      }
    }),
  );

  it.effect("preserves a typed name conflict cause when the decider catches a race", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const raceProject = ProjectId.make("name-race-project");
      yield* createProject(raceProject, "name-race-project");
      yield* service.create({ projectId: raceProject, ...codexInput });

      const error = yield* engine
        .dispatch({
          type: "project.mcp-server.create",
          commandId: CommandId.make("name-race-command"),
          projectId: raceProject,
          server: {
            id: McpServerId.make("name-race-server"),
            ...codexInput,
            name: "docs",
          },
          createdAt: "2026-09-02T20:00:00.000Z",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        cause: { _tag: "ProjectMcpNameConflictError", name: "docs" },
      });
    }),
  );

  it.effect("removes persisted MCP rows when their project is deleted", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const deletedProject = ProjectId.make("deleted-mcp-project");
      yield* createProject(deletedProject, "deleted-mcp-project");
      yield* service.create({ projectId: deletedProject, ...codexInput });

      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("delete-mcp-project"),
        projectId: deletedProject,
      });

      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_project_mcp_servers
          WHERE project_id = ${deletedProject}
        `,
      ).toEqual([{ count: 0 }]);
    }),
  );

  it.effect("keeps empty selections and stale provider IDs while rejecting newly unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const engine = yield* OrchestrationEngineService;
      const staleProviderId = ProviderInstanceId.make("retired");
      const staleProject = ProjectId.make("stale-project-a");
      yield* createProject(staleProject, "stale-project-a");
      const unattached = yield* service.create({
        projectId: staleProject,
        name: "Unattached",
        url: "https://unattached.example.test/mcp",
        enabled: true,
        providerInstanceIds: [],
      });
      yield* engine.dispatch({
        type: "project.mcp-server.create",
        commandId: CommandId.make("stale-provider-entry"),
        projectId: staleProject,
        server: {
          id: McpServerId.make("mcp-stale"),
          name: "Stale",
          url: "https://stale.example.test/mcp",
          enabled: true,
          providerInstanceIds: [staleProviderId],
        },
        createdAt: "2026-09-02T20:00:00.000Z",
      });

      const persisted = (yield* service.list(staleProject)).external;
      expect(persisted.find((entry) => entry.id === unattached.id)?.providerInstanceIds).toEqual(
        [],
      );
      expect(
        persisted.find((entry) => entry.id === McpServerId.make("mcp-stale"))?.providerInstanceIds,
      ).toEqual([staleProviderId]);
      expect(
        (yield* service.list(staleProject)).applications.find(
          (application) => application.serverId === McpServerId.make("mcp-stale"),
        )?.mode,
      ).toBe("unavailable");
      yield* service.update({
        projectId: staleProject,
        id: McpServerId.make("mcp-stale"),
        name: "Stale renamed",
        url: "https://stale.example.test/mcp",
        enabled: true,
        providerInstanceIds: [staleProviderId],
      });
      const unknown = yield* service
        .create({
          projectId: staleProject,
          name: "Unknown provider",
          url: "https://unknown.example.test/mcp",
          enabled: true,
          providerInstanceIds: [staleProviderId],
        })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({
        _tag: "ProjectMcpProviderNotFoundError",
        providerInstanceId: staleProviderId,
      });
    }),
  );

  it.effect("rejects unsafe URLs and case-folded duplicate names", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const validationProject = ProjectId.make("validation-project-a");
      yield* createProject(validationProject, "validation-project-a");
      yield* service.create({ projectId: validationProject, ...codexInput });

      const duplicate = yield* service
        .create({ projectId: validationProject, ...codexInput, name: "docs" })
        .pipe(Effect.flip);
      expect(duplicate).toMatchObject({ _tag: "ProjectMcpNameConflictError" });
      const unsafeUrl = yield* service
        .create({
          projectId: validationProject,
          name: "Unsafe",
          url: "http://example.test/mcp?token=secret",
          enabled: true,
          providerInstanceIds: [],
        })
        .pipe(Effect.flip);
      expect(unsafeUrl).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("returns a typed error when the project MCP limit is exhausted", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const validationProject = ProjectId.make("limit-project-a");
      yield* createProject(validationProject, "limit-project-a");

      for (let index = 0; index < 50; index += 1) {
        yield* service.create({
          projectId: validationProject,
          name: `Server ${index}`,
          url: `https://server-${index}.example.test/mcp`,
          enabled: true,
          providerInstanceIds: [],
        });
      }
      const limit = yield* service
        .create({
          projectId: validationProject,
          name: "Overflow",
          url: "https://overflow.example.test/mcp",
          enabled: true,
          providerInstanceIds: [],
        })
        .pipe(Effect.flip);
      expect(limit).toMatchObject({ _tag: "ProjectMcpServerLimitExceededError", limit: 50 });
    }),
  );

  it.effect("returns typed errors for missing update and remove targets", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const missingProject = ProjectId.make("missing-target-project");
      const missingId = McpServerId.make("missing-server");
      yield* createProject(missingProject, "missing-target-project");

      const updateError = yield* service
        .update({
          projectId: missingProject,
          id: missingId,
          ...codexInput,
        })
        .pipe(Effect.flip);
      const removeError = yield* service
        .remove({ projectId: missingProject, id: missingId })
        .pipe(Effect.flip);

      expect(updateError).toMatchObject({ _tag: "ProjectMcpServerNotFoundError", id: missingId });
      expect(removeError).toMatchObject({ _tag: "ProjectMcpServerNotFoundError", id: missingId });
    }),
  );

  it.effect("rebuilds the MCP projection from events with the same rows as live projection", () =>
    Effect.gen(function* () {
      const service = yield* ProjectMcpService.ProjectMcpService;
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const replayProject = ProjectId.make("replay-project-a");
      yield* createProject(replayProject, "replay-project-a");
      const entry = yield* service.create({ projectId: replayProject, ...codexInput });
      yield* service.update({
        projectId: replayProject,
        id: entry.id,
        name: "Docs v2",
        url: entry.url,
        enabled: false,
        providerInstanceIds: [],
      });
      const live = yield* sql`
        SELECT server_id, project_id, name, url, enabled, provider_instance_ids_json
        FROM projection_project_mcp_servers
        ORDER BY server_id
      `;

      yield* sql`DELETE FROM projection_project_mcp_servers`;
      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.project-mcp-servers'`;
      yield* pipeline.bootstrap;
      const replayed = yield* sql`
        SELECT server_id, project_id, name, url, enabled, provider_instance_ids_json
        FROM projection_project_mcp_servers
        ORDER BY server_id
      `;

      expect(replayed).toEqual(live);
    }),
  );
});
