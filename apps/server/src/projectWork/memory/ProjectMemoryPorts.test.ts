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
  decodeProjectMemoryProcessingConfiguration,
  type ProjectMemoryModelExchange,
} from "./ProjectMemoryPorts.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
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

it.effect("confirms rejected HTTP response drain before abort can error its body", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          init?.signal?.addEventListener("abort", () => {
            events.push("abort");
            controller.error(new Error("Controlled transport abort"));
          });
        },
        cancel: () => {
          events.push("cancel");
        },
      });
      return new Response(body, { status: 504 });
    });
    const result = yield* exchangeProjectMemoryModel(
      request((yield* Clock.currentTimeMillis) + 1000),
      () => events.push("drain"),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "Memory model outcome requires conservative accounting" },
    });
    expect(events).toEqual(["cancel", "abort", "drain"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);

for (const status of [200, 504])
  it.effect(`cleans up HTTP ${status} cancellation failure without confirming drain`, () =>
    Effect.gen(function* () {
      let transportSignal: AbortSignal | null | undefined;
      let body: ReadableStream<Uint8Array> | undefined;
      let drains = 0;
      const events: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        transportSignal = init?.signal;
        transportSignal?.addEventListener("abort", () => events.push("abort"));
        body = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array(1048577)),
          cancel: () => {
            events.push("cancel");
            return Promise.reject(new Error("Controlled cancellation failure"));
          },
        });
        return new Response(body, { status });
      });
      const remove = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(AbortSignal.prototype, "removeEventListener")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* exchangeProjectMemoryModel(
        request((yield* Clock.currentTimeMillis) + 1000),
        () => drains++,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "Memory model outcome requires conservative accounting" },
      });
      expect(events).toEqual(["cancel", "abort"]);
      expect(transportSignal?.aborted).toBe(true);
      expect(body?.locked).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(drains).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped),
  );

for (const outcome of ["rejected fetch", "no body"])
  it.effect(`confirms settled ${outcome} cleanup while preserving conservative failure`, () =>
    Effect.gen(function* () {
      let transportSignal: AbortSignal | null | undefined;
      let drains = 0;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        transportSignal = init?.signal;
        if (outcome === "rejected fetch") throw new Error("Controlled fetch rejection");
        return new Response(null, { status: 204 });
      });
      const result = yield* exchangeProjectMemoryModel(
        request((yield* Clock.currentTimeMillis) + 1000),
        () => {
          expect(transportSignal?.aborted).toBe(true);
          drains++;
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "Memory model outcome requires conservative accounting" },
      });
      expect(drains).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

it.effect(
  "interrupts an active read through the transport signal and confirms completed cleanup",
  () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const events: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            init?.signal?.addEventListener("abort", () => {
              events.push("abort");
              controller.close();
            });
          },
          pull: () => {
            Deferred.doneUnsafe(reading, Effect.void);
          },
        });
        return new Response(body);
      });
      const fiber = yield* exchangeProjectMemoryModel(
        request((yield* Clock.currentTimeMillis) + 1000),
        () => {
          events.push("drain");
          Deferred.doneUnsafe(drained, Effect.void);
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.forkChild);
      yield* Deferred.await(reading);
      expect(events).toEqual([]);
      yield* Fiber.interrupt(fiber);
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
      yield* Deferred.await(drained);
      expect(events).toEqual(["abort", "drain"]);
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
);

it.effect("does not confirm drain when interruption errors an active response body", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    let transportSignal: AbortSignal | null | undefined;
    let body: ReadableStream<Uint8Array> | undefined;
    let drains = 0;
    const removeListener = AbortSignal.prototype.removeEventListener;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (
          this: AbortSignal,
          ...args
        ) {
          removeListener.call(this, ...args);
          if (transportSignal?.aborted && body?.locked === false)
            Deferred.doneUnsafe(cleaned, Effect.void);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      transportSignal = init?.signal;
      body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          transportSignal?.addEventListener("abort", () =>
            controller.error(new Error("Controlled active read abort")),
          );
        },
        pull: () => {
          Deferred.doneUnsafe(reading, Effect.void);
        },
      });
      return new Response(body);
    });
    const fiber = yield* exchangeProjectMemoryModel(
      request((yield* Clock.currentTimeMillis) + 1000),
      () => drains++,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.forkChild);
    yield* Deferred.await(reading);
    yield* Fiber.interrupt(fiber);
    expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
    yield* Deferred.await(cleaned);
    expect(drains).toBe(0);
    expect(body?.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

for (const liquid of [false, true])
  it.effect(
    `observes ${liquid ? "Liquid" : "CommandCode"} memory transport drain only after delayed cancellation completes`,
    () =>
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
        const fiber = yield* exchangeProjectMemoryModel(
          liquid ? liquidRequest(deadline) : request(deadline),
          () => {
            observedDrain = true;
            Deferred.doneUnsafe(drained, Effect.void);
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, spy), Effect.forkChild);
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

const liquidModel = "liquid/lfm-2.5-2.6b:free";
const liquidRequest = (deadline: number) => ({
  ...request(deadline),
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: liquidModel,
  maximumInputTokens: 4096,
});
const liquidResponse = (content = '{"facts":[]}') => ({
  model: liquidModel,
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, cost: 0 },
});

it.effect("selects only explicit fixed extraction endpoints with Liquid endpoint ceilings", () =>
  Effect.gen(function* () {
    const config = {
      version: 1,
      extraction: {
        routeId: "liquid",
        credentialRef: "private-ref",
        endpoint: liquidRequest(1).endpoint,
        maximumInputTokens: 16384,
        maximumOutputTokens: 2048,
      },
      embedding: {
        routeId: "embed",
        credentialRef: "private-ref",
        endpoint: "https://openrouter.ai/api/v1/embeddings",
        maximumInputTokens: 8192,
        maximumOutputTokens: 1,
      },
      companion: {
        executable: "/python",
        scriptTarget: "/mem0.py",
        storeRoot: "/memory",
        memoryBytes: 16777216,
        runtimeFiles: [{ source: "/source", target: "/python" }],
      },
    };
    expect((yield* decodeProjectMemoryProcessingConfiguration(json(config))).extraction).toEqual(
      config.extraction,
    );
    expect(
      (yield* decodeProjectMemoryProcessingConfiguration(
        json({ ...config, extraction: { ...config.extraction, endpoint: request(1).endpoint } }),
      )).extraction.endpoint,
    ).toBe(request(1).endpoint);
    for (const extraction of [
      { ...config.extraction, endpoint: "https://arbitrary.invalid" },
      { ...config.extraction, endpoint: config.embedding.endpoint },
      { ...config.extraction, model: liquidModel },
      { ...config.extraction, maximumOutputTokens: 8193 },
      { ...config.extraction, maximumInputTokens: 65000 },
    ])
      expect(
        (yield* decodeProjectMemoryProcessingConfiguration(json({ ...config, extraction })).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
  }),
);

it.effect("Liquid sends one strict zero-price request and unwraps valid or empty facts", () =>
  Effect.gen(function* () {
    const facts = [{ key: "source", body: "Retained source", quote: "exact source" }];
    const spy = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(globalThis, "fetch")),
      (mock) => Effect.sync(() => mock.mockRestore()),
    );
    for (const expected of [facts, []]) {
      spy.mockResolvedValueOnce(new Response(json(liquidResponse(json({ facts: expected })))));
      const result = yield* exchangeProjectMemoryModel(
        liquidRequest((yield* Clock.currentTimeMillis) + 1000),
        () => {},
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, spy));
      expect(result).toEqual({
        value: expected,
        reportedModel: liquidModel,
        inputTokens: 30,
        outputTokens: 5,
      });
    }
    expect(spy).toHaveBeenCalledTimes(2);
    const sent = yield* decodeJson(String(spy.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({
      model: liquidModel,
      stream: false,
      max_tokens: 64,
      provider: {
        only: ["liquid/fp8"],
        order: ["liquid/fp8"],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "allow",
        max_price: { prompt: 0, completion: 0, request: 0 },
      },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "project_memory_facts",
          strict: true,
          schema: {
            additionalProperties: false,
            required: ["facts"],
            properties: {
              facts: {
                maxItems: 32,
                items: { additionalProperties: false, required: ["key", "body", "quote"] },
              },
            },
          },
        },
      },
    });
    expect(sent).not.toHaveProperty("models");
    expect(sent).not.toHaveProperty("plugins");
  }).pipe(Effect.scoped),
);

for (const content of [
  "[]",
  "{}",
  '{"facts":[],"extra":1}',
  '```json\n{"facts":[]}\n```',
  '{"facts":[{"key":"x","body":"x","quote":"x","extra":1}]}',
  '{"facts":[],"facts":[]}',
  '{"f\\u0061cts":[],"facts":[]}',
  '{"facts":[{"key":"x","key":"y","body":"x","quote":"x"}]}',
  '{"facts":[{"key":"x","body":3,"quote":"x"}]}',
  '{"facts":null}',
  '{"facts":[]',
  '{"facts":[{"key":" x","body":"x","quote":"x"}]}',
])
  it.effect(`Liquid rejects malformed facts ${content}`, () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(json(liquidResponse(content))));
      expect(
        (yield* exchangeProjectMemoryModel(
          liquidRequest((yield* Clock.currentTimeMillis) + 1000),
          () => {},
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result))._tag,
      ).toBe("Failure");
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

for (const [label, response] of [
  ["unsuffixed alias", { ...liquidResponse(), model: "liquid/lfm-2.5-2.6b" }],
  ["wrong model", { ...liquidResponse(), model: request(1).model }],
  [
    "missing cost",
    { ...liquidResponse(), usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } },
  ],
  ["nonzero cost", { ...liquidResponse(), usage: { ...liquidResponse().usage, cost: 0.001 } }],
  [
    "inconsistent usage",
    { ...liquidResponse(), usage: { ...liquidResponse().usage, total_tokens: 36 } },
  ],
  [
    "negative usage",
    { ...liquidResponse(), usage: { ...liquidResponse().usage, prompt_tokens: -1 } },
  ],
  [
    "fractional usage",
    { ...liquidResponse(), usage: { ...liquidResponse().usage, prompt_tokens: 1.5 } },
  ],
  [
    "unsafe usage",
    {
      ...liquidResponse(),
      usage: { ...liquidResponse().usage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
    },
  ],
  [
    "excess output",
    {
      ...liquidResponse(),
      usage: { prompt_tokens: 30, completion_tokens: 65, total_tokens: 95, cost: 0 },
    },
  ],
  [
    "excess input",
    {
      ...liquidResponse(),
      usage: { prompt_tokens: 4097, completion_tokens: 5, total_tokens: 4102, cost: 0 },
    },
  ],
  ["missing usage", { model: liquidModel, choices: liquidResponse().choices }],
  [
    "multiple choices",
    { ...liquidResponse(), choices: [...liquidResponse().choices, ...liquidResponse().choices] },
  ],
  [
    "truncated finish",
    {
      ...liquidResponse(),
      choices: [{ finish_reason: "length", message: { content: '{"facts":[]}' } }],
    },
  ],
  [
    "refusal",
    {
      ...liquidResponse(),
      choices: [{ finish_reason: "stop", message: { content: '{"facts":[]}', refusal: "No" } }],
    },
  ],
] as const)
  it.effect(`Liquid rejects ${label} without fallback`, () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(json(response)));
      expect(
        (yield* exchangeProjectMemoryModel(
          liquidRequest((yield* Clock.currentTimeMillis) + 1000),
          () => {},
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result))._tag,
      ).toBe("Failure");
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

it.effect(
  "Liquid rejects unconfigured identities, credentials, schema overhead and endpoint limits before fetch",
  () =>
    Effect.gen(function* () {
      const base = liquidRequest((yield* Clock.currentTimeMillis) + 1000);
      const fetch = vi.fn<typeof globalThis.fetch>();
      for (const invalid of [
        { ...base, model: "liquid/lfm-2.5-2.6b" },
        { ...base, endpoint: request(1).endpoint },
        { ...base, endpoint: "https://arbitrary.invalid" },
        { ...base, credential: "" },
        { ...base, credential: "bad\r\nkey" },
        { ...base, maximumOutputTokens: 8193 },
        { ...base, maximumInputTokens: 65500 },
        { ...base, maximumInputTokens: 1024 },
        { ...base, deadlineAtMs: base.deadlineAtMs + 300001 },
      ])
        expect(
          (yield* exchangeProjectMemoryModel(invalid, () => {}).pipe(
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      expect(fetch).not.toHaveBeenCalled();
    }),
);
