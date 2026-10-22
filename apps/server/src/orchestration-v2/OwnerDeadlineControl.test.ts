import { makeOwnerDeadlineStop } from "./runtimeLayer.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Result from "effect/Result";
import { assert, it } from "@effect/vitest";
import {
  TerminalToolError,
  CheckpointScopeId,
  CommandId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Outbox from "./EffectOutbox.ts";
import * as Worker from "./EffectWorker.ts";
import * as Deadline from "./OwnerDeadlineControl.ts";
import * as Admission from "./RunAdmission.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as ThreadTitles from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

function control(
  bindingId = "root",
  generation = 1,
  expiresAt = "1970-01-01T00:00:10.000Z",
): Outbox.OwnerDeadlineControlPayload {
  const rootId = "root";
  return {
    controlId: `deadline:${bindingId}:${generation}`,
    controlThreadId: ThreadId.make(`workflow-owner-control:${rootId}:${bindingId}:${generation}`),
    projectId: ProjectId.make("project:deadline"),
    bindingId,
    rootId,
    generation,
    fence: 1,
    targetThreadId: ThreadId.make(`thread:${bindingId}`),
    targetRunId: RunId.make(`run:${bindingId}:${generation}`),
    expiresAt,
  };
}
function row(value: Outbox.OwnerDeadlineControlPayload): Outbox.PendingOrchestrationEffectV2 {
  return {
    id: value.controlId,
    commandId: CommandId.make(value.controlId),
    threadId: value.controlThreadId,
    availableAt: DateTime.makeUnsafe(value.expiresAt),
    request: { type: "owner-deadline.expire", control: value },
  };
}
const layerOutbox = Outbox.layer.pipe(Layer.provide(Sqlite.layerMemory));

it.effect(
  "isolates normal retries, control lanes, and earlier child deadlines in both claim and wake queries",
  () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const root = control();
      const child = control("child", 1, "1970-01-01T00:00:05.000Z");
      yield* outbox.enqueue([
        {
          id: "normal",
          commandId: CommandId.make("normal"),
          threadId: root.targetThreadId,
          request: { type: "terminal.cleanup" },
        },
        row(root),
        row(child),
      ]);
      const normal = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "normal", leaseDurationMs: 1000 }),
      );
      assert.equal(normal.id, "normal");
      yield* outbox.retry({
        effectId: "normal",
        workerId: "normal",
        error: "backoff",
        delayMs: 20000,
      });
      assert.equal(
        DateTime.formatIso(Option.getOrThrow(yield* outbox.nextClaimableAt)),
        "1970-01-01T00:00:20.000Z",
      );
      assert.equal(
        DateTime.formatIso(Option.getOrThrow(yield* outbox.nextClaimableAtFor("owner-deadline"))),
        child.expiresAt,
      );
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "normal", leaseDurationMs: 1000 })),
      );
      assert.equal(
        Option.getOrThrow(
          yield* outbox.claimNext({
            workerId: "control",
            leaseDurationMs: 1000,
            consumer: "owner-deadline",
          }),
        ).id,
        child.controlId,
      );
      yield* TestClock.adjust("5 seconds");
      assert.equal(
        Option.getOrThrow(
          yield* outbox.claimNext({
            workerId: "control",
            leaseDurationMs: 1000,
            consumer: "owner-deadline",
          }),
        ).id,
        root.controlId,
      );
    }).pipe(Effect.provide(layerOutbox)),
);

it.effect(
  "requeues a crash-running control before true expiry and reschedules without stopping",
  () => {
    const target = control();
    const stopped: string[] = [];
    const handler = Deadline.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Admission.RunAdmission)({
            deadline: (input) =>
              Effect.succeed(
                input.now < input.expiresAt
                  ? { _tag: "early", availableAt: input.expiresAt }
                  : { _tag: "stop", targets: [input] },
              ),
          }),
          Layer.succeed(Deadline.OwnerDeadlineStop, {
            stop: ({ commandId }) =>
              Effect.sync(() => {
                stopped.push(commandId);
              }),
          }),
        ),
      ),
    );
    const executor = Layer.effect(
      Worker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const deadlines = yield* Deadline.OwnerDeadlineControl;
        return Worker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            effect.request.type === "owner-deadline.expire"
              ? deadlines.handle(effect.request.control).pipe(
                  Effect.mapError(
                    (cause) =>
                      new Worker.OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: effect.request.type,
                        cause,
                      }),
                  ),
                )
              : Effect.void,
        });
      }),
    ).pipe(Layer.provide(handler));
    const worker = Worker.layer.pipe(Layer.provideMerge(Layer.merge(layerOutbox, executor)));
    return Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const effects = yield* Worker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([row(target)]);
      yield* TestClock.adjust("10 seconds");
      yield* outbox.claimNext({
        workerId: "crashed",
        leaseDurationMs: 1000,
        consumer: "owner-deadline",
      });
      // Simulate recovery on a machine whose clock precedes the retained true expiry.
      yield* TestClock.setTime(0);
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
      assert.isTrue(yield* effects.runControlOnce);
      assert.deepEqual(stopped, []);
      assert.equal(
        Option.getOrThrow(yield* outbox.get(target.controlId)).availableAt,
        target.expiresAt,
      );
      assert.equal(yield* effects.drain(), 0);
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(yield* effects.runControlOnce);
      assert.deepEqual(stopped, [`${target.controlId}:stop`]);
      assert.equal(Option.getOrThrow(yield* outbox.get(target.controlId)).status, "succeeded");
    }).pipe(Effect.provide(worker));
  },
);

it.effect(
  "uses real targets and stable stop receipts for descendants while stale controls do nothing",
  () => {
    const root = control();
    const child = control("child");
    const stops: string[] = [];
    const handler = Deadline.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Admission.RunAdmission)({
            deadline: (input) =>
              Effect.succeed(
                input.generation === 1
                  ? { _tag: "stop", targets: [root, child] }
                  : { _tag: "stale" },
              ),
          }),
          Layer.succeed(Deadline.OwnerDeadlineStop, {
            stop: ({ control: target, commandId }) =>
              Effect.sync(() => {
                assert.isFalse(target.targetThreadId.startsWith("workflow-owner-control:"));
                if (!stops.includes(commandId)) stops.push(commandId);
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const deadlines = yield* Deadline.OwnerDeadlineControl;
      yield* deadlines.handle(root);
      yield* deadlines.handle(root);
      yield* deadlines.handle(control("root", 2));
      assert.deepEqual(stops, [`${root.controlId}:stop`, `${child.controlId}:stop`]);
    }).pipe(Effect.provide(handler));
  },
);

it.effect("cancels synthetic controls by linked ID without blocking real-thread settlement", () =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    const target = control();
    yield* outbox.enqueue([row(target)]);
    const cancelled = yield* outbox.cancelByIds({
      effectIds: [target.controlId],
      reason: "settled",
    });
    yield* outbox.signalCancellations(cancelled);
    yield* outbox.awaitSettled(target.controlId);
    assert.deepEqual(cancelled, [target.controlId]);
    assert.deepEqual(
      yield* outbox.cancelByIds({ effectIds: [target.controlId], reason: "settled" }),
      [],
    );
    assert.isTrue(Option.isNone(yield* outbox.nextClaimableAtFor("owner-deadline")));
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect("reserved consumer expires controls while all four normal workers are blocked", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const expired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let active = 0;
    const executor = Layer.succeed(Worker.OrchestrationEffectExecutorV2, {
      execute: (effect) =>
        Effect.gen(function* () {
          if (effect.request.type === "owner-deadline.expire") {
            yield* Deferred.succeed(expired, undefined);
            return;
          }
          active++;
          if (active === 4) yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
    });
    const workers = Worker.layer.pipe(Layer.provideMerge(Layer.merge(layerOutbox, executor)));
    yield* Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const effects = yield* Worker.OrchestrationEffectWorkerV2;
      const target = control();
      yield* outbox.enqueue([
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `normal:${i}`,
          commandId: CommandId.make(`normal:${i}`),
          threadId: ThreadId.make(`thread:${i}`),
          request: { type: "terminal.cleanup" as const },
        })),
        row(target),
      ]);
      const daemon = yield* Worker.runDaemon.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(expired);
      yield* outbox.awaitSettled(target.controlId);
      assert.equal(active, 4);
      assert.equal(Option.getOrThrow(yield* outbox.get(target.controlId)).status, "succeeded");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.interrupt(daemon);
      assert.isFalse(yield* effects.runControlOnce);
    }).pipe(Effect.provide(workers));
  }).pipe(Effect.scoped),
);

it.effect(
  "the production executor never resolves a synthetic thread or waits for native start and finalization",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let active = 0;
      const block = (threadId: ThreadId) =>
        Effect.gen(function* () {
          assert.isFalse(threadId.startsWith("workflow-owner-control:"));
          active++;
          if (active === 4) yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        });
      const target = control();
      const deadlines = Deadline.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Admission.RunAdmission)({
              deadline: (input) => Effect.succeed({ _tag: "stop", targets: [input] }),
            }),
            Layer.succeed(Deadline.OwnerDeadlineStop, {
              stop: ({ control: proof }) =>
                Effect.gen(function* () {
                  assert.equal(proof.targetThreadId, target.targetThreadId);
                  assert.equal(proof.targetRunId, target.targetRunId);
                  yield* Deferred.succeed(stopped, undefined);
                }),
            }),
          ),
        ),
      );
      const executor = Worker.layerExecutor.pipe(
        Layer.provide(
          Layer.mergeAll(
            deadlines,
            Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
            Layer.mock(RunFinalization.RunFinalizationService)({
              finalize: ({ threadId }) => block(threadId),
            }),
            Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
            Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
            Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
              start: ({ threadId }) => block(threadId),
            }),
            Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
            Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            ServerSettings.layerTest(),
          ),
        ),
      );
      const workers = Worker.layer.pipe(Layer.provideMerge(Layer.merge(layerOutbox, executor)));
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox.EffectOutboxV2;
        yield* outbox.enqueue([
          ...Array.from({ length: 4 }, (_, i) => ({
            id: `blocked:${i}`,
            commandId: CommandId.make(`blocked:${i}`),
            threadId: ThreadId.make(`thread:blocked:${i}`),
            request:
              i < 2
                ? { type: "provider-turn.start" as const, runId: RunId.make(`run:${i}`) }
                : {
                    type: "checkpoint.capture" as const,
                    runId: RunId.make(`run:${i}`),
                    scopeId: CheckpointScopeId.make(`scope:${i}`),
                  },
          })),
          row(target),
        ]);
        const daemon = yield* Worker.runDaemon.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(stopped);
        yield* outbox.awaitSettled(target.controlId);
        assert.equal(active, 4);
        assert.equal(Option.getOrThrow(yield* outbox.get(target.controlId)).status, "succeeded");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.provide(workers));
    }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "root self-cancellation finishes descendant commits and preserves write failures (child fails: %s)",
  (childFails) =>
    Effect.gen(function* () {
      const root = control("root", 1, "1970-01-01T00:00:00.000Z");
      const child = control("child", 1, root.expiresAt);
      const signalled = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const receipts = new Set<string>();
      const stops: string[] = [];
      const stopLayer = Layer.effect(
        Deadline.OwnerDeadlineStop,
        Effect.gen(function* () {
          const outbox = yield* Outbox.EffectOutboxV2;
          return Deadline.OwnerDeadlineStop.of({
            stop: ({ control: target, commandId }) =>
              Effect.gen(function* () {
                assert.equal(
                  target.targetRunId,
                  target.bindingId === "root" ? root.targetRunId : child.targetRunId,
                );
                if (receipts.has(commandId)) return;
                if (target.bindingId === "child" && childFails)
                  return yield* new Deadline.OwnerDeadlineControlError({
                    controlId: target.controlId,
                    cause: "child stop transaction failed",
                  });
                receipts.add(commandId);
                stops.push(target.targetThreadId);
                if (target.bindingId === "root") {
                  const cancelled = yield* outbox.cancelByIds({
                    effectIds: [root.controlId],
                    reason: "root stop settled assignment",
                  });
                  yield* outbox.signalCancellations(cancelled);
                  yield* Deferred.succeed(signalled, undefined);
                  yield* Deferred.await(release);
                }
              }).pipe(
                Effect.catchTags({
                  EffectOutboxError: (cause) =>
                    Effect.fail(
                      new Deadline.OwnerDeadlineControlError({
                        controlId: target.controlId,
                        cause,
                      }),
                    ),
                }),
              ),
          });
        }),
      ).pipe(Layer.provide(layerOutbox));
      const handler = Deadline.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            stopLayer,
            Layer.mock(Admission.RunAdmission)({
              deadline: () => Effect.succeed({ _tag: "stop", targets: [root, child] }),
            }),
          ),
        ),
      );
      const executor = Layer.effect(
        Worker.OrchestrationEffectExecutorV2,
        Effect.gen(function* () {
          const deadline = yield* Deadline.OwnerDeadlineControl;
          return Worker.OrchestrationEffectExecutorV2.of({
            execute: (effect) =>
              effect.request.type === "owner-deadline.expire"
                ? deadline.handle(effect.request.control).pipe(
                    Effect.mapError(
                      (cause) =>
                        new Worker.OrchestrationEffectExecutionError({
                          effectId: effect.id,
                          effectType: effect.request.type,
                          cause,
                        }),
                    ),
                  )
                : Effect.void,
          });
        }),
      ).pipe(Layer.provide(handler));
      const workers = Worker.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerOutbox, executor, handler)),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox.EffectOutboxV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([row(root)]);
        const running = yield* worker.runControlOnce.pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(signalled);
        assert.deepEqual(stops, [root.targetThreadId]);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(running);
        assert.equal(Exit.isFailure(result), childFails);
        if (Exit.isFailure(result)) {
          assert.equal(
            Option.getOrThrow(Cause.findErrorOption(result.cause)).operation,
            "cancelled-control-commit",
          );
          assert.deepEqual(stops, [root.targetThreadId]);
        }
        assert.equal(Option.getOrThrow(yield* outbox.get(root.controlId)).status, "cancelled");
        if (!childFails) {
          assert.deepEqual(stops, [root.targetThreadId, child.targetThreadId]);
          yield* (yield* Deadline.OwnerDeadlineControl).handle(root);
          assert.deepEqual(stops, [root.targetThreadId, child.targetThreadId]);
          assert.deepEqual([...receipts], [`${root.controlId}:stop`, `${child.controlId}:stop`]);
        }
      }).pipe(Effect.provide(workers));
    }).pipe(Effect.scoped),
);

it.effect(
  "shutting down a claimed control interrupts its shared thread-lock wait before the lock is released",
  () =>
    Effect.gen(function* () {
      const target = control("root", 1, "1970-01-01T00:00:00.000Z");
      const lock = yield* KeyedLock.make<ThreadId>();
      const held = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let commits = 0;
      const holder = yield* lock
        .withLock(
          target.targetThreadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const handler = Deadline.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Admission.RunAdmission)({
              deadline: () => Effect.succeed({ _tag: "stop", targets: [target] }),
            }),
            Layer.succeed(Deadline.OwnerDeadlineStop, {
              stop: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(requested, undefined);
                  yield* lock.withLock(
                    target.targetThreadId,
                    Effect.sync(() => {
                      commits++;
                    }),
                  );
                }),
            }),
          ),
        ),
      );
      const executor = Layer.effect(
        Worker.OrchestrationEffectExecutorV2,
        Effect.gen(function* () {
          const deadline = yield* Deadline.OwnerDeadlineControl;
          return Worker.OrchestrationEffectExecutorV2.of({
            execute: (effect) =>
              deadline.handle(target).pipe(
                Effect.mapError(
                  (cause) =>
                    new Worker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(handler));
      const workers = Worker.layer.pipe(Layer.provideMerge(Layer.merge(layerOutbox, executor)));
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox.EffectOutboxV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([row(target)]);
        const running = yield* worker.runControlOnce.pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* Fiber.interrupt(running);
        assert.isFalse(yield* Deferred.isDone(release));
        assert.equal(commits, 0);
        assert.equal(Option.getOrThrow(yield* outbox.get(target.controlId)).status, "running");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.equal(commits, 0);
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
      }).pipe(Effect.provide(workers));
    }).pipe(Effect.scoped),
);

it.effect(
  "deadline stop cleans only captured owned terminals and does not block other targets on uncertainty",
  () =>
    Effect.gen(function* () {
      const first = control("first", 1);
      const second = control("second", 2);
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const otherStopped = yield* Deferred.make<void>();
      const stoppedRuns: string[] = [];
      const terminals = [
        { id: "owned-first", owner: first, status: "running" },
        { id: "owned-second", owner: second, status: "running" },
        { id: "ordinary-user-terminal", owner: null, status: "running" },
      ];
      const stops = Layer.effect(Deadline.OwnerDeadlineStop, makeOwnerDeadlineStop).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              stopOwnedRun: ({ control, commandId }) =>
                Effect.sync(() => {
                  stoppedRuns.push(control.targetRunId);
                }).pipe(
                  Effect.andThen(
                    control.bindingId === first.bindingId
                      ? Effect.fail(
                          new Orchestrator.OrchestratorOwnerDeadlineBusyError({
                            threadId: control.targetThreadId,
                            commandId,
                          }),
                        )
                      : Deferred.succeed(otherStopped, undefined).pipe(Effect.asVoid),
                  ),
                ),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              closeProjectOwner: (owner) =>
                Effect.gen(function* () {
                  const captured = terminals.filter(
                    (terminal) =>
                      terminal.owner?.projectId === owner.projectId &&
                      terminal.owner.rootId === owner.rootId &&
                      terminal.owner.bindingId === owner.bindingId &&
                      terminal.owner.generation === owner.generation &&
                      terminal.owner.fence === owner.fence,
                  );
                  if (owner.bindingId === first.bindingId) {
                    yield* Deferred.succeed(cleanupStarted, undefined);
                    yield* Deferred.await(releaseCleanup);
                    captured.forEach((terminal) => {
                      terminal.status = "unknown";
                    });
                    return yield* new TerminalToolError({
                      operation: "close",
                      reason: "stop-uncertain",
                      projectId: ProjectId.make(owner.projectId),
                    });
                  }
                  captured.forEach((terminal) => {
                    terminal.status = "stopping";
                  });
                }),
            }),
          ),
        ),
      );
      const layer = Deadline.layer.pipe(
        Layer.provide(stops),
        Layer.provide(
          Layer.mock(Admission.RunAdmission)({
            deadline: () => Effect.succeed({ _tag: "stop", targets: [first, second] }),
          }),
        ),
      );
      const handler = yield* Deadline.OwnerDeadlineControl.pipe(Effect.provide(layer));
      const pending = yield* handler
        .handle(first)
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(cleanupStarted);
      yield* Deferred.await(otherStopped);
      assert.sameMembers(stoppedRuns, [first.targetRunId, second.targetRunId]);
      assert.equal(terminals[2]?.status, "running");
      yield* Deferred.succeed(releaseCleanup, undefined);
      const result = yield* Fiber.join(pending);
      assert.isTrue(Result.isFailure(result));
      assert.equal(terminals[0]?.status, "unknown");
      assert.equal(terminals[1]?.status, "stopping");
      assert.equal(terminals[2]?.status, "running");
    }).pipe(Effect.scoped),
);
