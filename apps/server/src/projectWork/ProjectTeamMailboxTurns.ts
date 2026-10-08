import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  CommandId,
  MessageId,
  ModelSelection,
  ManagedSkillKey,
  SkillCatalogRevision,
  SkillApplicationMode,
  ProjectId,
  ProjectTeamMessage,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProjectWorkAttemptId,
  ProjectWorkFoundationCommitCommand,
  ProviderInstanceId,
  ThreadId,
  IsoDateTime,
  projectWorkPayloadFingerprint,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type PiManagedOperationRequest,
  type PiManagedRuntimeError,
} from "../provider/pi/PiManagedRuntime.ts";
import { PiManagedProcessAllocationSchema } from "../provider/pi/PiManagedProcess.ts";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../provider/pi/PiWorkerProtocol.ts";
import { decodeProjectWorkEvent } from "./ProjectWorkEventStore.ts";
import {
  ProjectTeamAuthorization,
  ProjectTeamAuthorizationError,
  managedActorId,
} from "./ProjectTeamAuthorization.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamSessionReceipts } from "./ProjectTeamSessionReceipts.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { planMessageDelivery, applyMessageReceipt } from "./ProjectTeamMailboxPolicy.ts";
import type { makeProjectTeamPiOperations, PiCompactionAnchor } from "./ProjectTeamPiOperations.ts";
import { auditProjectMemoryOperationLedger } from "./memory/ProjectMemoryModelAccounting.ts";

export class ProjectTeamMailboxTurnsError extends Schema.TaggedError<ProjectTeamMailboxTurnsError>()(
  "ProjectTeamMailboxTurnsError",
  { reason: Schema.String },
) {}
class MailboxTurnPolicyDenied extends Schema.TaggedError<MailboxTurnPolicyDenied>()(
  "MailboxTurnPolicyDenied",
  { reason: Schema.String },
) {}
const isPolicyDenied = Schema.is(MailboxTurnPolicyDenied);
const isAuthorizationError = Schema.is(ProjectTeamAuthorizationError);
const isTurnsError = Schema.is(ProjectTeamMailboxTurnsError);
const policy = (reason: string) => new MailboxTurnPolicyDenied({ reason });
const currentPolicyDenied = (error: unknown) =>
  isPolicyDenied(error) ||
  (isAuthorizationError(error) &&
    [
      "Managed binding missing or changed",
      "Managed binding revoked, replaced or missing",
      "Managed member or frozen role is inactive",
      "Managed task ownership expired or changed",
      "Managed project unavailable",
      "Managed assignment or approval changed",
      "Managed project inactive",
    ].includes(error.reason));
const deny = (reason: string) => new ProjectTeamMailboxTurnsError({ reason });
const canonical = canonicalProjectWorkPayload;
const textHash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => textHash(canonical(value));
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\0]+$/),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const bounded = (limit: number) =>
  Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= limit));
const Limits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const RootBudget = Schema.Struct({ rootTaskId: Id, ...Limits.fields });
const Prompt = Schema.Struct({
  kind: Schema.Literal("prompt"),
  operationId: Id,
  threadId: ThreadId,
  prompt: bounded(65536),
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(bounded(4096)),
  modelSelection: Schema.optionalKey(ModelSelection),
  resumeCursor: Schema.optionalKey(Schema.NullOr(PiNativeReference)),
  skillPlan: Schema.optionalKey(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      desiredRevision: SkillCatalogRevision.check(
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
      applicationMode: SkillApplicationMode,
      skillKeys: Schema.Array(ManagedSkillKey).check(
        Schema.isMaxLength(32),
        Schema.makeFilter((keys) => new Set(keys).size === keys.length),
      ),
      payload: Schema.JsonObject,
    }),
  ),
});
const PreparedIntent = Schema.Struct({
  request: Prompt,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: PiManagedProcessAllocationSchema,
  rootBudget: RootBudget,
  operationLimits: Limits,
  resourceHash: Digest,
});
const Target = Schema.Struct({
  projectId: ProjectId,
  messageId: Id,
  messageRevision: Safe,
  runBindingRecordId: Id,
  attemptId: ProjectWorkAttemptId,
  bindingGeneration: Safe,
  leaseGeneration: Safe,
  deliveryGeneration: Safe,
  deliveryCursor: Positive,
});
const CompactAnchor = Schema.Struct({
  operationId: Id,
  operationOrdinal: Safe,
  receiptSha256: Digest,
  native: PiNativeReference,
});
const Common = {
  environmentId: Id,
  projectId: ProjectId,
  dispatchId: Id,
  bindingId: Id,
  generation: Safe,
  claimGeneration: Positive,
  fenceRevision: Safe,
  dispatchIntentSha256: Digest,
  boundaryRevision: Safe,
  originalAssignmentOperationId: Id,
  originalAssignmentReceiptSha256: Digest,
  binding: ProjectTeamRunBinding,
  rootBudget: RootBudget,
  attemptLimits: Limits,
  compactAnchor: Schema.optional(CompactAnchor),
};
const None = Schema.Struct({ kind: Schema.Literal("none"), ...Common });
const One = Schema.Struct({
  kind: Schema.Literal("one"),
  ...Common,
  message: ProjectTeamMessage,
  target: Target,
  request: Prompt,
  requestSha256: Digest,
  resourceHash: Digest,
  commandId: CommandId,
  userMessageId: MessageId,
});
const Predecessor = Schema.Struct({
  operationId: Id,
  operationOrdinal: Safe,
  decisionSha256: Digest,
  deliveryReceiptSha256: Digest,
  operationReceiptSha256: Digest,
  native: PiNativeReference,
});
const SuccessorFields = {
  version: Schema.Literal(2),
  turnIndex: Positive.check(Schema.isLessThanOrEqualTo(128)),
  predecessor: Predecessor,
};
const SuccessorNone = Schema.Struct({
  ...None.fields,
  ...SuccessorFields,
  stopReason: Schema.Literals(["empty", "chain-limit"]),
}).check(
  Schema.makeFilter((value) =>
    value.turnIndex === 128 ? value.stopReason === "chain-limit" : value.stopReason === "empty",
  ),
);
const SuccessorOne = Schema.Struct({ ...One.fields, ...SuccessorFields }).check(
  Schema.makeFilter((value) => value.turnIndex < 128),
);
const Selected = Schema.Union([One, SuccessorOne]);
const Successor = Schema.Union([SuccessorNone, SuccessorOne]);
const isSuccessor = Schema.is(Successor);
export const ProjectTeamMailboxTurnDecision = Schema.Union([
  None,
  One,
  SuccessorNone,
  SuccessorOne,
]);
export type ProjectTeamMailboxTurnDecision = typeof ProjectTeamMailboxTurnDecision.Type;
export type ProjectTeamSelectedMailboxTurn = typeof Selected.Type;
const DecisionRow = Schema.Struct({
  environment_id: Id,
  dispatch_id: Id,
  project_id: ProjectId,
  binding_id: Id,
  generation: Safe,
  decision_json: bounded(262144),
  decision_sha256: Digest,
  operation_id: Schema.NullOr(Id),
});
const SuccessorRow = Schema.Struct({
  ...DecisionRow.fields,
  predecessor_operation_id: Id,
  turn_index: Positive.check(Schema.isLessThanOrEqualTo(128)),
});
const OperationRow = Schema.Struct({
  operation_id: Id,
  operation_ordinal: Safe,
  environment_id: Id,
  project_id: ProjectId,
  binding_id: Id,
  generation: Safe,
  provider_instance_id: ProviderInstanceId,
  thread_id: ThreadId,
  worker_id: Id,
  request_hash: Digest,
  root_task_id: Id,
  maximum_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["prepared", "starting", "running", "settled", "quarantine"]),
  intent_json: bounded(1048576),
});
const SealInput = Schema.Struct({ operationId: Id, baseSystemText: bounded(65536) });
const BindInput = Schema.Struct({
  operationId: Id,
  reservationId: Id,
  encodedRequestSha256: Digest,
});
const ReflectInput = Schema.Struct({ operationId: Id });
const Terminal = Schema.Struct({
  identity: PiWorkerIdentity,
  operation: PiWorkerOperation,
  outcome: Schema.Literals(["success", "failed", "canceled", "quarantine"]),
  ownerCaptured: Schema.Boolean,
  native: Schema.NullOr(PiNativeReference),
  drain: Schema.NullOr(Schema.JsonObject),
  accountingReceipts: Schema.Array(Schema.JsonObject).check(Schema.isMaxLength(256)),
  failureCode: Schema.optionalKey(Id),
});
const ReflectionRow = Schema.Struct({
  operation_id: Id,
  phase: Schema.Literals(["uncertain", "delivered"]),
  command_json: bounded(262144),
  command_sha256: Digest,
  observation_sha256: Digest,
  observed_at: IsoDateTime,
  outcome_json: bounded(262144),
});
const Commands = Schema.Array(ProjectWorkFoundationCommitCommand).check(Schema.isMaxLength(1));
const Outcomes = Schema.Array(ProjectTeamMessage).check(Schema.isMaxLength(1));
const SealManifest = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("later"),
  decisionSha256: Digest,
  operationId: Id,
  environmentId: Id,
  projectId: ProjectId,
  dispatchId: Id,
  bindingId: Id,
  generation: Safe,
  claimGeneration: Positive,
  requestHash: Digest,
  workerId: Id,
  resourceHash: Digest,
  baseSystemTextSha256: Digest,
});
const BatchRow = Schema.Struct({
  operation_id: Id,
  batch_id: Id,
  environment_id: Id,
  project_id: ProjectId,
  dispatch_id: Id,
  binding_id: Id,
  generation: Safe,
  manifest_json: bounded(262144),
  manifest_sha256: Digest,
  system_text: bounded(65536),
  system_text_sha256: Digest,
  revision: Safe,
  status: Schema.Literals(["sealed", "uncertain", "delivered"]),
});
const BoundInput = Schema.Struct({
  reservation_id: Id,
  operation_id: Id,
  request_id: Positive,
  worker_id: Id,
  generation: Safe,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  system_text_sha256: Digest,
  encoded_request_sha256: Digest,
});
const ReservationFields = {
  workerId: Id,
  generation: Safe,
  operationId: Id,
  requestId: Positive,
  routeId: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
  callCount: Schema.Literal(1),
  deadlineAtMs: Positive,
};
const Reservation = Schema.Struct(ReservationFields);
const ReservationRow = Schema.Struct({
  reservation_id: Id,
  environment_id: Id,
  project_id: ProjectId,
  root_task_id: Id,
  run_id: Id,
  attempt_id: ProjectWorkAttemptId,
  worker_id: Id,
  generation: Safe,
  operation_id: Id,
  request_id: Positive,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  maximum_input_tokens: Positive,
  maximum_output_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["held", "reported", "failed", "unknown"]),
  capacity_state: Schema.Literals(["held", "released", "quarantine", "legacy"]),
  reservation_json: bounded(8192),
});
const SnapshotInput = Schema.Struct({
  fence: Schema.Struct({
    dispatchId: Id,
    revision: Safe,
    claimGeneration: Positive,
    stage: Schema.String,
  }),
  intent: Schema.JsonObject,
});
const ReadInput = Schema.Struct({
  projectId: ProjectId,
  bindingId: Id,
  generation: Safe,
  providerInstanceId: ProviderInstanceId,
  request: Schema.JsonObject,
});
const decodeDecision = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamMailboxTurnDecision),
  strict,
);
const decodeRow = Schema.decodeUnknownEffect(DecisionRow, strict);
const decodeSuccessorRow = Schema.decodeUnknownEffect(SuccessorRow, strict);
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedIntent), strict);
const exact = <A>(value: unknown, decode: (input: unknown) => A) => {
  const copy: unknown = structuredClone(value);
  const result = decode(copy);
  if (canonical(result) !== canonical(copy)) throw deny("Input differs from its strict capture");
  return result;
};
const immutableBinding = (binding: typeof ProjectTeamRunBinding.Type) => {
  const {
    revision: _,
    status: _status,
    updatedAt: _at,
    sessionId: _session,
    ...identity
  } = binding;
  return canonical(identity);
};
const derivedId = (kind: string, environmentId: string, dispatchId: string) =>
  `${kind}_${hash({ environmentId, dispatchId })}`;
const boundaryId = (
  kind: string,
  environmentId: string,
  dispatchId: string,
  predecessorOperationId?: string,
) =>
  predecessorOperationId === undefined
    ? derivedId(kind, environmentId, dispatchId)
    : `${kind}_${hash({ environmentId, dispatchId, predecessorOperationId })}`;
const decisionId = (kind: string, decision: ProjectTeamMailboxTurnDecision) =>
  boundaryId(
    kind,
    decision.environmentId,
    decision.dispatchId,
    isSuccessor(decision) ? decision.predecessor.operationId : undefined,
  );

type Operations = Effect.Success<ReturnType<typeof makeProjectTeamPiOperations>>;
export type ProjectTeamMailboxTurnOperationReceipt = NonNullable<
  Effect.Success<ReturnType<Operations["lookup"]>>
>;
export type ProjectTeamMailboxTurnDeliveryReceipt = {
  readonly operationId: string;
  readonly decisionSha256: string;
  readonly batchId: string;
  readonly observationSha256: string;
  readonly commandId: CommandId;
  readonly message: typeof ProjectTeamMessage.Type;
};
export type ProjectTeamMailboxTurnClaim =
  | { readonly _tag: "None"; readonly decision: typeof None.Type | typeof SuccessorNone.Type }
  | { readonly _tag: "Selected" | "Active" | "Uncertain"; readonly decision: typeof Selected.Type }
  | {
      readonly _tag: "Retained";
      readonly decision: typeof Selected.Type;
      readonly receipt: ProjectTeamMailboxTurnDeliveryReceipt;
    };
export type ProjectTeamMailboxTurnReflection =
  | { readonly _tag: "Pending" | "Uncertain" }
  | {
      readonly _tag: "Delivered" | "Retained";
      readonly receipt: ProjectTeamMailboxTurnDeliveryReceipt;
    };

const decodeId = Schema.decodeUnknownEffect(Id, strict);
const decodeNone = Schema.decodeUnknownEffect(None, strict);
const decodeOne = Schema.decodeUnknownEffect(One, strict);
const decodeSuccessorNone = Schema.decodeUnknownEffect(SuccessorNone, strict);
const decodeSuccessorOne = Schema.decodeUnknownEffect(SuccessorOne, strict);
const decodeOperationRow = Schema.decodeUnknownEffect(OperationRow, strict);
const decodeBatchRow = Schema.decodeUnknownEffect(BatchRow, strict);
const decodeSealManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SealManifest), strict);
const decodeUsage = Schema.decodeUnknownEffect(
  Schema.Struct({ root: Safe, attempt: Safe }),
  strict,
);
const decodeReservationRow = Schema.decodeUnknownEffect(ReservationRow, strict);
const decodeReservation = Schema.decodeUnknownEffect(Schema.fromJsonString(Reservation), strict);
const decodeBoundInput = Schema.decodeUnknownEffect(BoundInput, strict);
const decodeReflectionRow = Schema.decodeUnknownEffect(ReflectionRow, strict);
const decodeCommands = Schema.decodeUnknownEffect(Schema.fromJsonString(Commands), strict);
const decodeOutcomes = Schema.decodeUnknownEffect(Schema.fromJsonString(Outcomes), strict);
const decodeTerminal = Schema.decodeUnknownEffect(Schema.fromJsonString(Terminal), strict);
const decodeProjectTeamMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamMessage),
  strict,
);
const decodeEventPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));
const decodeProjectWorkFoundationCommitCommand = Schema.decodeUnknownEffect(
  ProjectWorkFoundationCommitCommand,
  strict,
);
const captureLocator = Schema.decodeUnknownSync(
  Schema.Struct({
    dispatchId: Schema.optionalKey(Id),
    operationId: Schema.optionalKey(Id),
    afterOperationId: Schema.optionalKey(Id),
  }),
  strict,
);
const captureBoundary = Schema.decodeUnknownSync(Schema.Struct({ afterOperationId: Id }), strict);
const captureHead = Schema.decodeUnknownSync(Schema.Struct({ dispatchId: Id }), strict);
const captureSnapshotInput = Schema.decodeUnknownSync(SnapshotInput, strict);
const captureReadInput = Schema.decodeUnknownSync(ReadInput, strict);
const captureSealInput = Schema.decodeUnknownSync(SealInput, strict);
const captureBindInput = Schema.decodeUnknownSync(BindInput, strict);
const captureReflectInput = Schema.decodeUnknownSync(ReflectInput, strict);
function makeMailboxTurnHistory(sql: SqlClient.SqlClient, environmentId: string) {
  const operation = Effect.fn("mailboxTurn.operation")(function* (decision: typeof Selected.Type) {
    const rows =
      yield* sql`SELECT operation_id,operation_ordinal,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,request_hash,root_task_id,maximum_tokens,deadline_at_ms,status,
      CASE WHEN length(CAST(intent_json AS BLOB)) <= 1048576 THEN intent_json ELSE NULL END AS intent_json
      FROM project_team_pi_operation WHERE operation_id=${decision.request.operationId} LIMIT 2`;
    if (rows.length !== 1) return yield* deny("Later operation is missing or ambiguous");
    const row = yield* decodeOperationRow(rows[0]).pipe(
      Effect.mapError(() => deny("Later operation columns are malformed")),
    );
    const intent = yield* decodeIntent(row.intent_json).pipe(
      Effect.mapError(() => deny("Later operation intent is malformed")),
    );
    if (
      row.environment_id !== environmentId ||
      row.project_id !== decision.projectId ||
      row.binding_id !== decision.bindingId ||
      row.generation !== decision.generation ||
      row.provider_instance_id !== decision.binding.providerInstanceId ||
      row.thread_id !== decision.request.threadId ||
      row.request_hash !== decision.requestSha256 ||
      canonical(intent.request) !== canonical(decision.request) ||
      row.intent_json !== canonical(intent) ||
      intent.resourceHash !== decision.resourceHash ||
      immutableBinding(intent.binding) !== immutableBinding(decision.binding) ||
      row.root_task_id !== decision.rootBudget.rootTaskId ||
      canonical(intent.rootBudget) !== canonical(decision.rootBudget) ||
      row.maximum_tokens !== intent.operationLimits.maximumTokens ||
      row.deadline_at_ms !== intent.operationLimits.deadlineAtMs ||
      row.maximum_tokens > decision.attemptLimits.maximumTokens ||
      row.deadline_at_ms > decision.attemptLimits.deadlineAtMs
    )
      return yield* deny("Later operation differs from its original selected identity");
    return { row, intent };
  });
  const batch = Effect.fn("mailboxTurn.batch")(function* (decision: typeof Selected.Type) {
    const rows =
      yield* sql`SELECT operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,
      CASE WHEN length(CAST(manifest_json AS BLOB)) <= 262144 THEN manifest_json ELSE NULL END AS manifest_json,manifest_sha256,
      CASE WHEN length(CAST(system_text AS BLOB)) <= 65536 THEN system_text ELSE NULL END AS system_text,system_text_sha256,revision,status
      FROM project_team_mailbox_batch WHERE operation_id=${decision.request.operationId} LIMIT 2`;
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) return yield* deny("Later seal is ambiguous");
    const row = yield* decodeBatchRow(rows[0]).pipe(
      Effect.mapError(() => deny("Later seal columns are malformed")),
    );
    const manifest = yield* decodeSealManifest(row.manifest_json).pipe(
      Effect.mapError(() => deny("Later seal manifest is malformed")),
    );
    if (
      canonical(manifest) !== row.manifest_json ||
      textHash(row.manifest_json) !== row.manifest_sha256 ||
      textHash(row.system_text) !== row.system_text_sha256 ||
      manifest.decisionSha256 !== hash(decision) ||
      manifest.operationId !== decision.request.operationId ||
      manifest.environmentId !== environmentId ||
      manifest.projectId !== decision.projectId ||
      manifest.dispatchId !== decision.dispatchId ||
      manifest.bindingId !== decision.bindingId ||
      manifest.generation !== decision.generation ||
      manifest.claimGeneration !== decision.claimGeneration ||
      manifest.requestHash !== decision.requestSha256 ||
      manifest.resourceHash !== decision.resourceHash ||
      row.operation_id !== manifest.operationId ||
      row.environment_id !== manifest.environmentId ||
      row.project_id !== manifest.projectId ||
      row.dispatch_id !== manifest.dispatchId ||
      row.binding_id !== manifest.bindingId ||
      row.generation !== manifest.generation
    )
      return yield* deny("Later seal digest or identity differs");
    return { row, manifest };
  });
  const reflectionPhase = Effect.fn("mailboxTurn.reflectionPhase")(function* (
    operationId: string,
    status: "uncertain" | "delivered",
  ) {
    const rows =
      yield* sql`SELECT operation_id,phase,CASE WHEN length(CAST(command_json AS BLOB))<=262144 THEN command_json ELSE NULL END AS command_json,
      command_sha256,observation_sha256,observed_at,CASE WHEN length(CAST(outcome_json AS BLOB))<=262144 THEN outcome_json ELSE NULL END AS outcome_json
      FROM project_team_mailbox_reflection WHERE operation_id=${operationId} AND phase=${status} LIMIT 2`;
    if (!rows.length) return undefined;
    if (rows.length !== 1) return yield* deny("Later reflection is ambiguous");
    const row = yield* decodeReflectionRow(rows[0]);
    const commands = yield* decodeCommands(row.command_json);
    const outcomes = yield* decodeOutcomes(row.outcome_json);
    if (
      row.operation_id !== operationId ||
      row.phase !== status ||
      canonical(commands) !== row.command_json ||
      canonical(outcomes) !== row.outcome_json ||
      hash(commands) !== row.command_sha256 ||
      commands.length !== 1 ||
      outcomes.length !== 1
    )
      return yield* deny("Later reflection integrity differs");
    const message = outcomes[0];
    if (!message) return yield* deny("Later retained outcome is missing");
    return { row, commands, message };
  });
  const observation = Effect.fn("mailboxTurn.observation")(function* (
    decision: typeof Selected.Type,
  ) {
    const op = yield* operation(decision);
    const rows = yield* sql<{ terminal_json: string | null; native_json: string | null }>`SELECT
      CASE WHEN length(CAST(terminal_json AS BLOB))<=262144 THEN terminal_json ELSE NULL END AS terminal_json,
      CASE WHEN length(CAST(native_json AS BLOB))<=4096 THEN native_json ELSE NULL END AS native_json
      FROM project_team_pi_operation WHERE operation_id=${decision.request.operationId} LIMIT 2`;
    if (rows.length !== 1 || !rows[0]?.terminal_json)
      return yield* deny("Later terminal observation is missing");
    const terminal = yield* decodeTerminal(rows[0].terminal_json);
    if (
      canonical(terminal) !== rows[0].terminal_json ||
      terminal.operation.operationId !== decision.request.operationId ||
      terminal.operation.operationKind !== "prompt" ||
      terminal.identity.workerId !== op.row.worker_id ||
      terminal.identity.generation !== decision.generation
    )
      return yield* deny("Later terminal identity differs");
    const processes =
      yield* sql`SELECT operation_id,unit,allocation_json,status,owner_json,drain_json FROM project_team_pi_process WHERE operation_id=${decision.request.operationId} LIMIT 2`;
    if (processes.length !== 1) return yield* deny("Later physical process is ambiguous");
    const memoryLedger = yield* auditProjectMemoryOperationLedger(sql, {
      environmentId: decision.environmentId,
      projectId: decision.projectId,
      bindingId: decision.bindingId,
      generation: decision.generation,
      operationId: decision.request.operationId,
    });
    if (!memoryLedger.settled)
      return yield* deny("Later memory model transport is not settled and drained");
    const accounting =
      yield* sql`SELECT reservation_id,status,capacity_state,settlement_json,accounting_receipt_id FROM project_team_model_request WHERE operation_id=${decision.request.operationId} ORDER BY request_id LIMIT 257`;
    if (accounting.length > 256) return yield* deny("Later accounting exceeds its bound");
    const inputs =
      yield* sql`SELECT reservation_id,operation_id,request_id,worker_id,generation,route_id,provider,model,system_text_sha256,encoded_request_sha256 FROM project_team_mailbox_input WHERE operation_id=${decision.request.operationId} ORDER BY request_id LIMIT 257`;
    if (inputs.length > 256) return yield* deny("Later inputs exceed their bound");
    const checkedInputs = yield* Effect.forEach(inputs, (row) => decodeBoundInput(row));
    return {
      op,
      terminal,
      sha256: hash({
        status: op.row.status,
        terminal,
        nativeJson: rows[0].native_json,
        process: processes[0],
        accounting,
        inputs: checkedInputs,
      }),
    };
  });
  const physicalMessage = Effect.fn("mailboxTurn.physicalMessage")(function* (
    message: typeof ProjectTeamMessage.Type,
  ) {
    const rows =
      yield* sql`SELECT record_id,project_id,status,revision,generation,updated_at,task_id,attempt_id,member_id,source_id,scope_key,slot,unique_key,provider_instance_id,thread_id,session_id,
      CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS payload_json FROM project_team_message WHERE record_id=${message.recordId} AND project_id=${message.projectId} LIMIT 2`;
    if (rows.length !== 1 || !rows[0]) return yield* deny("Later physical message is missing");
    const row = rows[0];
    const payload = yield* decodeProjectTeamMessage(row.payload_json);
    const { payload_json: _, ...columns } = row;
    const expected = {
      record_id: message.recordId,
      project_id: message.projectId,
      status: message.status,
      revision: message.revision,
      generation: message.generation,
      updated_at: message.updatedAt,
      task_id: message.taskId ?? null,
      attempt_id: null,
      member_id: null,
      source_id: null,
      scope_key: null,
      slot: null,
      unique_key: message.commandId,
      provider_instance_id: null,
      thread_id: null,
      session_id: null,
    };
    if (canonical(payload) !== canonical(message) || canonical(columns) !== canonical(expected))
      return yield* deny("Later physical message write was skipped or changed");
  });
  const verifyPhase = Effect.fn("mailboxTurn.verifyPhase")(function* (
    decision: typeof Selected.Type,
    saved: NonNullable<Effect.Success<ReturnType<typeof reflectionPhase>>>,
    previous?: NonNullable<Effect.Success<ReturnType<typeof reflectionPhase>>>,
  ) {
    const prior = previous?.message ?? decision.message;
    const expected = {
      ...prior,
      revision: prior.revision + 1,
      status: saved.row.phase,
      updatedAt: saved.row.observed_at,
      deliveryGeneration: decision.target.deliveryGeneration,
      deliveryCursor: decision.target.deliveryCursor,
    };
    if (canonical(saved.message) !== canonical(expected))
      return yield* deny("Later retained outcome differs");
    const command = saved.commands[0];
    const attribution = {
      actor: { kind: "system", id: "project-team-mailbox-turns" },
      source: { kind: "system", id: "project-team-mailbox-turns" },
      recordedAt: saved.row.observed_at,
    };
    if (
      !command ||
      command.commandId !==
        derivedId(`mailbox-${saved.row.phase}`, environmentId, decision.request.operationId) ||
      command.projectId !== decision.projectId ||
      command.committedAt !== saved.row.observed_at ||
      canonical(command.attribution) !== canonical(attribution) ||
      canonical(command.records) !== canonical([saved.message]) ||
      command.guided !== undefined ||
      command.transition !== undefined
    )
      return yield* deny("Later retained command differs");
    const receipts = yield* sql<{
      payload_fingerprint: string;
    }>`SELECT payload_fingerprint FROM project_work_command_receipts WHERE project_id=${decision.projectId} AND command_id=${command.commandId} LIMIT 2`;
    if (
      receipts.length !== 1 ||
      receipts[0]?.payload_fingerprint !==
        projectWorkPayloadFingerprint({
          ...command,
          attribution: { actor: attribution.actor, source: attribution.source },
        })
    )
      return yield* deny("Later command receipt differs");
    const events = yield* sql<{
      payload_json: string;
    }>`SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json ELSE NULL END AS payload_json FROM project_work_events WHERE project_id=${decision.projectId} AND command_id=${command.commandId} ORDER BY sequence LIMIT 2`;
    if (events.length !== 1 || !events[0]) return yield* deny("Later delivery event is missing");
    const payload = yield* decodeEventPayload(events[0].payload_json);
    const event = yield* Effect.try({
      try: () => decodeProjectWorkEvent(payload),
      catch: () => deny("Later delivery event is invalid"),
    });
    if (
      event.type !== "project-work.foundation.recorded" ||
      canonical(event.record) !== canonical(saved.message)
    )
      return yield* deny("Later delivery event differs");
  });
  const historical = Effect.fn("mailboxTurn.historical")(function* (
    decision: typeof Selected.Type,
    sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
    saved: NonNullable<Effect.Success<ReturnType<typeof reflectionPhase>>>,
    uncertain: Effect.Success<ReturnType<typeof reflectionPhase>>,
  ) {
    if (sealed.row.status !== "delivered" || sealed.row.revision !== (uncertain ? 2 : 1))
      return yield* deny("Later delivery phase differs");
    if (uncertain) yield* verifyPhase(decision, uncertain);
    yield* verifyPhase(decision, saved, uncertain);
    const observed = yield* observation(decision);
    if (
      observed.op.row.status !== "settled" ||
      observed.terminal.outcome !== "success" ||
      saved.row.observation_sha256 !== observed.sha256
    )
      return yield* deny("Later successful observation changed");
    const state = yield* readCurrentState(sql, decision.projectId);
    const matches =
      state.foundationRecords?.filter(
        (r) => r.kind === "message" && r.recordId === decision.message.recordId,
      ) ?? [];
    const value = matches[0];
    if (
      matches.length !== 1 ||
      value?.kind !== "message" ||
      value.revision < saved.message.revision ||
      !["delivered", "acknowledged", "resolved"].includes(value.status)
    )
      return yield* deny("Later delivery history changed");
    const immutable = (message: typeof ProjectTeamMessage.Type) => {
      const {
        revision: _,
        status: _s,
        updatedAt: _at,
        acknowledgedAt: _ack,
        resolvedAt: _res,
        ...rest
      } = message;
      return canonical(rest);
    };
    if (immutable(value) !== immutable(saved.message))
      return yield* deny("Later delivered message identity changed");
    yield* physicalMessage(value);
    return {
      operationId: decision.request.operationId,
      decisionSha256: hash(decision),
      batchId: sealed.row.batch_id,
      observationSha256: observed.sha256,
      commandId: (yield* decodeProjectWorkFoundationCommitCommand(saved.commands[0])).commandId,
      message: saved.message,
    };
  });
  return {
    operation,
    batch,
    reflectionPhase,
    observation,
    physicalMessage,
    verifyPhase,
    historical,
  };
}

/** Strict retained association only; callers separately derive current authority. */
export const makeProjectTeamMailboxTurnDecisionReader = Effect.fn(
  "makeProjectTeamMailboxTurnDecisionReader",
)(function* (options: { readonly environmentId: string }) {
  const environmentId = yield* decodeId(options.environmentId);
  const sql = yield* SqlClient.SqlClient;
  const receipts = yield* makeProjectTeamSessionReceipts({
    environmentId,
    maximumEnvironmentModelCalls: 128,
  });
  const readInside = Effect.fn("mailboxTurn.readInside")(function* (input: {
    readonly dispatchId?: string;
    readonly operationId?: string;
    readonly afterOperationId?: string;
  }) {
    const current = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (
      Option.isNone(current) ||
      current.value !== sql ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* deny("Mailbox decision requires its captured SQL transaction");
    if (
      (input.dispatchId === undefined) === (input.operationId === undefined) ||
      (input.afterOperationId !== undefined && input.dispatchId === undefined)
    )
      return yield* deny("Decision locator is ambiguous");
    const selected = input.operationId !== undefined;
    const legacy =
      selected || input.afterOperationId === undefined
        ? yield* sql`SELECT environment_id,dispatch_id,project_id,binding_id,generation,
        CASE WHEN length(CAST(decision_json AS BLOB)) <= 262144 THEN decision_json ELSE NULL END AS decision_json,
        decision_sha256,operation_id FROM project_team_mailbox_turn WHERE environment_id=${environmentId}
        AND ${selected ? sql`operation_id=${input.operationId}` : sql`dispatch_id=${input.dispatchId}`} LIMIT 2`
        : [];
    const successors =
      selected || input.afterOperationId !== undefined
        ? yield* sql`SELECT environment_id,dispatch_id,project_id,binding_id,generation,predecessor_operation_id,turn_index,
        CASE WHEN length(CAST(decision_json AS BLOB)) <= 262144 THEN decision_json ELSE NULL END AS decision_json,
        decision_sha256,operation_id FROM project_team_mailbox_successor WHERE environment_id=${environmentId}
        AND ${selected ? sql`operation_id=${input.operationId}` : sql`dispatch_id=${input.dispatchId} AND predecessor_operation_id=${input.afterOperationId}`} LIMIT 2`
        : [];
    const rows = [...legacy, ...successors];
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) return yield* deny("Mailbox decision is ambiguous");
    const row = yield* (legacy.length ? decodeRow(rows[0]) : decodeSuccessorRow(rows[0])).pipe(
      Effect.mapError(() => deny("Mailbox decision columns are malformed")),
    );
    const decision = yield* decodeDecision(row.decision_json).pipe(
      Effect.mapError(() => deny("Mailbox decision is malformed")),
    );
    if (
      canonical(decision) !== row.decision_json ||
      textHash(row.decision_json) !== row.decision_sha256 ||
      decision.environmentId !== row.environment_id ||
      decision.dispatchId !== row.dispatch_id ||
      decision.projectId !== row.project_id ||
      decision.bindingId !== row.binding_id ||
      decision.generation !== row.generation ||
      decision.binding.recordId !== decision.bindingId ||
      decision.binding.environmentId !== environmentId ||
      decision.binding.projectId !== decision.projectId ||
      decision.binding.generation !== decision.generation ||
      (isSuccessor(decision)
        ? !("predecessor_operation_id" in row) ||
          !("turn_index" in row) ||
          row.predecessor_operation_id !== decision.predecessor.operationId ||
          row.turn_index !== decision.turnIndex
        : "predecessor_operation_id" in row) ||
      (decision.kind === "none"
        ? row.operation_id !== null
        : row.operation_id !== decision.request.operationId ||
          hash(decision.request) !== decision.requestSha256)
    )
      return yield* deny("Mailbox decision identity or digest differs");
    if (
      decision.kind === "one" &&
      (decision.message.projectId !== decision.projectId ||
        decision.message.status !== "queued" ||
        decision.message.recipientId !== decision.binding.memberId ||
        decision.target.projectId !== decision.projectId ||
        decision.target.messageId !== decision.message.recordId ||
        decision.target.messageRevision !== decision.message.revision ||
        decision.target.runBindingRecordId !== decision.bindingId ||
        decision.target.bindingGeneration !== decision.generation ||
        decision.target.attemptId !== decision.binding.attemptId ||
        decision.request.threadId !== decision.binding.threadId ||
        decision.request.operationId !== decisionId("mailbox-turn", decision) ||
        decision.commandId !== decisionId("mailbox-turn-command", decision) ||
        decision.userMessageId !== decisionId("mailbox-turn-message", decision))
    )
      return yield* deny("Mailbox decision selected identity differs");
    return decision;
  });
  const readInTransaction = (input: {
    readonly dispatchId?: string;
    readonly operationId?: string;
    readonly afterOperationId?: string;
  }) => {
    try {
      return readInside(exact(input, captureLocator));
    } catch {
      return Effect.fail(deny("Mailbox decision locator is invalid"));
    }
  };
  const history = makeMailboxTurnHistory(sql, environmentId);
  const readPredecessorInTransaction = Effect.fn("mailboxTurn.readPredecessorInTransaction")(
    function* (operationId: string) {
      const decision = yield* readInTransaction({ operationId });
      if (!decision || decision.kind !== "one")
        return yield* deny("Predecessor has no selected mailbox decision");
      const sealed = yield* history.batch(decision);
      const delivered = yield* history.reflectionPhase(operationId, "delivered");
      if (!sealed || !delivered)
        return yield* deny("Predecessor has no committed successful mailbox delivery");
      const receipt = yield* history.historical(
        decision,
        sealed,
        delivered,
        yield* history.reflectionPhase(operationId, "uncertain"),
      );
      const observed = yield* history.observation(decision);
      const native = observed.terminal.native;
      if (
        !native ||
        !observed.terminal.ownerCaptured ||
        !observed.terminal.drain ||
        observed.terminal.failureCode !== undefined
      )
        return yield* deny("Predecessor successful ownership is incomplete");
      return {
        decision,
        receipt,
        operationOrdinal: observed.op.row.operation_ordinal,
        native,
        operationReceiptSha256: hash({
          operation: observed.terminal.operation,
          terminal: observed.terminal,
          native,
        }),
      };
    },
  );
  // Construct the receipt reader only at use; its own mailbox reader does not recursively
  // construct an operation service. Historical reads never reopen a stored boundary.
  const compactClock = yield* Effect.serviceOption(Clock.Clock);
  const compactAuthorization = yield* Effect.serviceOption(ProjectTeamAuthorization);
  const compactRepository = yield* Effect.serviceOption(ProjectWorkRepository);
  const loadCompactOperations: () => Effect.Effect<
    {
      readCompactionAnchorInTransaction: (
        identity: { readonly providerInstanceId: ProviderInstanceId; readonly threadId: ThreadId },
        afterOperationId: string,
        throughOperationId?: string,
      ) => Effect.Effect<PiCompactionAnchor | undefined, PiManagedRuntimeError>;
    },
    ProjectTeamMailboxTurnsError
  > = Effect.fn("mailboxTurn.loadCompactOperations")(
    function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService)) ||
        Option.isNone(compactClock) ||
        Option.isNone(compactAuthorization) ||
        Option.isNone(compactRepository)
      )
        return yield* deny("Mailbox compaction anchor is unavailable");
      const { makeProjectTeamPiOperations } = yield* Effect.promise(
        () => import("./ProjectTeamPiOperations.ts"),
      );
      return yield* makeProjectTeamPiOperations({ environmentId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Clock.Clock, compactClock.value),
        Effect.provideService(ProjectTeamAuthorization, compactAuthorization.value),
        Effect.provideService(ProjectWorkRepository, compactRepository.value),
      );
    },
    Effect.mapError(() => deny("Mailbox compaction anchor is unavailable")),
  );
  const compactOperations = yield* Effect.cached(loadCompactOperations());
  const verifyCompactAnchor: (
    decision: ProjectTeamMailboxTurnDecision,
    afterOperationId: string,
  ) => Effect.Effect<void, ProjectTeamMailboxTurnsError> = (decision, afterOperationId) =>
    Effect.gen(function* () {
      if (!decision.compactAnchor) return;
      const operations = yield* compactOperations;
      const anchor = yield* operations.readCompactionAnchorInTransaction(
        {
          providerInstanceId: decision.binding.providerInstanceId,
          threadId: decision.binding.threadId,
        },
        afterOperationId,
        decision.compactAnchor.operationId,
      );
      if (canonical(anchor) !== canonical(decision.compactAnchor))
        return yield* deny("Mailbox compaction anchor receipt differs");
    }).pipe(Effect.mapError(() => deny("Mailbox compaction anchor is unavailable")));
  const verifyOriginalInTransaction = Effect.fn("mailboxTurn.verifyOriginalInTransaction")(
    function* (snapshot: ProjectTeamDispatchSnapshot, decision: ProjectTeamMailboxTurnDecision) {
      const receipt = yield* receipts.readAssignment(snapshot);
      if (!receipt) return yield* deny("Original assignment receipt is missing");
      const transition = snapshot.intent.compiledClaim.transition;
      let checked = decision;
      for (let count = 0; count <= 128; count++) {
        const saved = yield* readInTransaction(
          isSuccessor(checked)
            ? {
                dispatchId: snapshot.fence.dispatchId,
                afterOperationId: checked.predecessor.operationId,
              }
            : { dispatchId: snapshot.fence.dispatchId },
        );
        if (
          !saved ||
          canonical(saved) !== canonical(checked) ||
          checked.dispatchIntentSha256 !== hash(snapshot.intent) ||
          checked.claimGeneration !== snapshot.fence.claimGeneration ||
          checked.fenceRevision !== snapshot.fence.revision ||
          checked.originalAssignmentOperationId !== receipt.operation.operationId ||
          checked.originalAssignmentReceiptSha256 !== hash(receipt) ||
          transition?.kind !== "claim" ||
          immutableBinding(transition.binding) !== immutableBinding(checked.binding) ||
          canonical(checked.rootBudget) !==
            canonical({
              rootTaskId: snapshot.intent.limits.rootTaskId,
              maximumTokens: snapshot.intent.limits.maximumTokens,
              deadlineAtMs: snapshot.intent.limits.rootDeadlineAtMs,
            }) ||
          canonical(checked.attemptLimits) !==
            canonical({
              maximumTokens: snapshot.intent.limits.attemptMaximumTokens,
              deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
            }) ||
          (checked.kind === "one" && checked.resourceHash !== receipt.resourceHash)
        )
          return yield* deny("Original mailbox fence, scope or budget differs");
        if (!isSuccessor(checked)) {
          yield* verifyCompactAnchor(checked, receipt.operation.operationId);
          if (
            checked.kind === "one" &&
            canonical(checked.request.resumeCursor) !==
              canonical(checked.compactAnchor?.native ?? receipt.native)
          )
            return yield* deny("Original mailbox native reference differs");
          return;
        }
        const previous = yield* readPredecessorInTransaction(checked.predecessor.operationId);
        yield* verifyCompactAnchor(checked, previous.decision.request.operationId);
        if (
          checked.turnIndex !==
            (isSuccessor(previous.decision) ? previous.decision.turnIndex + 1 : 1) ||
          checked.predecessor.decisionSha256 !== hash(previous.decision) ||
          checked.predecessor.deliveryReceiptSha256 !== hash(previous.receipt) ||
          checked.predecessor.operationReceiptSha256 !== previous.operationReceiptSha256 ||
          checked.predecessor.operationOrdinal !== previous.operationOrdinal ||
          canonical(checked.predecessor.native) !== canonical(previous.native) ||
          (checked.kind === "one" &&
            canonical(checked.request.resumeCursor) !==
              canonical(checked.compactAnchor?.native ?? previous.native))
        )
          return yield* deny("Mailbox predecessor receipt differs");
        checked = previous.decision;
      }
      return yield* deny("Mailbox chain exceeds its boundary limit");
    },
  );
  const readHeadInside = Effect.fn("mailboxTurn.readHeadInside")(function* (dispatchId: string) {
    let head = yield* readInTransaction({ dispatchId });
    const rows = yield* sql<{
      predecessor_operation_id: string;
      turn_index: number;
    }>`SELECT predecessor_operation_id,turn_index
      FROM project_team_mailbox_successor WHERE environment_id=${environmentId} AND dispatch_id=${dispatchId} ORDER BY turn_index LIMIT 129`;
    if (rows.length > 128) return yield* deny("Mailbox chain exceeds its boundary limit");
    for (const [index, row] of rows.entries()) {
      if (
        !head ||
        head.kind !== "one" ||
        row.turn_index !== index + 1 ||
        row.predecessor_operation_id !== head.request.operationId
      )
        return yield* deny("Mailbox chain is missing, forked or follows a terminal decision");
      const next = yield* readInTransaction({
        dispatchId,
        afterOperationId: head.request.operationId,
      });
      if (!next || !isSuccessor(next) || next.predecessor.decisionSha256 !== hash(head))
        return yield* deny("Mailbox successor identity differs");
      head = next;
    }
    return head;
  });
  const readHeadInTransaction = (input: { readonly dispatchId: string }) => {
    try {
      return readHeadInside(exact(input, captureHead).dispatchId);
    } catch {
      return Effect.fail(deny("Mailbox head locator is invalid"));
    }
  };
  return {
    readInTransaction,
    readHeadInTransaction,
    readPredecessorInTransaction,
    verifyOriginalInTransaction,
  };
});

/** One committed boundary decision; delivery grants no acknowledgment, completion or new scope. */
export const makeProjectTeamMailboxTurns = Effect.fn("makeProjectTeamMailboxTurns")(
  function* (options: {
    readonly environmentId: string;
    readonly lookupInTransaction: Operations["lookupInTransaction"];
  }) {
    const environmentId = yield* decodeId(options.environmentId);
    const lookupInTransaction = options.lookupInTransaction;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectTeamAuthorization;
    const reader = yield* makeProjectTeamMailboxTurnDecisionReader({ environmentId });
    const {
      operation,
      batch,
      reflectionPhase,
      observation,
      physicalMessage,
      verifyPhase,
      historical,
    } = makeMailboxTurnHistory(sql, environmentId);
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const sessions = yield* makeProjectTeamSessionReceipts({
      environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const ownGuard = Effect.gen(function* () {
      const current = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(current) ||
        current.value !== sql ||
        Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Mailbox turn must own its captured SQL transaction");
    });
    const own = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      ownGuard.pipe(
        Effect.andThen(
          sql.withTransaction(body.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
        ),
      );
    const originalBinding = (snapshot: ProjectTeamDispatchSnapshot) => {
      const claim = snapshot.intent.compiledClaim.transition;
      if (claim?.kind !== "claim") throw deny("Original dispatch claim is missing");
      return claim.binding;
    };
    const current = Effect.fn("mailboxTurn.current")(function* (
      original: ProjectTeamDispatchSnapshot,
    ) {
      const binding = originalBinding(original);
      const credential = yield* authorization.discover({
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
      });
      if (
        !credential ||
        credential.bindingId !== binding.recordId ||
        credential.generation !== binding.generation ||
        credential.projectId !== binding.projectId
      )
        return yield* policy("Original mailbox owner was replaced");
      const authority = yield* authorization.resolve({
        actor: { kind: "agent", id: managedActorId(credential) },
        managed: credential,
      });
      if (
        !authority ||
        immutableBinding(authority.binding) !== immutableBinding(binding) ||
        !authority.binding.sessionId
      )
        return yield* policy("Mailbox authority changed");
      const records = authority.state.foundationRecords ?? [];
      const members = records.filter((r) => r.kind === "member" && r.recordId === binding.memberId);
      const memberships = records.filter(
        (r) => r.kind === "task-membership" && r.taskId === binding.taskId,
      );
      const tasks = authority.state.tasks.filter((t) => t.taskId === binding.taskId);
      const member = members[0],
        taskMembership = memberships[0],
        task = tasks[0];
      if (
        members.length !== 1 ||
        member?.kind !== "member" ||
        memberships.length !== 1 ||
        taskMembership?.kind !== "task-membership" ||
        tasks.length !== 1 ||
        !task ||
        task.state !== "in-progress"
      )
        return yield* policy("Mailbox recipient is missing or ambiguous");
      const now = yield* Clock.currentTimeMillis;
      if (
        now >=
        Math.min(original.intent.limits.deadlineAtMs, original.intent.limits.rootDeadlineAtMs)
      )
        return yield* policy("Original mailbox deadline expired");
      return {
        authority,
        recipient: { member, runBinding: authority.binding, taskMembership, task },
      };
    });
    const claimInside = Effect.fn("mailboxTurn.claimInside")(function* (
      captured: typeof SnapshotInput.Type,
      boundary?: { readonly afterOperationId: string },
    ) {
      const original = yield* journal.readRetained(captured.fence.dispatchId);
      if (canonical(original) !== canonical(captured))
        return yield* deny("Original boundary snapshot differs");
      const locator =
        boundary === undefined
          ? { dispatchId: original.fence.dispatchId }
          : { dispatchId: original.fence.dispatchId, afterOperationId: boundary.afterOperationId };
      const prior = yield* reader.readInTransaction(locator);
      if (prior) return yield* classify(prior);
      if (original.fence.stage !== "assignment-observed")
        return yield* deny(
          "A later turn requires the first observed successful assignment boundary",
        );
      yield* journal.inspect(original.fence.dispatchId, { requireClaim: true });
      const receipt = yield* sessions.readAssignment(original);
      if (!receipt) return yield* deny("Original assignment receipt is missing");
      const predecessor =
        boundary === undefined
          ? undefined
          : yield* reader.readPredecessorInTransaction(boundary.afterOperationId);
      let compactAnchor: typeof CompactAnchor.Type | undefined;
      if (predecessor) {
        const head = yield* reader.readHeadInTransaction({ dispatchId: original.fence.dispatchId });
        if (canonical(head) !== canonical(predecessor.decision))
          return yield* deny("Requested predecessor is not the original mailbox head");
        yield* reader.verifyOriginalInTransaction(original, predecessor.decision);
        const fresh = yield* lookupInTransaction(
          {
            providerInstanceId: predecessor.decision.binding.providerInstanceId,
            threadId: predecessor.decision.binding.threadId,
          },
          predecessor.decision.request,
          predecessor.decision.requestSha256,
          predecessor.decision.resourceHash,
        );
        if (
          !fresh ||
          hash({ operation: fresh.operation, terminal: fresh.terminal, native: fresh.native }) !==
            predecessor.operationReceiptSha256
        )
          return yield* deny("Predecessor is not the current qualified successful operation");
        compactAnchor = fresh.compactionAnchor;
      } else {
        const newer = yield* sql`SELECT operation_id FROM project_team_pi_operation
          WHERE environment_id=${environmentId} AND binding_id=${receipt.bindingId}
          AND generation=${receipt.generation} AND operation_ordinal>${receipt.ordinal} LIMIT 1`;
        if (newer.length) {
          const { makeProjectTeamPiOperations } = yield* Effect.promise(
            () => import("./ProjectTeamPiOperations.ts"),
          );
          const operations = yield* makeProjectTeamPiOperations({ environmentId }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectTeamAuthorization, authorization),
            Effect.provideService(ProjectWorkRepository, repository),
          );
          compactAnchor = yield* operations.readCompactionAnchorInTransaction(
            {
              providerInstanceId: receipt.providerInstanceId,
              threadId: receipt.threadId,
            },
            receipt.operation.operationId,
          );
        }
      }
      const owner = yield* current(original);
      const common = {
        environmentId,
        projectId: owner.authority.binding.projectId,
        dispatchId: original.fence.dispatchId,
        bindingId: owner.authority.binding.recordId,
        generation: owner.authority.binding.generation,
        claimGeneration: original.fence.claimGeneration,
        fenceRevision: original.fence.revision,
        dispatchIntentSha256: hash(original.intent),
        boundaryRevision: owner.authority.state.revision,
        originalAssignmentOperationId: receipt.operation.operationId,
        originalAssignmentReceiptSha256: hash(receipt),
        binding: owner.authority.binding,
        rootBudget: {
          rootTaskId: original.intent.limits.rootTaskId,
          maximumTokens: original.intent.limits.maximumTokens,
          deadlineAtMs: original.intent.limits.rootDeadlineAtMs,
        },
        attemptLimits: {
          maximumTokens: original.intent.limits.attemptMaximumTokens,
          deadlineAtMs: original.intent.limits.deadlineAtMs,
        },
        ...(compactAnchor === undefined ? {} : { compactAnchor }),
      };
      const turnIndex =
        predecessor === undefined
          ? 0
          : isSuccessor(predecessor.decision)
            ? predecessor.decision.turnIndex + 1
            : 1;
      const successorFields =
        predecessor === undefined
          ? undefined
          : {
              version: 2 as const,
              turnIndex,
              predecessor: {
                operationId: predecessor.decision.request.operationId,
                operationOrdinal: predecessor.operationOrdinal,
                decisionSha256: hash(predecessor.decision),
                deliveryReceiptSha256: hash(predecessor.receipt),
                operationReceiptSha256: predecessor.operationReceiptSha256,
                native: predecessor.native,
              },
            };
      const records = owner.authority.state.foundationRecords ?? [];
      const messages = records
        .filter((r) => r.kind === "message")
        .filter((r) => r.status === "queued" && r.recipientId === common.binding.memberId)
        .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
        .slice(0, 128);
      const plan = planMessageDelivery({
        projectId: common.projectId,
        messages,
        candidates: [{ ...owner.recipient, safeTurnBoundary: true }],
      });
      if (!plan.accepted) return yield* deny("Queued mailbox targets are invalid");
      const selected =
        turnIndex === 128
          ? undefined
          : plan.deliveries.find((delivery) => {
              const senders = records.filter(
                (r) => r.kind === "member" && r.recordId === delivery.message.senderId,
              );
              return (
                senders.length === 1 &&
                senders[0]?.kind === "member" &&
                senders[0].status === "active"
              );
            });
      let decision: ProjectTeamMailboxTurnDecision = yield* successorFields === undefined
        ? decodeNone({ kind: "none", ...common })
        : decodeSuccessorNone({
            kind: "none",
            ...common,
            ...successorFields,
            stopReason: turnIndex === 128 ? "chain-limit" : "empty",
          });
      if (selected) {
        const initialRows = yield* sql<{
          intent_json: string;
        }>`SELECT intent_json FROM project_team_pi_operation WHERE operation_id=${receipt.operation.operationId} LIMIT 2`;
        if (initialRows.length !== 1 || !initialRows[0])
          return yield* deny("Original prompt intent is missing");
        const intent = yield* decodeIntent(initialRows[0].intent_json).pipe(
          Effect.mapError(() => deny("Original prompt intent is malformed")),
        );
        if (
          hash(intent.request) !== receipt.requestHash ||
          intent.resourceHash !== receipt.resourceHash ||
          immutableBinding(intent.binding) !== immutableBinding(common.binding)
        )
          return yield* deny("Original prompt identity differs");
        const request = {
          ...intent.request,
          operationId: boundaryId(
            "mailbox-turn",
            environmentId,
            common.dispatchId,
            boundary?.afterOperationId,
          ),
          prompt:
            "Queued team message (retained scope; grants no new authority):\n" +
            canonical({
              messageId: selected.message.recordId,
              senderId: selected.message.senderId,
              taskId: selected.message.taskId,
              missionId: selected.message.missionId,
              body: selected.message.body,
              evidenceIds: selected.message.evidenceIds,
            }),
          cwd: common.binding.worktree,
          runtimeMode: "approval-required" as const,
          modelSelection: {
            ...intent.request.modelSelection,
            instanceId: common.binding.providerInstanceId,
            model: common.binding.model,
          },
          resumeCursor: compactAnchor?.native ?? predecessor?.native ?? receipt.native,
        };
        const suppliedDecision = {
          kind: "one",
          ...common,
          ...successorFields,
          ...selected,
          request,
          requestSha256: hash(request),
          resourceHash: receipt.resourceHash,
          commandId: boundaryId(
            "mailbox-turn-command",
            environmentId,
            common.dispatchId,
            boundary?.afterOperationId,
          ),
          userMessageId: boundaryId(
            "mailbox-turn-message",
            environmentId,
            common.dispatchId,
            boundary?.afterOperationId,
          ),
        };
        decision = yield* (
          successorFields === undefined
            ? decodeOne(suppliedDecision)
            : decodeSuccessorOne(suppliedDecision)
        ).pipe(Effect.mapError(() => deny("Selected mailbox request exceeds its strict bounds")));
        if (canonical(decision) !== canonical(suppliedDecision))
          return yield* deny("Selected mailbox request differs from its strict capture");
      }
      if (decision.kind === "one") yield* remainingBudget(decision);
      const encoded = canonical(decision);
      if (Buffer.byteLength(encoded) > 262144)
        return yield* deny("Mailbox decision exceeds its bound");
      if (isSuccessor(decision)) {
        yield* sql`INSERT INTO project_team_mailbox_successor(environment_id,dispatch_id,predecessor_operation_id,turn_index,project_id,binding_id,generation,decision_json,decision_sha256,operation_id)
          VALUES(${environmentId},${decision.dispatchId},${decision.predecessor.operationId},${decision.turnIndex},${decision.projectId},${decision.bindingId},${decision.generation},${encoded},${textHash(encoded)},${decision.kind === "one" ? decision.request.operationId : null})
          ON CONFLICT(environment_id,dispatch_id,predecessor_operation_id) DO NOTHING`;
      } else {
        yield* sql`INSERT INTO project_team_mailbox_turn(environment_id,dispatch_id,project_id,binding_id,generation,decision_json,decision_sha256,operation_id)
          VALUES(${environmentId},${decision.dispatchId},${decision.projectId},${decision.bindingId},${decision.generation},${encoded},${textHash(encoded)},${decision.kind === "one" ? decision.request.operationId : null}) ON CONFLICT(environment_id,dispatch_id) DO NOTHING`;
      }
      const saved = yield* reader.readInTransaction(locator);
      if (!saved || canonical(saved) !== encoded)
        return yield* deny("Mailbox boundary first winner differs");
      const final = yield* journal.inspect(original.fence.dispatchId, { requireClaim: true });
      if (canonical(final) !== canonical(original))
        return yield* deny("Mailbox boundary changed during capture");
      const finalOwner = yield* current(final);
      if (
        canonical(finalOwner.recipient) !== canonical(owner.recipient) ||
        finalOwner.authority.state.revision !== common.boundaryRevision
      )
        return yield* deny("Mailbox authority changed during boundary capture");
      yield* reader.verifyOriginalInTransaction(final, decision);
      return decision.kind === "none"
        ? { _tag: "None" as const, decision }
        : { _tag: "Selected" as const, decision };
    });
    const claim = (
      input: ProjectTeamDispatchSnapshot,
      boundary?: { readonly afterOperationId: string },
    ) => {
      try {
        const captured = exact(input, captureSnapshotInput);
        const capturedBoundary =
          boundary === undefined ? undefined : exact(boundary, captureBoundary);
        return own(claimInside(captured, capturedBoundary));
      } catch {
        return Effect.fail(deny("Mailbox boundary input is invalid"));
      }
    };
    const selectedCurrent = Effect.fn("mailboxTurn.selectedCurrent")(function* (
      decision: typeof Selected.Type,
    ) {
      const original = yield* journal.inspect(decision.dispatchId, { requireClaim: true });
      if (
        original.fence.stage !== "assignment-observed" ||
        original.fence.revision !== decision.fenceRevision ||
        original.fence.claimGeneration !== decision.claimGeneration ||
        hash(original.intent) !== decision.dispatchIntentSha256
      )
        return yield* policy("Original later-turn boundary changed");
      yield* reader.verifyOriginalInTransaction(original, decision);
      const owner = yield* current(original);
      if (immutableBinding(owner.authority.binding) !== immutableBinding(decision.binding))
        return yield* policy("Selected binding changed");
      const records = owner.authority.state.foundationRecords ?? [];
      const messages = records.filter(
        (r) => r.kind === "message" && r.recordId === decision.message.recordId,
      );
      const message = messages[0];
      if (
        messages.length !== 1 ||
        message?.kind !== "message" ||
        canonical(message) !== canonical(decision.message)
      )
        return yield* policy("Selected queued message changed");
      const senders = records.filter((r) => r.kind === "member" && r.recordId === message.senderId);
      if (senders.length !== 1 || senders[0]?.kind !== "member" || senders[0].status !== "active")
        return yield* policy("Selected sender is inactive or ambiguous");
      const plan = planMessageDelivery({
        projectId: decision.projectId,
        messages: [message],
        candidates: [{ ...owner.recipient, safeTurnBoundary: true }],
      });
      if (
        !plan.accepted ||
        plan.deliveries.length !== 1 ||
        canonical(plan.deliveries[0]?.target) !== canonical(decision.target)
      )
        return yield* policy("Selected delivery target changed");
      return { original, owner };
    });
    const readInside = Effect.fn("mailboxTurn.readForOperationInside")(function* (
      input: typeof ReadInput.Type,
    ) {
      const rows = yield* sql<{
        dispatch_id: string;
      }>`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id=${environmentId} AND binding_id=${input.bindingId} AND generation=${input.generation} LIMIT 2`;
      if (rows.length !== 1 || !rows[0])
        return yield* deny("Managed original dispatch is unavailable");
      const original = yield* journal.readRetained(rows[0].dispatch_id);
      const binding = originalBinding(original);
      if (
        binding.projectId !== input.projectId ||
        binding.providerInstanceId !== input.providerInstanceId ||
        binding.threadId !== input.request.threadId ||
        binding.recordId !== input.bindingId ||
        binding.generation !== input.generation
      )
        return yield* deny("Requested mailbox owner differs");
      if (
        input.request.kind === "initialize" ||
        (input.request.kind === "prompt" &&
          input.request.prompt === original.intent.request.assignment &&
          (input.request.operationId === undefined ||
            input.request.operationId === original.intent.request.assignmentOperationId))
      )
        return { _tag: "NotLaterTurn" as const };
      if (input.request.kind !== "prompt")
        return yield* deny("Later prompt has no selected decision");
      const legacyMatches = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM project_team_mailbox_turn
        WHERE environment_id=${environmentId} AND dispatch_id=${original.fence.dispatchId} AND operation_id IS NOT NULL
        AND json_extract(decision_json,'$.request.prompt')=${input.request.prompt} LIMIT 2`;
      const successorMatches = yield* sql<{
        operation_id: string;
      }>`SELECT operation_id FROM project_team_mailbox_successor
        WHERE environment_id=${environmentId} AND dispatch_id=${original.fence.dispatchId} AND operation_id IS NOT NULL
        AND json_extract(decision_json,'$.request.prompt')=${input.request.prompt} LIMIT 2`;
      const matches = [...legacyMatches, ...successorMatches];
      if (matches.length !== 1 || !matches[0])
        return yield* deny("Later prompt has no unique exact selected decision");
      const decision = yield* reader.readInTransaction({ operationId: matches[0].operation_id });
      if (!decision || decision.kind !== "one")
        return yield* deny("Later prompt has no selected decision");
      const request = {
        ...input.request,
        ...(input.request.operationId === undefined
          ? { operationId: decision.request.operationId }
          : {}),
        ...(input.request.cwd === undefined ? { cwd: decision.request.cwd } : {}),
        ...(input.request.runtimeMode === undefined
          ? { runtimeMode: decision.request.runtimeMode }
          : {}),
        ...(input.request.resumeCursor === undefined
          ? { resumeCursor: decision.request.resumeCursor }
          : {}),
      };
      if (canonical(request) !== canonical(decision.request))
        return yield* deny("Later prompt differs from its selected request");
      const verified = yield* selectedCurrent(decision);
      return { _tag: "LaterTurn" as const, decision, original: verified.original };
    });
    const readForOperation = (input: {
      readonly projectId: ProjectId;
      readonly bindingId: string;
      readonly generation: number;
      readonly providerInstanceId: ProviderInstanceId;
      readonly request: PiManagedOperationRequest;
    }) => {
      try {
        return own(readInside(exact(input, captureReadInput)));
      } catch {
        return Effect.fail(deny("Later operation input is invalid"));
      }
    };
    const selectedDecision = Effect.fn("mailboxTurn.selectedDecision")(function* (
      operationId: string,
    ) {
      const decision = yield* reader.readInTransaction({ operationId });
      if (!decision || decision.kind !== "one")
        return yield* deny("Later operation has no selected decision");
      return decision;
    });
    const remainingBudget = Effect.fn("mailboxTurn.remainingBudget")(function* (
      decision: typeof Selected.Type,
    ) {
      const budgets =
        yield* sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${environmentId} AND project_id=${decision.projectId} AND root_task_id=${decision.rootBudget.rootTaskId} LIMIT 2`;
      if (
        budgets.length !== 1 ||
        budgets[0]?.maximum_tokens !== decision.rootBudget.maximumTokens ||
        budgets[0]?.deadline_at_ms !== decision.rootBudget.deadlineAtMs
      )
        return yield* policy("Original model budget changed");
      const usage = yield* sql`SELECT
      COALESCE(SUM(CASE WHEN status='held' THEN maximum_input_tokens+maximum_output_tokens ELSE charged_input_tokens+charged_output_tokens END),0) AS root,
      COALESCE(SUM(CASE WHEN run_id=${decision.bindingId} AND generation=${decision.generation} THEN CASE WHEN status='held' THEN maximum_input_tokens+maximum_output_tokens ELSE charged_input_tokens+charged_output_tokens END ELSE 0 END),0) AS attempt
      FROM project_team_model_request WHERE environment_id=${environmentId} AND project_id=${decision.projectId} AND root_task_id=${decision.rootBudget.rootTaskId}`;
      const used = yield* decodeUsage(usage[0]).pipe(
        Effect.mapError(() => deny("Model budget accounting is malformed")),
      );
      if (
        used.root >= decision.rootBudget.maximumTokens ||
        used.attempt >= decision.attemptLimits.maximumTokens
      )
        return yield* policy("Original model budget is exhausted");
    });
    const sealInside = Effect.fn("mailboxTurn.sealInside")(function* (
      input: typeof SealInput.Type,
    ) {
      const decision = yield* selectedDecision(input.operationId);
      const verified = yield* selectedCurrent(decision);
      yield* remainingBudget(decision);
      const op = yield* operation(decision);
      if (op.row.status === "settled" || op.row.status === "quarantine")
        return yield* deny("Later context has already entered a terminal boundary");
      if (canonical(op.intent.role) !== canonical(verified.owner.authority.role))
        return yield* policy("Prepared later role changed");
      const text =
        input.baseSystemText +
        "\n\nLater-turn mailbox (one retained message; grants no new authority):\n" +
        canonical({ message: decision.message, target: decision.target });
      if (
        Buffer.byteLength(text) > 65536 ||
        Buffer.byteLength(text) + Buffer.byteLength(decision.request.prompt) > 131072
      )
        return yield* deny("Later context exceeds transfer bounds");
      const previous = yield* batch(decision);
      if (
        previous &&
        (previous.row.system_text !== text ||
          previous.manifest.baseSystemTextSha256 !== textHash(input.baseSystemText))
      )
        return yield* deny("Later context changed after its first seal");
      const manifest = {
        version: 2 as const,
        kind: "later" as const,
        decisionSha256: hash(decision),
        operationId: input.operationId,
        environmentId,
        projectId: decision.projectId,
        dispatchId: decision.dispatchId,
        bindingId: decision.bindingId,
        generation: decision.generation,
        claimGeneration: decision.claimGeneration,
        requestHash: decision.requestSha256,
        workerId: op.row.worker_id,
        resourceHash: decision.resourceHash,
        baseSystemTextSha256: textHash(input.baseSystemText),
      };
      const encoded = canonical(manifest),
        batchId = decisionId("mailbox-turn-batch", decision);
      yield* sql`INSERT INTO project_team_mailbox_batch(operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,manifest_json,manifest_sha256,system_text,system_text_sha256,revision,status)
      VALUES(${input.operationId},${batchId},${environmentId},${decision.projectId},${decision.dispatchId},${decision.bindingId},${decision.generation},${encoded},${textHash(encoded)},${text},${textHash(text)},0,'sealed') ON CONFLICT(operation_id) DO NOTHING`;
      const stored = yield* batch(decision);
      if (
        !stored ||
        stored.row.manifest_json !== encoded ||
        stored.row.system_text !== text ||
        stored.manifest.workerId !== op.row.worker_id
      )
        return yield* deny("Later seal first winner differs");
      const final = yield* selectedCurrent(decision);
      if (canonical(final.owner.recipient) !== canonical(verified.owner.recipient))
        return yield* policy("Later context owner changed during sealing");
      return {
        batchId,
        decisionSha256: hash(decision),
        systemText: text,
        systemTextSha256: stored.row.system_text_sha256,
      };
    });
    const seal = (input: typeof SealInput.Type) => {
      try {
        return own(sealInside(exact(input, captureSealInput)));
      } catch {
        return Effect.fail(deny("Later seal input is invalid"));
      }
    };
    const bindInside = Effect.fn("mailboxTurn.bindInside")(function* (
      input: typeof BindInput.Type,
    ) {
      const decision = yield* selectedDecision(input.operationId);
      const verified = yield* selectedCurrent(decision);
      const op = yield* operation(decision),
        sealed = yield* batch(decision);
      if (
        !sealed ||
        sealed.manifest.workerId !== op.row.worker_id ||
        op.row.status !== "running" ||
        sealed.row.status !== "sealed"
      )
        return yield* deny("Later input has no current owned seal");
      const rows =
        yield* sql`SELECT reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,request_id,route_id,provider,model,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
      CASE WHEN length(CAST(reservation_json AS BLOB)) <= 8192 THEN reservation_json ELSE NULL END AS reservation_json
      FROM project_team_model_request WHERE reservation_id=${input.reservationId}
        AND request_lane='pi' AND request_scope='' LIMIT 2`;
      if (rows.length !== 1) return yield* deny("Later model reservation is missing or ambiguous");
      const reservation = yield* decodeReservationRow(rows[0]).pipe(
        Effect.mapError(() => deny("Later model reservation is malformed")),
      );
      const fields = {
        workerId: reservation.worker_id,
        generation: reservation.generation,
        operationId: reservation.operation_id,
        requestId: reservation.request_id,
        routeId: reservation.route_id,
        provider: reservation.provider,
        model: reservation.model,
        maxInputTokens: reservation.maximum_input_tokens,
        maxOutputTokens: reservation.maximum_output_tokens,
        callCount: 1 as const,
        deadlineAtMs: reservation.deadline_at_ms,
      };
      const captured = yield* decodeReservation(reservation.reservation_json).pipe(
        Effect.mapError(() => deny("Later model reservation identity is malformed")),
      );
      if (
        reservation.environment_id !== environmentId ||
        reservation.project_id !== decision.projectId ||
        reservation.root_task_id !== decision.rootBudget.rootTaskId ||
        reservation.run_id !== decision.bindingId ||
        reservation.attempt_id !== decision.target.attemptId ||
        reservation.worker_id !== op.row.worker_id ||
        reservation.generation !== decision.generation ||
        reservation.operation_id !== input.operationId ||
        reservation.route_id !== "command-code-ling-free" ||
        reservation.model !== decision.binding.model ||
        reservation.status !== "held" ||
        reservation.capacity_state !== "held" ||
        canonical(captured) !== canonical(fields) ||
        reservation.maximum_input_tokens + reservation.maximum_output_tokens >
          op.row.maximum_tokens ||
        reservation.deadline_at_ms > op.row.deadline_at_ms
      )
        return yield* deny("Later model reservation differs from its actual operation");
      const recorded = {
        reservation_id: input.reservationId,
        operation_id: input.operationId,
        request_id: reservation.request_id,
        worker_id: op.row.worker_id,
        generation: decision.generation,
        route_id: reservation.route_id,
        provider: reservation.provider,
        model: reservation.model,
        system_text_sha256: sealed.row.system_text_sha256,
        encoded_request_sha256: input.encodedRequestSha256,
      };
      yield* sql`INSERT INTO project_team_mailbox_input ${sql.insert(recorded)} ON CONFLICT(reservation_id) DO NOTHING`;
      const saved =
        yield* sql`SELECT * FROM project_team_mailbox_input WHERE reservation_id=${input.reservationId} LIMIT 2`;
      if (
        saved.length !== 1 ||
        canonical(yield* decodeBoundInput(saved[0])) !== canonical(recorded)
      )
        return yield* deny("Later input first winner differs");
      const final = yield* selectedCurrent(decision);
      if (canonical(final.owner.recipient) !== canonical(verified.owner.recipient))
        return yield* policy("Later model owner changed during input binding");
      return {
        reservationId: input.reservationId,
        requestId: reservation.request_id,
        workerId: op.row.worker_id,
        systemTextSha256: sealed.row.system_text_sha256,
        encodedRequestSha256: input.encodedRequestSha256,
      };
    });
    const bindInput = (input: typeof BindInput.Type) => {
      try {
        return own(bindInside(exact(input, captureBindInput)));
      } catch {
        return Effect.fail(deny("Later input binding is invalid"));
      }
    };
    const qualified = Effect.fn("mailboxTurn.qualified")(function* (
      decision: typeof Selected.Type,
      sealed: NonNullable<Effect.Success<ReturnType<typeof batch>>>,
      receipt: ProjectTeamMailboxTurnOperationReceipt,
    ) {
      const rows =
        yield* sql`SELECT reservation_id,operation_id,request_id,worker_id,generation,route_id,provider,model,system_text_sha256,encoded_request_sha256 FROM project_team_mailbox_input WHERE operation_id=${decision.request.operationId} ORDER BY request_id LIMIT 257`;
      if (
        !rows.length ||
        rows.length > 256 ||
        rows.length !== receipt.terminal.accountingReceipts.length
      )
        return yield* deny("Later consumed input accounting is incomplete");
      const seen = new Set<string>();
      for (const raw of rows) {
        const input = yield* decodeBoundInput(raw);
        const matches = receipt.terminal.accountingReceipts.filter(
          (r) => r.reservationId === input.reservation_id,
        );
        const match = matches[0];
        if (
          seen.has(input.reservation_id) ||
          matches.length !== 1 ||
          !match ||
          input.operation_id !== decision.request.operationId ||
          input.worker_id !== receipt.terminal.identity.workerId ||
          input.generation !== decision.generation ||
          input.request_id !== match.requestId ||
          input.route_id !== match.routeId ||
          input.provider !== match.provider ||
          input.model !== match.model ||
          input.system_text_sha256 !== sealed.row.system_text_sha256
        )
          return yield* deny("Later consumed request differs from its bound input");
        seen.add(input.reservation_id);
      }
    });
    const classify = Effect.fn("mailboxTurn.classifyInside")(function* (
      decision: ProjectTeamMailboxTurnDecision,
    ) {
      if (decision.kind === "none") return { _tag: "None" as const, decision };
      const sealed = yield* batch(decision);
      const saved = yield* reflectionPhase(decision.request.operationId, "delivered");
      if (saved) {
        if (!sealed) return yield* deny("Later delivered seal is missing");
        return {
          _tag: "Retained" as const,
          decision,
          receipt: yield* historical(
            decision,
            sealed,
            saved,
            yield* reflectionPhase(decision.request.operationId, "uncertain"),
          ),
        };
      }
      const rows = yield* sql<{
        status: string;
      }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${decision.request.operationId} LIMIT 2`;
      if (rows.length > 1) return yield* deny("Later operation is ambiguous");
      if (!rows.length) {
        yield* selectedCurrent(decision);
        yield* remainingBudget(decision);
        return { _tag: "Selected" as const, decision };
      }
      yield* operation(decision);
      const status = rows[0]?.status;
      return {
        _tag:
          status === "prepared" || status === "starting" || status === "running"
            ? ("Active" as const)
            : ("Uncertain" as const),
        decision,
      };
    });
    const reflect = (input: typeof ReflectInput.Type) => {
      let captured: typeof ReflectInput.Type;
      try {
        captured = exact(input, captureReflectInput);
      } catch {
        return Effect.fail(deny("Later reflection input is invalid"));
      }
      return Effect.suspend(() => {
        let result: ProjectTeamMailboxTurnReflection | undefined;
        type ValidationError =
          | Effect.Error<ReturnType<typeof historical>>
          | Effect.Error<ReturnType<typeof journal.inspect>>
          | Effect.Error<ReturnType<typeof current>>
          | Effect.Error<ReturnType<typeof observation>>
          | Effect.Error<ReturnType<typeof physicalMessage>>
          | Effect.Error<ReturnType<typeof lookupInTransaction>>
          | Effect.Error<ReturnType<typeof qualified>>
          | Effect.Error<ReturnType<typeof verifyPhase>>
          | Effect.Error<ReturnType<typeof batch>>;
        let validate: Effect.Effect<void, ValidationError, SqlClient.SqlClient> = Effect.void;
        return ownGuard.pipe(
          Effect.andThen(
            repository.executeAtomic(
              Effect.gen(function* () {
                const decision = yield* selectedDecision(captured.operationId);
                const sealed = yield* batch(decision);
                const saved = yield* reflectionPhase(captured.operationId, "delivered");
                const uncertain = yield* reflectionPhase(captured.operationId, "uncertain");
                if (saved) {
                  if (!sealed) return yield* deny("Later delivered seal is missing");
                  const receipt = yield* historical(decision, sealed, saved, uncertain);
                  validate = historical(decision, sealed, saved, uncertain).pipe(Effect.asVoid);
                  result = { _tag: "Retained", receipt };
                  return [];
                }
                const rows = yield* sql<{
                  status: string;
                }>`SELECT status FROM project_team_pi_operation WHERE operation_id=${captured.operationId} LIMIT 2`;
                if (!rows.length) {
                  yield* selectedCurrent(decision);
                  result = { _tag: "Pending" };
                  return [];
                }
                const op = yield* operation(decision);
                if (["prepared", "starting", "running"].includes(op.row.status)) {
                  const policyResult = yield* Effect.result(
                    Effect.gen(function* () {
                      const retainedOriginal = yield* journal.readRetained(decision.dispatchId);
                      yield* current(retainedOriginal);
                    }),
                  );
                  if (policyResult._tag === "Failure") {
                    if (!currentPolicyDenied(policyResult.failure))
                      return yield* Effect.fail(policyResult.failure);
                    // Original physical join belongs to the Host, never to this observation.
                    result = { _tag: "Uncertain" };
                    return [];
                  }
                  yield* selectedCurrent(decision);
                  result = { _tag: "Pending" };
                  return [];
                }
                const observed = yield* observation(decision);
                const ownerResult = yield* Effect.result(
                  Effect.gen(function* () {
                    const retainedOriginal = yield* journal.readRetained(decision.dispatchId);
                    const owner = yield* current(retainedOriginal);
                    const original = yield* journal.inspect(decision.dispatchId, {
                      requireClaim: true,
                    });
                    if (
                      original.fence.stage !== "assignment-observed" ||
                      original.fence.revision !== decision.fenceRevision ||
                      original.fence.claimGeneration !== decision.claimGeneration
                    )
                      return yield* policy("Original later-turn boundary changed");
                    yield* reader.verifyOriginalInTransaction(original, decision);
                    return owner;
                  }),
                );
                if (ownerResult._tag === "Failure") {
                  if (!currentPolicyDenied(ownerResult.failure))
                    return yield* Effect.fail(ownerResult.failure);
                  result = { _tag: "Uncertain" };
                  return [];
                }
                if (!sealed) {
                  result = { _tag: "Uncertain" };
                  return [];
                }
                if (
                  sealed.row.status !== (uncertain ? "uncertain" : "sealed") ||
                  sealed.row.revision !== (uncertain ? 1 : 0)
                )
                  return yield* deny("Later reflection phase differs");
                const owner = ownerResult.success;
                const success =
                  op.row.status === "settled" && observed.terminal.outcome === "success";
                const receipt = success
                  ? yield* lookupInTransaction(
                      {
                        providerInstanceId: decision.binding.providerInstanceId,
                        threadId: decision.binding.threadId,
                      },
                      decision.request,
                      decision.requestSha256,
                      decision.resourceHash,
                    )
                  : undefined;
                if (success && !receipt) return yield* deny("Later successful receipt is missing");
                if (receipt) yield* qualified(decision, sealed, receipt);
                if (uncertain) {
                  yield* verifyPhase(decision, uncertain);
                  if (!success) {
                    result = { _tag: "Uncertain" };
                    return [];
                  }
                }
                const prior = uncertain?.message ?? decision.message;
                const records = owner.authority.state.foundationRecords ?? [];
                const messages = records.filter(
                  (r) => r.kind === "message" && r.recordId === prior.recordId,
                );
                const senders = records.filter(
                  (r) => r.kind === "member" && r.recordId === prior.senderId,
                );
                if (
                  messages.length !== 1 ||
                  canonical(messages[0]) !== canonical(prior) ||
                  senders.length !== 1 ||
                  senders[0]?.kind !== "member" ||
                  senders[0].status !== "active"
                ) {
                  result = { _tag: "Uncertain" };
                  return [];
                }
                const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
                const status = success ? "delivered" : "uncertain";
                const transition = applyMessageReceipt({
                  message: prior,
                  current: owner.recipient,
                  recordedTarget: decision.target,
                  receipt: {
                    ...decision.target,
                    expectedMessageRevision: prior.revision,
                    status,
                    at,
                  },
                });
                if (!transition.accepted || !transition.changed) {
                  result = { _tag: "Uncertain" };
                  return [];
                }
                const message = transition.message;
                const command = yield* decodeProjectWorkFoundationCommitCommand({
                  type: "project-work.foundation.commit",
                  projectId: decision.projectId,
                  commandId: derivedId(`mailbox-${status}`, environmentId, captured.operationId),
                  expectedRevision: owner.authority.state.revision,
                  committedAt: at,
                  attribution: {
                    actor: { kind: "system", id: "project-team-mailbox-turns" },
                    source: { kind: "system", id: "project-team-mailbox-turns" },
                    recordedAt: at,
                  },
                  records: [message],
                });
                const commands = [command],
                  outcomes = [message];
                yield* sql`INSERT INTO project_team_mailbox_reflection(operation_id,phase,command_json,command_sha256,observation_sha256,observed_at,outcome_json)
          VALUES(${captured.operationId},${status},${canonical(commands)},${hash(commands)},${observed.sha256},${at},${canonical(outcomes)}) ON CONFLICT(operation_id,phase) DO NOTHING`;
                const retained = yield* reflectionPhase(captured.operationId, status);
                if (
                  !retained ||
                  canonical(retained.commands) !== canonical(commands) ||
                  canonical(retained.message) !== canonical(message) ||
                  retained.row.observation_sha256 !== observed.sha256
                )
                  return yield* deny("Later reflection first winner differs");
                validate = Effect.gen(function* () {
                  const finalOriginal = yield* journal.inspect(decision.dispatchId, {
                    requireClaim: true,
                  });
                  if (
                    finalOriginal.fence.stage !== "assignment-observed" ||
                    finalOriginal.fence.revision !== decision.fenceRevision ||
                    finalOriginal.fence.claimGeneration !== decision.claimGeneration
                  )
                    return yield* deny("Later boundary changed during reflection");
                  const finalOwner = yield* current(finalOriginal);
                  if (canonical(finalOwner.recipient) !== canonical(owner.recipient))
                    return yield* deny("Later recipient changed during reflection");
                  const matching = finalOwner.authority.state.foundationRecords?.filter(
                    (r) => r.kind === "message" && r.recordId === message.recordId,
                  );
                  if (matching?.length !== 1 || canonical(matching[0]) !== canonical(message))
                    return yield* deny("Later message write was skipped or changed");
                  yield* physicalMessage(message);
                  if ((yield* observation(decision)).sha256 !== observed.sha256)
                    return yield* deny("Later terminal changed during reflection");
                  if (receipt) {
                    const finalReceipt = yield* lookupInTransaction(
                      {
                        providerInstanceId: decision.binding.providerInstanceId,
                        threadId: decision.binding.threadId,
                      },
                      decision.request,
                      decision.requestSha256,
                      decision.resourceHash,
                    );
                    if (
                      !finalReceipt ||
                      hash({
                        operation: finalReceipt.operation,
                        terminal: finalReceipt.terminal,
                        native: finalReceipt.native,
                      }) !==
                        hash({
                          operation: receipt.operation,
                          terminal: receipt.terminal,
                          native: receipt.native,
                        })
                    )
                      return yield* deny("Later successful receipt changed");
                    yield* qualified(decision, sealed, finalReceipt);
                  }
                  yield* verifyPhase(decision, retained, uncertain);
                  const changed =
                    yield* sql`UPDATE project_team_mailbox_batch SET revision=revision+1,status=${status} WHERE operation_id=${captured.operationId} AND revision=${sealed.row.revision} AND status=${sealed.row.status} RETURNING operation_id`;
                  if (changed.length !== 1)
                    return yield* deny("Later reflection CAS was skipped or superseded");
                  const finalBatch = yield* batch(decision);
                  if (
                    !finalBatch ||
                    finalBatch.row.revision !== sealed.row.revision + 1 ||
                    finalBatch.row.status !== status
                  )
                    return yield* deny("Later reflection physical CAS differs");
                });
                result = receipt
                  ? {
                      _tag: "Delivered",
                      receipt: {
                        operationId: captured.operationId,
                        decisionSha256: hash(decision),
                        batchId: sealed.row.batch_id,
                        observationSha256: observed.sha256,
                        commandId: command.commandId,
                        message,
                      },
                    }
                  : { _tag: "Uncertain" };
                return commands;
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              Effect.suspend(() => validate).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            ),
          ),
          Effect.flatMap(() =>
            result ? Effect.succeed(result) : Effect.fail(deny("Later reflection did not commit")),
          ),
          Effect.mapError((error) =>
            isTurnsError(error) ? error : deny("Later reflection is unavailable"),
          ),
        );
      });
    };
    return { claim, readForOperation, seal, bindInput, reflect };
  },
);
