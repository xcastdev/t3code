import { notifyCompactCallerChange } from "./ProjectTeamCompactCaller.ts";
import {
  canonicalProjectWorkPayload,
  ProjectTeamIntegrationSources,
  type ProjectTeamJoinedFailureProof,
  type ProjectTeamReviewCompletionProof,
  projectWorkPayloadFingerprint,
  CommandId,
  ProjectTeamRecord as ProjectTeamRecordSchema,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkWriteResult,
  type ProjectTeamRecord,
  type ProjectWorkCriterion,
  type ProjectWorkEvidence,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  assertProjectTeamRunAuthority,
  projectTeamDerivedRecordId,
  projectTeamPlanHash,
} from "./ProjectTeamPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { isProjectWorkTombstoned } from "./ProjectTeamsPersistence.ts";
import { resolveProjectTeamLimits } from "./ProjectTeamLimits.ts";
import { projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";
import {
  prepareReviewCriterionProgress,
  assertRetainedReviewCriterionProgress,
} from "./ProjectTeamReviewCriterionProgress.ts";
import { deliveryDependencyIds } from "./ProjectTeamDeliveryAcceptanceState.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeFoundationEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: Id,
      projectId: Id,
      revision: Positive,
      occurredAt: Id,
      type: Schema.Literal("project-work.foundation.recorded"),
      record: ProjectTeamRecordSchema,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeWriteResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectWorkWriteResult));
const decodeEventIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Id)));
const decodeEffectJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamRecordSchema),
  { onExcessProperty: "error" },
);
const RecoveryPosition = Schema.Struct({
  rowId: Schema.String.check(
    Schema.isPattern(/^(?:0|-?[1-9][0-9]{0,18})$/),
    Schema.isMaxLength(20),
  ),
  dispatchIdHash: Digest,
});
export type ProjectTeamDispatchRecoveryPosition = typeof RecoveryPosition.Type;

const Stage = Schema.Literals([
  "reserved",
  "workspace-ready",
  "setup-complete",
  "session-bound",
  "assignment-intent",
  "assignment-observed",
  "stopping",
  "settled",
  "quarantine",
]);
const GitAssignment = Schema.Struct({
  effectId: Id,
  runId: Id,
  generation: Safe,
  primaryRoot: Text,
  commonGitDirectory: Text,
  worktreePath: Text,
  branchRef: Text,
  baseRef: Text,
  baseOid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  ownershipToken: Id,
  policyHash: Digest,
});
const Identity = Schema.Struct({ path: Text, dev: Id, ino: Id });
export const ProjectTeamWorkspaceReceipt = Schema.Struct({
  assignment: GitAssignment,
  primary: Identity,
  worktree: Identity,
  common: Identity,
  gitDirectory: Identity,
  initialHeadOid: Schema.String,
  pointerAndConfigurationHash: Digest,
});
const Request = Schema.Struct({
  dispatchId: Id,
  claim: ProjectWorkFoundationCommitCommand,
  git: GitAssignment,
  setupId: Id,
  initializeOperationId: Id,
  assignmentOperationId: Id,
  assignment: Schema.String.check(
    Schema.isMinLength(1),
    Schema.makeFilter((value) => Buffer.byteLength(value) <= 131072, {
      message: "Assignment exceeds its byte budget",
    }),
  ),
});
const Limits = Schema.Struct({
  rootTaskId: ProjectWorkTaskId,
  maximumTokens: Positive,
  attemptMaximumTokens: Positive,
  rootDeadlineAtMs: Positive,
  deadlineAtMs: Positive,
  delegationDepth: Safe,
  maximumDelegationDepth: Safe,
  repairAllowance: Safe,
  environmentModelCalls: Positive,
  projectWritableWorkers: Safe,
  modelCalls: Positive,
  writable: Schema.Boolean,
  limitsRecordId: Id,
  limitsRevision: Safe,
});
const RootCaps = Schema.Struct({
  maximumDelegationDepth: Safe.check(Schema.isLessThanOrEqualTo(8)),
  repairAllowance: Safe.check(Schema.isLessThanOrEqualTo(16)),
  environmentModelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
  projectWritableWorkers: Safe.check(Schema.isLessThanOrEqualTo(64)),
  modelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
});
const selectionHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const Intent = Schema.Struct({
  request: Request,
  compiledClaim: ProjectWorkFoundationCommitCommand,
  limits: Limits,
  rootCaps: RootCaps,
  writableReservationId: Schema.optionalKey(Id),
  integration: Schema.optionalKey(
    Schema.Struct({
      version: Schema.Literal(1),
      planId: Id,
      planRevision: Safe,
      planContentHash: Id,
      selection: ProjectTeamIntegrationSources,
      selectionSha256: Digest,
    }),
  ),
});
export const ProjectTeamIntegrationCombinationReceipt = Schema.Struct({
  version: Schema.Literal(1),
  selectionSha256: Digest,
  baseSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  combinedHeadSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  combinedTree: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  sourceHeads: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});
export type ProjectTeamIntegrationCombinationReceipt =
  typeof ProjectTeamIntegrationCombinationReceipt.Type;
export const ProjectTeamWorkspaceEvidence = Schema.Struct({
  workspace: ProjectTeamWorkspaceReceipt,
  integration: Schema.optionalKey(ProjectTeamIntegrationCombinationReceipt),
});
export type ProjectTeamDispatchRequest = typeof Request.Type;
export type ProjectTeamDispatchStage = typeof Stage.Type;
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
const RowSchema = Schema.Struct({
  dispatch_id: Id,
  project_id: Id,
  environment_id: EnvironmentId,
  binding_id: Id,
  generation: Safe,
  task_id: Id,
  attempt_id: Id,
  worktree: Text,
  branch: Text,
  root_task_id: ProjectWorkTaskId,
  root_maximum_tokens: Positive,
  root_deadline_at_ms: Positive,
  attempt_maximum_tokens: Positive,
  attempt_deadline_at_ms: Positive,
  delegation_depth: Safe,
  maximum_delegation_depth: Safe,
  repair_allowance: Safe,
  revision: Safe,
  claim_generation: Safe,
  cleanup_claim_revision: Schema.NullOr(Safe),
  stage: Stage,
  intent_json: Schema.String.check(
    Schema.makeFilter((value) => Buffer.byteLength(value) <= 262144),
  ),
  created_at: Id,
  updated_at: Id,
});
type Row = typeof RowSchema.Type;
const strict = { onExcessProperty: "error" } as const;
const decodeRequest = Schema.decodeUnknownEffect(Request, strict);
const decodeEnvironment = Schema.decodeUnknownEffect(EnvironmentId);
const decodeCalls = Schema.decodeUnknownEffect(Positive.check(Schema.isLessThanOrEqualTo(128)));
const decodeId = Schema.decodeUnknownEffect(Id);
const decodeRecoveryPosition = Schema.decodeUnknownEffect(RecoveryPosition, strict);
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecordSchema, {
  onExcessProperty: "error",
});
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent), strict);
const decodeRow = Schema.decodeUnknownEffect(RowSchema, strict);
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRecordSchema));
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(Intent));
const encodeProjectionJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

export class ProjectTeamDispatchJournalError extends Schema.TaggedError<ProjectTeamDispatchJournalError>()(
  "ProjectTeamDispatchJournalError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamDispatchJournalError({ reason });
const time = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const deadline = (value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
    ? DateTime.toEpochMillis(parsed.value)
    : undefined;
};
const fence = (row: Row) =>
  Object.freeze({
    dispatchId: row.dispatch_id,
    revision: row.revision,
    claimGeneration: row.claim_generation,
    stage: row.stage,
  });
export type ProjectTeamDispatchFence = ReturnType<typeof fence>;
const ForwardStage = Schema.Literals([
  "workspace-ready",
  "setup-complete",
  "session-bound",
  "assignment-intent",
  "assignment-observed",
]);
const RecordedStage = Schema.Union([
  ForwardStage,
  Schema.Literals(["stopping", "quarantine", "settled"]),
]);
const isCleanupStage = (stage: ProjectTeamDispatchStage) =>
  stage === "stopping" || stage === "quarantine" || stage === "settled";
const StageReceipt = Schema.Struct({
  receiptId: Id,
  stage: RecordedStage,
  evidence: Schema.JsonObject,
});
const decodeStageReceipt = Schema.decodeUnknownEffect(StageReceipt, strict);
const encodeStageEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));
const decodeStageEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));
const StoredStageReceipt = Schema.Struct({
  receipt_id: Id,
  dispatch_id: Id,
  revision: Positive,
  claim_generation: Safe,
  stage: RecordedStage,
  evidence_json: Schema.String.check(
    Schema.makeFilter((value) => Buffer.byteLength(value) <= 262144),
  ),
  recorded_at: Id,
});
const decodeStoredStageReceipt = Schema.decodeUnknownEffect(StoredStageReceipt, strict);

export type ProjectTeamDispatchStageReceipt = typeof StageReceipt.Type;
export type ProjectTeamDispatchSnapshot = {
  readonly fence: ProjectTeamDispatchFence;
  readonly intent: typeof Intent.Type;
};
export type ProjectTeamDispatchStageVerifier = (
  input: ProjectTeamDispatchStageReceipt,
  snapshot: ProjectTeamDispatchSnapshot,
) => Effect.Effect<void, ProjectTeamDispatchJournalError>;
const nextForwardStage: Partial<Record<ProjectTeamDispatchStage, typeof ForwardStage.Type>> = {
  reserved: "workspace-ready",
  "workspace-ready": "setup-complete",
  "setup-complete": "session-bound",
  "session-bound": "assignment-intent",
  "assignment-intent": "assignment-observed",
};

/** Only Root constructs this journal. Every effect admission and receipt checks committed authority. */
export const makeProjectTeamDispatchJournal = Effect.fn("makeProjectTeamDispatchJournal")(
  function* <E = never, R = never>(options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    /** Private Root resource loan; checks execute in the repository-owned transaction. */
    readonly verifyAdmission?: (
      input:
        | { readonly stage: "before"; readonly request: ProjectTeamDispatchRequest }
        | { readonly stage: "after"; readonly request: ProjectTeamDispatchRequest },
    ) => Effect.Effect<void, ProjectTeamDispatchJournalError>;
    /** Trusted Root checks actual retained Git/setup/native receipts. No client or worker predicate. */
    readonly verifyStage?: ProjectTeamDispatchStageVerifier;
    /** Read-only resource loan checked after final SQL reads, inside the stage transaction. */
    readonly verifyStageFinal?: ProjectTeamDispatchStageVerifier;
    /** Private owner resources revalidated after claim writes, before atomic commit. */
    readonly verifyClaimFinal?: (
      snapshot: ProjectTeamDispatchSnapshot,
    ) => Effect.Effect<void, ProjectTeamDispatchJournalError>;
    /** Root checks original worker/setup/model owners joined, including retained transport accounting. */
    readonly verifySettlement?: ProjectTeamDispatchStageVerifier;
    /** Read original child proof before releasing its attempt in this same transaction. */
    readonly prepareReviewCompletion?: (
      snapshot: ProjectTeamDispatchSnapshot,
      receipt: ProjectTeamDispatchStageReceipt,
    ) => Effect.Effect<ProjectTeamReviewCompletionProof | undefined, E, R>;
    /** Qualifies only a joined failed Pi operation with retained quarantined model accounting. */
    readonly prepareFailure?: (
      snapshot: ProjectTeamDispatchSnapshot,
      receipt: ProjectTeamDispatchStageReceipt,
    ) => Effect.Effect<
      Pick<ProjectTeamJoinedFailureProof, "fingerprint" | "operationId"> | undefined,
      E,
      R
    >;
    /** Recheck the original assessment target after domain projection, before COMMIT. */
    readonly verifyReviewTarget?: (
      snapshot: ProjectTeamDispatchSnapshot,
      receipt: ProjectTeamDispatchStageReceipt,
    ) => Effect.Effect<void, E, R>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const prepareReviewCompletion = options.prepareReviewCompletion;
    const prepareFailure = options.prepareFailure;
    const verifyReviewTarget = options.verifyReviewTarget;
    const verifyAdmission = options.verifyAdmission;
    const verifyStageFinal = options.verifyStageFinal;
    const verifyClaimFinal = options.verifyClaimFinal;
    const environmentId = yield* decodeEnvironment(options.environmentId);
    const environmentCalls = yield* decodeCalls(options.maximumEnvironmentModelCalls);
    const verificationResults = yield* makeProjectWorkVerificationResultReader({ environmentId });
    const read = Effect.fn("ProjectTeamDispatchJournal.read")(function* (dispatchId: string) {
      const rows = yield* sql<Row>`SELECT * FROM project_team_dispatch
      WHERE dispatch_id=${dispatchId} AND environment_id=${environmentId}`;
      if (!rows[0] || rows.length !== 1) return yield* deny("Dispatch ownership is missing");
      const row = yield* decodeRow(rows[0]).pipe(
        Effect.mapError(() => deny("Dispatch row is invalid")),
      );
      const intent = yield* decodeIntent(row.intent_json).pipe(
        Effect.mapError(() => deny("Dispatch intent is invalid")),
      );
      const transition = intent.compiledClaim.transition;
      if (transition?.kind !== "claim") return yield* deny("Dispatch claim is invalid");
      const binding = transition.binding;
      const limits = intent.limits;
      const writer = transition.dispatch?.writableReservation;
      if (
        intent.request.dispatchId !== row.dispatch_id ||
        intent.compiledClaim.projectId !== row.project_id ||
        binding.projectId !== row.project_id ||
        binding.environmentId !== row.environment_id ||
        row.environment_id !== environmentId ||
        binding.recordId !== row.binding_id ||
        binding.generation !== row.generation ||
        binding.taskId !== row.task_id ||
        binding.attemptId !== row.attempt_id ||
        binding.worktree !== row.worktree ||
        binding.branch !== row.branch ||
        limits.rootTaskId !== row.root_task_id ||
        limits.maximumTokens !== row.root_maximum_tokens ||
        limits.rootDeadlineAtMs !== row.root_deadline_at_ms ||
        limits.attemptMaximumTokens !== row.attempt_maximum_tokens ||
        limits.deadlineAtMs !== row.attempt_deadline_at_ms ||
        limits.delegationDepth !== row.delegation_depth ||
        limits.maximumDelegationDepth !== row.maximum_delegation_depth ||
        limits.repairAllowance !== row.repair_allowance ||
        intent.request.claim.committedAt !== row.created_at ||
        deadline(row.created_at) === undefined ||
        deadline(row.updated_at) === undefined ||
        row.claim_generation > row.revision ||
        binding.configuration.maxTokens !== limits.attemptMaximumTokens ||
        limits.attemptMaximumTokens > limits.maximumTokens ||
        limits.deadlineAtMs > limits.rootDeadlineAtMs ||
        limits.delegationDepth > limits.maximumDelegationDepth ||
        limits.maximumDelegationDepth > intent.rootCaps.maximumDelegationDepth ||
        limits.repairAllowance > intent.rootCaps.repairAllowance ||
        limits.writable !== (writer !== undefined) ||
        intent.writableReservationId !== writer?.recordId ||
        intent.request.git.worktreePath !== row.worktree ||
        intent.request.git.branchRef !== row.branch ||
        intent.request.git.runId !== row.binding_id ||
        intent.request.git.generation !== row.generation
      )
        return yield* deny("Dispatch identity does not match its retained intent");
      if (
        intent.integration !== undefined &&
        (intent.integration.selection.environmentId !== environmentId ||
          intent.integration.selectionSha256 !== selectionHash(intent.integration.selection) ||
          intent.integration.selection.sources.some((source) => source.taskId === binding.taskId))
      )
        return yield* deny("Frozen integration selection identity changed");
      return { row, intent };
    });
    const readClaimBaseline = Effect.fn("ProjectTeamDispatchJournal.readClaimBaseline")(function* (
      row: Row,
      intent: typeof Intent.Type,
      forward = false,
      historicalState?: Effect.Success<ReturnType<typeof readCurrentState>>,
    ) {
      // Deletion purges foundation proof. Retained history then carries cleanup knowledge only.
      if (yield* isProjectWorkTombstoned(sql, row.project_id)) {
        if (forward) return yield* deny("Project is deleted");
        return row.claim_generation;
      }
      const transition = intent.compiledClaim.transition;
      const original = transition?.kind === "claim" ? transition.dispatch?.effect : undefined;
      if (
        !original ||
        original.kind !== "effect" ||
        original.status !== "pending" ||
        original.effectId !== row.dispatch_id ||
        original.runId !== row.binding_id ||
        original.targetId !== row.binding_id ||
        original.taskId !== row.task_id ||
        original.generation !== row.generation ||
        original.projectId !== row.project_id ||
        original.recordId !==
          projectTeamDerivedRecordId(intent.compiledClaim.commandId, "dispatch-effect") ||
        original.effectKind !== "dispatch" ||
        original.claimGeneration !== 0 ||
        original.revision !== 0 ||
        fingerprint(original.payload) !==
          fingerprint({
            recordIds: [row.binding_id],
            expectedRevision: intent.request.claim.expectedRevision,
          })
      )
        return yield* deny("Original dispatch effect identity is invalid");
      const state = historicalState ?? (yield* readCurrentState(sql, row.project_id));
      if (historicalState !== undefined && state.projectId !== row.project_id)
        return yield* deny("Historical dispatch project differs");
      const effects = (state.foundationRecords ?? []).filter(
        (record) =>
          record.kind === "effect" &&
          (record.recordId === original.recordId || record.effectId === row.dispatch_id),
      );
      if (effects.length !== 1)
        return yield* deny("Committed dispatch effect is missing or ambiguous");
      const effect = yield* decodeRecord(effects[0]).pipe(
        Effect.mapError(() => deny("Committed dispatch effect is invalid")),
      );
      if (
        effect.kind !== "effect" ||
        deadline(effect.updatedAt) === undefined ||
        fingerprint({
          ...effect,
          status: original.status,
          revision: original.revision,
          updatedAt: original.updatedAt,
          claimGeneration: original.claimGeneration,
          outcome: original.outcome,
        }) !== fingerprint(original)
      )
        return yield* deny("Committed dispatch effect identity changed");
      const projected = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM project_team_effect WHERE record_id=${original.recordId}`;
      const stored = projected[0];
      if (projected.length !== 1 || !stored)
        return yield* deny("Committed dispatch effect SQL is missing");
      const decoded = yield* decodeEffectJson(stored.payload_json).pipe(
        Effect.mapError(() => deny("Committed dispatch effect SQL is invalid")),
      );
      if (
        fingerprint(decoded) !== fingerprint(effect) ||
        fingerprint(stored) !==
          fingerprint({
            record_id: effect.recordId,
            project_id: effect.projectId,
            status: effect.status,
            revision: effect.revision,
            generation: effect.generation,
            updated_at: effect.updatedAt,
            task_id: effect.taskId ?? null,
            attempt_id: null,
            member_id: null,
            source_id: effect.sourceId ?? null,
            scope_key: null,
            slot: null,
            unique_key: effect.effectId,
            provider_instance_id: null,
            thread_id: null,
            session_id: null,
            payload_json: stored.payload_json,
          })
      )
        return yield* deny("Committed dispatch effect SQL disagrees with foundation authority");
      const commandId = projectTeamDerivedRecordId(
        intent.compiledClaim.commandId,
        "claim-dispatch",
      );
      const events = yield* sql<Record<string, unknown>>`SELECT * FROM project_work_events
        WHERE project_id=${row.project_id} AND command_id=${commandId} ORDER BY sequence LIMIT 2`;
      const commands = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM project_work_command_receipts
        WHERE project_id=${row.project_id} AND command_id=${commandId} LIMIT 2`;
      if (effect.claimGeneration === 0) {
        if (
          (effect.status !== "pending" && effect.status !== "canceled") ||
          (effect.status === "pending" && fingerprint(effect) !== fingerprint(original)) ||
          (effect.status === "canceled" && effect.revision <= original.revision) ||
          row.claim_generation !== 0 ||
          events.length ||
          commands.length ||
          forward
        )
          return yield* deny("Dispatch has no committed effect claim");
        return 0;
      }
      const eventRow = events[0];
      const command = commands[0];
      if (events.length !== 1 || commands.length !== 1 || !eventRow || !command)
        return yield* deny("Committed dispatch claim receipt is missing or ambiguous");
      const event = yield* decodeFoundationEvent(eventRow.payload_json).pipe(
        Effect.mapError(() => deny("Committed dispatch claim event is invalid")),
      );
      const result = yield* decodeWriteResult(command.result_json).pipe(
        Effect.mapError(() => deny("Committed dispatch claim result is invalid")),
      );
      const ids = yield* decodeEventIds(command.event_ids_json).pipe(
        Effect.mapError(() => deny("Committed dispatch claim event IDs are invalid")),
      );
      const baseline = original.claimGeneration + 1;
      const attribution = intent.compiledClaim.attribution;
      const claimFingerprint = projectWorkPayloadFingerprint({
        type: "project-work.foundation.commit",
        projectId: row.project_id,
        commandId,
        expectedRevision: event.revision - 1,
        // Repository fingerprints omit attribution timestamps, display names and source URIs.
        attribution: {
          actor: { kind: attribution.actor.kind, id: attribution.actor.id },
          source: { kind: attribution.source.kind, id: attribution.source.id },
        },
        records: [event.record],
        committedAt: event.occurredAt,
      });
      if (
        event.projectId !== row.project_id ||
        eventRow.event_id !== event.eventId ||
        eventRow.event_type !== event.type ||
        eventRow.occurred_at !== event.occurredAt ||
        deadline(event.occurredAt) === undefined ||
        fingerprint(event.record) !==
          fingerprint({
            ...original,
            status: "claimed",
            revision: original.revision + 1,
            claimGeneration: baseline,
            updatedAt: event.occurredAt,
          }) ||
        row.claim_generation !== baseline ||
        effect.claimGeneration !== baseline ||
        effect.status === "pending" ||
        effect.revision < original.revision + 1 ||
        (forward && effect.status !== "claimed") ||
        command.created_at !== event.occurredAt ||
        command.payload_fingerprint !== claimFingerprint ||
        command.actor_kind !== attribution.actor.kind ||
        command.actor_id !== (attribution.actor.id ?? null) ||
        command.source_kind !== attribution.source.kind ||
        command.source_id !== (attribution.source.id ?? null) ||
        fingerprint(ids) !== fingerprint([event.eventId]) ||
        result.projectId !== row.project_id ||
        result.revision !== event.revision ||
        result.receipt.commandId !== commandId ||
        result.receipt.status !== "accepted" ||
        result.receipt.projectId !== row.project_id ||
        result.receipt.revision !== event.revision ||
        result.receipt.eventCount !== 1 ||
        result.delta.projectId !== row.project_id ||
        result.delta.revision !== event.revision ||
        fingerprint(result.delta.eventIds) !== fingerprint(ids)
      )
        return yield* deny("Dispatch header has no exact committed effect claim");
      return baseline;
    });
    const assertExecutionTime = Effect.fn("ProjectTeamDispatchJournal.assertExecutionTime")(
      function* (intent: typeof Intent.Type, leaseDeadlineAtMs: number, now: number) {
        if (now >= intent.limits.deadlineAtMs)
          return yield* deny("Frozen attempt deadline expired");
        if (now >= leaseDeadlineAtMs) return yield* deny("Dispatch lease expired or changed");
      },
    );
    const current = Effect.fn("ProjectTeamDispatchJournal.current")(function* (
      row: Row,
      intent: typeof Intent.Type,
    ) {
      if (row.stage === "stopping" || row.stage === "quarantine" || row.stage === "settled")
        return yield* deny("Dispatch retains cleanup ownership only");
      if (yield* isProjectWorkTombstoned(sql, row.project_id))
        return yield* deny("Project is deleted");
      const now = yield* Clock.currentTimeMillis;
      if (now >= intent.limits.deadlineAtMs) return yield* deny("Frozen attempt deadline expired");
      const state = yield* readCurrentState(sql, row.project_id);
      const records = state.foundationRecords ?? [];
      if (intent.integration !== undefined) {
        const selection = intent.integration;
        const plans = records.filter(
          (record) => record.kind === "plan-revision" && record.recordId === selection.planId,
        );
        const plan = plans[0];
        const original = intent.compiledClaim.transition;
        const roles =
          original?.kind === "claim"
            ? records.filter(
                (record) =>
                  record.kind === "role-revision" &&
                  record.recordId === original.binding.roleRevisionId,
              )
            : [];
        if (
          plans.length !== 1 ||
          plan?.kind !== "plan-revision" ||
          plan.status !== "proposed" ||
          plan.planRevision !== selection.planRevision ||
          plan.contentHash !== selection.planContentHash ||
          plan.integrationSources === undefined ||
          selectionHash(plan.integrationSources) !== selection.selectionSha256 ||
          roles.length !== 1 ||
          roles[0]?.kind !== "role-revision" ||
          roles[0].role !== "integrator"
        )
          return yield* deny("Approved integration source plan changed");
      }
      const bindings = records.filter(
        (r): r is Binding => r.kind === "run-binding" && r.recordId === row.binding_id,
      );
      const binding = bindings[0];
      if (
        bindings.length !== 1 ||
        !binding ||
        binding.environmentId !== environmentId ||
        binding.generation !== row.generation ||
        binding.leaseGeneration !== row.generation
      )
        return yield* deny("Dispatch run is replaced or missing");
      const initial = intent.compiledClaim.transition;
      if (initial?.kind !== "claim") return yield* deny("Dispatch claim is missing");
      const frozen = initial.binding;
      const repair = initial.repair;
      const expectedFrozen =
        repair === undefined
          ? frozen
          : {
              ...frozen,
              authorizationGateId: projectTeamDerivedRecordId(
                intent.compiledClaim.commandId,
                `repair-grant:${repair.episodeId}:${frozen.generation}`,
              ),
            };
      const repairGrants =
        repair === undefined
          ? []
          : records.filter(
              (record) =>
                record.kind === "gate" && record.recordId === expectedFrozen.authorizationGateId,
            );
      const repairGrant = repairGrants[0];
      const repairEpisodes =
        repair === undefined
          ? []
          : records.filter(
              (record) => record.kind === "repair-episode" && record.recordId === repair.episodeId,
            );
      const repairEpisode = repairEpisodes[0];
      if (
        repair !== undefined &&
        ((frozen.authorizationGateId !== initial.authorizationGateId &&
          frozen.authorizationGateId !== expectedFrozen.authorizationGateId) ||
          binding.authorizationGateId !== expectedFrozen.authorizationGateId ||
          binding.repairEpisodeId !== repair.episodeId ||
          repairEpisodes.length !== 1 ||
          repairEpisode?.kind !== "repair-episode" ||
          repairEpisode.taskId !== binding.taskId ||
          !repairEpisode.attemptIds.includes(binding.attemptId) ||
          repairGrants.length !== 1 ||
          repairGrant?.kind !== "gate" ||
          repairGrant.gate !== "repair" ||
          repairGrant.status !== "consumed" ||
          repairGrant.consumedByRunId !== binding.recordId ||
          repairGrant.consumedByCommandId !== intent.compiledClaim.commandId ||
          repairGrant.repairAuthorization?.episodeId !== repair.episodeId ||
          repairGrant.repairAuthorization?.inheritedGateId !== initial.authorizationGateId ||
          repairGrant.repairAuthorization?.failureFingerprint !==
            repairEpisode.failureFingerprint ||
          repairGrant.repairAuthorization?.relevantRevision !== repairEpisode.relevantRevision ||
          repairGrant.repairAuthorization?.semanticRepairNumber !== repairEpisode.semanticRepairs)
      )
        return yield* deny(
          "Repair binding does not match its original grant and derived repair grant",
        );
      if (
        binding.taskId !== frozen.taskId ||
        binding.attemptId !== frozen.attemptId ||
        binding.threadId !== frozen.threadId ||
        binding.providerInstanceId !== frozen.providerInstanceId ||
        binding.worktree !== frozen.worktree ||
        binding.branch !== frozen.branch ||
        fingerprint({
          ...binding,
          status: frozen.status,
          revision: frozen.revision,
          updatedAt: frozen.updatedAt,
          sessionId: frozen.sessionId,
        }) !== fingerprint(expectedFrozen)
      )
        return yield* deny("Frozen dispatch configuration changed");
      const bindingRows = yield* sql<{
        project_id: string;
        status: string;
        revision: number;
        generation: number;
        task_id: string;
        attempt_id: string;
        provider_instance_id: string;
        thread_id: string;
        session_id: string | null;
        payload_json: string;
      }>`SELECT project_id,status,revision,generation,task_id,attempt_id,provider_instance_id,
        thread_id,session_id,payload_json FROM project_team_run_binding WHERE record_id=${binding.recordId}`;
      const projectedBinding = bindingRows[0];
      if (
        bindingRows.length !== 1 ||
        !projectedBinding ||
        projectedBinding.project_id !== binding.projectId ||
        projectedBinding.status !== binding.status ||
        projectedBinding.revision !== binding.revision ||
        projectedBinding.generation !== binding.generation ||
        projectedBinding.task_id !== binding.taskId ||
        projectedBinding.attempt_id !== binding.attemptId ||
        projectedBinding.provider_instance_id !== binding.providerInstanceId ||
        projectedBinding.thread_id !== binding.threadId ||
        projectedBinding.session_id !== (binding.sessionId ?? null)
      )
        return yield* deny("Current binding SQL ownership is missing or inconsistent");
      const bindingPayload = yield* decodeJsonRecord(projectedBinding.payload_json).pipe(
        Effect.mapError(() => deny("Binding SQL payload is invalid")),
      );
      if (fingerprint(bindingPayload) !== fingerprint(binding))
        return yield* deny("Binding SQL payload disagrees with current authority");
      if (intent.limits.writable) {
        const expected = initial.dispatch?.writableReservation;
        const writers = records.filter(
          (r) => r.kind === "reservation" && r.recordId === intent.writableReservationId,
        );
        const writer = writers[0];
        if (
          !expected ||
          writers.length !== 1 ||
          writer?.kind !== "reservation" ||
          writer.status !== "held" ||
          writer.environmentId !== environmentId ||
          writer.projectId !== row.project_id ||
          writer.runId !== row.binding_id ||
          writer.taskId !== binding.taskId ||
          writer.attemptId !== binding.attemptId ||
          writer.generation !== row.generation ||
          writer.scope !== "project" ||
          writer.resourceKey !== "writable" ||
          writer.slot !== expected.slot ||
          writer.maximumTokens !== expected.maximumTokens ||
          writer.consumedTokens !== 0
        )
          return yield* deny("Original writer reservation is no longer held");
        const projected = yield* sql<{
          record_id: string;
          project_id: string;
          status: string;
          revision: number;
          generation: number;
          updated_at: string;
          task_id: string;
          attempt_id: string;
          scope_key: string;
          slot: number;
          payload_json: string;
        }>`SELECT record_id,project_id,status,revision,generation,updated_at,task_id,attempt_id,scope_key,slot,payload_json
          FROM project_team_reservation WHERE record_id=${writer.recordId}`;
        const held = projected[0];
        if (
          projected.length !== 1 ||
          !held ||
          held.record_id !== writer.recordId ||
          held.project_id !== writer.projectId ||
          held.status !== "held" ||
          held.revision !== writer.revision ||
          held.generation !== writer.generation ||
          held.updated_at !== writer.updatedAt ||
          held.task_id !== writer.taskId ||
          held.attempt_id !== writer.attemptId ||
          held.slot !== writer.slot ||
          held.scope_key !== canonicalProjectWorkPayload([environmentId, "project", row.project_id])
        )
          return yield* deny("Writer SQL ownership disagrees with its reservation");
        const payload = yield* decodeJsonRecord(held.payload_json).pipe(
          Effect.mapError(() => deny("Writer SQL payload is invalid")),
        );
        if (fingerprint(payload) !== fingerprint(writer))
          return yield* deny("Writer SQL payload disagrees with its reservation");
      }
      const role = records.find(
        (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
      );
      if (role?.kind !== "role-revision") return yield* deny("Frozen role is missing");
      const rootBudgets = yield* sql<{ maximum_tokens: number; deadline_at_ms: number }>`
      SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${environmentId}
        AND project_id=${row.project_id} AND root_task_id=${intent.limits.rootTaskId}`;
      if (
        rootBudgets.length !== 1 ||
        rootBudgets[0]?.maximum_tokens !== intent.limits.maximumTokens ||
        rootBudgets[0]?.deadline_at_ms !== intent.limits.rootDeadlineAtMs
      )
        return yield* deny("Original root budget changed or disappeared");
      const policy = resolveProjectTeamLimits({
        state,
        taskId: binding.taskId,
        roleRevisionId: binding.roleRevisionId,
        nowMs: now,
        environmentModelCalls: environmentCalls,
        writable: intent.limits.writable,
        rootBudget: {
          rootTaskId: intent.limits.rootTaskId,
          maximumTokens: intent.limits.maximumTokens,
          deadlineAtMs: intent.limits.rootDeadlineAtMs,
        },
        attemptConfiguration: binding.configuration,
        ...(binding.parentRunId === undefined ? {} : { parentRunId: binding.parentRunId }),
      });
      if (
        policy._tag !== "Eligible" ||
        policy.frozen.delegationDepth > intent.limits.maximumDelegationDepth
      )
        return yield* deny("Current managed limits deny execution");
      yield* Effect.try({
        try: () => assertProjectTeamRunAuthority(state, binding, role, true),
        catch: () => deny("Dispatch grant or assignment is stale"),
      });
      const dependencies = yield* Effect.try({
        try: () => deliveryDependencyIds(state, binding.taskId),
        catch: () => deny("Dependency lineage changed"),
      });
      if (dependencies.length > 0) {
        if (Option.isNone(settings)) return yield* deny("Delivery settings unavailable");
        const { makeProjectTeamDeliveryAcceptance } = yield* Effect.promise(
          () => import("./ProjectTeamDeliveryAcceptance.ts"),
        );
        const client = yield* Effect.serviceOption(SqlClient.SqlClient),
          owner = yield* Effect.serviceOption(ProjectWorkRepository);
        if (
          (Option.isSome(client) && client.value !== sql) ||
          (Option.isSome(owner) && owner.value !== repository)
        )
          return yield* deny("Delivery requires original dispatch services");
        const acceptance = yield* makeProjectTeamDeliveryAcceptance({ environmentId }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
          Effect.provideService(ServerSettingsService, settings.value),
          Effect.mapError(() => deny("Delivery history unavailable")),
        );
        yield* acceptance
          .assertTaskDependenciesInTransaction({
            projectId: ProjectId.make(state.projectId),
            taskId: binding.taskId,
          })
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
            Effect.mapError(() => deny("Delivered dependency history changed")),
          );
      }
      const attempt = state.attempts.find(
        (a) => a.attemptId === binding.attemptId && a.taskId === binding.taskId,
      );
      const leaseDeadlineAtMs =
        attempt?.leasedUntil === undefined ? undefined : deadline(attempt.leasedUntil);
      if (
        state.tasks.find((t) => t.taskId === binding.taskId)?.activeAttemptId !==
          binding.attemptId ||
        !attempt ||
        (attempt.state !== "leased" && attempt.state !== "running") ||
        !attempt.leasedUntil ||
        attempt.leaseToken !== initial.claim.leaseToken ||
        leaseDeadlineAtMs === undefined ||
        leaseDeadlineAtMs <= now
      )
        return yield* deny("Dispatch lease expired or changed");
      // Authority reads may await SQL; execution validity uses the clock after those reads.
      const admittedAt = yield* Clock.currentTimeMillis;
      yield* assertExecutionTime(intent, leaseDeadlineAtMs, admittedAt);
      return { state, binding, role, now: admittedAt, leaseDeadlineAtMs };
    });
    const currentClaim = Effect.fn("ProjectTeamDispatchJournal.currentClaim")(function* (
      row: Row,
      intent: typeof Intent.Type,
    ) {
      const authority = yield* current(row, intent);
      yield* readClaimBaseline(row, intent, true);
      yield* assertExecutionTime(
        intent,
        authority.leaseDeadlineAtMs,
        yield* Clock.currentTimeMillis,
      );
      return authority;
    });
    const reserve = Effect.fn("ProjectTeamDispatchJournal.reserve")(function* (
      input: ProjectTeamDispatchRequest,
      validation?: {
        readonly beforeDomainWrite: Effect.Effect<void, ProjectTeamDispatchJournalError>;
      },
    ) {
      const beforeDomainWrite = validation?.beforeDomainWrite;
      const request = yield* decodeRequest(input).pipe(
        Effect.mapError(() => deny("Invalid dispatch request")),
      );
      const transition = request.claim.transition;
      if (
        transition?.kind !== "claim" ||
        transition.dispatch !== undefined ||
        request.claim.guided !== undefined
      )
        return yield* deny("Dispatch requires one uncompiled private claim");
      const binding = transition.binding;
      const requestedLease = deadline(transition.claim.leasedUntil);
      if (requestedLease === undefined) return yield* deny("Dispatch lease timestamp is invalid");
      if (
        binding.environmentId !== environmentId ||
        request.git.effectId !== request.dispatchId ||
        request.git.runId !== binding.recordId ||
        request.git.generation !== binding.generation ||
        request.git.worktreePath !== binding.worktree ||
        request.git.branchRef !== binding.branch
      )
        return yield* deny("Assignment does not match its frozen run");
      let admitted: { row: Row; intent: typeof Intent.Type } | undefined;
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          if (verifyAdmission) yield* verifyAdmission({ stage: "before", request });
          const existing = yield* sql<Row>`SELECT dispatch_id,project_id,environment_id,binding_id,
        generation,revision,claim_generation,stage,intent_json FROM project_team_dispatch
        WHERE dispatch_id=${request.dispatchId}`;
          if (existing.length > 0) {
            admitted = yield* read(request.dispatchId);
            if (fingerprint(admitted.intent.request) !== fingerprint(request))
              return yield* deny("Dispatch identity was reused");
            yield* current(admitted.row, admitted.intent);
            return [admitted.intent.compiledClaim];
          }
          if (yield* isProjectWorkTombstoned(sql, binding.projectId))
            return yield* deny("Project is deleted");
          const state = yield* readCurrentState(sql, binding.projectId);
          const now = yield* Clock.currentTimeMillis;
          const records = state.foundationRecords ?? [];
          let rootTaskId = binding.taskId;
          const tasks = new Set<string>();
          for (;;) {
            if (tasks.has(rootTaskId) || tasks.size >= 9)
              return yield* deny("Invalid task ancestry");
            tasks.add(rootTaskId);
            const memberships = records.filter(
              (r) => r.kind === "task-membership" && r.taskId === rootTaskId,
            );
            const membership = memberships[0];
            if (memberships.length !== 1 || membership?.kind !== "task-membership")
              return yield* deny("Invalid task ancestry");
            if (!membership.parentTaskId) break;
            rootTaskId = membership.parentTaskId;
          }
          const budgets = yield* sql<{ maximum_tokens: number; deadline_at_ms: number }>`
        SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget
        WHERE environment_id=${environmentId} AND project_id=${binding.projectId} AND root_task_id=${rootTaskId}`;
          const anchors = yield* sql<{
            intent_json: string;
          }>`SELECT intent_json FROM project_team_dispatch
        WHERE environment_id=${environmentId} AND project_id=${binding.projectId} AND root_task_id=${rootTaskId}
        ORDER BY created_at,dispatch_id LIMIT 1`;
          const anchor = anchors[0] ? yield* decodeIntent(anchors[0].intent_json) : undefined;
          if (budgets.length > 0 !== (anchor !== undefined))
            return yield* deny("Root budget requires trusted legacy reconciliation");
          const role = records.find(
            (r) => r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
          );
          if (role?.kind !== "role-revision") return yield* deny("Configured role is missing");
          const policies = records.filter(
            (r) => r.kind === "limits" && r.status === "configured" && r.model === role.model,
          );
          const policy = policies[0];
          if (policies.length !== 1 || policy?.kind !== "limits")
            return yield* deny("One configured model policy is required");
          if (
            anchor &&
            (budgets[0]?.maximum_tokens !== anchor.limits.maximumTokens ||
              budgets[0]?.deadline_at_ms !== anchor.limits.rootDeadlineAtMs ||
              anchor.limits.rootTaskId !== rootTaskId)
          )
            return yield* deny("Original root budget changed");
          // Implementation also reserves its setup writes, even when its local tool subset is read-only.
          const writable =
            role.role === "implementer" ||
            role.role === "integrator" ||
            ["pi.write", "pi.edit", "pi.bash"].some((tool) =>
              binding.configuration.toolIds.includes(tool),
            );
          const rootBudget = budgets[0]
            ? {
                rootTaskId,
                maximumTokens: budgets[0].maximum_tokens,
                deadlineAtMs: budgets[0].deadline_at_ms,
              }
            : {
                rootTaskId,
                maximumTokens: Math.min(binding.configuration.maxTokens, policy.tokenLimit),
                deadlineAtMs:
                  now + Math.min(binding.configuration.maxDurationMs, policy.durationLimitMs),
              };
          const resolved = resolveProjectTeamLimits({
            state,
            taskId: binding.taskId,
            roleRevisionId: binding.roleRevisionId,
            nowMs: now,
            environmentModelCalls: environmentCalls,
            writable,
            rootBudget,
            attemptConfiguration: binding.configuration,
            ...(binding.parentRunId === undefined ? {} : { parentRunId: binding.parentRunId }),
          });
          if (resolved._tag !== "Eligible")
            return yield* deny(`Dispatch limits blocked: ${resolved.reason}`);
          const snapshot = resolved.frozen;
          const rootCaps = anchor?.rootCaps ?? {
            maximumDelegationDepth: snapshot.maximumDelegationDepth,
            repairAllowance: snapshot.repairAllowance,
            environmentModelCalls: snapshot.environmentModelCalls,
            projectWritableWorkers: snapshot.projectWritableWorkers,
            modelCalls: snapshot.modelCalls,
          };
          const limits = {
            ...snapshot,
            maximumDelegationDepth: Math.min(
              rootCaps.maximumDelegationDepth,
              snapshot.maximumDelegationDepth,
            ),
            repairAllowance: Math.min(rootCaps.repairAllowance, snapshot.repairAllowance),
            environmentModelCalls: Math.min(
              rootCaps.environmentModelCalls,
              snapshot.environmentModelCalls,
            ),
            projectWritableWorkers: Math.min(
              rootCaps.projectWritableWorkers,
              snapshot.projectWritableWorkers,
            ),
            modelCalls: Math.min(rootCaps.modelCalls, snapshot.modelCalls),
          };
          if (limits.delegationDepth > limits.maximumDelegationDepth)
            return yield* deny("Original root depth exhausted");
          const held = yield* sql<{ slot: number }>`SELECT slot FROM project_team_reservation
        WHERE project_id=${binding.projectId} AND status='held' AND scope_key=${canonicalProjectWorkPayload([environmentId, "project", binding.projectId])}`;
          const slot = Array.from(
            { length: limits.projectWritableWorkers },
            (_, index) => index,
          ).find((index) => !held.some((r) => r.slot === index));
          if (writable && slot === undefined)
            return yield* deny("Writable project capacity exhausted");
          const at = request.claim.committedAt;
          const effectId = projectTeamDerivedRecordId(request.claim.commandId, "dispatch-effect");
          const reservationId = projectTeamDerivedRecordId(
            request.claim.commandId,
            "writable-reservation",
          );
          if (
            transition.repair !== undefined &&
            binding.authorizationGateId !== transition.authorizationGateId
          )
            return yield* deny("Repair input binding changed its inherited authorization grant");
          const compiledClaim: typeof ProjectWorkFoundationCommitCommand.Type = {
            ...request.claim,
            transition: {
              ...transition,
              binding: {
                ...binding,
                ...(transition.repair === undefined
                  ? {}
                  : {
                      authorizationGateId: projectTeamDerivedRecordId(
                        request.claim.commandId,
                        `repair-grant:${transition.repair.episodeId}:${binding.generation}`,
                      ),
                    }),
                configuration: {
                  ...binding.configuration,
                  maxTokens: limits.attemptMaximumTokens,
                  maxDurationMs: limits.deadlineAtMs - now,
                },
              },
              claim: {
                ...transition.claim,
                leasedUntil: time(Math.min(requestedLease, limits.deadlineAtMs)),
              },
              dispatch: {
                effect: {
                  kind: "effect",
                  projectId: binding.projectId,
                  recordId: effectId,
                  revision: 0,
                  generation: binding.generation,
                  updatedAt: at,
                  status: "pending",
                  effectId: request.dispatchId,
                  effectKind: "dispatch",
                  taskId: binding.taskId,
                  runId: binding.recordId,
                  targetId: binding.recordId,
                  payload: {
                    recordIds: [binding.recordId],
                    expectedRevision: request.claim.expectedRevision,
                  },
                  claimGeneration: 0,
                  availableAt: at,
                },
                ...(writable
                  ? {
                      writableReservation: {
                        kind: "reservation" as const,
                        projectId: binding.projectId,
                        recordId: reservationId,
                        revision: 0,
                        generation: binding.generation,
                        updatedAt: at,
                        status: "held" as const,
                        environmentId,
                        scope: "project" as const,
                        resourceKey: "writable",
                        slot: slot!,
                        runId: binding.recordId,
                        taskId: binding.taskId,
                        attemptId: binding.attemptId,
                        maximumTokens: 0,
                        consumedTokens: 0,
                      },
                    }
                  : {}),
              },
            },
          };
          const selectedPlans = records.filter(
            (record) =>
              record.kind === "plan-revision" &&
              record.taskId === binding.taskId &&
              record.specRevision === binding.specRevision &&
              record.planRevision === binding.planRevision &&
              record.status === "proposed",
          );
          const selectedPlan = selectedPlans[0];
          const integration =
            writable &&
            selectedPlan?.kind === "plan-revision" &&
            selectedPlan.integrationSources !== undefined
              ? {
                  version: 1 as const,
                  planId: selectedPlan.recordId,
                  planRevision: selectedPlan.planRevision,
                  planContentHash: selectedPlan.contentHash,
                  selection: selectedPlan.integrationSources,
                  selectionSha256: selectionHash(selectedPlan.integrationSources),
                }
              : undefined;
          if (
            integration !== undefined &&
            (selectedPlans.length !== 1 ||
              role.role !== "integrator" ||
              integration.selection.environmentId !== environmentId ||
              selectedPlan?.kind !== "plan-revision" ||
              projectTeamPlanHash(selectedPlan) !== integration.planContentHash)
          )
            return yield* deny(
              "Integration dispatch requires its exact approved source plan and original integrator",
            );
          const intent: typeof Intent.Type = {
            request,
            ...(integration === undefined ? {} : { integration }),
            compiledClaim,
            limits,
            rootCaps,
            ...(writable ? { writableReservationId: reservationId } : {}),
          };
          if (Buffer.byteLength(encodeIntent(intent)) > 262144)
            return yield* deny("Dispatch intent exceeds its storage bound");
          // Admission's resource loan compares the pre-claim reducer snapshot. Revalidate it
          // after the awaited admission reads, before this transaction changes that snapshot.
          if (beforeDomainWrite !== undefined) yield* beforeDomainWrite;
          if (budgets.length === 0)
            yield* sql`INSERT INTO project_team_model_budget VALUES
        (${environmentId},${binding.projectId},${rootTaskId},${limits.maximumTokens},${limits.rootDeadlineAtMs})`;
          admitted = {
            row: {
              dispatch_id: request.dispatchId,
              project_id: binding.projectId,
              environment_id: environmentId,
              binding_id: binding.recordId,
              generation: binding.generation,
              task_id: binding.taskId,
              attempt_id: binding.attemptId,
              worktree: binding.worktree,
              branch: binding.branch,
              root_task_id: limits.rootTaskId,
              root_maximum_tokens: limits.maximumTokens,
              root_deadline_at_ms: limits.rootDeadlineAtMs,
              attempt_maximum_tokens: limits.attemptMaximumTokens,
              attempt_deadline_at_ms: limits.deadlineAtMs,
              delegation_depth: limits.delegationDepth,
              maximum_delegation_depth: limits.maximumDelegationDepth,
              repair_allowance: limits.repairAllowance,
              stage: "reserved",
              revision: 0,
              claim_generation: 0,
              cleanup_claim_revision: null,
              intent_json: encodeIntent(intent),
              created_at: request.claim.committedAt,
              updated_at: request.claim.committedAt,
            },
            intent,
          };
          return [compiledClaim];
        }),
        Effect.gen(function* () {
          if (!admitted) return yield* deny("Dispatch was not admitted");
          yield* current(admitted.row, admitted.intent);
          const { row, intent } = admitted;
          yield* sql`INSERT INTO project_team_dispatch (dispatch_id,environment_id,project_id,binding_id,
        generation,task_id,attempt_id,worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,
        attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,
        repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
        VALUES (${row.dispatch_id},${environmentId},${row.project_id},${row.binding_id},${row.generation},
          ${binding.taskId},${binding.attemptId},${binding.worktree},${binding.branch},${intent.limits.rootTaskId},
          ${intent.limits.maximumTokens},${intent.limits.rootDeadlineAtMs},${intent.limits.attemptMaximumTokens},
          ${intent.limits.deadlineAtMs},${intent.limits.delegationDepth},${intent.limits.maximumDelegationDepth},
          ${intent.limits.repairAllowance},'reserved',0,0,${row.intent_json},${request.claim.committedAt},${request.claim.committedAt})
        ON CONFLICT(dispatch_id) DO NOTHING`;
          const committed = yield* read(row.dispatch_id);
          if (committed.row.intent_json !== row.intent_json)
            return yield* deny("Dispatch identity conflicts");
          // Complete awaited SQL authority reads before the last resource/settings loan.
          // Its own legitimate writes changed the reducer snapshot, not the frozen resources.
          const finalAuthority = yield* current(committed.row, committed.intent);
          if (verifyAdmission) yield* verifyAdmission({ stage: "after", request });
          yield* assertExecutionTime(
            committed.intent,
            finalAuthority.leaseDeadlineAtMs,
            yield* Clock.currentTimeMillis,
          );
        }),
      );
      if (!admitted) return yield* deny("Dispatch commit is missing");
      return { fence: fence(admitted.row), intent: admitted.intent };
    });
    const inspect = Effect.fn("ProjectTeamDispatchJournal.inspect")(function* (
      dispatchId: string,
      options?: { readonly requireClaim: true },
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(dispatchId);
          if (options?.requireClaim) yield* currentClaim(value.row, value.intent);
          else yield* current(value.row, value.intent);
          return { fence: fence(value.row), intent: value.intent };
        }),
      );
    });
    const claimEffect = Effect.fn("ProjectTeamDispatchJournal.claimEffect")(function* (
      expected: ProjectTeamDispatchFence,
    ) {
      let claimed: { row: Row; intent: typeof Intent.Type } | undefined;
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          const value = yield* read(expected.dispatchId);
          const authority = yield* current(value.row, value.intent);
          if (
            fingerprint(fence(value.row)) !== fingerprint(expected) ||
            value.row.stage !== "reserved"
          )
            return yield* deny("Dispatch claim fence is stale");
          const effect = authority.state.foundationRecords?.find(
            (record) =>
              record.kind === "effect" &&
              record.effectId === expected.dispatchId &&
              record.runId === value.row.binding_id,
          );
          if (
            effect?.kind !== "effect" ||
            effect.status !== "pending" ||
            effect.claimGeneration !== value.row.claim_generation ||
            effect.generation !== value.row.generation
          )
            return yield* deny("Dispatch effect is already claimed or changed");
          const at = time(authority.now);
          const updated = yield* decodeRecord({
            ...effect,
            status: "claimed",
            revision: effect.revision + 1,
            claimGeneration: effect.claimGeneration + 1,
            updatedAt: at,
          });
          claimed = {
            ...value,
            row: {
              ...value.row,
              revision: value.row.revision + 1,
              claim_generation: value.row.claim_generation + 1,
            },
          };
          return [
            {
              type: "project-work.foundation.commit" as const,
              projectId: value.intent.compiledClaim.projectId,
              commandId: CommandId.make(
                projectTeamDerivedRecordId(value.intent.compiledClaim.commandId, "claim-dispatch"),
              ),
              expectedRevision: authority.state.revision,
              attribution: value.intent.compiledClaim.attribution,
              records: [updated],
              committedAt: at,
            },
          ];
        }),
        Effect.gen(function* () {
          if (!claimed) return yield* deny("Dispatch effect claim is missing");
          yield* current(claimed.row, claimed.intent);
          const changed =
            yield* sql`UPDATE project_team_dispatch SET revision=${claimed.row.revision},
        claim_generation=${claimed.row.claim_generation},updated_at=${time(yield* Clock.currentTimeMillis)}
        WHERE dispatch_id=${expected.dispatchId} AND environment_id=${environmentId}
          AND revision=${expected.revision} AND claim_generation=${expected.claimGeneration} AND stage='reserved'
        RETURNING dispatch_id`;
          if (changed.length !== 1) return yield* deny("Dispatch effect claim was superseded");
          const final = yield* read(expected.dispatchId);
          const authority = yield* currentClaim(final.row, final.intent);
          if (verifyClaimFinal)
            yield* verifyClaimFinal({ fence: fence(final.row), intent: final.intent });
          yield* assertExecutionTime(
            final.intent,
            authority.leaseDeadlineAtMs,
            yield* Clock.currentTimeMillis,
          );
        }),
      );
      if (!claimed) return yield* deny("Dispatch effect claim did not commit");
      return { fence: fence(claimed.row), intent: claimed.intent };
    });
    const readRetained = Effect.fn("ProjectTeamDispatchJournal.readRetained")(function* (
      dispatchId: string,
    ) {
      const value = yield* read(dispatchId);
      yield* readClaimBaseline(value.row, value.intent);
      return { fence: fence(value.row), intent: value.intent };
    });
    const recoveryIds = Effect.fn("ProjectTeamDispatchJournal.recoveryIds")(function* (input: {
      readonly afterDispatchId?: string;
      readonly limit: number;
    }) {
      const limit = yield* decodeCalls(input.limit);
      const after =
        input.afterDispatchId === undefined ? "" : yield* decodeId(input.afterDispatchId);
      // Retained discovery grants cleanup knowledge, never forward execution authority.
      return yield* sql<{ dispatch_id: string }>`SELECT dispatch_id FROM project_team_dispatch
        WHERE environment_id=${environmentId} AND stage <> 'settled' AND dispatch_id > ${after}
        ORDER BY dispatch_id LIMIT ${limit}`;
    });
    const readRecoveryPage = Effect.fn("ProjectTeamDispatchJournal.readRecoveryPage")(
      function* (input: { readonly afterDispatchId?: string; readonly limit: number }) {
        return yield* Effect.forEach(yield* recoveryIds(input), (row) =>
          readRetained(row.dispatch_id),
        );
      },
    );
    const readRecoveryCandidates = Effect.fn("ProjectTeamDispatchJournal.readRecoveryCandidates")(
      function* (input: {
        readonly afterDispatchId?: string;
        readonly afterPosition?: ProjectTeamDispatchRecoveryPosition;
        readonly limit: number;
      }) {
        if (input.afterDispatchId !== undefined && input.afterPosition !== undefined)
          return yield* deny("Recovery continuation requires exactly one cursor");
        const limit = yield* decodeCalls(input.limit);
        type RecoveryRow = { dispatch_id: unknown; row_id: string };
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            let rows: ReadonlyArray<RecoveryRow>;
            if (input.afterPosition !== undefined) {
              const position = yield* decodeRecoveryPosition(input.afterPosition).pipe(
                Effect.mapError(() => deny("Invalid recovery continuation position")),
              );
              const retained =
                yield* sql<RecoveryRow>`SELECT dispatch_id,CAST(rowid AS TEXT) AS row_id
              FROM project_team_dispatch WHERE rowid=CAST(${position.rowId} AS INTEGER)
                AND environment_id=${environmentId}`;
              const previous = retained[0];
              if (
                retained.length !== 1 ||
                !previous ||
                previous.row_id !== position.rowId ||
                fingerprint(["project-team-recovery-position", previous.dispatch_id]) !==
                  position.dispatchIdHash
              )
                return yield* deny("Recovery continuation owner is missing or changed");
              rows = yield* sql<RecoveryRow>`SELECT dispatch_id,CAST(rowid AS TEXT) AS row_id
              FROM project_team_dispatch WHERE environment_id=${environmentId} AND stage <> 'settled'
                AND (dispatch_id > ${previous.dispatch_id}
                  OR (dispatch_id IS ${previous.dispatch_id} AND rowid > CAST(${position.rowId} AS INTEGER))
                  OR (${previous.dispatch_id} IS NULL AND dispatch_id IS NOT NULL))
              ORDER BY dispatch_id,rowid LIMIT ${limit}`;
            } else if (input.afterDispatchId !== undefined) {
              const after = yield* decodeId(input.afterDispatchId);
              rows = yield* sql<RecoveryRow>`SELECT dispatch_id,CAST(rowid AS TEXT) AS row_id
              FROM project_team_dispatch WHERE environment_id=${environmentId} AND stage <> 'settled'
                AND dispatch_id > ${after} ORDER BY dispatch_id,rowid LIMIT ${limit}`;
            } else {
              // Start before every raw key, including corrupt null/empty keys; diagnostics grant no authority.
              rows = yield* sql<RecoveryRow>`SELECT dispatch_id,CAST(rowid AS TEXT) AS row_id
              FROM project_team_dispatch WHERE environment_id=${environmentId} AND stage <> 'settled'
              ORDER BY dispatch_id,rowid LIMIT ${limit}`;
            }
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const position = yield* decodeRecoveryPosition({
                  rowId: row.row_id,
                  dispatchIdHash: fingerprint(["project-team-recovery-position", row.dispatch_id]),
                });
                const dispatchId = typeof row.dispatch_id === "string" ? row.dispatch_id : null;
                const snapshot = yield* (
                  dispatchId === null
                    ? Effect.fail(deny("Dispatch row identity is invalid"))
                    : decodeId(dispatchId).pipe(Effect.flatMap(readRetained))
                ).pipe(Effect.exit);
                return { dispatchId, position, snapshot };
              }),
            );
          }),
        );
      },
    );
    const readStageHistory = Effect.fn("ProjectTeamDispatchJournal.readStageHistory")(function* (
      dispatch: Row,
      intent: typeof Intent.Type,
      historicalState?: Effect.Success<ReturnType<typeof readCurrentState>>,
    ) {
      const rows = yield* sql`SELECT * FROM project_team_dispatch_receipt
        WHERE dispatch_id=${dispatch.dispatch_id} ORDER BY revision LIMIT 129`;
      if (rows.length > 128) return yield* deny("Retained stage history exceeds its bound");
      let stage: ProjectTeamDispatchStage = "reserved";
      let revision = yield* readClaimBaseline(dispatch, intent, false, historicalState);
      let recordedAt = deadline(dispatch.created_at)!;
      const updatedAt = deadline(dispatch.updated_at)!;
      const receipts = [];
      for (const raw of rows) {
        const row = yield* decodeStoredStageReceipt(raw).pipe(
          Effect.mapError(() => deny("Retained stage receipt is invalid")),
        );
        const timestamp = deadline(row.recorded_at);
        const cleanup = isCleanupStage(row.stage);
        if (
          stage === "settled" ||
          (dispatch.claim_generation === 0 && !cleanup) ||
          row.dispatch_id !== dispatch.dispatch_id ||
          row.claim_generation !== dispatch.claim_generation ||
          row.revision !== revision + 1 ||
          timestamp === undefined ||
          timestamp < recordedAt ||
          timestamp > updatedAt ||
          (!cleanup && nextForwardStage[stage] !== row.stage)
        )
          return yield* deny("Retained stage receipt does not match its ordered dispatch history");
        const evidence = yield* decodeStageEvidence(row.evidence_json).pipe(
          Effect.mapError(() => deny("Retained stage evidence is invalid")),
        );
        receipts.push({
          receiptId: row.receipt_id,
          revision: row.revision,
          claimGeneration: row.claim_generation,
          stage: row.stage,
          evidence,
          bindingId: dispatch.binding_id,
          generation: dispatch.generation,
        });
        stage = row.stage;
        revision = row.revision;
        recordedAt = timestamp;
      }
      if (stage !== dispatch.stage || revision !== dispatch.revision)
        return yield* deny("Current dispatch stage has no matching complete retained history");
      return receipts;
    });
    const advanceStage = Effect.fn("ProjectTeamDispatchJournal.advanceStage")(function* (
      expected: ProjectTeamDispatchFence,
      input: ProjectTeamDispatchStageReceipt,
    ) {
      const receipt = yield* decodeStageReceipt(input).pipe(
        Effect.mapError(() => deny("Invalid stage receipt")),
      );
      const evidence = encodeStageEvidence(receipt.evidence);
      if (Buffer.byteLength(evidence) > 262144)
        return yield* deny("Stage evidence exceeds its storage bound");
      const verifyStage = options.verifyStage;
      if (!verifyStage) return yield* deny("Actual stage verification is unavailable");
      const independent = Option.isNone(yield* Effect.serviceOption(sql.transactionService));
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(expected.dispatchId);
          const history = yield* readStageHistory(value.row, value.intent);
          const stored =
            yield* sql`SELECT * FROM project_team_dispatch_receipt WHERE receipt_id=${receipt.receiptId}`;
          const old = yield* Effect.forEach(stored, (row) =>
            decodeStoredStageReceipt(row).pipe(
              Effect.mapError(() => deny("Retained stage receipt is invalid")),
            ),
          );
          if (old[0]) {
            if (
              old.length !== 1 ||
              old[0].dispatch_id !== expected.dispatchId ||
              old[0].stage !== receipt.stage ||
              old[0].evidence_json !== evidence ||
              old[0].claim_generation !== expected.claimGeneration ||
              old[0].revision > value.row.revision ||
              deadline(old[0].recorded_at) === undefined
            )
              return yield* deny("Stage receipt identity was reused");
            // Exact replay never grants another external effect. Forward replays still require current authority.
            const authority = isCleanupStage(receipt.stage)
              ? undefined
              : yield* currentClaim(value.row, value.intent);
            if (verifyStageFinal)
              yield* verifyStageFinal(receipt, { fence: fence(value.row), intent: value.intent });
            if (authority)
              yield* assertExecutionTime(
                value.intent,
                authority.leaseDeadlineAtMs,
                yield* Clock.currentTimeMillis,
              );
            return { fence: fence(value.row), intent: value.intent, duplicate: true };
          }
          if (
            fingerprint(fence(value.row)) !== fingerprint(expected) ||
            (value.row.claim_generation === 0 && !isCleanupStage(receipt.stage))
          )
            return yield* deny("Stage ownership fence is stale");
          const cleanup = isCleanupStage(receipt.stage);
          if (
            value.row.stage === "settled" ||
            (!cleanup && nextForwardStage[value.row.stage] !== receipt.stage)
          )
            return yield* deny("Dispatch stage cannot advance out of order");
          if (!cleanup) {
            yield* currentClaim(value.row, value.intent);
          }
          if (history.length >= 128)
            return yield* deny("Retained stage history is full; cleanup requires attention");
          yield* verifyStage(receipt, { fence: fence(value.row), intent: value.intent });
          // Verification may await filesystem or native services; re-read committed history and authority.
          yield* readStageHistory(value.row, value.intent);
          let authority = cleanup ? undefined : yield* currentClaim(value.row, value.intent);
          const revision = value.row.revision + 1;
          const now = yield* Clock.currentTimeMillis;
          if (authority) yield* assertExecutionTime(value.intent, authority.leaseDeadlineAtMs, now);
          const at = time(now);
          const updated =
            yield* sql`UPDATE project_team_dispatch SET stage=${receipt.stage},revision=${revision},updated_at=${at}
          WHERE dispatch_id=${expected.dispatchId} AND environment_id=${environmentId}
            AND revision=${expected.revision} AND claim_generation=${expected.claimGeneration} AND stage=${expected.stage}
          RETURNING dispatch_id`;
          if (updated.length !== 1) return yield* deny("Stage ownership was superseded");
          yield* sql`INSERT INTO project_team_dispatch_receipt VALUES
          (${receipt.receiptId},${expected.dispatchId},${revision},${expected.claimGeneration},${receipt.stage},${evidence},${at})`;
          const final = yield* read(expected.dispatchId);
          if (
            fingerprint(fence(final.row)) !==
              fingerprint(fence({ ...value.row, revision, stage: receipt.stage })) ||
            fingerprint(final.intent) !== fingerprint(value.intent)
          )
            return yield* deny("Final stage ownership changed");
          yield* readStageHistory(final.row, final.intent);
          if (!cleanup) {
            authority = yield* currentClaim(final.row, final.intent);
          }
          if (verifyStageFinal)
            yield* verifyStageFinal(receipt, { fence: fence(final.row), intent: final.intent });
          // An awaited write or history read can exhaust authority; fail while both writes can still roll back.
          if (authority)
            yield* assertExecutionTime(
              value.intent,
              authority.leaseDeadlineAtMs,
              yield* Clock.currentTimeMillis,
            );
          return {
            fence: fence({ ...value.row, revision, stage: receipt.stage }),
            intent: value.intent,
            duplicate: false,
          };
        }),
      );
      if (independent) yield* notifyCompactCallerChange;
      return result;
    });
    const readHistoricalInTransaction = Effect.fn(
      "ProjectTeamDispatchJournal.readHistoricalInTransaction",
    )(function* (
      dispatchId: string,
      historicalState?: Effect.Success<ReturnType<typeof readCurrentState>>,
    ) {
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepository = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepository) ||
        suppliedRepository.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Dispatch history requires its original caller transaction");
      const value = yield* read(yield* decodeId(dispatchId));
      const receipts = yield* readStageHistory(value.row, value.intent, historicalState);
      return { snapshot: { fence: fence(value.row), intent: value.intent }, receipts };
    });
    const readStageReceipts = Effect.fn("ProjectTeamDispatchJournal.readStageReceipts")(function* (
      dispatchId: string,
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(dispatchId);
          return yield* readStageHistory(value.row, value.intent);
        }),
      );
    });
    const claimCleanup = Effect.fn("ProjectTeamDispatchJournal.claimCleanup")(function* (
      expected: ProjectTeamDispatchFence,
    ) {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        (Option.isSome(client) && client.value !== sql) ||
        Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Cleanup claim requires its captured independent SQL transaction");
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(expected.dispatchId);
          yield* readStageHistory(value.row, value.intent);
          if (
            fingerprint(fence(value.row)) !== fingerprint(expected) ||
            expected.stage !== "assignment-observed"
          )
            return yield* deny("Cleanup claim fence is stale");
          yield* currentClaim(value.row, value.intent);
          const snapshot = { fence: fence(value.row), intent: value.intent };
          if (value.row.cleanup_claim_revision !== null) {
            if (value.row.cleanup_claim_revision !== expected.revision)
              return yield* deny("Cleanup claim belongs to another revision");
            return { _tag: "Claimed" as const, snapshot };
          }
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE project_team_compact_caller SET status='released'
            WHERE environment_id=${environmentId} AND binding_id=${value.row.binding_id}
            AND generation=${value.row.generation} AND status='pending' AND deadline_at_ms<=${now}`;
          const callers = yield* sql`SELECT 1 FROM project_team_compact_caller
            WHERE environment_id=${environmentId} AND binding_id=${value.row.binding_id}
            AND generation=${value.row.generation} AND status='pending' LIMIT 1`;
          if (callers.length) return { _tag: "WaitingForCompact" as const };
          const operations = yield* sql<{
            operation_kind: string;
            status: string;
          }>`SELECT operation_kind,status
          FROM project_team_pi_operation WHERE environment_id=${environmentId}
          AND binding_id=${value.row.binding_id} AND generation=${value.row.generation}
          ORDER BY operation_ordinal LIMIT 131`;
          if (operations.length > 130 || operations.some((row) => row.status === "quarantine"))
            return yield* deny("Cleanup operation ownership requires reconciliation");
          const active = operations.filter((row) => row.status !== "settled");
          if (active.some((row) => row.operation_kind !== "compact"))
            return yield* deny("Original operation must finish before cleanup");
          if (active.length > 0) return { _tag: "WaitingForCompact" as const };
          const claimed =
            yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=${expected.revision}
          WHERE dispatch_id=${expected.dispatchId} AND environment_id=${environmentId}
          AND revision=${expected.revision} AND claim_generation=${expected.claimGeneration}
          AND stage=${expected.stage} AND cleanup_claim_revision IS NULL RETURNING dispatch_id`;
          if (claimed.length !== 1) return yield* deny("Cleanup claim was superseded");
          return { _tag: "Claimed" as const, snapshot };
        }),
      );
    });
    const settleAfterJoined = Effect.fn("ProjectTeamDispatchJournal.settleAfterJoined")(function* (
      expected: ProjectTeamDispatchFence,
      input: ProjectTeamDispatchStageReceipt,
    ) {
      const receipt = yield* decodeStageReceipt(input).pipe(
        Effect.mapError(() => deny("Invalid joined settlement receipt")),
      );
      const verify = options.verifySettlement;
      if (receipt.stage !== "settled" || verify === undefined)
        return yield* deny("Original joined-owner settlement verification is unavailable");
      let settled: Effect.Success<ReturnType<typeof advanceStage>> | undefined;
      let parentProgress:
        | readonly ReturnType<typeof prepareReviewCriterionProgress>[number][]
        | undefined;
      let parentCriteria: readonly ProjectWorkCriterion[] = [];
      let inputEvidence: readonly ProjectWorkEvidence[] = [];
      let applicability: Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> | undefined;
      let verification: Extract<
        ProjectTeamReviewCompletionProof,
        { status: "completed" }
      >["parentAssessments"];
      let joinedFingerprint: string | undefined;
      const joinedCommandId = projectTeamDerivedRecordId(receipt.receiptId, "joined-domain");
      const assertCriterion = (projectId: string, criterion: ProjectWorkCriterion) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT * FROM project_work_criteria WHERE project_id=${projectId} AND criterion_id=${criterion.criterionId}`;
          const expectedRow = {
            criterion_id: criterion.criterionId,
            project_id: projectId,
            task_id: criterion.taskId,
            description: criterion.description,
            required: criterion.required ? 1 : 0,
            status: criterion.status,
            satisfied_by_evidence_ids_json: encodeProjectionJson(criterion.satisfiedByEvidenceIds),
            waiver_json:
              criterion.waiver === undefined ? null : encodeProjectionJson(criterion.waiver),
            revision: criterion.revision,
            updated_at: criterion.updatedAt,
          };
          if (rows.length !== 1 || fingerprint(rows[0]) !== fingerprint(expectedRow))
            return yield* deny("Joined review physical parent criterion changed");
        });
      const assertEvidence = (projectId: string, evidence: ProjectWorkEvidence) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT * FROM project_work_evidence WHERE project_id=${projectId} AND evidence_id=${evidence.evidenceId}`;
          const expectedRow = {
            evidence_id: evidence.evidenceId,
            project_id: projectId,
            task_id: evidence.taskId ?? null,
            criterion_id: evidence.criterionId ?? null,
            kind: evidence.kind,
            summary: evidence.summary,
            detail: evidence.detail ?? null,
            uri: evidence.uri ?? null,
            recorded_at: evidence.recordedAt,
            revision: evidence.revision,
            attribution_json:
              evidence.attribution === undefined
                ? null
                : encodeProjectionJson(evidence.attribution),
            scope_hash: evidence.scopeHash ?? null,
            output_artifact_ids_json:
              evidence.outputArtifactIds === undefined
                ? null
                : encodeProjectionJson(evidence.outputArtifactIds),
          };
          if (rows.length !== 1 || fingerprint(rows[0]) !== fingerprint(expectedRow))
            return yield* deny("Joined review physical evidence changed");
        });
      const assertInputs = (projectId: string) =>
        Effect.gen(function* () {
          for (const evidence of inputEvidence) yield* assertEvidence(projectId, evidence);
          if (applicability !== undefined) {
            const rows =
              yield* sql`SELECT * FROM project_team_evidence_applicability WHERE project_id=${projectId} AND record_id=${applicability.recordId}`;
            const expectedRow = {
              record_id: applicability.recordId,
              project_id: projectId,
              status: applicability.status,
              revision: applicability.revision,
              generation: applicability.generation,
              updated_at: applicability.updatedAt,
              task_id: applicability.taskId,
              attempt_id: null,
              member_id: null,
              source_id: null,
              scope_key: null,
              slot: null,
              unique_key: null,
              provider_instance_id: null,
              thread_id: null,
              session_id: null,
              payload_json: encodeProjectionJson(applicability),
            };
            if (rows.length !== 1 || fingerprint(rows[0]) !== fingerprint(expectedRow))
              return yield* deny("Joined review physical verification applicability changed");
          }
          if (verification !== undefined) {
            const original = verification.verification;
            const retained = yield* verificationResults.readInTransaction({
              jobId: original.jobId,
              expectedManifestHash: original.manifestHash,
            });
            if (
              retained._tag !== "Terminal" ||
              retained.metadata.resultHash !== original.resultHash ||
              retained.result.attemptId !== original.attemptId ||
              retained.result.outcome !== original.outcome ||
              retained.result.exitCode !== original.exitCode
            )
              return yield* deny("Joined review original verification result changed");
          }
        });
      const assertProgressReceipt = (
        projectId: string,
        state: Effect.Success<ReturnType<typeof readCurrentState>>,
      ) =>
        Effect.gen(function* () {
          const audited = yield* readCompletedReviewCommand({
            sql,
            projectId,
            commandId: joinedCommandId,
            dispatchId: expected.dispatchId,
            joinedReceiptId: receipt.receiptId,
            state,
            required: parentProgress !== undefined,
            parentCriteria,
            ...(joinedFingerprint === undefined ? {} : { expectedFingerprint: joinedFingerprint }),
            ...(parentProgress === undefined ? {} : { expectedDrafts: parentProgress }),
          });
          if (audited === undefined) return;
          const { events } = audited;
          // Replay checks immutable evidence, while later criterion revisions remain legitimate.
          for (const event of events) {
            if (
              event.type === "project-work.evidence.added" &&
              event.evidence.evidenceId.startsWith("review-criterion-progress:")
            )
              yield* assertEvidence(projectId, event.evidence);
          }
        });
      const assertDomainSettled = Effect.gen(function* () {
        const value = yield* read(expected.dispatchId);
        yield* readStageHistory(value.row, value.intent);
        if (value.row.stage !== "settled") return yield* deny("Dispatch has no terminal receipt");
        yield* verify(receipt, { fence: fence(value.row), intent: value.intent });
        if (yield* isProjectWorkTombstoned(sql, value.row.project_id)) return;
        const state = yield* readCurrentState(sql, value.row.project_id);
        const records = state.foundationRecords ?? [];
        const binding = records.find(
          (r) => r.kind === "run-binding" && r.recordId === value.row.binding_id,
        );
        const writer = records.find((r) => r.recordId === value.intent.writableReservationId);
        const attempt = state.attempts.find((a) => a.attemptId === value.row.attempt_id);
        if (
          binding?.kind !== "run-binding" ||
          binding.status !== "settled" ||
          binding.generation !== value.row.generation ||
          (value.intent.writableReservationId !== undefined &&
            (writer?.kind !== "reservation" ||
              writer.status !== "released" ||
              writer.runId !== binding.recordId)) ||
          attempt === undefined ||
          attempt.state === "leased" ||
          attempt.state === "running" ||
          records.some(
            (r) =>
              r.kind === "effect" &&
              r.runId === binding.recordId &&
              (r.effectKind === "dispatch" || r.effectKind === "stop") &&
              (r.status === "pending" || r.status === "claimed" || r.status === "uncertain"),
          )
        )
          return yield* deny("Joined settlement has incomplete domain ownership");
        // The reducer checkpoint is not proof that the corresponding SQL writes landed.
        // Check the original ownership rows and projections while all writes can still roll back.
        const ownership = records.filter(
          (r) =>
            (r.kind === "run-binding" && r.recordId === binding.recordId) ||
            (r.kind === "reservation" && r.recordId === value.intent.writableReservationId) ||
            (r.kind === "effect" &&
              r.runId === binding.recordId &&
              (r.effectKind === "dispatch" || r.effectKind === "stop")),
        );
        for (const record of ownership) {
          if (
            record.kind !== "run-binding" &&
            record.kind !== "reservation" &&
            record.kind !== "effect"
          )
            return yield* deny("Joined settlement ownership has an invalid kind");
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT record_id,project_id,status,revision,generation,
            updated_at,task_id,attempt_id,member_id,scope_key,slot,unique_key,
            provider_instance_id,thread_id,session_id,payload_json
            FROM ${sql("project_team_" + record.kind.replaceAll("-", "_"))}
            WHERE record_id=${record.recordId} AND project_id=${value.row.project_id}`;
          const row = rows[0];
          if (rows.length !== 1 || row === undefined)
            return yield* deny("Joined settlement physical ownership is missing");
          const payload = yield* decodeJsonRecord(row.payload_json).pipe(
            Effect.mapError(() => deny("Joined settlement physical ownership payload is invalid")),
          );
          const { payload_json: _, ...columns } = row;
          const expectedColumns = {
            record_id: record.recordId,
            project_id: record.projectId,
            status: record.status,
            revision: record.revision,
            generation: record.generation,
            updated_at: record.updatedAt,
            task_id: record.taskId ?? null,
            attempt_id: "attemptId" in record ? record.attemptId : null,
            member_id: "memberId" in record ? record.memberId : null,
            scope_key:
              record.kind === "reservation"
                ? canonicalProjectWorkPayload([
                    record.environmentId,
                    record.scope,
                    record.scope === "environment"
                      ? "model-call"
                      : record.scope === "project"
                        ? record.projectId
                        : record.resourceKey,
                  ])
                : null,
            slot: record.kind === "reservation" ? record.slot : null,
            unique_key: record.kind === "effect" ? record.effectId : null,
            provider_instance_id: record.kind === "run-binding" ? record.providerInstanceId : null,
            thread_id: record.kind === "run-binding" ? record.threadId : null,
            session_id: record.kind === "run-binding" ? (record.sessionId ?? null) : null,
          };
          if (
            fingerprint(columns) !== fingerprint(expectedColumns) ||
            fingerprint(payload) !== fingerprint(record)
          )
            return yield* deny("Joined settlement physical ownership disagrees with domain state");
        }
        const task = state.tasks.find((t) => t.taskId === value.row.task_id);
        if (
          task === undefined ||
          attempt.taskId !== task.taskId ||
          task.activeAttemptId === attempt.attemptId
        )
          return yield* deny("Joined settlement task ownership is incomplete");
        const tasks =
          yield* sql`SELECT * FROM project_work_tasks WHERE project_id=${value.row.project_id} AND task_id=${task.taskId}`;
        const attempts =
          yield* sql`SELECT * FROM project_work_attempts WHERE project_id=${value.row.project_id} AND attempt_id=${attempt.attemptId}`;
        const expectedTask = {
          task_id: task.taskId,
          project_id: value.row.project_id,
          title: task.title,
          summary: task.summary ?? null,
          state: task.state,
          specification_json:
            task.specification === undefined ? null : encodeProjectionJson(task.specification),
          assignee_json: task.assignee === undefined ? null : encodeProjectionJson(task.assignee),
          watchers_json: encodeProjectionJson(task.watchers ?? []),
          approval_json: task.approval === undefined ? null : encodeProjectionJson(task.approval),
          revision: task.revision,
          spec_revision: task.specRevision,
          active_attempt_id: task.activeAttemptId ?? null,
          failure_kind: task.failureKind ?? null,
          blocker_id: task.blockerId ?? null,
          created_at: task.createdAt,
          updated_at: task.updatedAt,
          completed_at: task.completedAt ?? null,
          canceled_at: task.canceledAt ?? null,
          attribution_json:
            task.attribution === undefined ? null : encodeProjectionJson(task.attribution),
        };
        const expectedAttempt = {
          attempt_id: attempt.attemptId,
          project_id: value.row.project_id,
          task_id: attempt.taskId,
          state: attempt.state,
          lease_token: attempt.leaseToken ?? null,
          leased_until: attempt.leasedUntil ?? null,
          started_at: attempt.startedAt ?? null,
          ended_at: attempt.endedAt ?? null,
          failure_kind: attempt.failureKind ?? null,
          failure_reason: attempt.failureReason ?? null,
          failure_evidence_ids_json: encodeProjectionJson(attempt.failureEvidenceIds ?? []),
          failure_resolved_at: attempt.failureResolvedAt ?? null,
          failure_resolution_reason: attempt.failureResolutionReason ?? null,
          failure_resolution_evidence_ids_json: encodeProjectionJson(
            attempt.failureResolutionEvidenceIds ?? [],
          ),
          failure_resolution_attribution_json:
            attempt.failureResolutionAttribution === undefined
              ? null
              : encodeProjectionJson(attempt.failureResolutionAttribution),
          checkpoint_ids_json: encodeProjectionJson(attempt.checkpointIds),
          revision: attempt.revision,
          updated_at: attempt.endedAt ?? attempt.startedAt ?? "",
          attribution_json:
            attempt.attribution === undefined ? null : encodeProjectionJson(attempt.attribution),
        };
        if (
          tasks.length !== 1 ||
          attempts.length !== 1 ||
          fingerprint(tasks[0]) !== fingerprint(expectedTask) ||
          fingerprint(attempts[0]) !== fingerprint(expectedAttempt)
        )
          return yield* deny(
            "Joined settlement physical task or attempt disagrees with domain state",
          );
        if (parentProgress !== undefined) {
          for (const criterion of parentCriteria) {
            const changed = parentProgress.find(
              (draft) =>
                draft.type === "project-work.criterion.upserted" &&
                draft.criterion.criterionId === criterion.criterionId,
            );
            yield* assertCriterion(
              value.row.project_id,
              changed?.type === "project-work.criterion.upserted" ? changed.criterion : criterion,
            );
          }
          for (const draft of parentProgress)
            if (draft.type === "project-work.evidence.added")
              yield* assertEvidence(value.row.project_id, draft.evidence);
          yield* assertInputs(value.row.project_id);
        }
        yield* assertProgressReceipt(value.row.project_id, state);
      });
      let reviewTargetSnapshot: ProjectTeamDispatchSnapshot | undefined;
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          const original = yield* read(expected.dispatchId);
          yield* readStageHistory(original.row, original.intent);
          yield* verify(receipt, { fence: fence(original.row), intent: original.intent });
          if (yield* isProjectWorkTombstoned(sql, original.row.project_id)) {
            settled = yield* advanceStage(expected, receipt);
            return [];
          }
          const state = yield* readCurrentState(sql, original.row.project_id);
          const records = state.foundationRecords ?? [];
          const binding = records.find(
            (r) => r.kind === "run-binding" && r.recordId === original.row.binding_id,
          );
          if (binding?.kind !== "run-binding" || binding.generation !== original.row.generation)
            return yield* deny("Original settlement binding is missing or replaced");
          if (binding.status === "settled") {
            settled = yield* advanceStage(expected, receipt);
            return [];
          }
          const task = state.tasks.find((t) => t.taskId === original.row.task_id);
          const attempt = state.attempts.find((a) => a.attemptId === original.row.attempt_id);
          if (task === undefined || attempt === undefined)
            return yield* deny("Original settlement task or attempt is missing");
          const reviewCompletion =
            prepareReviewCompletion === undefined
              ? undefined
              : yield* prepareReviewCompletion(
                  { fence: fence(original.row), intent: original.intent },
                  receipt,
                );
          const membership = state.foundationRecords?.filter(
            (record) => record.kind === "task-membership" && record.taskId === task.taskId,
          );
          const owner = state.foundationRecords?.find(
            (record) => record.kind === "member" && record.recordId === binding.memberId,
          );
          const mayReflectFailure =
            reviewCompletion === undefined &&
            task.state === "in-progress" &&
            task.activeAttemptId === attempt.attemptId &&
            (attempt.state === "leased" || attempt.state === "running") &&
            (binding.status === "running" || binding.status === "quarantined") &&
            membership?.length === 1 &&
            membership[0]?.kind === "task-membership" &&
            membership[0].status === "active" &&
            (membership[0].controlState === undefined || membership[0].controlState === "active") &&
            membership[0].requestedSuccessorMemberId === undefined &&
            owner?.kind === "member" &&
            owner.status === "active" &&
            !state.blockers.some(
              (blocker) => blocker.taskId === task.taskId && blocker.resolvedAt === undefined,
            );
          const failureEvidence =
            prepareFailure === undefined || !mayReflectFailure
              ? undefined
              : yield* prepareFailure(
                  { fence: fence(original.row), intent: original.intent },
                  receipt,
                );
          const failure =
            failureEvidence === undefined
              ? undefined
              : {
                  ...failureEvidence,
                  repairAllowance: Math.min(
                    original.intent.limits.repairAllowance,
                    original.intent.rootCaps.repairAllowance,
                  ),
                };
          if (
            reviewCompletion?.status === "completed" &&
            reviewCompletion.report.type === "project-team.assignment.report" &&
            reviewCompletion.report.criterionAssessments !== undefined
          ) {
            if (verifyReviewTarget === undefined)
              return yield* deny("Assessment settlement requires current target verification");
            reviewTargetSnapshot = { fence: fence(original.row), intent: original.intent };
          }
          settled = yield* advanceStage(expected, receipt);
          const at = time(yield* Clock.currentTimeMillis);
          const command: typeof ProjectWorkFoundationCommitCommand.Type = {
            type: "project-work.foundation.commit",
            projectId: original.intent.compiledClaim.projectId,
            commandId: CommandId.make(
              projectTeamDerivedRecordId(receipt.receiptId, "joined-domain"),
            ),
            expectedRevision: state.revision,
            attribution: {
              actor: { kind: "system", id: "project-team-runtime" },
              source: { kind: "system", id: "project-team-runtime" },
              recordedAt: at,
            },
            records: [],
            committedAt: at,
            transition: {
              kind: "run.settle",
              ...(reviewCompletion === undefined ? {} : { reviewCompletion }),
              ...(failure === undefined ? {} : { failure }),
              bindingId: binding.recordId,
              generation: binding.generation,
              expectedBindingRevision: binding.revision,
              taskId: task.taskId,
              expectedTaskRevision: task.revision,
              attemptId: attempt.attemptId,
              expectedAttemptRevision: attempt.revision,
              dispatchId: expected.dispatchId,
              receiptId: receipt.receiptId,
              ...(original.intent.writableReservationId === undefined
                ? {}
                : {
                    writableReservationId: original.intent.writableReservationId,
                  }),
              effectIds: records.flatMap((r) =>
                r.kind === "effect" &&
                r.runId === binding.recordId &&
                (r.effectKind === "dispatch" || r.effectKind === "stop") &&
                (r.status === "pending" || r.status === "claimed" || r.status === "uncertain")
                  ? [r.recordId]
                  : [],
              ),
            },
          };
          if (reviewCompletion?.status === "completed") {
            joinedFingerprint = projectWorkCommandFingerprint(command);
            parentProgress = yield* Effect.try({
              try: () =>
                prepareReviewCriterionProgress({
                  state,
                  completion: reviewCompletion,
                  settlementCommandId: joinedCommandId,
                  settlementCommandFingerprint: joinedFingerprint!,
                  at,
                }),
              catch: () => deny("Joined review parent progress cannot be prepared"),
            });
            const snapshots = reviewCompletion.parentAssessments?.snapshots ?? [];
            const criterionIds = new Set(snapshots.map((snapshot) => snapshot.criterion.id));
            parentCriteria = state.criteria.filter((criterion) =>
              criterionIds.has(criterion.criterionId),
            );
            const evidenceIds = new Set(
              snapshots.flatMap((snapshot) => snapshot.evidence.map((evidence) => evidence.id)),
            );
            verification = snapshots.length === 0 ? undefined : reviewCompletion.parentAssessments;
            const originalVerification = verification?.verification;
            if (originalVerification?.evidenceId !== undefined)
              evidenceIds.add(originalVerification.evidenceId);
            inputEvidence = state.evidence.filter((evidence) =>
              evidenceIds.has(evidence.evidenceId),
            );
            applicability =
              originalVerification?.applicabilityId === undefined
                ? undefined
                : state.foundationRecords?.find(
                    (
                      record,
                    ): record is Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> =>
                      record.kind === "evidence-applicability" &&
                      record.recordId === originalVerification.applicabilityId,
                  );
            for (const criterion of parentCriteria)
              yield* assertCriterion(original.row.project_id, criterion);
            yield* assertInputs(original.row.project_id);
          }
          return [command];
        }),
        assertDomainSettled.pipe(
          Effect.andThen(() =>
            reviewTargetSnapshot === undefined || verifyReviewTarget === undefined
              ? Effect.void
              : verifyReviewTarget(reviewTargetSnapshot, receipt),
          ),
        ),
      );
      if (settled === undefined)
        return yield* deny("Joined settlement returned no durable receipt");
      return settled;
    });
    return {
      reserve,
      inspect,
      claimEffect,
      readRetained,
      readHistoricalInTransaction,
      readRecoveryPage,
      readRecoveryCandidates,
      advanceStage,
      readStageReceipts,
      settleAfterJoined,
      claimCleanup,
    };
  },
);

/** Shared original joined-command audit. Current criterion revisions may legitimately invalidate old support. */
export const readCompletedReviewCommand = Effect.fn("ProjectTeamReviewCompleted.readCommand")(
  function* (input: {
    readonly sql: SqlClient.SqlClient;
    readonly projectId: string;
    readonly commandId: string;
    readonly dispatchId: string;
    readonly joinedReceiptId: string;
    readonly state: Effect.Success<ReturnType<typeof readCurrentState>>;
    readonly required: boolean;
    readonly expectedFingerprint?: string;
    readonly expectedDrafts?: readonly ReturnType<typeof prepareReviewCriterionProgress>[number][];
    readonly parentCriteria: readonly ProjectWorkCriterion[];
  }) {
    const { sql, projectId, commandId: joinedCommandId, state } = input;
    const rows = yield* sql<
      Record<string, unknown>
    >`SELECT * FROM project_work_events WHERE project_id=${projectId} AND command_id=${joinedCommandId} ORDER BY sequence LIMIT 513`;
    const commands = yield* sql<
      Record<string, unknown>
    >`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${joinedCommandId} LIMIT 2`;
    // Historical settlements with no joined command grant no progress.
    if (rows.length === 0 && commands.length === 0 && !input.required) return undefined;
    const command = commands[0];
    if (!command || commands.length !== 1 || rows.length === 0 || rows.length > 512)
      return yield* deny("Joined review command receipt is missing or ambiguous");
    const events = yield* Effect.try({
      try: () =>
        rows.map((row) => {
          const event = decodeProjectWorkEvent(JSON.parse(String(row.payload_json)));
          if (
            event.projectId !== projectId ||
            row.event_id !== event.eventId ||
            row.event_type !== event.type ||
            row.occurred_at !== event.occurredAt ||
            !Number.isSafeInteger(event.revision) ||
            event.revision <= 0 ||
            deadline(event.occurredAt) === undefined
          )
            throw new Error("Invalid retained joined event metadata");
          return event;
        }),
      catch: () => deny("Joined review retained events are invalid"),
    });
    const result = yield* decodeWriteResult(command.result_json).pipe(
      Effect.mapError(() => deny("Joined review command result is invalid")),
    );
    const ids = yield* decodeEventIds(command.event_ids_json).pipe(
      Effect.mapError(() => deny("Joined review command event IDs are invalid")),
    );
    const last = events[events.length - 1]!;
    if (
      command.actor_kind !== "system" ||
      command.actor_id !== "project-team-runtime" ||
      command.source_kind !== "system" ||
      command.source_id !== "project-team-runtime" ||
      typeof command.payload_fingerprint !== "string" ||
      !/^[a-f0-9]{8}$/.test(command.payload_fingerprint) ||
      (input.expectedFingerprint !== undefined &&
        command.payload_fingerprint !== input.expectedFingerprint) ||
      command.created_at !== events[0]!.occurredAt ||
      events.some(
        (event, i) =>
          event.revision !== last.revision - events.length + i + 1 ||
          event.occurredAt !== command.created_at,
      ) ||
      new Set(ids).size !== ids.length ||
      fingerprint(ids) !== fingerprint(events.map((event) => event.eventId)) ||
      result.projectId !== projectId ||
      result.revision !== last.revision ||
      result.receipt.commandId !== joinedCommandId ||
      result.receipt.projectId !== projectId ||
      result.receipt.status !== "accepted" ||
      result.receipt.revision !== last.revision ||
      result.receipt.eventCount !== events.length ||
      result.delta.projectId !== projectId ||
      result.delta.revision !== last.revision ||
      fingerprint(result.delta.eventIds) !== fingerprint(ids)
    )
      return yield* deny("Joined review command receipt disagrees with its original events");
    if (input.expectedDrafts !== undefined) {
      const observed = events
        .filter(
          (event) =>
            (event.type === "project-work.evidence.added" &&
              event.evidence.evidenceId.startsWith("review-criterion-progress:")) ||
            (event.type === "project-work.criterion.upserted" &&
              input.parentCriteria.some(
                (criterion) => criterion.criterionId === event.criterion.criterionId,
              )),
        )
        .map(
          ({ eventId: _eventId, projectId: _projectId, revision: _revision, ...draft }) => draft,
        );
      if (fingerprint(observed) !== fingerprint(input.expectedDrafts))
        return yield* deny("Joined review progress events differ from the prepared changes");
    }
    yield* Effect.try({
      try: () =>
        assertRetainedReviewCriterionProgress({
          state,
          events,
          settlement: {
            commandId: joinedCommandId,
            commandFingerprint: String(command.payload_fingerprint),
            dispatchId: input.dispatchId,
            joinedReceiptId: input.joinedReceiptId,
          },
        }),
      catch: () => deny("Joined review immutable progress provenance changed"),
    });
    return { events, result, commandFingerprint: String(command.payload_fingerprint) };
  },
);
