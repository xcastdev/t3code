import { ProjectVerificationCommandSelection } from "./projectVerification.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkAttribution,
  ProjectWorkAttributionRead,
  ProjectWorkCriterionId,
} from "./projectWorkCore.ts";
import {
  ProjectIssueIntake,
  ProjectIssueIntakeRead,
  ProjectIssueRepositoryCursor,
  ProjectIssueRepositoryCursorRead,
} from "./projectIssueIntake.ts";
import {
  ProjectMemorySource,
  ProjectMemorySourceRead,
  ProjectMemoryExtraction,
  ProjectMemoryExtractionRead,
  ProjectMemoryObservation,
  ProjectMemoryObservationRead,
} from "./projectMemory.ts";
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const Body = Schema.String.check(Schema.isMaxLength(32_000));
const Priority = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const Ids = Schema.Array(Text.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(64));
const Fields = {
  recordId: Text.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  updatedAt: IsoDateTime,
};
export const ProjectTeamExecutionKind = Schema.Literals(["legacy", "managed", "human"]);
export const ProjectTeamDeliverableKind = Schema.Literals([
  "code",
  "research",
  "plan",
  "review",
  "reminder",
  "non-code",
]);
export const ProjectTeamMission = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("mission"),
  status: Schema.Literals(["draft", "active", "paused", "completed", "canceled"]),
  title: Text,
  objective: Body,
  requiredTaskIds: Schema.Array(ProjectWorkTaskId).check(Schema.isMaxLength(256)),
});
export const ProjectTeamTaskMembership = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("task-membership"),
  status: Schema.Literals(["active", "removed"]),
  taskId: ProjectWorkTaskId,
  missionId: Schema.optionalKey(Text),
  executionKind: ProjectTeamExecutionKind,
  deliverableKind: ProjectTeamDeliverableKind,
  parentTaskId: Schema.optionalKey(ProjectWorkTaskId),
  assignment: Schema.optionalKey(
    Schema.Struct({
      authorizationGateId: Text.check(Schema.isMaxLength(256)),
      outputDescriptions: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
      parentRunId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
      repairEpisodeId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
    }),
  ),
  controlState: Schema.optionalKey(
    Schema.Literals(["active", "deferred", "paused", "canceling", "canceled"]),
  ),
  requestedSuccessorMemberId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
});
export const ProjectTeamRoleRevision = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("role-revision"),
  status: Schema.Literals(["available", "retired"]),
  roleId: Text,
  roleRevision: NonNegativeInt,
  role: Schema.Literals([
    "coordinator",
    "investigator",
    "planner",
    "implementer",
    "reviewer",
    "integrator",
  ]),
  instructions: Body,
  skills: Ids,
  tools: Ids,
  model: Text,
  memoryAccess: Schema.Literals(["none", "project", "shared"]),
  delegationDepth: NonNegativeInt.check(Schema.isLessThanOrEqualTo(8)),
});
export const ProjectTeamMember = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("member"),
  status: Schema.Literals(["active", "paused", "retired"]),
  name: Text,
  coordinator: Schema.Boolean,
  roleRevisionId: Text,
});
const IntegrationId = Text.check(Schema.isMaxLength(256));
const IntegrationDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const IntegrationOid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const IntegrationRevision = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
/** Human-selected identities. Only the host can qualify and freeze the referenced code. */
export const ProjectTeamIntegrationSourceRef = Schema.Struct({
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  bindingId: IntegrationId,
  expectedBindingRevision: IntegrationRevision,
  generation: IntegrationRevision,
  reviewDispatchId: IntegrationId,
  expectedReviewProposalSha256: IntegrationDigest,
  verificationJobId: IntegrationId,
  expectedManifestHash: IntegrationDigest,
  expectedBranchRef: IntegrationId,
  expectedBaseSha: IntegrationOid,
  expectedHeadSha: IntegrationOid,
  expectedTestedTree: IntegrationOid,
});
export type ProjectTeamIntegrationSourceRef = typeof ProjectTeamIntegrationSourceRef.Type;
export const ProjectTeamIntegrationSourceRefs = Schema.Array(ProjectTeamIntegrationSourceRef).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.makeFilter(
    (sources) => new Set(sources.map((source) => source.taskId)).size === sources.length,
  ),
);
/** Captured by the host and retained in the plan approved by the human. */
export const ProjectTeamIntegrationSource = Schema.Struct({
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  bindingId: IntegrationId,
  bindingRevision: IntegrationRevision,
  generation: IntegrationRevision,
  dispatchId: IntegrationId,
  workspaceReceiptSha256: IntegrationDigest,
  specRevision: IntegrationRevision,
  planRevision: IntegrationRevision,
  scopeHash: IntegrationDigest,
  branchRef: IntegrationId,
  baseSha: IntegrationOid,
  headSha: IntegrationOid,
  testedTree: IntegrationOid,
  reviewDispatchId: IntegrationId,
  reviewProposalSha256: IntegrationDigest,
  joinedReceiptId: IntegrationId,
  jobId: IntegrationId,
  manifestHash: IntegrationDigest,
  attemptId: IntegrationId,
  resultHash: IntegrationDigest,
});
export type ProjectTeamIntegrationSource = typeof ProjectTeamIntegrationSource.Type;
export const ProjectTeamIntegrationSources = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(256)),
  sources: Schema.Array(ProjectTeamIntegrationSource).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (sources) => new Set(sources.map((source) => source.taskId)).size === sources.length,
    ),
  ),
}).check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131_072,
  ),
);
export type ProjectTeamIntegrationSources = typeof ProjectTeamIntegrationSources.Type;

/** Bounded host-qualified candidates for selecting a plan's inputs; this read grants no approval. */
export const ProjectTeamIntegrationSourcePage = Schema.Struct({
  environmentId: EnvironmentId.check(Schema.isMaxLength(256)),
  projectId: ProjectId.check(Schema.isMaxLength(256)),
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  revision: IntegrationRevision,
  taskRevision: IntegrationRevision,
  candidates: Schema.Array(
    Schema.Struct({
      ref: ProjectTeamIntegrationSourceRef,
      source: ProjectTeamIntegrationSource,
      taskTitle: Text,
    }),
  ).check(Schema.isMaxLength(64)),
  nextOffset: IntegrationRevision,
  hasMore: Schema.Boolean,
});
export type ProjectTeamIntegrationSourcePage = typeof ProjectTeamIntegrationSourcePage.Type;

export const ProjectTeamPlanRevision = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("plan-revision"),
  status: Schema.Literals(["proposed", "retired"]),
  taskId: ProjectWorkTaskId,
  specRevision: NonNegativeInt,
  planRevision: NonNegativeInt,
  content: Body,
  contentHash: Text,
  dependencyTaskIds: Schema.Array(ProjectWorkTaskId).check(Schema.isMaxLength(64)),
  integrationSources: Schema.optionalKey(ProjectTeamIntegrationSources),
});
const VerificationId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const validVerificationGate = (gate: {
  readonly gate: string;
  readonly verificationJobId?: string;
  readonly contentHash: string;
}) =>
  gate.gate !== "verification" ||
  (gate.verificationJobId !== undefined && /^[a-f0-9]{64}$/u.test(gate.contentHash));
export const ProjectTeamGate = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("gate"),
  status: Schema.Literals([
    "proposed",
    "pending",
    "approved",
    "rejected",
    "invalidated",
    "consumed",
  ]),
  taskId: ProjectWorkTaskId,
  gate: Schema.Literals([
    "investigation",
    "assignment",
    "specification",
    "plan",
    "execution",
    "merge",
    "repair",
    "verification",
  ]),
  specRevision: NonNegativeInt,
  planRevision: NonNegativeInt,
  contentHash: Text,
  verificationJobId: Schema.optionalKey(VerificationId),
  attribution: ProjectWorkAttribution,
  repository: Schema.optionalKey(Text),
  pullRequestNumber: Schema.optionalKey(NonNegativeInt),
  headSha: Schema.optionalKey(Text),
  targetBranch: Schema.optionalKey(Text),
  mergeMethod: Schema.optionalKey(Schema.Literals(["merge", "squash", "rebase"])),
  evidenceIds: Ids,
  consumedByRunId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
  consumedByCommandId: Schema.optionalKey(CommandId),
  assignmentAuthorization: Schema.optionalKey(
    Schema.Struct({
      assignmentKind: Schema.Literals(["planning", "review"]),
      parentTaskId: ProjectWorkTaskId,
      parentSpecRevision: NonNegativeInt,
      parentSpecificationGateId: Text.check(Schema.isMaxLength(256)),
      parentSpecificationHash: Text,
      parentScopeHash: Text,
      parentPlan: Schema.optionalKey(
        Schema.Struct({
          recordId: Text.check(Schema.isMaxLength(256)),
          planRevision: NonNegativeInt,
          contentHash: Text,
          gateId: Text.check(Schema.isMaxLength(256)),
        }),
      ),
    }),
  ),
  repairAuthorization: Schema.optionalKey(
    Schema.Struct({
      episodeId: Text.check(Schema.isMaxLength(256)),
      failureFingerprint: Text,
      relevantRevision: Text,
      semanticRepairNumber: NonNegativeInt,
      inheritedGateId: Text.check(Schema.isMaxLength(256)),
      exceptionGateId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
    }),
  ),
}).check(
  Schema.makeFilter(
    (gate) =>
      validVerificationGate(gate) &&
      (gate.gate === "verification" || gate.verificationJobId === undefined),
    { message: "Only verification gates require an exact job pointer and SHA-256 hash" },
  ),
);
export const ProjectTeamRunBinding = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("run-binding"),
  status: Schema.Literals(["reserved", "running", "stopping", "settled", "revoked", "quarantined"]),
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  memberId: Text,
  roleRevisionId: Text,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionId: Schema.optionalKey(Text),
  parentRunId: Schema.optionalKey(Text),
  environmentId: EnvironmentId,
  model: Text,
  configuration: Schema.Struct({
    instructionsHash: Text,
    toolIds: Ids,
    skillIds: Ids,
    runtimeVersion: Text,
    maxTokens: NonNegativeInt.check(Schema.isGreaterThan(0)),
    maxDurationMs: NonNegativeInt.check(Schema.isGreaterThan(0)),
    paidFallback: Schema.Literal(false),
  }),
  worktree: Text,
  branch: Text,
  leaseGeneration: NonNegativeInt,
  specRevision: NonNegativeInt,
  planRevision: NonNegativeInt,
  authorizationGateId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
  specificationGateId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
  planGateId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
  scopeHash: Schema.optionalKey(Text),
  repairEpisodeId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
});
export const ProjectTeamMessage = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("message"),
  status: Schema.Literals([
    "queued",
    "delivered",
    "acknowledged",
    "resolved",
    "uncertain",
    "canceled",
  ]),
  commandId: Text,
  senderId: Text,
  recipientId: Text,
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  missionId: Schema.optionalKey(Text),
  replyTo: Schema.optionalKey(Text),
  body: Body,
  evidenceIds: Ids,
  deliveryGeneration: NonNegativeInt,
  deliveryCursor: NonNegativeInt,
  acknowledgedAt: Schema.optionalKey(IsoDateTime),
  resolvedAt: Schema.optionalKey(IsoDateTime),
});
export const ProjectTeamQuestion = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("question"),
  status: Schema.Literals(["pending", "answered", "canceled"]),
  taskId: ProjectWorkTaskId,
  senderId: Text,
  targetGateId: Text,
  targetRevision: NonNegativeInt,
  body: Body,
  choices: Ids,
  seenAt: Schema.optionalKey(IsoDateTime),
  answer: Schema.optionalKey(Text),
  answeredBy: Schema.optionalKey(ProjectWorkAttribution),
});
export const ProjectTeamEvidenceApplicability = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("evidence-applicability"),
  status: Schema.Literals(["current", "stale", "rejected"]),
  taskId: ProjectWorkTaskId,
  evidenceId: Text,
  specRevision: NonNegativeInt,
  planRevision: NonNegativeInt,
  repository: Text,
  worktree: Text,
  testedTree: Text,
  testedCommit: Schema.optionalKey(Text),
  baseSha: Text,
  headSha: Text,
  command: Body,
  exitCode: Schema.Int,
  artifactId: Text,
  environmentSummary: Text,
  integration: Schema.Boolean,
  scopeHash: Schema.optionalKey(Text),
});
export const ProjectTeamRepairEpisode = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("repair-episode"),
  status: Schema.Literals(["active", "exhausted", "resolved"]),
  taskId: ProjectWorkTaskId,
  failureFingerprint: Text,
  relevantRevision: Text,
  allowance: NonNegativeInt,
  semanticRepairs: NonNegativeInt,
  transportRetries: NonNegativeInt,
  timeoutCount: NonNegativeInt,
  attemptIds: Schema.Array(ProjectWorkAttemptId).check(Schema.isMaxLength(64)),
  rootTaskId: Schema.optionalKey(ProjectWorkTaskId),
  lastSemanticRevision: Schema.optionalKey(Text),
  pendingSemanticRepair: Schema.optionalKey(Schema.Boolean),
  exceptionGrantId: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
});
export const ProjectTeamLimits = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("limits"),
  status: Schema.Literals(["configured", "disabled"]),
  environmentModelCalls: NonNegativeInt.check(Schema.isLessThanOrEqualTo(128)),
  projectWritableWorkers: NonNegativeInt.check(Schema.isLessThanOrEqualTo(64)),
  modelCalls: NonNegativeInt.check(Schema.isLessThanOrEqualTo(128)),
  delegationDepth: NonNegativeInt.check(Schema.isLessThanOrEqualTo(8)),
  repairAllowance: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16)),
  model: Text,
  tokenLimit: NonNegativeInt,
  durationLimitMs: NonNegativeInt,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  projectPriority: Schema.optionalKey(Priority),
  taskPriorities: Schema.optionalKey(
    Schema.Array(Schema.Struct({ taskId: ProjectWorkTaskId, priority: Priority })).check(
      Schema.isMaxLength(128),
    ),
  ),
  profileRecordIds: Schema.optionalKey(Ids),
});
export const ProjectTeamReservation = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("reservation"),
  status: Schema.Literals(["held", "released"]),
  environmentId: EnvironmentId,
  scope: Schema.Literals(["environment", "project", "model"]),
  resourceKey: Text,
  slot: NonNegativeInt,
  runId: Text,
  taskId: ProjectWorkTaskId,
  attemptId: ProjectWorkAttemptId,
  maximumTokens: NonNegativeInt,
  consumedTokens: NonNegativeInt,
});
export const ProjectTeamEffect = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("effect"),
  status: Schema.Literals(["pending", "claimed", "succeeded", "failed", "uncertain", "canceled"]),
  effectId: Text,
  effectKind: Schema.Literals([
    "dispatch",
    "setup",
    "publication",
    "mailbox-wake",
    "memory-index",
    "memory-delete",
    "stop",
  ]),
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  runId: Schema.optionalKey(Text),
  sourceId: Schema.optionalKey(Text),
  sourceGeneration: Schema.optionalKey(NonNegativeInt),
  targetId: Text,
  payload: Schema.Struct({
    recordIds: Ids,
    expectedRevision: NonNegativeInt,
    summary: Schema.optionalKey(Body),
  }),
  claimGeneration: NonNegativeInt,
  outcome: Schema.optionalKey(Text),
  availableAt: IsoDateTime,
});
const FindingId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const FindingIds = Schema.Array(FindingId).check(
  Schema.isMaxLength(64),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
const FindingFields = {
  findingId: FindingId,
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  criterionIds: Schema.Array(ProjectWorkCriterionId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((values) => new Set(values).size === values.length),
  ),
  detail: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32_000),
    Schema.isPattern(/\S/u),
  ),
  status: Schema.Literals(["open", "resolved"]),
  resolutionArtifactIds: FindingIds,
};
export const ProjectTeamReviewFindingProvenance = Schema.Struct({
  reviewTaskId: ProjectWorkTaskId,
  bindingId: FindingId,
  generation: NonNegativeInt,
  memberId: FindingId,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionId: FindingId,
  initializeOperationId: FindingId,
  dispatchId: FindingId,
  targetSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type ProjectTeamReviewFindingProvenance = typeof ProjectTeamReviewFindingProvenance.Type;
export const ProjectTeamReviewFinding = Schema.Struct({
  ...Fields,
  ...FindingFields,
  kind: Schema.Literal("review-finding"),
  taskId: ProjectWorkTaskId,
  target: Schema.Struct({
    projectId: ProjectId,
    taskId: ProjectWorkTaskId,
    specRevision: NonNegativeInt,
    planRevision: NonNegativeInt,
    baseSha: Text,
    headSha: Text,
  }),
  originReviewer: ProjectTeamReviewFindingProvenance,
  reportedBy: ProjectTeamReviewFindingProvenance,
}).check(
  Schema.makeFilter(
    (value) =>
      value.target.projectId === value.projectId &&
      value.target.taskId === value.taskId &&
      (value.status === "open"
        ? value.resolutionArtifactIds.length === 0
        : value.resolutionArtifactIds.length > 0),
  ),
);
export type ProjectTeamReviewFinding = typeof ProjectTeamReviewFinding.Type;

export const ProjectTeamRecord = Schema.Union([
  ProjectTeamReviewFinding,
  ProjectTeamMission,
  ProjectTeamTaskMembership,
  ProjectTeamRoleRevision,
  ProjectTeamMember,
  ProjectTeamPlanRevision,
  ProjectTeamGate,
  ProjectTeamRunBinding,
  ProjectTeamMessage,
  ProjectTeamQuestion,
  ProjectTeamEvidenceApplicability,
  ProjectTeamRepairEpisode,
  ProjectTeamLimits,
  ProjectTeamReservation,
  ProjectTeamEffect,
  ProjectIssueIntake,
  ProjectIssueRepositoryCursor,
  ProjectMemorySource,
  ProjectMemoryExtraction,
  ProjectMemoryObservation,
]);
export type ProjectTeamRecord = typeof ProjectTeamRecord.Type;
// Read variants deliberately retain unknown future states and role/kind slugs.
export const ProjectTeamRecordRead = Schema.Union([
  Schema.Struct({ ...ProjectTeamReviewFinding.fields, status: Text, severity: Text }),
  Schema.Struct({ ...ProjectTeamMission.fields, status: Text }),
  Schema.Struct({
    ...ProjectTeamTaskMembership.fields,
    status: Text,
    executionKind: Text,
    deliverableKind: Text,
  }),
  Schema.Struct({
    ...ProjectTeamRoleRevision.fields,
    status: Text,
    role: Text,
    memoryAccess: Text,
  }),
  Schema.Struct({ ...ProjectTeamMember.fields, status: Text }),
  Schema.Struct({ ...ProjectTeamPlanRevision.fields, status: Text }),
  Schema.Struct({
    ...ProjectTeamGate.fields,
    status: Text,
    gate: Text,
    attribution: ProjectWorkAttributionRead,
  }).check(Schema.makeFilter(validVerificationGate)),
  Schema.Struct({ ...ProjectTeamRunBinding.fields, status: Text }),
  Schema.Struct({ ...ProjectTeamMessage.fields, status: Text }),
  Schema.Struct({
    ...ProjectTeamQuestion.fields,
    status: Text,
    answeredBy: Schema.optionalKey(ProjectWorkAttributionRead),
  }),
  Schema.Struct({ ...ProjectTeamEvidenceApplicability.fields, status: Text }),
  Schema.Struct({ ...ProjectTeamRepairEpisode.fields, status: Text }),
  Schema.Struct({ ...ProjectTeamLimits.fields, status: Text }),
  Schema.Struct({ ...ProjectTeamReservation.fields, status: Text, scope: Text }),
  Schema.Struct({ ...ProjectTeamEffect.fields, status: Text, effectKind: Text }),
  ProjectIssueIntakeRead,
  ProjectIssueRepositoryCursorRead,
  ProjectMemorySourceRead,
  ProjectMemoryExtractionRead,
  ProjectMemoryObservationRead,
  Schema.Struct({ ...Fields, kind: Text, status: Text, payload: Schema.optionalKey(Body) }),
]);
export type ProjectTeamRecordRead = typeof ProjectTeamRecordRead.Type;
export const ProjectTeamRecordPage = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  nextCursor: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  ),
  items: Schema.Array(ProjectTeamRecordRead).check(Schema.isMaxLength(128)),
});
export const PROJECT_TEAM_DEFAULT_LIMITS = {
  environmentModelCalls: 2,
  projectWritableWorkers: 1,
  delegationDepth: 2,
  repairAllowance: 2,
} as const;

/** Server-issued credential metadata; never accepted from client command fields. */
export const ProjectTeamCredential = Schema.Struct({
  projectId: ProjectId,
  bindingId: Text.check(Schema.isMaxLength(256)),
  generation: NonNegativeInt,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
});
export type ProjectTeamCredential = typeof ProjectTeamCredential.Type;
const IntentFields = {
  commandId: CommandId,
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  expectedRevision: NonNegativeInt,
  expectedTaskRevision: NonNegativeInt,
  specRevision: NonNegativeInt,
  planRevision: NonNegativeInt,
};
const ConfiguredPositive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Profile = Schema.Struct({
  role: ProjectTeamRoleRevision.fields.role,
  instructions: Body,
  skills: Ids,
  tools: Ids,
  model: Text,
  memoryAccess: ProjectTeamRoleRevision.fields.memoryAccess,
  delegationDepth: ProjectTeamRoleRevision.fields.delegationDepth,
});
/** Human configuration installs profiles and policy; it does not start an assignment. */
export const ProjectTeamConfigurationIntent = Schema.Struct({
  type: Schema.Literal("project-team.configure"),
  commandId: CommandId,
  projectId: ProjectId,
  expectedRevision: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  expectedConfigurationGeneration: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  enabled: Schema.Boolean,
  providerInstanceId: ProviderInstanceId,
  projectPriority: Priority,
  taskPriorities: Schema.Array(
    Schema.Struct({ taskId: ProjectWorkTaskId, priority: Priority }),
  ).check(Schema.isMaxLength(128)),
  profiles: Schema.Array(Profile).check(
    Schema.isMinLength(6),
    Schema.isMaxLength(6),
    Schema.makeFilter((profiles) => new Set(profiles.map((profile) => profile.role)).size === 6, {
      message: "Configure exactly one profile for each initial team role",
    }),
  ),
  modelPolicies: Schema.Array(
    Schema.Struct({
      model: Text,
      tokenLimit: ConfiguredPositive,
      durationLimitMs: ConfiguredPositive,
      modelCalls: ConfiguredPositive.check(Schema.isLessThanOrEqualTo(128)),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(6),
    Schema.makeFilter(
      (policies) => new Set(policies.map((policy) => policy.model)).size === policies.length,
      {
        message: "Model policies must be unique",
      },
    ),
  ),
  environmentModelCalls: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(128))),
  projectWritableWorkers: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(64))),
  delegationDepth: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(8))),
  repairAllowance: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(16))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamConfigurationIntent = typeof ProjectTeamConfigurationIntent.Type;

const VerificationRevision = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const ProjectTeamVerificationProposal = Schema.Struct({
  ...IntentFields,
  type: Schema.Literal("project-team.verification.propose"),
  projectId: ProjectId.check(Schema.isMaxLength(256)),
  taskId: ProjectWorkTaskId.check(Schema.isMaxLength(256)),
  expectedRevision: VerificationRevision,
  expectedTaskRevision: VerificationRevision,
  specRevision: VerificationRevision,
  planRevision: VerificationRevision,
  jobId: VerificationId,
  bindingId: VerificationId,
  expectedBindingRevision: VerificationRevision,
  generation: VerificationRevision,
  criterionIds: Schema.Array(ProjectWorkCriterionId.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  command: ProjectVerificationCommandSelection,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamVerificationProposal = typeof ProjectTeamVerificationProposal.Type;

export const ProjectTeamReviewFindingIntent = Schema.Struct({
  ...IntentFields,
  ...FindingFields,
  type: Schema.Literal("project-team.review.finding.record"),
  revision: NonNegativeInt,
})
  .check(
    Schema.makeFilter(
      (value) =>
        new TextEncoder().encode(value.detail).length +
          [...value.criterionIds, ...value.resolutionArtifactIds].reduce(
            (total, id) => total + new TextEncoder().encode(id).length,
            0,
          ) <=
        131_072,
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamReviewFindingIntent = typeof ProjectTeamReviewFindingIntent.Type;

export const ProjectTeamWriteIntent = Schema.Union([
  ProjectTeamReviewFindingIntent,
  ProjectTeamVerificationProposal,
  ProjectTeamConfigurationIntent,
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.gate.respond"),
    gateId: Text,
    expectedGateRevision: NonNegativeInt,
    response: Schema.Literals(["approved", "rejected"]),
  }),
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.message.send"),
    messageId: Text.check(Schema.isMaxLength(256)),
    recipientId: Text.check(Schema.isMaxLength(256)),
    recipientTaskId: ProjectWorkTaskId,
    expectedRecipientMembershipRevision: NonNegativeInt,
    body: Body,
    replyTo: Schema.optionalKey(Text.check(Schema.isMaxLength(256))),
    evidenceIds: Ids,
  }),
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.question.request"),
    questionId: Text,
    targetGateId: Text,
    expectedGateRevision: NonNegativeInt,
    body: Body,
    choices: Ids,
  }),
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.question.answer"),
    questionId: Text,
    expectedQuestionRevision: NonNegativeInt,
    expectedGateRevision: NonNegativeInt,
    answer: Text,
  }),
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.delegation.request"),
    requestId: Text,
    recipientId: Text,
    objective: Body,
  }),
  Schema.Struct({
    ...IntentFields,
    type: Schema.Literal("project-team.memory.promote"),
    observationId: Text,
    expectedObservationRevision: NonNegativeInt,
    expectedSourceRevision: NonNegativeInt,
    knowledgeId: Text,
    title: Text,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectTeamWriteIntent = typeof ProjectTeamWriteIntent.Type;
