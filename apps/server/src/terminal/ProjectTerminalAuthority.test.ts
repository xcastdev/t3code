import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AdmissionResult, CheckInput } from "../orchestration-v2/RunAdmission.ts";
import { evaluateTerminalAuthority, sameTerminalAuthority } from "./ProjectTerminalAuthority.ts";
const threadId = ThreadId.make("thread");
const runId = RunId.make("run");
const providerSessionId = ProviderSessionId.make("session");
const providerThreadId = ProviderThreadId.make("provider-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const projection = {
  runs: [
    {
      id: runId,
      activeAttemptId: RunAttemptId.make("attempt"),
      providerThreadId,
      providerInstanceId,
      status: "running" as const,
    },
  ],
  providerThreads: [{ id: providerThreadId, providerSessionId }],
  turnItems: [],
};
const caller = { threadId, providerSessionId, providerInstanceId };
const admitted: AdmissionResult = {
  _tag: "admitted",
  owner: {
    projectId: ProjectId.make("project"),
    bindingId: "binding",
    rootId: "root",
    generation: 2,
    fence: 3,
    threadId,
    runId,
    expiresAt: "2026-01-01T00:00:00.000Z",
    configuration: {
      providerInstanceId,
      model: "model",
      instructionsHash: "hash",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 100,
      maxDurationMs: 1000,
      paidFallback: false,
    },
  },
};
it.effect(
  "uses actual run attempt/session authority and refuses expired/stopped/reassigned owners",
  () =>
    Effect.gen(function* () {
      const checks: CheckInput[] = [];
      let decision: AdmissionResult = admitted;
      const admission = {
        check: (input: CheckInput) =>
          Effect.sync(() => {
            checks.push(input);
            return decision;
          }),
      };
      const before = yield* evaluateTerminalAuthority({
        threadId,
        runId,
        caller,
        projection,
        admission,
      });
      assert.equal(before.owner?.rootId, "root");
      assert.equal(checks[0]?.nativeTarget?.runAttemptId, projection.runs[0]!.activeAttemptId);
      assert.equal(checks[0]?.originSessionId, providerSessionId);
      decision = { _tag: "denied", reason: "expired" };
      assert.equal(
        (yield* Effect.result(
          evaluateTerminalAuthority({ threadId, runId, caller, projection, admission }),
        ))._tag,
        "Failure",
      );
      decision = admitted;
      assert.equal(
        (yield* Effect.result(
          evaluateTerminalAuthority({
            threadId,
            runId,
            caller,
            projection: { ...projection, turnItems: [{ runId, type: "run_interrupt_request" }] },
            admission,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          evaluateTerminalAuthority({
            threadId,
            runId,
            caller: { ...caller, providerSessionId: "old-session" },
            projection,
            admission,
          }),
        ))._tag,
        "Failure",
      );
      const reassigned = {
        ...before,
        owner: before.owner ? { ...before.owner, generation: 3 } : undefined,
      };
      assert.equal(sameTerminalAuthority(before, reassigned), false);
      const retried = {
        ...before,
        nativeTarget: { ...before.nativeTarget, runAttemptId: RunAttemptId.make("new-attempt") },
      };
      assert.equal(sameTerminalAuthority(before, retried), false);
    }),
);
