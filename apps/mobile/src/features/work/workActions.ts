import {
  EnvironmentAuthorizationError,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkCriterion,
  ProjectWorkAttempt,
  ProjectWorkWriteIntent,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
  type ProjectWorkTaskContext,
} from "@t3tools/contracts";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import * as Schema from "effect/Schema";

export interface MobileWorkScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
}
export interface MobileWorkCurrent extends MobileWorkScope {
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly foundationSupported: boolean;
  readonly guidedSupported: boolean;
  readonly fresh: boolean;
  readonly context: ProjectWorkTaskContext | null;
  readonly foundation: ProjectWorkFoundationSnapshot;
}
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
const knownRecord = Schema.is(ProjectTeamRecord);
const knownTask = Schema.is(ProjectWorkTask);
const knownCriterion = Schema.is(ProjectWorkCriterion);
const knownAttempt = Schema.is(ProjectWorkAttempt);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const only = <T>(items: ReadonlyArray<T>): T | null => (items.length === 1 ? items[0]! : null);

/** Capability flags describe UI support. The server still authorizes every command. */
export function reviewMobileWork(current: MobileWorkCurrent) {
  const { context, foundation } = current;
  let reason: string | null = null;
  if (!current.connected) reason = "Reconnect to make changes. Cached work may be out of date.";
  else if (!current.enabled) reason = "Project Work is disabled in this environment's settings.";
  else if (!current.foundationSupported || !current.guidedSupported)
    reason = "This server does not support guided Work actions. Update the server to use them.";
  else if (
    !current.fresh ||
    !foundation.complete ||
    foundation.error !== null ||
    context === null ||
    foundation.revision !== context.revision
  )
    reason = "Refresh the complete current project work before making changes.";
  else if (
    context.projectId !== current.projectId ||
    context.task.projectId !== current.projectId ||
    context.task.taskId !== current.taskId ||
    context.policy.taskId !== current.taskId
  )
    reason = "This task does not belong to the selected project.";
  else if (
    !knownTask(context.task) ||
    [context.activeAttempt, context.reclaimableAttempt].some(
      (attempt) =>
        attempt !== undefined && (!knownAttempt(attempt) || attempt.taskId !== current.taskId),
    ) ||
    !foundation.records.every(knownRecord) ||
    foundation.records.some((record) => record.projectId !== current.projectId) ||
    !context.criteria.every(knownCriterion) ||
    context.criteria.some((criterion) => criterion.taskId !== current.taskId) ||
    new Set(context.criteria.map((criterion) => criterion.criterionId)).size !==
      context.criteria.length
  )
    reason = "This task contains a workflow state this client cannot change.";
  else if (
    context.task.specification !== undefined &&
    (context.task.specification.revision !== context.task.specRevision ||
      context.task.specification.criterionIds.some(
        (id) => !context.criteria.some((criterion) => criterion.criterionId === id),
      ))
  )
    reason = "Load the complete current specification before making changes.";
  const records = foundation.records
    .filter(knownRecord)
    .filter((record) => "taskId" in record && record.taskId === current.taskId);
  const membership = only(records.filter((record) => record.kind === "task-membership"));
  if (reason === null && (membership?.status !== "active" || membership.executionKind === "legacy"))
    reason = "Guided actions are unavailable for this task.";
  if (
    reason === null &&
    (context?.task.state === "completed" ||
      context?.task.state === "canceled" ||
      (membership?.controlState !== undefined && membership.controlState !== "active"))
  )
    reason = "This task is stopped. Review its recorded state before continuing.";
  const plan = only(
    records.filter(
      (record): record is Plan =>
        record.kind === "plan-revision" &&
        record.status === "proposed" &&
        record.specRevision === context?.task.specRevision,
    ),
  );
  const gates = records.filter(
    (record): record is Gate =>
      record.kind === "gate" &&
      (record.status === "pending" || record.status === "proposed") &&
      record.specRevision === context?.task.specRevision,
  );
  const specificationGate =
    context?.task.specification === undefined
      ? null
      : only(gates.filter((gate) => gate.gate === "specification" && gate.planRevision === 0));
  const planGate =
    plan === null
      ? null
      : only(
          gates.filter(
            (gate) =>
              gate.gate === "plan" &&
              gate.planRevision === plan.planRevision &&
              gate.contentHash === plan.contentHash,
          ),
        );
  const canInvestigate =
    reason === null &&
    context?.task.activeAttemptId === undefined &&
    context?.activeAttempt === undefined &&
    !records.some((record) => record.kind === "run-binding" && record.status !== "settled");
  return {
    reason,
    specificationGate: reason === null ? specificationGate : null,
    planGate: reason === null ? planGate : null,
    plan,
    canInvestigate,
    gates: records.filter((record): record is Gate => record.kind === "gate"),
  };
}

export type MobileWorkAction =
  | { readonly kind: "investigate" }
  | { readonly kind: "gate"; readonly gateId: string; readonly response: "approved" | "rejected" };
export interface MobileWorkActionState {
  readonly objective: string;
  readonly outputs: string;
  readonly status: "idle" | "sending" | "uncertain" | "stale" | "denied" | "accepted";
  readonly notice: string | null;
  readonly pending: ProjectWorkWriteIntent | null;
}
// Only validated public domain fields establish an authoritative write rejection.
const knownPublicRejection = Schema.is(
  Schema.Union([
    Schema.Struct(EnvironmentAuthorizationError.fields),
    Schema.Struct({ _tag: Schema.Literal("ProjectTeamAuthorizationError"), reason: Schema.String }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkAuthorizationError"),
      reason: Schema.Literals([
        "spoofed-attribution",
        "agent-approval-required",
        "invalid-approval",
        "project-work-disabled",
        "unknown-project",
        "project-archived",
        "project-tombstoned",
      ]),
    }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkContentRejectedError"),
      matches: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String })),
    }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkPolicyError"),
      code: Schema.Literals([
        "unknown-task",
        "unknown-criterion",
        "unknown-evidence",
        "unknown-relationship",
        "unknown-blocker",
        "stale-revision",
        "invalid-state",
        "invalid-specification",
        "invalid-relationship",
        "active-attempt",
        "unresolved-dependency",
        "unsatisfied-criterion",
        "protected-specification",
        "approval-required",
        "authority-required",
        "duplicate-record",
        "deferred-command",
      ]),
      message: Schema.String,
    }),
  ]),
);
const changedTeamTarget = new Set([
  "Project revision changed",
  "Task or specification revision changed",
  "Plan revision changed",
  "Gate target changed",
  "Specification approval target changed",
  "Plan approval target changed",
  "Gate response is no longer eligible",
  "Gate response changed since receipt",
  "Guided project or task revision changed",
  "Guided receipt target changed",
  "Question target changed",
]);
export function publicWorkRejection(error: unknown) {
  if (!knownPublicRejection(error)) return null;
  if (
    (error._tag === "ProjectTeamAuthorizationError" && changedTeamTarget.has(error.reason)) ||
    (error._tag === "ProjectWorkPolicyError" && error.code === "stale-revision")
  )
    return { status: "stale" as const, notice: null };
  const reason =
    error._tag === "ProjectWorkContentRejectedError"
      ? "Content contains a secret; edit your draft before resending"
      : error._tag === "ProjectWorkPolicyError" || error._tag === "EnvironmentAuthorizationError"
        ? error.message
        : error.reason;
  return {
    status: "denied" as const,
    notice: `The server denied this action: ${reason}. Your draft is kept.`,
  };
}

/** Owns one scoped draft and exact command across conflict, disconnect and retry. */
export function createWorkActionSession(
  scope: MobileWorkScope,
  current: () => MobileWorkCurrent,
  send: (intent: ProjectWorkWriteIntent) => Promise<void>,
  id: () => CommandId,
  changed: () => void = () => {},
) {
  let readCurrent = current;
  let alive = true;
  let blockedRevision: number | null = null;
  let state: MobileWorkActionState = {
    objective: "",
    outputs: "Findings, sources, and open questions",
    status: "idle",
    notice: null,
    pending: null,
  };
  const update = (patch: Partial<MobileWorkActionState>) => {
    state = { ...state, ...patch };
    if (alive) changed();
  };
  const available = () => {
    const value = readCurrent();
    if (
      !alive ||
      value.environmentId !== scope.environmentId ||
      value.projectId !== scope.projectId ||
      value.taskId !== scope.taskId
    )
      return null;
    if (reviewMobileWork(value).reason !== null) return null;
    return value;
  };
  const execute = async (intent: ProjectWorkWriteIntent) => {
    update({ status: "sending", pending: intent, notice: null });
    try {
      await send(intent);
      blockedRevision = intent.expectedRevision ?? null;
      update({
        status: "accepted",
        pending: null,
        notice: "Recorded. Refresh work to see the current state.",
      });
    } catch (error) {
      const rejection = publicWorkRejection(error);
      const status = rejection?.status ?? "uncertain";
      if (status === "stale") blockedRevision = intent.expectedRevision ?? null;
      update({
        status,
        notice:
          status === "stale"
            ? "Work changed on another client. Your draft is kept. Refresh and review it before sending a new command."
            : status === "denied"
              ? (rejection?.notice ?? "The server denied this action. Your draft is kept.")
              : "The response was lost. The action may have been recorded. Retry the exact command or refresh to inspect its result.",
      });
    }
  };
  return {
    get state() {
      return state;
    },
    canSubmit(revision: number | null) {
      return alive && state.status === "idle" && revision !== null && revision !== blockedRevision;
    },
    setCurrent(read: () => MobileWorkCurrent) {
      readCurrent = read;
    },
    edit(objective: string, outputs: string) {
      if (state.status !== "sending" && state.status !== "uncertain")
        update({ objective, outputs });
    },
    async submit(action: MobileWorkAction) {
      if (state.status !== "idle") return;
      const value = available();
      if (value === null || value.context === null || value.context.revision === blockedRevision) {
        update({ notice: "Load current work in this environment and project before sending." });
        return;
      }
      const review = reviewMobileWork(value);
      const base = {
        commandId: id(),
        projectId: scope.projectId,
        taskId: scope.taskId,
        expectedRevision: value.context.revision,
        expectedTaskRevision: value.context.task.revision,
      };
      let intent: ProjectWorkWriteIntent;
      try {
        if (action.kind === "investigate") {
          if (!review.canInvestigate) {
            update({
              notice: "Investigation is unavailable while this task has an active worker.",
            });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.investigation.start",
            objective: state.objective,
            outputDescriptions: state.outputs
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          });
        } else {
          const gate = [review.specificationGate, review.planGate].find(
            (entry) => entry?.recordId === action.gateId,
          );
          if (!gate) {
            update({ notice: "This approval is no longer current. Refresh work." });
            return;
          }
          intent = decodeWrite({
            ...base,
            type: "project-team.gate.respond",
            specRevision: gate.specRevision,
            planRevision: gate.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            response: action.response,
          });
        }
      } catch {
        update({
          notice:
            "Enter an investigation objective and one to sixteen outputs within the server's text limits.",
        });
        return;
      }
      await execute(intent);
    },
    async retry() {
      if (state.status !== "uncertain" || state.pending === null) return;
      if (available() === null) {
        update({
          notice:
            "Reconnect and refresh this task in its original environment and project to retry.",
        });
        return;
      }
      await execute(state.pending);
    },
    reset() {
      if (state.status !== "sending" && state.status !== "uncertain")
        update({ status: "idle", pending: null, notice: null });
    },
    activate() {
      alive = true;
    },
    dispose() {
      alive = false;
    },
  };
}
