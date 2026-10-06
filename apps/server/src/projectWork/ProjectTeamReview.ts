import { ProjectId, ProjectWorkTaskId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const exactText = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter((value) => value === value.trim()),
  );
const Id = exactText(256);
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Target = Schema.Struct({
  projectId: ProjectId.check(
    Schema.isMaxLength(256),
    Schema.makeFilter((v) => v === v.trim()),
  ),
  taskId: ProjectWorkTaskId.check(
    Schema.isMaxLength(256),
    Schema.makeFilter((v) => v === v.trim()),
  ),
  specRevision: Revision,
  planRevision: Revision,
  baseSha: exactText(4_000),
  headSha: exactText(4_000),
});
const Identity = Schema.Struct({
  memberId: Id,
  runId: Id,
  threadId: ThreadId.check(
    Schema.isMaxLength(256),
    Schema.makeFilter((v) => v === v.trim()),
  ),
  providerInstanceId: ProviderInstanceId.check(
    Schema.isMaxLength(256),
    Schema.makeFilter((v) => v === v.trim()),
  ),
  sessionId: Id,
});
const SessionInput = Schema.Struct({
  target: Target,
  reviewer: Schema.Struct({ target: Target, identity: Identity }),
  implementers: Schema.Array(Identity).check(Schema.isMaxLength(256)),
  sessionObservation: Schema.Struct({
    identity: Identity,
    fresh: Schema.Boolean,
    resumed: Schema.Boolean,
    conversationHistoryPresent: Schema.Boolean,
  }),
});
export type ReviewTarget = typeof Target.Type;
export type ReviewSessionInput = typeof SessionInput.Type;
type SessionRejection =
  | "invalid-input"
  | "stale-review-target"
  | "session-observation-mismatch"
  | "fresh-session-required"
  | "implementer-member"
  | "implementer-run"
  | "implementer-thread"
  | "implementer-session";
export type ReviewSessionResult =
  | { readonly status: "eligible" }
  | { readonly status: "rejected"; readonly reason: SessionRejection };

const isSessionInput = Schema.is(SessionInput);
const sameTarget = (a: ReviewTarget, b: ReviewTarget) =>
  a.projectId === b.projectId &&
  a.taskId === b.taskId &&
  a.specRevision === b.specRevision &&
  a.planRevision === b.planRevision &&
  a.baseSha === b.baseSha &&
  a.headSha === b.headSha;
const sameIdentity = (a: typeof Identity.Type, b: typeof Identity.Type) =>
  a.memberId === b.memberId &&
  a.runId === b.runId &&
  a.threadId === b.threadId &&
  a.providerInstanceId === b.providerInstanceId &&
  a.sessionId === b.sessionId;

/** Eligibility only: callers establish run authority and supply trusted host observations. */
export const evaluateReviewSessionEligibility = (input: unknown): ReviewSessionResult => {
  // Guards inspect original values without the contracts' trimming transformations.
  if (!isSessionInput(input)) return { status: "rejected", reason: "invalid-input" };
  if (!sameTarget(input.target, input.reviewer.target))
    return { status: "rejected", reason: "stale-review-target" };
  const identity = input.reviewer.identity;
  const observation = input.sessionObservation;
  if (!sameIdentity(identity, observation.identity))
    return { status: "rejected", reason: "session-observation-mismatch" };
  if (!observation.fresh || observation.resumed || observation.conversationHistoryPresent)
    return { status: "rejected", reason: "fresh-session-required" };
  for (const implementer of input.implementers) {
    if (identity.memberId === implementer.memberId)
      return { status: "rejected", reason: "implementer-member" };
    if (identity.runId === implementer.runId)
      return { status: "rejected", reason: "implementer-run" };
    if (identity.threadId === implementer.threadId)
      return { status: "rejected", reason: "implementer-thread" };
    if (
      identity.providerInstanceId === implementer.providerInstanceId &&
      identity.sessionId === implementer.sessionId
    )
      return { status: "rejected", reason: "implementer-session" };
  }
  return { status: "eligible" };
};

const ids = (maximum: number, minimum = 0) =>
  Schema.Array(Id).check(
    Schema.isMinLength(minimum),
    Schema.isMaxLength(maximum),
    Schema.makeFilter((values) => new Set(values).size === values.length),
  );
const Finding = Schema.Struct({
  findingId: Id,
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  criterionIds: ids(64, 1),
  target: Target,
  revision: Revision,
  status: Schema.Literals(["open", "resolved"]),
  detail: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32_000),
    Schema.isPattern(/\S/u),
  ),
  resolutionArtifactIds: ids(64),
});
const FindingInput = Schema.Struct({
  target: Target,
  currentFinding: Schema.optionalKey(Finding),
  proposedFinding: Finding,
  currentCriterionIds: ids(256),
  retainedResolutionEvidence: Schema.Array(
    Schema.Struct({
      artifactId: Id,
      target: Target,
      findings: Schema.Array(Schema.Struct({ findingId: Id, revision: Revision })).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(64),
        Schema.makeFilter(
          (values) => new Set(values.map((v) => v.findingId)).size === values.length,
        ),
      ),
    }),
  ).check(
    Schema.isMaxLength(256),
    Schema.makeFilter((values) => new Set(values.map((v) => v.artifactId)).size === values.length),
  ),
});
export type ReviewFinding = typeof Finding.Type;
export type ReviewFindingInput = typeof FindingInput.Type;
type FindingRejection =
  | "invalid-input"
  | "stale-finding-target"
  | "finding-identity-mismatch"
  | "unknown-criterion"
  | "invalid-resolution-state"
  | "resolution-evidence-required"
  | "resolution-artifact-not-retained"
  | "stale-resolution-evidence"
  | "resolution-finding-mismatch"
  | "stale-resolution-finding"
  | "invalid-initial-revision"
  | "conflicting-finding-replay"
  | "invalid-next-revision";
export type ReviewFindingResult =
  | { readonly status: "accepted" | "duplicate" }
  | { readonly status: "rejected"; readonly reason: FindingRejection };

const isFindingInput = Schema.is(FindingInput);
const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);
const sameFinding = (a: ReviewFinding, b: ReviewFinding) =>
  a.findingId === b.findingId &&
  a.severity === b.severity &&
  sameIds(a.criterionIds, b.criterionIds) &&
  sameTarget(a.target, b.target) &&
  a.revision === b.revision &&
  a.status === b.status &&
  a.detail === b.detail &&
  sameIds(a.resolutionArtifactIds, b.resolutionArtifactIds);

/** Trusted callers resolve current criteria and retained artifact applicability. This records no approval. */
export const evaluateReviewFindingTransition = (input: unknown): ReviewFindingResult => {
  if (!isFindingInput(input)) return { status: "rejected", reason: "invalid-input" };
  const { currentFinding: current, proposedFinding: proposed } = input;
  const origin = proposed.target;
  if (
    origin.projectId !== input.target.projectId ||
    origin.taskId !== input.target.taskId ||
    origin.specRevision !== input.target.specRevision ||
    origin.planRevision !== input.target.planRevision ||
    (current !== undefined && !sameTarget(current.target, origin)) ||
    (!sameTarget(input.target, origin) && (current === undefined || proposed.status !== "resolved"))
  )
    return { status: "rejected", reason: "stale-finding-target" };
  if (current !== undefined && current.findingId !== proposed.findingId)
    return { status: "rejected", reason: "finding-identity-mismatch" };
  const criteria = new Set(input.currentCriterionIds);
  if (proposed.criterionIds.some((id) => !criteria.has(id)))
    return { status: "rejected", reason: "unknown-criterion" };
  if (proposed.status === "open" && proposed.resolutionArtifactIds.length > 0)
    return { status: "rejected", reason: "invalid-resolution-state" };
  if (proposed.status === "resolved") {
    if (proposed.resolutionArtifactIds.length === 0)
      return { status: "rejected", reason: "resolution-evidence-required" };
    const retained = new Map(
      input.retainedResolutionEvidence.map((record) => [record.artifactId, record]),
    );
    for (const artifactId of proposed.resolutionArtifactIds) {
      const evidence = retained.get(artifactId);
      if (evidence === undefined)
        return { status: "rejected", reason: "resolution-artifact-not-retained" };
      if (!sameTarget(input.target, evidence.target))
        return { status: "rejected", reason: "stale-resolution-evidence" };
      const finding = evidence.findings.find((entry) => entry.findingId === proposed.findingId);
      if (finding === undefined)
        return { status: "rejected", reason: "resolution-finding-mismatch" };
      if (finding.revision !== proposed.revision)
        return { status: "rejected", reason: "stale-resolution-finding" };
    }
  }
  if (current === undefined)
    return proposed.revision === 0
      ? { status: "accepted" }
      : { status: "rejected", reason: "invalid-initial-revision" };
  if (proposed.revision === current.revision)
    return sameFinding(current, proposed)
      ? { status: "duplicate" }
      : { status: "rejected", reason: "conflicting-finding-replay" };
  if (current.revision === Number.MAX_SAFE_INTEGER || proposed.revision !== current.revision + 1)
    return { status: "rejected", reason: "invalid-next-revision" };
  return { status: "accepted" };
};
