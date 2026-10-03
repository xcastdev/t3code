import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
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
  provider: Schema.Literal("command-code"),
  model: Id,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
  callCount: Schema.Literal(1),
  deadlineAtMs: Positive,
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
  failureCode: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z_]{1,64}$/))),
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
  reservation_json: string;
  settlement_json: string | null;
};
const matchesReservation = (row: Row, reservation: PiModelRequestReservation) =>
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
export interface ProjectTeamModelAccountingOptions {
  readonly environmentId: string;
  readonly maximumConcurrentCalls?: number;
  readonly maximumConcurrentModelCalls?: number;
  readonly routeId: string;
  readonly model: string;
  readonly acceptedReportedModels: ReadonlyArray<string>;
  /** Read the durable operation and ancestral root limits using the transaction's SQL context. */
  readonly resolveOperation: (
    authority: ProjectTeamAuthority,
    reservation: PiModelRequestReservation,
  ) => Effect.Effect<typeof Operation.Type, ModelAccountingError>;
}
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
            authority.binding.model !== policy.model ||
            reservation.model !== policy.model ||
            reservation.routeId !== policy.routeId
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
            maximum > binding.configuration.maxTokens
          )
            return yield* deny("Model operation policy mismatch");
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
            yield* sql<Row>`SELECT * FROM project_team_model_request WHERE worker_id=${reservation.workerId} AND generation=${reservation.generation} AND operation_id=${reservation.operationId} AND request_id=${reservation.requestId}`;
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
              previous.attempt_id !== binding.attemptId
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
          }>`SELECT COALESCE(SUM(CASE WHEN status='held' THEN maximum_input_tokens ELSE charged_input_tokens END),0) AS input,COALESCE(SUM(CASE WHEN status='held' THEN maximum_output_tokens ELSE charged_output_tokens END),0) AS output FROM project_team_model_request WHERE environment_id=${policy.environmentId} AND project_id=${binding.projectId} AND root_task_id=${operation.rootTaskId}`;
          const charged = usage[0];
          const used = charged ? sum(charged.input, charged.output) : undefined;
          const total = used === undefined ? undefined : sum(used, maximum);
          if (total === undefined || total > operation.maximumTokens)
            return yield* deny("Root model budget exhausted");
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
          ).find((i) => !slots.some((row) => row.model === policy.model && row.model_slot === i));
          if (environmentSlot === undefined || modelSlot === undefined)
            return yield* deny("Model call capacity exhausted");
          const reservationId = yield* crypto.randomUUIDv4;
          yield* sql`INSERT INTO project_team_model_request (reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,operation_id,request_id,route_id,provider,model,environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,charged_input_tokens,charged_output_tokens,reservation_json) VALUES (${reservationId},${policy.environmentId},${binding.projectId},${operation.rootTaskId},${binding.recordId},${binding.attemptId},${reservation.workerId},${reservation.generation},${reservation.operationId},${reservation.requestId},${reservation.routeId},${reservation.provider},${reservation.model},${environmentSlot},${modelSlot},${reservation.maxInputTokens},${reservation.maxOutputTokens},${reservation.deadlineAtMs},'held','held',0,0,${encodeReservation(reservation)})`;
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
      if ((usage === undefined) !== (settlement.reportedModel === undefined))
        return yield* deny("Incomplete reported usage");
      if (
        usage &&
        (!policy.acceptedReportedModels.includes(settlement.reportedModel ?? "") ||
          sum(usage.prompt_tokens, usage.completion_tokens) !== usage.total_tokens ||
          usage.prompt_tokens > settlement.maxInputTokens ||
          usage.completion_tokens > settlement.maxOutputTokens ||
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
      const inputCharge =
        settlement.outcome === "reported" ? usage!.prompt_tokens : settlement.maxInputTokens;
      const outputCharge =
        settlement.outcome === "reported" ? usage!.completion_tokens : settlement.maxOutputTokens;
      if (
        settlement.chargedInputTokens !== inputCharge ||
        settlement.chargedOutputTokens !== outputCharge
      )
        return yield* deny("Invalid settlement charge");
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<Row>`SELECT * FROM project_team_model_request WHERE reservation_id=${settlement.reservationId}`;
          const row = rows[0];
          if (
            !row ||
            row.environment_id !== policy.environmentId ||
            row.route_id !== policy.routeId ||
            row.model !== policy.model
          )
            return yield* deny("Reservation unavailable");
          const reservation = yield* storedReservation(row.reservation_json);
          const supplied = yield* validate(
            Reservation,
            Object.fromEntries(
              Object.keys(fields).map((key) => [key, Reflect.get(settlement, key)]),
            ),
          );
          if (
            encodeReservation(reservation) !== encodeReservation(supplied) ||
            !matchesReservation(row, reservation)
          )
            return yield* deny("Settlement identity changed");
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
            row.status === "held"
              ? settlement.transportDrained === true
                ? "released"
                : "quarantine"
              : row.capacity_state;
          const receipt = row.accounting_receipt_id ?? (yield* crypto.randomUUIDv4);
          yield* sql`UPDATE project_team_model_request SET status=${settlement.outcome},capacity_state=${capacityState},charged_input_tokens=${inputCharge},charged_output_tokens=${outputCharge},accounting_receipt_id=${receipt},settlement_json=${encodeSettlement(committedSettlement)} WHERE reservation_id=${row.reservation_id}`;
          return { accountingReceiptId: receipt };
        }),
      );
    },
    Effect.mapError(() => deny("Model settlement denied")),
  );
  return ProjectTeamModelAccounting.of({ reserve, settle });
});
