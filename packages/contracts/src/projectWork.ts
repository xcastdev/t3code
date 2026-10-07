import { ProjectVerificationJobManifest } from "./projectVerification.ts";
import {
  ProjectTeamRecord,
  ProjectTeamRecordRead,
  ProjectTeamWriteIntent,
  ProjectTeamRunBinding,
  ProjectTeamDeliverableKind,
  ProjectTeamEffect,
  ProjectTeamReservation,
  ProjectTeamTaskMembership,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingProvenance,
  ProjectTeamIntegrationSourceRefs,
  ProjectTeamIntegrationSources,
} from "./projectTeams.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
  ThreadId,
} from "./baseSchemas.ts";

export * from "./projectWorkCore.ts";
import {
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  ProjectWorkRelationshipId,
  ProjectWorkBlockerId,
  ProjectWorkApprovalId,
  ProjectWorkResultId,
  ProjectWorkTaskState,
  ProjectWorkTaskStateRead,
  ProjectWorkAttemptState,
  ProjectWorkAttemptStateRead,
  ProjectWorkFailureKind,
  ProjectWorkFailureKindRead,
  ProjectWorkActor,
  ProjectWorkSource,
  ProjectWorkAttribution,
  ProjectWorkAttributionRead,
} from "./projectWorkCore.ts";

const ProjectWorkRevision = NonNegativeInt;
const ProjectWorkExpectedRevision = Schema.optionalKey(ProjectWorkRevision);
const ProjectWorkAttributionField = Schema.optionalKey(ProjectWorkAttribution);
const ProjectWorkSummary = Schema.String.check(Schema.isMaxLength(32_000));
const ProjectWorkShortText = TrimmedString.check(Schema.isMaxLength(4_000));
const ProjectWorkRequiredText = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));

export const ProjectWorkCriterionStatus = Schema.Literals(["unsatisfied", "satisfied", "waived"]);
export type ProjectWorkCriterionStatus = typeof ProjectWorkCriterionStatus.Type;
/** Read-only superset that preserves criterion statuses introduced by newer servers. */
export const ProjectWorkCriterionStatusRead = Schema.String;
export type ProjectWorkCriterionStatusRead = typeof ProjectWorkCriterionStatusRead.Type;

export const ProjectWorkCriterionWaiver = Schema.Struct({
  reason: ProjectWorkRequiredText,
  evidenceIds: Schema.Array(ProjectWorkEvidenceId),
  specRevision: ProjectWorkRevision,
  waivedAt: IsoDateTime,
  attribution: ProjectWorkAttribution,
});
export type ProjectWorkCriterionWaiver = typeof ProjectWorkCriterionWaiver.Type;

export const ProjectWorkCriterionWaiverRead = Schema.Struct({
  ...ProjectWorkCriterionWaiver.fields,
  attribution: ProjectWorkAttributionRead,
});
export type ProjectWorkCriterionWaiverRead = typeof ProjectWorkCriterionWaiverRead.Type;

export const ProjectWorkCriterion = Schema.Struct({
  criterionId: ProjectWorkCriterionId,
  taskId: ProjectWorkTaskId,
  description: ProjectWorkShortText,
  required: Schema.Boolean,
  status: ProjectWorkCriterionStatus,
  satisfiedByEvidenceIds: Schema.Array(ProjectWorkEvidenceId),
  waiver: Schema.optionalKey(ProjectWorkCriterionWaiver),
  revision: ProjectWorkRevision,
  updatedAt: IsoDateTime,
});
export type ProjectWorkCriterion = typeof ProjectWorkCriterion.Type;

export const ProjectWorkCriterionRead = Schema.Struct({
  ...ProjectWorkCriterion.fields,
  status: ProjectWorkCriterionStatusRead,
  waiver: Schema.optionalKey(ProjectWorkCriterionWaiverRead),
});
export type ProjectWorkCriterionRead = typeof ProjectWorkCriterionRead.Type;

/** Approval of a concrete specification revision. Approval is intentionally
 * separate from task state so policy can invalidate it when the specification
 * changes. */
export const ProjectWorkApproval = Schema.Struct({
  approvalId: ProjectWorkApprovalId,
  taskId: ProjectWorkTaskId,
  specRevision: NonNegativeInt,
  approvedAt: IsoDateTime,
  attribution: ProjectWorkAttribution,
});
export type ProjectWorkApproval = typeof ProjectWorkApproval.Type;

export const ProjectWorkApprovalRead = Schema.Struct({
  ...ProjectWorkApproval.fields,
  attribution: ProjectWorkAttributionRead,
});
export type ProjectWorkApprovalRead = typeof ProjectWorkApprovalRead.Type;

export const ProjectWorkSpecification = Schema.Struct({
  objective: ProjectWorkRequiredText,
  scopeIn: ProjectWorkRequiredText,
  scopeOut: ProjectWorkRequiredText,
  criterionIds: Schema.Array(ProjectWorkCriterionId).check(Schema.isNonEmpty()),
  revision: ProjectWorkRevision,
  protected: Schema.Boolean,
});
export type ProjectWorkSpecification = typeof ProjectWorkSpecification.Type;

export const ProjectWorkTask = Schema.Struct({
  taskId: ProjectWorkTaskId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  summary: Schema.optionalKey(ProjectWorkSummary),
  state: ProjectWorkTaskState.pipe(Schema.withDecodingDefault(Effect.succeed("draft" as const))),
  specification: Schema.optionalKey(ProjectWorkSpecification),
  assignee: Schema.optionalKey(ProjectWorkActor),
  watchers: Schema.Array(ProjectWorkActor).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as Array<ProjectWorkActor>)),
  ),
  approval: Schema.optionalKey(ProjectWorkApproval),
  revision: ProjectWorkRevision,
  specRevision: ProjectWorkRevision,
  activeAttemptId: Schema.optionalKey(ProjectWorkAttemptId),
  failureKind: Schema.optionalKey(ProjectWorkFailureKind),
  blockerId: Schema.optionalKey(ProjectWorkBlockerId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.optionalKey(IsoDateTime),
  canceledAt: Schema.optionalKey(IsoDateTime),
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkTask = typeof ProjectWorkTask.Type;

/** A read shape which preserves newer state and failure values on older clients. */
export const ProjectWorkTaskRead = Schema.Struct({
  ...ProjectWorkTask.fields,
  state: ProjectWorkTaskStateRead,
  failureKind: Schema.optionalKey(ProjectWorkFailureKindRead),
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
  approval: Schema.optionalKey(ProjectWorkApprovalRead),
});
export type ProjectWorkTaskRead = typeof ProjectWorkTaskRead.Type;

export const ProjectWorkAttempt = Schema.Struct({
  attemptId: ProjectWorkAttemptId,
  taskId: ProjectWorkTaskId,
  state: ProjectWorkAttemptState,
  leaseToken: Schema.optionalKey(TrimmedNonEmptyString),
  leasedUntil: Schema.optionalKey(IsoDateTime),
  startedAt: Schema.optionalKey(IsoDateTime),
  endedAt: Schema.optionalKey(IsoDateTime),
  failureKind: Schema.optionalKey(ProjectWorkFailureKind),
  failureReason: Schema.optionalKey(ProjectWorkShortText),
  failureEvidenceIds: Schema.optionalKey(Schema.Array(ProjectWorkEvidenceId)),
  failureResolvedAt: Schema.optionalKey(IsoDateTime),
  failureResolutionReason: Schema.optionalKey(ProjectWorkShortText),
  failureResolutionEvidenceIds: Schema.optionalKey(Schema.Array(ProjectWorkEvidenceId)),
  failureResolutionAttribution: Schema.optionalKey(ProjectWorkAttribution),
  checkpointIds: Schema.Array(TrimmedNonEmptyString),
  revision: ProjectWorkRevision,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkAttempt = typeof ProjectWorkAttempt.Type;

const { leaseToken: _projectWorkLeaseToken, ...ProjectWorkAttemptReadFields } =
  ProjectWorkAttempt.fields;
export const ProjectWorkAttemptRead = Schema.Struct({
  ...ProjectWorkAttemptReadFields,
  state: ProjectWorkAttemptStateRead,
  failureKind: Schema.optionalKey(ProjectWorkFailureKindRead),
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkAttemptRead = typeof ProjectWorkAttemptRead.Type;

export const ProjectWorkEvidenceKind = Schema.Literals([
  "test",
  "review",
  "artifact",
  "observation",
  "external",
]);
export type ProjectWorkEvidenceKind = typeof ProjectWorkEvidenceKind.Type;
/** Read-only superset that preserves evidence kinds introduced by newer servers. */
export const ProjectWorkEvidenceKindRead = Schema.String;
export type ProjectWorkEvidenceKindRead = typeof ProjectWorkEvidenceKindRead.Type;

export const ProjectWorkEvidence = Schema.Struct({
  evidenceId: ProjectWorkEvidenceId,
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  criterionId: Schema.optionalKey(ProjectWorkCriterionId),
  kind: ProjectWorkEvidenceKind,
  summary: ProjectWorkShortText,
  detail: Schema.optionalKey(ProjectWorkSummary),
  uri: Schema.optionalKey(TrimmedString),
  scopeHash: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  outputArtifactIds: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(64),
    ),
  ),
  recordedAt: IsoDateTime,
  revision: ProjectWorkRevision,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkEvidence = typeof ProjectWorkEvidence.Type;

export const ProjectWorkEvidenceRead = Schema.Struct({
  ...ProjectWorkEvidence.fields,
  kind: ProjectWorkEvidenceKindRead,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkEvidenceRead = typeof ProjectWorkEvidenceRead.Type;

export const ProjectWorkRelationshipKind = Schema.Literals([
  "depends-on",
  "blocks",
  "duplicates",
  "relates-to",
  "continues",
  "supersedes",
]);
export type ProjectWorkRelationshipKind = typeof ProjectWorkRelationshipKind.Type;
/** Read-only superset that preserves relationship kinds introduced by newer servers. */
export const ProjectWorkRelationshipKindRead = Schema.String;
export type ProjectWorkRelationshipKindRead = typeof ProjectWorkRelationshipKindRead.Type;

export const ProjectWorkRelationship = Schema.Struct({
  relationshipId: ProjectWorkRelationshipId,
  projectId: ProjectId,
  fromTaskId: ProjectWorkTaskId,
  toTaskId: ProjectWorkTaskId,
  kind: ProjectWorkRelationshipKind,
  revision: ProjectWorkRevision,
  createdAt: IsoDateTime,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkRelationship = typeof ProjectWorkRelationship.Type;

export const ProjectWorkRelationshipRead = Schema.Struct({
  ...ProjectWorkRelationship.fields,
  kind: ProjectWorkRelationshipKindRead,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkRelationshipRead = typeof ProjectWorkRelationshipRead.Type;

export const ProjectWorkBlocker = Schema.Struct({
  blockerId: ProjectWorkBlockerId,
  taskId: ProjectWorkTaskId,
  reason: ProjectWorkShortText,
  resolver: ProjectWorkShortText,
  referenceIds: Schema.Array(TrimmedNonEmptyString),
  attention: Schema.Boolean,
  resolvedAt: Schema.optionalKey(IsoDateTime),
  revision: ProjectWorkRevision,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkBlocker = typeof ProjectWorkBlocker.Type;

export const ProjectWorkBlockerRead = Schema.Struct({
  ...ProjectWorkBlocker.fields,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkBlockerRead = typeof ProjectWorkBlockerRead.Type;

export const ProjectWorkKnowledgeSourceKind = Schema.Literals([
  "task",
  "thread",
  "session",
  "worktree",
  "attempt",
  "manual",
]);
export type ProjectWorkKnowledgeSourceKind = typeof ProjectWorkKnowledgeSourceKind.Type;
/** Read-only superset that preserves knowledge source kinds introduced by newer servers. */
export const ProjectWorkKnowledgeSourceKindRead = Schema.String;
export type ProjectWorkKnowledgeSourceKindRead = typeof ProjectWorkKnowledgeSourceKindRead.Type;

export const ProjectWorkKnowledge = Schema.Struct({
  knowledgeId: ProjectWorkKnowledgeId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  body: ProjectWorkSummary,
  sourceKind: ProjectWorkKnowledgeSourceKind,
  sourceId: TrimmedNonEmptyString,
  revision: ProjectWorkRevision,
  supersedesKnowledgeId: Schema.optionalKey(ProjectWorkKnowledgeId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkKnowledge = typeof ProjectWorkKnowledge.Type;

export const ProjectWorkKnowledgeRead = Schema.Struct({
  ...ProjectWorkKnowledge.fields,
  sourceKind: ProjectWorkKnowledgeSourceKindRead,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkKnowledgeRead = typeof ProjectWorkKnowledgeRead.Type;

export const ProjectWorkDecisionState = Schema.Literals([
  "proposed",
  "accepted",
  "rejected",
  "superseded",
]);
export type ProjectWorkDecisionState = typeof ProjectWorkDecisionState.Type;
/** Read-only superset that preserves decision states introduced by newer servers. */
export const ProjectWorkDecisionStateRead = Schema.String;
export type ProjectWorkDecisionStateRead = typeof ProjectWorkDecisionStateRead.Type;

export const ProjectWorkDecision = Schema.Struct({
  decisionId: ProjectWorkDecisionId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  body: ProjectWorkSummary,
  state: ProjectWorkDecisionState,
  supersedesDecisionId: Schema.optionalKey(ProjectWorkDecisionId),
  /** Transition metadata never rewrites the original proposal body. */
  rejectionReason: Schema.optionalKey(ProjectWorkShortText),
  rejectedAt: Schema.optionalKey(IsoDateTime),
  stateTransitionAttribution: Schema.optionalKey(ProjectWorkAttribution),
  revision: ProjectWorkRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkDecision = typeof ProjectWorkDecision.Type;

export const ProjectWorkDecisionRead = Schema.Struct({
  ...ProjectWorkDecision.fields,
  state: ProjectWorkDecisionStateRead,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkDecisionRead = typeof ProjectWorkDecisionRead.Type;

export const ProjectWorkAttentionReason = Schema.Literals([
  "blocked",
  "failed",
  "approval-required",
  "stale",
  "needs-review",
  "external-issue-closed",
]);
export type ProjectWorkAttentionReason = typeof ProjectWorkAttentionReason.Type;
/** Read-only superset that preserves attention reasons introduced by newer servers. */
export const ProjectWorkAttentionReasonRead = Schema.String;
export type ProjectWorkAttentionReasonRead = typeof ProjectWorkAttentionReasonRead.Type;

export const ProjectWorkAttention = Schema.Struct({
  taskId: ProjectWorkTaskId,
  reason: ProjectWorkAttentionReason,
  detail: Schema.optionalKey(ProjectWorkShortText),
  seenAt: Schema.optionalKey(IsoDateTime),
  resolvedAt: Schema.optionalKey(IsoDateTime),
  revision: ProjectWorkRevision,
});
export type ProjectWorkAttention = typeof ProjectWorkAttention.Type;

export const ProjectWorkAttentionRead = Schema.Struct({
  ...ProjectWorkAttention.fields,
  reason: ProjectWorkAttentionReasonRead,
});
export type ProjectWorkAttentionRead = typeof ProjectWorkAttentionRead.Type;

export const ProjectWorkCheckpointRead = Schema.Struct({
  checkpointId: TrimmedNonEmptyString,
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  ref: Schema.optionalKey(TrimmedNonEmptyString),
  capturedAt: IsoDateTime,
  revision: ProjectWorkRevision,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkCheckpointRead = typeof ProjectWorkCheckpointRead.Type;

export const ProjectWorkReadinessReason = Schema.Literals([
  "missing-specification",
  "missing-criterion",
  "approval-required",
  "unresolved-dependency",
  "active-blocker",
  "active-attempt",
  "manual-triage-failure",
  "canceled",
  "completed",
  "unknown-task",
]);
export type ProjectWorkReadinessReason = typeof ProjectWorkReadinessReason.Type;

export const ProjectWorkAction = Schema.Literals([
  "specify",
  "ready",
  "claim",
  "complete",
  "fail",
  "resolve-failure",
  "revise-protected-specification",
  "reclaim",
  "takeover",
  "block",
  "resolve-blocker",
  "reopen",
  "cancel",
  "duplicate",
  "approve",
  "assign",
  "watch",
  "unwatch",
  "protect-specification",
  "waive-criterion",
  "add-evidence",
  "link-relationship",
  "unlink-relationship",
]);
export type ProjectWorkAction = typeof ProjectWorkAction.Type;

export const ProjectWorkActionAvailability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectWorkActionAvailability = typeof ProjectWorkActionAvailability.Type;

export const ProjectWorkClaimability = Schema.Struct({
  claimable: Schema.Boolean,
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectWorkClaimability = typeof ProjectWorkClaimability.Type;

export const ProjectWorkReadiness = Schema.Struct({
  ready: Schema.Boolean,
  reasons: Schema.Array(ProjectWorkReadinessReason),
});
export type ProjectWorkReadiness = typeof ProjectWorkReadiness.Type;

export const ProjectWorkCommentId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectWorkCommentId"),
);
export type ProjectWorkCommentId = typeof ProjectWorkCommentId.Type;

export const ProjectWorkComment = Schema.Struct({
  commentId: ProjectWorkCommentId,
  projectId: ProjectId,
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  body: ProjectWorkSummary,
  createdAt: IsoDateTime,
  revision: ProjectWorkRevision,
  attribution: ProjectWorkAttributionField,
});
export type ProjectWorkComment = typeof ProjectWorkComment.Type;

export const ProjectWorkCommentRead = Schema.Struct({
  ...ProjectWorkComment.fields,
  attribution: Schema.optionalKey(ProjectWorkAttributionRead),
});
export type ProjectWorkCommentRead = typeof ProjectWorkCommentRead.Type;

export const ProjectWorkBriefingKind = Schema.Literals(["compact", "standard", "detailed"]);
export type ProjectWorkBriefingKind = typeof ProjectWorkBriefingKind.Type;
/** Read-only superset that preserves briefing kinds introduced by newer servers. */
export const ProjectWorkBriefingKindRead = Schema.String;
export type ProjectWorkBriefingKindRead = typeof ProjectWorkBriefingKindRead.Type;

export const ProjectWorkBriefing = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectWorkBriefingKind,
  generatedAt: IsoDateTime,
  sourceRevision: ProjectWorkRevision,
  text: ProjectWorkSummary,
  includedTaskIds: Schema.Array(ProjectWorkTaskId),
  includedKnowledgeIds: Schema.Array(ProjectWorkKnowledgeId),
  omittedReasons: Schema.Array(TrimmedNonEmptyString),
  narrative: Schema.optionalKey(ProjectWorkShortText),
  narrativeModel: Schema.optionalKey(TrimmedNonEmptyString),
  narrativeGeneratedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectWorkBriefing = typeof ProjectWorkBriefing.Type;

export const ProjectWorkBriefingRead = Schema.Struct({
  ...ProjectWorkBriefing.fields,
  kind: ProjectWorkBriefingKindRead,
});
export type ProjectWorkBriefingRead = typeof ProjectWorkBriefingRead.Type;

export const ProjectWorkDeltaKind = Schema.Literals([
  "task",
  "attempt",
  "criterion",
  "evidence",
  "relationship",
  "blocker",
  "knowledge",
  "decision",
  "comment",
  "attention",
]);
export type ProjectWorkDeltaKind = typeof ProjectWorkDeltaKind.Type;
/** Read-only superset that preserves delta kinds introduced by newer servers. */
export const ProjectWorkDeltaKindRead = Schema.String;
export type ProjectWorkDeltaKindRead = typeof ProjectWorkDeltaKindRead.Type;

export const ProjectWorkDelta = Schema.Struct({
  projectId: ProjectId,
  cursor: NonNegativeInt,
  eventId: EventId,
  kind: ProjectWorkDeltaKind,
  recordId: TrimmedNonEmptyString,
  revision: ProjectWorkRevision,
  deleted: Schema.Boolean,
  record: Schema.optionalKey(Schema.Unknown),
});
export type ProjectWorkDelta = typeof ProjectWorkDelta.Type;

export const ProjectWorkDeltaRead = Schema.Struct({
  ...ProjectWorkDelta.fields,
  kind: ProjectWorkDeltaKindRead,
});
export type ProjectWorkDeltaRead = typeof ProjectWorkDeltaRead.Type;

/**
 * Cursor used by the project-work stream.  This is the durable event-log
 * sequence, rather than the project revision: unrelated project events may
 * advance it, and a client must be able to resume after those skipped rows.
 */
export const ProjectWorkStreamInput = Schema.Struct({
  projectId: ProjectId,
  afterCursor: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type ProjectWorkStreamInput = typeof ProjectWorkStreamInput.Type;

export const ProjectWorkStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delta"),
    delta: ProjectWorkDelta,
  }),
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
    projectId: ProjectId,
    cursor: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("resync-required"),
    projectId: ProjectId,
    cursor: NonNegativeInt,
    reason: Schema.Literals(["cursor-ahead", "replay-too-large"]),
  }),
]);
export type ProjectWorkStreamItem = typeof ProjectWorkStreamItem.Type;

/**
 * The bounded result returned by a project-work mutation.  Mutations expose
 * the committed cursor and affected fields, while reads remain the way to
 * retrieve records.  Keeping this separate from the reduced aggregate state
 * prevents RPC and MCP retries from accidentally shipping every collection.
 */
export const ProjectWorkMutationDelta = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  eventIds: Schema.Array(EventId).check(Schema.isMaxLength(64)),
  changedFields: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(64)),
});
export type ProjectWorkMutationDelta = typeof ProjectWorkMutationDelta.Type;

export const ProjectWorkWriteResult = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  receipt: Schema.Struct({
    commandId: CommandId,
    status: Schema.Literals(["accepted", "duplicate"]),
    projectId: ProjectId,
    revision: NonNegativeInt,
    eventCount: NonNegativeInt,
  }),
  delta: ProjectWorkMutationDelta,
});
export type ProjectWorkWriteResult = typeof ProjectWorkWriteResult.Type;

/** Additive pagination metadata for callers that need a coherent revision for
 * a bounded collection. Older callers may continue requesting the legacy
 * array response by omitting `envelope`. */
export const ProjectWorkBoundedReadEnvelope = Schema.Struct({
  projectId: ProjectId,
  revision: ProjectWorkRevision,
  offset: NonNegativeInt,
  limit: NonNegativeInt,
  hasMore: Schema.Boolean,
  items: Schema.Array(Schema.Unknown),
});
export type ProjectWorkBoundedReadEnvelope = typeof ProjectWorkBoundedReadEnvelope.Type;

/** One authoritative, bounded view of the records needed to act on a task.
 * The active attempt uses the public read shape, which excludes lease tokens. */
export const ProjectWorkTaskContext = Schema.Struct({
  projectId: ProjectId,
  revision: ProjectWorkRevision,
  task: ProjectWorkTaskRead,
  activeAttempt: Schema.optionalKey(ProjectWorkAttemptRead),
  /** Newest unresolved failed/expired attempt selected by server policy. */
  reclaimableAttempt: Schema.optionalKey(ProjectWorkAttemptRead),
  criteria: Schema.Array(ProjectWorkCriterionRead),
  evidence: Schema.Array(ProjectWorkEvidenceRead),
  relationships: Schema.Array(ProjectWorkRelationshipRead),
  blockers: Schema.Array(ProjectWorkBlockerRead),
  comments: Schema.Array(ProjectWorkCommentRead),
  children: Schema.Struct({
    criteria: Schema.Array(ProjectWorkCriterionRead),
    evidence: Schema.Array(ProjectWorkEvidenceRead),
    relationships: Schema.Array(ProjectWorkRelationshipRead),
    blockers: Schema.Array(ProjectWorkBlockerRead),
    comments: Schema.Array(ProjectWorkCommentRead),
  }),
  policy: Schema.Struct({
    taskId: ProjectWorkTaskId,
    readiness: ProjectWorkReadiness,
    claimability: ProjectWorkClaimability,
    actions: Schema.Record(ProjectWorkAction, ProjectWorkActionAvailability),
    attention: Schema.Array(ProjectWorkAttentionRead),
  }),
});
export type ProjectWorkTaskContext = typeof ProjectWorkTaskContext.Type;

export const ProjectWorkExportV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  format: Schema.Literal("json"),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  exportedAt: IsoDateTime,
  projectRevision: ProjectWorkRevision,
  tasks: Schema.Array(ProjectWorkTaskRead),
  attempts: Schema.Array(ProjectWorkAttemptRead),
  criteria: Schema.Array(ProjectWorkCriterionRead),
  evidence: Schema.Array(ProjectWorkEvidenceRead),
  relationships: Schema.Array(ProjectWorkRelationshipRead),
  blockers: Schema.Array(ProjectWorkBlockerRead),
  checkpoints: Schema.Array(ProjectWorkCheckpointRead),
  attention: Schema.Array(ProjectWorkAttentionRead),
  knowledge: Schema.Array(ProjectWorkKnowledgeRead),
  decisions: Schema.Array(ProjectWorkDecisionRead),
  comments: Schema.Array(ProjectWorkCommentRead),
  history: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  redactions: Schema.Array(TrimmedNonEmptyString),
});
export const ProjectWorkExportV2 = Schema.Struct({
  ...ProjectWorkExportV1.fields,
  schemaVersion: Schema.Literal(2),
  foundationRecords: Schema.Array(ProjectTeamRecordRead).check(Schema.isMaxLength(10_000)),
});
export const ProjectWorkExport = Schema.Union([ProjectWorkExportV1, ProjectWorkExportV2]);
export type ProjectWorkExport = typeof ProjectWorkExport.Type;

export const ProjectWorkMarkdownExport = Schema.Struct({
  format: Schema.Literal("markdown"),
  projectId: ProjectId,
  generatedAt: IsoDateTime,
  authoritative: Schema.Literal(false),
  contents: Schema.String,
});
export type ProjectWorkMarkdownExport = typeof ProjectWorkMarkdownExport.Type;

const ProjectWorkCommandFields = {
  commandId: CommandId,
  projectId: ProjectId,
  expectedRevision: ProjectWorkExpectedRevision,
  attribution: ProjectWorkAttributionField,
};

export const ProjectWorkTaskCreateCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.create"),
  taskId: ProjectWorkTaskId,
  title: TrimmedNonEmptyString,
  summary: Schema.optionalKey(ProjectWorkSummary),
  deliverableKind: Schema.optionalKey(ProjectTeamDeliverableKind),
  createdAt: IsoDateTime,
});

/** Human refinement links the existing intake identity without approving execution. */
export const ProjectWorkIssueRefineCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.issue.refine"),
  expectedRevision: NonNegativeInt,
  issueRecordId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  expectedIssueRevision: NonNegativeInt,
  target: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("new-task"),
      taskId: ProjectWorkTaskId,
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
      summary: Schema.optionalKey(ProjectWorkSummary),
      deliverableKind: ProjectTeamDeliverableKind,
    }),
    Schema.Struct({
      kind: Schema.Literal("existing-task"),
      taskId: ProjectWorkTaskId,
      expectedTaskRevision: NonNegativeInt,
    }),
    Schema.Struct({
      kind: Schema.Literal("mission"),
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
      objective: Schema.String.check(Schema.isMaxLength(32_000)),
    }),
  ]),
  refinedAt: IsoDateTime,
});
export type ProjectWorkIssueRefineCommand = typeof ProjectWorkIssueRefineCommand.Type;

export const ProjectWorkTaskSpecifyCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.specify"),
  taskId: ProjectWorkTaskId,
  specification: ProjectWorkSpecification,
  updatedAt: IsoDateTime,
});

/**
 * The approval bound to one exact protected-specification payload. The server
 * compares `payloadFingerprint` against the canonical full payload before it
 * accepts the revision; identity and single-use semantics belong to P6.
 */
export const ProjectWorkProtectedSpecificationApproval = Schema.Struct({
  approvalId: ProjectWorkApprovalId,
  taskId: ProjectWorkTaskId,
  specRevision: NonNegativeInt,
  payloadFingerprint: TrimmedNonEmptyString,
  approvedAt: IsoDateTime,
  attribution: ProjectWorkAttribution,
});
export type ProjectWorkProtectedSpecificationApproval =
  typeof ProjectWorkProtectedSpecificationApproval.Type;

/** Ephemeral proof carried by an agent for any sensitive project-work write.
 * The token is consumed by the server auth layer and is never part of an
 * event or a durable receipt. Protected specification revisions additionally
 * carry the human approval payload above. */
export const ProjectWorkAgentApprovalProof = Schema.Struct({
  approvalToken: TrimmedNonEmptyString,
});
export type ProjectWorkAgentApprovalProof = typeof ProjectWorkAgentApprovalProof.Type;

/** Changes to a protected specification are explicit and carry all results
 * whose evidence was produced against the old revision. */
export const ProjectWorkTaskReviseProtectedSpecificationCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.revise-protected-specification"),
  taskId: ProjectWorkTaskId,
  specification: ProjectWorkSpecification,
  criterionSnapshots: Schema.Array(ProjectWorkCriterion),
  affectedResultIds: Schema.Array(ProjectWorkResultId),
  approval: ProjectWorkProtectedSpecificationApproval,
  /** Ephemeral bearer proof supplied by an agent; never persisted in events. */
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
  revisedAt: IsoDateTime,
  attribution: ProjectWorkAttribution,
});
export type ProjectWorkTaskReviseProtectedSpecificationCommand =
  typeof ProjectWorkTaskReviseProtectedSpecificationCommand.Type;

/**
 * Returns the complete protected-revision payload with the fingerprint field
 * intentionally omitted. Keeping this projection next to the contract makes
 * web, MCP, and the server bind approval to the same bytes.
 */
export const projectWorkProtectedRevisionFingerprintPayload = (
  command: ProjectWorkTaskReviseProtectedSpecificationCommand,
): unknown => ({
  type: command.type,
  commandId: command.commandId,
  projectId: command.projectId,
  taskId: command.taskId,
  expectedRevision: command.expectedRevision,
  specification: command.specification,
  criterionSnapshots: command.criterionSnapshots,
  affectedResultIds: command.affectedResultIds,
  // A provider session is a transport lease, not the durable source. Keep
  // session-specific provenance in the stored attribution URI, but exclude
  // it from approval binding so a renewed session can retry the same intent.
  attribution: stableProjectWorkAttributionForFingerprint(command.attribution),
  revisedAt: command.revisedAt,
  approval: {
    approvalId: command.approval.approvalId,
    taskId: command.approval.taskId,
    specRevision: command.approval.specRevision,
    approvedAt: command.approval.approvedAt,
    attribution: stableProjectWorkAttributionForFingerprint(command.approval.attribution),
  },
});

const stableProjectWorkAttributionForFingerprint = (
  attribution: ProjectWorkAttribution,
): unknown => ({
  actor: attribution.actor,
  source: {
    kind: attribution.source.kind,
    ...(attribution.source.id === undefined ? {} : { id: attribution.source.id }),
  },
  recordedAt: attribution.recordedAt,
});

/** Fingerprint used before the server has minted the approval id and timestamp.
 * Adapters may bind an approval to this stable intent first; the authoritative
 * decider still verifies the complete payload fingerprint on write. */
export const projectWorkProtectedRevisionIntentFingerprintPayload = (
  command: ProjectWorkTaskReviseProtectedSpecificationCommand,
): unknown => {
  const payload = projectWorkProtectedRevisionFingerprintPayload(command) as Record<
    string,
    unknown
  >;
  return {
    ...payload,
    approval: { taskId: command.taskId, specRevision: command.specification.revision },
  };
};

/** Alias retained for callers that use the noun-first operation name. */
export const ProjectWorkTaskProtectedSpecificationReviseCommand =
  ProjectWorkTaskReviseProtectedSpecificationCommand;
export type ProjectWorkTaskProtectedSpecificationReviseCommand =
  ProjectWorkTaskReviseProtectedSpecificationCommand;

export const ProjectWorkTaskReadyCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.ready"),
  taskId: ProjectWorkTaskId,
  updatedAt: IsoDateTime,
});

export const ProjectWorkTaskClaimCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.claim"),
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  leaseToken: TrimmedNonEmptyString,
  leasedUntil: IsoDateTime,
  claimedAt: IsoDateTime,
});

export const ProjectWorkTaskCompleteCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.complete"),
  taskId: ProjectWorkTaskId,
  attemptId: Schema.optionalKey(ProjectWorkAttemptId),
  /** Present on provider/agent writes; omitted for tokenless human actions. */
  leaseToken: Schema.optionalKey(TrimmedNonEmptyString),
  satisfiedCriterionIds: Schema.Array(ProjectWorkCriterionId),
  completedAt: IsoDateTime,
});

export const ProjectWorkTaskFailCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.fail"),
  taskId: ProjectWorkTaskId,
  attemptId: Schema.optionalKey(ProjectWorkAttemptId),
  /** Present on provider/agent writes; omitted for tokenless human actions. */
  leaseToken: Schema.optionalKey(TrimmedNonEmptyString),
  failureKind: ProjectWorkFailureKind,
  reason: ProjectWorkShortText,
  evidenceIds: Schema.optionalKey(Schema.Array(ProjectWorkEvidenceId)),
  failedAt: IsoDateTime,
});

/** A human-authored resolution closes a failed attempt and lets policy derive
 * the task's next state from the uncapped aggregate history. */
export const ProjectWorkTaskResolveFailureCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.resolve-failure"),
  taskId: ProjectWorkTaskId,
  reason: ProjectWorkShortText,
  evidenceIds: Schema.Array(ProjectWorkEvidenceId),
  resolvedAt: IsoDateTime,
  attribution: Schema.Struct({
    actor: Schema.Struct({
      kind: Schema.Literal("human"),
      id: Schema.optionalKey(TrimmedNonEmptyString),
      displayName: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    source: ProjectWorkSource,
    recordedAt: IsoDateTime,
  }),
});

export const ProjectWorkAttemptRenewCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attempt.renew"),
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  leaseToken: TrimmedNonEmptyString,
  leasedUntil: IsoDateTime,
  renewedAt: IsoDateTime,
});

export const ProjectWorkAttemptCheckpointCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attempt.checkpoint"),
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  leaseToken: TrimmedNonEmptyString,
  checkpointId: TrimmedNonEmptyString,
  ref: Schema.optionalKey(TrimmedString),
  capturedAt: IsoDateTime,
});

export const ProjectWorkAttemptExpireCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attempt.expire"),
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  reason: ProjectWorkShortText,
  expiredAt: IsoDateTime,
});

export const ProjectWorkAttemptReclaimCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attempt.reclaim"),
  taskId: ProjectWorkTaskId,
  previousAttemptId: ProjectWorkAttemptId,
  attemptId: ProjectWorkAttemptId,
  leaseToken: TrimmedNonEmptyString,
  leasedUntil: IsoDateTime,
  claimedAt: IsoDateTime,
});

export const ProjectWorkAttemptTakeoverCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attempt.takeover"),
  taskId: ProjectWorkTaskId,
  previousAttemptId: ProjectWorkAttemptId,
  attemptId: ProjectWorkAttemptId,
  leaseToken: TrimmedNonEmptyString,
  leasedUntil: IsoDateTime,
  claimedAt: IsoDateTime,
  authorized: Schema.Boolean,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkTaskBlockCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.block"),
  taskId: ProjectWorkTaskId,
  blockerId: ProjectWorkBlockerId,
  reason: ProjectWorkShortText,
  resolver: ProjectWorkShortText,
  referenceIds: Schema.Array(TrimmedNonEmptyString),
  blockedAt: IsoDateTime,
});

export const ProjectWorkTaskResolveBlockerCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.resolve-blocker"),
  taskId: ProjectWorkTaskId,
  blockerId: ProjectWorkBlockerId,
  resolvedAt: IsoDateTime,
});

export const ProjectWorkTaskReopenCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.reopen"),
  taskId: ProjectWorkTaskId,
  reopenedAt: IsoDateTime,
});

export const ProjectWorkTaskCancelCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.cancel"),
  taskId: ProjectWorkTaskId,
  reason: Schema.optionalKey(ProjectWorkShortText),
  canceledAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkTaskDuplicateCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.duplicate"),
  sourceTaskId: ProjectWorkTaskId,
  duplicateTaskId: ProjectWorkTaskId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  summary: Schema.optionalKey(ProjectWorkSummary),
  duplicatedAt: IsoDateTime,
});

export const ProjectWorkTaskApproveCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.approve"),
  taskId: ProjectWorkTaskId,
  approvalId: ProjectWorkApprovalId,
  specRevision: NonNegativeInt,
  approvedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkTaskAssignCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.assign"),
  taskId: ProjectWorkTaskId,
  assignee: Schema.NullOr(ProjectWorkActor),
  assignedAt: IsoDateTime,
});

export const ProjectWorkTaskWatchCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.watch"),
  taskId: ProjectWorkTaskId,
  watcher: ProjectWorkActor,
  watchedAt: IsoDateTime,
});

export const ProjectWorkTaskUnwatchCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.unwatch"),
  taskId: ProjectWorkTaskId,
  watcher: ProjectWorkActor,
  unwatchedAt: IsoDateTime,
});

export const ProjectWorkTaskProtectSpecificationCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.task.protect-specification"),
  taskId: ProjectWorkTaskId,
  specRevision: NonNegativeInt,
  protectedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkCriterionUpsertCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.criterion.upsert"),
  taskId: ProjectWorkTaskId,
  criterion: ProjectWorkCriterion,
  updatedAt: IsoDateTime,
});

export const ProjectWorkCriterionWaiveCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.criterion.waive"),
  taskId: ProjectWorkTaskId,
  criterionId: ProjectWorkCriterionId,
  waiver: ProjectWorkCriterionWaiver,
  waivedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkEvidenceAddCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.evidence.add"),
  evidence: ProjectWorkEvidence,
  addedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkRelationshipLinkCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.relationship.link"),
  relationship: ProjectWorkRelationship,
  linkedAt: IsoDateTime,
});

export const ProjectWorkRelationshipUnlinkCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.relationship.unlink"),
  relationshipId: ProjectWorkRelationshipId,
  unlinkedAt: IsoDateTime,
});

export const ProjectWorkKnowledgePromoteCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.knowledge.promote"),
  knowledge: ProjectWorkKnowledge,
  promotedAt: IsoDateTime,
});

export const ProjectWorkDecisionProposeCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.decision.propose"),
  decision: ProjectWorkDecision,
  proposedAt: IsoDateTime,
});

export const ProjectWorkDecisionAcceptCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.decision.accept"),
  decisionId: ProjectWorkDecisionId,
  acceptedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkDecisionRejectCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.decision.reject"),
  decisionId: ProjectWorkDecisionId,
  reason: ProjectWorkShortText,
  rejectedAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkDecisionSupersedeCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  // Supersession is an attributed state transition; unlike ordinary optional
  // command attribution, callers must identify who/what caused this write.
  attribution: ProjectWorkAttribution,
  type: Schema.Literal("project-work.decision.supersede"),
  decisionId: ProjectWorkDecisionId,
  replacement: ProjectWorkDecision,
  supersededAt: IsoDateTime,
  approvalToken: Schema.optionalKey(TrimmedNonEmptyString),
});

export const ProjectWorkCommentAddCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.comment.add"),
  comment: ProjectWorkComment,
  addedAt: IsoDateTime,
});

export const ProjectWorkAttentionSeenCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.attention.seen"),
  taskId: ProjectWorkTaskId,
  seenAt: IsoDateTime,
});

const GuidedText = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const GuidedBody = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
const GuidedId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const utf8Length = (value: string) => {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};
const GuidedFields = {
  commandId: CommandId,
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  expectedRevision: NonNegativeInt,
  expectedTaskRevision: NonNegativeInt,
};

export const ProjectTeamReviewCriterionAssessment = Schema.Struct({
  criterionId: ProjectWorkCriterionId,
  expectedRevision: NonNegativeInt,
  verdict: Schema.Literals(["met", "not-met"]),
  detail: GuidedBody,
  evidenceIds: Schema.Array(GuidedId).check(
    Schema.isMaxLength(64),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
}).check(
  Schema.makeFilter(
    (assessment) => assessment.verdict !== "met" || assessment.evidenceIds.length > 0,
    {
      message: "A positive criterion assessment requires retained evidence",
    },
  ),
);
export type ProjectTeamReviewCriterionAssessment = typeof ProjectTeamReviewCriterionAssessment.Type;

/** Guided intent inputs describe a requested change, never caller-created authority. */
export const ProjectTeamGuidedIntent = Schema.Union([
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.assignment.start"),
    assignmentKind: Schema.Literals(["planning", "review"]),
    objective: GuidedBody,
    outputDescriptions: Schema.Array(GuidedText).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16),
    ),
    specRevision: NonNegativeInt,
    specificationGateId: GuidedId,
    expectedSpecificationGateRevision: NonNegativeInt,
    parentPlan: Schema.optionalKey(
      Schema.Struct({
        recordId: GuidedId,
        expectedRecordRevision: NonNegativeInt,
        planRevision: NonNegativeInt,
        gateId: GuidedId,
        expectedGateRevision: NonNegativeInt,
      }),
    ),
  }).check(
    Schema.makeFilter(
      (input) => input.assignmentKind !== "review" || input.parentPlan !== undefined,
      { message: "A review assignment requires its exact approved parent plan" },
    ),
    Schema.makeFilter(
      (input) => input.assignmentKind !== "planning" || input.outputDescriptions.length === 1,
      { message: "A planning assignment has one proposed-plan output" },
    ),
  ),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.investigation.start"),
    objective: GuidedBody,
    outputDescriptions: Schema.Array(GuidedText).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16),
    ),
    issueRecordId: Schema.optionalKey(GuidedId),
    expectedIssueRevision: Schema.optionalKey(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.issueRecordId === undefined) === (input.expectedIssueRevision === undefined),
      { message: "An issue target requires its expected revision" },
    ),
  ),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.specification.propose"),
    expectedSpecRevision: NonNegativeInt,
    specification: ProjectWorkSpecification,
    criterionSnapshots: Schema.Array(ProjectWorkCriterion).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.plan.propose"),
    specRevision: NonNegativeInt,
    content: GuidedBody,
    dependencyTaskIds: Schema.Array(ProjectWorkTaskId).check(Schema.isMaxLength(64)),
    integrationSourceRefs: Schema.optionalKey(ProjectTeamIntegrationSourceRefs),
    previousPlanId: Schema.optionalKey(GuidedId),
    expectedPreviousPlanRevision: Schema.optionalKey(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.previousPlanId === undefined) === (input.expectedPreviousPlanRevision === undefined),
      { message: "A previous plan target requires its expected record revision" },
    ),
  ),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.execution.start"),
    specRevision: NonNegativeInt,
    planRevision: NonNegativeInt,
    specGateId: GuidedId,
    expectedSpecGateRevision: NonNegativeInt,
    planId: GuidedId,
    expectedPlanRecordRevision: NonNegativeInt,
    planGateId: GuidedId,
    expectedPlanGateRevision: NonNegativeInt,
  }),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.task.control"),
    control: Schema.Union([
      Schema.Struct({
        action: Schema.Literals([
          "defer",
          "reopen",
          "pause",
          "resume",
          "cancel",
          "resolve-failure",
        ]),
        reason: GuidedText,
      }),
      Schema.Struct({
        action: Schema.Literal("reassign"),
        reason: GuidedText,
        recipientMemberId: GuidedId,
        expectedMemberRevision: NonNegativeInt,
      }),
    ]),
  }),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.assignment.report"),
    specRevision: NonNegativeInt,
    planRevision: NonNegativeInt,
    assignmentId: GuidedId,
    expectedAssignmentRevision: NonNegativeInt,
    summary: GuidedBody,
    evidenceIds: Schema.Array(GuidedId).check(Schema.isMaxLength(64)),
    outputArtifactIds: Schema.Array(GuidedId).check(Schema.isMaxLength(64)),
    outputs: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          criterionId: ProjectWorkCriterionId,
          detail: GuidedBody,
          summary: Schema.optionalKey(GuidedText),
          kind: Schema.Literals(["observation", "artifact"]),
        }),
      ).check(Schema.isMaxLength(64)),
    ),
    criterionAssessments: Schema.optionalKey(
      Schema.Array(ProjectTeamReviewCriterionAssessment).check(
        Schema.isMaxLength(64),
        Schema.makeFilter(
          (assessments) =>
            new Set(assessments.map((assessment) => assessment.criterionId)).size ===
            assessments.length,
        ),
      ),
    ),
    outcome: Schema.Literals(["findings", "review-ready", "complete"]),
  }).check(
    Schema.makeFilter(
      (input) => input.criterionAssessments === undefined || input.outcome === "complete",
      {
        message: "Criterion assessments require a complete review report",
      },
    ),
    Schema.makeFilter(
      (input) =>
        utf8Length(input.summary) +
          (input.outputs ?? []).reduce(
            (total, output) => total + utf8Length(output.detail) + utf8Length(output.summary ?? ""),
            0,
          ) +
          (input.criterionAssessments === undefined
            ? 0
            : utf8Length(canonicalProjectWorkPayload(input.criterionAssessments))) <=
        131_072,
      { message: "Retained report content exceeds its 128 KiB byte limit" },
    ),
  ),
  Schema.Struct({
    ...GuidedFields,
    type: Schema.Literal("project-team.repair.resolve"),
    episodeId: GuidedId,
    expectedEpisodeRevision: NonNegativeInt,
    failureFingerprint: GuidedText,
    relevantRevision: GuidedText,
    decision: Schema.Literals(["diagnose", "approve-one-repair", "revise-scope", "abandon"]),
    reason: GuidedText,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamGuidedIntent = typeof ProjectTeamGuidedIntent.Type;

/** Private gateway compilation; raw foundation commands remain denied by transports. */
export const ProjectWorkGuidedTransition = Schema.Struct({
  intent: ProjectTeamGuidedIntent,
  integrationSources: Schema.optionalKey(ProjectTeamIntegrationSources),
  bindingId: Schema.optionalKey(GuidedId),
  generation: Schema.optionalKey(NonNegativeInt),
}).check(
  Schema.makeFilter(
    (input) => (input.bindingId === undefined) === (input.generation === undefined),
    { message: "A compiled managed identity requires its generation" },
  ),
);
export type ProjectWorkGuidedTransition = typeof ProjectWorkGuidedTransition.Type;

/** Private scheduler/runtime transitions. Public transports deny foundation commands. */
const JoinedRunCounter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const ReviewProofDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ReviewProofSnapshot = Schema.Struct({
  id: GuidedId,
  revision: JoinedRunCounter,
  sha256: ReviewProofDigest,
});
export const ProjectTeamReviewCompletionDenialReason = Schema.Literals([
  "stale-proof",
  "scope-changed",
  "control-changed",
  "assignment-failed",
  "assignment-incomplete",
  "dependency-incomplete",
  "invalid-proof",
]);
const ReviewParentAssessmentSnapshot = Schema.Struct({
  assessmentSha256: ReviewProofDigest,
  projectId: GuidedId,
  taskId: GuidedId,
  target: ProjectTeamReviewFinding.fields.target,
  parentScopeHash: GuidedId,
  criterion: ReviewProofSnapshot,
  evidence: Schema.Array(
    Schema.Struct({
      ...ReviewProofSnapshot.fields,
      taskId: GuidedId,
      criterionId: Schema.optionalKey(GuidedId),
      scopeHash: GuidedId,
    }),
  ).check(
    Schema.isMaxLength(64),
    Schema.makeFilter((values) => new Set(values.map((value) => value.id)).size === values.length),
  ),
});
const ReviewParentAssessments = Schema.Struct({
  snapshots: Schema.Array(ReviewParentAssessmentSnapshot).check(
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (values) => new Set(values.map((value) => value.criterion.id)).size === values.length,
    ),
  ),
  verification: Schema.Struct({
    environmentId: GuidedId,
    jobId: GuidedId,
    manifestHash: ReviewProofDigest,
    attemptId: GuidedId,
    resultHash: ReviewProofDigest,
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
    evidenceId: Schema.optionalKey(GuidedId),
    applicabilityId: Schema.optionalKey(GuidedId),
  }),
});
/** Private joined settlement carries retained child proof, never an approval grant. */
export const ProjectTeamReviewCompletionProof = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    proposalCommandId: GuidedId,
    proposalSha256: ReviewProofDigest,
    assignmentOperationId: GuidedId,
    assignmentRequestHash: ReviewProofDigest,
    assignmentReceiptSha256: ReviewProofDigest,
    joinedReceiptId: GuidedId,
    joinedEvidenceSha256: ReviewProofDigest,
    report: ProjectTeamGuidedIntent.check(
      Schema.makeFilter(
        (value) => value.type === "project-team.assignment.report" && value.outcome === "complete",
      ),
    ),
    reportAttribution: ProjectWorkAttribution,
    assignment: ProjectTeamTaskMembership.check(
      Schema.makeFilter(
        (value) =>
          value.status === "active" &&
          value.executionKind === "managed" &&
          value.deliverableKind === "review" &&
          value.parentTaskId !== undefined,
      ),
    ),
    target: ProjectTeamReviewFinding.fields.target,
    provenance: ProjectTeamReviewFindingProvenance,
    criteria: Schema.Array(ReviewProofSnapshot).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(64),
    ),
    evidence: Schema.Array(ReviewProofSnapshot).check(Schema.isMaxLength(128)),
    outputs: Schema.Array(
      Schema.Struct({ evidenceId: GuidedId, criterionId: GuidedId, sha256: ReviewProofDigest }),
    ).check(Schema.isMaxLength(64)),
    reportEvidenceId: GuidedId,
    reportCommentId: GuidedId,
    findings: Schema.Array(
      Schema.Struct({ findingId: GuidedId, revision: JoinedRunCounter, sha256: ReviewProofDigest }),
    ).check(Schema.isMaxLength(256)),
    parentAssessments: Schema.optionalKey(ReviewParentAssessments),
  }),
  Schema.Struct({
    status: Schema.Literal("denied"),
    proposalCommandId: GuidedId,
    proposalSha256: ReviewProofDigest,
    assignmentOperationId: GuidedId,
    reason: ProjectTeamReviewCompletionDenialReason,
  }),
])
  .check(
    Schema.makeFilter((value) => utf8Length(canonicalProjectWorkPayload(value)) <= 524288, {
      message: "Retained review completion proof exceeds its 512 KiB byte limit",
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamReviewCompletionProof = typeof ProjectTeamReviewCompletionProof.Type;

const PublicationRepository = Schema.Struct({
  host: GuidedId.check(
    Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  ),
  nodeId: GuidedId,
  nameWithOwner: GuidedId.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
});
/** Private host-owned outbox envelope; transports cannot submit foundation commands. */
export const ProjectWorkPublicationRequest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("create-pr"),
  operationId: GuidedId,
  marker: GuidedId.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/u)),
  repository: PublicationRepository,
  target: Schema.Struct({
    projectId: ProjectId,
    taskId: ProjectWorkTaskId,
    specRevision: JoinedRunCounter,
    planRevision: JoinedRunCounter,
    scopeHash: GuidedId,
    baseSha: GuidedId,
    headSha: GuidedId,
    baseRef: GuidedId,
    headRef: GuidedId,
    headRepositoryNodeId: GuidedId,
    headSelector: GuidedId,
  }),
  expectedTaskRevision: JoinedRunCounter,
  authorizationRecordIds: Schema.Array(GuidedId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  threadId: Schema.optionalKey(ThreadId),
  title: GuidedText,
  body: Schema.String.check(Schema.isMaxLength(32_000)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectWorkPublicationRequest = typeof ProjectWorkPublicationRequest.Type;
const PublicationOutcomeFields = {
  version: Schema.Literal(1),
  operationId: GuidedId,
  requestHash: GuidedId.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  claimGeneration: JoinedRunCounter,
  observedAt: IsoDateTime,
};
export const ProjectWorkPublicationOutcome = Schema.Union([
  Schema.Struct({
    ...PublicationOutcomeFields,
    kind: Schema.Literal("confirmed"),
    marker: GuidedId,
    repository: PublicationRepository,
    pullRequest: Schema.Struct({
      nodeId: GuidedId,
      number: JoinedRunCounter.check(Schema.isGreaterThan(0)),
      url: GuidedText,
      state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
      baseSha: GuidedId,
      headSha: GuidedId,
      baseRef: GuidedId,
      headRef: GuidedId,
      headRepositoryNodeId: GuidedId,
    }),
  }),
  Schema.Struct({
    ...PublicationOutcomeFields,
    kind: Schema.Literal("uncertain"),
    reason: Schema.Literals([
      "missing-match",
      "ambiguous-match",
      "changed-identity",
      "incomplete-response",
      "interrupted-write",
    ]),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectWorkPublicationOutcome = typeof ProjectWorkPublicationOutcome.Type;
/** Host-qualified repair proof; never accepted as a public review-tool input. */
export const ProjectTeamReviewResolutionProof = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  prior: Schema.optionalKey(
    Schema.Struct({
      revision: JoinedRunCounter,
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ),
  target: ProjectTeamReviewFinding.fields.target,
  reviewTargetSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  jobId: GuidedId,
  manifestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  attemptId: GuidedId,
  resultHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: GuidedId,
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      byteCount: JoinedRunCounter.check(Schema.isLessThanOrEqualTo(1048576)),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
    Schema.makeFilter(
      (artifacts) => new Set(artifacts.map((a) => a.artifactId)).size === artifacts.length,
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamReviewResolutionProof = typeof ProjectTeamReviewResolutionProof.Type;

export const ProjectWorkTeamTransition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("review.resolve"),
    finding: ProjectTeamReviewFinding,
    proof: ProjectTeamReviewResolutionProof,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("verification.claim"),
    taskId: ProjectWorkTaskId,
    expectedTaskRevision: JoinedRunCounter,
    gateId: GuidedId,
    expectedGateRevision: JoinedRunCounter,
    jobId: GuidedId,
    manifestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    attemptId: GuidedId,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("publication.claim"),
    effectId: GuidedId,
    expectedEffectRevision: JoinedRunCounter,
    expectedClaimGeneration: JoinedRunCounter,
  }),
  Schema.Struct({
    kind: Schema.Literal("publication.reflect"),
    effectId: GuidedId,
    expectedEffectRevision: JoinedRunCounter,
    claimGeneration: JoinedRunCounter,
    receipt: ProjectWorkPublicationOutcome,
  }),
  Schema.Struct({
    kind: Schema.Literal("memory.reflect"),
    effectId: GuidedId,
    claimGeneration: JoinedRunCounter,
    outcomeKind: Schema.Literals(["index-complete", "delete-source-complete", "no-facts"]),
    sourceId: GuidedId,
    sourceRevision: JoinedRunCounter,
    sourceGeneration: JoinedRunCounter,
    observationIds: Schema.Array(GuidedId).check(
      Schema.isMaxLength(32),
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
    expectedEffectRevision: JoinedRunCounter,
    expectedExtractionRevision: Schema.optionalKey(JoinedRunCounter),
  }),
  Schema.Struct({
    kind: Schema.Literal("run.settle"),
    reviewCompletion: Schema.optionalKey(ProjectTeamReviewCompletionProof),
    bindingId: GuidedId,
    generation: JoinedRunCounter,
    expectedBindingRevision: JoinedRunCounter,
    taskId: ProjectWorkTaskId,
    expectedTaskRevision: JoinedRunCounter,
    attemptId: ProjectWorkAttemptId,
    expectedAttemptRevision: JoinedRunCounter,
    dispatchId: GuidedId,
    receiptId: GuidedId,
    writableReservationId: Schema.optionalKey(GuidedId),
    effectIds: Schema.Array(GuidedId).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("claim"),
    taskId: ProjectWorkTaskId,
    expectedTaskRevision: NonNegativeInt,
    authorizationGateId: GuidedId,
    expectedGateRevision: NonNegativeInt,
    claim: ProjectWorkTaskClaimCommand,
    binding: ProjectTeamRunBinding,
    dispatch: Schema.optionalKey(
      Schema.Struct({
        effect: ProjectTeamEffect,
        writableReservation: Schema.optionalKey(ProjectTeamReservation),
      }),
    ),
    repair: Schema.optionalKey(
      Schema.Struct({
        episodeId: GuidedId,
        expectedEpisodeRevision: NonNegativeInt,
        exceptionGateId: Schema.optionalKey(GuidedId),
        expectedExceptionGateRevision: Schema.optionalKey(NonNegativeInt),
      }).check(
        Schema.makeFilter(
          (input) =>
            (input.exceptionGateId === undefined) ===
            (input.expectedExceptionGateRevision === undefined),
          { message: "An exception gate requires its expected revision" },
        ),
      ),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    bindingId: GuidedId,
    generation: NonNegativeInt,
    expectedBindingRevision: NonNegativeInt,
    failureFingerprint: GuidedText,
    relevantRevision: GuidedText,
    failureKind: Schema.Literals(["semantic", "transport", "timeout"]),
    summary: GuidedBody,
  }),
  Schema.Struct({
    kind: Schema.Literal("repair.consume"),
    episodeId: GuidedId,
    expectedEpisodeRevision: NonNegativeInt,
    bindingId: GuidedId,
    generation: NonNegativeInt,
    relevantRevision: GuidedText,
    exceptionGateId: Schema.optionalKey(GuidedId),
    expectedExceptionGateRevision: Schema.optionalKey(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.exceptionGateId === undefined) ===
        (input.expectedExceptionGateRevision === undefined),
      { message: "An exception gate requires its expected revision" },
    ),
  ),
]);
export type ProjectWorkTeamTransition = typeof ProjectWorkTeamTransition.Type;

export const ProjectWorkFoundationCommitCommand = Schema.Struct({
  ...ProjectWorkCommandFields,
  type: Schema.Literal("project-work.foundation.commit"),
  expectedRevision: NonNegativeInt,
  attribution: ProjectWorkAttribution,
  records: Schema.Array(ProjectTeamRecord).check(Schema.isMaxLength(64)),
  claim: Schema.optionalKey(ProjectWorkTaskClaimCommand),
  guided: Schema.optionalKey(ProjectWorkGuidedTransition),
  transition: Schema.optionalKey(ProjectWorkTeamTransition),
  committedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (command) => {
      if (command.guided !== undefined || command.transition !== undefined)
        return (
          command.records.length === 0 &&
          command.claim === undefined &&
          (command.guided === undefined || command.transition === undefined)
        );
      return command.records.length > 0;
    },
    { message: "A foundation transaction requires one unmixed transition or nonempty records" },
  ),
);

export const ProjectWorkCommand = Schema.Union([
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskCreateCommand,
  ProjectWorkIssueRefineCommand,
  ProjectWorkTaskSpecifyCommand,
  ProjectWorkTaskReviseProtectedSpecificationCommand,
  ProjectWorkTaskReadyCommand,
  ProjectWorkTaskClaimCommand,
  ProjectWorkTaskCompleteCommand,
  ProjectWorkTaskFailCommand,
  ProjectWorkTaskResolveFailureCommand,
  ProjectWorkAttemptRenewCommand,
  ProjectWorkAttemptCheckpointCommand,
  ProjectWorkAttemptExpireCommand,
  ProjectWorkAttemptReclaimCommand,
  ProjectWorkAttemptTakeoverCommand,
  ProjectWorkTaskBlockCommand,
  ProjectWorkTaskResolveBlockerCommand,
  ProjectWorkTaskReopenCommand,
  ProjectWorkTaskCancelCommand,
  ProjectWorkTaskDuplicateCommand,
  ProjectWorkTaskApproveCommand,
  ProjectWorkTaskAssignCommand,
  ProjectWorkTaskWatchCommand,
  ProjectWorkTaskUnwatchCommand,
  ProjectWorkTaskProtectSpecificationCommand,
  ProjectWorkCriterionUpsertCommand,
  ProjectWorkCriterionWaiveCommand,
  ProjectWorkEvidenceAddCommand,
  ProjectWorkRelationshipLinkCommand,
  ProjectWorkRelationshipUnlinkCommand,
  ProjectWorkKnowledgePromoteCommand,
  ProjectWorkDecisionProposeCommand,
  ProjectWorkDecisionAcceptCommand,
  ProjectWorkDecisionRejectCommand,
  ProjectWorkDecisionSupersedeCommand,
  ProjectWorkCommentAddCommand,
  ProjectWorkAttentionSeenCommand,
]);
export type ProjectWorkCommand = typeof ProjectWorkCommand.Type;

/** Names used by RPC and MCP adapters when referring to the command union. */
export const ProjectWorkWriteIntent = Schema.Union([
  ProjectWorkCommand,
  ProjectTeamWriteIntent,
  ProjectTeamGuidedIntent,
]);
export type ProjectWorkWriteIntent = typeof ProjectWorkWriteIntent.Type;

/** A retained preview describes prepared inputs; it grants no execution authority. */
export const ProjectWorkVerificationJobRead = Schema.Struct({
  kind: Schema.Literal("verification-job"),
  manifest: ProjectVerificationJobManifest,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type ProjectWorkVerificationJobRead = typeof ProjectWorkVerificationJobRead.Type;

export const ProjectWorkReadRecord = Schema.Union([
  ProjectWorkVerificationJobRead,
  ProjectWorkTaskRead,
  ProjectWorkAttemptRead,
  ProjectWorkCriterionRead,
  ProjectWorkEvidenceRead,
  ProjectWorkRelationshipRead,
  ProjectWorkBlockerRead,
  ProjectWorkKnowledgeRead,
  ProjectWorkDecisionRead,
  ProjectWorkCommentRead,
  ProjectWorkAttentionRead,
]);
export type ProjectWorkReadRecord = typeof ProjectWorkReadRecord.Type;

/** Stable read surface used by both the WebSocket RPC and MCP adapters. */
export const ProjectWorkReadOperation = Schema.Literals([
  "supervision",
  "foundation-records",
  "issue-comments",
  "snapshot",
  "task",
  "task-context",
  "verification-job",
  "integration-sources",
  "tasks",
  "attempts",
  "criteria",
  "evidence",
  "relationships",
  "blockers",
  "attention",
  "activities",
  "checkpoints",
  "knowledge",
  "decisions",
  "comments",
  "search",
  "briefing",
  "narrative",
  "export-json",
  "export-markdown",
]);
export type ProjectWorkReadOperation = typeof ProjectWorkReadOperation.Type;

export const ProjectWorkReadIntent = Schema.Struct({
  projectId: ProjectId,
  operation: ProjectWorkReadOperation,
  verificationJobId: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  issueRecordId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  expectedIssueRevision: Schema.optionalKey(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  issueCommentPage: Schema.optionalKey(
    NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
  exportVersion: Schema.optionalKey(Schema.Literals([1, 2])),
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  attemptId: Schema.optionalKey(ProjectWorkAttemptId),
  criterionId: Schema.optionalKey(ProjectWorkCriterionId),
  state: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["compact", "standard", "detailed"])),
  limit: Schema.optionalKey(NonNegativeInt),
  offset: Schema.optionalKey(NonNegativeInt),
  includeActivity: Schema.optionalKey(Schema.Boolean),
  /** JSON backup exports include the immutable project event history. */
  includeHistory: Schema.optionalKey(Schema.Boolean),
  recordKinds: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(32)),
  ),
  /** Return revision-bearing pagination metadata for collection reads. */
  envelope: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (input) =>
      input.operation !== "verification-job" ||
      (input.verificationJobId !== undefined &&
        input.taskId !== undefined &&
        input.taskId.length <= 256 &&
        input.query === undefined &&
        input.state === undefined),
    { message: "Verification previews require an exact task and job ID without search selectors" },
  ),
  Schema.makeFilter(
    (input) =>
      input.operation !== "integration-sources" ||
      (input.taskId !== undefined &&
        input.query === undefined &&
        input.state === undefined &&
        input.cursor === undefined &&
        (input.limit === undefined || input.limit <= 64)),
    { message: "Integration source candidates require an exact task and bounded page" },
  ),
);
export type ProjectWorkReadIntent = typeof ProjectWorkReadIntent.Type;

export const ProjectWorkApprovalRequest = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  specRevision: NonNegativeInt,
  payloadFingerprint: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
});
export type ProjectWorkApprovalRequest = typeof ProjectWorkApprovalRequest.Type;

export const ProjectWorkApprovalGrant = Schema.Struct({
  approval: ProjectWorkProtectedSpecificationApproval,
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ProjectWorkApprovalGrant = typeof ProjectWorkApprovalGrant.Type;

export const ProjectWorkEventType = Schema.Literals([
  "project-work.foundation.recorded",
  "project-work.task.created",
  "project-work.task.specified",
  "project-work.task.specification-revised",
  "project-work.task.ready",
  "project-work.task.claimed",
  "project-work.task.completed",
  "project-work.task.failed",
  "project-work.task.failure-resolved",
  "project-work.task.blocked",
  "project-work.task.blocker-resolved",
  "project-work.task.reopened",
  "project-work.task.canceled",
  "project-work.task.duplicated",
  "project-work.task.approved",
  "project-work.task.assigned",
  "project-work.task.watched",
  "project-work.task.unwatched",
  "project-work.task.specification-protected",
  "project-work.result.invalidated",
  "project-work.criterion.upserted",
  "project-work.criterion.waived",
  "project-work.evidence.added",
  "project-work.relationship.linked",
  "project-work.relationship.unlinked",
  "project-work.attempt.renewed",
  "project-work.attempt.checkpointed",
  "project-work.attempt.expired",
  "project-work.attempt.stopped",
  "project-work.attempt.reclaimed",
  "project-work.attempt.taken-over",
  "project-work.activity.recorded",
  "project-work.knowledge.promoted",
  "project-work.decision.proposed",
  "project-work.decision.accepted",
  "project-work.decision.rejected",
  "project-work.decision.superseded",
  "project-work.comment.added",
  "project-work.attention.seen",
]);
export type ProjectWorkEventType = typeof ProjectWorkEventType.Type;

/** Stable JSON encoding used when an approval is bound to a write payload. */
export const canonicalProjectWorkPayload = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

/**
 * A deterministic, non-cryptographic digest for full-payload comparisons.
 * Authorization and one-shot approval verification are intentionally owned by
 * the server auth layer; this helper only prevents partial-payload binding.
 */
export const projectWorkPayloadFingerprint = (value: unknown): string => {
  let hash = 2_166_136_261;
  for (const character of canonicalProjectWorkPayload(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
