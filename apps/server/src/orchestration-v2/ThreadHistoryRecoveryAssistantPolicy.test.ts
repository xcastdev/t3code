import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderThreadId,
  RunId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as MemoryFixture from "../assistants/AssistantMemory.test-utils.ts";
import { AssistantRepository, AssistantError } from "../assistants/AssistantRepository.ts";
import { makeAssistantHistoryPolicy } from "../assistants/AssistantHistoryPolicy.ts";
import { makeAssistantMemoryContext } from "../assistants/AssistantMemory.ts";
import { assistantMemoryContextHash } from "../assistants/AssistantResources.ts";
import * as Handoffs from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  sourceTuple,
  type ProjectMemoryError,
} from "../projectWork/memory/ProjectMemoryRepository.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { threadHistoryArchiveMigration } from "../persistence/ThreadHistoryArchiveMigration.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import * as Recovery from "./ThreadHistoryRecoveryService.ts";
import * as Policy from "./ThreadHistoryRecoveryAssistantPolicy.ts";
import { ContextHandoffEpoch } from "./ContextHandoffEpoch.ts";
import { validateHistoryArchiveCommit } from "./ThreadHistoryArchiveCommitGuard.ts";
import * as Projection from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as Management from "./ThreadManagementService.ts";

const memory = MemoryFixture.fixture((input) =>
  Effect.succeed({
    facts: [
      {
        key: input.sourceText.includes("dark") ? "editor.theme" : "terminal.color",
        body: input.sourceText,
        quote: input.sourceText,
      },
    ],
  }),
);
const schema = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const statement of threadHistoryArchiveMigration.statements) yield* sql.unsafe(statement);
  }),
).pipe(Layer.provideMerge(memory));
const epoch = Layer.effect(
  ContextHandoffEpoch,
  Effect.gen(function* () {
    const capture = yield* makeAssistantHistoryPolicy;
    const context = yield* makeAssistantMemoryContext;
    const repository = yield* AssistantRepository;
    return ContextHandoffEpoch.of({
      capture,
      current: Effect.fn("test.archive.currentEpoch")(
        function* (threadId) {
          const record = yield* repository.findByThread(threadId);
          if (record === null) return undefined;
          const current = yield* context(record);
          return {
            memoryEpoch: current.memoryEpoch,
            memoryContextHash: assistantMemoryContextHash(current.text),
          };
        },
        Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
      ),
    });
  }),
);
const base = Layer.mergeAll(Archive.layer, Projects.layer, Policy.layer).pipe(
  Layer.provideMerge(epoch),
  Layer.provideMerge(Projection.layer),
  Layer.provideMerge(schema),
  Layer.provideMerge(Layer.mock(CheckpointStore.CheckpointStore)({})),
  Layer.provideMerge(NodeServices.layer),
);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationV2AppThreadJson);
const decodeRun = Schema.decodeUnknownEffect(OrchestrationV2RunJson);
const decodeItem = Schema.decodeUnknownEffect(OrchestrationV2TurnItemJson);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const setup = Effect.fn("test.assistantArchive.setup")(function* () {
  const seeded = yield* MemoryFixture.seed();
  const repository = yield* AssistantRepository;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projection.ProjectionStoreV2;
  const binding = seeded.record.detail.summary.binding;
  const record = yield* repository.setProvisioning(
    seeded.record.detail.summary,
    { state: "ready", binding },
    "/owned-assistant",
  );
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const home = yield* decodeThread({
    id: binding.canonicalThreadId,
    projectId: binding.backingProjectId,
    title: "Assistant home",
    createdBy: "system",
    creationSource: "server",
    providerInstanceId: seeded.evidence.modelSelection.instanceId,
    modelSelection: seeded.evidence.modelSelection,
    runtimeMode: record.detail.configuration.configuration.runtimeMode,
    interactionMode: record.detail.configuration.configuration.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: binding.canonicalThreadId,
    },
    forkedFrom: null,
    createdAt: DateTime.formatIso(at),
    updatedAt: DateTime.formatIso(at),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
  });
  const apply = Effect.fn("test.assistantArchive.apply")((event: OrchestrationV2DomainEvent) =>
    projections.apply(event),
  );
  yield* apply({
    id: EventId.make("owned-home-created"),
    type: "thread.created",
    threadId: home.id,
    occurredAt: at,
    payload: home,
  });
  const first = yield* seeded.memory.capture(seeded.evidence);
  yield* seeded.memory.process(first.operationKey);
  const retainedEvidence = {
    ...seeded.evidence,
    messageId: MessageId.make("remembered-message"),
    runId: RunId.make("remembered-run"),
    content: "I prefer the green terminal.",
  };
  const retained = yield* seeded.memory.capture(retainedEvidence);
  yield* seeded.memory.process(retained.operationKey);
  const current = yield* seeded.memory.context(record);
  let ordinal = 0;
  for (const evidence of [seeded.evidence, retainedEvidence]) {
    const run = yield* decodeRun({
      id: evidence.runId,
      threadId: home.id,
      ordinal: ++ordinal,
      providerInstanceId: evidence.modelSelection.instanceId,
      modelSelection: evidence.modelSelection,
      providerThreadId: null,
      userMessageId: evidence.messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      queuePosition: null,
      requestedAt: DateTime.formatIso(at),
      startedAt: DateTime.formatIso(at),
      completedAt: DateTime.formatIso(at),
      checkpointId: null,
      contextHandoffId: null,
    });
    yield* apply({
      id: EventId.make(`created-${run.id}`),
      type: "run.created",
      threadId: home.id,
      runId: run.id,
      occurredAt: at,
      payload: run,
    });
    yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions(thread_id,run_id,assistant_id,configuration_revision,configuration_json,created_at) VALUES(${home.id},${run.id},${binding.assistantId},${record.detail.configuration.revision},${encode({ snapshot: { memoryEpoch: current.memoryEpoch, memoryContextHash: assistantMemoryContextHash(current.text) } })},${DateTime.formatIso(at)})`;
    for (const [type, text] of [
      ["user_message", evidence.content],
      ["assistant_message", `Old assistant echo: ${evidence.content}`],
    ] as const) {
      const item = yield* decodeItem({
        id: `item-${ordinal}-${type}`,
        threadId: home.id,
        runId: run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal * 2 + (type === "user_message" ? 0 : 1),
        status: "completed",
        title: null,
        startedAt: DateTime.formatIso(at),
        completedAt: DateTime.formatIso(at),
        updatedAt: DateTime.formatIso(at),
        type,
        messageId: evidence.messageId,
        text,
        ...(type === "user_message"
          ? { createdBy: "user", creationSource: "web", inputIntent: "turn_start", attachments: [] }
          : { streaming: false }),
      });
      yield* apply({
        id: EventId.make(`event-${item.id}`),
        type: "turn-item.updated",
        threadId: home.id,
        runId: run.id,
        occurredAt: at,
        payload: item,
      });
    }
  }
  const original = (yield* (yield* Projection.ProjectionStoreV2).getThreadRecords(home.id, [
    "runs",
  ])).runs[0]!;
  const unknownRun = {
    ...original,
    id: RunId.make("unknown-run"),
    ordinal: 3,
    userMessageId: MessageId.make("unknown-message"),
  };
  yield* apply({
    id: EventId.make("unknown-run-created"),
    type: "run.created",
    threadId: home.id,
    runId: unknownRun.id,
    occurredAt: at,
    payload: unknownRun,
  });
  yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions(thread_id,run_id,assistant_id,configuration_revision,configuration_json,created_at) VALUES(${home.id},${unknownRun.id},${binding.assistantId},${record.detail.configuration.revision},${encode({ snapshot: { memoryEpoch: current.memoryEpoch, memoryContextHash: assistantMemoryContextHash(current.text) } })},${DateTime.formatIso(at)})`;
  const unknown = yield* decodeItem({
    id: "unknown-raw-item",
    threadId: home.id,
    runId: unknownRun.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 99,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.formatIso(at),
    type: "user_message",
    messageId: "unknown-message",
    text: "Unknown raw archived evidence must stay out.".repeat(300),
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    attachments: [],
  });
  yield* apply({
    id: EventId.make("unknown-item-created"),
    type: "turn-item.updated",
    threadId: home.id,
    occurredAt: at,
    payload: unknown,
  });
  const unknownEcho = yield* decodeItem({
    ...unknown,
    updatedAt: DateTime.formatIso(at),
    id: "unknown-echo",
    type: "assistant_message",
    ordinal: 100,
    text: "Unknown raw archived echo must stay out.",
    streaming: false,
  });
  yield* apply({
    id: EventId.make("unknown-echo-created"),
    type: "turn-item.updated",
    threadId: home.id,
    runId: unknownRun.id,
    occurredAt: at,
    payload: unknownEcho,
  });
  const archives = yield* Archive.ThreadHistoryArchiveService;
  const archiveId = "assistant-context-source";
  yield* archives.prepare({ threadId: home.id, archiveId, reason: "rollback" });
  yield* seeded.memory.forget(
    sourceTuple(
      {
        environmentId: seeded.evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: record.ownerRevision,
      },
      first.source,
    ),
  );
  return { ...seeded, home, archiveId, at, retained, record, retainedEvidence };
});

const recoveryWithSqlDelivery = Effect.fn("test.assistantArchive.recovery")(function* (
  beforeCommit: Effect.Effect<void, ProjectMemoryError> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projection.ProjectionStoreV2;
  const epochs = yield* ContextHandoffEpoch;
  const repository = yield* AssistantRepository;
  const delivery = Layer.mock(Management.ThreadManagementService)({
    // Provider inference is the test boundary. The recovery seed still commits to real canonical projection rows behind the production SQL stamp guard.
    sendToThread: Effect.fn("test.assistantArchive.deliver")(
      function* (input) {
        yield* beforeCommit;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* validateHistoryArchiveCommit();
            const source = yield* projections.getThreadRecords(input.threadId, [
              "runs",
              "messages",
              "turnItems",
            ]);
            const originalRun = source.runs[0];
            if (originalRun === undefined) return yield* Effect.die("Fixture run is missing.");
            const now = yield* DateTime.now;
            const run = {
              ...originalRun,
              id: RunId.make(`recovery-run:${input.messageId}`),
              ordinal: Math.max(...source.runs.map((run) => run.ordinal)) + 1,
              userMessageId: input.messageId,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
            };
            yield* projections.apply({
              id: EventId.make(`run-${input.messageId}`),
              type: "run.created",
              threadId: input.threadId,
              runId: run.id,
              occurredAt: now,
              payload: run,
            });
            const stamp = yield* epochs.current(input.threadId);
            const owner = yield* repository.findByThread(input.threadId);
            if (!stamp || !owner) return yield* Effect.die("Canonical owner stamp is missing.");
            yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions(thread_id,run_id,assistant_id,configuration_revision,configuration_json,created_at) VALUES(${input.threadId},${run.id},${owner.detail.summary.assistantId},${owner.detail.configuration.revision},${encode({ snapshot: stamp })},${DateTime.formatIso(now)})`;
            const message: OrchestrationV2ConversationMessage = {
              id: input.messageId,
              threadId: input.threadId,
              runId: run.id,
              nodeId: null,
              role: "user",
              text: input.text,
              attachments: [],
              streaming: false,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
              createdAt: now,
              updatedAt: now,
            };
            yield* projections.apply({
              id: EventId.make(`delivered-${input.messageId}`),
              type: "message.updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: message,
            });
            const turnItem = yield* decodeItem({
              id: `seed-${input.messageId}`,
              threadId: input.threadId,
              runId: run.id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: Math.max(...source.turnItems.map((item) => item.ordinal)) + 1,
              status: "completed",
              title: null,
              startedAt: DateTime.formatIso(now),
              completedAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
              type: "user_message",
              messageId: input.messageId,
              text: input.text,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
              inputIntent: "turn_start",
              attachments: [],
            });
            yield* projections.apply({
              id: EventId.make(`item-${input.messageId}`),
              type: "turn-item.updated",
              threadId: input.threadId,
              runId: run.id,
              occurredAt: now,
              payload: turnItem,
            });
            return {
              dispatch: { sequence: 0, storedEvents: [] },
              projection: { ...source, messages: [...source.messages, message] },
              message,
              run,
              turnItem: null,
              delivery: "started" as const,
            };
          }),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(
            (cause) =>
              new Management.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause,
              }),
          ),
        ),
    ),
  });
  return yield* Recovery.ThreadHistoryRecoveryService.pipe(
    Effect.provide(Layer.fresh(Recovery.layer).pipe(Layer.provide(delivery))),
  );
});

it.effect(
  "canonical home archive restore applies current memory filtering, retains visible history, and cannot fork into an ordinary thread",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* recoveryWithSqlDelivery();
      const input = {
        threadId: f.home.id,
        archiveId: f.archiveId,
        commandId: CommandId.make("recover-owned-home"),
        messageId: MessageId.make("recovered-owned-context"),
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      assert.deepEqual(yield* recovery.capabilities(input), {
        owner: "assistant-home",
        contextRestore: true,
        fork: false,
        restoreFiles: false,
        retainedCheckpointIds: [],
      });
      const result = yield* recovery.recover({ ...input, mode: "restore" });
      assert.equal(result.threadId, f.home.id);
      assert.equal(result.continuity, "context-only");
      assert.isTrue(result.partial);
      const projection = yield* (yield* Projection.ProjectionStoreV2).getThreadRecords(f.home.id, [
        "messages",
      ]);
      const seed = projection.messages.find((message) => message.id === input.messageId);
      assert.equal(seed?.createdBy, "system");
      assert.equal(seed?.creationSource, "server");
      assert.include(seed?.text ?? "", "green terminal");
      assert.notInclude(seed?.text ?? "", "dark editor");
      assert.notInclude(seed?.text ?? "", "Old assistant echo");
      assert.notInclude(seed?.text ?? "", "Unknown raw archived");
      assert.equal((yield* sql`SELECT 1 FROM orchestration_v2_projection_threads`).length, 1);
      assert.equal((yield* sql`SELECT 1 FROM t3_workflow_v2_assistant_memory_receipts`).length, 2);
      const retained = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${f.archiveId} AND kind='turn_items'`;
      assert.include(retained.map((row) => row.payload).join(""), "dark editor");
      const fork = yield* recovery
        .recover({
          ...input,
          commandId: CommandId.make("owned-fork-refused"),
          messageId: MessageId.make("owned-fork-message"),
          mode: "fork",
          targetThreadId: f.home.id,
        })
        .pipe(Effect.flip);
      assert.equal(fork.reason, "forbidden");
      const current = yield* (yield* AssistantRepository).findByThread(f.home.id);
      assert.equal(current?.detail.summary.binding.canonicalThreadId, f.home.id);
      const live = yield* (yield* Projection.ProjectionStoreV2).getThreadRecords(f.home.id, [
        "turnItems",
      ]);
      const systemSeed = live.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === input.messageId,
      );
      assert.isDefined(systemSeed);
      const handoffs = yield* Handoffs.ContextHandoffServiceV2.pipe(
        Effect.provide(Handoffs.layer.pipe(Layer.provide(IdAllocator.layer))),
      );
      const regenerated = {
        threadId: f.home.id,
        targetRunId: RunId.make("regenerated-history"),
        toProviderThreadId: ProviderThreadId.make("regenerated-provider"),
        toProviderInstanceId: f.home.providerInstanceId,
        items: [systemSeed!],
        createdAt: f.at,
      };
      assert.include(
        (yield* handoffs.prepareLegacyImport(regenerated)).summaryText,
        "green terminal",
      );
      yield* f.memory.forget(
        sourceTuple(
          {
            environmentId: f.evidence.environmentId,
            owner: f.retained.source.owner,
            ownerRevision: f.record.ownerRevision,
          },
          f.retained.source,
        ),
      );
      const afterForget = yield* handoffs.prepareLegacyImport(regenerated);
      assert.notInclude(afterForget.summaryText, "green terminal");
      assert.isTrue(afterForget.protectedHistoryOmissions);
    }).pipe(Effect.scoped, Effect.provide(Layer.fresh(base))),
);

it.effect(
  "forgetting a retained fact after archive capture rejects the canonical seed at its SQL commit boundary",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const forget = f.memory.forget(
        sourceTuple(
          {
            environmentId: f.evidence.environmentId,
            owner: f.retained.source.owner,
            ownerRevision: f.record.ownerRevision,
          },
          f.retained.source,
        ),
      );
      const recovery = yield* recoveryWithSqlDelivery(forget);
      const messageId = MessageId.make("stale-canonical-seed");
      const outcome = yield* recovery
        .recover({
          threadId: f.home.id,
          archiveId: f.archiveId,
          mode: "restore",
          commandId: CommandId.make("stale-canonical-recovery"),
          messageId,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(outcome.reason, "execution");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id=${messageId}`)
          .length,
        0,
      );
      assert.equal((yield* sql`SELECT 1 FROM orchestration_v2_projection_threads`).length, 1);
      const current = yield* (yield* AssistantRepository).findByThread(f.home.id);
      assert.equal(current?.detail.summary.binding.canonicalThreadId, f.home.id);
    }).pipe(Effect.scoped, Effect.provide(Layer.fresh(base))),
);
