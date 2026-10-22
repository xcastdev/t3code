import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makePiTextGeneration } from "./textGeneration.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakePi = (
  reply: string,
  setModelError?: string,
  thinking?: { readonly error?: string; readonly beforeAck?: Effect.Effect<void> },
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const thinkingRequested = yield* Deferred.make<void>();
    const received: Array<Record<string, unknown>> = [];
    const emit = (record: Record<string, unknown>) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
    let buffered = "";
    const onStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        buffered += new TextDecoder().decode(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const record = decodeJsonLine(line) as Record<string, unknown>;
          received.push(record);
          const response = { type: "response", id: record["id"], command: record["type"] };
          if (record["type"] === "prompt") {
            yield* emit({ ...response, success: true });
            yield* emit({ type: "agent_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "set_thinking_level") {
            yield* Deferred.succeed(thinkingRequested, undefined);
            if (thinking?.beforeAck) yield* thinking.beforeAck;
            yield* emit(
              thinking?.error !== undefined
                ? { ...response, success: false, error: thinking.error }
                : { ...response, success: true },
            );
          } else if (record["type"] === "set_model" && setModelError !== undefined) {
            yield* emit({ ...response, success: false, error: setModelError });
          } else {
            yield* emit({ ...response, success: true });
          }
        }
      });
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          // Outside the valid pid range, so PiRpc's process-group kill never lands.
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return { spawner, received, thinkingRequested };
  });

it.effect("names the model and the disabled extensions when Pi cannot load it", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", "Model not found: demo/demo-model");
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model"),
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Pi rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.include(error.detail, "--no-extensions");
    assert.isUndefined(pi.received.find((record) => record["type"] === "prompt"));
  }),
);

it.effect("extracts facts through the configured native Pi model", () =>
  Effect.gen(function* () {
    const facts = [
      { key: "storage", body: "SQLite is authoritative.", quote: "SQLite is authoritative." },
    ];
    const pi = yield* makeFakePi(encodeJsonLine({ facts }));
    const service = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "configured-pi", launchArgs: "", customModels: [] },
      { PI_AUTH_TOKEN: "private-native-token" },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    const result = yield* service.extractMemoryFacts({
      cwd: "/tmp/project",
      sourceText: "SQLite is authoritative.",
      modelSelection: createModelSelection(ProviderInstanceId.make("second-pi"), "demo/demo-model"),
    });
    assert.deepEqual(result, { facts });
    assert.deepEqual(
      pi.received.find((record) => record["type"] === "set_model"),
      { id: "t3-0", type: "set_model", provider: "demo", modelId: "demo-model" },
    );
    assert.notInclude(encodeJsonLine(pi.received), "private-native-token");
  }).pipe(Effect.scoped),
);

it.effect.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "applies selected Pi thinking %s before extracting facts",
  (thinking) =>
    Effect.gen(function* () {
      const pi = yield* makeFakePi('{"facts":[]}');
      const service = yield* makePiTextGeneration(
        { enabled: true, binaryPath: "configured-pi", launchArgs: "", customModels: [] },
        { PI_AUTH_TOKEN: "private-native-token" },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
      const result = yield* service.extractMemoryFacts({
        cwd: "/tmp/project",
        sourceText: "SQLite is authoritative.",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("selected-pi"),
          "demo/demo-model",
          [{ id: "thinking", value: thinking }],
        ),
      });
      assert.deepEqual(result, { facts: [] });
      assert.deepEqual(
        pi.received.map((request) => request["type"]),
        ["set_model", "set_thinking_level", "prompt", "get_last_assistant_text"],
      );
      assert.equal(pi.received[1]?.["level"], thinking);
    }).pipe(Effect.scoped),
);

it.effect("waits for the native thinking acknowledgement before prompting", () =>
  Effect.gen(function* () {
    const acknowledge = yield* Deferred.make<void>();
    const pi = yield* makeFakePi('{"facts":[]}', undefined, {
      beforeAck: Deferred.await(acknowledge),
    });
    const service = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    const fiber = yield* service
      .extractMemoryFacts({
        cwd: "/tmp/project",
        sourceText: "SQLite is authoritative.",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("selected-pi"),
          "demo/demo-model",
          [{ id: "thinking", value: "off" }],
        ),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(pi.thinkingRequested);
    assert.deepEqual(
      pi.received.map((request) => request["type"]),
      ["set_model", "set_thinking_level"],
    );
    yield* Deferred.succeed(acknowledge, undefined);
    assert.deepEqual(yield* Fiber.join(fiber), { facts: [] });
  }).pipe(Effect.scoped),
);

it.effect("fails extraction without prompting when native Pi refuses thinking", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi('{"facts":[]}', undefined, {
      error: "Unsupported thinking level for model; private-token",
    });
    const service = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    const error = yield* service
      .extractMemoryFacts({
        cwd: "/tmp/project",
        sourceText: "SQLite is authoritative.",
        modelSelection: createModelSelection(ProviderInstanceId.make("selected-pi"), "default", [
          { id: "thinking", value: "xhigh" },
        ]),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "TextGenerationError");
    assert.equal(error.operation, "extractMemoryFacts");
    assert.deepEqual(
      pi.received.map((request) => request["type"]),
      ["set_thinking_level"],
    );
    assert.notInclude(encodeJsonLine(error), "private-token");
  }).pipe(Effect.scoped),
);

it.effect.each(["unsupported", true])(
  "rejects invalid thinking selection %s rather than ignoring it",
  (thinking) =>
    Effect.gen(function* () {
      const pi = yield* makeFakePi('{"facts":[]}');
      const service = yield* makePiTextGeneration(
        { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        {},
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
      const error = yield* service
        .extractMemoryFacts({
          cwd: "/tmp/project",
          sourceText: "SQLite is authoritative.",
          modelSelection: createModelSelection(ProviderInstanceId.make("selected-pi"), "default", [
            { id: "thinking", value: thinking },
          ]),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "TextGenerationError");
      assert.deepEqual(pi.received, []);
    }).pipe(Effect.scoped),
);
