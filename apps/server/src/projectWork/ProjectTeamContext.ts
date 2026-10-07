import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRecord as TeamRecordSchema,
  ProjectWorkTask,
  ProjectWorkCriterion,
  ProjectWorkCriterionWaiver,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkAttemptId,
  EventId,
  IsoDateTime,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import {
  evaluateProjectTeamGate,
  projectTeamSpecificationHash,
  projectTeamPlanHash,
} from "./ProjectTeamPolicy.ts";

// These private codecs match ProjectTeamModelAccounting's retained producer protocol.
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

const strict = { onExcessProperty: "error" } as const;
const decodeRecord = Schema.decodeUnknownEffect(TeamRecordSchema, strict);
const decodeFoundationEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: Schema.String,
      projectId: Schema.String,
      revision: Schema.Int,
      occurredAt: Schema.String,
      type: Schema.Literal("project-work.foundation.recorded"),
      record: TeamRecordSchema,
    }),
  ),
  strict,
);
const decodeRecordJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TeamRecordSchema),
  strict,
);
const decodeTask = Schema.decodeUnknownEffect(ProjectWorkTask, strict);
const decodeCriterion = Schema.decodeUnknownEffect(ProjectWorkCriterion, strict);
const eventFields = {
  eventId: EventId,
  projectId: Schema.String,
  revision: Safe,
  occurredAt: IsoDateTime,
};
// Match the actual retained Decider criterion progress event protocol.
const CriterionEvent = Schema.Union([
  Schema.Struct({
    ...eventFields,
    type: Schema.Literal("project-work.criterion.upserted"),
    taskId: ProjectWorkTaskId,
    criterion: ProjectWorkCriterion,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...eventFields,
    type: Schema.Literal("project-work.criterion.waived"),
    taskId: ProjectWorkTaskId,
    criterionId: ProjectWorkCriterionId,
    waiver: ProjectWorkCriterionWaiver,
    waivedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...eventFields,
    type: Schema.Literal("project-work.task.completed"),
    taskId: ProjectWorkTaskId,
    attemptId: Schema.optionalKey(ProjectWorkAttemptId),
    satisfiedCriterionIds: Schema.Array(ProjectWorkCriterionId),
    completedAt: IsoDateTime,
  }),
]);
const decodeCriterionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CriterionEvent),
  strict,
);
const decodeReservation = Schema.decodeUnknownEffect(Schema.fromJsonString(Reservation), strict);
const decodeSettlement = Schema.decodeUnknownEffect(Schema.fromJsonString(Settlement), strict);
const OperationInput = Schema.Struct({
  projectId: Schema.String,
  bindingId: Id,
  generation: Safe,
  providerInstanceId: Id,
  threadId: Id,
  operationId: Id,
  operationKind: Schema.Literals(["initialize", "prompt"]),
});
const decodeOperationInput = Schema.decodeUnknownEffect(OperationInput, strict);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const Bounds = { contextBytes: 262144, ledgerRows: 4096, ledgerBytes: 16777216 } as const;

export class ProjectTeamContextError extends Schema.TaggedError<ProjectTeamContextError>()(
  "ProjectTeamContextError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamContextError({ reason });
const add = (left: number, right: number) => {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0)
    throw deny("Required limits exceed numeric bounds");
  return total;
};
type RecordOf<K extends ProjectTeamRecord["kind"]> = Extract<ProjectTeamRecord, { kind: K }>;
const ModelRow = Schema.Struct({
  reservation_id: Id,
  environment_id: Id,
  project_id: Schema.String,
  root_task_id: Schema.String,
  run_id: Schema.String,
  attempt_id: Schema.String,
  worker_id: Id,
  generation: Safe,
  operation_id: Id,
  request_id: Positive,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  environment_slot: Safe,
  model_slot: Safe,
  maximum_input_tokens: Positive,
  maximum_output_tokens: Positive,
  deadline_at_ms: Positive,
  status: Schema.Literals(["held", "reported", "failed", "unknown"]),
  capacity_state: Schema.Literals(["held", "released", "quarantine", "legacy"]),
  charged_input_tokens: Safe,
  charged_output_tokens: Safe,
  accounting_receipt_id: Schema.NullOr(Id),
  reservation_json: Schema.String,
  settlement_json: Schema.NullOr(Schema.String),
});
const decodeModelRow = Schema.decodeUnknownEffect(ModelRow, strict);
const reservationFields = (value: typeof Settlement.Type) =>
  Object.fromEntries(Object.keys(fields).map((key) => [key, Reflect.get(value, key)]));

/** A read snapshot only. Root must revalidate the original run immediately before delivery. */
export const makeProjectTeamContext = Effect.fn("makeProjectTeamContext")(function* (options: {
  readonly environmentId: string;
  readonly maximumEnvironmentModelCalls: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sourceService = yield* makeProjectTeamIntegrationSources({
    environmentId: options.environmentId,
  });
  const journal = yield* makeProjectTeamDispatchJournal(options);
  const reviewTargets = yield* makeProjectTeamReviewTargets(options);
  const readRecord = Effect.fn("ProjectTeamContext.readRecord")(function* (
    record: ProjectTeamRecord,
  ) {
    const validated = yield* decodeRecord(record);
    const rows = yield* sql<{
      record_id: string;
      project_id: string;
      status: string;
      revision: number;
      generation: number;
      updated_at: string;
      payload_json: string;
    }>`SELECT record_id,project_id,status,revision,generation,updated_at,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${Bounds.contextBytes} THEN payload_json ELSE NULL END AS payload_json
      FROM ${sql("project_team_" + record.kind.replaceAll("-", "_"))} WHERE record_id=${record.recordId}`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.record_id !== record.recordId ||
      row.project_id !== record.projectId ||
      row.status !== record.status ||
      row.revision !== record.revision ||
      row.generation !== record.generation ||
      row.updated_at !== record.updatedAt ||
      !same(yield* decodeRecordJson(row.payload_json), validated)
    )
      return yield* deny("Required record SQL disagrees with current authority");
    const events = yield* sql<{
      payload_json: string;
      event_id: string;
      project_id: string;
      occurred_at: string;
    }>`SELECT event_id,project_id,occurred_at,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${Bounds.contextBytes} THEN payload_json ELSE NULL END AS payload_json
      FROM project_work_events WHERE project_id=${record.projectId} AND event_type='project-work.foundation.recorded'
      AND json_extract(payload_json,'$.record.recordId')=${record.recordId} ORDER BY sequence DESC LIMIT 1`;
    const storedEvent = events[0];
    if (storedEvent === undefined)
      return yield* deny("Required record retained provenance is missing");
    const event = yield* decodeFoundationEvent(storedEvent.payload_json);
    if (
      event.eventId !== storedEvent.event_id ||
      event.projectId !== storedEvent.project_id ||
      event.occurredAt !== storedEvent.occurred_at ||
      !same(event.record, validated)
    )
      return yield* deny("Required record disagrees with retained event provenance");
    return validated;
  });
  const readLedger = Effect.fn("ProjectTeamContext.readLedger")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    const transition = snapshot.intent.compiledClaim.transition;
    if (transition?.kind !== "claim") return yield* deny("Original claim is missing");
    const binding = transition.binding;
    const limits = snapshot.intent.limits;
    let historyBytes = 0;
    const readOriginals = Effect.fn("ProjectTeamContext.readOriginals")(function* (
      kind: "task-membership" | "run-binding" | "effect",
      selection: Fragment,
    ) {
      const rows = yield* sql<{
        sequence: number;
        event_id: string;
        project_id: string;
        occurred_at: string;
        command_id: string;
        bytes: number;
      }>`SELECT sequence,event_id,project_id,occurred_at,command_id,
        length(CAST(payload_json AS BLOB)) AS bytes
        FROM project_work_events WHERE project_id=${binding.projectId}
        AND event_type='project-work.foundation.recorded'
        AND json_extract(payload_json,'$.record.kind')=${kind}
        AND json_extract(payload_json,'$.record.revision')=0 AND ${selection}
        ORDER BY sequence LIMIT 4097`;
      if (rows.length > Bounds.ledgerRows) return yield* deny("Root claim history exceeds bounds");
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.sequence) ||
          row.sequence <= 0 ||
          !Number.isSafeInteger(row.bytes) ||
          row.bytes < 0 ||
          row.bytes > Bounds.contextBytes
        )
          return yield* deny("Root claim event exceeds bounds");
        historyBytes = add(historyBytes, row.bytes);
      }
      if (historyBytes > Bounds.ledgerBytes)
        return yield* deny("Root claim history exceeds byte bounds");
      return yield* Effect.forEach(
        rows,
        Effect.fn("ProjectTeamContext.decodeOriginal")(function* (row) {
          const payloads = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_work_events
            WHERE project_id=${binding.projectId} AND sequence=${row.sequence} AND event_id=${row.event_id}`;
          if (payloads.length !== 1 || payloads[0] === undefined)
            return yield* deny("Original root claim event is missing");
          const event = yield* decodeFoundationEvent(payloads[0].payload_json);
          if (
            event.eventId !== row.event_id ||
            event.projectId !== binding.projectId ||
            event.projectId !== row.project_id ||
            event.occurredAt !== row.occurred_at ||
            event.record.kind !== kind ||
            event.record.projectId !== binding.projectId ||
            event.record.revision !== 0
          )
            return yield* deny("Root claim retained identity changed");
          return { commandId: row.command_id, record: event.record };
        }),
      );
    });
    // Original domain memberships and claims survive physical dispatch/ledger loss.
    // Parent membership is immutable; read only its original edge, not a replay of task events.
    const roots = yield* readOriginals(
      "task-membership",
      sql`json_extract(payload_json,'$.record.taskId')=${limits.rootTaskId}`,
    );
    if (
      roots.length !== 1 ||
      roots[0]?.record.kind !== "task-membership" ||
      roots[0].record.parentTaskId !== undefined
    )
      return yield* deny("Original root membership is missing or ambiguous");
    const tasks = new Set<string>([limits.rootTaskId]);
    let frontier = [limits.rootTaskId as string];
    let depth = 0;
    while (frontier.length > 0) {
      const children = yield* readOriginals(
        "task-membership",
        sql`json_extract(payload_json,'$.record.parentTaskId') IN ${sql.in(frontier)}`,
      );
      if (children.length > 0 && ++depth >= 9)
        return yield* deny("Original root task lineage exceeds bounds");
      const next: string[] = [];
      for (const child of children) {
        const membership = child.record;
        if (
          membership.kind !== "task-membership" ||
          membership.parentTaskId === undefined ||
          !frontier.includes(membership.parentTaskId) ||
          tasks.has(membership.taskId) ||
          tasks.size >= Bounds.ledgerRows
        )
          return yield* deny("Original root task membership is inconsistent");
        tasks.add(membership.taskId);
        next.push(membership.taskId);
      }
      frontier = next;
    }
    const originals = yield* readOriginals(
      "run-binding",
      sql`json_extract(payload_json,'$.record.environmentId')=${options.environmentId}
      AND json_extract(payload_json,'$.record.taskId') IN ${sql.in([...tasks])}`,
    );
    const owners = new Map<string, ProjectTeamDispatchSnapshot>();
    for (const original of originals) {
      const run = original.record;
      if (
        run.kind !== "run-binding" ||
        run.environmentId !== options.environmentId ||
        owners.has(run.recordId)
      )
        return yield* deny("Original root run membership is inconsistent");
      const effects = yield* readOriginals(
        "effect",
        sql`command_id=${original.commandId}
        AND json_extract(payload_json,'$.record.effectKind')='dispatch'
        AND json_extract(payload_json,'$.record.runId')=${run.recordId}`,
      );
      const effect = effects[0]?.record;
      if (effects.length !== 1 || effect?.kind !== "effect")
        return yield* deny("Original root dispatch claim is missing");
      const owner = yield* journal.readRetained(effect.effectId);
      const claim = owner.intent.compiledClaim.transition;
      if (
        claim?.kind !== "claim" ||
        !same(claim.binding, run) ||
        !same(claim.dispatch?.effect, effect) ||
        owner.intent.compiledClaim.commandId !== original.commandId ||
        owner.intent.limits.rootTaskId !== limits.rootTaskId ||
        owner.intent.limits.maximumTokens !== limits.maximumTokens ||
        owner.intent.limits.rootDeadlineAtMs !== limits.rootDeadlineAtMs
      )
        return yield* deny("Root dispatch history is inconsistent");
      owners.set(run.recordId, owner);
    }
    const members = yield* sql<{
      dispatch_id: string;
      binding_id: string;
    }>`SELECT dispatch_id,binding_id
      FROM project_team_dispatch WHERE environment_id=${options.environmentId}
      AND project_id=${binding.projectId} AND root_task_id=${limits.rootTaskId} ORDER BY dispatch_id LIMIT 4097`;
    if (
      !owners.has(binding.recordId) ||
      members.length !== owners.size ||
      members.some(
        (member) => owners.get(member.binding_id)?.fence.dispatchId !== member.dispatch_id,
      )
    )
      return yield* deny("Root physical owners disagree with original claims");
    const selection = sql`(environment_id=${options.environmentId} AND project_id=${binding.projectId}
      AND root_task_id=${limits.rootTaskId}) OR run_id IN ${sql.in([...owners.keys()])}`;
    const metadata = yield* sql<{ reservation_id: string; bytes: number }>`SELECT reservation_id,
      length(CAST(reservation_json AS BLOB))+COALESCE(length(CAST(settlement_json AS BLOB)),0) AS bytes
      FROM project_team_model_request WHERE ${selection} ORDER BY reservation_id LIMIT 4097`;
    if (
      metadata.length > Bounds.ledgerRows ||
      metadata.some((m) => !Number.isSafeInteger(m.bytes) || m.bytes < 0 || m.bytes > 24576) ||
      metadata.reduce((total, m) => total + m.bytes, 0) > Bounds.ledgerBytes
    )
      return yield* deny("Remaining budget ledger exceeds required bounds");
    const rows =
      yield* sql`SELECT * FROM project_team_model_request WHERE ${selection} ORDER BY reservation_id LIMIT 4097`;
    const budgets = yield* sql<{
      maximum_tokens: number;
      deadline_at_ms: number;
    }>`SELECT maximum_tokens,deadline_at_ms
      FROM project_team_model_budget WHERE environment_id=${options.environmentId}
      AND project_id=${binding.projectId} AND root_task_id=${limits.rootTaskId}`;
    if (
      budgets.length > 1 ||
      (rows.length > 0 && budgets.length !== 1) ||
      budgets.some(
        (budget) =>
          budget.maximum_tokens !== limits.maximumTokens ||
          budget.deadline_at_ms !== limits.rootDeadlineAtMs,
      )
    )
      return yield* deny("Retained model budget disagrees with frozen root limits");
    if (rows.length !== metadata.length) return yield* deny("Remaining budget ledger changed");
    let rootUsedTokens = 0;
    let attemptUsedTokens = 0;
    let outstandingRequests = 0;
    const receipts: Array<{
      reservationId: string;
      runId: string;
      generation: number;
      status: string;
      capacityState: string;
      chargedTokens: number;
      accountingReceiptId: string | null;
    }> = [];
    for (const [index, input] of rows.entries()) {
      const row = yield* decodeModelRow(input);
      const owner = owners.get(row.run_id);
      const claim = owner?.intent.compiledClaim.transition;
      if (
        owner === undefined ||
        claim?.kind !== "claim" ||
        owner.fence.claimGeneration === 0 ||
        row.environment_id !== options.environmentId ||
        row.project_id !== binding.projectId ||
        row.root_task_id !== limits.rootTaskId ||
        row.attempt_id !== claim.binding.attemptId ||
        row.generation !== claim.binding.generation ||
        row.model !== claim.binding.model ||
        row.deadline_at_ms > owner.intent.limits.deadlineAtMs ||
        metadata[index]?.reservation_id !== row.reservation_id ||
        Buffer.byteLength(row.reservation_json) > 8192 ||
        Buffer.byteLength(row.settlement_json ?? "") > 16384
      )
        return yield* deny("Remaining budget owner identity is invalid");
      const reservation = yield* decodeReservation(row.reservation_json);
      const expected = {
        workerId: row.worker_id,
        generation: row.generation,
        operationId: row.operation_id,
        requestId: row.request_id,
        routeId: row.route_id,
        provider: row.provider,
        model: row.model,
        maxInputTokens: row.maximum_input_tokens,
        maxOutputTokens: row.maximum_output_tokens,
        callCount: 1,
        deadlineAtMs: row.deadline_at_ms,
      };
      const maximum = add(row.maximum_input_tokens, row.maximum_output_tokens);
      if (!same(reservation, expected) || maximum > owner.intent.limits.attemptMaximumTokens)
        return yield* deny("Remaining budget reservation disagrees with physical identity");
      let charged = maximum;
      if (row.status === "held") {
        if (
          row.capacity_state !== "held" ||
          row.charged_input_tokens !== 0 ||
          row.charged_output_tokens !== 0 ||
          row.accounting_receipt_id !== null ||
          row.settlement_json !== null
        )
          return yield* deny("Held model request has contradictory settlement");
      } else {
        if (
          row.settlement_json === null ||
          row.accounting_receipt_id === null ||
          row.capacity_state === "held" ||
          row.capacity_state === "legacy"
        )
          return yield* deny("Settled model request lacks retained accounting proof");
        const settlement = yield* decodeSettlement(row.settlement_json);
        if (
          !same(reservationFields(settlement), reservation) ||
          settlement.reservationId !== row.reservation_id ||
          settlement.outcome !== row.status ||
          settlement.chargedInputTokens !== row.charged_input_tokens ||
          settlement.chargedOutputTokens !== row.charged_output_tokens ||
          (row.capacity_state === "released" && settlement.transportDrained !== true)
        )
          return yield* deny("Settled model request disagrees with original accounting");
        const usage = settlement.reportedUsage;
        if (
          (usage === undefined) !== (settlement.reportedModel === undefined) ||
          (row.status === "reported" && usage === undefined) ||
          (usage !== undefined &&
            (add(usage.prompt_tokens, usage.completion_tokens) !== usage.total_tokens ||
              usage.prompt_tokens > row.maximum_input_tokens ||
              usage.completion_tokens > row.maximum_output_tokens ||
              Object.values(usage.prompt_tokens_details ?? {}).some(
                (n) => n !== undefined && n > usage.prompt_tokens,
              ) ||
              Object.values(usage.completion_tokens_details ?? {}).some(
                (n) => n !== undefined && n > usage.completion_tokens,
              ) ||
              [
                usage.prompt_cache_hit_tokens,
                usage.prompt_cache_miss_tokens,
                usage.cached_tokens,
              ].some((n) => n !== undefined && n > usage.prompt_tokens)))
        )
          return yield* deny("Retained reported usage is inconsistent");
        const inputCharge =
          row.status === "reported" ? usage!.prompt_tokens : row.maximum_input_tokens;
        const outputCharge =
          row.status === "reported" ? usage!.completion_tokens : row.maximum_output_tokens;
        if (inputCharge !== row.charged_input_tokens || outputCharge !== row.charged_output_tokens)
          return yield* deny("Uncertain model requests must retain their full charge");
        charged = add(inputCharge, outputCharge);
      }
      rootUsedTokens = add(rootUsedTokens, charged);
      if (row.attempt_id === binding.attemptId) attemptUsedTokens = add(attemptUsedTokens, charged);
      if (row.capacity_state !== "released") outstandingRequests++;
      receipts.push({
        reservationId: row.reservation_id,
        runId: row.run_id,
        generation: row.generation,
        status: row.status,
        capacityState: row.capacity_state,
        chargedTokens: charged,
        accountingReceiptId: row.accounting_receipt_id,
      });
    }
    if (rootUsedTokens > limits.maximumTokens) return yield* deny("Root model budget is overdrawn");
    return {
      rootUsedTokens,
      rootRemainingTokens: limits.maximumTokens - rootUsedTokens,
      // The producer enforces each operation's maximum; attempt usage is cumulative information, not a replacement producer gate.
      attemptUsedTokens,
      outstandingRequests,
      receipts,
    };
  });
  const verifyRetainedCriteria = Effect.fn("ProjectTeamContext.verifyRetainedCriteria")(function* (
    task: ProjectWorkTask,
    criteria: ReadonlyArray<ProjectWorkCriterion>,
    retained: {
      rows: number;
      bytes: number;
      eventIds: Set<string>;
      events: Map<string, typeof CriterionEvent.Type>;
    },
  ) {
    type EventRow = {
      sequence: number;
      event_id: string;
      project_id: string;
      event_type: string;
      occurred_at: string;
      bytes: number;
      payload_json: string;
    };
    const consume = (row: EventRow) => {
      if (
        !Number.isSafeInteger(row.sequence) ||
        row.sequence <= 0 ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        row.bytes > Bounds.contextBytes
      )
        throw deny("Required retained scope event exceeds bounds");
      if (!retained.eventIds.has(row.event_id)) {
        retained.rows++;
        retained.bytes = add(retained.bytes, row.bytes);
        retained.eventIds.add(row.event_id);
      }
      if (retained.rows > Bounds.ledgerRows || retained.bytes > Bounds.ledgerBytes)
        throw deny("Required retained scope history exceeds bounds");
    };
    const verify = (
      row: EventRow,
      event: { eventId: string; projectId: string; type: string; occurredAt: string },
    ) => {
      if (
        event.eventId !== row.event_id ||
        event.projectId !== task.projectId ||
        event.projectId !== row.project_id ||
        event.type !== row.event_type ||
        event.occurredAt !== row.occurred_at
      )
        throw deny("Required retained scope event identity changed");
    };
    const column = sql`sequence,event_id,project_id,event_type,occurred_at,length(CAST(payload_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${Bounds.contextBytes} THEN payload_json ELSE NULL END AS payload_json`;
    // Approved specification content is already bound through actual Journal policy
    // to the exact original gate digest, whose full retained event is checked below.
    for (const criterion of criteria) {
      const sources =
        yield* sql<EventRow>`SELECT ${column} FROM project_work_events WHERE project_id=${task.projectId}
        AND event_type='project-work.criterion.upserted' AND json_extract(payload_json,'$.criterion.criterionId')=${criterion.criterionId}
        ORDER BY sequence DESC LIMIT 1`;
      const sourceRow = sources[0];
      if (sourceRow === undefined) return yield* deny("Required criterion origin is missing");
      consume(sourceRow);
      const source = yield* decodeCriterionEvent(sourceRow.payload_json);
      verify(sourceRow, source);
      retained.events.set(sourceRow.event_id, source);
      if (
        source.type !== "project-work.criterion.upserted" ||
        source.taskId !== task.taskId ||
        source.criterion.taskId !== task.taskId ||
        source.criterion.criterionId !== criterion.criterionId
      )
        return yield* deny("Required criterion source is inconsistent");
      const reconstructed = { ...source.criterion };
      const changes =
        yield* sql<EventRow>`SELECT sequence,event_id,project_id,event_type,occurred_at,
        length(CAST(payload_json AS BLOB)) AS bytes,NULL AS payload_json FROM project_work_events WHERE project_id=${task.projectId}
        AND event_type IN ('project-work.criterion.waived','project-work.task.completed') AND sequence>${sourceRow.sequence}
        AND json_extract(payload_json,'$.taskId')=${task.taskId}
        AND (event_type='project-work.task.completed' OR json_extract(payload_json,'$.criterionId')=${criterion.criterionId})
        ORDER BY sequence ASC LIMIT 4097`;
      if (changes.length > Bounds.ledgerRows)
        return yield* deny("Required criterion history exceeds bounds");
      for (const row of changes) {
        consume(row);
        let change = retained.events.get(row.event_id);
        if (change === undefined) {
          const payloads =
            yield* sql<EventRow>`SELECT ${column} FROM project_work_events WHERE project_id=${task.projectId}
          AND sequence=${row.sequence} AND event_id=${row.event_id}`;
          const payload = payloads[0];
          if (
            payloads.length !== 1 ||
            payload === undefined ||
            payload.bytes !== row.bytes ||
            payload.event_type !== row.event_type ||
            payload.occurred_at !== row.occurred_at
          )
            return yield* deny("Required criterion history changed during read");
          change = yield* decodeCriterionEvent(payload.payload_json);
          retained.events.set(row.event_id, change);
        }
        verify(row, change);
        if (change.taskId !== task.taskId)
          return yield* deny("Required criterion history is foreign");
        if (change.type === "project-work.criterion.waived") {
          if (change.criterionId !== criterion.criterionId)
            return yield* deny("Required waiver target changed");
          reconstructed.status = "waived";
          reconstructed.waiver = change.waiver;
          reconstructed.revision = add(reconstructed.revision, 1);
          reconstructed.updatedAt = change.waivedAt;
        } else if (
          change.type === "project-work.task.completed" &&
          change.satisfiedCriterionIds.includes(criterion.criterionId)
        ) {
          reconstructed.status = "satisfied";
          reconstructed.revision = add(reconstructed.revision, 1);
          reconstructed.updatedAt = change.completedAt;
        } else if (change.type === "project-work.criterion.upserted")
          return yield* deny("Required criterion event kind changed");
      }
      if (!same(reconstructed, criterion))
        return yield* deny("Required criterion progress disagrees with retained history");
    }
  });
  const readRequiredContext = Effect.fn("ProjectTeamContext.readRequired")(
    function* (snapshot: ProjectTeamDispatchSnapshot, initialReview: boolean) {
      const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(currentClient) && currentClient.value !== sql)
        return yield* deny("Required context must use its captured SQL client");
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Required context must own its read transaction");
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const original = yield* journal.inspect(snapshot.fence.dispatchId, {
            requireClaim: true,
          });
          if (!same(original, snapshot))
            return yield* deny("Required context original dispatch fence changed");
          const claim = original.intent.compiledClaim.transition;
          if (claim?.kind !== "claim") return yield* deny("Original dispatch claim is missing");
          const binding = claim.binding;
          if (original.intent.integration !== undefined) {
            yield* sourceService
              .assertCurrentInTransaction({
                projectId: binding.projectId,
                integrationTaskId: binding.taskId,
                sources: original.intent.integration.selection,
              })
              .pipe(Effect.mapError(() => deny("Approved integration sources changed")));
          }
          const projects = yield* sql`SELECT project.project_id FROM projection_projects AS project
        LEFT JOIN project_lifecycle AS lifecycle ON lifecycle.project_id=project.project_id
        WHERE project.project_id=${binding.projectId} AND project.deleted_at IS NULL
        AND (lifecycle.state IS NULL OR lifecycle.state='active')`;
          if (projects.length !== 1)
            return yield* deny("Required project is archived, deleted or missing");
          const state = yield* readCurrentState(sql, binding.projectId);
          const records = state.foundationRecords ?? [];
          const retained = {
            rows: 0,
            bytes: 0,
            eventIds: new Set<string>(),
            events: new Map<string, typeof CriterionEvent.Type>(),
          };
          const requiredRecords = new Map<string, ProjectTeamRecord>();
          const recordById = (id: string | undefined) => {
            const matches = records.filter((r) => r.recordId === id);
            if (
              id === undefined ||
              matches.length !== 1 ||
              matches[0]?.projectId !== binding.projectId
            )
              throw deny("Required record is missing, foreign or ambiguous");
            const record = matches[0]!;
            requiredRecords.set(record.recordId, record);
            return record;
          };
          const role = recordById(binding.roleRevisionId);
          if (role.kind !== "role-revision") return yield* deny("Original role is missing");
          const reviewTarget =
            role.role === "reviewer"
              ? yield* initialReview
                  ? reviewTargets.captureInitial(original)
                  : reviewTargets.readForDispatch(original)
              : undefined;
          if (reviewTarget) {
            recordById(reviewTarget.verificationGate.recordId);
            recordById(reviewTarget.prepared.manifest.bindingId);
          }
          const member = recordById(binding.memberId);
          if (member.kind !== "member") return yield* deny("Original member is missing");
          const gateIds = new Set(
            [binding.authorizationGateId, binding.specificationGateId, binding.planGateId].filter(
              (id) => id !== undefined,
            ),
          );
          const tasks: Array<{
            task: ProjectWorkTask;
            membership: RecordOf<"task-membership">;
            criteria: ReadonlyArray<ProjectWorkCriterion>;
            plan?: RecordOf<"plan-revision">;
          }> = [];
          const seen = new Set<string>();
          let taskId: string | undefined = binding.taskId;
          while (taskId !== undefined) {
            if (seen.has(taskId) || seen.size >= 9)
              return yield* deny("Required task lineage is invalid");
            seen.add(taskId);
            const matches = state.tasks.filter((t) => t.taskId === taskId);
            if (matches.length !== 1) return yield* deny("Required task is missing or ambiguous");
            const task = yield* decodeTask(matches[0]);
            if (task.projectId !== binding.projectId || task.state === "canceled")
              return yield* deny("Required task is foreign or canceled");
            const memberships = records.filter(
              (r) => r.kind === "task-membership" && r.taskId === taskId,
            );
            if (memberships.length !== 1 || memberships[0]?.kind !== "task-membership")
              return yield* deny("Required membership is ambiguous");
            const membership = memberships[0];
            if (
              membership.status !== "active" ||
              (membership.controlState !== undefined && membership.controlState !== "active")
            )
              return yield* deny("Required parent task is paused or removed");
            requiredRecords.set(membership.recordId, membership);
            const plans = records
              .filter(
                (r): r is RecordOf<"plan-revision"> =>
                  r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed",
              )
              .sort((a, b) => b.planRevision - a.planRevision);
            const plan = plans[0];
            if (plan !== undefined && plans[1]?.planRevision === plan.planRevision)
              return yield* deny("Required plan revision is ambiguous");
            if (plan !== undefined) requiredRecords.set(plan.recordId, plan);
            if (taskId !== binding.taskId) {
              const targets = [
                ["specification", projectTeamSpecificationHash(state, task.taskId), 0],
                ...(plan === undefined
                  ? []
                  : [["plan", projectTeamPlanHash(plan), plan.planRevision] as const]),
              ] as const;
              for (const [kind, contentHash, planRevision] of targets) {
                const approvals = records.filter(
                  (record): record is RecordOf<"gate"> =>
                    record.kind === "gate" &&
                    evaluateProjectTeamGate(record, {
                      projectId: task.projectId,
                      taskId: task.taskId,
                      gate: kind,
                      specRevision: task.specRevision,
                      planRevision,
                      contentHash,
                      evidenceIds: [],
                    }).available,
                );
                if (
                  approvals.length !== 1 ||
                  (kind === "plan" &&
                    (plan?.specRevision !== task.specRevision || plan.contentHash !== contentHash))
                )
                  return yield* deny("Required ancestor approval is missing, stale or ambiguous");
                gateIds.add(approvals[0]!.recordId);
              }
            }
            const criteria = yield* Effect.forEach(
              state.criteria.filter((c) => c.taskId === taskId),
              (criterion) => decodeCriterion(criterion),
            );
            if (criteria.length > 64) return yield* deny("Required criteria exceed context bounds");
            const physical = yield* sql<{
              specification_json: string | null;
              spec_revision: number;
              revision: number;
              state: string;
            }>`SELECT specification_json,spec_revision,revision,state
          FROM project_work_tasks WHERE task_id=${taskId} AND project_id=${binding.projectId}`;
            const stored = physical[0];
            if (
              physical.length !== 1 ||
              stored === undefined ||
              stored.revision !== task.revision ||
              stored.spec_revision !== task.specRevision ||
              stored.state !== task.state ||
              stored.specification_json !==
                (task.specification === undefined ? null : encodeJson(task.specification))
            )
              return yield* deny("Required task SQL disagrees with approved scope");
            const physicalCriteria =
              yield* sql`SELECT criterion_id,task_id,description,required,status,satisfied_by_evidence_ids_json,waiver_json,revision,updated_at
          FROM project_work_criteria WHERE project_id=${binding.projectId} AND task_id=${taskId} ORDER BY criterion_id LIMIT 65`;
            const expected = [...criteria]
              .sort((a, b) =>
                a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0,
              )
              .map((c) => ({
                criterion_id: c.criterionId,
                task_id: c.taskId,
                description: c.description,
                required: c.required ? 1 : 0,
                status: c.status,
                satisfied_by_evidence_ids_json: encodeJson(c.satisfiedByEvidenceIds),
                waiver_json: c.waiver === undefined ? null : encodeJson(c.waiver),
                revision: c.revision,
                updated_at: c.updatedAt,
              }));
            if (!same(physicalCriteria, expected))
              return yield* deny("Required output criteria SQL disagrees with authority");
            yield* verifyRetainedCriteria(task, criteria, retained);
            tasks.push({ task, membership, criteria, ...(plan === undefined ? {} : { plan }) });
            taskId = membership.parentTaskId;
          }
          for (const id of gateIds) {
            const gate = recordById(id);
            if (gate.kind !== "gate") return yield* deny("Required approval has an invalid kind");
            if (gate.assignmentAuthorization !== undefined) {
              gateIds.add(gate.assignmentAuthorization.parentSpecificationGateId);
              if (gate.assignmentAuthorization.parentPlan !== undefined)
                gateIds.add(gate.assignmentAuthorization.parentPlan.gateId);
            }
            if (gate.repairAuthorization !== undefined) {
              gateIds.add(gate.repairAuthorization.inheritedGateId);
              if (gate.repairAuthorization.exceptionGateId !== undefined)
                gateIds.add(gate.repairAuthorization.exceptionGateId);
              recordById(gate.repairAuthorization.episodeId);
            }
            if (gateIds.size > 32) return yield* deny("Required approvals exceed context bounds");
          }
          // Questions are visible only to their original task/member, with a still-current exact target revision.
          const questions = records.filter(
            (r): r is RecordOf<"question"> =>
              r.kind === "question" &&
              r.status === "pending" &&
              r.taskId === binding.taskId &&
              r.senderId === binding.memberId,
          );
          if (questions.length > 64) return yield* deny("Required questions exceed context bounds");
          const applicableQuestions: Array<RecordOf<"question">> = [];
          for (const question of questions) {
            const targets = records.filter(
              (r) =>
                r.kind === "gate" &&
                r.recordId === question.targetGateId &&
                r.taskId === binding.taskId &&
                r.revision === question.targetRevision,
            );
            if (targets.length !== 1) continue;
            requiredRecords.set(question.recordId, question);
            requiredRecords.set(targets[0]!.recordId, targets[0]!);
            applicableQuestions.push(question);
          }
          const repairEpisodes = records.filter(
            (r): r is RecordOf<"repair-episode"> =>
              r.kind === "repair-episode" &&
              (r.rootTaskId ?? r.taskId) === original.intent.limits.rootTaskId,
          );
          if (repairEpisodes.length > 64)
            return yield* deny("Required repair history exceeds context bounds");
          for (const episode of repairEpisodes) requiredRecords.set(episode.recordId, episode);
          for (const record of requiredRecords.values()) yield* readRecord(record);
          const ledger = yield* readLedger(original);
          const now = yield* Clock.currentTimeMillis;
          const required = {
            projectId: binding.projectId,
            taskId: binding.taskId,
            runId: binding.recordId,
            attemptId: binding.attemptId,
            generation: binding.generation,
            sourceRevision: state.revision,
            dispatch: original.fence,
            originalAssignment: original.intent.request.assignment,
            ...(reviewTarget === undefined ? {} : { reviewTarget }),
            role,
            member,
            tasks,
            approvals: [...gateIds].map((id) => requiredRecords.get(id)),
            questions: applicableQuestions,
            repairEpisodes,
            frozenLimits: original.intent.limits,
            originalRootCaps: original.intent.rootCaps,
            remaining: {
              ...ledger,
              asOfMs: now,
              rootRemainingDurationMs: Math.max(0, original.intent.limits.rootDeadlineAtMs - now),
              attemptRemainingDurationMs: Math.max(0, original.intent.limits.deadlineAtMs - now),
            },
          };
          const text =
            "Required context from retained T3 authority. This read snapshot grants no new approval.\n" +
            canonicalProjectWorkPayload(required);
          if (Buffer.byteLength(text, "utf8") > Bounds.contextBytes)
            return yield* deny("Required context exceeds its UTF8 bound");
          const final = yield* journal.inspect(original.fence.dispatchId, { requireClaim: true });
          if (!same(final, original))
            return yield* deny("Required context dispatch changed before return");
          if (reviewTarget) {
            const checked = yield* reviewTargets.readForDispatch(final);
            if (!same(checked, reviewTarget))
              return yield* deny("Original review target changed before return");
          }
          return {
            text,
            required,
            provenance: {
              dispatch: original.fence,
              sourceRevision: state.revision,
              recordIds: [...requiredRecords.keys()].sort(),
              criterionEventIds: [...retained.eventIds].sort(),
              ledgerReservationIds: ledger.receipts.map((r) => r.reservationId),
            },
          };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
    },
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
        : Effect.fail(deny("Required context denied by retained or current authority")),
    ),
  );
  const readRequired = Effect.fn("ProjectTeamContext.readRequiredSnapshot")(function* (
    snapshot: ProjectTeamDispatchSnapshot,
  ) {
    return yield* readRequiredContext(snapshot, false);
  });
  const readForOperation = Effect.fn("ProjectTeamContext.readForOperation")(function* (
    input: typeof OperationInput.Type,
  ) {
    const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isSome(currentClient) && currentClient.value !== sql)
      return yield* deny("Required context must use its captured SQL client");
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* deny("Required context must own its read transaction");
    const operation = yield* decodeOperationInput(input).pipe(
      Effect.mapError(() => deny("Required operation identity is invalid")),
    );
    const snapshot = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ dispatch_id: string }>`SELECT dispatch_id
            FROM project_team_dispatch WHERE environment_id=${options.environmentId}
            AND project_id=${operation.projectId} AND binding_id=${operation.bindingId}
            AND generation=${operation.generation} ORDER BY dispatch_id LIMIT 129`;
          if (rows.length !== 1 || rows[0] === undefined)
            return yield* deny("Required original dispatch is missing or ambiguous");
          const retained = yield* journal.readRetained(rows[0].dispatch_id);
          const claim = retained.intent.compiledClaim.transition;
          const request = retained.intent.request;
          if (
            claim?.kind !== "claim" ||
            claim.binding.environmentId !== options.environmentId ||
            claim.binding.projectId !== operation.projectId ||
            claim.binding.recordId !== operation.bindingId ||
            claim.binding.generation !== operation.generation ||
            claim.binding.providerInstanceId !== operation.providerInstanceId ||
            claim.binding.threadId !== operation.threadId ||
            operation.operationId !==
              (operation.operationKind === "initialize"
                ? request.initializeOperationId
                : request.assignmentOperationId)
          )
            return yield* deny("Required operation differs from its original dispatch");
          return retained;
        }),
      )
      .pipe(Effect.mapError(() => deny("Required original dispatch is unavailable")));
    // The owned reader revalidates this snapshot in its own transaction before returning content.
    return yield* readRequiredContext(snapshot, operation.operationKind === "initialize");
  });
  return { readRequired, readForOperation };
});
