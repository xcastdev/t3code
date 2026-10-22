import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Processing from "../projectWork/memory/ProjectMemoryProcessing.ts";
import { ProjectMemoryError } from "../projectWork/memory/ProjectMemoryRepository.ts";
import * as Memory from "./AssistantMemory.ts";
import * as Activity from "./AssistantMemoryActivity.ts";
import * as Sources from "./AssistantMemorySources.ts";
import * as Runtime from "./AssistantMemoryRuntime.ts";

const worker = (ports: {
  recover: Memory.AssistantMemory["Service"]["recover"];
  reconcile: Processing.ProjectMemoryProcessing["Service"]["reconcile"];
  cleanup: Processing.ProjectMemoryProcessing["Service"]["cleanup"];
  activity: Activity.AssistantMemoryActivity["Service"];
}) =>
  Runtime.workerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Events.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.never,
        }),
        Layer.mock(Memory.AssistantMemory)({ recover: ports.recover }),
        Layer.mock(Processing.ProjectMemoryProcessing)({
          reconcile: ports.reconcile,
          cleanup: ports.cleanup,
        }),
        Layer.mock(Sources.AssistantSettledMemorySource)({ forRun: () => Effect.succeed(null) }),
        Layer.succeed(Activity.AssistantMemoryActivity, ports.activity),
      ),
    ),
  );

it.effect.each(["startup-recovery", "activity-reconcile", "activity-cleanup"] as const)(
  "closing the worker scope during %s cancels in-flight work without starting another operation",
  (stage) =>
    Effect.gen(function* () {
      const recoveryStarted = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const cleanupInterrupted = yield* Deferred.make<void>();
      const afterCancellation = yield* Deferred.make<void>();
      const releaseUnexpected = yield* Deferred.make<void>();
      const wakes = yield* Queue.unbounded<void>();
      const calls: Array<string> = [];
      let closing = false;
      const activity = Activity.AssistantMemoryActivity.of({
        wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
        subscribe: Effect.succeed(Stream.fromQueue(wakes)),
      });
      const unexpected = Effect.fn("AssistantMemoryCancellation.unexpected")(function* (
        operation: string,
      ) {
        calls.push(`${operation}:after-cancellation`);
        yield* Deferred.succeed(afterCancellation, undefined);
        yield* Deferred.await(releaseUnexpected);
        return [];
      });
      const layer = worker({
        activity,
        recover: Effect.fn("AssistantMemoryCancellation.recover")(function* () {
          calls.push("recover");
          yield* Deferred.succeed(recoveryStarted, undefined);
          return yield* Effect.never;
        }),
        reconcile: Effect.fn("AssistantMemoryCancellation.reconcile")(function* () {
          if (closing) return yield* unexpected("reconcile");
          calls.push("reconcile");
          if (stage === "activity-reconcile") {
            yield* Deferred.succeed(blocked, undefined);
            return yield* Effect.never;
          }
          return [];
        }),
        cleanup: Effect.fn("AssistantMemoryCancellation.cleanup")(function* () {
          if (closing) return yield* unexpected("cleanup");
          calls.push("cleanup");
          if (stage === "activity-cleanup") {
            yield* Deferred.succeed(blocked, undefined);
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanupInterrupted, undefined).pipe(Effect.asVoid),
              ),
            );
          }
          return [];
        }),
      });
      const parent = yield* Effect.never.pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(recoveryStarted);
      if (stage !== "startup-recovery") {
        yield* activity.wake;
        yield* Deferred.await(blocked);
      }
      const before = [...calls];
      closing = true;
      const shutdown = yield* Fiber.interrupt(parent).pipe(Effect.forkChild);
      if (stage === "activity-cleanup") yield* Deferred.await(cleanupInterrupted);
      const result = yield* Effect.raceFirst(
        Fiber.join(shutdown).pipe(Effect.as("closed")),
        Deferred.await(afterCancellation).pipe(Effect.as("new-work")),
      );
      yield* Deferred.succeed(releaseUnexpected, undefined);
      yield* Fiber.join(shutdown);
      assert.equal(result, "closed");
      assert.deepStrictEqual(calls, before);
    }),
);

it.effect.each(["recovery", "reconcile"] as const)(
  "a typed %s failure still reaches ordinary interruptible cleanup",
  (failure) =>
    Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const calls: Array<string> = [];
      let cleanups = 0;
      const layer = worker({
        activity: { wake: Effect.void, subscribe: Effect.succeed(Stream.never) },
        recover: Effect.fn("AssistantMemoryCancellation.typedRecover")(function* () {
          calls.push("recover");
          if (failure === "recovery")
            return yield* new ProjectMemoryError({ reason: "unavailable" });
          return null;
        }),
        reconcile: Effect.fn("AssistantMemoryCancellation.typedReconcile")(function* () {
          calls.push("reconcile");
          if (failure === "reconcile")
            return yield* new Processing.MemoryProcessingError({ reason: "unavailable" });
          return [];
        }),
        cleanup: Effect.fn("AssistantMemoryCancellation.typedCleanup")(function* () {
          calls.push("cleanup");
          cleanups += 1;
          if (cleanups === 2) yield* Deferred.succeed(drained, undefined);
          return [];
        }),
      });
      yield* Deferred.await(drained).pipe(Effect.provide(layer));
      assert.deepStrictEqual(calls, ["recover", "cleanup", "reconcile", "cleanup"]);
    }),
);
