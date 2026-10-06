import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ProjectWorkTaskId, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ServerSecrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as settingsLayer, ServerSettingsService } from "../serverSettings.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { makeProjectTeamExecutionWorker } from "./ProjectWorkRuntime.ts";

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>, enabled = true) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({
      projectWorkEnabled: true,
      projectTeamExecutionEnabled: enabled,
    });
    return yield* effect;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        ProjectWorkEventBusLive,
        settingsLayer.pipe(
          Layer.provide(ServerSecrets.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
          Layer.provideMerge(
            Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-worker-" })),
          ),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

// Real worker/reactor/settings/bus; this controlled owner acquires no native runtime.
const control = Effect.fn("executionWorkerTest.control")(function* (
  options: {
    readonly holdSweeps?: boolean;
    readonly holdStop?: boolean;
    readonly pages?: readonly boolean[];
  } = {},
) {
  const availability = yield* PubSub.sliding<ProviderInstanceId>(128);
  const entered = yield* Queue.unbounded<number>();
  const started = yield* Queue.unbounded<number>();
  const released = yield* Queue.unbounded<number>();
  const permits = yield* Queue.unbounded<boolean>();
  const stopping = yield* Queue.unbounded<number>();
  const stopPermit = yield* Deferred.make<void>();
  let starts = 0;
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let stops = 0;
  let finalized = 0;
  const start = Effect.gen(function* () {
    const generation = ++starts;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        finalized++;
        yield* Queue.offer(released, generation);
      }),
    );
    yield* Queue.offer(started, generation);
    return {
      sweep: () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            active++;
            maximumActive = Math.max(maximumActive, active);
          }),
          () =>
            Effect.gen(function* () {
              const call = ++calls;
              yield* Queue.offer(entered, call);
              const hasMore = options.holdSweeps
                ? yield* Queue.take(permits)
                : (options.pages?.[call - 1] ?? false);
              return { hasMore };
            }),
          () =>
            Effect.sync(() => {
              active--;
            }),
        ),
      stop: Effect.gen(function* () {
        stops++;
        yield* Queue.offer(stopping, generation);
        if (options.holdStop) yield* Deferred.await(stopPermit);
      }),
    };
  });
  return {
    entered,
    started,
    released,
    permits,
    stopping,
    stopPermit,
    availability,
    make: (ready: Effect.Effect<void> = Effect.void) =>
      makeProjectTeamExecutionWorker(start, ready).pipe(
        Effect.provide(
          Layer.mock(ProjectTeamPiRuntime)({
            subscribeChanges: PubSub.subscribe(availability).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
      ),
    counts: () => ({ starts, calls, active, maximumActive, stops, finalized }),
  };
});

it.effect("retains an availability wake while startup readiness is held", () =>
  scoped(
    Effect.gen(function* () {
      const c = yield* control();
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const worker = yield* c.make(
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      yield* Deferred.await(waiting);
      expect(c.counts().starts).toBe(0);
      yield* PubSub.publish(c.availability, ProviderInstanceId.make("pi-instance"));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Queue.take(c.entered)).toBe(1);
      expect(yield* Queue.take(c.entered)).toBe(2);
      yield* worker.stop;
      expect(c.counts()).toMatchObject({ starts: 1, active: 0, stops: 1, finalized: 1 });
    }),
  ),
);

it.effect("finishes all remaining work pages before publishing its startup receipt", () =>
  scoped(
    Effect.gen(function* () {
      const c = yield* control({ pages: [true, true, false] });
      const worker = yield* c.make();
      expect((yield* worker.ready).status).toBe("ready");
      expect(c.counts()).toMatchObject({ starts: 1, calls: 3, active: 0, maximumActive: 1 });
      yield* worker.stop;
    }),
  ),
);

it.effect(
  "coalesces committed work received during a held sweep into one serial continuation",
  () =>
    scoped(
      Effect.gen(function* () {
        const c = yield* control({ holdSweeps: true });
        const bus = yield* ProjectWorkEventBus;
        const worker = yield* c.make();
        expect(yield* Queue.take(c.entered)).toBe(1);
        yield* bus.publish(
          Array.from({ length: 16 }, (_, index) => ({
            cursor: index + 1,
            event: {
              type: "project-work.task.ready" as const,
              eventId: EventId.make(`ready-${index + 1}`),
              projectId: ProjectId.make("project"),
              taskId: ProjectWorkTaskId.make("task"),
              revision: index + 1,
              occurredAt: "2026-10-06T00:00:00.000Z",
            },
          })),
        );
        yield* worker.observed(16);
        const drained = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Queue.offer(c.permits, false);
        expect(yield* Queue.take(c.entered)).toBe(2);
        yield* Queue.offer(c.permits, false);
        expect((yield* Fiber.join(drained)).observedCursor).toBe(16);
        expect(c.counts()).toMatchObject({ calls: 2, active: 0, maximumActive: 1 });
        yield* worker.stop;
      }),
    ),
);

it.effect("disabled startup stays idle and re-enable gets a new joined owner generation", () =>
  scoped(
    Effect.gen(function* () {
      const c = yield* control();
      const settings = yield* ServerSettingsService;
      const worker = yield* c.make();
      expect((yield* worker.ready).status).toBe("disabled");
      expect(c.counts()).toMatchObject({ starts: 0, calls: 0 });
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      expect(yield* Queue.take(c.started)).toBe(1);
      expect((yield* worker.drain()).status).toBe("ready");
      expect(c.counts()).toMatchObject({ starts: 1, stops: 0 });
      yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
      expect(yield* Queue.take(c.stopping)).toBe(1);
      expect(yield* Queue.take(c.released)).toBe(1);
      expect((yield* worker.drain()).status).toBe("disabled");
      expect(c.counts()).toMatchObject({ active: 0, stops: 1, finalized: 1 });
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      expect(yield* Queue.take(c.started)).toBe(2);
      expect((yield* worker.drain()).status).toBe("ready");
      expect(c.counts()).toMatchObject({ starts: 2, maximumActive: 1 });
      yield* worker.stop;
      expect(c.counts()).toMatchObject({ active: 0, stops: 2, finalized: 2 });
    }),
    false,
  ),
);

it.effect(
  "shutdown waits for owner cleanup and interrupts the paused sweep before releasing its scope",
  () =>
    scoped(
      Effect.gen(function* () {
        const c = yield* control({ holdSweeps: true, holdStop: true });
        const worker = yield* c.make();
        expect(yield* Queue.take(c.entered)).toBe(1);
        let closed = false;
        const closing = yield* worker.stop.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(c.stopping)).toBe(1);
        expect(closed).toBe(false);
        yield* Deferred.succeed(c.stopPermit, undefined);
        yield* Fiber.join(closing);
        expect(closed).toBe(true);
        expect(c.counts()).toMatchObject({ active: 0, stops: 1, finalized: 1 });
      }),
    ),
);
