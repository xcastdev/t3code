// @effect-diagnostics nodeBuiltinImport:off -- Only caller-owned temporary fixture paths are used.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ScheduledTaskUpsertInput,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ProviderRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const preservationIds = {
  project: ProjectId.make("preservation-project"),
  thread: ThreadId.make("preservation-thread"),
  fork: ThreadId.make("preservation-fork"),
  run: RunId.make("preservation-run"),
  node: NodeId.make("preservation-node"),
  session: ProviderSessionId.make("preservation-session"),
  providerThread: ProviderThreadId.make("preservation-provider-thread"),
  scope: CheckpointScopeId.make("preservation-scope"),
  checkpoint: CheckpointId.make("preservation-checkpoint"),
  command: CommandId.make("preservation-conversation"),
  auth: AuthSessionId.make("preservation-auth"),
};
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const iso = DateTime.formatIso(at);
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const decodeScheduledTask = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

/** Read production schedules without admitting their registered work in this seed/read composition. */
export const preservationScheduleLayer = ScheduledTasks.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(Scheduler.Scheduler, Scheduler.Scheduler.of({ register: () => Effect.void })),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ManagedFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/fixture-only",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

export const preservationRepositoryLayer = Layer.mergeAll(
  ProviderRuntime.layer,
  AuthSessions.layer,
  Receipts.layer,
  Outbox.layer,
  preservationScheduleLayer,
);

export const preservationSeedLayer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer)),
  Layer.provideMerge(preservationRepositoryLayer),
);

/** Settings are synthetic and contain no credentials; no secret store is opened. */
export function preservationSettingsLayer(root: string) {
  const config = ServerConfig.layerTest(root, root);
  return ServerSettings.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(config),
  );
}

export const writePreservationSettings = Effect.fn("upgradeFixture.writeSettings")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  NodeFS.mkdirSync(NodePath.dirname(config.settingsPath), { recursive: true });
  NodeFS.writeFileSync(
    config.settingsPath,
    encodeFixtureJson({
      responseStreamingMode: "turn",
      continueThreadsAfterServerUpdate: false,
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    }),
  );
});

export const seedUpgradePreservation = Effect.fn("upgradeFixture.seedPreservation")(function* (
  workspaceRoot: string,
) {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("preservation-project-create"),
    projectId: preservationIds.project,
    commandType: "project.create",
    acceptedAt: at,
    event: {
      eventId: EventId.make("preservation-project-created"),
      aggregateKind: "project",
      aggregateId: preservationIds.project,
      occurredAt: iso,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: preservationIds.project,
        title: "Saved workspace",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: iso,
        updatedAt: iso,
      },
    },
  });
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: preservationIds.thread,
    projectId: preservationIds.project,
    title: "Saved conversation",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: "preservation",
    worktreePath: null,
    activeProviderThreadId: preservationIds.providerThread,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: preservationIds.thread,
    },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run = {
    id: preservationIds.run,
    threadId: preservationIds.thread,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: preservationIds.providerThread,
    userMessageId: MessageId.make("preservation-user"),
    rootNodeId: preservationIds.node,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: preservationIds.checkpoint,
    contextHandoffId: null,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const add = (event: OrchestrationV2DomainEvent) => events.push(event);
  const base = { threadId: preservationIds.thread, occurredAt: at };
  add({
    ...base,
    id: EventId.make("preservation-thread-created"),
    type: "thread.created",
    payload: thread,
  });
  add({ ...base, id: EventId.make("preservation-run-created"), type: "run.created", payload: run });
  for (const [ordinal, role, text] of [
    [1, "user", "Keep the saved request"],
    [2, "assistant", "Keep the saved answer"],
  ] as const) {
    const messageId = MessageId.make(`preservation-${role}`);
    add({
      ...base,
      id: EventId.make(`preservation-message-${role}`),
      type: "message.updated",
      payload: {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        id: messageId,
        threadId: preservationIds.thread,
        runId: preservationIds.run,
        nodeId: preservationIds.node,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    add({
      ...base,
      id: EventId.make(`preservation-item-${role}`),
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`preservation-item-${role}`),
        threadId: preservationIds.thread,
        runId: preservationIds.run,
        nodeId: preservationIds.node,
        providerThreadId: preservationIds.providerThread,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: role,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        ...(role === "user"
          ? {
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              messageId,
              inputIntent: "turn_start",
              text,
              attachments: [],
            }
          : { type: "assistant_message", messageId, text, streaming: false }),
      },
    });
  }
  add({
    ...base,
    id: EventId.make("preservation-session-attached"),
    type: "provider-session.attached",
    payload: {
      id: preservationIds.session,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: workspaceRoot,
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: at,
      updatedAt: at,
      lastError: null,
    },
  });
  add({
    ...base,
    id: EventId.make("preservation-provider-thread-updated"),
    type: "provider-thread.updated",
    payload: {
      id: preservationIds.providerThread,
      driver,
      providerInstanceId: instanceId,
      providerSessionId: preservationIds.session,
      appThreadId: preservationIds.thread,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-conversation", strength: "strong" },
      nativeConversationHeadRef: { driver, nativeId: "native-head", strength: "strong" },
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
    },
  });
  add({
    ...base,
    id: EventId.make("preservation-scope-created"),
    type: "checkpoint-scope.created",
    payload: {
      id: preservationIds.scope,
      threadId: preservationIds.thread,
      runId: preservationIds.run,
      nodeId: preservationIds.node,
      parentScopeId: null,
      providerThreadId: preservationIds.providerThread,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: workspaceRoot,
      createdAt: at,
    },
  });
  add({
    ...base,
    id: EventId.make("preservation-checkpoint-captured"),
    type: "checkpoint.captured",
    payload: {
      id: preservationIds.checkpoint,
      threadId: preservationIds.thread,
      scopeId: preservationIds.scope,
      runId: preservationIds.run,
      nodeId: preservationIds.node,
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      ref: CheckpointRef.make("refs/t3/preservation/1"),
      status: "ready",
      files: [],
      capturedAt: at,
    },
  });
  add({
    ...base,
    id: EventId.make("preservation-pr-linked"),
    type: "thread.pull-request-synced",
    payload: {
      ...thread,
      pullRequests: [
        {
          host: "github.com",
          repository: "fixture/repository",
          number: 42,
          url: "https://github.com/fixture/repository/pull/42",
          source: "manual",
          linkedAt: iso,
          snapshot: null,
          stack: null,
        },
      ],
    },
  });
  yield* sink.commitCommand({
    commandId: preservationIds.command,
    threadId: preservationIds.thread,
    commandType: "fixture.conversation",
    acceptedAt: at,
    events,
    effects: [
      {
        id: "preservation-running",
        commandId: preservationIds.command,
        threadId: preservationIds.thread,
        request: { type: "provider-runtime.continue", sourceRunId: preservationIds.run },
      },
      {
        id: "preservation-pending",
        commandId: preservationIds.command,
        threadId: preservationIds.thread,
        request: { type: "provider-turn.start", runId: preservationIds.run },
      },
    ],
  });
  const outbox = yield* Outbox.EffectOutboxV2;
  yield* outbox.claimNext({ workerId: "previous-fixture-worker", leaseDurationMs: 60_000 });
  yield* sink.commitCommand({
    commandId: CommandId.make("preservation-fork-create"),
    threadId: preservationIds.fork,
    commandType: "thread.fork",
    acceptedAt: at,
    effects: [],
    events: [
      {
        id: EventId.make("preservation-fork-created"),
        type: "thread.created",
        threadId: preservationIds.fork,
        occurredAt: at,
        payload: {
          ...thread,
          id: preservationIds.fork,
          title: "Saved fork",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: preservationIds.thread,
            relationshipToParent: "fork",
            rootThreadId: preservationIds.thread,
          },
          forkedFrom: { type: "run", threadId: preservationIds.thread, runId: preservationIds.run },
        },
      },
    ],
  });
  yield* (yield* ProviderRuntime.ProviderSessionRuntimeRepository).upsert({
    threadId: preservationIds.thread,
    providerName: "codex",
    providerInstanceId: instanceId,
    adapterKey: "codex",
    runtimeMode: "full-access",
    status: "stopped",
    lastSeenAt: iso,
    resumeCursor: { threadId: "native-conversation", lastNativeTurnId: "native-turn" },
    runtimePayload: { nativeThreadId: "native-conversation", cwd: workspaceRoot },
  });
  yield* (yield* AuthSessions.AuthSessionRepository).create({
    sessionId: preservationIds.auth,
    subject: "fixture-client",
    scopes: ["orchestration:read", "orchestration:operate"],
    method: "browser-session-cookie",
    issuedAt: at,
    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
    client: {
      label: "Fixture remote client",
      ipAddress: "127.0.0.1",
      userAgent: "fixture",
      deviceType: "desktop",
      os: "fixture-os",
      browser: null,
    },
  });
  const schedule = yield* decodeScheduledTask({
    id: "preservation-schedule",
    title: "Saved review",
    prompt: "Review the saved conversation",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: preservationIds.project,
    threadId: preservationIds.thread,
    workspaceStrategy: { type: "root" },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  yield* (yield* ScheduledTasks.ScheduledTaskService).upsert(schedule);
});

/** These are the same decoders/readers used by clients and continuation recovery, not raw row hashes. */
export const readUpgradePreservation = Effect.fn("upgradeFixture.readPreservation")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const project = Option.getOrThrow(
    yield* (yield* ProjectStore.ProjectStoreV2).get(preservationIds.project),
  );
  return {
    project: {
      id: project.projectId,
      title: project.title,
      defaultModelSelection: project.defaultModelSelection,
    },
    conversation: yield* projections.getThreadProjection(preservationIds.thread),
    fork: yield* projections.getThread(preservationIds.fork),
    shell: yield* projections.getThreadShell(preservationIds.thread),
    pullRequests: yield* projections.getThreadsWithPullRequests(preservationIds.thread),
    history: yield* projections.getTimelinePage(preservationIds.thread, { limit: 20 }),
    runtime: Option.getOrThrow(
      yield* (yield* ProviderRuntime.ProviderSessionRuntimeRepository).getByThreadId({
        threadId: preservationIds.thread,
      }),
    ),
    effects: yield* (yield* Outbox.EffectOutboxV2).listByCommandId(preservationIds.command),
    receipt: Option.getOrThrow(
      yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(preservationIds.command),
    ),
    auth: Option.getOrThrow(
      yield* (yield* AuthSessions.AuthSessionRepository).getById({
        sessionId: preservationIds.auth,
      }),
    ),
    schedules: (yield* (yield* ScheduledTasks.ScheduledTaskService).list()).tasks,
    events: yield* Stream.runCollect(
      (yield* EventStore.EventStoreV2).read({ threadId: preservationIds.thread }),
    ),
  };
});

export const legacyPreservationThread = ThreadId.make("legacy-preservation-thread");

/** Historical V1 projections and their source events share these exact fixture payloads. */
export const seedLegacyPreservation = Effect.fn("upgradeFixture.seedLegacy")(function* (
  workspaceRoot: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const thread = {
    threadId: legacyPreservationThread,
    projectId: "legacy-preservation-project",
    title: "Legacy saved conversation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: iso,
    updatedAt: iso,
  };
  const append = Effect.fn("upgradeFixture.appendLegacyEvent")(function* (
    eventId: string,
    kind: string,
    stream: string,
    version: number,
    type: string,
    payload: unknown,
  ) {
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${eventId}, ${kind}, ${stream}, ${version}, ${type}, ${iso}, 'user', ${encodeFixtureJson(payload)}, '{}')`;
  });
  const project = {
    projectId: thread.projectId,
    title: "Legacy workspace",
    workspaceRoot,
    scripts: [],
    createdAt: iso,
    updatedAt: iso,
  };
  yield* append(
    "legacy-project-created",
    "project",
    project.projectId,
    1,
    "project.created",
    project,
  );
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project.projectId}, ${project.title}, ${workspaceRoot}, '[]', ${iso}, ${iso})`;
  yield* append(
    "legacy-thread-created",
    "thread",
    legacyPreservationThread,
    1,
    "thread.created",
    thread,
  );
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${legacyPreservationThread}, ${thread.projectId}, ${thread.title}, ${encodeFixtureJson(modelSelection)},
      ${thread.runtimeMode}, ${thread.interactionMode}, ${iso}, ${iso})`;
  for (let index = 0; index < 6; index++) {
    const message = {
      messageId: `legacy-preserved-message-${index}`,
      threadId: legacyPreservationThread,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Legacy saved text ${index}`,
      streaming: false,
      attachments: [],
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    };
    yield* append(
      `legacy-message-${index}`,
      "thread",
      legacyPreservationThread,
      index + 2,
      "thread.message-sent",
      message,
    );
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, attachments_json, created_at, updated_at)
      VALUES (${message.messageId}, ${message.threadId}, ${message.role}, ${message.text}, 0, '[]', ${message.createdAt}, ${message.updatedAt})`;
  }
});
