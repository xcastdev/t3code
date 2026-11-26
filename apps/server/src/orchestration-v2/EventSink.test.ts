import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  RunAttemptId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as RunAdmission from "./RunAdmission.ts";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerAdmission = Layer.effect(
  RunAdmission.RunAdmission,
  Effect.gen(function* () {
    const ordinary = yield* RunAdmission.RunAdmission;
    const sql = yield* SqlClient.SqlClient;
    return RunAdmission.RunAdmission.of({
      ...ordinary,
      commit: (input) =>
        sql`INSERT INTO test_bindings(thread_id) VALUES (${input.threadId})`.pipe(
          Effect.orDie,
          Effect.as({ _tag: "ordinary" as const }),
        ),
    });
  }),
).pipe(Layer.provide(RunAdmission.layerOrdinary));
const makeLayer = (admissionLayer = layerAdmission) =>
  EventSink.layerWithAdmission.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        EventStore.layer,
        ProjectionStore.layer,
        CommandReceiptStore.layer,
        EffectOutbox.layer,
        ProjectStore.layer,
        TurnItemPositionStore.layer,
        admissionLayer,
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Source",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
  };
}

it.effect("stores the project each notification belonged to when it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* EventStore.EventStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("notice-thread");
    const original = makeThread(threadId, now);
    const adoptedProjectId = ProjectId.make("adopted-project");
    const notice = (id: string) => ({
      id: EventId.make(id),
      type: "message.updated" as const,
      threadId,
      occurredAt: now,
      payload: {
        id: MessageId.make(id),
        threadId,
        runId: null,
        nodeId: null,
        role: "system" as const,
        text: "Completed",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "system" as const,
        creationSource: "server" as const,
        notification: {
          source: { kind: "background_task" as const },
          outcome: "completed" as const,
          summary: "Completed",
        },
      },
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("notice-thread-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: original,
        },
        notice("first-notice"),
      ],
    });
    yield* sink.write({
      events: [
        notice("second-notice"),
        {
          id: EventId.make("notice-thread-adopted"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...original, projectId: adoptedProjectId },
        },
        notice("third-notice"),
      ],
    });
    const events = yield* store
      .read({ threadId, eventType: "message.updated" })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      Array.from(events, ({ event }) => event.projectId),
      [original.projectId, original.projectId, adoptedProjectId],
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE test_bindings (thread_id TEXT NOT NULL)`;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const source = makeThread(sourceId, now);
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    assert.deepEqual(yield* sql`SELECT thread_id FROM test_bindings`, []);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect.each(["revoked", "expired"] as const)(
  "revalidates %s ownership when recovery resends the same admitted attempt",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("rewind-owner");
      const runId = RunId.make("rewind-run");
      const attemptId = RunAttemptId.make("rewind-attempt");
      const now = yield* DateTime.now;
      const thread = makeThread(threadId, now);
      const owner: RunAdmission.AdmittedOwner = {
        projectId: thread.projectId,
        bindingId: "binding",
        rootId: "root",
        generation: 1,
        fence: 1,
        threadId,
        runId,
        runAttemptId: attemptId,
        expiresAt: "2099-01-01T00:00:00.000Z",
        configuration: {
          providerInstanceId: thread.providerInstanceId,
          model: thread.modelSelection.model,
          instructionsHash: "retained",
          toolIds: [],
          skillIds: [],
          runtimeVersion: "test",
          maxTokens: 1000,
          maxDurationMs: 10000,
          paidFallback: false,
          instructionSnapshot: {
            configurationHash: "retained",
            resourceRevision: "retained",
            memoryEpoch: 0,
            roleInstructions: "Retained role",
            toolIds: [],
            skillIds: [],
          },
        },
      };
      const admission = Layer.effect(
        RunAdmission.RunAdmission,
        Effect.gen(function* () {
          const ordinary = yield* RunAdmission.RunAdmission;
          return RunAdmission.RunAdmission.of({
            ...ordinary,
            prepareResources: () =>
              Effect.die("A same-attempt resend must use its retained snapshot."),
            check: () => Effect.succeed({ _tag: "admitted", owner }),
            commit: () =>
              Effect.succeed(
                state === "revoked"
                  ? { _tag: "denied", reason: "owner-revoked" }
                  : { _tag: "expired", owner },
              ),
          });
        }),
      ).pipe(Layer.provide(RunAdmission.layerOrdinary));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const run: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("rewind-message"),
          rootNodeId: NodeId.make("rewind-root"),
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("rewind-thread-created"),
              threadId,
              type: "thread.created",
              occurredAt: now,
              payload: thread,
            },
            {
              id: EventId.make("rewind-run-created"),
              threadId,
              runId,
              type: "run.created",
              occurredAt: now,
              payload: run,
            },
          ],
        });
        const result = yield* sink
          .commitCommand({
            commandId: CommandId.make("rewind-command"),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            effects: [],
            events: [
              {
                id: EventId.make("rewind-run"),
                threadId,
                runId,
                type: "run.updated",
                occurredAt: now,
                payload: { ...run, status: "starting", startedAt: null },
              },
            ],
          })
          .pipe(sink.withProviderBatch);
        assert.equal(result.receipt.status, "rejected");
        assert.equal(
          result.receipt.error,
          state === "revoked" ? "owner-revoked" : "Run owner deadline expired.",
        );
        assert.deepEqual((yield* projections.getThreadRecords(threadId, ["runs"])).runs, [run]);
      }).pipe(Effect.provide(makeLayer(admission)));
    }),
);
