import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { applyProjectWorkEvents } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { invalidateReviewCriterionProgress } from "./ProjectTeamReviewCriterionProgress.ts";
import { evaluateReviewFindingTransition } from "./ProjectTeamReview.ts";
import {
  REVIEW_FINDING_RESOLUTION_MAX_EVENTS,
  REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES,
  REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES,
  prepareReviewFindingResolutionEvidence,
  reviewFindingResolutionHash,
  readReviewFindingResolutionEvidence,
} from "./ProjectTeamReviewResolutionRecords.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
const decode = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
const canonical = canonicalProjectWorkPayload;
const deny = (message: string): never => {
  throw new ProjectWorkPolicyError("authority-required", message);
};

/** The authenticated SQL compiler supplies successful retained repair proof before this transition. */
export function decideProjectTeamReviewResolution(
  state: ProjectWorkReducerState,
  raw: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
): ReadonlyArray<ProjectWorkEvent> {
  const command = decode(raw);
  const transition = command.transition;
  if (
    transition?.kind !== "review.resolve" ||
    command.guided !== undefined ||
    command.claim !== undefined ||
    command.records.length !== 0 ||
    command.projectId !== state.projectId ||
    command.expectedRevision !== state.revision ||
    command.attribution.actor.kind !== "agent" ||
    command.attribution.source.kind !== "mcp" ||
    command.attribution.source.id !== "project-work.report"
  )
    return deny("Finding resolution requires its unmixed private reviewer transition");
  const { finding, proof } = transition;
  const matches = (state.foundationRecords ?? []).filter(
    (r) =>
      r.recordId === finding.recordId ||
      (r.kind === "review-finding" &&
        r.taskId === finding.taskId &&
        r.findingId === finding.findingId),
  );
  const original = matches[0];
  if (
    Buffer.byteLength(canonical(finding), "utf8") > REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES ||
    (original?.kind === "review-finding" &&
      Buffer.byteLength(canonical(original), "utf8") > REVIEW_FINDING_RESOLUTION_MAX_FINDING_BYTES)
  )
    return deny("Finding resolution exceeds its retained finding byte bound");
  if (
    matches.length > 1 ||
    (original !== undefined && original.kind !== "review-finding") ||
    finding.status !== "resolved" ||
    finding.projectId !== state.projectId ||
    finding.reportedBy.targetSha256 !== proof.reviewTargetSha256 ||
    command.attribution.actor.id !==
      `agent:mcp:${finding.reportedBy.providerInstanceId}:${finding.reportedBy.threadId}` ||
    canonical(proof.artifacts.map((a) => a.artifactId)) !== canonical(finding.resolutionArtifactIds)
  )
    return deny("Finding resolution does not match its original finding and reviewer proof");
  if (original?.kind === "review-finding" && canonical(original) === canonical(finding)) {
    const retained = readReviewFindingResolutionEvidence({ state, finding });
    if (
      retained &&
      canonical(retained.detail.proof) === canonical(proof) &&
      canonical(retained.detail.reportAttribution.actor) === canonical(command.attribution.actor) &&
      canonical(retained.detail.reportAttribution.source) === canonical(command.attribution.source)
    )
      return [];
    return deny("Repeated finding resolution requires its exact retained repair receipt");
  }
  if (
    finding.updatedAt !== command.committedAt ||
    (original === undefined
      ? proof.prior !== undefined
      : proof.prior?.revision !== original.revision ||
        proof.prior.sha256 !== reviewFindingResolutionHash(original))
  )
    return deny("Finding resolution does not match its original finding and reviewer proof");
  const decision = evaluateReviewFindingTransition({
    target: proof.target,
    ...(original?.kind === "review-finding" ? { currentFinding: original } : {}),
    proposedFinding: finding,
    currentCriterionIds: state.criteria
      .filter((c) => c.taskId === finding.taskId)
      .map((c) => c.criterionId),
    retainedResolutionEvidence: proof.artifacts.map((a) => ({
      artifactId: a.artifactId,
      target: proof.target,
      findings: [{ findingId: finding.findingId, revision: finding.revision }],
    })),
  });
  if (decision.status !== "accepted")
    return deny("Finding resolution is not an exact new repair revision");
  const record = validateProjectTeamRecord(
    state,
    finding,
    command.attribution,
    undefined,
    undefined,
    undefined,
    undefined,
    transition,
  );
  const evidence = prepareReviewFindingResolutionEvidence({
    finding,
    proof,
    commandId: command.commandId,
    at: command.committedAt,
    attribution: command.attribution,
  });
  if (state.evidence.some((e) => e.evidenceId === evidence.evidenceId))
    return deny("Finding resolution evidence identity already exists");
  const events: ProjectWorkEvent[] = [];
  let working = state;
  const add = (draft: Draft) => {
    if (events.length >= REVIEW_FINDING_RESOLUTION_MAX_EVENTS)
      return deny("Finding resolution exceeds its retained event bound");
    if (!Number.isSafeInteger(state.revision + events.length + 1))
      return deny("Finding resolution event revision is exhausted");
    const next = event(draft, events.length);
    if (Buffer.byteLength(canonical(next), "utf8") > REVIEW_FINDING_RESOLUTION_MAX_EVENT_BYTES)
      return deny("Finding resolution exceeds its retained event byte bound");
    events.push(next);
    working = applyProjectWorkEvents(working, [next]);
  };
  add({ type: "project-work.foundation.recorded", record, occurredAt: command.committedAt });
  add({
    type: "project-work.evidence.added",
    evidence,
    addedAt: command.committedAt,
    occurredAt: command.committedAt,
  });
  for (const draft of invalidateReviewCriterionProgress({
    state: working,
    at: command.committedAt,
  }))
    add(draft);
  return events;
}
