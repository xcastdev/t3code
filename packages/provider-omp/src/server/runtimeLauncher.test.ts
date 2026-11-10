// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { ApprovalBroker, decodeControlEnvelope } from "./controlChannel.ts";

it("correlates identical native prompts and consumes only explicit once/deny in the active epoch", async () => {
  const sent: unknown[] = [];
  const broker = new ApprovalBroker("provider", "epoch", (frame) => sent.push(frame));
  const a = broker.request({ full: "same", compact: "same" }, { nativeCallId: "a" });
  const b = broker.request({ full: "same", compact: "same" }, { nativeCallId: "b" });
  const [first, second] = sent as { id: string }[];
  expect(first!.id).not.toBe(second!.id);
  expect(
    broker.answer({
      v: 1,
      type: "approval_answer",
      providerSession: "provider",
      epoch: "epoch",
      id: second!.id,
      answer: "deny",
    }),
  ).toBe(true);
  expect(
    broker.answer({
      v: 1,
      type: "approval_answer",
      providerSession: "provider",
      epoch: "old",
      id: first!.id,
      answer: "once",
    }),
  ).toBe(false);
  expect(
    broker.answer({
      v: 1,
      type: "approval_answer",
      providerSession: "provider",
      epoch: "epoch",
      id: first!.id,
      answer: "once",
    }),
  ).toBe(true);
  expect(
    broker.answer({
      v: 1,
      type: "approval_answer",
      providerSession: "provider",
      epoch: "epoch",
      id: first!.id,
      answer: "once",
    }),
  ).toBe(false);
  expect(await a).toBe("once");
  expect(await b).toBe("deny");
  const expired = broker.request({ full: "same", compact: "same" }, { nativeCallId: "c" });
  broker.close();
  expect(await expired).toBe("deny");
  expect(
    decodeControlEnvelope({
      v: 1,
      type: "approval_answer",
      providerSession: "provider",
      epoch: "epoch",
      id: "a",
      answer: "session",
    }),
  ).toEqual({ ok: false });
});

it("rejects policy and runtime launch overrides before invoking OMP", async () => {
  const { resolveOmpLaunchArgs } = await import("./launch.ts");
  for (const value of [
    "--mode rpc",
    "--config",
    "--approval-mode yolo",
    "--preload hostile.ts",
    "prompt text",
    "-- --config a",
  ])
    expect(resolveOmpLaunchArgs(value).ok).toBe(false);
  expect(resolveOmpLaunchArgs('--config "project policy.yml" --agent-dir /profile')).toEqual({
    ok: true,
    args: ["--config", "project policy.yml", "--agent-dir", "/profile"],
  });
});

it("requires the full reviewed guard handshake and expires individual approvals", async () => {
  const { requiredGuards } = await import("./compatibility.ts");
  const base = { v: 1, type: "ready", providerSession: "s", epoch: "e", id: "ready" };
  expect(
    decodeControlEnvelope({
      ...base,
      payload: { recipe: "unknown", guards: requiredGuards, mode: "approval-required" },
    }),
  ).toEqual({ ok: false });
  expect(
    decodeControlEnvelope({
      ...base,
      payload: {
        recipe: "omp-18.16.0-bun-1.4.4",
        guards: requiredGuards.slice(1),
        mode: "approval-required",
      },
    }),
  ).toEqual({ ok: false });
  expect(
    decodeControlEnvelope({
      ...base,
      payload: {
        recipe: "omp-18.16.0-bun-1.4.4",
        guards: requiredGuards,
        mode: "approval-required",
      },
    }).ok,
  ).toBe(true);
  const sent: import("./controlChannel.ts").ControlEnvelope[] = [];
  const broker = new ApprovalBroker("s", "e", (frame) => sent.push(frame));
  const pending = broker.request({ full: "approve", compact: "approve" }, { nativeCallId: "call" });
  broker.expire(sent[0]!.id);
  expect(await pending).toBe("deny");
  expect(
    broker.answer({
      v: 1,
      type: "approval_answer",
      providerSession: "s",
      epoch: "e",
      id: sent[0]!.id,
      answer: "once",
    }),
  ).toBe(false);
});

it("embeds the current complete runtime assets before bundling", async () => {
  const { runtimeAssetSources } = await import("./runtimeAssets.generated.ts");
  const { runtimeLoaderSource } = await import("./runtimeLoaderSource.ts");
  const { runtimeLauncherSource } = await import("./runtimeLauncherSource.ts");
  expect(runtimeAssetSources["preload.ts"]).toBe(runtimeLoaderSource);
  expect(runtimeAssetSources["launcher.ts"]).toBe(runtimeLauncherSource);
  for (const [name, source] of Object.entries(runtimeAssetSources)) {
    if (name === "preload.ts" || name === "launcher.ts") continue;
    expect(
      source,
      `Run vp run --filter @t3tools/provider-omp generate:runtime-assets after changing ${name}`,
    ).toBe(await NodeFSP.readFile(new URL(name, import.meta.url), "utf8"));
  }
});
