import {
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  ProjectTeamMemorySelection,
  ProjectTeamMemoryProcessIntent,
  ProjectTeamEffect,
  canonicalProjectWorkPayload,
  EventId,
  ProjectWorkWriteResult,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { ProjectWorkRepository } from "../ProjectWorkRepository.ts";
import type { ProjectTeamDispatchSnapshot } from "../ProjectTeamDispatchJournal.ts";
import { PiManagedProcessAllocationSchema } from "../../provider/pi/PiManagedProcess.ts";
import type { ProjectTeamPrincipal } from "../ProjectTeamAuthorization.ts";
import { ProjectMemoryServiceError, projectMemoryHash } from "./ProjectMemoryService.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const strict = { onExcessProperty: "error" } as const;
export const ProjectMemoryOperationIdentity = Schema.Struct({
  environmentId: Id,
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  bindingId: Id,
  generation: Safe,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  operationId: Id,
  workerId: Id,
  ordinal: Safe,
});
export type ProjectMemoryOperationIdentity = typeof ProjectMemoryOperationIdentity.Type;
export const ProjectMemoryTaskOwner = Schema.Struct({
  ...ProjectMemoryOperationIdentity.fields,
  version: Schema.Literal(1),
  attemptId: Id,
  rootBindingId: Id,
  rootTaskId: Id,
  rootMaximumTokens: Positive,
  rootDeadlineAtMs: Positive,
  attemptMaximumTokens: Positive,
  attemptDeadlineAtMs: Positive,
  operationMaximumTokens: Positive,
  operationDeadlineAtMs: Positive,
  leaseDeadlineAtMs: Positive,
  roleSha256: Hash,
  configurationSha256: Hash,
  requestSha256: Hash,
  allocation: PiManagedProcessAllocationSchema,
});
export type ProjectMemoryTaskOwner = typeof ProjectMemoryTaskOwner.Type;

/** Only the executing bridge supplies this captured-operation port. Stored facts
 * locate its original owner; they do not authorize a future execution themselves. */
export class ProjectMemoryOperation extends Context.Service<
  ProjectMemoryOperation,
  {
    readonly identity: ProjectMemoryOperationIdentity;
    readonly readCurrentInTransaction: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectMemoryTaskOwner, ProjectMemoryServiceError>;
  }
>()("t3/projectWork/memory/ProjectMemoryModelAccounting/ProjectMemoryOperation") {}

export const ProjectMemoryJobOwner = Schema.Struct({
  version: Schema.Literal(1),
  operation: ProjectMemoryTaskOwner,
  selection: ProjectTeamMemorySelection,
  request: ProjectTeamMemoryProcessIntent,
  admittedEffect: ProjectTeamEffect,
  commandId: Id,
  intentFingerprint: Schema.String.check(Schema.isMaxLength(256)),
  actorId: Id,
  sourceKind: Id,
  sourceId: Schema.NullOr(Id),
  admittedAt: Schema.String,
});
export type ProjectMemoryJobOwner = typeof ProjectMemoryJobOwner.Type;
export const ProjectMemoryReservation = Schema.Struct({
  version: Schema.Literal(1),
  lane: Schema.Literal("memory"),
  scope: Hash,
  effectId: Id,
  ownerSha256: Hash,
  phase: Schema.Literals(["extract", "embed"]),
  workerId: Id,
  generation: Safe,
  operationId: Id,
  requestId: Positive,
  routeId: Id,
  provider: Schema.Literals(["command-code", "openrouter"]),
  model: Id,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
  callCount: Schema.Literal(1),
  deadlineAtMs: Positive,
});
export const ProjectMemorySettlement = Schema.Struct({
  ...ProjectMemoryReservation.fields,
  reservationId: Id,
  outcome: Schema.Literals(["reported", "failed", "unknown"]),
  chargedInputTokens: Safe,
  chargedOutputTokens: Safe,
  transportDrained: Schema.Boolean,
  reportedModel: Schema.optionalKey(Id),
  reportedInputTokens: Schema.optionalKey(Safe),
  reportedOutputTokens: Schema.optionalKey(Safe),
});
export type ProjectMemoryReservation = typeof ProjectMemoryReservation.Type;
export type ProjectMemorySettlement = typeof ProjectMemorySettlement.Type;
const decodeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryJobOwner),
  strict,
);
const decodeReservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryReservation),
  strict,
);
const decodeSettlement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemorySettlement),
  strict,
);
const decodeReservationInput = Schema.decodeUnknownEffect(ProjectMemoryReservation, strict);
const decodeSettlementInput = Schema.decodeUnknownEffect(ProjectMemorySettlement, strict);
const decodeOwnerInput = Schema.decodeUnknownEffect(ProjectMemoryJobOwner, strict);
const decodePolicy = Schema.decodeUnknownEffect(
  Schema.Struct({
    environmentId: Id,
    maximumConcurrentCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
    maximumConcurrentModelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
  }),
  strict,
);
const decodeAdmittedEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("project-work.foundation.recorded"),
      eventId: EventId,
      projectId: ProjectId,
      revision: Safe,
      occurredAt: Schema.String,
      record: ProjectTeamEffect,
    }),
  ),
  strict,
);
const decodeAcceptedResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const decodeAcceptedIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(EventId)),
  strict,
);
const decodeOwnerIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.optionalKey(Schema.Unknown),
      binding: ProjectTeamRunBinding,
      role: ProjectTeamRoleRevision,
      allocation: PiManagedProcessAllocationSchema,
      rootBudget: Schema.Struct({
        rootTaskId: Id,
        maximumTokens: Positive,
        deadlineAtMs: Positive,
      }),
      operationLimits: Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive }),
      resourceHash: Schema.optionalKey(Hash),
    }),
  ),
  strict,
);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isMemoryServiceError = Schema.is(ProjectMemoryServiceError);
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const sameReportedModel = (reported: string | undefined, requested: string) =>
  reported === requested || (requested.endsWith(":free") && reported === requested.slice(0, -5));
const readOriginalDispatch = Effect.fn("ProjectMemoryModelAccounting.readOriginalDispatch")(
  function* (
    sql: SqlClient.SqlClient,
    owner: ProjectMemoryTaskOwner,
    dispatchId: string,
  ): Effect.fn.Return<ProjectTeamDispatchSnapshot, ProjectMemoryServiceError> {
    const repository = yield* Effect.serviceOption(ProjectWorkRepository);
    if (Option.isNone(repository))
      return yield* deny("Original memory dispatch repository is unavailable");
    const { makeProjectTeamDispatchJournal } = yield* Effect.promise(
      () => import("../ProjectTeamDispatchJournal.ts"),
    );
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: owner.environmentId,
      maximumEnvironmentModelCalls: 128,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectWorkRepository, repository.value),
      Effect.mapError(() => deny("Original memory dispatch is unavailable")),
    );
    return yield* journal
      .readRetained(dispatchId)
      .pipe(Effect.mapError(() => deny("Original memory dispatch history changed")));
  },
);

/** The accepted bridge receipt binds the executing worker. A strict private
 * JSON envelope alone cannot grant an operation or replace its frozen limits. */
export const auditProjectMemoryAdmission = Effect.fn("auditProjectMemoryAdmission")(function* (
  sql: SqlClient.SqlClient,
  owner: ProjectMemoryJobOwner,
) {
  const operation = owner.operation;
  const expectedFingerprint =
    "project-team-intent:" +
    NodeCrypto.createHash("sha256")
      .update(
        canonicalProjectWorkPayload({
          intent: owner.request,
          actor: { kind: "agent", id: owner.actorId },
          source: { kind: owner.sourceKind, id: owner.sourceId },
          managed: {
            projectId: operation.projectId,
            bindingId: operation.bindingId,
            generation: operation.generation,
            providerInstanceId: operation.providerInstanceId,
            threadId: operation.threadId,
          },
        }),
      )
      .digest("hex");
  if (
    owner.sourceKind !== "mcp" ||
    owner.sourceId !== operation.workerId ||
    owner.intentFingerprint !== expectedFingerprint ||
    owner.request.projectId !== operation.projectId ||
    owner.request.taskId !== operation.taskId ||
    owner.commandId !== owner.request.commandId ||
    !same(owner.request.selection, owner.selection) ||
    owner.admittedEffect.effectId !== owner.selection.effectId
  )
    return yield* deny("Memory admission has no authenticated original worker association");
  const metadata = yield* sql<{ bytes: number }>`SELECT
    length(CAST(payload_fingerprint AS BLOB))+length(CAST(actor_kind AS BLOB))+
    length(CAST(actor_id AS BLOB))+length(CAST(source_kind AS BLOB))+
    length(CAST(source_id AS BLOB))+length(CAST(created_at AS BLOB))+
    length(CAST(event_ids_json AS BLOB))+length(CAST(result_json AS BLOB)) AS bytes
    FROM project_work_command_receipts WHERE project_id=${operation.projectId}
    AND command_id=${owner.commandId} LIMIT 2`;
  if (
    metadata.length !== 1 ||
    !Number.isSafeInteger(metadata[0]?.bytes) ||
    (metadata[0]?.bytes ?? 4194305) > 524288
  )
    return yield* deny("Original memory admission receipt exceeds its retained bound");
  const receipts = yield* sql<{
    fingerprint: string;
    actorKind: string;
    actorId: string;
    sourceKind: string;
    sourceId: string;
    at: string;
    ids: string | null;
    result: string | null;
  }>`SELECT payload_fingerprint AS fingerprint,actor_kind AS actorKind,actor_id AS actorId,
    source_kind AS sourceKind,source_id AS sourceId,created_at AS at,
    CASE WHEN length(CAST(event_ids_json AS BLOB))<=262144 THEN event_ids_json END AS ids,
    CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result
    FROM project_work_command_receipts WHERE project_id=${operation.projectId}
    AND command_id=${owner.commandId} LIMIT 2`;
  const receipt = receipts[0];
  if (
    receipts.length !== 1 ||
    receipt === undefined ||
    receipt.ids === null ||
    receipt.result === null ||
    receipt.fingerprint !== expectedFingerprint ||
    receipt.actorKind !== "agent" ||
    receipt.actorId !== owner.actorId ||
    receipt.sourceKind !== "mcp" ||
    receipt.sourceId !== operation.workerId ||
    receipt.at !== owner.admittedAt
  )
    return yield* deny("Original memory admission receipt authority changed");
  const ids = yield* decodeAcceptedIds(receipt.ids);
  const result = yield* decodeAcceptedResult(receipt.result);
  const events = yield* sql<{ id: string; at: string; type: string; payload: string | null }>`SELECT
    event_id AS id,occurred_at AS at,event_type AS type,
    CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
    FROM project_work_events WHERE project_id=${operation.projectId}
    AND command_id=${owner.commandId} ORDER BY sequence LIMIT 2`;
  const physical = events[0];
  if (
    events.length !== 1 ||
    physical === undefined ||
    physical.payload === null ||
    physical.type !== "project-work.foundation.recorded" ||
    physical.at !== owner.admittedAt ||
    result.projectId !== operation.projectId ||
    result.receipt.projectId !== operation.projectId ||
    result.receipt.commandId !== owner.commandId ||
    result.receipt.status !== "accepted" ||
    result.receipt.eventCount !== 1 ||
    !same(ids, [physical.id]) ||
    !same(result.delta.eventIds, ids)
  )
    return yield* deny("Original memory admission event membership changed");
  const event = yield* decodeAdmittedEvent(physical.payload);
  if (
    event.eventId !== physical.id ||
    event.projectId !== operation.projectId ||
    event.occurredAt !== owner.admittedAt ||
    !same(event.record, owner.admittedEffect)
  )
    return yield* deny("Original memory admission event changed");
  const operations = yield* sql<{
    id: string;
    worker: string;
    binding: string;
    generation: number;
    ordinal: number;
    kind: string;
    request: string;
    maximum: number;
    deadline: number;
    intent: string | null;
  }>`SELECT operation_id AS id,worker_id AS worker,binding_id AS binding,generation,
    operation_ordinal AS ordinal,operation_kind AS kind,request_hash AS request,
    maximum_tokens AS maximum,deadline_at_ms AS deadline,
    CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json END AS intent
    FROM project_team_pi_operation WHERE environment_id=${operation.environmentId}
    AND project_id=${operation.projectId} AND worker_id=${operation.workerId} LIMIT 2`;
  const original = operations[0];
  if (
    operations.length !== 1 ||
    original === undefined ||
    original.intent === null ||
    original.id !== operation.operationId ||
    original.binding !== operation.bindingId ||
    original.generation !== operation.generation ||
    original.ordinal !== operation.ordinal ||
    original.kind !== "prompt" ||
    original.request !== operation.requestSha256 ||
    original.maximum !== operation.operationMaximumTokens ||
    original.deadline !== operation.operationDeadlineAtMs
  )
    return yield* deny("Memory admission's original operation changed");
  const intent = yield* decodeOwnerIntent(original.intent);
  if (
    intent.binding.recordId !== operation.bindingId ||
    intent.binding.projectId !== operation.projectId ||
    intent.binding.taskId !== operation.taskId ||
    intent.binding.attemptId !== operation.attemptId ||
    intent.binding.generation !== operation.generation ||
    intent.binding.environmentId !== operation.environmentId ||
    intent.binding.providerInstanceId !== operation.providerInstanceId ||
    intent.binding.threadId !== operation.threadId ||
    projectMemoryHash(intent.role) !== operation.roleSha256 ||
    projectMemoryHash(intent.binding.configuration) !== operation.configurationSha256 ||
    !same(intent.allocation, operation.allocation) ||
    intent.rootBudget.rootTaskId !== operation.rootTaskId ||
    intent.rootBudget.maximumTokens !== operation.rootMaximumTokens ||
    intent.rootBudget.deadlineAtMs !== operation.rootDeadlineAtMs ||
    intent.operationLimits.maximumTokens !== operation.operationMaximumTokens ||
    intent.operationLimits.deadlineAtMs !== operation.operationDeadlineAtMs
  )
    return yield* deny("Memory admission's frozen operation scope or limits changed");
  const dispatches = yield* sql<{ id: string }>`SELECT dispatch_id AS id
    FROM project_team_dispatch WHERE environment_id=${operation.environmentId}
    AND binding_id=${operation.bindingId} AND generation=${operation.generation} LIMIT 2`;
  if (dispatches.length > 1) return yield* deny("Original memory dispatch is ambiguous");
  const dispatchId = dispatches[0]?.id;
  if (dispatchId !== undefined) {
    const dispatch = yield* readOriginalDispatch(sql, operation, dispatchId);
    const claim = dispatch.intent.compiledClaim.transition;
    if (
      claim?.kind !== "claim" ||
      claim.binding.recordId !== operation.bindingId ||
      claim.binding.taskId !== operation.taskId ||
      claim.binding.attemptId !== operation.attemptId ||
      claim.binding.generation !== operation.generation ||
      dispatch.intent.limits.rootTaskId !== operation.rootTaskId ||
      dispatch.intent.limits.maximumTokens !== operation.rootMaximumTokens ||
      dispatch.intent.limits.rootDeadlineAtMs !== operation.rootDeadlineAtMs ||
      dispatch.intent.limits.attemptMaximumTokens !== operation.attemptMaximumTokens ||
      dispatch.intent.limits.deadlineAtMs !== operation.attemptDeadlineAtMs ||
      Date.parse(claim.claim.leasedUntil) !== operation.leaseDeadlineAtMs
    )
      return yield* deny("Original memory attempt or lease ceiling changed");
  } else if (
    operation.attemptMaximumTokens !== intent.binding.configuration.maxTokens ||
    operation.attemptDeadlineAtMs !== operation.operationDeadlineAtMs ||
    operation.leaseDeadlineAtMs < operation.operationDeadlineAtMs
  ) {
    return yield* deny("Standalone memory attempt limits differ from its original operation");
  }
});

/** Historical ledger reads audit both lanes while native terminal receipts list
 * only native reservations. Source correction never erases an original charge. */
export const auditProjectMemoryOperationLedger = Effect.fn("auditProjectMemoryOperationLedger")(
  function* (
    sql: SqlClient.SqlClient,
    identity: {
      readonly environmentId: string;
      readonly projectId: string;
      readonly bindingId: string;
      readonly generation: number;
      readonly operationId: string;
    },
  ) {
    const metadata = yield* sql<{ reservationId: string; bytes: number }>`SELECT
      reservation_id AS reservationId,
      length(CAST(reservation_json AS BLOB))+COALESCE(length(CAST(settlement_json AS BLOB)),0) +
      length(CAST(reservation_id AS BLOB))+length(CAST(environment_id AS BLOB))+
      length(CAST(project_id AS BLOB))+length(CAST(root_task_id AS BLOB))+
      length(CAST(run_id AS BLOB))+length(CAST(attempt_id AS BLOB))+
      length(CAST(worker_id AS BLOB))+length(CAST(operation_id AS BLOB))+
      length(CAST(route_id AS BLOB))+length(CAST(provider AS BLOB))+length(CAST(model AS BLOB))+
      length(CAST(request_scope AS BLOB))+COALESCE(length(CAST(accounting_receipt_id AS BLOB)),0)+
      length(CAST(generation AS BLOB))+length(CAST(request_id AS BLOB))+
      length(CAST(maximum_input_tokens AS BLOB))+length(CAST(maximum_output_tokens AS BLOB))+
      length(CAST(deadline_at_ms AS BLOB))+length(CAST(status AS BLOB))+length(CAST(capacity_state AS BLOB))+
      length(CAST(charged_input_tokens AS BLOB))+length(CAST(charged_output_tokens AS BLOB))
      AS bytes FROM project_team_model_request
      WHERE environment_id=${identity.environmentId} AND project_id=${identity.projectId}
        AND run_id=${identity.bindingId} AND generation=${identity.generation}
        AND operation_id=${identity.operationId} AND request_lane='memory'
      ORDER BY reservation_id LIMIT 257`;
    if (
      metadata.length > 256 ||
      metadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 32768) ||
      metadata.reduce((total, row) => total + row.bytes, 0) > 4194304
    )
      return yield* deny("Memory operation ledger exceeds its retained bound");
    const rows = yield* sql<{
      reservation_id: string;
      environment_id: string;
      project_id: string;
      root_task_id: string;
      run_id: string;
      attempt_id: string;
      worker_id: string;
      generation: number;
      operation_id: string;
      request_id: number;
      request_scope: string;
      route_id: string;
      provider: string;
      model: string;
      maximum_input_tokens: number;
      maximum_output_tokens: number;
      deadline_at_ms: number;
      status: string;
      capacity_state: string;
      charged_input_tokens: number;
      charged_output_tokens: number;
      accounting_receipt_id: string | null;
      reservation_json: string;
      settlement_json: string | null;
    }>`SELECT reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,
      generation,operation_id,request_id,request_scope,route_id,provider,model,maximum_input_tokens,
      maximum_output_tokens,deadline_at_ms,status,capacity_state,charged_input_tokens,charged_output_tokens,
      accounting_receipt_id,reservation_json,settlement_json
      FROM project_team_model_request WHERE environment_id=${identity.environmentId}
        AND project_id=${identity.projectId} AND run_id=${identity.bindingId}
        AND generation=${identity.generation} AND operation_id=${identity.operationId}
        AND request_lane='memory' ORDER BY reservation_id LIMIT 257`;
    if (
      rows.length !== metadata.length ||
      rows.some((row, index) => row.reservation_id !== metadata[index]?.reservationId)
    )
      return yield* deny("Memory operation ledger changed during its retained read");
    let settled = true;
    let retainedBytes = metadata.reduce((total, row) => total + row.bytes, 0);
    const auditedOwners = new Map<string, ProjectMemoryJobOwner>();
    for (const row of rows) {
      const reservation = yield* decodeReservation(row.reservation_json);
      let owner = auditedOwners.get(reservation.effectId);
      if (owner === undefined) {
        const ownerMetadata = yield* sql<{
          bytes: number | null;
        }>`SELECT length(CAST(owner_json AS BLOB)) AS bytes
          FROM project_team_memory_job WHERE effect_id=${reservation.effectId}
          AND environment_id=${identity.environmentId} AND project_id=${identity.projectId} LIMIT 2`;
        const ownerBytes = ownerMetadata[0]?.bytes;
        if (
          ownerMetadata.length !== 1 ||
          ownerBytes === null ||
          ownerBytes === undefined ||
          !Number.isSafeInteger(ownerBytes) ||
          ownerBytes > 262144 ||
          (retainedBytes += ownerBytes) > 4194304
        )
          return yield* deny("Memory ledger owner exceeds its retained aggregate bound");
        const owners = yield* sql<{ owner: string | null }>`SELECT
          CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
          FROM project_team_memory_job WHERE effect_id=${reservation.effectId}
          AND environment_id=${identity.environmentId} AND project_id=${identity.projectId} LIMIT 2`;
        if (owners.length !== 1 || owners[0]?.owner === null || owners[0]?.owner === undefined)
          return yield* deny("Memory reservation has no original admitted job owner");
        owner = yield* decodeOwner(owners[0].owner);
        yield* auditProjectMemoryAdmission(sql, owner);
        auditedOwners.set(reservation.effectId, owner);
      }
      const operation = owner.operation;
      if (
        projectMemoryHash(owner) !== reservation.ownerSha256 ||
        operation.environmentId !== row.environment_id ||
        operation.projectId !== row.project_id ||
        operation.rootTaskId !== row.root_task_id ||
        operation.bindingId !== row.run_id ||
        operation.attemptId !== row.attempt_id ||
        operation.workerId !== row.worker_id ||
        operation.generation !== row.generation ||
        operation.operationId !== row.operation_id ||
        reservation.workerId !== row.worker_id ||
        reservation.generation !== row.generation ||
        reservation.operationId !== row.operation_id ||
        reservation.requestId !== row.request_id ||
        reservation.scope !== row.request_scope ||
        reservation.routeId !== row.route_id ||
        reservation.provider !== row.provider ||
        reservation.model !== row.model ||
        reservation.maxInputTokens !== row.maximum_input_tokens ||
        reservation.maxOutputTokens !== row.maximum_output_tokens ||
        reservation.deadlineAtMs !== row.deadline_at_ms ||
        reservation.deadlineAtMs >
          Math.min(
            operation.operationDeadlineAtMs,
            operation.attemptDeadlineAtMs,
            operation.rootDeadlineAtMs,
            operation.leaseDeadlineAtMs,
          ) ||
        reservation.maxInputTokens + reservation.maxOutputTokens >
          operation.operationMaximumTokens ||
        (reservation.phase === "extract"
          ? reservation.provider !== "command-code" ||
            reservation.model !== "inclusionai/ling-3.1-flash:free"
          : reservation.provider !== "openrouter" ||
            reservation.model !== "nvidia/nemotron-3-embed-1b:free")
      )
        return yield* deny("Memory reservation disagrees with its original operation owner");
      if (row.status === "held") {
        if (
          row.settlement_json !== null ||
          row.accounting_receipt_id !== null ||
          row.capacity_state !== "held" ||
          row.charged_input_tokens !== 0 ||
          row.charged_output_tokens !== 0
        )
          return yield* deny("Held memory reservation is corrupt");
        settled = false;
        continue;
      }
      if (row.settlement_json === null || row.accounting_receipt_id === null)
        return yield* deny("Memory reservation settlement is missing");
      const settlement = yield* decodeSettlement(row.settlement_json);
      const {
        reservationId: _id,
        outcome: _outcome,
        chargedInputTokens: _input,
        chargedOutputTokens: _output,
        transportDrained: _drain,
        reportedModel: _model,
        reportedInputTokens: _reportedInput,
        reportedOutputTokens: _reportedOutput,
        ...settledReservation
      } = settlement;
      if (
        !same(reservation, settledReservation) ||
        settlement.reservationId !== row.reservation_id ||
        settlement.outcome !== row.status ||
        settlement.chargedInputTokens !== row.charged_input_tokens ||
        settlement.chargedOutputTokens !== row.charged_output_tokens ||
        row.capacity_state !== (settlement.transportDrained ? "released" : "quarantine") ||
        (settlement.outcome === "reported"
          ? !sameReportedModel(settlement.reportedModel, reservation.model) ||
            settlement.reportedInputTokens !== settlement.chargedInputTokens ||
            settlement.reportedOutputTokens !== settlement.chargedOutputTokens ||
            settlement.chargedInputTokens > reservation.maxInputTokens ||
            settlement.chargedOutputTokens > reservation.maxOutputTokens
          : settlement.chargedInputTokens !== reservation.maxInputTokens ||
            settlement.chargedOutputTokens !== reservation.maxOutputTokens)
      )
        return yield* deny("Memory accounting settlement is corrupt");
      if (!settlement.transportDrained) settled = false;
    }
    return { rows, settled };
  },
);

export interface ProjectMemoryModelAccountingOptions {
  readonly environmentId: string;
  readonly maximumConcurrentCalls: number;
  readonly maximumConcurrentModelCalls: number;
  /** Requalify the saved selection, configured ports and executing operation in
   * the captured transaction. This port cannot derive authority from owner_json. */
  readonly assertCurrentInTransaction: (
    owner: ProjectMemoryJobOwner,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly assertTransportDrainedInTransaction: (
    reservationId: string,
    reservation: ProjectMemoryReservation,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
}

/** Memory requests retain the actual operation ID. Both request lanes therefore
 * consume the same operation, attempt, ancestral root and transport slots. */
export const makeProjectMemoryModelAccounting = Effect.fn("makeProjectMemoryModelAccounting")(
  function* (options: ProjectMemoryModelAccountingOptions) {
    const policy = yield* decodePolicy({
      environmentId: options.environmentId,
      maximumConcurrentCalls: options.maximumConcurrentCalls,
      maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
    });
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const crypto = yield* Crypto.Crypto;
    const owning = Effect.fn("ProjectMemoryModelAccounting.owning")(function* () {
      const current = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        (Option.isSome(current) && current.value !== sql) ||
        Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Memory accounting must own its captured SQL transaction");
    });
    const clockCheck = Effect.fn("ProjectMemoryModelAccounting.clockCheck")(function* (
      deadline: number,
    ) {
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* deny("Memory model deadline expired");
    });
    const savedOwner = Effect.fn("ProjectMemoryModelAccounting.savedOwner")(function* (
      effectId: string,
    ) {
      const rows = yield* sql<{ owner: string | null }>`SELECT
      CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
      FROM project_team_memory_job WHERE effect_id=${effectId}
      AND environment_id=${policy.environmentId} LIMIT 2`;
      const json = rows[0]?.owner;
      if (rows.length !== 1 || json === null || json === undefined)
        return yield* deny("Memory model stage has no original admitted owner");
      const owner = yield* decodeOwner(json);
      yield* auditProjectMemoryAdmission(sql, owner);
      return owner;
    });
    const reserve = Effect.fn("ProjectMemoryModelAccounting.reserve")(
      function* (
        suppliedOwner: ProjectMemoryJobOwner,
        stage: {
          readonly phase: "extract" | "embed";
          readonly routeId: string;
          readonly requestId: number;
          readonly maxInputTokens: number;
          readonly maxOutputTokens: number;
          readonly deadlineAtMs: number;
        },
      ) {
        yield* owning();
        const supplied = yield* decodeOwnerInput(suppliedOwner);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* savedOwner(supplied.selection.effectId);
            if (!same(owner, supplied)) return yield* deny("Original memory owner changed");
            yield* options.assertCurrentInTransaction(owner);
            const operation = owner.operation;
            const provider = stage.phase === "extract" ? "command-code" : "openrouter";
            const model =
              stage.phase === "extract"
                ? "inclusionai/ling-3.1-flash:free"
                : "nvidia/nemotron-3-embed-1b:free";
            const scope = projectMemoryHash({
              version: 1,
              ownerSha256: projectMemoryHash(owner),
              phase: stage.phase,
              routeId: stage.routeId,
              provider,
              model,
            });
            const reservation = yield* decodeReservationInput({
              ...stage,
              version: 1,
              lane: "memory",
              scope,
              effectId: owner.selection.effectId,
              ownerSha256: projectMemoryHash(owner),
              workerId: operation.workerId,
              generation: operation.generation,
              operationId: operation.operationId,
              provider,
              model,
              callCount: 1,
            });
            const maximum = reservation.maxInputTokens + reservation.maxOutputTokens;
            const deadline = Math.min(
              operation.rootDeadlineAtMs,
              operation.attemptDeadlineAtMs,
              operation.operationDeadlineAtMs,
              operation.leaseDeadlineAtMs,
            );
            if (
              !Number.isSafeInteger(maximum) ||
              maximum > operation.operationMaximumTokens ||
              reservation.deadlineAtMs > deadline ||
              operation.environmentId !== policy.environmentId
            )
              return yield* deny("Memory reservation exceeds its original operation limits");
            yield* clockCheck(reservation.deadlineAtMs);
            const ledger = yield* auditProjectMemoryOperationLedger(sql, operation);
            const previous = ledger.rows.find(
              (row) => row.request_scope === scope && row.request_id === reservation.requestId,
            );
            if (previous !== undefined) {
              if (!same(yield* decodeReservation(previous.reservation_json), reservation))
                return yield* deny("Memory request identity changed");
              return {
                reservationId: previous.reservation_id,
                reservation,
                status: "existing" as const,
              };
            }
            const legacy = yield* sql`SELECT 1 FROM project_team_model_request
        WHERE environment_id=${policy.environmentId} AND capacity_state='legacy' LIMIT 1`;
            if (legacy.length > 0)
              return yield* deny("Legacy model capacity requires reconciliation");
            const budgets = yield* sql<{ maximum: number; deadline: number }>`SELECT
        maximum_tokens AS maximum,deadline_at_ms AS deadline FROM project_team_model_budget
        WHERE environment_id=${policy.environmentId} AND project_id=${operation.projectId}
        AND root_task_id=${operation.rootTaskId} LIMIT 2`;
            const budget = budgets[0];
            if (
              budgets.length > 1 ||
              (budget !== undefined &&
                (budget.maximum !== operation.rootMaximumTokens ||
                  budget.deadline !== operation.rootDeadlineAtMs))
            )
              return yield* deny("Original memory root budget changed");
            if (budget === undefined)
              yield* sql`INSERT INTO project_team_model_budget VALUES(
        ${policy.environmentId},${operation.projectId},${operation.rootTaskId},
        ${operation.rootMaximumTokens},${operation.rootDeadlineAtMs})`;
            const usage = yield* sql<{ root: number; attempt: number; operation: number }>`SELECT
        COALESCE(SUM(CASE WHEN status='held' THEN maximum_input_tokens+maximum_output_tokens
          ELSE charged_input_tokens+charged_output_tokens END),0) AS root,
        COALESCE(SUM(CASE WHEN run_id=${operation.bindingId} AND generation=${operation.generation}
          AND attempt_id=${operation.attemptId} THEN CASE WHEN status='held'
            THEN maximum_input_tokens+maximum_output_tokens ELSE charged_input_tokens+charged_output_tokens END
          ELSE 0 END),0) AS attempt,
        COALESCE(SUM(CASE WHEN run_id=${operation.bindingId} AND generation=${operation.generation}
          AND operation_id=${operation.operationId} THEN CASE WHEN status='held'
            THEN maximum_input_tokens+maximum_output_tokens ELSE charged_input_tokens+charged_output_tokens END
          ELSE 0 END),0) AS operation
        FROM project_team_model_request WHERE environment_id=${policy.environmentId}
          AND project_id=${operation.projectId} AND root_task_id=${operation.rootTaskId}`;
            const totals = usage[0];
            if (
              totals === undefined ||
              Object.values(totals).some(
                (value) =>
                  !Number.isSafeInteger(value) ||
                  value < 0 ||
                  !Number.isSafeInteger(value + maximum),
              ) ||
              totals.root + maximum > operation.rootMaximumTokens ||
              totals.attempt + maximum > operation.attemptMaximumTokens ||
              totals.operation + maximum > operation.operationMaximumTokens
            )
              return yield* deny("Original memory operation, attempt or root budget exhausted");
            const slots = yield* sql<{
              environment: number;
              modelSlot: number;
              model: string;
            }>`SELECT
        environment_slot AS environment,model_slot AS modelSlot,model FROM project_team_model_request
        WHERE environment_id=${policy.environmentId} AND capacity_state IN ('held','quarantine')
        LIMIT 129`;
            if (slots.length > 128) return yield* deny("Shared model capacity exceeds its bound");
            const environmentSlot = Array.from(
              { length: policy.maximumConcurrentCalls },
              (_, i) => i,
            ).find((i) => !slots.some((row) => row.environment === i));
            const modelSlot = Array.from(
              { length: policy.maximumConcurrentModelCalls },
              (_, i) => i,
            ).find((i) => !slots.some((row) => row.model === model && row.modelSlot === i));
            if (environmentSlot === undefined || modelSlot === undefined)
              return yield* deny("Shared model call capacity exhausted");
            const reservationId = yield* crypto.randomUUIDv4;
            yield* sql`INSERT INTO project_team_model_request (
        reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
        operation_id,request_id,request_lane,request_scope,route_id,provider,model,
        environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
        status,capacity_state,charged_input_tokens,charged_output_tokens,reservation_json)
        VALUES(${reservationId},${policy.environmentId},${operation.projectId},${operation.rootTaskId},
          ${operation.bindingId},${operation.attemptId},${operation.workerId},${operation.generation},
          ${operation.operationId},${reservation.requestId},'memory',${scope},${reservation.routeId},
          ${provider},${model},${environmentSlot},${modelSlot},${reservation.maxInputTokens},
          ${reservation.maxOutputTokens},${reservation.deadlineAtMs},'held','held',0,0,
          ${canonicalProjectWorkPayload(reservation)})`;
            yield* options.assertCurrentInTransaction(owner);
            yield* clockCheck(reservation.deadlineAtMs);
            return { reservationId, reservation, status: "reserved" as const };
          }).pipe(Effect.provideService(ProjectWorkRepository, repository)),
        );
      },
      Effect.mapError((error) =>
        isMemoryServiceError(error) ? error : deny("Memory model reservation denied"),
      ),
    );
    const settle = Effect.fn("ProjectMemoryModelAccounting.settle")(
      function* (input: ProjectMemorySettlement) {
        yield* owning();
        const settlement = yield* decodeSettlementInput(input);
        const {
          reservationId,
          outcome,
          chargedInputTokens,
          chargedOutputTokens,
          transportDrained,
          reportedModel,
          reportedInputTokens,
          reportedOutputTokens,
          ...reservation
        } = settlement;
        if (
          outcome === "reported"
            ? !sameReportedModel(reportedModel, reservation.model) ||
              reportedInputTokens !== chargedInputTokens ||
              reportedOutputTokens !== chargedOutputTokens ||
              chargedInputTokens > reservation.maxInputTokens ||
              chargedOutputTokens > reservation.maxOutputTokens
            : chargedInputTokens !== reservation.maxInputTokens ||
              chargedOutputTokens !== reservation.maxOutputTokens
        )
          return yield* deny("Memory settlement charge is not proved");
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* savedOwner(reservation.effectId);
            const ledger = yield* auditProjectMemoryOperationLedger(sql, owner.operation);
            const row = ledger.rows.find((entry) => entry.reservation_id === reservationId);
            if (
              row === undefined ||
              !same(yield* decodeReservation(row.reservation_json), reservation)
            )
              return yield* deny("Memory settlement has no identical reserved stage");
            if (row.status !== "held") {
              if (
                row.settlement_json === null ||
                row.accounting_receipt_id === null ||
                !same(yield* decodeSettlement(row.settlement_json), settlement)
              )
                return yield* deny("Retained memory settlement changed");
              return { accountingReceiptId: row.accounting_receipt_id };
            }
            if (transportDrained)
              yield* options.assertTransportDrainedInTransaction(reservationId, reservation);
            const accountingReceiptId = yield* crypto.randomUUIDv4;
            yield* sql`UPDATE project_team_model_request SET status=${outcome},
        capacity_state=${transportDrained ? "released" : "quarantine"},
        charged_input_tokens=${chargedInputTokens},charged_output_tokens=${chargedOutputTokens},
        accounting_receipt_id=${accountingReceiptId},settlement_json=${canonicalProjectWorkPayload(settlement)}
        WHERE reservation_id=${reservationId} AND request_lane='memory' AND status='held'`;
            yield* auditProjectMemoryOperationLedger(sql, owner.operation);
            return { accountingReceiptId };
          }).pipe(Effect.provideService(ProjectWorkRepository, repository)),
        );
      },
      Effect.mapError((error) =>
        isMemoryServiceError(error) ? error : deny("Memory model settlement denied"),
      ),
    );
    const confirmTransportDrained = Effect.fn(
      "ProjectMemoryModelAccounting.confirmTransportDrained",
    )(
      function* (effectId: string, reservationId: string) {
        yield* owning();
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* savedOwner(effectId);
            const ledger = yield* auditProjectMemoryOperationLedger(sql, owner.operation);
            const row = ledger.rows.find((entry) => entry.reservation_id === reservationId);
            if (
              row === undefined ||
              row.status === "held" ||
              row.settlement_json === null ||
              row.accounting_receipt_id === null
            )
              return yield* deny("Memory drain requires an original settled reservation");
            const settlement = yield* decodeSettlement(row.settlement_json);
            const reservation = yield* decodeReservation(row.reservation_json);
            yield* options.assertTransportDrainedInTransaction(reservationId, reservation);
            if (!settlement.transportDrained) {
              yield* sql`UPDATE project_team_model_request SET capacity_state='released',
          settlement_json=${canonicalProjectWorkPayload({ ...settlement, transportDrained: true })}
          WHERE reservation_id=${reservationId} AND request_lane='memory' AND capacity_state='quarantine'`;
              yield* auditProjectMemoryOperationLedger(sql, owner.operation);
            }
            return { accountingReceiptId: row.accounting_receipt_id };
          }).pipe(Effect.provideService(ProjectWorkRepository, repository)),
        );
      },
      Effect.mapError((error) =>
        isMemoryServiceError(error) ? error : deny("Memory transport drain denied"),
      ),
    );
    return { reserve, settle, confirmTransportDrained };
  },
);
