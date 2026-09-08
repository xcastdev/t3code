// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  OrchestrationCommand,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "@t3tools/contracts";
import {
  CommandId,
  EnvironmentId,
  ApprovalRequestId,
  EventId,
  McpCatalogSessionId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ProviderSessionStartInput,
  ThreadId,
  type ResolvedProjectMcpServer,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, describe, vi } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive, type ProviderServiceLiveOptions } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectMcpService from "../../project/ProjectMcpService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ProjectMcpProxyRegistry from "../../mcp/ProjectMcpProxyRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);
const defaultProjectId = ProjectId.make("provider-service-project");
const makeProviderProjectContextTestLayer = (
  resolveForSession: ProjectMcpService.ProjectMcpServiceShape["resolveForSession"] = () =>
    Effect.succeed([]),
  acquireSessionLease: ProjectMcpService.ProjectMcpServiceShape["acquireSessionLease"] = () =>
    Effect.succeed({ servers: [], resolveSecret: () => undefined, oauthStateLeases: new Map() }),
  commandReadModel?: unknown,
  acquireResolvedSessionLease: ProjectMcpService.ProjectMcpServiceShape["acquireResolvedSessionLease"] = (
    servers,
  ) => Effect.succeed({ servers, resolveSecret: () => undefined, oauthStateLeases: new Map() }),
) =>
  Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getThreadShellById: () =>
        Effect.succeed(
          Option.some(
            commandReadModel === undefined
              ? { projectId: defaultProjectId }
              : {
                  projectId: (commandReadModel as { threads: Array<{ projectId: ProjectId }> })
                    .threads[0]!.projectId,
                  session: (commandReadModel as { threads: Array<{ session?: unknown }> })
                    .threads[0]?.session,
                },
          ),
        ),
      ...(commandReadModel === undefined
        ? {}
        : { getCommandReadModel: () => Effect.succeed(commandReadModel) }),
    } as never),
    Layer.succeed(ProjectMcpService.ProjectMcpService, {
      resolveForSession,
      acquireSessionLease,
      acquireResolvedSessionLease,
    } as never),
  );

const makeTestProviderServiceLive = (
  options?: Parameters<typeof makeProviderServiceLive>[0],
  projectContextLayer = makeProviderProjectContextTestLayer(),
) => makeProviderServiceLive(options).pipe(Layer.provide(projectContextLayer));

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const subscribed = Deferred.makeUnsafe<void>();

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const uploadFeedback = vi.fn(
    (
      input: ProviderUploadFeedbackInput,
    ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
      Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      remoteHttpMcp: "next-session",
      managedPreviewMcp: "next-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    ...(provider === CODEX_DRIVER ? { uploadFeedback } : {}),
    stopAll,
    get streamEvents() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(runtimeEventPubSub);
          yield* Deferred.succeed(subscribed, undefined);
          return Stream.fromSubscription(subscription);
        }),
      );
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    subscribed: Deferred.await(subscribed),
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    uploadFeedback,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer(
  issueMcpCredential?: ProviderServiceLiveOptions["issueMcpCredential"],
) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const projectMcpServer = {
    id: McpServerId.make("mcp-docs"),
    name: "t3-code",
    transport: {
      type: "streamable-http",
      url: "https://docs.example.test/mcp",
      headers: [],
      authorization: { type: "none" },
    },
  } as const;
  const issuedProjectMcpServer = {
    id: projectMcpServer.id,
    name: projectMcpServer.name,
    endpoint: new URL("http://127.0.0.1:43123/mcp/project/project-endpoint"),
    authorizationHeader: "Bearer project-token",
  } as const;
  const resolveProjectMcp = vi.fn<ProjectMcpService.ProjectMcpServiceShape["resolveForSession"]>(
    () => Effect.succeed([projectMcpServer]),
  );
  let releasedSessionLeases = 0;
  const acquireProjectMcpLease = vi.fn<
    ProjectMcpService.ProjectMcpServiceShape["acquireSessionLease"]
  >(() =>
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        releasedSessionLeases += 1;
      }),
    ).pipe(
      Effect.as({
        servers: [projectMcpServer],
        resolveSecret: () => undefined,
        oauthStateLeases: new Map(),
      }),
    ),
  );

  const layer = it.layer(
    Layer.mergeAll(
      makeTestProviderServiceLive(
        issueMcpCredential === undefined ? undefined : { issueMcpCredential },
        makeProviderProjectContextTestLayer(resolveProjectMcp, acquireProjectMcpLease),
      ).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    projectMcpServer,
    issuedProjectMcpServer,
    resolveProjectMcp,
    acquireProjectMcpLease,
    get releasedSessionLeases() {
      return releasedSessionLeases;
    },
    layer,
  };
}

it.effect("starts providers from the durable catalog and persists application", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-durable-catalog");
    const sessionId = McpCatalogSessionId.make("catalog-session-durable");
    const projectId = ProjectId.make("project-durable-catalog");
    const logicalServerId = McpServerId.make("durable-server");
    const definition = {
      definitionId: "definition-durable",
      logicalServerId,
      scope: "global" as const,
      scopeId: "environment-durable",
      name: "Durable server",
      transport: {
        type: "streamable-http" as const,
        url: "https://durable.example.test/mcp",
        headers: [
          {
            name: "X-Api-Key",
            credential: { id: "11111111-1111-4111-8111-111111111111", name: "api-key" },
          },
        ],
        authorization: { type: "none" as const },
      },
      enabled: true,
      providerInstanceIds: [codexInstanceId],
      revision: 1,
    };
    const snapshot = {
      catalogSessionId: sessionId,
      threadId,
      providerInstanceId: codexInstanceId,
      baseline: [definition],
      desired: [definition],
      desiredRevision: 1,
      appliedRevision: 0,
    };
    const readModel = {
      threads: [
        {
          id: threadId,
          projectId,
          session: { mcpCatalogSessionId: sessionId },
        },
      ],
      mcpCatalog: {
        environmentId: "environment-durable",
        globalRevision: 1,
        globalDefinitions: [definition],
        projectRevisions: [],
        projectDefinitions: [],
        projectOverrides: [],
        sessions: [snapshot],
      },
    };
    const acquired = vi.fn((servers: ReadonlyArray<ResolvedProjectMcpServer>) =>
      Effect.succeed({ servers, resolveSecret: () => undefined, oauthStateLeases: new Map() }),
    );
    const issued = vi.fn(
      (request: Parameters<typeof McpSessionRegistry.issueActiveMcpCredential>[0]) =>
        Effect.succeed({
          config: {
            environmentId: EnvironmentId.make("environment-durable"),
            threadId: request.threadId,
            providerSessionId: "provider-session-durable",
            providerInstanceId: request.providerInstanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer durable-token",
            projectServers: (request.projectMcpServers ?? []).map((server) => ({
              id: server.id,
              name: server.name,
              endpoint: new URL("http://127.0.0.1:43123/mcp/project/durable"),
              authorizationHeader: "Bearer durable-token",
            })),
          },
        }),
    );
    const applied = vi.fn((_command: OrchestrationCommand) => Effect.succeed({ sequence: 2 }));
    const adapter = makeFakeCodexAdapter();
    const providerLayer = makeTestProviderServiceLive(
      { issueMcpCredential: issued },
      makeProviderProjectContextTestLayer(
        undefined,
        () => Effect.die("legacy lease should not be used"),
        readModel,
        acquired,
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [CODEX_DRIVER]: adapter.adapter }),
        ),
      ),
      Layer.provide(
        ProviderSessionDirectoryLive.pipe(
          Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
        ),
      ),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: applied,
        } as never),
      ),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(acquired.mock.calls.length, 1);
      assert.deepEqual(
        acquired.mock.calls[0]?.[0].map(({ id, name }) => ({ id, name })),
        [{ id: logicalServerId, name: "Durable server" }],
      );
      assert.equal(issued.mock.calls.length, 1);
      assert.deepEqual(
        issued.mock.calls[0]?.[0].projectMcpServers?.map(({ id, name }) => ({ id, name })),
        [{ id: logicalServerId, name: "Durable server" }],
      );
      assert.deepEqual(applied.mock.calls[0]?.[0], {
        type: "thread.mcp-catalog.applied",
        commandId: CommandId.make(
          "server:mcp-catalog-applied:thread-durable-catalog:catalog-session-durable:1",
        ),
        threadId,
        mcpCatalogSessionId: sessionId,
        revision: 1,
        appliedAt: "1970-01-01T00:00:00.000Z",
      });
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeTestProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeTestProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeTestProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer((request) =>
  Effect.succeed({
    config: {
      environmentId: EnvironmentId.make("provider-service-environment"),
      threadId: request.threadId,
      providerSessionId: `provider-session-${request.threadId}`,
      providerInstanceId: request.providerInstanceId,
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer preview-token",
      projectServers: [
        {
          id: McpServerId.make("mcp-docs"),
          name: "t3-code",
          endpoint: new URL("http://127.0.0.1:43123/mcp/project/project-endpoint"),
          authorizationHeader: "Bearer project-token",
        },
      ],
    },
  }),
);

const makeMcpLifecycleHarness = Effect.fn("makeMcpLifecycleHarness")(function* (
  leaseGate: Effect.Effect<void> = Effect.void,
) {
  const original = makeFakeCodexAdapter();
  let current: ReturnType<typeof makeFakeCodexAdapter> | undefined = original;
  const changes = yield* PubSub.unbounded<void>();
  const forwarded = yield* Queue.unbounded<ProviderRuntimeEvent>();
  let reconcileBarrier: { remaining: number; done: Deferred.Deferred<void> } | undefined;
  const base = makeAdapterRegistryMock({ [CODEX_DRIVER]: original.adapter });
  const registry: ProviderAdapterRegistry.ProviderAdapterRegistryShape = {
    ...base,
    getByInstance: () =>
      current
        ? Effect.succeed(current.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider: CODEX_DRIVER })),
    listInstances: () =>
      Effect.gen(function* () {
        if (reconcileBarrier && --reconcileBarrier.remaining === 0) {
          yield* Deferred.succeed(reconcileBarrier.done, undefined);
        }
        return current ? [codexInstanceId] : [];
      }),
    subscribeChanges: PubSub.subscribe(changes),
    streamChanges: Stream.fromPubSub(changes),
  };
  const proxy = yield* ProjectMcpProxyRegistry.__testing.make({
    endpointBase: "http://127.0.0.1:43123/mcp",
  });
  yield* Effect.addFinalizer(() => proxy.revokeAll);
  const credentials = yield* McpSessionRegistry.__testing.make().pipe(
    Effect.provideService(HttpServer.HttpServer, {
      address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
      serve: () => Effect.void,
    }),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("lifecycle-test")),
      getDescriptor: Effect.die("unused"),
    }),
    Effect.provideService(ProjectMcpProxyRegistry.ProjectMcpProxyRegistry, proxy),
  );
  yield* Effect.addFinalizer(() => credentials.revokeAll);
  const leases: Array<{ active: boolean }> = [];
  const issued: McpSessionRegistry.McpIssuedCredential[] = [];
  let revokeFailures = 0;
  let revokeAttempts = 0;
  const providerLayer = makeTestProviderServiceLive(
    {
      issueMcpCredential: (request) =>
        credentials.revokeThread(request.threadId).pipe(
          Effect.andThen(credentials.issue(request)),
          Effect.tap((credential) =>
            Effect.sync(() => {
              issued.push(credential);
            }),
          ),
        ),
      revokeMcpCredential: (threadId) =>
        Effect.suspend(() => {
          revokeAttempts += 1;
          if (revokeFailures > 0) {
            revokeFailures -= 1;
            return Effect.die("injected proxy revocation failure");
          }
          return credentials.revokeThread(threadId);
        }),
      canonicalEventLogger: {
        filePath: "memory://mcp-lifecycle",
        write: (event) => Queue.offer(forwarded, event as ProviderRuntimeEvent).pipe(Effect.asVoid),
        close: () => Effect.void,
      },
    },
    makeProviderProjectContextTestLayer(undefined, () =>
      Effect.gen(function* () {
        const lease = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const lease = { active: true };
            leases.push(lease);
            return lease;
          }),
          (lease) =>
            Effect.sync(() => {
              lease.active = false;
            }),
        );
        yield* leaseGate;
        return {
          servers: [routing.projectMcpServer],
          resolveSecret: () => (lease.active ? "leased-secret" : undefined),
          oauthStateLeases: new Map(),
        };
      }),
    ),
  ).pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(
      ProviderSessionDirectoryLive.pipe(
        Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
      ),
    ),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const providerScope = yield* Scope.make();
  const closeProvider = Scope.close(providerScope, Exit.void);
  yield* Effect.addFinalizer(() => closeProvider);
  const context = yield* Layer.build(providerLayer).pipe(Scope.provide(providerScope));
  const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(context));
  yield* original.subscribed;
  const changeInstance = Effect.fn("changeInstance")(function* (next: typeof current) {
    const done = yield* Deferred.make<void>();
    reconcileBarrier = { remaining: 2, done };
    current = next;
    yield* PubSub.publish(changes, undefined);
    yield* PubSub.publish(changes, undefined);
    yield* Deferred.await(done);
    if (next) yield* next.subscribed;
  });
  const exit = Effect.fn("emitExit")(function* (
    adapter: typeof original,
    threadId: ThreadId,
    sessionId?: string,
  ) {
    adapter.emit({
      type: "session.exited",
      eventId: asEventId("lifecycle-exit"),
      provider: CODEX_DRIVER,
      threadId,
      createdAt: "2026-09-07T00:00:00.000Z",
      payload: {},
      ...(sessionId ? { raw: { source: "notification", payload: { sessionId } } } : {}),
    });
    return yield* Queue.take(forwarded);
  });
  const credentialAlive = Effect.fn("credentialAlive")(function* (index: number) {
    const config = issued[index]?.config;
    assert.isDefined(config);
    const endpoint = config!.projectServers?.[0]?.endpoint;
    assert.isDefined(endpoint);
    const handle = endpoint!.pathname.split("/").at(-1)!;
    return {
      credential:
        (yield* credentials.resolve(config!.authorizationHeader.replace(/^Bearer\s+/, ""))) !==
        undefined,
      proxy: (yield* proxy.resolve(config!.providerSessionId, handle)) !== undefined,
      lease: leases[index]?.active,
    };
  });
  return {
    provider,
    original,
    changeInstance,
    exit,
    credentialAlive,
    closeProvider,
    leases,
    get issuedCount() {
      return issued.length;
    },
    failRevokes: (count: number) => {
      revokeFailures = count;
    },
    get revokeAttempts() {
      return revokeAttempts;
    },
  };
});

it.effect.each(["removed", "replaced"])(
  "rejects a start whose instance is %s during lease acquisition",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* makeMcpLifecycleHarness(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const threadId = asThreadId(`lease-race-${mode}`);
      const starting = yield* h.provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* h.changeInstance(mode === "replaced" ? makeFakeCodexAdapter() : undefined);
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
      assert.equal(h.issuedCount, 0);
      assert.deepEqual(h.leases, [{ active: false }]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["removed", "replaced"])(
  "cleans MCP resources when a provider instance is %s",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* makeMcpLifecycleHarness();
      const threadId = asThreadId(`instance-${mode}`);
      const input = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access" as const,
      };
      yield* h.provider.startSession(threadId, input);
      assert.deepEqual(yield* h.credentialAlive(0), { credential: true, proxy: true, lease: true });
      const replacement = mode === "replaced" ? makeFakeCodexAdapter() : undefined;
      yield* h.changeInstance(replacement);
      assert.deepEqual(yield* h.credentialAlive(0), {
        credential: false,
        proxy: false,
        lease: false,
      });
      if (replacement) {
        yield* h.provider.startSession(threadId, input);
        yield* h.exit(h.original, threadId);
        assert.deepEqual(yield* h.credentialAlive(1), {
          credential: true,
          proxy: true,
          lease: true,
        });
        yield* replacement.stopSession(threadId);
        yield* h.exit(replacement, threadId);
        assert.deepEqual(yield* h.credentialAlive(1), {
          credential: false,
          proxy: false,
          lease: false,
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retries transient exit cleanup before forwarding and keeps repeated failures retryable",
  () =>
    Effect.gen(function* () {
      const h = yield* makeMcpLifecycleHarness();
      const threadId = asThreadId("exit-cleanup-failure");
      const input = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access" as const,
      };
      yield* h.provider.startSession(threadId, input);
      yield* h.original.stopSession(threadId);
      h.failRevokes(1);
      yield* h.exit(h.original, threadId);
      assert.equal(h.revokeAttempts, 2);
      assert.deepEqual(yield* h.credentialAlive(0), {
        credential: false,
        proxy: false,
        lease: false,
      });
      yield* h.provider.startSession(threadId, input);
      yield* h.original.stopSession(threadId);
      h.failRevokes(2);
      yield* h.exit(h.original, threadId);
      assert.deepEqual(yield* h.credentialAlive(1), { credential: true, proxy: true, lease: true });
      yield* h.exit(h.original, threadId);
      assert.deepEqual(yield* h.credentialAlive(1), {
        credential: false,
        proxy: false,
        lease: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 3000 },
);

it.effect(
  "keeps instance cleanup subscribed after repeated revocation failures",
  () =>
    Effect.gen(function* () {
      const h = yield* makeMcpLifecycleHarness();
      const threadId = asThreadId("instance-cleanup-failure");
      yield* h.provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      h.failRevokes(2);
      yield* h.changeInstance(undefined);
      yield* h.changeInstance(undefined);
      assert.deepEqual(yield* h.credentialAlive(0), {
        credential: false,
        proxy: false,
        lease: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 3000 },
);

it.effect.each(["start", "stop", "stopAll"])(
  "revokes real MCP endpoints after a failed adapter %s",
  (operation) =>
    Effect.gen(function* () {
      const h = yield* makeMcpLifecycleHarness();
      const threadId = asThreadId(`failed-${operation}`);
      const input = {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access" as const,
      };
      const failure = new ProviderAdapterRequestError({
        provider: CODEX_DRIVER,
        method: operation,
        detail: "injected lifecycle failure",
      });
      if (operation !== "start") yield* h.provider.startSession(threadId, input);
      const method =
        operation === "start" ? "startSession" : operation === "stop" ? "stopSession" : "stopAll";
      const spy = vi
        .spyOn(h.original.adapter, method)
        .mockImplementationOnce(() => Effect.fail(failure));
      const result = yield* (
        operation === "start"
          ? h.provider.startSession(threadId, input)
          : operation === "stop"
            ? h.provider.stopSession({ threadId })
            : h.closeProvider
      ).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      assert.equal(Exit.isFailure(result), operation !== "stopAll");
      assert.deepEqual(yield* h.credentialAlive(0), {
        credential: false,
        proxy: false,
        lease: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("matches native exits and preserves a newer native session on the same adapter", () =>
  Effect.gen(function* () {
    const h = yield* makeMcpLifecycleHarness();
    const threadId = asThreadId("native-exit");
    const input = {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access" as const,
    };
    yield* h.provider.startSession(threadId, { ...input, resumeCursor: { sessionId: "first" } });
    yield* h.provider.startSession(threadId, { ...input, resumeCursor: { sessionId: "second" } });
    yield* h.exit(h.original, threadId, "first");
    assert.deepEqual(yield* h.credentialAlive(1), { credential: true, proxy: true, lease: true });
    yield* h.exit(h.original, threadId);
    assert.deepEqual(yield* h.credentialAlive(1), { credential: true, proxy: true, lease: true });
    yield* h.exit(h.original, threadId, "second");
    assert.deepEqual(yield* h.credentialAlive(1), {
      credential: false,
      proxy: false,
      lease: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive uploads feedback through the adapter that recovered the session",
  () =>
    Effect.gen(function* () {
      const original = makeFakeCodexAdapter();
      const replacement = makeFakeCodexAdapter();
      const baseRegistry = makeAdapterRegistryMock({ [CODEX_DRIVER]: original.adapter });
      let swapAfterFirstLookup = false;
      let feedbackLookupCount = 0;
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        ...baseRegistry,
        getByInstance: (instanceId) => {
          if (instanceId !== codexInstanceId) {
            return baseRegistry.getByInstance(instanceId);
          }
          const useReplacement = swapAfterFirstLookup && feedbackLookupCount++ > 0;
          return Effect.succeed(useReplacement ? replacement.adapter : original.adapter);
        },
      };
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-feedback-adapter-replacement");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        yield* original.stopSession(threadId);
        original.uploadFeedback.mockClear();
        replacement.uploadFeedback.mockClear();
        swapAfterFirstLookup = true;

        const result = yield* provider.uploadFeedback({ threadId });

        assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
        assert.strictEqual(original.uploadFeedback.mock.calls.length, 0);
        assert.deepStrictEqual(replacement.uploadFeedback.mock.calls, [[{ threadId }]]);
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeTestProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeTestProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("releases the MCP lease when an adapter stop fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-mcp-failed-stop");
      const releasedBefore = routing.releasedSessionLeases;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const stop = vi.spyOn(routing.codex.adapter, "stopSession").mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: CODEX_DRIVER,
            method: "stopSession",
            detail: "injected stop failure",
          }),
        ),
      );
      const stopped = yield* provider
        .stopSession({ threadId })
        .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => stop.mockRestore())));
      assert.isTrue(Exit.isFailure(stopped));
      assert.equal(routing.releasedSessionLeases, releasedBefore + 1);
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      yield* routing.codex.stopSession(threadId);
    }),
  );

  it.effect("cleans an exit received while the adapter is still starting", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-mcp-exit-during-start");
      const releasedBefore = routing.releasedSessionLeases;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const originalStart = routing.codex.adapter.startSession;
      const start = vi
        .spyOn(routing.codex.adapter, "startSession")
        .mockImplementationOnce((input) =>
          originalStart(input).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(finish)),
          ),
        );
      yield* routing.codex.subscribed;
      const events = yield* Stream.toPull(provider.streamEvents);
      const forwarded = yield* events.pipe(Effect.forkChild({ startImmediately: true }));
      const starting = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* routing.codex.stopSession(threadId);
      routing.codex.emit({
        type: "session.exited",
        eventId: asEventId("during-start"),
        provider: CODEX_DRIVER,
        threadId,
        createdAt: "2026-09-07T00:00:00.000Z",
        payload: {},
      });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(starting).pipe(Effect.ensuring(Effect.sync(() => start.mockRestore())));
      yield* Fiber.join(forwarded);
      assert.equal(routing.releasedSessionLeases, releasedBefore + 1);
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    }).pipe(Effect.scoped),
  );

  it.effect.each(["old adapter", "old native session", "missing native ID with live replacement"])(
    "keeps replacement MCP credentials after an exit from %s",
    (scenario) =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId(`thread-mcp-${scenario}`);
        const releasedBefore = routing.releasedSessionLeases;
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          resumeCursor: { sessionId: "replacement-native" },
          runtimeMode: "full-access",
        });
        const source = scenario === "old adapter" ? routing.claude : routing.codex;
        yield* source.subscribed;
        if (scenario !== "missing native ID with live replacement") {
          yield* routing.codex.stopSession(threadId);
        }
        const events = yield* Stream.toPull(provider.streamEvents);
        const forwarded = yield* events.pipe(Effect.forkChild({ startImmediately: true }));
        source.emit({
          type: "session.exited",
          eventId: asEventId(`exit-${scenario}`),
          provider: source.adapter.provider,
          threadId,
          createdAt: "2026-09-07T00:00:00.000Z",
          payload: {},
          ...(scenario === "old native session"
            ? { raw: { source: "notification", payload: { sessionId: "old-native" } } }
            : {}),
        });
        yield* Fiber.join(forwarded);
        assert.equal(routing.releasedSessionLeases, releasedBefore);
        assert.isDefined(McpProviderSession.readMcpProviderSession(threadId));
        yield* provider.stopSession({ threadId });
      }).pipe(Effect.scoped),
  );

  it.effect("releases MCP credentials before forwarding an unexpected session exit", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-mcp-unexpected-exit");
      const releasedBefore = routing.releasedSessionLeases;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const events = yield* Stream.toPull(provider.streamEvents);
      const forwarded = yield* events.pipe(Effect.forkChild({ startImmediately: true }));
      yield* routing.codex.subscribed;
      yield* routing.codex.stopSession(threadId);
      routing.codex.emit({
        type: "session.exited",
        eventId: asEventId("unexpected-exit"),
        provider: CODEX_DRIVER,
        threadId,
        createdAt: "2026-09-07T00:00:00.000Z",
        payload: {},
      });
      yield* Fiber.join(forwarded);
      assert.equal(routing.releasedSessionLeases, releasedBefore + 1);
      assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("resolves project MCP servers for normal starts and internal recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-project-mcp");
      routing.acquireProjectMcpLease.mockClear();
      routing.codex.startSession.mockClear();

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-mcp",
        runtimeMode: "full-access",
      });

      assert.deepEqual(routing.acquireProjectMcpLease.mock.calls, [
        [defaultProjectId, codexInstanceId],
      ]);
      assert.deepEqual(
        (routing.codex.startSession.mock.calls[0]?.[0] as { projectMcpServers?: unknown })
          ?.projectMcpServers,
        [routing.issuedProjectMcpServer],
      );

      yield* routing.codex.stopSession(threadId);
      routing.codex.startSession.mockClear();
      yield* provider.sendTurn({ threadId, input: "recover", attachments: [] });

      assert.deepEqual(routing.acquireProjectMcpLease.mock.calls, [
        [defaultProjectId, codexInstanceId],
        [defaultProjectId, codexInstanceId],
      ]);
      assert.deepEqual(
        (routing.codex.startSession.mock.calls[0]?.[0] as { projectMcpServers?: unknown })
          ?.projectMcpServers,
        [routing.issuedProjectMcpServer],
      );
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("owns the project MCP lease for the provider session lifetime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-project-mcp-lease");
      const releasedBefore = routing.releasedSessionLeases;
      routing.acquireProjectMcpLease.mockClear();

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      assert.equal(routing.acquireProjectMcpLease.mock.calls.length, 1);
      assert.equal(routing.releasedSessionLeases, releasedBefore);

      yield* provider.stopSession({ threadId });
      assert.equal(routing.releasedSessionLeases, releasedBefore + 1);
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes feedback to the Codex adapter and returns its feedback ID", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-route");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.uploadFeedback.mockClear();

      const result = yield* provider.uploadFeedback({
        threadId,
        reason: "The agent stopped early.",
      });

      assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
      assert.deepStrictEqual(routing.codex.uploadFeedback.mock.calls, [
        [{ threadId, reason: "The agent stopped early." }],
      ]);
    }),
  );

  it.effect("recovers a stopped Codex session before uploading feedback", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-recover");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/feedback-project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(threadId);
      routing.codex.startSession.mockClear();
      routing.codex.uploadFeedback.mockClear();

      const result = yield* provider.uploadFeedback({ threadId });

      assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
      assert.strictEqual(routing.codex.startSession.mock.calls.length, 1);
      assert.deepStrictEqual(routing.codex.uploadFeedback.mock.calls, [[{ threadId }]]);
    }),
  );

  it.effect("rejects feedback for providers that do not support uploads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-claude");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* provider.uploadFeedback({ threadId }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.include(error.issue, "does not support feedback uploads");
      routing.claude.startSession.mockClear();
    }),
  );

  it.effect("does not restart an unsupported provider before rejecting feedback", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-unsupported-stopped");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* routing.claude.stopSession(threadId);
      routing.claude.startSession.mockClear();

      const error = yield* provider.uploadFeedback({ threadId }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.include(error.issue, "does not support feedback uploads");
      assert.strictEqual(routing.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("appends attachment file paths to the turn input text", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-attach"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-attach"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const attachment = {
        type: "image" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 123,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "use this screenshot",
        attachments: [attachment],
      });

      const turnInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(typeof turnInput.input, "string");
      const turnText = turnInput.input ?? "";
      assert.equal(turnText.startsWith("use this screenshot"), true);
      assert.include(turnText, '[Attached image "screenshot.png" is saved at: ');
      assert.equal(turnText.endsWith(`${attachment.id}.png]`), true);

      // An attachment-only turn stays valid and the injected line becomes the
      // whole input text, so the agent still learns the path.
      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        attachments: [attachment],
      });
      const imageOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(imageOnlyInput.input?.startsWith('[Attached image "screenshot.png"'), true);

      const fileAttachment = {
        type: "file" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc-pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 456,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "summarize the report",
        attachments: [attachment, fileAttachment],
      });
      const mixedInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.include(mixedInput.input ?? "", '[Attached file "report.pdf" is saved at: ');
      assert.include(mixedInput.input ?? "", `${fileAttachment.id}.pdf]`);
      // Every attachment reaches the adapter; each adapter decides what its
      // provider ingests natively.
      assert.deepEqual(mixedInput.attachments, [attachment, fileAttachment]);

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({ threadId: session.threadId, attachments: [fileAttachment] });
      const fileOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.include(fileOnlyInput.input ?? "", '[Attached file "report.pdf" is saved at: ');
      assert.deepEqual(fileOnlyInput.attachments, [fileAttachment]);

      yield* provider.stopSession({ threadId: session.threadId });
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("does not persist running after a concurrent send is interrupted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sendStarted = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockImplementationOnce(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(sendStarted, undefined);
          yield* Deferred.await(interrupted);
          return yield* Effect.interrupt;
        }),
      );
      routing.codex.interruptTurn.mockImplementationOnce(() =>
        Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
      );

      const threadId = asThreadId("thread-interrupted-send-directory");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const sendExitFiber = yield* provider
        .sendTurn({
          threadId: session.threadId,
          input: "hold this prompt",
          attachments: [],
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(sendStarted);
      yield* provider.interruptTurn({ threadId: session.threadId });
      const sendExit = yield* Fiber.join(sendExitFiber);

      assert.equal(Exit.isFailure(sendExit), true);
      if (Exit.isFailure(sendExit)) {
        assert.equal(Cause.hasInterruptsOnly(sendExit.cause), true);
      }
      const persisted = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        // The directory folds both adapter "ready" and "running" into its
        // runtime "running" state. The payload proves sendTurn did not upsert.
        assert.equal(persisted.value.status, "running");
        const payload = persisted.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId?: string | null;
            lastRuntimeEvent?: string | null;
          };
          assert.equal(runtimePayload.activeTurnId ?? null, null);
          assert.notEqual(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeTestProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeTestProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeTestProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

describe("agent browser access", () => {
  const revokedThreads: Array<ThreadId> = [];

  const projectMcpServer = {
    id: McpServerId.make("project-mcp-server"),
    name: "Project MCP",
    transport: {
      type: "streamable-http",
      url: "https://project-mcp.example.test/mcp",
      headers: [],
      authorization: { type: "none" },
    },
  } satisfies ResolvedProjectMcpServer;

  const startSessionWith = (enableAgentBrowserAccess: boolean, threadId: ThreadId) =>
    Effect.gen(function* () {
      const issued: Array<ThreadId> = [];
      const codex = makeFakeCodexAdapter();
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter }),
      );
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeTestProviderServiceLive({
        issueMcpCredential: (request) =>
          Effect.sync(() => {
            issued.push(request.threadId);
            return undefined;
          }),
        revokeMcpCredential: (revoked) => Effect.sync(() => void revokedThreads.push(revoked)),
      }).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess })),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      return issued;
    });

  // Credential issuance is the observable that matters: it is the only place a
  // credential is minted, and `/mcp` accepts nothing else, so withholding it is
  // what actually denies every provider and external MCP client.
  it.effect("requests no MCP credential when agent browser access is off", () =>
    Effect.gen(function* () {
      const issued = yield* startSessionWith(false, asThreadId("thread-browser-off"));

      assert.deepEqual(issued, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("revokes an already-issued credential when access is off", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-revoke");
      revokedThreads.length = 0;

      yield* startSessionWith(false, threadId);

      // Clearing the in-memory map is not enough: a token issued before the
      // toggle flipped stays valid against `/mcp` for its whole liveness
      // window, and later turns refresh it.
      assert.deepEqual([...new Set(revokedThreads)], [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requests an MCP credential when agent browser access is on", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-on");

      const issued = yield* startSessionWith(true, threadId);

      assert.deepEqual(issued, [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps project MCP when browser preview access is off", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-project-mcp-browser-off");
      const requests: Array<{
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly includePreview?: boolean;
        readonly projectMcpServers?: ReadonlyArray<ResolvedProjectMcpServer>;
      }> = [];
      const codex = makeFakeCodexAdapter();
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter }),
      );
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeTestProviderServiceLive(
        {
          issueMcpCredential: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return {
                config: {
                  environmentId: EnvironmentId.make("provider-service-environment"),
                  threadId: request.threadId,
                  providerSessionId: "project-only-provider-session",
                  providerInstanceId: request.providerInstanceId,
                  endpoint: "http://127.0.0.1:43123/mcp",
                  authorizationHeader: "Bearer preview-token",
                  projectServers: [
                    {
                      id: projectMcpServer.id,
                      name: projectMcpServer.name,
                      endpoint: new URL("http://127.0.0.1:43123/mcp/project/project-only"),
                      authorizationHeader: "Bearer project-token",
                    },
                  ],
                },
              };
            }),
        },
        makeProviderProjectContextTestLayer(
          () => Effect.succeed([]),
          () =>
            Effect.succeed({
              servers: [projectMcpServer],
              resolveSecret: () => undefined,
              oauthStateLeases: new Map(),
            }),
        ),
      ).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(
          ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess: false }),
        ),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });

        assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
      }).pipe(Effect.provide(providerLayer));

      assert.equal(requests.length, 1);
      const request = requests[0]!;
      assert.equal(request.threadId, threadId);
      assert.equal(request.providerInstanceId, codexInstanceId);
      assert.equal(request.includePreview, false);
      assert.deepEqual(request.projectMcpServers, [projectMcpServer]);
      assert.deepEqual(
        (codex.startSession.mock.calls[0]?.[0] as { projectMcpServers?: unknown })
          ?.projectMcpServers,
        [
          {
            id: projectMcpServer.id,
            name: projectMcpServer.name,
            endpoint: new URL("http://127.0.0.1:43123/mcp/project/project-only"),
            authorizationHeader: "Bearer project-token",
          },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
