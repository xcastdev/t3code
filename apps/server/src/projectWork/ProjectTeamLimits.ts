import {
  ProjectTeamLimits,
  ProjectTeamRoleRevision,
  ProjectTeamRunBinding,
  ProjectTeamTaskMembership,
  ProjectWorkTaskId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";

const SafeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const PositiveInteger = SafeInteger.check(Schema.isGreaterThan(0));
const Text = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4000));
const Id = Text.check(Schema.isMaxLength(256));
const TaskId = ProjectWorkTaskId.check(Schema.isTrimmed(), Schema.isMaxLength(256));
const Budget = Schema.Struct({
  rootTaskId: TaskId,
  maximumTokens: PositiveInteger,
  deadlineAtMs: PositiveInteger,
});
const Request = Schema.Struct({
  taskId: TaskId,
  roleRevisionId: Id,
  nowMs: SafeInteger,
  environmentModelCalls: PositiveInteger.check(Schema.isLessThanOrEqualTo(128)),
  writable: Schema.Boolean,
  rootBudget: Schema.optionalKey(Budget),
  parentRunId: Schema.optionalKey(Id),
  attemptConfiguration: Schema.Struct({
    maxTokens: PositiveInteger,
    maxDurationMs: PositiveInteger,
    paidFallback: Schema.Literal(false),
  }),
});
const Reason = Schema.Literals([
  "invalid-input",
  "missing-role",
  "ambiguous-role",
  "invalid-role",
  "model-unconfigured",
  "missing-limits",
  "ambiguous-limits",
  "invalid-limits",
  "limits-disabled",
  "limits-exhausted",
  "invalid-task-lineage",
  "invalid-run-lineage",
  "root-budget-required",
  "root-budget-mismatch",
  "deadline-expired",
  "deadline-overflow",
  "delegation-depth-exceeded",
  "writable-restricted",
  "writable-capacity-exhausted",
]);
const validRequest = Schema.is(Request);
const validLimits = Schema.is(ProjectTeamLimits);
const validRole = Schema.is(ProjectTeamRoleRevision);
const validMembership = Schema.is(ProjectTeamTaskMembership);
const validRun = Schema.is(ProjectTeamRunBinding);
const validInteger = Schema.is(SafeInteger);
const validPositive = Schema.is(PositiveInteger);
const validText = Schema.is(Text);
const validId = Schema.is(Id);
const blocked = (reason: typeof Reason.Type) => ({ _tag: "Blocked" as const, reason });
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
type Run = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
const maximumLineageNodes = 9;

/** A pure policy snapshot, not authorization. Root persists the root anchors and intersects
 * prior frozen depth/repair caps before admitting work or reserving model capacity. */
export const resolveProjectTeamLimits = (input: {
  state: ProjectWorkReducerState;
  taskId: ProjectWorkTaskId;
  roleRevisionId: string;
  nowMs: number;
  environmentModelCalls: number;
  writable: boolean;
  rootBudget?: { rootTaskId: ProjectWorkTaskId; maximumTokens: number; deadlineAtMs: number };
  parentRunId?: string;
  attemptConfiguration: { maxTokens: number; maxDurationMs: number; paidFallback: false };
}) => {
  if (!validRequest(input)) return blocked("invalid-input");
  const { state } = input;
  const records = state.foundationRecords ?? [];
  const roles = records.filter(
    (r): r is Extract<ProjectTeamRecord, { kind: "role-revision" }> =>
      r.kind === "role-revision" && r.recordId === input.roleRevisionId,
  );
  if (roles.length === 0) return blocked("missing-role");
  if (roles.length !== 1) return blocked("ambiguous-role");
  const role = roles[0]!;
  if (
    !validRole(role) ||
    !validId(role.recordId) ||
    !validText(role.model) ||
    role.projectId !== state.projectId ||
    role.status !== "available" ||
    !validInteger(role.revision) ||
    !validInteger(role.roleRevision)
  )
    return blocked("invalid-role");
  if (role.model === "unconfigured") return blocked("model-unconfigured");
  const policies = records.filter(
    (r): r is typeof ProjectTeamLimits.Type =>
      r.kind === "limits" && r.model === role.model && r.projectId === state.projectId,
  );
  const configuredPolicies = policies.filter((policy) => policy.status === "configured");
  if (configuredPolicies.length === 0)
    return blocked(
      policies.some((policy) => policy.status === "disabled")
        ? "limits-disabled"
        : "missing-limits",
    );
  if (configuredPolicies.length !== 1) return blocked("ambiguous-limits");
  const policy = configuredPolicies[0]!;
  if (
    !validLimits(policy) ||
    !validId(policy.recordId) ||
    !validInteger(policy.revision) ||
    !validInteger(policy.tokenLimit) ||
    !validInteger(policy.durationLimitMs)
  )
    return blocked("invalid-limits");
  if (policy.status !== "configured") return blocked("limits-disabled");
  if (
    policy.tokenLimit === 0 ||
    policy.durationLimitMs === 0 ||
    policy.modelCalls === 0 ||
    policy.environmentModelCalls === 0
  )
    return blocked("limits-exhausted");

  const lineage: Membership[] = [];
  const seenTasks = new Set<string>();
  let currentTaskId = input.taskId;
  while (true) {
    if (
      !validId(currentTaskId) ||
      lineage.length >= maximumLineageNodes ||
      seenTasks.has(currentTaskId)
    )
      return blocked("invalid-task-lineage");
    seenTasks.add(currentTaskId);
    const tasks = state.tasks.filter((task) => task.taskId === currentTaskId);
    if (
      tasks.length !== 1 ||
      tasks[0]!.projectId !== state.projectId ||
      !validInteger(tasks[0]!.revision)
    )
      return blocked("invalid-task-lineage");
    const memberships = records.filter(
      (r): r is Membership => r.kind === "task-membership" && r.taskId === currentTaskId,
    );
    if (memberships.length !== 1) return blocked("invalid-task-lineage");
    const membership = memberships[0]!;
    if (
      !validMembership(membership) ||
      !validId(membership.recordId) ||
      membership.projectId !== state.projectId ||
      membership.status !== "active" ||
      membership.executionKind === "legacy" ||
      (lineage.length === 0 && membership.executionKind !== "managed") ||
      !validInteger(membership.revision)
    )
      return blocked("invalid-task-lineage");
    lineage.push(membership);
    if (membership.parentTaskId === undefined) break;
    currentTaskId = membership.parentTaskId;
  }
  const rootTaskId = currentTaskId;
  const delegationDepth = lineage.length - 1;
  const maximumDelegationDepth = Math.min(role.delegationDepth, policy.delegationDepth);
  if (delegationDepth > maximumDelegationDepth) return blocked("delegation-depth-exceeded");
  const membership = lineage[0]!;
  if (
    input.writable &&
    (["investigator", "planner", "reviewer"].includes(role.role) ||
      ["research", "plan", "review"].includes(membership.deliverableKind))
  )
    return blocked("writable-restricted");
  if (input.writable && policy.projectWritableWorkers === 0)
    return blocked("writable-capacity-exhausted");

  const runs = records.filter((record): record is Run => record.kind === "run-binding");
  const priorRuns = runs.filter((run) => run.taskId === input.taskId);
  const runsById = new Map<string, Run>();
  const duplicateRunIds = new Set<string>();
  for (const run of runs) {
    if (runsById.has(run.recordId)) duplicateRunIds.add(run.recordId);
    else runsById.set(run.recordId, run);
  }
  const membershipsByTask = new Map(lineage.map((entry) => [entry.taskId, entry]));
  const recordedParent = membership.assignment?.parentRunId;
  if (
    input.parentRunId !== undefined &&
    recordedParent !== undefined &&
    input.parentRunId !== recordedParent
  )
    return blocked("invalid-run-lineage");
  const parentRunId = input.parentRunId ?? recordedParent;
  // Run replacements can refer to the same task; only task ancestry contributes depth.
  const starts = [
    ...priorRuns.map((run) => run.recordId),
    ...(parentRunId === undefined ? [] : [parentRunId]),
  ];
  const validatedRuns = new Set<string>();
  for (const start of starts) {
    const seenRuns = new Set<string>();
    let runId: string | undefined = start;
    let previousTaskId = input.taskId;
    while (runId !== undefined) {
      const run = runsById.get(runId);
      if (run === undefined || duplicateRunIds.has(runId)) return blocked("invalid-run-lineage");
      const previousMembership = membershipsByTask.get(previousTaskId);
      // Every incoming edge must match task ancestry, even when its suffix was validated earlier.
      if (run.taskId !== previousTaskId && run.taskId !== previousMembership?.parentTaskId)
        return blocked("invalid-run-lineage");
      if (validatedRuns.has(runId)) break;
      if (
        seenRuns.has(runId) ||
        !validRun(run) ||
        !validId(run.recordId) ||
        !validInteger(run.revision) ||
        run.projectId !== state.projectId ||
        !seenTasks.has(run.taskId)
      )
        return blocked("invalid-run-lineage");
      seenRuns.add(runId);
      previousTaskId = run.taskId;
      runId = run.parentRunId;
    }
    for (const id of seenRuns) validatedRuns.add(id);
  }
  if (
    input.rootBudget === undefined &&
    (delegationDepth > 0 ||
      priorRuns.length > 0 ||
      parentRunId !== undefined ||
      state.attempts.some((attempt) => attempt.taskId === input.taskId))
  )
    return blocked("root-budget-required");
  if (input.rootBudget !== undefined && input.rootBudget.rootTaskId !== rootTaskId)
    return blocked("root-budget-mismatch");
  const duration = Math.min(input.attemptConfiguration.maxDurationMs, policy.durationLimitMs);
  if (input.nowMs > Number.MAX_SAFE_INTEGER - duration) return blocked("deadline-overflow");
  const attemptDeadline = input.nowMs + duration;
  const rootDeadlineAtMs = input.rootBudget?.deadlineAtMs ?? attemptDeadline;
  if (rootDeadlineAtMs <= input.nowMs) return blocked("deadline-expired");
  const maximumTokens =
    input.rootBudget?.maximumTokens ??
    Math.min(input.attemptConfiguration.maxTokens, policy.tokenLimit);
  if (!validPositive(maximumTokens)) return blocked("invalid-input");
  return Object.freeze({
    _tag: "Eligible" as const,
    frozen: Object.freeze({
      rootTaskId,
      maximumTokens,
      attemptMaximumTokens: Math.min(
        maximumTokens,
        input.attemptConfiguration.maxTokens,
        policy.tokenLimit,
      ),
      rootDeadlineAtMs,
      deadlineAtMs: Math.min(rootDeadlineAtMs, attemptDeadline),
      delegationDepth,
      maximumDelegationDepth,
      repairAllowance: policy.repairAllowance,
      environmentModelCalls: Math.min(input.environmentModelCalls, policy.environmentModelCalls),
      projectWritableWorkers: policy.projectWritableWorkers,
      modelCalls: policy.modelCalls,
      writable: input.writable,
      limitsRecordId: policy.recordId,
      limitsRevision: policy.revision,
    }),
  });
};
