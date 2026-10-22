import { ProjectId, ProjectWorkTaskId, TurnTokenUsage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const PositiveInteger = Integer.check(Schema.isGreaterThan(0));
const Root = Schema.Struct({ projectId: ProjectId, rootTaskId: ProjectWorkTaskId });
const Admission = Schema.Struct({
  ...Root.fields,
  maximumTokens: PositiveInteger,
  deadlineAtMs: PositiveInteger,
  nowMs: Integer,
});
const Receipt = Schema.fromJsonString(
  Schema.Struct({ turnTokenUsage: Schema.optionalKey(TurnTokenUsage) }),
);
const Limits = Schema.fromJsonString(Schema.Struct({ maximumTokens: PositiveInteger }));
const validAdmission = Schema.is(Admission);
const validPositiveInteger = Schema.is(PositiveInteger);
const decodeReceipt = Schema.decodeUnknownOption(Receipt);
const decodeLimits = Schema.decodeUnknownOption(Limits);

interface Operation {
  readonly operationId: string;
  readonly runId: string;
  readonly runAttemptId: string | null;
  readonly observedTokens: number;
  readonly availability: "reported" | "unknown" | "in-flight";
  readonly hasSubagents: boolean;
}
interface RootAccounting {
  readonly observedTokens: number;
  readonly unknownOperations: number;
  readonly inFlightOperations: number;
  readonly maximumTokens: number | null;
  readonly deadlineAtMs: number | null;
  readonly operations: ReadonlyArray<Operation>;
}
type ReadResult =
  | { readonly _tag: "Available"; readonly accounting: RootAccounting }
  | { readonly _tag: "Unavailable"; readonly reason: "read-bound" | "ledger-invalid" | "overflow" };
type AdmissionResult =
  | { readonly _tag: "Eligible"; readonly accounting: RootAccounting }
  | {
      readonly _tag: "Blocked";
      readonly reason:
        | "invalid-input"
        | "read-bound"
        | "ledger-invalid"
        | "overflow"
        | "deadline-expired"
        | "threshold-reached";
    };

export class ProjectTeamModelAccounting extends Context.Service<
  ProjectTeamModelAccounting,
  {
    readonly readRoot: (input: typeof Root.Type) => Effect.Effect<ReadResult, SqlError.SqlError>;
    readonly checkAdmission: (
      input: typeof Admission.Type,
    ) => Effect.Effect<AdmissionResult, SqlError.SqlError>;
  }
>()("t3/projectWork/ProjectTeamModelAccounting") {}

// This is a reference view of V2 receipts. Global Usage remains solely owned by V2.
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readRoot = Effect.fn("ProjectTeamModelAccounting.readRoot")(function* (
    input: typeof Root.Type,
  ): Effect.fn.Return<ReadResult, SqlError.SqlError> {
    const roots = yield* sql<{
      root_deadline: string;
      limits_json: string;
    }>`SELECT root_deadline,limits_json
      FROM t3_workflow_v2_run_admissions WHERE project_id=${input.projectId}
      AND root_task_id=${input.rootTaskId} AND phase <> 'prepared' LIMIT 1025`;
    if (roots.length > 1024) return { _tag: "Unavailable", reason: "read-bound" };
    let maximumTokens: number | null = null;
    let deadlineAtMs: number | null = null;
    for (const root of roots) {
      const limits = decodeLimits(root.limits_json);
      const deadline = Date.parse(root.root_deadline);
      if (limits._tag === "None" || !validPositiveInteger(deadline))
        return { _tag: "Unavailable", reason: "ledger-invalid" };
      maximumTokens = Math.min(
        maximumTokens ?? limits.value.maximumTokens,
        limits.value.maximumTokens,
      );
      deadlineAtMs = Math.min(deadlineAtMs ?? deadline, deadline);
    }
    const rows = yield* sql<{
      run_id: string;
      attempt_id: string | null;
      provider_turn_id: string | null;
      status: string | null;
      attempt_status: string | null;
      phase: string;
      payload_json: string | null;
    }>`SELECT DISTINCT owned.run_id,a.attempt_id,t.provider_turn_id,t.status,a.status AS attempt_status,owned.phase,t.payload_json
      FROM (SELECT DISTINCT run_id,thread_id,phase FROM t3_workflow_v2_run_admissions
        WHERE project_id=${input.projectId} AND root_task_id=${input.rootTaskId}
          AND phase <> 'prepared' AND run_id IS NOT NULL) owned
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.run_id=owned.run_id AND a.thread_id=owned.thread_id
      LEFT JOIN orchestration_v2_projection_provider_turns t ON t.run_attempt_id=a.attempt_id AND t.thread_id=a.thread_id
        AND t.provider_thread_id=a.provider_thread_id
      ORDER BY owned.run_id,a.attempt_id,t.provider_turn_id LIMIT 4097`;
    if (rows.length > 4096) return { _tag: "Unavailable", reason: "read-bound" };
    const operations = new Map<string, Operation>();
    let observedTokens = 0;
    for (const row of rows) {
      const operationId =
        row.provider_turn_id === null
          ? `v2-attempt:${row.attempt_id ?? row.run_id}`
          : `v2-turn:${row.provider_turn_id}`;
      if (operations.has(operationId)) continue;
      const parsed = row.payload_json === null ? undefined : decodeReceipt(row.payload_json);
      if (parsed?._tag === "None") return { _tag: "Unavailable", reason: "ledger-invalid" };
      const usage = parsed?._tag === "Some" ? parsed.value.turnTokenUsage : undefined;
      // Cache and reasoning counts are subsets of input/output in the V2 contract.
      const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(observedTokens + tokens))
        return { _tag: "Unavailable", reason: "overflow" };
      observedTokens += tokens;
      const terminal =
        row.status === null
          ? row.phase === "settled" ||
            (row.attempt_status !== null && !["pending", "running"].includes(row.attempt_status))
          : !["pending", "running"].includes(row.status);
      operations.set(operationId, {
        operationId,
        runId: row.run_id,
        runAttemptId: row.attempt_id,
        observedTokens: tokens,
        availability:
          usage?.usageStatus === "complete" ? "reported" : terminal ? "unknown" : "in-flight",
        hasSubagents: usage?.hasSubagents ?? false,
      });
    }
    const values = [...operations.values()];
    return {
      _tag: "Available",
      accounting: {
        observedTokens,
        maximumTokens,
        deadlineAtMs,
        unknownOperations: values.filter((operation) => operation.availability === "unknown")
          .length,
        inFlightOperations: values.filter((operation) => operation.availability === "in-flight")
          .length,
        operations: values,
      },
    };
  });
  const checkAdmission = Effect.fn("ProjectTeamModelAccounting.checkAdmission")(function* (
    input: typeof Admission.Type,
  ): Effect.fn.Return<AdmissionResult, SqlError.SqlError> {
    if (!validAdmission(input)) return { _tag: "Blocked", reason: "invalid-input" };
    const result = yield* readRoot(input);
    if (result._tag === "Unavailable") return { _tag: "Blocked", reason: result.reason };
    const { accounting } = result;
    if (input.nowMs >= Math.min(input.deadlineAtMs, accounting.deadlineAtMs ?? input.deadlineAtMs))
      return { _tag: "Blocked", reason: "deadline-expired" };
    if (
      accounting.observedTokens >=
      Math.min(input.maximumTokens, accounting.maximumTokens ?? input.maximumTokens)
    )
      return { _tag: "Blocked", reason: "threshold-reached" };
    // Missing native usage is uncertainty, not an exhausted budget. Concurrent calls
    // can exceed this observed threshold before another admission.
    return { _tag: "Eligible", accounting };
  });
  return ProjectTeamModelAccounting.of({ readRoot, checkAdmission });
});

export const layer = Layer.effect(ProjectTeamModelAccounting, make);
