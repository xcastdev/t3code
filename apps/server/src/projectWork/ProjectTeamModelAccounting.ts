import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import type {
  PiModelAccountingReceipt,
  PiModelRequestReservation,
  PiModelRequestSettlement,
} from "../provider/pi/PiModelBroker.ts";
import {
  ProjectTeamAuthorization,
  type ProjectTeamAuthority,
  type ProjectTeamPrincipal,
} from "./ProjectTeamAuthorization.ts";

export class ModelAccountingError extends Schema.TaggedError<ModelAccountingError>()(
  "ModelAccountingError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ModelAccountingError({ reason });
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_./:@-]{1,256}$/));
const fields = {
  workerId: Id,
  generation: Safe,
  operationId: Id,
  requestId: Positive,
  routeId: Id,
  provider: Schema.Literals(["command-code", "openai-codex"]),
  model: Id,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
  callCount: Schema.Literal(1),
  deadlineAtMs: Positive,
  accountingMode: Schema.optionalKey(Schema.Literal("openai-subscription-monitored")),
  unknownMaximumTokens: Schema.optionalKey(Schema.Literal(64_000)),
};
const Reservation = Schema.Struct(fields);
const InputDetails = Schema.Struct({
  audio_tokens: Schema.optional(Safe),
  cached_tokens: Schema.optional(Safe),
  cache_write_tokens: Schema.optional(Safe),
  cache_creation_input_tokens: Schema.optional(Safe),
  cache_read_input_tokens: Schema.optional(Safe),
  text_tokens: Schema.optional(Safe),
  image_tokens: Schema.optional(Safe),
  video_tokens: Schema.optional(Safe),
});
const OutputDetails = Schema.Struct({
  reasoning_tokens: Schema.optional(Safe),
  accepted_prediction_tokens: Schema.optional(Safe),
  rejected_prediction_tokens: Schema.optional(Safe),
  audio_tokens: Schema.optional(Safe),
});
const Settlement = Schema.Struct({
  ...fields,
  reservationId: Id,
  transportDrained: Schema.optional(Schema.Boolean),
  outcome: Schema.Literals(["reported", "failed", "unknown"]),
  failureCode: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^(?:[A-Z_]{1,64}|TRANSPORT_RESPONSE_HTTP_[1-5][0-9]{2})$/),
    ),
  ),
  chargedInputTokens: Safe,
  chargedOutputTokens: Safe,
  reportedModel: Schema.optional(Id),
  reportedUsage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Safe,
      completion_tokens: Safe,
      total_tokens: Safe,
      prompt_tokens_details: Schema.optional(Schema.NullOr(InputDetails)),
      completion_tokens_details: Schema.optional(Schema.NullOr(OutputDetails)),
      prompt_cache_hit_tokens: Schema.optional(Safe),
      prompt_cache_miss_tokens: Schema.optional(Safe),
      cached_tokens: Schema.optional(Safe),
    }),
  ),
});
const Policy = Schema.Struct({
  environmentId: Id,
  routeId: Id,
  model: Id,
  maximumConcurrentCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
  maximumConcurrentModelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
  acceptedReportedModels: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
// Root ceilings identify the cumulative journal; operation ceilings bound this request's owner.
const Operation = Schema.Struct({
  workerId: Id,
  operationId: Id,
  rootTaskId: Id,
  maximumTokens: Positive,
  deadlineAtMs: Positive,
  operationMaximumTokens: Positive,
  operationDeadlineAtMs: Positive,
});
const strict = { onExcessProperty: "error" } as const;
const encodeReservation = Schema.encodeSync(Schema.fromJsonString(Reservation));
const encodeSettlement = Schema.encodeSync(Schema.fromJsonString(Settlement));
const decodeReservationJson = Schema.decodeSync(Schema.fromJsonString(Reservation), strict);
const decodeSettlementJson = Schema.decodeSync(Schema.fromJsonString(Settlement), strict);
const validate = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(
    schema,
    strict,
  )(value).pipe(Effect.mapError(() => deny("Invalid accounting input")));
const sum = (a: number, b: number) => (Number.isSafeInteger(a + b) ? a + b : undefined);
const storedReservation = (json: string) =>
  Effect.try({
    try: () => {
      if (Buffer.byteLength(json) > 8192) throw deny("Invalid journal");
      return decodeReservationJson(json);
    },
    catch: () => deny("Invalid accounting journal"),
  });
const storedSettlement = (json: string) =>
  Effect.try({
    try: () => {
      if (Buffer.byteLength(json) > 16384) throw deny("Invalid journal");
      return decodeSettlementJson(json);
    },
    catch: () => deny("Invalid accounting journal"),
  });
type Row = {
  reservation_id: string;
  environment_id: string;
  project_id: string;
  root_task_id: string;
  run_id: string;
  attempt_id: string;
  worker_id: string;
  generation: number;
  operation_id: string;
  request_lane: string;
  request_scope: string;
  request_id: number;
  route_id: string;
  provider: string;
  model: string;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  deadline_at_ms: number;
  status: string;
  capacity_state: "held" | "released" | "quarantine" | "legacy";
  charged_input_tokens: number;
  charged_output_tokens: number;
  accounting_receipt_id: string | null;
  accounting_mode: string;
  unknown_maximum_tokens: number | null;
  reservation_json: string;
  settlement_json: string | null;
};
const matchesReservation = (row: Row, reservation: PiModelRequestReservation) =>
  row.request_lane === "pi" &&
  row.request_scope === "" &&
  row.worker_id === reservation.workerId &&
  row.generation === reservation.generation &&
  row.operation_id === reservation.operationId &&
  row.request_id === reservation.requestId &&
  row.route_id === reservation.routeId &&
  row.provider === reservation.provider &&
  row.model === reservation.model &&
  row.maximum_input_tokens === reservation.maxInputTokens &&
  row.maximum_output_tokens === reservation.maxOutputTokens &&
  row.deadline_at_ms === reservation.deadlineAtMs;

const RecordedRow = Schema.Struct({
  reservation_id: Id,
  environment_id: Id,
  project_id: Id,
  root_task_id: Id,
  run_id: Id,
  attempt_id: Id,
  worker_id: Id,
  generation: Safe,
  operation_id: Id,
  request_lane: Schema.Literals(["pi", "memory"]),
  request_scope: Schema.String.check(Schema.isMaxLength(256)),
  request_id: Positive,
  route_id: Id,
  provider: Schema.Literals(["command-code", "openai-codex", "openrouter"]),
  model: Id,
  maximum_input_tokens: Positive,
  maximum_output_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["held", "reported", "failed", "unknown"]),
  capacity_state: Schema.Literals(["held", "released", "quarantine", "legacy"]),
  charged_input_tokens: Safe,
  charged_output_tokens: Safe,
  accounting_receipt_id: Schema.NullOr(Id),
  accounting_mode: Schema.Literals(["hard", "openai-subscription-monitored"]),
  unknown_maximum_tokens: Schema.NullOr(Schema.Literal(64_000)),
  reservation_json: Schema.String.check(
    Schema.makeFilter((value) => Buffer.byteLength(value) <= 8192),
  ),
  settlement_json: Schema.NullOr(
    Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= 16384)),
  ),
});
export const decodeProjectTeamRecordedModelRow = Schema.decodeUnknownEffect(RecordedRow, strict);

/** Display reads reuse the native reservation/settlement protocol without admitting requests. */
export const auditProjectTeamRecordedPiModelRow = Effect.fn(
  "ProjectTeamModelAccounting.auditRecordedPiRow",
)(function* (
  row: typeof RecordedRow.Type,
  terminalAccounting?: readonly PiModelAccountingReceipt[],
) {
  const reservation = yield* storedReservation(row.reservation_json);
  const monitored = reservation.accountingMode === "openai-subscription-monitored";
  if (
    monitored !== (row.provider === "openai-codex") ||
    (monitored
      ? row.accounting_mode !== "openai-subscription-monitored"
      : row.accounting_mode !== "hard") ||
    row.unknown_maximum_tokens !== (monitored ? 64_000 : null) ||
    (monitored && reservation.unknownMaximumTokens !== 64_000) ||
    (row.provider === "openai-codex" && row.route_id !== "openai-subscription-luna")
  )
    return yield* deny("Recorded subscription accounting mode differs");
  if (!matchesReservation(row, reservation))
    return yield* deny("Recorded native reservation differs");
  if (row.status === "held") {
    if (
      row.capacity_state !== "held" ||
      row.settlement_json !== null ||
      row.accounting_receipt_id !== null ||
      row.charged_input_tokens !== 0 ||
      row.charged_output_tokens !== 0
    )
      return yield* deny("Recorded held native request differs");
    return;
  }
  if (!row.settlement_json || !row.accounting_receipt_id)
    return yield* deny("Recorded native settlement missing");
  const settlement = yield* storedSettlement(row.settlement_json);
  const {
    reservationId,
    outcome,
    failureCode: _failure,
    chargedInputTokens,
    chargedOutputTokens,
    reportedModel,
    reportedUsage,
    transportDrained,
    ...settledReservation
  } = settlement;
  const chargedUsageMismatch =
    outcome === "reported"
      ? reportedUsage === undefined ||
        reportedModel === undefined ||
        reportedUsage.prompt_tokens !== chargedInputTokens ||
        reportedUsage.completion_tokens !== chargedOutputTokens ||
        reportedUsage.total_tokens !== chargedInputTokens + chargedOutputTokens ||
        (!monitored &&
          (chargedInputTokens > reservation.maxInputTokens ||
            chargedOutputTokens > reservation.maxOutputTokens))
      : outcome === "unknown"
        ? chargedInputTokens !== reservation.maxInputTokens ||
          chargedOutputTokens !== (monitored ? 64_000 : reservation.maxOutputTokens)
        : monitored
          ? chargedInputTokens !==
              Math.max(reservation.maxInputTokens, reportedUsage?.prompt_tokens ?? 0) ||
            chargedOutputTokens !==
              Math.max(reservation.maxOutputTokens, reportedUsage?.completion_tokens ?? 0)
          : chargedInputTokens !== reservation.maxInputTokens ||
            chargedOutputTokens !== reservation.maxOutputTokens;
  if (terminalAccounting !== undefined) {
    const receipts = terminalAccounting.filter(
      (receipt) => receipt.reservationId === row.reservation_id,
    );
    const receipt = receipts[0];
    if (receipts.length > 1 || (outcome === "reported" && receipt === undefined))
      return yield* deny("Recorded native settlement lacks its terminal receipt");
    if (
      receipt !== undefined &&
      (receipt.accountingReceiptId !== row.accounting_receipt_id ||
        receipt.requestId !== row.request_id ||
        receipt.routeId !== row.route_id ||
        receipt.provider !== row.provider ||
        receipt.model !== row.model ||
        receipt.reportedModel !== reportedModel ||
        reportedUsage === undefined ||
        canonicalProjectWorkPayload(receipt.usage) !== canonicalProjectWorkPayload(reportedUsage))
    )
      return yield* deny("Recorded native settlement differs from its terminal receipt");
  }
  if (
    encodeReservation(settledReservation) !== encodeReservation(reservation) ||
    reservationId !== row.reservation_id ||
    outcome !== row.status ||
    chargedInputTokens !== row.charged_input_tokens ||
    chargedOutputTokens !== row.charged_output_tokens ||
    row.capacity_state !==
      (monitored && outcome === "unknown"
        ? "quarantine"
        : transportDrained === true
          ? "released"
          : "quarantine") ||
    (outcome === "reported" && terminalAccounting === undefined && reportedModel !== row.model) ||
    chargedUsageMismatch
  )
    return yield* deny("Recorded native settlement differs");
});
export interface ProjectTeamModelAccountingOptions {
  readonly environmentId: string;
  readonly maximumConcurrentCalls?: number;
  readonly maximumConcurrentModelCalls?: number;
  readonly routeId: string;
  readonly model: string;
  readonly acceptedReportedModels: ReadonlyArray<string>;
  /** Private, immutable authority for the one approved OpenAI subscription test root. */
  readonly subscriptionTest?: ProjectTeamPiSubscriptionTestSelection;
  /** Read the durable operation and ancestral root limits using the transaction's SQL context. */
  readonly resolveOperation: (
    authority: ProjectTeamAuthority,
    reservation: PiModelRequestReservation,
  ) => Effect.Effect<typeof Operation.Type, ModelAccountingError>;
}

export interface ProjectTeamPiSubscriptionTestSelection {
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly model: "gpt-6-luna";
  readonly maximumTokens: 64_000;
  readonly maximumDurationMs: 300_000;
}

const SubscriptionSelection = Schema.Struct({
  projectId: Id,
  rootTaskId: Id,
  model: Schema.Literal("gpt-6-luna"),
  maximumTokens: Schema.Literal(64_000),
  maximumDurationMs: Schema.Literal(300_000),
});
const decodeSubscriptionSelection = Schema.decodeUnknownSync(SubscriptionSelection, strict);
export class ProjectTeamModelAccounting extends Context.Service<
  ProjectTeamModelAccounting,
  {
    readonly reserve: (
      principal: ProjectTeamPrincipal,
      reservation: PiModelRequestReservation,
    ) => Effect.Effect<
      { readonly reservationId: string; readonly status: "reserved" | "existing" },
      ModelAccountingError
    >;
    readonly settle: (
      settlement: PiModelRequestSettlement,
    ) => Effect.Effect<{ readonly accountingReceiptId: string }, ModelAccountingError>;
  }
>()("t3/projectWork/ProjectTeamModelAccounting") {}

/** An existing receipt acknowledges the original request; the broker must never transport it again. */
export const make = Effect.fn("ProjectTeamModelAccounting.make")(function* (
  options: ProjectTeamModelAccountingOptions,
) {
  const policy = yield* validate(Policy, {
    environmentId: options.environmentId,
    routeId: options.routeId,
    model: options.model,
    maximumConcurrentCalls:
      options.maximumConcurrentCalls === undefined ? 2 : options.maximumConcurrentCalls,
    maximumConcurrentModelCalls:
      options.maximumConcurrentModelCalls === undefined ? 2 : options.maximumConcurrentModelCalls,
    acceptedReportedModels: options.acceptedReportedModels,
  });
  const subscriptionTest =
    options.subscriptionTest === undefined
      ? undefined
      : yield* validate(SubscriptionSelection, { ...options.subscriptionTest });
  if (typeof options.resolveOperation !== "function")
    return yield* deny("Operation authority required");
  const sql = yield* SqlClient.SqlClient;
  const authorization = yield* ProjectTeamAuthorization;
  const crypto = yield* Crypto.Crypto;
  const assertTransactionOwner = Effect.fn("ProjectTeamModelAccounting.assertTransactionOwner")(
    function* () {
      const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(currentClient) && currentClient.value !== sql)
        return yield* deny("Accounting must use its captured SQL client");
      // A savepoint cannot provide a receipt committed independently of its enclosing transaction.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Accounting must own its SQL transaction");
    },
  );
  const clockCheck = Effect.fn("ProjectTeamModelAccounting.clockCheck")(function* (
    deadline: number,
  ) {
    if (!Number.isSafeInteger(deadline) || (yield* Clock.currentTimeMillis) >= deadline)
      return yield* deny("Model request deadline expired");
  });
  const reserve = Effect.fn("ProjectTeamModelAccounting.reserve")(
    function* (principal: ProjectTeamPrincipal, input: PiModelRequestReservation) {
      yield* assertTransactionOwner();
      const reservation = yield* validate(Reservation, input);
      const maximum = sum(reservation.maxInputTokens, reservation.maxOutputTokens);
      if (maximum === undefined) return yield* deny("Model reservation exceeds numeric bounds");
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const authority = yield* authorization.resolve(principal);
          if (
            !authority ||
            authority.binding.status !== "running" ||
            authority.binding.generation !== reservation.generation ||
            authority.binding.environmentId !== policy.environmentId ||
            (reservation.accountingMode === "openai-subscription-monitored"
              ? !subscriptionTest ||
                reservation.provider !== "openai-codex" ||
                reservation.model !== subscriptionTest.model ||
                authority.binding.model !== subscriptionTest.model ||
                reservation.routeId !== "openai-subscription-luna" ||
                authority.binding.projectId !== subscriptionTest.projectId
              : reservation.provider !== "command-code" ||
                authority.binding.model !== policy.model ||
                reservation.model !== policy.model ||
                reservation.routeId !== policy.routeId)
          )
            return yield* deny("Model request authority denied");
          const operation = yield* validate(
            Operation,
            yield* options.resolveOperation(authority, reservation),
          );
          const binding = authority.binding;
          if (
            operation.workerId !== reservation.workerId ||
            operation.operationId !== reservation.operationId ||
            reservation.deadlineAtMs > operation.operationDeadlineAtMs ||
            reservation.deadlineAtMs > operation.deadlineAtMs ||
            maximum > operation.operationMaximumTokens ||
            maximum > binding.configuration.maxTokens ||
            (reservation.accountingMode === "openai-subscription-monitored" &&
              (reservation.unknownMaximumTokens !== 64_000 ||
                reservation.maxInputTokens + reservation.maxOutputTokens >
                  subscriptionTest!.maximumTokens ||
                operation.rootTaskId !== subscriptionTest!.rootTaskId ||
                operation.maximumTokens > subscriptionTest!.maximumTokens))
          ) {
            return yield* deny("Model operation policy mismatch");
          }
          const deadline = Math.min(
            reservation.deadlineAtMs,
            operation.deadlineAtMs,
            operation.operationDeadlineAtMs,
            Option.getOrElse(
              DateTime.make(
                authority.state.attempts.find((a) => a.attemptId === binding.attemptId)
                  ?.leasedUntil ?? "",
              ).pipe(Option.map(DateTime.toEpochMillis)),
              () => 0,
            ),
          );
          yield* clockCheck(deadline);
          if (reservation.accountingMode === "openai-subscription-monitored") {
            const grant = yield* sql<{
              model: string;
              route_id: string;
              maximum_tokens: number;
              maximum_duration_ms: number;
              deadline_at_ms: number;
              stopped_at_ms: number | null;
            }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms
              FROM project_team_pi_subscription_grant WHERE environment_id=${policy.environmentId}
              AND project_id=${binding.projectId} AND root_task_id=${operation.rootTaskId}`;
            const currentTime = yield* Clock.currentTimeMillis;
            if (!grant[0]) {
              if (operation.deadlineAtMs - currentTime > subscriptionTest!.maximumDurationMs)
                return yield* deny("Subscription root deadline exceeds its approved duration");
              yield* sql`INSERT INTO project_team_pi_subscription_grant
                (environment_id,project_id,root_task_id,model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms)
                VALUES (${policy.environmentId},${binding.projectId},${operation.rootTaskId},${subscriptionTest!.model},'openai-subscription-luna',${subscriptionTest!.maximumTokens},${subscriptionTest!.maximumDurationMs},${operation.deadlineAtMs})`;
            } else if (
              grant[0].model !== subscriptionTest!.model ||
              grant[0].route_id !== "openai-subscription-luna" ||
              grant[0].maximum_tokens !== subscriptionTest!.maximumTokens ||
              grant[0].maximum_duration_ms !== subscriptionTest!.maximumDurationMs ||
              grant[0].deadline_at_ms !== operation.deadlineAtMs ||
              grant[0].stopped_at_ms !== null
            )
              return yield* deny("Subscription root grant is stopped or changed");
          }
          const legacy = yield* sql<{
            reservation_id: string;
          }>`SELECT reservation_id FROM project_team_model_request WHERE environment_id=${policy.environmentId} AND capacity_state='legacy' LIMIT 1`;
          if (legacy.length > 0)
            return yield* deny("Legacy model transport requires reconciliation");
          const budgets = yield* sql<{
            maximum_tokens: number;
            deadline_at_ms: number;
          }>`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${policy.environmentId} AND project_id=${binding.projectId} AND root_task_id=${operation.rootTaskId}`;
          const budget = budgets[0];
          if (
            budget &&
            (budget.maximum_tokens !== operation.maximumTokens ||
              budget.deadline_at_ms !== operation.deadlineAtMs)
          )
            return yield* deny("Frozen root budget changed");
          const existing =
            yield* sql<Row>`SELECT * FROM project_team_model_request WHERE worker_id=${reservation.workerId} AND generation=${reservation.generation} AND operation_id=${reservation.operationId} AND request_id=${reservation.requestId}
              AND request_lane='pi' AND request_scope=''`;
          const previous = existing[0];
          if (previous) {
            const persisted = yield* storedReservation(previous.reservation_json);
            if (
              !matchesReservation(previous, reservation) ||
              encodeReservation(persisted) !== encodeReservation(reservation) ||
              previous.environment_id !== policy.environmentId ||
              previous.project_id !== binding.projectId ||
              previous.root_task_id !== operation.rootTaskId ||
              previous.run_id !== binding.recordId ||
              previous.attempt_id !== binding.attemptId ||
              previous.accounting_mode !==
                (reservation.accountingMode === "openai-subscription-monitored"
                  ? "openai-subscription-monitored"
                  : "hard") ||
              previous.unknown_maximum_tokens !==
                (reservation.accountingMode === "openai-subscription-monitored" ? 64_000 : null)
            )
              return yield* deny("Model request identity changed");
            yield* clockCheck(deadline);
            return { reservationId: previous.reservation_id, status: "existing" as const };
          }
          if (!budget)
            yield* sql`INSERT INTO project_team_model_budget VALUES(${policy.environmentId},${binding.projectId},${operation.rootTaskId},${operation.maximumTokens},${operation.deadlineAtMs})`;
          const usage = yield* sql<{
            input: number;
            output: number;
          }>`SELECT COALESCE(SUM(CASE WHEN ${reservation.accountingMode === "openai-subscription-monitored" ? 1 : 0} THEN charged_input_tokens ELSE CASE WHEN status='held' THEN maximum_input_tokens ELSE charged_input_tokens END END),0) AS input,COALESCE(SUM(CASE WHEN ${reservation.accountingMode === "openai-subscription-monitored" ? 1 : 0} THEN charged_output_tokens ELSE CASE WHEN status='held' THEN maximum_output_tokens ELSE charged_output_tokens END END),0) AS output FROM project_team_model_request WHERE environment_id=${policy.environmentId} AND project_id=${binding.projectId} AND root_task_id=${operation.rootTaskId}`;
          const charged = usage[0];
          const used = charged ? sum(charged.input, charged.output) : undefined;
          const total = used === undefined ? undefined : sum(used, maximum);
          if (
            total === undefined ||
            (reservation.accountingMode === "openai-subscription-monitored"
              ? used === undefined || used >= 64_000
              : total > operation.maximumTokens)
          )
            return yield* deny("Root model budget exhausted");
          // The root can contain several attempts. Every lane and operation in
          // this original attempt consumes its admitted attempt ceiling.
          const attempts = yield* sql<{ maximum: number | null; deadline: number | null }>`SELECT
            CASE WHEN json_type(intent_json,'$.limits.attemptMaximumTokens')='integer'
              THEN json_extract(intent_json,'$.limits.attemptMaximumTokens') END AS maximum,
            CASE WHEN json_type(intent_json,'$.limits.deadlineAtMs')='integer'
              THEN json_extract(intent_json,'$.limits.deadlineAtMs') END AS deadline
            FROM project_team_dispatch WHERE environment_id=${policy.environmentId}
              AND binding_id=${binding.recordId} AND generation=${binding.generation} LIMIT 2`;
          const originalAttempt = attempts[0];
          if (
            attempts.length > 1 ||
            (originalAttempt !== undefined &&
              (originalAttempt.maximum === null ||
                originalAttempt.deadline === null ||
                !Number.isSafeInteger(originalAttempt.maximum) ||
                originalAttempt.maximum <= 0 ||
                !Number.isSafeInteger(originalAttempt.deadline) ||
                originalAttempt.deadline <= 0))
          )
            return yield* deny("Original model attempt limits are unavailable");
          const attemptMaximum = Math.min(
            binding.configuration.maxTokens,
            originalAttempt?.maximum ?? binding.configuration.maxTokens,
          );
          yield* clockCheck(Math.min(deadline, originalAttempt?.deadline ?? deadline));
          const attemptUsage = yield* sql<{ tokens: number }>`SELECT
            COALESCE(SUM(CASE WHEN ${reservation.accountingMode === "openai-subscription-monitored" ? 1 : 0} THEN charged_input_tokens+charged_output_tokens
              WHEN status='held' THEN maximum_input_tokens+maximum_output_tokens
              ELSE charged_input_tokens+charged_output_tokens END),0) AS tokens
            FROM project_team_model_request WHERE environment_id=${policy.environmentId}
              AND project_id=${binding.projectId} AND run_id=${binding.recordId}
              AND generation=${binding.generation} AND attempt_id=${binding.attemptId}`;
          const attemptBase = attemptUsage[0]?.tokens ?? -1;
          const attemptTotal =
            reservation.accountingMode === "openai-subscription-monitored"
              ? attemptBase
              : sum(attemptBase, maximum);
          if (
            attemptTotal === undefined ||
            (attemptUsage[0]?.tokens ?? -1) < 0 ||
            !Number.isSafeInteger(attemptUsage[0]?.tokens) ||
            attemptTotal > attemptMaximum ||
            (reservation.accountingMode === "openai-subscription-monitored" &&
              attemptTotal >= attemptMaximum)
          )
            return yield* deny("Original attempt model budget exhausted");
          const operationUsage = yield* sql<{ tokens: number }>`SELECT
            COALESCE(SUM(CASE WHEN ${reservation.accountingMode === "openai-subscription-monitored" ? 1 : 0} THEN charged_input_tokens+charged_output_tokens
              WHEN status='held' THEN maximum_input_tokens+maximum_output_tokens
              ELSE charged_input_tokens+charged_output_tokens END),0) AS tokens
            FROM project_team_model_request WHERE environment_id=${policy.environmentId}
            AND project_id=${binding.projectId} AND run_id=${binding.recordId}
            AND generation=${binding.generation} AND operation_id=${reservation.operationId}`;
          const usedOperation = operationUsage[0]?.tokens;
          if (
            usedOperation === undefined ||
            !Number.isSafeInteger(usedOperation) ||
            usedOperation < 0 ||
            (reservation.accountingMode === "openai-subscription-monitored"
              ? usedOperation >= operation.operationMaximumTokens
              : !Number.isSafeInteger(usedOperation + maximum) ||
                usedOperation + maximum > operation.operationMaximumTokens)
          )
            return yield* deny("Original operation model budget exhausted");
          const slots = yield* sql<{
            environment_slot: number;
            model_slot: number;
            model: string;
          }>`SELECT environment_slot,model_slot,model FROM project_team_model_request WHERE environment_id=${policy.environmentId} AND capacity_state IN ('held','quarantine')`;
          const environmentSlot = Array.from(
            { length: policy.maximumConcurrentCalls },
            (_, i) => i,
          ).find((i) => !slots.some((row) => row.environment_slot === i));
          const modelSlot = Array.from(
            { length: policy.maximumConcurrentModelCalls },
            (_, i) => i,
          ).find(
            (i) => !slots.some((row) => row.model === reservation.model && row.model_slot === i),
          );
          if (environmentSlot === undefined || modelSlot === undefined)
            return yield* deny("Model call capacity exhausted");
          const reservationId = yield* crypto.randomUUIDv4;
          yield* sql`INSERT INTO project_team_model_request (reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,charged_input_tokens,charged_output_tokens,reservation_json,accounting_mode,unknown_maximum_tokens) VALUES (${reservationId},${policy.environmentId},${binding.projectId},${operation.rootTaskId},${binding.recordId},${binding.attemptId},${reservation.workerId},${reservation.generation},${reservation.operationId},${reservation.requestId},${reservation.routeId},${reservation.provider},${reservation.model},${environmentSlot},${modelSlot},${reservation.maxInputTokens},${reservation.maxOutputTokens},${reservation.deadlineAtMs},'held','held',0,0,${encodeReservation(reservation)},${reservation.accountingMode === "openai-subscription-monitored" ? "openai-subscription-monitored" : "hard"},${reservation.unknownMaximumTokens ?? null})`;
          yield* clockCheck(deadline);
          return { reservationId, status: "reserved" as const };
        }),
      );
    },
    Effect.mapError(() => deny("Model reservation denied")),
  );
  const settle = Effect.fn("ProjectTeamModelAccounting.settle")(
    function* (input: PiModelRequestSettlement) {
      yield* assertTransactionOwner();
      const settlement = yield* validate(Settlement, input);
      if (sum(settlement.maxInputTokens, settlement.maxOutputTokens) === undefined)
        return yield* deny("Invalid settlement bounds");
      const usage = settlement.reportedUsage;
      if (settlement.outcome === "reported" && (!usage || !settlement.reportedModel))
        return yield* deny("Reported usage required");
      if (settlement.outcome === "unknown" && usage !== undefined)
        return yield* deny("Unknown usage cannot include partial reported usage");
      if ((usage === undefined) !== (settlement.reportedModel === undefined))
        return yield* deny("Incomplete reported usage");
      if (
        usage &&
        (!policy.acceptedReportedModels.includes(settlement.reportedModel ?? "") ||
          sum(usage.prompt_tokens, usage.completion_tokens) !== usage.total_tokens ||
          (settlement.accountingMode !== "openai-subscription-monitored" &&
            (usage.prompt_tokens > settlement.maxInputTokens ||
              usage.completion_tokens > settlement.maxOutputTokens)) ||
          Object.values(usage.prompt_tokens_details ?? {}).some(
            (n) => n !== undefined && n > usage.prompt_tokens,
          ) ||
          Object.values(usage.completion_tokens_details ?? {}).some(
            (n) => n !== undefined && n > usage.completion_tokens,
          ) ||
          [usage.prompt_cache_hit_tokens, usage.prompt_cache_miss_tokens, usage.cached_tokens].some(
            (n) => n !== undefined && n > usage.prompt_tokens,
          ))
      )
        return yield* deny("Invalid reported usage");
      let inputCharge =
        settlement.outcome === "reported"
          ? usage!.prompt_tokens
          : Math.max(usage?.prompt_tokens ?? 0, settlement.maxInputTokens);
      let outputCharge =
        settlement.outcome === "reported"
          ? usage!.completion_tokens
          : settlement.accountingMode === "openai-subscription-monitored" &&
              settlement.outcome === "unknown"
            ? (settlement.unknownMaximumTokens ?? 64_000)
            : Math.max(usage?.completion_tokens ?? 0, settlement.maxOutputTokens);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<Row>`SELECT * FROM project_team_model_request WHERE reservation_id=${settlement.reservationId}
              AND request_lane='pi' AND request_scope=''`;
          const row = rows[0];
          if (
            !row ||
            row.environment_id !== policy.environmentId ||
            (settlement.accountingMode === "openai-subscription-monitored"
              ? row.route_id !== "openai-subscription-luna" ||
                row.model !== "gpt-6-luna" ||
                row.provider !== "openai-codex"
              : row.route_id !== policy.routeId ||
                row.model !== policy.model ||
                row.provider !== "command-code")
          )
            return yield* deny("Reservation unavailable");
          const reservation = yield* storedReservation(row.reservation_json);
          const supplied = yield* validate(
            Reservation,
            Object.fromEntries(
              Object.keys(fields)
                .filter((key) => Object.hasOwn(settlement, key))
                .map((key) => [key, Reflect.get(settlement, key)]),
            ),
          );
          if (
            encodeReservation(reservation) !== encodeReservation(supplied) ||
            !matchesReservation(row, reservation) ||
            row.accounting_mode !==
              (reservation.accountingMode === "openai-subscription-monitored"
                ? "openai-subscription-monitored"
                : "hard") ||
            row.unknown_maximum_tokens !==
              (reservation.accountingMode === "openai-subscription-monitored" ? 64_000 : null)
          )
            return yield* deny("Settlement identity changed");
          if (reservation.accountingMode === "openai-subscription-monitored") {
            const grants = yield* sql<{
              model: string;
              route_id: string;
              maximum_tokens: number;
              maximum_duration_ms: number;
              deadline_at_ms: number;
            }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms
              FROM project_team_pi_subscription_grant WHERE environment_id=${row.environment_id}
              AND project_id=${row.project_id} AND root_task_id=${row.root_task_id}`;
            const grant = grants[0];
            if (
              !grant ||
              grant.model !== reservation.model ||
              grant.route_id !== reservation.routeId ||
              grant.maximum_tokens !== 64_000 ||
              grant.maximum_duration_ms !== 300_000 ||
              grant.deadline_at_ms < reservation.deadlineAtMs
            )
              return yield* deny("Durable subscription grant changed");
          }
          if (row.status !== "held" && row.settlement_json) {
            const previous = yield* storedSettlement(row.settlement_json);
            inputCharge = Math.max(inputCharge, previous.chargedInputTokens);
            outputCharge = Math.max(outputCharge, previous.chargedOutputTokens);
          }
          if (
            settlement.chargedInputTokens !== inputCharge ||
            settlement.chargedOutputTokens !== outputCharge
          )
            return yield* deny("Invalid settlement charge");
          let committedSettlement = settlement;
          if (row.status !== "held") {
            if (!row.settlement_json || !row.accounting_receipt_id)
              return yield* deny("Settlement journal incomplete");
            const previous = yield* storedSettlement(row.settlement_json);
            // A repeated settlement cannot establish new transport cleanup or release quarantine.
            committedSettlement = {
              ...settlement,
              transportDrained: previous.transportDrained,
            };
            if (
              row.status !== previous.outcome ||
              row.charged_input_tokens !== previous.chargedInputTokens ||
              row.charged_output_tokens !== previous.chargedOutputTokens
            )
              return yield* deny("Settlement journal mismatch");
            if (previous.reportedUsage && previous.reportedModel) {
              if (
                settlement.reportedUsage &&
                encodeSettlement({
                  ...previous,
                  reportedUsage: settlement.reportedUsage,
                  reportedModel: settlement.reportedModel,
                }) !== encodeSettlement(previous)
              )
                return yield* deny("Reported evidence changed");
              committedSettlement = {
                ...committedSettlement,
                reportedUsage: previous.reportedUsage,
                reportedModel: previous.reportedModel,
              };
            }
            if (encodeSettlement(previous) === encodeSettlement(committedSettlement))
              return { accountingReceiptId: row.accounting_receipt_id };
            if (
              previous.outcome !== "reported" ||
              settlement.outcome === "reported" ||
              inputCharge < row.charged_input_tokens ||
              outputCharge < row.charged_output_tokens
            )
              return yield* deny("Settled request cannot be rewritten");
          }
          if (row.status === "held" && row.capacity_state !== "held")
            return yield* deny("Reservation capacity journal mismatch");
          const capacityState =
            settlement.accountingMode === "openai-subscription-monitored" &&
            settlement.outcome === "unknown"
              ? "quarantine"
              : row.status === "held"
                ? settlement.transportDrained === true
                  ? "released"
                  : "quarantine"
                : row.capacity_state;
          const receipt = row.accounting_receipt_id ?? (yield* crypto.randomUUIDv4);
          yield* sql`UPDATE project_team_model_request SET status=${settlement.outcome},capacity_state=${capacityState},charged_input_tokens=${inputCharge},charged_output_tokens=${outputCharge},accounting_receipt_id=${receipt},settlement_json=${encodeSettlement(committedSettlement)} WHERE reservation_id=${row.reservation_id}`;
          if (settlement.accountingMode === "openai-subscription-monitored") {
            const rootUsage = yield* sql<{
              tokens: number;
            }>`SELECT COALESCE(SUM(charged_input_tokens+charged_output_tokens),0) AS tokens
              FROM project_team_model_request WHERE environment_id=${row.environment_id} AND project_id=${row.project_id}
              AND root_task_id=${row.root_task_id}`;
            const breached =
              settlement.outcome === "unknown" || (rootUsage[0]?.tokens ?? 0) >= 64_000;
            if (breached)
              yield* sql`UPDATE project_team_pi_subscription_grant
              SET stopped_at_ms=COALESCE(stopped_at_ms,${yield* Clock.currentTimeMillis}),
                  stop_reason=COALESCE(stop_reason,${settlement.outcome === "unknown" ? "unknown-usage" : "threshold-reached"})
              WHERE environment_id=${row.environment_id} AND project_id=${row.project_id} AND root_task_id=${row.root_task_id}`;
          }
          return { accountingReceiptId: receipt };
        }),
      );
    },
    Effect.mapError(() => deny("Model settlement denied")),
  );
  return ProjectTeamModelAccounting.of({ reserve, settle });
});

export interface ProjectTeamPiSubscriptionGrantIdentity {
  readonly environmentId: string;
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly model: "gpt-6-luna";
  readonly routeId: "openai-subscription-luna";
  readonly maximumTokens: 64_000;
  readonly maximumDurationMs: 300_000;
  readonly deadlineAtMs: number;
}

/** Root composes this with its constructor-captured SQL client for live and native stop checks. */
export const makeProjectTeamPiSubscriptionParentPolicy = (
  sql: SqlClient.SqlClient,
  selection: ProjectTeamPiSubscriptionTestSelection,
) => {
  const frozen = decodeSubscriptionSelection({ ...selection });
  const read = (identity: ProjectTeamPiSubscriptionGrantIdentity) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        model: string;
        route_id: string;
        maximum_tokens: number;
        maximum_duration_ms: number;
        deadline_at_ms: number;
        stopped_at_ms: number | null;
      }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms
        FROM project_team_pi_subscription_grant WHERE environment_id=${identity.environmentId}
        AND project_id=${identity.projectId} AND root_task_id=${identity.rootTaskId}`;
      const row = rows[0];
      if (
        identity.projectId !== frozen.projectId ||
        identity.rootTaskId !== frozen.rootTaskId ||
        identity.model !== frozen.model ||
        identity.maximumTokens !== frozen.maximumTokens ||
        identity.maximumDurationMs !== frozen.maximumDurationMs ||
        identity.routeId !== "openai-subscription-luna"
      )
        return yield* deny("Subscription parent authority differs from its frozen selection");
      if (!row) return undefined;
      if (
        row.model !== frozen.model ||
        row.route_id !== identity.routeId ||
        row.maximum_tokens !== frozen.maximumTokens ||
        row.maximum_duration_ms !== frozen.maximumDurationMs ||
        row.deadline_at_ms !== identity.deadlineAtMs
      )
        return yield* deny("Durable subscription grant is unavailable or changed");
      return row;
    });
  return {
    check: (identity: ProjectTeamPiSubscriptionGrantIdentity) =>
      read(identity).pipe(
        Effect.flatMap((row) =>
          row === undefined || row.stopped_at_ms === null
            ? Effect.void
            : Effect.fail(deny("Subscription root is stopped")),
        ),
      ),
    readStop: (identity: ProjectTeamPiSubscriptionGrantIdentity) =>
      read(identity).pipe(Effect.map((row) => row !== undefined && row.stopped_at_ms !== null)),
  };
};
