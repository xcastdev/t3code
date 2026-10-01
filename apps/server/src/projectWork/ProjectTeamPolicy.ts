import type { ProjectTeamRecord, ProjectWorkTask } from "@t3tools/contracts";

type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
export type ProjectTeamGateTarget = Pick<
  Gate,
  | "projectId"
  | "taskId"
  | "gate"
  | "specRevision"
  | "planRevision"
  | "contentHash"
  | "evidenceIds"
  | "repository"
  | "pullRequestNumber"
  | "headSha"
  | "targetBranch"
  | "mergeMethod"
>;

type ProjectTeamPolicyReason =
  | "missing-gate"
  | "gate-not-approved"
  | "human-approval-required"
  | "stale-gate-target"
  | "invalid-gate-evidence"
  | "stale-gate-evidence"
  | "invalid-merge-target"
  | "stale-merge-target"
  | "missing-dependency"
  | "dependency-project-mismatch"
  | "dependency-task-mismatch"
  | "dependency-not-completed"
  | "dependency-membership-removed"
  | "ambiguous-dependency-membership"
  | "delivery-proof-required";

export type ProjectTeamPolicyResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: ProjectTeamPolicyReason };

const unavailable = (reason: ProjectTeamPolicyReason): ProjectTeamPolicyResult => ({
  available: false,
  reason,
});
const validText = (text: string | undefined) =>
  text !== undefined && text.length > 0 && text.length <= 4_000 && text === text.trim();
const validEvidenceIds = (ids: ReadonlyArray<string>) =>
  ids.length <= 64 &&
  new Set(ids).size === ids.length &&
  ids.every((id) => validText(id) && id.length <= 256);
const validMergeTarget = (target: ProjectTeamGateTarget) =>
  validText(target.repository) &&
  validText(target.headSha) &&
  validText(target.targetBranch) &&
  target.pullRequestNumber !== undefined &&
  Number.isSafeInteger(target.pullRequestNumber) &&
  target.pullRequestNumber > 0 &&
  (target.mergeMethod === "merge" ||
    target.mergeMethod === "squash" ||
    target.mergeMethod === "rebase");

/** The caller resolves the current target and content hash from trusted server authority. */
export const evaluateProjectTeamGate = (
  gate: Gate | undefined,
  target: ProjectTeamGateTarget,
): ProjectTeamPolicyResult => {
  if (gate === undefined) return unavailable("missing-gate");
  if (gate.status !== "approved") return unavailable("gate-not-approved");
  if (gate.attribution.actor.kind !== "human") return unavailable("human-approval-required");
  if (
    gate.projectId !== target.projectId ||
    gate.taskId !== target.taskId ||
    gate.gate !== target.gate ||
    gate.specRevision !== target.specRevision ||
    gate.planRevision !== target.planRevision ||
    gate.contentHash !== target.contentHash
  ) {
    return unavailable("stale-gate-target");
  }
  if (!validEvidenceIds(gate.evidenceIds) || !validEvidenceIds(target.evidenceIds)) {
    return unavailable("invalid-gate-evidence");
  }
  const expectedEvidence = new Set(target.evidenceIds);
  if (
    gate.evidenceIds.length !== expectedEvidence.size ||
    gate.evidenceIds.some((id) => !expectedEvidence.has(id))
  ) {
    return unavailable("stale-gate-evidence");
  }
  if (target.gate === "merge") {
    if (!validMergeTarget(gate) || !validMergeTarget(target)) {
      return unavailable("invalid-merge-target");
    }
    if (
      gate.repository !== target.repository ||
      gate.pullRequestNumber !== target.pullRequestNumber ||
      gate.headSha !== target.headSha ||
      gate.targetBranch !== target.targetBranch ||
      gate.mergeMethod !== target.mergeMethod
    ) {
      return unavailable("stale-merge-target");
    }
  }
  return { available: true };
};

/** Managed code needs a future authoritative delivery receipt; completion or approval cannot prove merge. */
export const evaluateProjectTeamDependency = (input: {
  readonly projectId: ProjectWorkTask["projectId"];
  readonly taskId: ProjectWorkTask["taskId"];
  readonly task: ProjectWorkTask | undefined;
  readonly memberships: ReadonlyArray<Membership>;
}): ProjectTeamPolicyResult => {
  const { task, taskId, projectId } = input;
  if (task === undefined) return unavailable("missing-dependency");
  if (task.projectId !== projectId) return unavailable("dependency-project-mismatch");
  if (task.taskId !== taskId) return unavailable("dependency-task-mismatch");
  const memberships = input.memberships.filter((membership) => membership.taskId === taskId);
  if (memberships.some((membership) => membership.projectId !== projectId)) {
    return unavailable("dependency-project-mismatch");
  }
  if (memberships.length > 1) return unavailable("ambiguous-dependency-membership");
  const membership = memberships[0];
  if (membership?.status === "removed") return unavailable("dependency-membership-removed");
  if (task.state !== "completed") return unavailable("dependency-not-completed");
  if (membership?.executionKind === "managed" && membership.deliverableKind === "code") {
    return unavailable("delivery-proof-required");
  }
  return { available: true };
};
