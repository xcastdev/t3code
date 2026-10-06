import { ProjectTeamEvidenceApplicability } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type Evidence = typeof ProjectTeamEvidenceApplicability.Type;
const fields = ProjectTeamEvidenceApplicability.fields;
const hasContent = Schema.is(Schema.String.check(Schema.isPattern(/\S/u)));
const Target = Schema.Struct({
  projectId: fields.projectId,
  taskId: fields.taskId,
  specRevision: fields.specRevision,
  planRevision: fields.planRevision,
  repository: fields.repository,
  worktree: fields.worktree,
  testedTree: fields.testedTree,
  testedCommit: Schema.requiredKey(fields.testedCommit),
  baseSha: fields.baseSha,
  headSha: fields.headSha,
  environmentSummary: fields.environmentSummary.check(Schema.isPattern(/\S/u)),
});
const isEvidence = Schema.is(ProjectTeamEvidenceApplicability);
const isTarget = Schema.is(Target);

export type CommittedEvidenceTarget = typeof Target.Type;
export interface CommittedEvidenceInput {
  readonly evidence: Evidence;
  readonly target: CommittedEvidenceTarget;
  readonly retainedArtifactIds: ReadonlySet<string>;
  readonly requireIntegration: boolean;
}
export type CommittedEvidenceRejectionReason =
  | "invalid-evidence"
  | "invalid-target"
  | "evidence-not-current"
  | "command-failed"
  | "command-missing"
  | "artifact-missing"
  | "artifact-not-retained"
  | "environment-missing"
  | "project-mismatch"
  | "task-mismatch"
  | "spec-mismatch"
  | "plan-mismatch"
  | "repository-mismatch"
  | "worktree-mismatch"
  | "tested-tree-mismatch"
  | "tested-commit-missing"
  | "tested-commit-mismatch"
  | "base-mismatch"
  | "head-mismatch"
  | "environment-mismatch"
  | "integration-required";
export type CommittedEvidenceResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly reasons: ReadonlyArray<CommittedEvidenceRejectionReason>;
    };

/** Callers must supply an authorized current snapshot and trusted artifact retention IDs. */
export function evaluateCommittedEvidence(input: CommittedEvidenceInput): CommittedEvidenceResult {
  const { evidence, target } = input;
  // Type guards validate without applying the contracts' trimming transformations.
  const validEvidence = isEvidence(evidence);
  const validTarget = isTarget(target);
  if (!validEvidence || !validTarget) {
    const reasons: CommittedEvidenceRejectionReason[] = [];
    if (!validEvidence) reasons.push("invalid-evidence");
    if (!validTarget) reasons.push("invalid-target");
    return { status: "rejected", reasons };
  }
  const reasons: CommittedEvidenceRejectionReason[] = [];
  if (evidence.status !== "current") reasons.push("evidence-not-current");
  if (evidence.exitCode !== 0) reasons.push("command-failed");
  if (!hasContent(evidence.command)) reasons.push("command-missing");
  if (!hasContent(evidence.artifactId)) reasons.push("artifact-missing");
  if (!input.retainedArtifactIds.has(evidence.artifactId)) reasons.push("artifact-not-retained");
  if (!hasContent(evidence.environmentSummary)) reasons.push("environment-missing");
  if (evidence.projectId !== target.projectId) reasons.push("project-mismatch");
  if (evidence.taskId !== target.taskId) reasons.push("task-mismatch");
  if (evidence.specRevision !== target.specRevision) reasons.push("spec-mismatch");
  if (evidence.planRevision !== target.planRevision) reasons.push("plan-mismatch");
  if (evidence.repository !== target.repository) reasons.push("repository-mismatch");
  if (evidence.worktree !== target.worktree) reasons.push("worktree-mismatch");
  if (evidence.testedTree !== target.testedTree) reasons.push("tested-tree-mismatch");
  if (evidence.testedCommit === undefined) reasons.push("tested-commit-missing");
  else if (evidence.testedCommit !== target.testedCommit) reasons.push("tested-commit-mismatch");
  if (evidence.baseSha !== target.baseSha) reasons.push("base-mismatch");
  if (evidence.headSha !== target.headSha) reasons.push("head-mismatch");
  if (evidence.environmentSummary !== target.environmentSummary)
    reasons.push("environment-mismatch");
  if (input.requireIntegration && !evidence.integration) reasons.push("integration-required");
  return reasons.length === 0 ? { status: "accepted" } : { status: "rejected", reasons };
}
