import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  canonicalProjectWorkPayload,
  IsoDateTime,
  ProjectTeamReviewCompletionProof,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingProvenance,
  ProjectWorkAttribution,
  ProjectWorkCriterion,
  ProjectWorkEvidence,
  ProjectWorkEvidenceId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";

type Completed = Extract<ProjectTeamReviewCompletionProof, { status: "completed" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
type Finding = Extract<ProjectTeamRecord, { kind: "review-finding" }>;
type CriterionEvent = Extract<ProjectWorkEvent, { type: "project-work.criterion.upserted" }>;
type ProgressEvent =
  | CriterionEvent
  | Extract<ProjectWorkEvent, { type: "project-work.evidence.added" }>;
type Draft<T = ProgressEvent> = T extends ProgressEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const prefix = "review-criterion-progress:";
const producer = "project-team-review-criterion-progress";
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const CommandFingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}$/u));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Snapshot = Schema.Struct({ id: Id, revision: Safe, sha256: Digest });
const Verification = Schema.Struct({
  environmentId: Id,
  jobId: Id,
  manifestHash: Digest,
  attemptId: Id,
  resultHash: Digest,
  outcome: Schema.Literals([
    "success",
    "failed",
    "timed-out",
    "overflow",
    "canceled",
    "revoked",
    "abandoned",
  ]),
  exitCode: Schema.NullOr(
    Schema.Int.check(
      Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  evidenceId: Schema.optionalKey(Id),
  applicabilityId: Schema.optionalKey(Id),
});
const Provenance = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-team.review-criterion-progress"),
  environmentId: Id,
  projectId: Id,
  taskId: Id,
  criterionId: Id,
  settlementCommandId: Id,
  settlementCommandFingerprint: CommandFingerprint,
  proposalCommandId: Id,
  proposalSha256: Digest,
  assignmentOperationId: Id,
  assignmentReceiptSha256: Digest,
  joinedReceiptId: Id,
  joinedEvidenceSha256: Digest,
  target: ProjectTeamReviewFinding.fields.target,
  reviewer: ProjectTeamReviewFindingProvenance,
  reportAttribution: ProjectWorkAttribution,
  verification: Verification,
  verificationSnapshots: Schema.optionalKey(
    Schema.Struct({ evidenceSha256: Digest, applicabilitySha256: Digest }),
  ),
  criterionChange: Schema.optionalKey(Schema.Struct({ revision: Safe, sha256: Digest })),
  assessment: Schema.Struct({
    sha256: Digest,
    verdict: Schema.Literals(["met", "not-met"]),
    originalRevision: Safe,
    originalSha256: Digest,
    definitionSha256: Digest,
    parentScopeHash: Id,
    evidence: Schema.Array(Snapshot).check(
      Schema.isMaxLength(64),
      Schema.makeFilter(
        (values) => new Set(values.map((value) => value.id)).size === values.length,
      ),
    ),
  }),
  findings: Schema.Struct({ sha256: Digest, count: Safe.check(Schema.isLessThanOrEqualTo(256)) }),
});
type Provenance = typeof Provenance.Type;
const decodeProvenance = Schema.decodeUnknownSync(Schema.fromJsonString(Provenance), strict);
const decodeProof = Schema.decodeUnknownSync(ProjectTeamReviewCompletionProof, strict);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const decodeCriterion = Schema.decodeUnknownSync(ProjectWorkCriterion, strict);
const decodeAt = Schema.decodeUnknownSync(IsoDateTime, strict);
const decodeId = Schema.decodeUnknownSync(Id, strict);
const decodeCommandFingerprint = Schema.decodeUnknownSync(CommandFingerprint, strict);
const VerificationDetail = Schema.Struct({
  jobId: Id,
  manifestHash: Digest,
  attemptId: Id,
  resultHash: Digest,
  criteriaHash: Digest,
  criterionCount: Safe,
});
const decodeVerificationDetail = Schema.decodeUnknownSync(
  Schema.fromJsonString(VerificationDetail),
  strict,
);
function deny(message: string): never {
  throw new ProjectWorkPolicyError("invalid-state", message);
}
function exact<A>(value: unknown, decode: (value: unknown) => A): A {
  const decoded = decode(value);
  if (canonical(decoded) !== canonical(value))
    deny("Review progress input changed during decoding");
  return decoded;
}
function index<A>(values: readonly A[], id: (value: A) => string) {
  const result = new Map<string, A[]>();
  for (const value of values) {
    const key = id(value);
    const matches = result.get(key);
    if (matches) matches.push(value);
    else result.set(key, [value]);
  }
  return result;
}
function unique<A>(values: readonly A[] | undefined, message: string): A {
  if (values?.length !== 1) deny(message);
  return values[0]!;
}
const definitionHash = (criterion: ProjectWorkCriterion) =>
  hash({
    taskId: criterion.taskId,
    criterionId: criterion.criterionId,
    description: criterion.description,
    required: criterion.required,
  });
const evidenceId = (
  value: Pick<
    Provenance,
    "environmentId" | "projectId" | "proposalCommandId" | "criterionId" | "target"
  >,
) =>
  prefix +
  hash({
    environmentId: value.environmentId,
    projectId: value.projectId,
    proposalCommandId: value.proposalCommandId,
    criterionId: value.criterionId,
    target: value.target,
  });
const isProducer = (entry: ProjectWorkEvidence) =>
  entry.attribution?.actor.kind === "system" &&
  entry.attribution.actor.id === producer &&
  entry.attribution.source.kind === "system" &&
  entry.attribution.source.id === producer;
function indexes(state: ProjectWorkReducerState) {
  const records = state.foundationRecords ?? [];
  return {
    criteria: index(state.criteria, (c) => c.criterionId),
    tasks: index(state.tasks, (t) => t.taskId),
    evidence: index(state.evidence, (e) => e.evidenceId),
    records: index(records, (r) => r.recordId),
    plans: index(
      records.filter((r): r is Plan => r.kind === "plan-revision" && r.status === "proposed"),
      (r) => canonical([r.taskId, r.specRevision, r.planRevision]),
    ),
    findings: index(
      records.filter((r): r is Finding => r.kind === "review-finding"),
      (r) => canonical(r.target),
    ),
    scopes: new Map<string, string>(),
  };
}
type Indexes = ReturnType<typeof indexes>;
function parentScope(state: ProjectWorkReducerState, lookup: Indexes, taskId: string, plan: Plan) {
  const key = canonical([taskId, plan.specRevision, plan.planRevision]);
  let scope = lookup.scopes.get(key);
  if (scope === undefined) {
    scope = projectTeamScopeHash(state, taskId, plan);
    lookup.scopes.set(key, scope);
  }
  return scope;
}
function findingSnapshots(lookup: Indexes, target: Provenance["target"], criterionId?: string) {
  const records = (lookup.findings.get(canonical(target)) ?? []).filter(
    (r) =>
      criterionId === undefined ||
      r.criterionIds.some((id) => id === criterionId) ||
      r.severity === "critical",
  );
  if (records.length > 256 || new Set(records.map((r) => r.findingId)).size !== records.length)
    deny("Review progress findings are ambiguous or exceed their bound");
  return records
    .map((r) => ({ findingId: r.findingId, revision: r.revision, sha256: hash(r) }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
}
function readSupport(lookup: Indexes, id: string, criterion: ProjectWorkCriterion) {
  const entry = unique(lookup.evidence.get(id), "Review progress evidence is missing or ambiguous");
  if (
    !isProducer(entry) ||
    entry.kind !== "review" ||
    !entry.detail ||
    Buffer.byteLength(entry.detail) > 32000
  )
    deny("Review progress evidence has invalid producer provenance");
  const value = decodeProvenance(entry.detail);
  if (
    canonical(value) !== entry.detail ||
    evidenceId(value) !== id ||
    entry.taskId !== criterion.taskId ||
    entry.criterionId !== criterion.criterionId ||
    value.taskId !== criterion.taskId ||
    value.criterionId !== criterion.criterionId ||
    value.target.taskId !== value.taskId ||
    value.target.projectId !== value.projectId ||
    value.environmentId !== value.verification.environmentId ||
    value.reviewer.reviewTaskId === value.taskId ||
    entry.scopeHash !== value.assessment.parentScopeHash
  )
    deny("Review progress evidence identity changed");
  if (
    value.assessment.verdict === "met" &&
    (value.assessment.evidence.length === 0 ||
      value.verification.outcome !== "success" ||
      value.verification.exitCode !== 0 ||
      !value.verification.evidenceId ||
      !value.verification.applicabilityId ||
      !value.verificationSnapshots)
  )
    deny("Retained positive review progress has no successful verification");
  if (
    criterion.satisfiedByEvidenceIds.some((evidenceId) => evidenceId === id) &&
    (value.assessment.verdict !== "met" || value.criterionChange === undefined)
  )
    deny("Retained review progress has no original support attachment");
  return { entry, value };
}
function verificationSnapshots(lookup: Indexes, value: Provenance["verification"]) {
  if (
    value.outcome !== "success" ||
    value.exitCode !== 0 ||
    !value.evidenceId ||
    !value.applicabilityId
  )
    return undefined;
  const evidenceMatches = lookup.evidence.get(value.evidenceId);
  const recordMatches = lookup.records.get(value.applicabilityId);
  if (evidenceMatches?.length !== 1 || recordMatches?.length !== 1) return undefined;
  const evidence = evidenceMatches[0]!;
  const record = recordMatches[0]!;
  if (
    record.kind !== "evidence-applicability" ||
    !evidence.detail ||
    Buffer.byteLength(evidence.detail) > 32000 ||
    evidence.kind !== "test" ||
    record.evidenceId !== evidence.evidenceId ||
    record.exitCode !== 0
  )
    return undefined;
  let detail: typeof VerificationDetail.Type;
  try {
    detail = decodeVerificationDetail(evidence.detail);
  } catch {
    return undefined;
  }
  if (
    canonical(detail) !== evidence.detail ||
    detail.jobId !== value.jobId ||
    detail.manifestHash !== value.manifestHash ||
    detail.attemptId !== value.attemptId ||
    detail.resultHash !== value.resultHash
  )
    return undefined;
  return {
    evidence,
    record,
    snapshots: { evidenceSha256: hash(evidence), applicabilitySha256: hash(record) },
  };
}
function currentSupport(
  state: ProjectWorkReducerState,
  lookup: Indexes,
  criterion: ProjectWorkCriterion,
  value: Provenance,
) {
  if (value.projectId !== state.projectId || value.assessment.verdict !== "met")
    deny("Review progress support belongs to another project or verdict");
  const tasks = lookup.tasks.get(value.taskId);
  const plans = lookup.plans.get(
    canonical([value.taskId, value.target.specRevision, value.target.planRevision]),
  );
  const task = tasks?.length === 1 ? tasks[0] : undefined;
  const plan = plans?.length === 1 ? plans[0] : undefined;
  if (
    !task ||
    task.specRevision !== value.target.specRevision ||
    !plan ||
    definitionHash(criterion) !== value.assessment.definitionSha256 ||
    parentScope(state, lookup, value.taskId, plan) !== value.assessment.parentScopeHash
  )
    return false;
  for (const input of value.assessment.evidence) {
    const matches = lookup.evidence.get(input.id);
    const evidence = matches?.length === 1 ? matches[0] : undefined;
    if (
      !evidence ||
      evidence.taskId !== value.taskId ||
      (evidence.criterionId !== undefined && evidence.criterionId !== value.criterionId) ||
      evidence.scopeHash !== value.assessment.parentScopeHash ||
      evidence.revision !== input.revision ||
      hash(evidence) !== input.sha256
    )
      return false;
  }
  const findings = findingSnapshots(lookup, value.target, value.criterionId);
  if (findings.length !== value.findings.count || hash(findings) !== value.findings.sha256)
    return false;
  const verification = verificationSnapshots(lookup, value.verification);
  if (!verification) return false;
  return (
    verification.record.status === "current" &&
    verification.record.projectId === state.projectId &&
    verification.record.taskId === value.taskId &&
    verification.evidence.taskId === value.taskId &&
    verification.record.specRevision === value.target.specRevision &&
    verification.record.planRevision === value.target.planRevision &&
    verification.record.baseSha === value.target.baseSha &&
    verification.record.headSha === value.target.headSha &&
    verification.record.scopeHash === value.assessment.parentScopeHash &&
    verification.evidence.scopeHash === value.assessment.parentScopeHash &&
    canonical(verification.snapshots) === canonical(value.verificationSnapshots)
  );
}
function keptSupports(
  state: ProjectWorkReducerState,
  lookup: Indexes,
  criterion: ProjectWorkCriterion,
  rejectedTarget?: Provenance["target"],
) {
  return criterion.satisfiedByEvidenceIds.filter((id) => {
    if (!id.startsWith(prefix)) return true;
    const { value } = readSupport(lookup, id, criterion);
    return (
      currentSupport(state, lookup, criterion, value) &&
      (rejectedTarget === undefined || canonical(value.target) !== canonical(rejectedTarget))
    );
  });
}
function criterionDraft(
  criterion: ProjectWorkCriterion,
  ids: readonly ProjectWorkEvidenceId[],
  at: string,
): Draft<CriterionEvent> | undefined {
  if (canonical(ids) === canonical(criterion.satisfiedByEvidenceIds)) return undefined;
  if (!Number.isSafeInteger(criterion.revision) || criterion.revision >= Number.MAX_SAFE_INTEGER)
    deny("Review progress criterion revision is exhausted");
  return {
    type: "project-work.criterion.upserted",
    taskId: criterion.taskId,
    criterion: {
      ...criterion,
      status: ids.length > 0 ? "satisfied" : "unsatisfied",
      satisfiedByEvidenceIds: [...ids],
      revision: criterion.revision + 1,
      updatedAt: at,
    },
    updatedAt: at,
    occurredAt: at,
  };
}

/** The private joined producer supplies qualified facts; this plan grants only selected criterion support. */
export function prepareReviewCriterionProgress(input: {
  readonly state: ProjectWorkReducerState;
  readonly completion: Completed;
  readonly settlementCommandId: string;
  readonly settlementCommandFingerprint: string;
  readonly at: string;
}): readonly Draft[] {
  const decoded = exact(input.completion, decodeProof);
  if (decoded.status !== "completed") deny("Review progress requires a completed reviewer proof");
  const completion = decoded;
  const report = completion.report;
  if (report.type !== "project-team.assignment.report")
    deny("Review progress requires an original reviewer report");
  const assessments = report.criterionAssessments;
  const parent = completion.parentAssessments;
  if (assessments === undefined) {
    if (parent !== undefined) deny("Review progress snapshots have no original assessments");
    return [];
  }
  if (!parent || assessments.length !== parent.snapshots.length)
    deny("Review progress is missing original assessment snapshots");
  if (assessments.length === 0) return [];
  const at = exact(input.at, decodeAt);
  const settlementCommandId = exact(input.settlementCommandId, decodeId);
  const settlementCommandFingerprint = exact(
    input.settlementCommandFingerprint,
    decodeCommandFingerprint,
  );
  const state = input.state;
  const lookup = indexes(state);
  if (canonical(findingSnapshots(lookup, completion.target)) !== canonical(completion.findings))
    deny("Review progress original findings changed");
  const openCritical = (lookup.findings.get(canonical(completion.target)) ?? []).some(
    (r) => r.severity === "critical" && r.status === "open",
  );
  const drafts: Draft[] = [];
  for (const [position, assessment] of assessments.entries()) {
    const snapshot = parent.snapshots[position]!;
    const criterion = unique(
      lookup.criteria.get(assessment.criterionId),
      "Review progress criterion is missing or ambiguous",
    );
    if (
      criterion.taskId !== completion.target.taskId ||
      snapshot.taskId !== criterion.taskId ||
      snapshot.projectId !== state.projectId ||
      completion.target.projectId !== state.projectId ||
      snapshot.criterion.id !== criterion.criterionId ||
      snapshot.criterion.revision !== criterion.revision ||
      assessment.expectedRevision !== criterion.revision ||
      snapshot.criterion.sha256 !== hash(exact(criterion, decodeCriterion)) ||
      snapshot.assessmentSha256 !== hash(assessment) ||
      canonical(snapshot.target) !== canonical(completion.target) ||
      canonical(snapshot.evidence.map((e) => e.id)) !== canonical(assessment.evidenceIds)
    )
      deny("Review progress original assessment changed");
    const plan = unique(
      lookup.plans.get(
        canonical([
          criterion.taskId,
          completion.target.specRevision,
          completion.target.planRevision,
        ]),
      ),
      "Review progress parent plan is missing or ambiguous",
    );
    const task = unique(
      lookup.tasks.get(criterion.taskId),
      "Review progress parent task is missing or ambiguous",
    );
    if (
      task.specRevision !== completion.target.specRevision ||
      parentScope(state, lookup, criterion.taskId, plan) !== snapshot.parentScopeHash
    )
      deny("Review progress original parent scope changed");
    for (const captured of snapshot.evidence) {
      const evidence = unique(
        lookup.evidence.get(captured.id),
        "Review progress input evidence is missing or ambiguous",
      );
      if (
        evidence.taskId !== criterion.taskId ||
        captured.taskId !== criterion.taskId ||
        (evidence.criterionId !== undefined && evidence.criterionId !== criterion.criterionId) ||
        captured.criterionId !== evidence.criterionId ||
        evidence.scopeHash !== snapshot.parentScopeHash ||
        captured.scopeHash !== snapshot.parentScopeHash ||
        evidence.revision !== captured.revision ||
        hash(exact(evidence, decodeEvidence)) !== captured.sha256
      )
        deny("Review progress input evidence changed");
    }
    const verification = parent.verification;
    if (
      verification.outcome !== "success" &&
      (verification.evidenceId !== undefined || verification.applicabilityId !== undefined)
    )
      deny("Failed verification cannot supply applicability");
    const positive = assessment.verdict === "met";
    if (positive && openCritical)
      deny("An open critical finding prevents positive review progress");
    const verified = positive ? verificationSnapshots(lookup, verification) : undefined;
    const findings = findingSnapshots(lookup, completion.target, criterion.criterionId);
    const id = ProjectWorkEvidenceId.make(
      evidenceId({
        environmentId: verification.environmentId,
        projectId: state.projectId,
        proposalCommandId: completion.proposalCommandId,
        criterionId: criterion.criterionId,
        target: completion.target,
      }),
    );
    const preserve =
      criterion.status === "waived" ||
      criterion.waiver !== undefined ||
      (criterion.status === "satisfied" && criterion.satisfiedByEvidenceIds.length === 0);
    const retained = preserve
      ? []
      : keptSupports(state, lookup, criterion, positive ? undefined : completion.target);
    const next = preserve
      ? undefined
      : criterionDraft(criterion, positive ? [...retained, id] : retained, at);
    const value: Provenance = {
      version: 1,
      kind: "project-team.review-criterion-progress",
      environmentId: verification.environmentId,
      projectId: state.projectId,
      taskId: criterion.taskId,
      criterionId: criterion.criterionId,
      settlementCommandId,
      settlementCommandFingerprint,
      proposalCommandId: completion.proposalCommandId,
      proposalSha256: completion.proposalSha256,
      assignmentOperationId: completion.assignmentOperationId,
      assignmentReceiptSha256: completion.assignmentReceiptSha256,
      joinedReceiptId: completion.joinedReceiptId,
      joinedEvidenceSha256: completion.joinedEvidenceSha256,
      target: completion.target,
      reviewer: completion.provenance,
      reportAttribution: completion.reportAttribution,
      verification,
      ...(verified === undefined ? {} : { verificationSnapshots: verified.snapshots }),
      ...(next === undefined
        ? {}
        : { criterionChange: { revision: next.criterion.revision, sha256: hash(next.criterion) } }),
      assessment: {
        sha256: snapshot.assessmentSha256,
        verdict: assessment.verdict,
        originalRevision: criterion.revision,
        originalSha256: snapshot.criterion.sha256,
        definitionSha256: definitionHash(criterion),
        parentScopeHash: snapshot.parentScopeHash,
        evidence: snapshot.evidence.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })),
      },
      findings: { sha256: hash(findings), count: findings.length },
    };
    if (positive && !currentSupport(state, lookup, criterion, value))
      deny("Review progress successful verification is no longer applicable");
    const detail = canonical(value);
    if (detail.length > 32000 || Buffer.byteLength(detail) > 32000)
      deny("Review progress provenance exceeds its evidence bound");
    if (lookup.evidence.has(id)) deny("Review progress evidence identity already exists");
    const evidence = decodeEvidence({
      evidenceId: id,
      taskId: criterion.taskId,
      criterionId: criterion.criterionId,
      kind: "review",
      summary: `Qualified reviewer judgment: ${assessment.verdict}.`,
      detail,
      scopeHash: snapshot.parentScopeHash,
      recordedAt: at,
      revision: 0,
      attribution: {
        actor: { kind: "system", id: producer },
        source: { kind: "system", id: producer },
        recordedAt: at,
      },
    });
    drafts.push({ type: "project-work.evidence.added", evidence, addedAt: at, occurredAt: at });
    if (next) drafts.push(next);
  }
  return drafts;
}

/** Retained changes revoke only support produced here; an invalidated judgment is never restored. */
export function invalidateReviewCriterionProgress(input: {
  readonly state: ProjectWorkReducerState;
  readonly at: string;
}): readonly Draft<CriterionEvent>[] {
  if (
    !input.state.criteria.some((c) => c.satisfiedByEvidenceIds.some((id) => id.startsWith(prefix)))
  )
    return [];
  const at = exact(input.at, decodeAt);
  const lookup = indexes(input.state);
  const drafts: Draft<CriterionEvent>[] = [];
  for (const criterion of input.state.criteria) {
    if (
      criterion.status === "waived" ||
      criterion.waiver !== undefined ||
      !criterion.satisfiedByEvidenceIds.some((id) => id.startsWith(prefix))
    )
      continue;
    unique(lookup.criteria.get(criterion.criterionId), "Review progress criterion is ambiguous");
    const next = criterionDraft(criterion, keptSupports(input.state, lookup, criterion), at);
    if (next) drafts.push(next);
  }
  return drafts;
}

/** The caller audits the original command receipt first. Current criterion drift cannot replay its old grant. */
export function assertRetainedReviewCriterionProgress(input: {
  readonly state: ProjectWorkReducerState;
  readonly events: readonly ProjectWorkEvent[];
  readonly settlement: {
    readonly commandId: string;
    readonly commandFingerprint: string;
    readonly dispatchId: string;
    readonly joinedReceiptId: string;
  };
}): void {
  const ownedEvents = input.events.filter(
    (event) =>
      event.type === "project-work.evidence.added" && event.evidence.evidenceId.startsWith(prefix),
  );
  if (ownedEvents.length === 0) return;
  const lookup = indexes(input.state);
  const ids = new Set<string>();
  for (const event of ownedEvents) {
    if (event.type !== "project-work.evidence.added") continue;
    const recorded = exact(event.evidence, decodeEvidence);
    if (!recorded.criterionId || !recorded.taskId)
      deny("Retained review progress has no criterion owner");
    const criterion = unique(
      lookup.criteria.get(recorded.criterionId),
      "Retained review progress criterion is missing or ambiguous",
    );
    const { entry, value } = readSupport(lookup, recorded.evidenceId, criterion);
    if (
      ids.has(recorded.evidenceId) ||
      canonical(entry) !== canonical(recorded) ||
      event.projectId !== input.state.projectId ||
      value.projectId !== input.state.projectId ||
      value.settlementCommandId !== input.settlement.commandId ||
      value.settlementCommandFingerprint !== input.settlement.commandFingerprint ||
      value.joinedReceiptId !== input.settlement.joinedReceiptId ||
      value.reviewer.dispatchId !== input.settlement.dispatchId
    )
      deny("Retained review progress settlement identity changed");
    ids.add(recorded.evidenceId);
    const changes = input.events.filter(
      (candidate) =>
        candidate.type === "project-work.criterion.upserted" &&
        candidate.criterion.criterionId === recorded.criterionId,
    );
    if (changes.length !== (value.criterionChange === undefined ? 0 : 1))
      deny("Retained review progress criterion events are missing or ambiguous");
    const change = changes[0];
    if (change?.type === "project-work.criterion.upserted") {
      const changeProof = value.criterionChange;
      if (!changeProof) deny("Retained review progress has no original criterion change");
      const original = exact(change.criterion, decodeCriterion);
      if (
        change.taskId !== value.taskId ||
        original.taskId !== value.taskId ||
        original.revision !== value.assessment.originalRevision + 1 ||
        original.revision !== changeProof.revision ||
        hash(original) !== changeProof.sha256 ||
        original.waiver !== undefined ||
        original.status === "waived" ||
        definitionHash(original) !== value.assessment.definitionSha256 ||
        (value.assessment.verdict === "met" &&
          (original.status !== "satisfied" ||
            !original.satisfiedByEvidenceIds.includes(recorded.evidenceId))) ||
        (value.assessment.verdict === "not-met" &&
          original.satisfiedByEvidenceIds.includes(recorded.evidenceId))
      )
        deny("Retained review progress original criterion event changed");
    }
  }
}
