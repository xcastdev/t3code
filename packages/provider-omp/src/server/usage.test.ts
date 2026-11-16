import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Host from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { readOmpUsage, ompUsageFormat } from "./usage.ts";
const decodeOmpScanState = Schema.decodeUnknownEffect(ompUsageFormat.state.schema);
it("counts native assistant usage once and keeps auxiliary model_usage separate", () => {
  const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: { total: 0.1 } };
  const rows = [
    { id: "a", type: "message", message: { role: "assistant", model: "m", provider: "p", usage } },
    { id: "a", type: "message", message: { role: "assistant", usage } },
    { id: "b", type: "model_usage", purpose: "title", model: "tiny", usage },
  ];
  expect(readOmpUsage(rows)).toEqual({
    main: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: 0.1 },
    auxiliary: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: 0.1 },
  });
});

it("reads native JSONL main and auxiliary sources with fork-stable deduplication", async () => {
  const { ompUsageFormat } = await import("./usage.ts");
  const state = { sessionId: "" };
  expect(ompUsageFormat.parseLine('{"type":"session","id":"s"}', state)).toEqual([]);
  const record = {
    type: "message",
    id: "a",
    timestamp: "2026-11-04T00:00:00Z",
    message: {
      role: "assistant",
      provider: "p",
      model: "m",
      usage: { input: 10, cacheRead: 20, cacheWrite: 3, output: 4, cost: { total: 0.5 } },
    },
  };
  const first = ompUsageFormat.parseLine(JSON.stringify(record), state)[0];
  expect(first).toMatchObject({
    provider: "omp",
    sessionId: "s",
    model: "m",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 3,
      outputTokens: 4,
    },
    reportedCostUsd: 0.5,
  });
  const fork = ompUsageFormat.parseLine(JSON.stringify(record), { sessionId: "fork" })[0];
  expect(fork?.dedupeKey).toBe(first?.dedupeKey);
  expect(
    ompUsageFormat.parseLine(
      JSON.stringify({
        type: "model_usage",
        id: "b",
        timestamp: record.timestamp,
        purpose: "title",
        provider: "p",
        model: "tiny",
        usage: record.message.usage,
      }),
      state,
    )[0],
  ).toMatchObject({ model: "tiny", auxiliary: true });
});

it("resolves native profiles, agent-dir and migrated XDG session roots while owned session-dir stays authoritative", async () => {
  const { resolveOmpUsageDirectory } = await import("./usage.ts");
  const base = {
    platform: "linux",
    home: "/home/fixture",
    environment: {},
    launchArgs: "",
    exists: () => false,
  };
  expect(
    resolveOmpUsageDirectory({
      ...base,
      launchArgs: "--profile=work",
      environment: { PI_CODING_AGENT_DIR: "/ambient" },
    }),
  ).toBe("/home/fixture/.omp/profiles/work/agent/sessions");
  expect(
    resolveOmpUsageDirectory({ ...base, launchArgs: "--profile=work --agent-dir=/configured" }),
  ).toBe("/configured/sessions");
  expect(
    resolveOmpUsageDirectory({ ...base, environment: { OMP_PROFILE: "", PI_PROFILE: "work" } }),
  ).toBe("/home/fixture/.omp/agent/sessions");
  expect(
    resolveOmpUsageDirectory({
      ...base,
      launchArgs: "--profile=work",
      environment: { XDG_DATA_HOME: "/data" },
      exists: (p) => p === "/data/omp/profiles/work",
    }),
  ).toBe("/data/omp/profiles/work/sessions");
  expect(
    resolveOmpUsageDirectory({ ...base, launchArgs: "--profile=work", sessionDir: "/owned" }),
  ).toBe("/owned");
});
it("normalizes native context independently of cumulative main and auxiliary usage", async () => {
  const { ompTokenUsage } = await import("./usage.ts");
  expect(
    ompTokenUsage(
      { contextUsage: { tokens: 512, contextWindow: 8192 } },
      { tokens: { input: 100, cacheRead: 200, output: 12 } },
      "now",
    ),
  ).toEqual({
    usedTokens: 512,
    maxTokens: 8192,
    inputTokens: 100,
    cachedInputTokens: 200,
    outputTokens: 12,
    updatedAt: "now",
  });
  expect(
    ompTokenUsage({ contextUsage: { tokens: NaN, contextWindow: 8192 } }, {}, "now"),
  ).toBeUndefined();
});
it.effect(
  "reader resolves owned and configured native sources and supplies persisted fork-dedup state",
  () =>
    Effect.gen(function* () {
      const { ompUsageReader, ownedOmpSessionDirectory } = yield* Effect.promise(
        () => import("./usage.ts"),
      );
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const home = host.paths.baseDir;
      const xdg = home + "/data";
      yield* fs.makeDirectory(xdg + "/omp/profiles/work", { recursive: true }).pipe(Effect.orDie);
      const instanceId = ProviderInstanceId.make("omp-usage");
      const input = {
        instanceId,
        configured: true,
        config: {
          enabled: false,
          binaryPath: "omp",
          launchArgs: "--profile=work",
          customModels: [],
        },
        environment: { HOME: home, XDG_DATA_HOME: xdg },
      };
      if (ompUsageReader.kind !== "transcripts") throw new Error("Expected native transcripts");
      expect(yield* ompUsageReader.directories(input, { awaitRefresh: true })).toEqual([
        { dir: ownedOmpSessionDirectory(host.paths.stateDir, instanceId) },
        { dir: xdg + "/omp/profiles/work/sessions" },
      ]);
      expect(
        yield* ompUsageReader.directories(
          {
            ...input,
            config: {
              ...input.config,
              launchArgs: "--profile=work --agent-dir=" + home + "/explicit",
            },
          },
          { awaitRefresh: true },
        ),
      ).toEqual([
        { dir: ownedOmpSessionDirectory(host.paths.stateDir, instanceId) },
        { dir: home + "/explicit/sessions" },
      ]);
      expect(
        yield* ompUsageReader.directories(
          {
            ...input,
            config: { ...input.config, launchArgs: "--session-dir=/unsupported" },
          },
          { awaitRefresh: true },
        ),
      ).toEqual([{ dir: ownedOmpSessionDirectory(host.paths.stateDir, instanceId) }]);
      const format = ompUsageReader.format;
      expect(format.sharedSessionsAcrossFiles).toBe(true);
      const state = format.state!.initial();
      format.parseLine('{"type":"session","id":"owned"}', state);
      const resumed = yield* decodeOmpScanState(state);
      expect(resumed).toEqual({ sessionId: "owned" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, Host.layer().pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
);
