import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as ServerSecrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { makeProjectTeamExecutionReactor } from "./ProjectTeamExecutionReactor.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const services = () =>
  Layer.merge(
    Settings.layer.pipe(
      Layer.provide(ServerSecrets.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-execution-reactor-" })),
      ),
    ),
    ProjectWorkEventBusLive,
  );
const enable = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  yield* settings.updateSettings({ projectWorkEnabled: true, projectTeamExecutionEnabled: true });
  return settings;
});
const event = (cursor: number, value: ProjectWorkEvent) => ({ cursor, event: value });
const readyEvent = (cursor: number) =>
  event(cursor, {
    type: "project-work.task.ready",
    eventId: EventId.make(`event-${cursor}`),
    projectId: ProjectId.make("project"),
    revision: cursor,
    occurredAt: "2026-10-04T00:00:00.000Z",
    taskId: ProjectWorkTaskId.make("task"),
  });
const quietEvent = (cursor: number) =>
  event(cursor, {
    type: "project-work.attention.seen",
    eventId: EventId.make(`event-${cursor}`),
    projectId: "project",
    revision: cursor,
    occurredAt: "2026-10-04T00:00:00.000Z",
    taskId: ProjectWorkTaskId.make("task"),
    seenAt: "2026-10-04T00:00:00.000Z",
  });
const acknowledgment = (cursor: number) =>
  event(cursor, {
    type: "project-work.foundation.recorded",
    eventId: EventId.make(`ack-event-${cursor}`),
    projectId: "project",
    revision: cursor,
    occurredAt: "2026-10-04T00:00:00.000Z",
    record: {
      kind: "message",
      recordId: `message-${cursor}`,
      projectId: ProjectId.make("project"),
      revision: 1,
      generation: 0,
      updatedAt: "2026-10-04T00:00:00.000Z",
      status: "acknowledged",
      commandId: `message-command-${cursor}`,
      senderId: "sender",
      recipientId: "recipient",
      body: "acknowledged",
      evidenceIds: [],
      deliveryGeneration: 0,
      deliveryCursor: cursor,
    },
  });
const control = Effect.gen(function* () {
  const started = yield* Queue.unbounded<number>();
  const sweeps = yield* Queue.unbounded<number>();
  const stops = yield* Queue.unbounded<number>();
  const finalized = yield* Queue.unbounded<number>();
  let starts = 0;
  let count = 0;
  let inSweep = 0;
  let maxInSweep = 0;
  const start = Effect.gen(function* () {
    const id = ++starts;
    yield* Queue.offer(started, id);
    yield* Effect.addFinalizer(() => Queue.offer(finalized, id).pipe(Effect.asVoid));
    return {
      ready: Effect.void,
      sweep: Effect.acquireUseRelease(
        Effect.sync(() => {
          inSweep++;
          maxInSweep = Math.max(maxInSweep, inSweep);
        }),
        () => Queue.offer(sweeps, ++count).pipe(Effect.asVoid),
        () =>
          Effect.sync(() => {
            inSweep--;
          }),
      ),
      stop: Queue.offer(stops, id).pipe(Effect.asVoid),
    };
  });
  return {
    start,
    started,
    sweeps,
    stops,
    finalized,
    counts: () => ({ starts, count, maxInSweep }),
  };
});

it.layer(NodeServices.layer)("project team execution reactor", (it) => {
  for (const [budget, maxOps] of [
    [0, 2048],
    [26, 2048],
    [27, 2048],
    [28, 2048],
    [undefined, 27],
    [undefined, 2048],
  ] as const) {
    it.effect(
      `settles concurrent drains after joined stop with ${budget === undefined ? `ordinary scheduler budget ${maxOps}` : `one scheduler yield at ${budget}`}`,
      () =>
        Effect.gen(function* () {
          yield* enable;
          const entered = yield* Deferred.make<void>();
          let stops = 0;
          let finalized = 0;
          const reactor = yield* makeProjectTeamExecutionReactor({
            start: Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              return {
                ready: Effect.void,
                sweep: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                stop: Effect.sync(() => {
                  stops++;
                }),
              };
            }),
          });
          yield* Deferred.await(entered);
          const base = new Scheduler.MixedScheduler("sync", () => () => {});
          const dispatcher = base.makeDispatcher();
          const yielded = new Set<number>();
          const scheduler: Scheduler.Scheduler = {
            executionMode: "sync",
            shouldYield: (fiber) => {
              if (budget === undefined) return base.shouldYield(fiber);
              if (budget !== 0 && !yielded.has(fiber.id) && fiber.currentOpCount >= budget) {
                yielded.add(fiber.id);
                return true;
              }
              return false;
            },
            makeDispatcher: () => dispatcher,
          };
          const drains = yield* Effect.forEach(Array.from({ length: 24 }), () =>
            Effect.forkChild(
              reactor
                .drain()
                .pipe(
                  Effect.provideService(Scheduler.Scheduler, scheduler),
                  Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOps),
                ),
              { startImmediately: true },
            ),
          );
          yield* Effect.sync(() => dispatcher.flush());
          yield* reactor.stop;
          const exits = yield* Effect.sync(() => {
            dispatcher.flush();
            return drains.map((fiber) => fiber.pollUnsafe());
          });
          // A quiescent dispatcher after joined stop proves a lost waiter without a timeout.
          yield* Effect.sync(() => {
            for (const fiber of drains) fiber.interruptUnsafe();
            dispatcher.flush();
          });
          yield* Effect.forEach(drains, Fiber.await);
          assert.equal(exits.filter((exit) => exit === undefined).length, 0);
          assert.isTrue(
            exits.every(
              (exit) =>
                exit !== undefined && Exit.isSuccess(exit) && exit.value.status === "stopped",
            ),
          );
          if (budget !== undefined) assert.equal(yielded.size, budget === 0 ? 0 : 24);
          assert.equal(stops, 1);
          assert.equal(finalized, 1);
        }).pipe(Effect.scoped, Effect.provide(services())),
    );
  }
  for (const [budget, maxOps] of [
    [0, 2048],
    [7, 2048],
    [8, 2048],
    [9, 2048],
    [undefined, 8],
    [undefined, 2048],
  ] as const) {
    it.effect(
      `joins concurrent stop callers with ${budget === undefined ? `ordinary scheduler budget ${maxOps}` : `one scheduler yield at ${budget}`}`,
      () =>
        Effect.gen(function* () {
          yield* enable;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let stops = 0;
          let finalized = 0;
          const reactor = yield* makeProjectTeamExecutionReactor({
            start: Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              return {
                ready: Effect.void,
                sweep: Effect.void,
                stop: Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.sync(() => {
                      stops++;
                    }),
                  ),
                ),
              };
            }),
          });
          yield* reactor.ready;
          const parentId = yield* Effect.fiberId;
          const ordinary = new Scheduler.MixedScheduler("sync");
          let automatic = false;
          const makeScheduler = () => {
            const base = new Scheduler.MixedScheduler("sync", (task) =>
              automatic ? ordinary.setImmediate(task) : () => {},
            );
            const dispatcher = base.makeDispatcher();
            const yielded = new Set<number>();
            const scheduler: Scheduler.Scheduler = {
              executionMode: "sync",
              shouldYield: (fiber) => {
                if (fiber.id === parentId) return false;
                if (budget === undefined) return base.shouldYield(fiber);
                if (budget !== 0 && !yielded.has(fiber.id) && fiber.currentOpCount >= budget) {
                  yielded.add(fiber.id);
                  return true;
                }
                return false;
              },
              makeDispatcher: () => dispatcher,
            };
            return { scheduler, dispatcher };
          };
          const a = makeScheduler();
          const b = makeScheduler();
          // Detached test fibers expose the failing baseline; successful shutdown joins them all.
          const first = yield* Effect.forkDetach(reactor.stop, { startImmediately: true }).pipe(
            Effect.provideService(Scheduler.Scheduler, a.scheduler),
            Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOps),
          );
          const second = yield* Effect.forkDetach(reactor.stop, { startImmediately: true }).pipe(
            Effect.provideService(Scheduler.Scheduler, b.scheduler),
            Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOps),
          );
          yield* Effect.sync(() => a.dispatcher.flush());
          yield* Deferred.await(entered);
          const observer = yield* Effect.forkDetach(reactor.stop, { startImmediately: true }).pipe(
            Effect.provideService(Scheduler.Scheduler, {
              executionMode: "sync",
              shouldYield: () => false,
              makeDispatcher: () => ordinary.makeDispatcher(),
            }),
          );
          yield* Effect.sync(() => b.dispatcher.flush());
          automatic = true;
          yield* Deferred.succeed(release, undefined);
          yield* Effect.sync(() => {
            a.dispatcher.flush();
            b.dispatcher.flush();
          });
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(first)));
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(second)));
          yield* reactor.stop;
          const exit = yield* Effect.sync(() => observer.pollUnsafe());
          if (exit === undefined) yield* Effect.sync(() => observer.interruptUnsafe());
          assert.isDefined(exit);
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(observer)));
          assert.equal(stops, 1);
          assert.equal(finalized, 1);
        }).pipe(Effect.scoped, Effect.provide(services())),
    );
  }
  it.effect(
    "subscribes before the snapshot so concurrent settings and work commits survive startup",
    () =>
      Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const bus = yield* ProjectWorkEventBus;
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* control;
        const constructing = yield* Effect.forkChild(
          makeProjectTeamExecutionReactor({ start: owner.start }).pipe(
            Effect.provideService(Settings.ServerSettingsService, {
              ...settings,
              getSettings: settings.getSettings.pipe(
                Effect.tap(() => Deferred.succeed(reading, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
            }),
          ),
        );
        yield* Deferred.await(reading);
        yield* settings.updateSettings({
          projectWorkEnabled: true,
          projectTeamExecutionEnabled: true,
        });
        yield* bus.publish([readyEvent(1)]);
        yield* Deferred.succeed(release, undefined);
        const reactor = yield* Fiber.join(constructing);
        yield* reactor.observed(1);
        assert.equal(yield* Queue.take(owner.started), 1);
        assert.equal((yield* reactor.drain(1)).status, "ready");
        assert.equal(owner.counts().starts, 1);
        yield* reactor.stop;
        assert.equal(yield* Queue.take(owner.finalized), 1);
      }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("requires both settings and discovers work only after the recovery barrier", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({
        projectWorkEnabled: false,
        projectTeamExecutionEnabled: true,
      });
      const owner = yield* control;
      const recoveryEntered = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: owner.start.pipe(
          Effect.map((value) => ({
            ...value,
            ready: Deferred.succeed(recoveryEntered, undefined).pipe(
              Effect.andThen(Deferred.await(recovered)),
            ),
          })),
        ),
      });
      assert.equal((yield* reactor.ready).status, "disabled");
      assert.equal(owner.counts().starts, 0);
      yield* settings.updateSettings({
        projectWorkEnabled: true,
        projectTeamExecutionEnabled: false,
      });
      assert.equal((yield* reactor.drain()).status, "disabled");
      assert.equal(owner.counts().starts, 0);
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      yield* Deferred.await(recoveryEntered);
      assert.equal(owner.counts().count, 0);
      assert.equal((yield* reactor.observed(0)).status, "starting");
      yield* Deferred.succeed(recovered, undefined);
      assert.equal(yield* Queue.take(owner.sweeps), 1);
      const receipt = yield* reactor.drain();
      assert.equal(receipt.status, "ready");
      assert.equal(receipt.generation, 1);
      yield* reactor.stop;
      assert.equal(yield* Queue.take(owner.finalized), 1);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("coalesces committed events during one held sweep into one followup", () =>
    Effect.gen(function* () {
      yield* enable;
      const bus = yield* ProjectWorkEventBus;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* control;
      let pass = 0;
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: owner.start.pipe(
          Effect.map((value) => ({
            ...value,
            sweep: Effect.gen(function* () {
              pass++;
              if (pass === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              yield* value.sweep;
            }),
          })),
        ),
      });
      yield* Deferred.await(entered);
      yield* bus.publish(Array.from({ length: 100 }, (_, index) => readyEvent(index + 1)));
      // This quiet cursor receipt joins ingestion of every meaningful hint before release.
      yield* bus.publish([quietEvent(101)]);
      yield* reactor.observed(101);
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Queue.take(owner.sweeps), 1);
      assert.equal(yield* Queue.take(owner.sweeps), 2);
      yield* reactor.stop;
      assert.equal(pass, 2);
      assert.equal(owner.counts().maxInSweep, 1);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("joins stop and child finalizers before permitting a replacement generation", () =>
    Effect.gen(function* () {
      const settings = yield* enable;
      const stopEntered = yield* Deferred.make<void>();
      const stopRelease = yield* Deferred.make<void>();
      const sweepEntered = yield* Deferred.make<void>();
      const swept = yield* Deferred.make<void>();
      const finalizerEntered = yield* Deferred.make<void>();
      const finalizerRelease = yield* Deferred.make<void>();
      const owner = yield* control;
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: Effect.gen(function* () {
          const value = yield* owner.start;
          if (owner.counts().starts !== 1) return value;
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(finalizerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finalizerRelease)),
            ),
          );
          return {
            ...value,
            sweep: Deferred.succeed(sweepEntered, undefined).pipe(
              Effect.andThen(Deferred.await(swept)),
            ),
            stop: Deferred.succeed(stopEntered, undefined).pipe(
              Effect.andThen(Deferred.await(stopRelease)),
            ),
          };
        }),
      });
      yield* Deferred.await(sweepEntered);
      yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
      yield* Deferred.await(stopEntered);
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      assert.equal(owner.counts().starts, 1);
      yield* Deferred.succeed(stopRelease, undefined);
      yield* Deferred.await(finalizerEntered);
      assert.equal(owner.counts().starts, 1);
      yield* Deferred.succeed(finalizerRelease, undefined);
      assert.equal(yield* Queue.take(owner.started), 1);
      assert.equal(yield* Queue.take(owner.started), 2);
      const receipt = yield* reactor.drain();
      assert.equal(receipt.generation, 2);
      assert.equal(receipt.status, "ready");
      yield* reactor.stop;
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("failed or uncertain cleanup blocks replacement and remains visible to callers", () =>
    Effect.gen(function* () {
      const settings = yield* enable;
      const stopping = yield* Deferred.make<void>();
      const owner = yield* control;
      const reactorScope = yield* Scope.make();
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: owner.start.pipe(
          Effect.tap(() => Effect.addFinalizer(() => Effect.die("scope-close-failed"))),
          Effect.map((value) => ({
            ...value,
            stop: Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Effect.fail("uncertain-owner")),
            ),
          })),
        ),
      }).pipe(Scope.provide(reactorScope));
      yield* reactor.ready;
      yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
      yield* Deferred.await(stopping);
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      const result = yield* reactor.drain().pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.equal(owner.counts().starts, 1);
      if (Exit.isFailure(result)) {
        assert.include(Cause.pretty(result.cause), "uncertain-owner");
        assert.include(Cause.pretty(result.cause), "scope-close-failed");
      }
      assert.isTrue(Exit.isFailure(yield* reactor.stop.pipe(Effect.exit)));
      yield* Scope.close(reactorScope, Exit.void).pipe(Effect.exit);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("startup failure fails readiness, joins owners, and preserves cleanup failure", () =>
    Effect.gen(function* () {
      yield* enable;
      const owner = yield* control;
      const reactorScope = yield* Scope.make();
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: owner.start.pipe(
          Effect.map((value) => ({
            ...value,
            ready: Effect.fail("recovery-failed"),
            stop: Effect.fail("stop-failed"),
          })),
        ),
      }).pipe(Scope.provide(reactorScope));
      const result = yield* reactor.ready.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.equal(owner.counts().count, 0);
      assert.equal(yield* Queue.take(owner.finalized), 1);
      if (Exit.isFailure(result)) {
        assert.include(Cause.pretty(result.cause), "recovery-failed");
        assert.include(Cause.pretty(result.cause), "stop-failed");
      }
      yield* reactor.stop.pipe(Effect.exit);
      yield* Scope.close(reactorScope, Exit.void).pipe(Effect.exit);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect(
    "shutdown interrupts constructing owners and releases pending readiness and drains",
    () =>
      Effect.gen(function* () {
        yield* enable;
        const constructing = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const reactor = yield* makeProjectTeamExecutionReactor({
          start: Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(finalized, undefined).pipe(Effect.asVoid),
            );
            yield* Deferred.succeed(constructing, undefined);
            return yield* Effect.never;
          }),
        });
        yield* Deferred.await(constructing);
        const waitingReady = yield* Effect.forkChild(reactor.ready);
        const waitingDrain = yield* Effect.forkChild(reactor.drain());
        yield* reactor.stop;
        yield* Deferred.await(finalized);
        assert.equal((yield* Fiber.join(waitingReady)).status, "stopped");
        assert.equal((yield* Fiber.join(waitingDrain)).status, "stopped");
        assert.equal((yield* reactor.drain()).completedSweeps, 0);
      }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("interrupted constructor closes both acquired subscriptions before returning", () =>
    Effect.gen(function* () {
      yield* enable;
      const settings = yield* Settings.ServerSettingsService;
      const bus = yield* ProjectWorkEventBus;
      const reading = yield* Deferred.make<void>();
      const closed = yield* Queue.unbounded<string>();
      const owner = yield* control;
      const acquisition = yield* Effect.forkChild(
        makeProjectTeamExecutionReactor({ start: owner.start }).pipe(
          Effect.provideService(Settings.ServerSettingsService, {
            ...settings,
            getSettings: settings.getSettings.pipe(
              Effect.tap(() => Deferred.succeed(reading, undefined)),
              Effect.andThen(Effect.never),
            ),
            subscribeChanges: settings.subscribeChanges.pipe(
              Effect.tap(() =>
                Effect.addFinalizer(() => Queue.offer(closed, "settings").pipe(Effect.asVoid)),
              ),
            ),
          }),
          Effect.provideService(ProjectWorkEventBus, {
            ...bus,
            subscribe: bus.subscribe.pipe(
              Effect.tap(() =>
                Effect.addFinalizer(() => Queue.offer(closed, "work").pipe(Effect.asVoid)),
              ),
            ),
          }),
        ),
      );
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(acquisition);
      const result = yield* Fiber.await(acquisition);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterrupts(result.cause));
      assert.deepEqual([yield* Queue.take(closed), yield* Queue.take(closed)].sort(), [
        "settings",
        "work",
      ]);
      assert.equal(owner.counts().starts, 0);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect("an interrupted stop caller retains cleanup failures after joined settlement", () =>
    Effect.gen(function* () {
      yield* enable;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reactorScope = yield* Scope.make();
      const reactor = yield* makeProjectTeamExecutionReactor({
        start: Effect.succeed({
          ready: Effect.void,
          sweep: Effect.void,
          stop: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail("cleanup-failed")),
          ),
        }),
      }).pipe(Scope.provide(reactorScope));
      yield* reactor.ready;
      const caller = yield* Effect.forkChild(reactor.stop);
      yield* Deferred.await(entered);
      const interrupted = yield* Fiber.interrupt(caller).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupted);
      const result = yield* Fiber.await(caller);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        assert.isTrue(Cause.hasInterrupts(result.cause));
        assert.include(Cause.pretty(result.cause), "cleanup-failed");
      }
      yield* Scope.close(reactorScope, Exit.void).pipe(Effect.exit);
    }).pipe(Effect.scoped, Effect.provide(services())),
  );

  it.effect(
    "status and acknowledgment notifications do not create a scheduling feedback loop",
    () =>
      Effect.gen(function* () {
        yield* enable;
        const bus = yield* ProjectWorkEventBus;
        const owner = yield* control;
        let cursor = 0;
        const reactor = yield* makeProjectTeamExecutionReactor({
          start: owner.start.pipe(
            Effect.map((value) => ({
              ...value,
              sweep: value.sweep.pipe(
                Effect.andThen(Effect.suspend(() => bus.publish([acknowledgment(++cursor)]))),
              ),
            })),
          ),
        });
        yield* reactor.ready;
        const receipt = yield* reactor.drain(1);
        // The explicit drain performs the second pass; observing its quiet event adds none.
        const joined = yield* reactor.drain(2);
        yield* reactor.stop;
        assert.equal(receipt.completedSweeps, 2);
        assert.equal(joined.completedSweeps, 3);
        assert.equal(owner.counts().count, 3);
      }).pipe(Effect.scoped, Effect.provide(services())),
  );
});
