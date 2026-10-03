import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectTeamRecord as ProjectTeamRecordSchema,
  EnvironmentId,
  ProjectWorkTaskId,
  ProjectWorkFoundationCommitCommand,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assertProjectTeamRunAuthority, projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { isProjectWorkTombstoned } from "./ProjectTeamsPersistence.ts";
import { resolveProjectTeamLimits } from "./ProjectTeamLimits.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
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
const Intent = Schema.Struct({
  request: Request,
  compiledClaim: ProjectWorkFoundationCommitCommand,
  limits: Limits,
  rootCaps: RootCaps,
  writableReservationId: Schema.optionalKey(Id),
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
const decodeRecord = Schema.decodeUnknownEffect(ProjectTeamRecordSchema);
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent), strict);
const decodeRow = Schema.decodeUnknownEffect(RowSchema, strict);
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRecordSchema));
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(Intent));

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
const RecordedStage = Schema.Union([ForwardStage, Schema.Literals(["stopping", "quarantine"])]);
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
  function* (options: {
    readonly environmentId: string;
    readonly maximumEnvironmentModelCalls: number;
    /** Trusted Root checks actual retained Git/setup/native receipts. No client or worker predicate. */
    readonly verifyStage?: ProjectTeamDispatchStageVerifier;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const environmentId = yield* decodeEnvironment(options.environmentId);
    const environmentCalls = yield* decodeCalls(options.maximumEnvironmentModelCalls);
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
      return { row, intent };
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
      if (
        binding.taskId !== frozen.taskId ||
        binding.attemptId !== frozen.attemptId ||
        binding.threadId !== frozen.threadId ||
        binding.providerInstanceId !== frozen.providerInstanceId ||
        binding.worktree !== frozen.worktree ||
        binding.branch !== frozen.branch ||
        fingerprint(binding.configuration) !== fingerprint(frozen.configuration)
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
    const reserve = Effect.fn("ProjectTeamDispatchJournal.reserve")(function* (
      input: ProjectTeamDispatchRequest,
    ) {
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
          const compiledClaim: typeof ProjectWorkFoundationCommitCommand.Type = {
            ...request.claim,
            transition: {
              ...transition,
              binding: {
                ...binding,
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
          const intent: typeof Intent.Type = {
            request,
            compiledClaim,
            limits,
            rootCaps,
            ...(writable ? { writableReservationId: reservationId } : {}),
          };
          if (Buffer.byteLength(encodeIntent(intent)) > 262144)
            return yield* deny("Dispatch intent exceeds its storage bound");
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
        }),
      );
      if (!admitted) return yield* deny("Dispatch commit is missing");
      return { fence: fence(admitted.row), intent: admitted.intent };
    });
    const inspect = Effect.fn("ProjectTeamDispatchJournal.inspect")(function* (dispatchId: string) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(dispatchId);
          yield* current(value.row, value.intent);
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
        }),
      );
      if (!claimed) return yield* deny("Dispatch effect claim did not commit");
      return { fence: fence(claimed.row), intent: claimed.intent };
    });
    const readRetained = Effect.fn("ProjectTeamDispatchJournal.readRetained")(function* (
      dispatchId: string,
    ) {
      const value = yield* read(dispatchId);
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
        type RecoveryRow = { dispatch_id: string | null; row_id: string };
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
                const snapshot = yield* (
                  row.dispatch_id === null
                    ? Effect.fail(deny("Dispatch row identity is invalid"))
                    : readRetained(row.dispatch_id)
                ).pipe(Effect.exit);
                return { dispatchId: row.dispatch_id, position, snapshot };
              }),
            );
          }),
        );
      },
    );
    const readStageHistory = Effect.fn("ProjectTeamDispatchJournal.readStageHistory")(function* (
      dispatch: Row,
    ) {
      const rows = yield* sql`SELECT * FROM project_team_dispatch_receipt
        WHERE dispatch_id=${dispatch.dispatch_id} ORDER BY revision LIMIT 129`;
      if (rows.length > 128) return yield* deny("Retained stage history exceeds its bound");
      let stage: ProjectTeamDispatchStage = "reserved";
      let revision = dispatch.claim_generation;
      let recordedAt = deadline(dispatch.created_at)!;
      const updatedAt = deadline(dispatch.updated_at)!;
      const receipts = [];
      for (const raw of rows) {
        const row = yield* decodeStoredStageReceipt(raw).pipe(
          Effect.mapError(() => deny("Retained stage receipt is invalid")),
        );
        const timestamp = deadline(row.recorded_at);
        const cleanup = row.stage === "stopping" || row.stage === "quarantine";
        if (
          dispatch.claim_generation === 0 ||
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
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const value = yield* read(expected.dispatchId);
          const history = yield* readStageHistory(value.row);
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
            if (receipt.stage !== "stopping" && receipt.stage !== "quarantine")
              yield* current(value.row, value.intent);
            return { fence: fence(value.row), intent: value.intent, duplicate: true };
          }
          if (
            fingerprint(fence(value.row)) !== fingerprint(expected) ||
            value.row.claim_generation === 0
          )
            return yield* deny("Stage ownership fence is stale");
          const cleanup = receipt.stage === "stopping" || receipt.stage === "quarantine";
          if (
            value.row.stage === "settled" ||
            (!cleanup && nextForwardStage[value.row.stage] !== receipt.stage)
          )
            return yield* deny("Dispatch stage cannot advance out of order");
          if (!cleanup) yield* current(value.row, value.intent);
          if (history.length >= 128)
            return yield* deny("Retained stage history is full; cleanup requires attention");
          yield* verifyStage(receipt, { fence: fence(value.row), intent: value.intent });
          // Verification may await filesystem or native services; re-read committed history and authority.
          yield* readStageHistory(value.row);
          const authority = cleanup ? undefined : yield* current(value.row, value.intent);
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
          yield* readStageHistory({ ...value.row, revision, stage: receipt.stage, updated_at: at });
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
    });
    const readStageReceipts = Effect.fn("ProjectTeamDispatchJournal.readStageReceipts")(function* (
      dispatchId: string,
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          return yield* readStageHistory((yield* read(dispatchId)).row);
        }),
      );
    });
    return {
      reserve,
      inspect,
      claimEffect,
      readRetained,
      readRecoveryPage,
      readRecoveryCandidates,
      advanceStage,
      readStageReceipts,
    };
  },
);
