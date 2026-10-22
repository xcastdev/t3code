import { assert, it } from "@effect/vitest";
import { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Accounting from "./ProjectTeamModelAccounting.ts";

const projectId = ProjectId.make("accounting-project");
const rootTaskId = ProjectWorkTaskId.make("root-task");
const at = "2026-01-01T00:00:00.000Z";
const deadline = "2026-01-01T00:05:00.000Z";
const request = {
  projectId,
  rootTaskId,
  maximumTokens: 100,
  deadlineAtMs: Date.parse(deadline),
  nowMs: Date.parse(at),
};
const layer = Accounting.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.fn("AccountingTest.seed")(function* (
  id: string,
  root = rootTaskId,
  phase = "settled",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO t3_workflow_v2_run_admissions
    (admission_id,project_id,binding_id,root_id,root_task_id,thread_id,run_id,generation,fence,command_id,phase,depth,writable,root_deadline,expires_at,snapshot_json,limits_json)
    VALUES (${id},${projectId},${id},'root-binding',${root},${id},${id},0,0,${id},${phase},0,0,${deadline},${deadline},'{}','{"maximumTokens":100}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
    (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json)
    VALUES (${id},${id},${id},1,${id},'codex',${id},'completed','{}')`;
});
const report = Effect.fn("AccountingTest.report")(function* (
  id: string,
  usage?: { usageStatus: "complete" | "partial"; inputTokens: number; outputTokens: number },
  status = "completed",
  ordinal = 1,
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify(
    usage === undefined
      ? {}
      : {
          turnTokenUsage: {
            ...usage,
            usageScope: "main_agent",
            hasSubagents: true,
            cachedInputTokens: 5,
            cacheCreationTokens: 3,
            reasoningTokens: 4,
          },
        },
  );
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
    (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json)
    VALUES (${`${id}-${ordinal}`},${id},${id},${id},${id},${ordinal},${status},${payload})
    ON CONFLICT(provider_turn_id) DO UPDATE SET payload_json=excluded.payload_json,status=excluded.status`;
});

it.effect(
  "aggregates only persisted turns in the root and replays stable operation IDs without recounting cache subsets",
  () =>
    Effect.gen(function* () {
      yield* seed("first");
      yield* seed("replacement");
      yield* seed("unrelated", ProjectWorkTaskId.make("other-root"));
      yield* report("first", { usageStatus: "complete", inputTokens: 30, outputTokens: 10 });
      yield* report(
        "first",
        { usageStatus: "complete", inputTokens: 5, outputTokens: 5 },
        "completed",
        2,
      );
      yield* report("replacement", { usageStatus: "complete", inputTokens: 20, outputTokens: 10 });
      yield* report("unrelated", {
        usageStatus: "complete",
        inputTokens: 1000,
        outputTokens: 1000,
      });
      const accounting = yield* Accounting.ProjectTeamModelAccounting;
      const result = yield* accounting.readRoot(request);
      assert.equal(result._tag, "Available");
      if (result._tag !== "Available") return;
      assert.equal(result.accounting.observedTokens, 80);
      assert.equal(result.accounting.operations.length, 3);
      assert.equal(result.accounting.unknownOperations, 0);
      assert.deepStrictEqual(yield* accounting.readRoot(request), result);
      yield* report("first", { usageStatus: "complete", inputTokens: 30, outputTokens: 10 });
      assert.deepStrictEqual(yield* accounting.readRoot(request), result);
      assert.equal((yield* accounting.checkAdmission(request))._tag, "Eligible");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains missing and partial usage uncertainty without blocking native providers until observed totals reach the threshold",
  () =>
    Effect.gen(function* () {
      yield* seed("missing");
      const accounting = yield* Accounting.ProjectTeamModelAccounting;
      const noTurn = yield* accounting.checkAdmission(request);
      assert.equal(noTurn._tag, "Eligible");
      if (noTurn._tag !== "Eligible") return;
      assert.equal(noTurn.accounting.unknownOperations, 1);
      assert.equal(noTurn.accounting.operations[0]?.availability, "unknown");
      yield* report("missing");
      const missing = yield* accounting.checkAdmission(request);
      assert.equal(missing._tag, "Eligible");
      if (missing._tag !== "Eligible") return;
      assert.equal(missing.accounting.unknownOperations, 1);
      assert.equal(missing.accounting.operations[0]?.availability, "unknown");
      yield* report("missing", { usageStatus: "partial", inputTokens: 20, outputTokens: 10 });
      const partial = yield* accounting.checkAdmission(request);
      assert.equal(partial._tag, "Eligible");
      if (partial._tag !== "Eligible") return;
      assert.equal(partial.accounting.observedTokens, 30);
      assert.equal(partial.accounting.unknownOperations, 1);
      assert.equal(partial.accounting.operations[0]?.availability, "unknown");
      yield* report("missing", { usageStatus: "partial", inputTokens: 90, outputTokens: 10 });
      assert.deepStrictEqual(yield* accounting.checkAdmission(request), {
        _tag: "Blocked",
        reason: "threshold-reached",
      });
      yield* report("missing", { usageStatus: "complete", inputTokens: 90, outputTokens: 20 });
      const completed = yield* accounting.readRoot(request);
      assert.equal(completed._tag, "Available");
      if (completed._tag !== "Available") return;
      assert.equal(completed.accounting.observedTokens, 110);
      assert.equal(completed.accounting.unknownOperations, 0);
      assert.equal(completed.accounting.operations.length, 1);
      assert.equal(
        completed.accounting.operations[0]?.operationId,
        missing.accounting.operations[0]?.operationId,
      );
      assert.equal(completed.accounting.operations[0]?.availability, "reported");
      assert.deepStrictEqual(yield* accounting.checkAdmission(request), {
        _tag: "Blocked",
        reason: "threshold-reached",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "blocks later admissions at observed thresholds while preserving original root limits through replacement and cleanup",
  () =>
    Effect.gen(function* () {
      yield* seed("original");
      yield* seed("replacement");
      yield* report("original", { usageStatus: "complete", inputTokens: 80, outputTokens: 20 });
      yield* report("replacement", { usageStatus: "complete", inputTokens: 30, outputTokens: 10 });
      const accounting = yield* Accounting.ProjectTeamModelAccounting;
      const renewed = {
        ...request,
        maximumTokens: 1000,
        deadlineAtMs: request.deadlineAtMs + 1000,
      };
      assert.deepStrictEqual(yield* accounting.checkAdmission(renewed), {
        _tag: "Blocked",
        reason: "threshold-reached",
      });
      assert.deepStrictEqual(
        yield* accounting.checkAdmission({ ...renewed, nowMs: request.deadlineAtMs }),
        { _tag: "Blocked", reason: "deadline-expired" },
      );
      const result = yield* accounting.readRoot(request);
      assert.equal(result._tag, "Available");
      if (result._tag !== "Available") return;
      assert.equal(result.accounting.observedTokens, 140);
      assert.equal(result.accounting.maximumTokens, 100);
      assert.equal(result.accounting.deadlineAtMs, request.deadlineAtMs);
    }).pipe(Effect.provide(layer)),
);

it.effect("leaves active unreported calls in flight and never reserves an invented hard cap", () =>
  Effect.gen(function* () {
    yield* seed("active", rootTaskId, "launched");
    yield* report("active", undefined, "running");
    const accounting = yield* Accounting.ProjectTeamModelAccounting;
    const result = yield* accounting.checkAdmission(request);
    assert.equal(result._tag, "Eligible");
    if (result._tag !== "Eligible") return;
    assert.equal(result.accounting.inFlightOperations, 1);
    assert.equal(result.accounting.unknownOperations, 0);
    assert.equal(result.accounting.observedTokens, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("fails closed for corrupt persisted usage and unsafe totals", () =>
  Effect.gen(function* () {
    yield* seed("corrupt");
    yield* report("corrupt", {
      usageStatus: "complete",
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 10,
    });
    const accounting = yield* Accounting.ProjectTeamModelAccounting;
    assert.deepStrictEqual(yield* accounting.checkAdmission(request), {
      _tag: "Blocked",
      reason: "overflow",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json='{"turnTokenUsage":{"usageStatus":"complete"}}'`;
    assert.deepStrictEqual(yield* accounting.checkAdmission(request), {
      _tag: "Blocked",
      reason: "ledger-invalid",
    });
  }).pipe(Effect.provide(layer)),
);
