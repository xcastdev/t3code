import type {
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkTaskRead,
} from "@t3tools/contracts";

export type WorkGateRecord = Extract<ProjectTeamRecordRead, { readonly kind: "gate" }>;
export type WorkPlanRecord = Extract<ProjectTeamRecordRead, { readonly kind: "plan-revision" }>;
export type WorkMembershipRecord = Extract<
  ProjectTeamRecordRead,
  { readonly kind: "task-membership" }
>;
export type WorkIssueRecord = Extract<ProjectTeamRecordRead, { readonly kind: "issue" }>;
export type WorkMissionRecord = Extract<ProjectTeamRecordRead, { readonly kind: "mission" }>;

// The read union keeps a catch-all member whose `kind` is a plain string, so
// equality alone does not narrow; its schema filter excludes every known kind.
const ofKind =
  <K extends ProjectTeamRecordRead["kind"]>(kind: K) =>
  (record: ProjectTeamRecordRead): record is Extract<ProjectTeamRecordRead, { kind: K }> =>
    record.kind === kind;
export const isGateRecord = ofKind("gate");
export const isPlanRecord = ofKind("plan-revision");
export const isMembershipRecord = ofKind("task-membership");
export const isIssueRecord = ofKind("issue");
export const isMissionRecord = ofKind("mission");

export type WorkApprovalState = "approved" | "rejected" | "pending" | "stale" | "missing";

export interface WorkApprovalStep {
  readonly id: "specification" | "plan";
  readonly label: string;
  readonly revision: number | null;
  readonly state: WorkApprovalState;
  readonly detail: string;
  readonly gate: WorkGateRecord | null;
  readonly hash: string | null;
}

export type WorkGuidedControl = "pause" | "resume" | "defer" | "cancel" | "reopen";

export interface WorkTaskModel {
  readonly task: ProjectWorkTaskRead;
  readonly guided: boolean;
  readonly membership: WorkMembershipRecord | null;
  readonly controlState: string;
  readonly terminal: boolean;
  readonly specGate: WorkGateRecord | null;
  readonly plan: WorkPlanRecord | null;
  readonly planCurrent: boolean;
  readonly planGate: WorkGateRecord | null;
  /** Approvals that a later scope change voided, newest first. */
  readonly invalidated: ReadonlyArray<WorkGateRecord>;
  readonly steps: ReadonlyArray<WorkApprovalStep>;
  /** Bound by guided waivers; only present when exactly one current specification gate exists. */
  readonly specificationHash: string | null;
  /** Records from a different project revision or duplicate current records block guided writes. */
  readonly blockedReason: string | null;
}

const granted = (status: string) => status === "approved" || status === "consumed";
const SHA256 = /^[a-f0-9]{64}$/u;

function gateStep(
  id: WorkApprovalStep["id"],
  label: string,
  revision: number,
  gate: WorkGateRecord | null,
  replaced: boolean,
): WorkApprovalStep {
  const base = { id, label, revision, gate, hash: gate?.contentHash ?? null };
  if (gate === null)
    return replaced
      ? { ...base, state: "stale", detail: "Scope changed after approval. Approve again." }
      : { ...base, state: "missing", detail: "No approval request recorded yet." };
  if (granted(gate.status)) return { ...base, state: "approved", detail: "Approved by a human." };
  if (gate.status === "rejected")
    return { ...base, state: "rejected", detail: "Rejected. Propose a revision." };
  return { ...base, state: "pending", detail: "Waiting for human approval." };
}

/**
 * Reads one task's revision-bound approval state from its context and its
 * task-filtered team records. This only explains what is recorded; the server
 * still decides whether each write is allowed.
 */
export function deriveWorkTask(input: {
  readonly context: ProjectWorkTaskContext;
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly recordsRevision: number | null;
}): WorkTaskModel {
  const { context } = input;
  const task = context.task;
  const records = input.records.filter(
    (record) =>
      "projectId" in record &&
      record.projectId === task.projectId &&
      "taskId" in record &&
      record.taskId === task.taskId,
  );
  const memberships = records.filter(isMembershipRecord).filter((r) => r.status === "active");
  const membership = memberships.length === 1 ? memberships[0]! : null;
  const guided = memberships.length > 0;
  const gates = records.filter(isGateRecord);
  const specGates = gates.filter(
    (gate) =>
      gate.gate === "specification" &&
      gate.specRevision === task.specRevision &&
      gate.status !== "invalidated",
  );
  const plans = records.filter(isPlanRecord).filter((plan) => plan.status === "proposed");
  const plan = plans.length === 1 ? plans[0]! : null;
  const planCurrent = plan !== null && plan.specRevision === task.specRevision;
  const planGates = plan
    ? gates.filter(
        (gate) =>
          gate.gate === "plan" &&
          gate.specRevision === task.specRevision &&
          gate.planRevision === plan.planRevision &&
          gate.status !== "invalidated",
      )
    : [];
  const specGate = specGates.length === 1 ? specGates[0]! : null;
  const planGate = planGates.length === 1 ? planGates[0]! : null;
  // Hermes has no Array#toSorted; filter already returns a fresh array.
  const invalidated = gates
    .filter((gate) => gate.status === "invalidated")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const controlState = membership?.controlState ?? "active";
  const terminal =
    task.state === "completed" ||
    task.state === "canceled" ||
    controlState === "canceled" ||
    controlState === "canceling";

  const blockedReason =
    memberships.length > 1 || specGates.length > 1 || plans.length > 1 || planGates.length > 1
      ? "More than one current approval record matches this task. Refresh before changing it."
      : guided && input.recordsRevision !== context.revision
        ? "Approval records are still catching up with this task."
        : null;

  const steps: WorkApprovalStep[] = [];
  if (guided) {
    steps.push(
      task.specification === undefined
        ? {
            id: "specification",
            label: "Scope",
            revision: null,
            state: "missing",
            detail: "Propose a specification.",
            gate: null,
            hash: null,
          }
        : gateStep(
            "specification",
            "Scope",
            task.specRevision,
            specGate,
            invalidated.some((gate) => gate.gate === "specification"),
          ),
    );
    steps.push(
      plan === null
        ? {
            id: "plan",
            label: "Plan",
            revision: null,
            state: "missing",
            detail: "Propose a plan after the scope.",
            gate: null,
            hash: null,
          }
        : !planCurrent
          ? {
              id: "plan",
              label: "Plan",
              revision: plan.planRevision,
              state: "stale",
              detail: `Written for scope revision ${plan.specRevision}. Propose it again.`,
              gate: null,
              hash: plan.contentHash,
            }
          : gateStep(
              "plan",
              "Plan",
              plan.planRevision,
              planGate,
              invalidated.some((gate) => gate.gate === "plan"),
            ),
    );
  } else {
    const approval = task.approval;
    steps.push({
      id: "specification",
      label: "Scope",
      revision: task.specification ? task.specRevision : null,
      gate: null,
      hash: null,
      ...(task.specification === undefined
        ? { state: "missing", detail: "Write a specification." }
        : approval === undefined
          ? { state: "pending", detail: "Waiting for human approval." }
          : approval.specRevision === task.specRevision
            ? { state: "approved", detail: "Approved by a human." }
            : {
                state: "stale",
                detail: `Approved revision ${approval.specRevision}; scope changed since.`,
              }),
    });
  }

  return {
    task,
    guided,
    membership,
    controlState,
    terminal,
    specGate,
    plan,
    planCurrent,
    planGate,
    invalidated,
    steps,
    specificationHash:
      specGate !== null && SHA256.test(specGate.contentHash) ? specGate.contentHash : null,
    blockedReason,
  };
}

/** Human steering only. None of these start or stop a worker. */
export function guidedControls(model: WorkTaskModel): ReadonlyArray<WorkGuidedControl> {
  if (!model.guided) return [];
  if (model.terminal) return ["reopen"];
  if (model.controlState === "paused" || model.controlState === "deferred")
    return ["resume", "cancel"];
  return ["pause", "defer", "cancel"];
}

export const GUIDED_CONTROL_LABELS: Record<WorkGuidedControl, string> = {
  pause: "Pause",
  resume: "Resume",
  defer: "Defer",
  cancel: "Cancel task",
  reopen: "Reopen",
};

/** Respond controls for one gate. Revoking reverses a recorded human decision. */
export function gateResponses(
  gate: WorkGateRecord | null,
): ReadonlyArray<"approved" | "rejected" | "invalidated"> {
  if (gate === null) return [];
  if (gate.status === "pending" || gate.status === "proposed") return ["approved", "rejected"];
  if (gate.status === "approved" || gate.status === "rejected") return ["invalidated"];
  return [];
}

export function workStateLabel(state: string): string {
  const label = state.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function workStateVariant(
  state: string,
): "secondary" | "success" | "warning" | "error" | "outline" | "info" {
  switch (state) {
    case "completed":
    case "approved":
    case "accepted":
      return "success";
    case "failed":
    case "blocked":
    case "rejected":
      return "error";
    case "in-progress":
    case "in-review":
    case "pending":
    case "stale":
    case "paused":
    case "deferred":
      return "warning";
    case "ready":
    case "specified":
    case "proposed":
      return "info";
    case "canceled":
    case "superseded":
      return "outline";
    default:
      return "secondary";
  }
}

const FAILURE_MESSAGES: Record<string, string> = {
  forbidden: "This connection is not allowed to change Work here.",
  rejected: "The server rejected this change. Someone may have changed the task; review it again.",
  unavailable: "Work is unavailable on this environment right now.",
  "invalid-request": "The server could not accept this change.",
};

/** Error text that says what happened and what the user can do next. */
export function describeWorkFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "ProjectWorkRpcError" && "reason" in error)
      return FAILURE_MESSAGES[String(error.reason)] ?? "The change failed.";
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection lacks permission to change Work on this environment.";
  }
  return error instanceof Error && error.message ? error.message : "The change failed.";
}

export function shortHash(hash: string | null): string | null {
  return hash === null ? null : hash.slice(0, 8);
}
