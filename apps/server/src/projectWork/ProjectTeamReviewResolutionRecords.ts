import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  canonicalProjectWorkPayload,
  ProjectTeamReviewFinding,
  ProjectTeamReviewResolutionProof,
  ProjectWorkAttribution,
  ProjectWorkEvidence,
} from "@t3tools/contracts";
import { ProjectWorkPolicyError, type ProjectWorkState } from "./ProjectWorkPolicy.ts";

export const REVIEW_FINDING_RESOLUTION_MAX_EVENTS = 512;
export const REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES = 262144;
export const REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES = 524288;

const canonical = canonicalProjectWorkPayload;
export const reviewFindingResolutionHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const producer = "project-team-review-finding-resolution";
const prefix = "review-finding-resolution:";
const strict = { onExcessProperty: "error" } as const;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ProjectTeamReviewResolutionDetail = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-team.review-finding-resolution"),
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  findingRecordId: ProjectTeamReviewFinding.fields.recordId,
  findingRevision: ProjectTeamReviewFinding.fields.revision,
  findingSha256: Digest,
  proof: ProjectTeamReviewResolutionProof,
  reportAttribution: ProjectWorkAttribution,
});
const decodeDetail = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectTeamReviewResolutionDetail),
  strict,
);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
type Finding = ProjectTeamReviewFinding;
type Target = Finding["target"];

export const reviewFindingResolutionEvidenceId = (
  finding: Finding,
  proof: ProjectTeamReviewResolutionProof,
) =>
  prefix +
  reviewFindingResolutionHash({
    recordId: finding.recordId,
    revision: finding.revision,
    findingSha256: reviewFindingResolutionHash(finding),
    proofSha256: reviewFindingResolutionHash(proof),
  });

/** The private transition records a repair judgment, never parent completion or approval. */
export function prepareReviewFindingResolutionEvidence(input: {
  finding: Finding;
  proof: ProjectTeamReviewResolutionProof;
  commandId: string;
  at: string;
  attribution: ProjectWorkAttribution;
}) {
  const { finding, proof } = input;
  const detail = canonical({
    version: 1,
    kind: "project-team.review-finding-resolution",
    commandId: input.commandId,
    findingRecordId: finding.recordId,
    findingRevision: finding.revision,
    findingSha256: reviewFindingResolutionHash(finding),
    proof,
    reportAttribution: input.attribution,
  });
  decodeDetail(detail);
  return decodeEvidence({
    evidenceId: reviewFindingResolutionEvidenceId(finding, proof),
    taskId: finding.taskId,
    kind: "review",
    summary: `Resolved review finding ${finding.findingId}`,
    detail,
    outputArtifactIds: proof.artifacts.map((a) => a.artifactId),
    recordedAt: input.at,
    revision: 0,
    attribution: {
      actor: { kind: "system", id: producer },
      source: { kind: "system", id: producer },
      recordedAt: input.at,
    },
  });
}

export function parseReviewFindingResolutionEvidence(entry: ProjectWorkEvidence) {
  if (
    !entry.evidenceId.startsWith(prefix) ||
    entry.kind !== "review" ||
    entry.attribution?.actor.kind !== "system" ||
    entry.attribution.actor.id !== producer ||
    entry.attribution.source.kind !== "system" ||
    entry.attribution.source.id !== producer ||
    !entry.detail
  )
    return undefined;
  try {
    const detail = decodeDetail(entry.detail);
    if (canonical(detail) !== entry.detail) return undefined;
    return { evidence: entry, detail };
  } catch {
    return undefined;
  }
}

function matches(
  finding: Finding,
  value: NonNullable<ReturnType<typeof parseReviewFindingResolutionEvidence>>,
) {
  const { evidence, detail } = value;
  return (
    finding.status === "resolved" &&
    detail.findingRecordId === finding.recordId &&
    detail.findingRevision === finding.revision &&
    detail.findingSha256 === reviewFindingResolutionHash(finding) &&
    detail.proof.reviewTargetSha256 === finding.reportedBy.targetSha256 &&
    detail.proof.target.projectId === finding.projectId &&
    detail.proof.target.taskId === finding.taskId &&
    detail.proof.target.specRevision === finding.target.specRevision &&
    detail.proof.target.planRevision === finding.target.planRevision &&
    canonical(detail.proof.artifacts.map((a) => a.artifactId)) ===
      canonical(finding.resolutionArtifactIds) &&
    canonical(evidence) ===
      canonical(
        prepareReviewFindingResolutionEvidence({
          finding,
          proof: detail.proof,
          commandId: detail.commandId,
          at: finding.updatedAt,
          attribution: detail.reportAttribution,
        }),
      )
  );
}

/** Structural association for pure reducers. SQL readers additionally audit its original receipt. */
export function indexReviewFindings(
  state: Pick<ProjectWorkState, "foundationRecords" | "evidence">,
) {
  const receipts = new Map<
    string,
    Array<NonNullable<ReturnType<typeof parseReviewFindingResolutionEvidence>>>
  >();
  for (const evidence of state.evidence) {
    const value = parseReviewFindingResolutionEvidence(evidence);
    if (!value) continue;
    const entries = receipts.get(value.detail.findingRecordId) ?? [];
    entries.push(value);
    receipts.set(value.detail.findingRecordId, entries);
  }
  const byTarget = new Map<
    string,
    Array<{
      finding: Finding;
      receipt?: NonNullable<ReturnType<typeof parseReviewFindingResolutionEvidence>>;
    }>
  >();
  for (const finding of state.foundationRecords ?? []) {
    if (finding.kind !== "review-finding") continue;
    const candidates = (receipts.get(finding.recordId) ?? []).filter((r) => matches(finding, r));
    const resolution = candidates.length === 1 ? candidates[0] : undefined;
    const keys = new Set([canonical(finding.target)]);
    if (resolution) keys.add(canonical(resolution.detail.proof.target));
    for (const key of keys) {
      const entries = byTarget.get(key) ?? [];
      entries.push({ finding, ...(resolution ? { receipt: resolution } : {}) });
      byTarget.set(key, entries);
    }
  }
  return { byTarget, receipts };
}

export function selectReviewFindings(
  index: ReturnType<typeof indexReviewFindings>,
  target: Target,
  criterionId?: string,
) {
  const selected = (index.byTarget.get(canonical(target)) ?? []).filter(
    ({ finding }) =>
      criterionId === undefined ||
      finding.criterionIds.some((id) => id === criterionId) ||
      finding.severity === "critical",
  );
  if (
    selected.length > 256 ||
    new Set(selected.map(({ finding }) => finding.findingId)).size !== selected.length
  )
    throw new ProjectWorkPolicyError(
      "invalid-state",
      "Review findings are ambiguous or exceed their bound",
    );
  return {
    records: selected.map(({ finding }) => finding),
    snapshots: selected
      .map(({ finding, receipt }) => ({
        findingId: finding.findingId,
        revision: finding.revision,
        sha256: receipt
          ? reviewFindingResolutionHash({ finding, receipt: receipt.evidence })
          : reviewFindingResolutionHash(finding),
      }))
      .sort((a, b) => a.findingId.localeCompare(b.findingId)),
  };
}

export function readReviewFindingResolutionEvidence(input: {
  state: Pick<ProjectWorkState, "foundationRecords" | "evidence">;
  finding: Finding;
}) {
  const candidates = (
    indexReviewFindings(input.state).receipts.get(input.finding.recordId) ?? []
  ).filter((r) => matches(input.finding, r));
  return candidates.length === 1 ? candidates[0] : undefined;
}
