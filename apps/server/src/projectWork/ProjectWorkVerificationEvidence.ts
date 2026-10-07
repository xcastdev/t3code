import {
  canonicalProjectWorkPayload,
  ProjectWorkEvidenceAddCommand,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { evaluateCommittedEvidence } from "./ProjectWorkEvidencePolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import type {
  RetainedVerificationResult,
  VerificationExecutionIntent,
} from "./ProjectWorkVerificationExecutionJournal.ts";

const canonical = canonicalProjectWorkPayload;
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidenceAddCommand, {
  onExcessProperty: "error",
});
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
const deny = () => new ProjectWorkPolicyError("invalid-state", "Verification evidence changed");

/** Private command construction inside the original host-observed completion
 * transaction, after the journal has rehashed both retained output channels.
 * This function does not establish host provenance or criterion satisfaction. */
export function prepareVerificationEvidence(
  state: ProjectWorkReducerState,
  intent: Pick<VerificationExecutionIntent, "receipt">,
  result: RetainedVerificationResult,
) {
  const job = intent.receipt.manifest;
  const plans = (state.foundationRecords ?? []).filter(
    (record) =>
      record.kind === "plan-revision" &&
      record.taskId === job.taskId &&
      record.planRevision === job.planRevision &&
      record.specRevision === job.specRevision &&
      record.status === "proposed",
  );
  const plan = plans[0];
  if (
    result.outcome !== "success" ||
    result.exitCode !== 0 ||
    state.projectId !== job.projectId ||
    plans.length !== 1 ||
    plan?.kind !== "plan-revision"
  )
    throw deny();
  const scopeHash = projectTeamScopeHash(state, job.taskId, plan);
  const identity = {
    environmentId: job.environmentId,
    projectId: job.projectId,
    taskId: job.taskId,
    jobId: job.jobId,
    attemptId: result.attemptId,
    manifestHash: intent.receipt.sha256,
  };
  const id = (domain: string) => "verification:" + digest({ domain, identity });
  const at = DateTime.formatIso(DateTime.makeUnsafe(result.finishedAtMs));
  const attribution = {
    actor: { kind: "system", id: "project-team-verification" },
    source: { kind: "system", id: "project-team-verification" },
    recordedAt: at,
  } as const;
  const evidence = decodeEvidence({
    type: "project-work.evidence.add",
    projectId: job.projectId,
    commandId: id("evidence-command"),
    expectedRevision: state.revision,
    attribution,
    addedAt: at,
    evidence: {
      evidenceId: id("test-evidence"),
      taskId: job.taskId,
      kind: "test",
      summary: "Verification command completed with exit code 0 and both output channels retained.",
      detail: canonical({
        jobId: job.jobId,
        manifestHash: intent.receipt.sha256,
        attemptId: result.attemptId,
        resultHash: digest(result),
        criteriaHash: digest(job.criteria),
        criterionCount: job.criteria.length,
      }),
      scopeHash,
      outputArtifactIds: [result.stdout.artifactId, result.stderr.artifactId],
      recordedAt: at,
      revision: 0,
      attribution,
    },
  });
  const applicability = decodeCommit({
    type: "project-work.foundation.commit",
    projectId: job.projectId,
    commandId: id("applicability-command"),
    expectedRevision: state.revision + 1,
    attribution,
    committedAt: at,
    records: [
      {
        kind: "evidence-applicability",
        projectId: job.projectId,
        recordId: id("test-applicability"),
        revision: 0,
        generation: job.generation,
        updatedAt: at,
        status: "current",
        taskId: job.taskId,
        evidenceId: evidence.evidence.evidenceId,
        specRevision: job.specRevision,
        planRevision: job.planRevision,
        repository: job.target.repository,
        worktree: job.target.worktree,
        testedTree: job.target.testedTree,
        testedCommit: job.target.testedCommit,
        baseSha: job.target.baseSha,
        headSha: job.target.headSha,
        command: canonical({ executable: job.command.executable, argv: job.command.argv }),
        exitCode: 0,
        artifactId: result.stdout.artifactId,
        environmentSummary: result.environmentSummary,
        integration: job.integration === true,
        scopeHash,
      },
    ],
  });
  return { evidence, applicability, scopeHash };
}

export function assertVerificationEvidence(
  state: ProjectWorkReducerState,
  prepared: ReturnType<typeof prepareVerificationEvidence>,
  intent: Pick<VerificationExecutionIntent, "receipt">,
  result: RetainedVerificationResult,
) {
  const expected = prepared.applicability.records[0];
  const evidence = state.evidence.filter(
    (entry) => entry.evidenceId === prepared.evidence.evidence.evidenceId,
  );
  const records = (state.foundationRecords ?? []).filter(
    (entry) => entry.recordId === expected?.recordId,
  );
  const actual = records[0];
  if (
    evidence.length !== 1 ||
    records.length !== 1 ||
    actual?.kind !== "evidence-applicability" ||
    canonical(evidence[0]) !== canonical(prepared.evidence.evidence) ||
    canonical(actual) !== canonical(expected) ||
    prepareVerificationEvidence(state, intent, result).scopeHash !== prepared.scopeHash ||
    evaluateCommittedEvidence({
      evidence: actual,
      target: {
        projectId: intent.receipt.manifest.projectId,
        taskId: intent.receipt.manifest.taskId,
        specRevision: intent.receipt.manifest.specRevision,
        planRevision: intent.receipt.manifest.planRevision,
        ...intent.receipt.manifest.target,
        environmentSummary: result.environmentSummary,
      },
      retainedArtifactIds: new Set([result.stdout.artifactId, result.stderr.artifactId]),
      requireIntegration: false,
    }).status !== "accepted"
  )
    throw deny();
}
