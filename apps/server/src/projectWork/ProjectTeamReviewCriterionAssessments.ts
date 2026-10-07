import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamReviewCriterionAssessment,
  ProjectTeamReviewFinding,
  ProjectWorkCriterion,
  ProjectWorkEvidence,
  type ProjectVerificationJobManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectWorkState } from "./ProjectWorkPolicy.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { indexReviewFindings, selectReviewFindings } from "./ProjectTeamReviewResolutionRecords.ts";

const strict = { onExcessProperty: "error" } as const;
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isTrimmed());
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Identity = Schema.Struct({ id: Id, revision: Safe, sha256: Digest });
export const ProjectTeamReviewCriterionAssessmentSnapshot = Schema.Struct({
  assessmentSha256: Digest,
  projectId: Id,
  taskId: Id,
  target: ProjectTeamReviewFinding.fields.target,
  parentScopeHash: Id,
  criterion: Identity,
  evidence: Schema.Array(
    Schema.Struct({
      ...Identity.fields,
      taskId: Id,
      criterionId: Schema.optionalKey(Id),
      scopeHash: Id,
    }),
  ).check(Schema.isMaxLength(64)),
});
export type ProjectTeamReviewCriterionAssessmentSnapshot =
  typeof ProjectTeamReviewCriterionAssessmentSnapshot.Type;
export class ProjectTeamReviewCriterionAssessmentError extends Schema.TaggedError<ProjectTeamReviewCriterionAssessmentError>()(
  "ProjectTeamReviewCriterionAssessmentError",
  { reason: Schema.String },
) {}
const fail = (reason: string) => new ProjectTeamReviewCriterionAssessmentError({ reason });
const isAssessmentError = Schema.is(ProjectTeamReviewCriterionAssessmentError);
const decodeCriterion = Schema.decodeUnknownSync(ProjectWorkCriterion, strict);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const decodeAssessment = Schema.decodeUnknownSync(ProjectTeamReviewCriterionAssessment, strict);
const exact = <A>(value: unknown, decode: (value: unknown) => A) => {
  const decoded = decode(value);
  if (canonical(decoded) !== canonical(value))
    throw fail("Assessment record changed during decoding");
  return decoded;
};
type Target = typeof ProjectTeamReviewFinding.fields.target.Type;

/** Pending judgments use only the original qualified parent and current retained scoped records. */
export const snapshotReviewCriterionAssessments = (input: {
  readonly assessments: readonly ProjectTeamReviewCriterionAssessment[] | undefined;
  readonly state: ProjectWorkState;
  readonly target: Target;
  readonly prepared: ProjectVerificationJobManifest;
}) =>
  Effect.try({
    try: () => {
      if (input.assessments === undefined) return undefined;
      const { state, target, prepared } = input;
      if (
        input.assessments.length > 64 ||
        new Set(input.assessments.map((a) => a.criterionId)).size !== input.assessments.length
      )
        throw fail("Assessment criteria are ambiguous or exceed their bound");
      const plans = (state.foundationRecords ?? []).filter(
        (r) =>
          r.kind === "plan-revision" &&
          r.taskId === target.taskId &&
          r.planRevision === target.planRevision,
      );
      const plan = plans[0];
      if (
        plans.length !== 1 ||
        plan?.kind !== "plan-revision" ||
        state.projectId !== target.projectId ||
        prepared.projectId !== target.projectId ||
        prepared.taskId !== target.taskId ||
        prepared.specRevision !== target.specRevision ||
        prepared.planRevision !== target.planRevision
      )
        throw fail("Assessment parent scope is unavailable");
      const parentScopeHash = projectTeamScopeHash(state, target.taskId, plan);
      if (input.assessments.length === 0) return [];
      const selectedById = new Map<
        string,
        Array<ProjectVerificationJobManifest["criteria"][number]>
      >();
      for (const criterion of prepared.criteria) {
        const id = criterion.criterionId;
        const matches = selectedById.get(id);
        if (matches) matches.push(criterion);
        else selectedById.set(id, [criterion]);
      }
      const parentCriteriaById = new Map<string, Array<typeof ProjectWorkCriterion.Type>>();
      for (const criterion of state.criteria) {
        if (criterion.taskId !== target.taskId) continue;
        const id = criterion.criterionId;
        const matches = parentCriteriaById.get(id);
        if (matches) matches.push(criterion);
        else parentCriteriaById.set(id, [criterion]);
      }
      // Identity ambiguity is global, including duplicates belonging to another task.
      const evidenceById = new Map<string, Array<typeof ProjectWorkEvidence.Type>>();
      const referencedEvidenceIds = new Set(
        input.assessments.flatMap((assessment) => assessment.evidenceIds),
      );
      if (referencedEvidenceIds.size > 0) {
        for (const entry of state.evidence) {
          const id = entry.evidenceId;
          if (!referencedEvidenceIds.has(id)) continue;
          const matches = evidenceById.get(id);
          if (matches) matches.push(entry);
          else evidenceById.set(id, [entry]);
        }
      }
      const hasOpenCriticalFinding = selectReviewFindings(
        indexReviewFindings(state),
        target,
      ).records.some((record) => record.severity === "critical" && record.status === "open");
      return input.assessments.map((raw) => {
        const assessment = exact(raw, decodeAssessment);
        const selected = selectedById.get(assessment.criterionId) ?? [];
        const criteria = parentCriteriaById.get(assessment.criterionId) ?? [];
        const criterion = criteria[0];
        if (
          selected.length !== 1 ||
          criteria.length !== 1 ||
          !criterion ||
          criterion.revision !== assessment.expectedRevision ||
          selected[0]?.revision !== assessment.expectedRevision
        )
          throw fail("Assessment requires an exact selected parent criterion revision");
        if (assessment.verdict === "met" && hasOpenCriticalFinding)
          throw fail("An open critical finding prevents a positive assessment");
        const evidence = assessment.evidenceIds.map((id) => {
          const matches = evidenceById.get(id) ?? [];
          const entry = matches[0];
          if (
            matches.length !== 1 ||
            !entry ||
            entry.taskId !== target.taskId ||
            entry.scopeHash !== parentScopeHash ||
            !entry.detail?.trim() ||
            (entry.criterionId !== undefined && entry.criterionId !== assessment.criterionId)
          )
            throw fail("Assessment evidence is unavailable, foreign or stale");
          const decoded = exact(entry, decodeEvidence);
          return {
            id,
            taskId: target.taskId,
            ...(decoded.criterionId === undefined ? {} : { criterionId: decoded.criterionId }),
            scopeHash: parentScopeHash,
            revision: decoded.revision,
            sha256: hash(decoded),
          };
        });
        return {
          assessmentSha256: hash(assessment),
          projectId: target.projectId,
          taskId: target.taskId,
          target,
          parentScopeHash,
          criterion: {
            id: criterion.criterionId,
            revision: criterion.revision,
            sha256: hash(exact(criterion, decodeCriterion)),
          },
          evidence,
        };
      });
    },
    catch: (error) =>
      isAssessmentError(error) ? error : fail("Invalid criterion assessment records"),
  });

/** Check decoded stored identities without treating the stored judgment as acceptance authority. */
export const reviewCriterionAssessmentBindingsMatch = (
  assessments: readonly ProjectTeamReviewCriterionAssessment[] | undefined,
  snapshots: readonly ProjectTeamReviewCriterionAssessmentSnapshot[] | undefined,
  target: Target,
) => {
  if (assessments === undefined) return snapshots === undefined;
  if (
    snapshots === undefined ||
    snapshots.length !== assessments.length ||
    new Set(snapshots.map((s) => s.criterion.id)).size !== snapshots.length
  )
    return false;
  return assessments.every((assessment, index) => {
    const snapshot = snapshots[index]!;
    return (
      snapshot.assessmentSha256 === hash(assessment) &&
      snapshot.projectId === target.projectId &&
      snapshot.taskId === target.taskId &&
      canonical(snapshot.target) === canonical(target) &&
      snapshot.criterion.id === assessment.criterionId &&
      snapshot.criterion.revision === assessment.expectedRevision &&
      snapshot.evidence.length === assessment.evidenceIds.length &&
      snapshot.evidence.every(
        (entry, position) =>
          entry.id === assessment.evidenceIds[position] &&
          entry.taskId === target.taskId &&
          entry.scopeHash === snapshot.parentScopeHash &&
          (entry.criterionId === undefined || entry.criterionId === assessment.criterionId),
      )
    );
  });
};
