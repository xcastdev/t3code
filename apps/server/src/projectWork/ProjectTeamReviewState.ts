// @effect-diagnostics-next-line nodeBuiltinImport:off -- Work proof snapshots use deterministic SHA-256 identities.
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  type ProjectTeamRunBinding,
  type ProjectTeamRecord,
  type ProjectTeamReviewFinding,
  type ProjectTeamReviewCompletionProof,
  type ProjectTeamReviewResolutionProof,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import type { ReviewSnapshot } from "./ProjectTeamReviewFreshness.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  projectTeamScopeHash,
  projectTeamSpecificationHash,
  projectTeamPlanHash,
} from "./ProjectTeamPolicy.ts";
export const reviewDigest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const stale = () => new ProjectWorkPolicyError("authority-required", "Review proof is stale");
export const records = (state: ProjectWorkReducerState) => state.foundationRecords ?? [];
export const binding = (state: ProjectWorkReducerState, id: string) =>
  records(state).find(
    (r): r is typeof ProjectTeamRunBinding.Type => r.kind === "run-binding" && r.recordId === id,
  );
export const configuration = (state: ProjectWorkReducerState) =>
  reviewDigest(
    records(state)
      .filter((r) => ["role-revision", "member", "limits"].includes(r.kind))
      .toSorted((a, b) => a.recordId.localeCompare(b.recordId)),
  );
export const reviewerConfiguration = (b: typeof ProjectTeamRunBinding.Type) =>
  reviewDigest({
    recordId: b.recordId,
    taskId: b.taskId,
    attemptId: b.attemptId,
    generation: b.generation,
    leaseGeneration: b.leaseGeneration,
    memberId: b.memberId,
    roleRevisionId: b.roleRevisionId,
    providerInstanceId: b.providerInstanceId,
    threadId: b.threadId,
    environmentId: b.environmentId,
    model: b.model,
    configuration: b.configuration,
    specRevision: b.specRevision,
    planRevision: b.planRevision,
    scopeHash: b.scopeHash,
  });
const plan = (state: ProjectWorkReducerState, taskId: string) =>
  records(state)
    .filter(
      (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
        r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed",
    )
    .toSorted((a, b) => b.planRevision - a.planRevision)[0];
export const reviewTaskScope = (state: ProjectWorkReducerState, taskId: string) =>
  reviewDigest({
    specificationHash: projectTeamSpecificationHash(state, taskId),
    plan: plan(state, taskId),
    criteria: state.criteria
      .filter((c) => c.taskId === taskId)
      .toSorted((a, b) => a.criterionId.localeCompare(b.criterionId)),
  });
export const assertReviewSnapshotState = (state: ProjectWorkReducerState, s: ReviewSnapshot) => {
  const reviewer = binding(state, s.reviewBindingId);
  const source = binding(state, s.source.recordId);
  const assignment = records(state).find(
    (r) => r.kind === "task-membership" && r.recordId === s.assignment.recordId,
  );
  const task = state.tasks.find((t) => t.taskId === s.manifest.taskId);
  const criteria = state.criteria
    .filter((c) => c.taskId === s.manifest.taskId)
    .toSorted((a, b) => a.criterionId.localeCompare(b.criterionId));
  const currentPlan = plan(state, s.manifest.taskId);
  if (
    state.projectId !== s.projectId ||
    reviewer === undefined ||
    source === undefined ||
    reviewerConfiguration(reviewer) !== s.reviewerConfigurationHash ||
    reviewTaskScope(state, reviewer.taskId) !== s.reviewScopeHash ||
    !["reserved", "running", "stopping", "settled"].includes(reviewer.status) ||
    reviewDigest(source) !== reviewDigest(s.source) ||
    reviewDigest(assignment) !== reviewDigest(s.assignment) ||
    reviewDigest(records(state).find((r) => r.recordId === s.sourceAssignment.recordId)) !==
      reviewDigest(s.sourceAssignment) ||
    assignment?.kind !== "task-membership" ||
    assignment.status !== "active" ||
    (assignment.controlState !== undefined && assignment.controlState !== "active") ||
    task === undefined ||
    task.specRevision !== s.manifest.specRevision ||
    ["canceled", "failed"].includes(task.state) ||
    projectTeamSpecificationHash(state, task.taskId) !== s.manifest.specificationHash ||
    (currentPlan?.planRevision ?? 0) !== s.manifest.planRevision ||
    currentPlan === undefined ||
    projectTeamPlanHash(currentPlan) !== s.manifest.planHash ||
    projectTeamScopeHash(state, task.taskId, currentPlan) !== source.scopeHash ||
    reviewDigest(criteria) !== reviewDigest(s.criteria) ||
    configuration(state) !== s.configurationHash ||
    records(state).some(
      (r) =>
        r.kind === "run-binding" &&
        ((r.taskId === source.taskId && r.generation > source.generation) ||
          (r.taskId === reviewer.taskId && r.generation > reviewer.generation)),
    )
  )
    throw stale();
};
/** The reducer accepts only the host's retained proof, with every evidence and finding snapshot intact. */
export function assertReviewCompletionProof(
  state: ProjectWorkReducerState,
  proof: ProjectTeamReviewCompletionProof,
): asserts proof is Extract<ProjectTeamReviewCompletionProof, { status: "completed" }> {
  if (
    proof.status !== "completed" ||
    proof.report.type !== "project-team.assignment.report" ||
    proof.report.outcome !== "complete" ||
    reviewDigest(proof.report) !== proof.proposalSha256
  )
    throw stale();
  const b = binding(state, proof.provenance.bindingId);
  if (
    b === undefined ||
    b.generation !== proof.provenance.generation ||
    b.threadId !== proof.provenance.threadId ||
    b.runId !== proof.provenance.runId ||
    b.runAttemptId !== proof.provenance.runAttemptId ||
    b.nodeId !== proof.provenance.nodeId ||
    b.sessionId !== proof.provenance.sessionId ||
    b.memberId !== proof.provenance.memberId ||
    !["running", "stopping"].includes(b.status) ||
    proof.report.taskId !== b.taskId ||
    proof.assignment.taskId !== b.taskId ||
    proof.assignment.parentTaskId !== proof.target.taskId
  )
    throw stale();
  const assignment = records(state).find(
    (r) => r.kind === "task-membership" && r.recordId === proof.assignment.recordId,
  );
  if (reviewDigest(assignment) !== reviewDigest(proof.assignment)) throw stale();
  for (const c of proof.criteria) {
    const current = state.criteria.find((v) => v.criterionId === c.id);
    if (
      current === undefined ||
      current.revision !== c.revision ||
      reviewDigest(current) !== c.sha256
    )
      throw stale();
  }
  for (const e of proof.evidence) {
    const current = state.evidence.find((v) => v.evidenceId === e.id);
    if (
      current === undefined ||
      current.revision !== e.revision ||
      reviewDigest(current) !== e.sha256
    )
      throw stale();
  }
  const findings = records(state).filter(
    (r): r is ProjectTeamReviewFinding =>
      r.kind === "review-finding" && r.taskId === proof.target.taskId,
  );
  if (
    findings.length !== proof.findings.length ||
    findings.some(
      (f) =>
        f.status !== "resolved" ||
        f.reportedBy.targetSha256 !== proof.provenance.targetSha256 ||
        !proof.findings.some(
          (p) =>
            p.findingId === f.findingId &&
            p.revision === f.revision &&
            p.sha256 === reviewDigest(f),
        ),
    )
  )
    throw stale();
}
export function reviewCompletionDrafts(
  state: ProjectWorkReducerState,
  proof: ProjectTeamReviewCompletionProof,
  at: string,
): ReadonlyArray<
  Omit<
    Extract<ProjectWorkEvent, { type: "project-work.task.completed" }>,
    "eventId" | "projectId" | "revision"
  >
> {
  assertReviewCompletionProof(state, proof);
  return [
    {
      type: "project-work.task.completed",
      taskId: proof.assignment.taskId,
      satisfiedCriterionIds: [],
      completedAt: at,
      occurredAt: at,
    },
  ];
}
export function assertReviewResolution(
  state: ProjectWorkReducerState,
  finding: ProjectTeamReviewFinding,
  proof: ProjectTeamReviewResolutionProof,
): void {
  const prior = records(state).find(
    (r): r is ProjectTeamReviewFinding =>
      r.kind === "review-finding" && r.recordId === finding.recordId,
  );
  const b = binding(state, finding.reportedBy.bindingId);
  if (
    prior === undefined ||
    proof.prior?.revision !== prior.revision ||
    proof.prior.sha256 !== reviewDigest(prior) ||
    finding.revision !== prior.revision + 1 ||
    (prior.status !== "open" && prior.reportedBy.targetSha256 === proof.reviewTargetSha256) ||
    finding.status !== "resolved" ||
    reviewDigest(finding.originReviewer) !== reviewDigest(prior.originReviewer) ||
    finding.originReviewer.bindingId === finding.reportedBy.bindingId ||
    b?.status !== "running" ||
    b.generation !== finding.reportedBy.generation ||
    b.memberId !== finding.reportedBy.memberId ||
    finding.reportedBy.targetSha256 !== proof.reviewTargetSha256 ||
    proof.target.taskId !== finding.taskId ||
    proof.target.projectId !== finding.projectId ||
    proof.artifacts.length !== finding.resolutionArtifactIds.length ||
    proof.artifacts.some((a) => !finding.resolutionArtifactIds.includes(a.artifactId))
  )
    throw stale();
}

export function assertReviewFindingCurrent(
  state: ProjectWorkReducerState,
  finding: ProjectTeamReviewFinding,
  attribution: ProjectWorkAttribution,
): void {
  const p = finding.reportedBy;
  const b = binding(state, p.bindingId);
  const member = records(state).find((r) => r.kind === "member" && r.recordId === p.memberId);
  const role = records(state).find(
    (r) => r.kind === "role-revision" && r.recordId === b?.roleRevisionId,
  );
  const assignment = records(state).find(
    (r) => r.kind === "task-membership" && r.taskId === b?.taskId,
  );
  const task = state.tasks.find((t) => t.taskId === finding.taskId);
  const currentPlan = plan(state, finding.taskId);
  if (
    finding.projectId !== state.projectId ||
    finding.target.projectId !== state.projectId ||
    finding.target.taskId !== finding.taskId ||
    finding.status !== "open" ||
    finding.resolutionArtifactIds.length !== 0 ||
    reviewDigest(finding.originReviewer) !== reviewDigest(p) ||
    attribution.actor.kind !== "agent" ||
    attribution.actor.id !== p.threadId ||
    attribution.source.kind !== "mcp" ||
    attribution.source.id !== p.sessionId ||
    b === undefined ||
    b.status !== "running" ||
    b.generation !== p.generation ||
    b.leaseGeneration !== p.generation ||
    b.memberId !== p.memberId ||
    b.providerInstanceId !== p.providerInstanceId ||
    b.threadId !== p.threadId ||
    b.runId !== p.runId ||
    b.runAttemptId !== p.runAttemptId ||
    b.nodeId !== p.nodeId ||
    b.sessionId !== p.sessionId ||
    member?.kind !== "member" ||
    member.status !== "active" ||
    member.roleRevisionId !== b.roleRevisionId ||
    role?.kind !== "role-revision" ||
    role.role !== "reviewer" ||
    role.status !== "available" ||
    assignment?.kind !== "task-membership" ||
    assignment.status !== "active" ||
    assignment.deliverableKind !== "review" ||
    assignment.parentTaskId !== finding.taskId ||
    (assignment.controlState !== undefined && assignment.controlState !== "active") ||
    task?.specRevision !== finding.target.specRevision ||
    (currentPlan?.planRevision ?? 0) !== finding.target.planRevision ||
    finding.criterionIds.some(
      (id) => !state.criteria.some((c) => c.taskId === finding.taskId && c.criterionId === id),
    )
  )
    throw stale();
  const prior = records(state).find(
    (r): r is ProjectTeamReviewFinding =>
      r.kind === "review-finding" && r.recordId === finding.recordId,
  );
  if (
    finding.revision !== (prior === undefined ? 0 : prior.revision + 1) ||
    (prior !== undefined &&
      (prior.status !== "open" ||
        reviewDigest(prior.originReviewer) !== reviewDigest(finding.originReviewer)))
  )
    throw stale();
}
