import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  exchangeProjectMemoryModel,
  type ProjectMemoryModelExchange,
} from "./ProjectMemoryPorts.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const request = (deadlineAtMs: number): ProjectMemoryModelExchange => ({
  phase: "extract",
  endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
  model: "inclusionai/ling-3.1-flash:free",
  credential: "controlled-private-key",
  maximumInputTokens: 1024,
  maximumOutputTokens: 64,
  deadlineAtMs,
  input: "A retained exact source.",
});

it.effect("observes memory transport drain only after delayed cancellation completes", () =>
  Effect.gen(function* () {
    const cancelEntered = yield* Deferred.make<void>();
    const drained = yield* Deferred.make<void>();
    const releaseCancel = Promise.withResolvers<void>();
    let observedDrain = false;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(1048577)),
      cancel: () => {
        Deferred.doneUnsafe(cancelEntered, Effect.void);
        return releaseCancel.promise;
      },
    });
    const spy = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body))),
      (mock) =>
        Effect.sync(() => {
          releaseCancel.resolve();
          mock.mockRestore();
        }),
    );
    const deadline = (yield* Clock.currentTimeMillis) + 1000;
    const fiber = yield* exchangeProjectMemoryModel(request(deadline), () => {
      observedDrain = true;
      Deferred.doneUnsafe(drained, Effect.void);
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, spy), Effect.forkChild);
    yield* Deferred.await(cancelEntered);
    yield* Fiber.interrupt(fiber);
    const interrupted = yield* Fiber.await(fiber);
    expect(interrupted._tag).toBe("Failure");
    expect(observedDrain).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    releaseCancel.resolve();
    yield* Deferred.await(drained);
    expect(observedDrain).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("keeps failed cancellation unproved and accepts a completed bounded model response", () =>
  Effect.gen(function* () {
    let observedDrain = false;
    const rejectedBody = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(1048577)),
      cancel: () => Promise.reject(new Error("Controlled cancellation failure")),
    });
    const spy = yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rejectedBody)),
      ),
      (mock) => Effect.sync(() => mock.mockRestore()),
    );
    const deadline = (yield* Clock.currentTimeMillis) + 1000;
    const rejected = yield* exchangeProjectMemoryModel(request(deadline), () => {
      observedDrain = true;
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, spy), Effect.result);
    expect(rejected._tag).toBe("Failure");
    expect(observedDrain).toBe(false);
    spy.mockResolvedValueOnce(
      new Response(
        json({
          model: "inclusionai/ling-3.1-flash",
          choices: [{ message: { content: "[]" } }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        }),
      ),
    );
    const completed = yield* exchangeProjectMemoryModel(request(deadline), () => {
      observedDrain = true;
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, spy));
    expect(completed).toEqual({
      value: [],
      reportedModel: "inclusionai/ling-3.1-flash",
      inputTokens: 7,
      outputTokens: 2,
    });
    expect(observedDrain).toBe(true);
    const wrongProvider = yield* exchangeProjectMemoryModel(
      { ...request(deadline), endpoint: "https://unconfigured.invalid" },
      () => {
        observedDrain = true;
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, spy), Effect.result);
    expect(wrongProvider._tag).toBe("Failure");
    expect(spy).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);
