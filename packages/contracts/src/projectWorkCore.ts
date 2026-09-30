import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

/** Identifiers owned by the project-work aggregate. */
const projectWorkId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ProjectWorkTaskId = projectWorkId("ProjectWorkTaskId");
export type ProjectWorkTaskId = typeof ProjectWorkTaskId.Type;
export const ProjectWorkAttemptId = projectWorkId("ProjectWorkAttemptId");
export type ProjectWorkAttemptId = typeof ProjectWorkAttemptId.Type;
export const ProjectWorkCriterionId = projectWorkId("ProjectWorkCriterionId");
export type ProjectWorkCriterionId = typeof ProjectWorkCriterionId.Type;
export const ProjectWorkEvidenceId = projectWorkId("ProjectWorkEvidenceId");
export type ProjectWorkEvidenceId = typeof ProjectWorkEvidenceId.Type;
export const ProjectWorkKnowledgeId = projectWorkId("ProjectWorkKnowledgeId");
export type ProjectWorkKnowledgeId = typeof ProjectWorkKnowledgeId.Type;
export const ProjectWorkDecisionId = projectWorkId("ProjectWorkDecisionId");
export type ProjectWorkDecisionId = typeof ProjectWorkDecisionId.Type;
export const ProjectWorkRelationshipId = projectWorkId("ProjectWorkRelationshipId");
export type ProjectWorkRelationshipId = typeof ProjectWorkRelationshipId.Type;
export const ProjectWorkBlockerId = projectWorkId("ProjectWorkBlockerId");
export type ProjectWorkBlockerId = typeof ProjectWorkBlockerId.Type;
export const ProjectWorkApprovalId = projectWorkId("ProjectWorkApprovalId");
export type ProjectWorkApprovalId = typeof ProjectWorkApprovalId.Type;
export const ProjectWorkResultId = projectWorkId("ProjectWorkResultId");
export type ProjectWorkResultId = typeof ProjectWorkResultId.Type;

/** A result produced for one specification revision and explicitly invalidated
 * when a protected revision changes the evidence it depends on. */
export const ProjectWorkResultInvalidation = Schema.Struct({
  resultId: ProjectWorkResultId,
  specRevision: NonNegativeInt,
  invalidatedAt: IsoDateTime,
});
export type ProjectWorkResultInvalidation = typeof ProjectWorkResultInvalidation.Type;

export const ProjectWorkTaskState = Schema.Literals([
  "draft",
  "specified",
  "ready",
  "in-progress",
  "blocked",
  "in-review",
  "completed",
  "failed",
  "canceled",
]);
export type ProjectWorkTaskState = typeof ProjectWorkTaskState.Type;
/** Read-only superset that preserves states introduced by newer servers. */
export const ProjectWorkTaskStateRead = Schema.String;
export type ProjectWorkTaskStateRead = typeof ProjectWorkTaskStateRead.Type;

export const ProjectWorkAttemptState = Schema.Literals([
  "leased",
  "running",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);
export type ProjectWorkAttemptState = typeof ProjectWorkAttemptState.Type;
/** Read-only superset that preserves attempt states introduced by newer servers. */
export const ProjectWorkAttemptStateRead = Schema.String;
export type ProjectWorkAttemptStateRead = typeof ProjectWorkAttemptStateRead.Type;

export const ProjectWorkFailureKind = Schema.Literals([
  "recoverable",
  "manual-triage",
  "lease-expired",
]);
export type ProjectWorkFailureKind = typeof ProjectWorkFailureKind.Type;
/** Read-only superset that preserves failure kinds introduced by newer servers. */
export const ProjectWorkFailureKindRead = Schema.String;
export type ProjectWorkFailureKindRead = typeof ProjectWorkFailureKindRead.Type;

export const ProjectWorkActorKind = Schema.Literals(["human", "agent", "system", "adapter"]);
export type ProjectWorkActorKind = typeof ProjectWorkActorKind.Type;
/** Read-only superset that preserves actor kinds introduced by newer servers. */
export const ProjectWorkActorKindRead = Schema.String;
export type ProjectWorkActorKindRead = typeof ProjectWorkActorKindRead.Type;
export const ProjectWorkSourceKind = Schema.Literals([
  "web",
  "desktop",
  "mobile",
  "mcp",
  "provider",
  "import",
  "system",
  "external",
]);
export type ProjectWorkSourceKind = typeof ProjectWorkSourceKind.Type;
/** Read-only superset that preserves source kinds introduced by newer servers. */
export const ProjectWorkSourceKindRead = Schema.String;
export type ProjectWorkSourceKindRead = typeof ProjectWorkSourceKindRead.Type;

export const ProjectWorkActor = Schema.Struct({
  kind: ProjectWorkActorKind,
  id: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectWorkActor = typeof ProjectWorkActor.Type;

export const ProjectWorkActorRead = Schema.Struct({
  ...ProjectWorkActor.fields,
  kind: ProjectWorkActorKindRead,
});
export type ProjectWorkActorRead = typeof ProjectWorkActorRead.Type;

export const ProjectWorkSource = Schema.Struct({
  kind: ProjectWorkSourceKind,
  id: Schema.optionalKey(TrimmedNonEmptyString),
  uri: Schema.optionalKey(TrimmedString),
});
export type ProjectWorkSource = typeof ProjectWorkSource.Type;

export const ProjectWorkSourceRead = Schema.Struct({
  ...ProjectWorkSource.fields,
  kind: ProjectWorkSourceKindRead,
});
export type ProjectWorkSourceRead = typeof ProjectWorkSourceRead.Type;

export const ProjectWorkAttribution = Schema.Struct({
  actor: ProjectWorkActor,
  source: ProjectWorkSource,
  recordedAt: IsoDateTime,
});
export type ProjectWorkAttribution = typeof ProjectWorkAttribution.Type;

export const ProjectWorkAttributionRead = Schema.Struct({
  ...ProjectWorkAttribution.fields,
  actor: ProjectWorkActorRead,
  source: ProjectWorkSourceRead,
});
export type ProjectWorkAttributionRead = typeof ProjectWorkAttributionRead.Type;
