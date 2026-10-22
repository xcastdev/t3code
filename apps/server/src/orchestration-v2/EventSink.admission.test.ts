import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RunAdmission from "./RunAdmission.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const isRunAdmissionError = Schema.is(RunAdmission.RunAdmissionError);

const makeEvent = (
  id: string,
  now: DateTime.Utc,
  worktreePath: string | null = null,
): OrchestrationV2DomainEvent => {
  const threadId = ThreadId.make(id);
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:admission"),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`event:${id}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  };
};

const layerDatabase = Sqlite.layerMemory;
const layerStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
).pipe(Layer.provideMerge(layerDatabase));
const withAdmission = <E>(
  admission: Layer.Layer<RunAdmission.RunAdmission, E, SqlClient.SqlClient>,
) =>
  Layer.mergeAll(
    layerStores,
    EventSink.layerWithAdmission.pipe(
      Layer.provide(Layer.merge(layerStores, admission.pipe(Layer.provide(layerStores)))),
    ),
  );

it.effect("rejects a whole admission batch durably and replays it without preparing again", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const admission = Layer.effect(
      RunAdmission.RunAdmission,
      Effect.gen(function* () {
        const ordinary = yield* RunAdmission.RunAdmission;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE admission_probe (thread_id TEXT PRIMARY KEY)`;
        return RunAdmission.RunAdmission.of({
          ...ordinary,
          commit: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (n) => n + 1);
              yield* sql`INSERT INTO admission_probe (thread_id) VALUES (${input.threadId})`;
              return input.threadId === "second"
                ? { _tag: "denied" as const, reason: "owner-revoked" }
                : { _tag: "ordinary" as const };
            }).pipe(
              Effect.mapError(
                (cause) => new RunAdmission.RunAdmissionError({ operation: "test", cause }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(RunAdmission.layerOrdinary));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:batch-denied");
      const input = {
        commandId,
        threadId: ThreadId.make("first"),
        commandType: "delegated_task.request",
        acceptedAt: now,
        events: [makeEvent("first", now), makeEvent("second", now)],
        effects: [],
      };
      const first = yield* sink.commitCommand(input);
      assert.equal(first.receipt.status, "rejected");
      assert.equal(first.receipt.error, "owner-revoked");
      assert.deepEqual(yield* sql`SELECT * FROM admission_probe`, []);
      assert.equal(yield* sink.latestSequence(), 0);
      const replay = yield* sink.commitCommand(input);
      assert.deepEqual(replay.receipt, first.receipt);
      assert.equal(replay.committed, false);
      assert.equal(yield* Ref.get(calls), 2);
      assert.deepEqual(yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(commandId), []);
    }).pipe(Effect.provide(withAdmission(admission)));
  }),
);

it.effect(
  "rolls back binding and receipt together on a commit failure, then admits one retry",
  () =>
    Effect.gen(function* () {
      const fail = yield* Ref.make(true);
      const admission = Layer.effect(
        RunAdmission.RunAdmission,
        Effect.gen(function* () {
          const ordinary = yield* RunAdmission.RunAdmission;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE admission_probe (thread_id TEXT PRIMARY KEY)`;
          return RunAdmission.RunAdmission.of({
            ...ordinary,
            commit: (input) =>
              Effect.gen(function* () {
                yield* sql`INSERT INTO admission_probe (thread_id) VALUES (${input.threadId})`;
                if (yield* Ref.get(fail))
                  return yield* Effect.fail(
                    new RunAdmission.RunAdmissionError({
                      operation: "injected-crash",
                      cause: "crash after binding",
                    }),
                  );
                return { _tag: "ordinary" as const };
              }).pipe(
                Effect.mapError((cause) =>
                  isRunAdmissionError(cause)
                    ? cause
                    : new RunAdmission.RunAdmissionError({ operation: "test", cause }),
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(RunAdmission.layerOrdinary));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const commandId = CommandId.make("command:crash");
        const input = {
          commandId,
          threadId: ThreadId.make("crash"),
          commandType: "thread.create",
          acceptedAt: now,
          events: [makeEvent("crash", now)],
          effects: [],
        };
        assert.equal((yield* Effect.result(sink.commitCommand(input)))._tag, "Failure");
        assert.deepEqual(yield* sql`SELECT * FROM admission_probe`, []);
        assert.isTrue(
          Option.isNone(
            yield* (yield* CommandReceiptStore.CommandReceiptStoreV2).getByCommandId(commandId),
          ),
        );
        yield* Ref.set(fail, false);
        const results = yield* Effect.all([sink.commitCommand(input), sink.commitCommand(input)], {
          concurrency: "unbounded",
        });
        assert.equal(results.filter((r) => r.committed).length, 1);
        assert.equal((yield* sql`SELECT * FROM admission_probe`).length, 1);
        assert.equal(yield* sink.latestSequence(), 1);
      }).pipe(Effect.provide(withAdmission(admission)));
    }),
);

it.effect(
  "stops a late owned native turn at its retained session without stopping a successor",
  () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<
        Array<{ runId: string; runAttemptId: string; terminal: boolean }>
      >([]);
      const admission = Layer.effect(
        RunAdmission.RunAdmission,
        Effect.gen(function* () {
          const ordinary = yield* RunAdmission.RunAdmission;
          return RunAdmission.RunAdmission.of({
            ...ordinary,
            observeNativeTurn: (input) =>
              Ref.update(observed, (rows) => [...rows, input]).pipe(
                Effect.as({
                  stop: input.runAttemptId === "attempt:old" && !input.terminal,
                  cancelControlIds: [],
                }),
              ),
          });
        }),
      ).pipe(Layer.provide(RunAdmission.layerOrdinary));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("late-native");
        const providerThreadId = ProviderThreadId.make("provider-thread:shared");
        const oldAttempt = RunAttemptId.make("attempt:old");
        const successorAttempt = RunAttemptId.make("attempt:successor");
        const oldRun = RunId.make("run:old");
        const successorRun = RunId.make("run:successor");
        const oldNode = NodeId.make("node:old");
        const successorNode = NodeId.make("node:successor");
        yield* sink.write({
          events: [
            makeEvent(threadId, now),
            ...[
              { id: oldAttempt, runId: oldRun, nodeId: oldNode },
              { id: successorAttempt, runId: successorRun, nodeId: successorNode },
            ].map((attempt): OrchestrationV2DomainEvent => ({
              id: EventId.make(`event:${attempt.id}`),
              threadId,
              runId: attempt.runId,
              occurredAt: now,
              type: "run-attempt.updated",
              payload: {
                id: attempt.id,
                runId: attempt.runId,
                attemptOrdinal: 1,
                rootNodeId: attempt.nodeId,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId,
                providerTurnId: null,
                reason: "initial",
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            })),
            {
              id: EventId.make("event:successor-native-destination"),
              threadId,
              occurredAt: now,
              type: "provider-thread.updated",
              payload: {
                id: providerThreadId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: ProviderSessionId.make("session:successor"),
                appThreadId: threadId,
                ownerNodeId: successorNode,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 2,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: null,
                goal: null,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        const turnEvent = (
          runId: RunId,
          runAttemptId: RunAttemptId,
          nodeId: NodeId,
          status: "running" | "completed",
        ): OrchestrationV2DomainEvent => ({
          id: EventId.make(`event:${runAttemptId}:${status}`),
          threadId,
          runId,
          occurredAt: now,
          type: "provider-turn.updated",
          payload: {
            id: ProviderTurnId.make(`turn:${runAttemptId}`),
            providerThreadId,
            runAttemptId,
            nodeId,
            nativeTurnRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: `native:${runAttemptId}`,
              strength: "strong",
            },
            ordinal: runAttemptId === oldAttempt ? 1 : 2,
            status,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
          },
        });
        yield* sink.write({
          providerEventOrigin: {
            threadId,
            runId: oldRun,
            providerSessionId: ProviderSessionId.make("session:old"),
          },
          events: [turnEvent(oldRun, oldAttempt, oldNode, "running")],
        });
        yield* sink.write({
          providerEventOrigin: {
            threadId,
            runId: successorRun,
            providerSessionId: ProviderSessionId.make("session:successor"),
          },
          events: [turnEvent(successorRun, successorAttempt, successorNode, "running")],
        });
        const stopId = CommandId.make("command:owner-native-stop:attempt:old:turn:attempt:old");
        const effects = yield* outbox.listByCommandId(stopId);
        assert.equal(effects.length, 1);
        assert.deepEqual(effects[0]?.request, {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("session:old"),
          providerThreadId,
          providerTurnId: ProviderTurnId.make("turn:attempt:old"),
        });
        assert.deepEqual(
          yield* outbox.listByCommandId(
            CommandId.make("command:owner-native-stop:attempt:successor:turn:attempt:successor"),
          ),
          [],
        );
        yield* sink.write({
          providerEventOrigin: {
            threadId,
            runId: oldRun,
            providerSessionId: ProviderSessionId.make("session:old"),
          },
          events: [turnEvent(oldRun, oldAttempt, oldNode, "completed")],
        });
        assert.deepEqual(
          (yield* Ref.get(observed)).map((row) => [row.runId, row.runAttemptId, row.terminal]),
          [
            [oldRun, oldAttempt, false],
            [successorRun, successorAttempt, false],
            [oldRun, oldAttempt, true],
          ],
        );
      }).pipe(Effect.provide(withAdmission(admission)));
    }),
);

it.effect("rejects an exact native stop when the same run has moved to a successor attempt", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("same-run-successor");
    const runId = RunId.make("run:shared");
    const successorAttempt = RunAttemptId.make("attempt:next");
    const successorNode = NodeId.make("node:next");
    const providerThreadId = ProviderThreadId.make("provider-thread:shared");
    const providerSessionId = ProviderSessionId.make("session:shared");
    yield* sink.write({
      events: [
        makeEvent(threadId, now),
        {
          id: EventId.make("event:successor-run"),
          threadId,
          runId,
          type: "run.created",
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            providerThreadId,
            userMessageId: MessageId.make("message:root"),
            rootNodeId: successorNode,
            activeAttemptId: successorAttempt,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("event:successor-provider-thread"),
          threadId,
          type: "provider-thread.updated",
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: successorNode,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const commandId = CommandId.make("command:stale-native-stop");
    const result = yield* sink.commitCommand({
      commandId,
      threadId,
      commandType: "run.interrupt",
      acceptedAt: now,
      exactRunStop: {
        runId,
        runAttemptId: RunAttemptId.make("attempt:old"),
        rootNodeId: NodeId.make("node:old"),
        providerThreadId,
        providerSessionId,
      },
      events: [
        {
          id: EventId.make("event:must-not-stop-successor"),
          threadId,
          runId,
          type: "run.updated",
          occurredAt: now,
          payload: {
            ...(yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(threadId, [
              "runs",
            ])).runs[0]!,
            status: "interrupted",
            completedAt: now,
          },
        },
      ],
      effects: [
        {
          id: "effect:must-not-interrupt-successor",
          commandId,
          threadId,
          request: {
            type: "provider-turn.interrupt",
            providerThreadId,
            providerSessionId,
            providerTurnId: ProviderTurnId.make("turn:next"),
          },
        },
      ],
    });
    assert.equal(result.receipt.status, "rejected");
    assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    assert.equal(
      (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(threadId, ["runs"]))
        .runs[0]?.status,
      "running",
    );
    const controlId = "effect:owned-settlement";
    yield* outbox.enqueue([
      {
        id: controlId,
        commandId: CommandId.make("command:owned-settlement"),
        threadId: ThreadId.make("workflow-owner-control:isolated"),
        request: {
          type: "owner-deadline.expire",
          control: {
            controlId,
            controlThreadId: ThreadId.make("workflow-owner-control:isolated"),
            projectId: ProjectId.make("project:admission"),
            bindingId: "binding:isolated",
            rootId: "root:isolated",
            generation: 1,
            fence: 1,
            targetThreadId: threadId,
            targetRunId: runId,
            expiresAt: DateTime.formatIso(now),
          },
        },
      },
    ]);
    const cancellation = outbox.awaitCancellation(controlId);
    const currentRun = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
      threadId,
      ["runs"],
    )).runs[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:owned-settled"),
          threadId,
          runId,
          type: "run.updated",
          occurredAt: now,
          payload: { ...currentRun, status: "completed", completedAt: now },
        },
      ],
    });
    yield* cancellation;
    const settled = yield* outbox.get(controlId);
    assert.equal(Option.getOrThrow(settled).status, "cancelled");
  }).pipe(
    Effect.provide(
      withAdmission(
        Layer.effect(
          RunAdmission.RunAdmission,
          Effect.map(RunAdmission.RunAdmission, (ordinary) =>
            RunAdmission.RunAdmission.of({
              ...ordinary,
              settle: () => Effect.succeed(["effect:owned-settlement"]),
            }),
          ),
        ).pipe(Layer.provide(RunAdmission.layerOrdinary)),
      ),
    ),
  ),
);

it.effect(
  "prepares resource candidates outside SQL and carries them into the atomic admission",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const candidate: RunAdmission.PreparedResourceInstructions = {
        catalogRevision: 1,
        baseHash: "trusted-base",
        snapshot: {
          configurationHash: "config",
          resourceRevision: "resources",
          memoryEpoch: 0,
          roleInstructions: "Trusted role and skill",
          skillIds: ["review"],
          toolIds: [],
        },
      };
      const admission = Layer.effect(
        RunAdmission.RunAdmission,
        Effect.gen(function* () {
          const ordinary = yield* RunAdmission.RunAdmission;
          const sql = yield* SqlClient.SqlClient;
          return RunAdmission.RunAdmission.of({
            ...ordinary,
            prepareResources: (input) =>
              Effect.gen(function* () {
                assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
                assert.equal(input.proposedWorktreePath, "/tmp/proposed-worktree");
                yield* Ref.update(calls, (value) => value + 1);
                return candidate;
              }),
            commit: (input) =>
              Effect.gen(function* () {
                assert.isTrue(Option.isSome(yield* Effect.serviceOption(sql.transactionService)));
                assert.strictEqual(input.preparedResources, candidate);
                assert.equal(input.proposedWorktreePath, "/tmp/proposed-worktree");
                return { _tag: "ordinary" as const };
              }),
          });
        }),
      ).pipe(Layer.provide(RunAdmission.layerOrdinary));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const input = {
          commandId: CommandId.make("command:resource-preflight"),
          threadId: ThreadId.make("resource-preflight"),
          commandType: "thread.create",
          acceptedAt: now,
          events: [makeEvent("resource-preflight", now, "/tmp/proposed-worktree")],
          effects: [],
        };
        const committed = yield* sink.commitCommand(input);
        assert.equal(committed.receipt.status, "accepted");
        assert.equal((yield* sink.commitCommand(input)).committed, false);
        assert.equal(yield* Ref.get(calls), 1);
      }).pipe(Effect.provide(withAdmission(admission)));
    }),
);
