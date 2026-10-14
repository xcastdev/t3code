import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { inspectPiSubscriptionConfiguration } from "./PiSubscriptionConfiguration.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subscription-config-" });
  const input = {
    agentDirectory: directory,
    runtimeVersion: "0.99.1",
    nodeVersion: "22.19.0",
    selectedModel: { provider: "openai-codex", model: "gpt-6-luna" },
    limits: { maxInputTokens: 16_384, maxOutputTokens: 2_048, deadlineMs: 300_000 },
    reasoningEffort: "high",
    serviceTier: "default",
  };
  const write = (name: string, value: unknown) =>
    fs.writeFileString(path.join(directory, name), JSON.stringify(value));
  return { input, write };
});

it.effect("uses the installed Pi subscription model metadata without reading credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("auth.json", { "openai-codex": "not-a-credential" });
    const result = yield* inspectPiSubscriptionConfiguration(f.input);
    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
      api: "openai-codex-responses",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      contextWindow: 272_000,
      maxInputTokens: 16_384,
      maxOutputTokens: 2_048,
      advertisedMaxOutputTokens: 128_000,
      reasoning: true,
      reasoningEffort: "high",
      serviceTier: "default",
      catalogue: { source: "pi-sdk:0.99.1/openai-codex" },
    });
    expect(Object.isFrozen(result)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a subscription route, effort, tier or runtime change", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const change of [
      { selectedModel: { provider: "command-code", model: "gpt-6-luna" } },
      { selectedModel: { provider: "openai-codex", model: "gpt-6-other" } },
      { reasoningEffort: "low" },
      { serviceTier: "priority" },
      { runtimeVersion: "0.98.0" },
      { nodeVersion: "22.18.0" },
    ]) {
      const error = yield* Effect.flip(
        inspectPiSubscriptionConfiguration({ ...f.input, ...change }),
      );
      expect(error.reason).toBe("configuration");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a native subscription endpoint override instead of forwarding it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("models.json", {
      providers: {
        "openai-codex": { baseUrl: "https://example.com", api: "openai-codex-responses" },
      },
    });
    const error = yield* Effect.flip(inspectPiSubscriptionConfiguration(f.input));
    expect(error.reason).toBe("native-configuration");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
