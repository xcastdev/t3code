import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { selectCurrentProjectWorkKnowledge } from "./ProjectWorkKnowledgeSelection.ts";
import { auditProjectMemoryOperationLedger } from "./memory/ProjectMemoryModelAccounting.ts";
import { ProjectMemoryPorts } from "./memory/ProjectMemoryPorts.ts";
import {
  readProjectMemoryObservations,
  type ProjectMemoryRetrieval,
} from "./memory/ProjectMemoryRetrieval.ts";
import {
  ProjectTeamAuthorization,
  managedActorId,
  type ProjectTeamMessageRecipients,
} from "./ProjectTeamAuthorization.ts";
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
  ProjectWorkWriteResult,
  ProjectWorkDecision,
  ProjectWorkDecisionId,
  ProjectWorkKnowledge,
  ProjectWorkAttribution,
  ProjectId,
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
import { applyProjectWorkEvents, emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import * as NodeCrypto from "node:crypto";
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
  provider: Schema.Literals(["command-code", "openai-codex"]),
  accountingMode: Schema.optionalKey(Schema.Literals(["hard", "openai-subscription-monitored"])),
  unknownMaximumTokens: Schema.optionalKey(Schema.Literal(64_000)),
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
const decodeAnswerEventIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(EventId)),
  strict,
);
const decodeAnswerResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const retainedEventFields = {
  ...eventFields,
  projectId: ProjectId,
  attribution: Schema.optionalKey(ProjectWorkAttribution),
};
const DecisionEvent = Schema.Union([
  Schema.Struct({
    ...retainedEventFields,
    type: Schema.Literal("project-work.decision.proposed"),
    decision: ProjectWorkDecision,
    proposedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...retainedEventFields,
    type: Schema.Literal("project-work.decision.accepted"),
    decisionId: ProjectWorkDecisionId,
    acceptedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...retainedEventFields,
    type: Schema.Literal("project-work.decision.rejected"),
    decisionId: ProjectWorkDecisionId,
    reason: Schema.String,
    rejectedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...retainedEventFields,
    attribution: ProjectWorkAttribution,
    type: Schema.Literal("project-work.decision.superseded"),
    decisionId: ProjectWorkDecisionId,
    replacement: ProjectWorkDecision,
    supersededAt: IsoDateTime,
  }),
]);
const KnowledgeEvent = Schema.Struct({
  ...retainedEventFields,
  type: Schema.Literal("project-work.knowledge.promoted"),
  knowledge: ProjectWorkKnowledge,
  promotedAt: IsoDateTime,
});
const decodeDecisionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DecisionEvent),
  strict,
);
const decodeKnowledgeEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(KnowledgeEvent),
  strict,
);
const decodeDecision = Schema.decodeUnknownEffect(ProjectWorkDecision, strict);
const decodeKnowledge = Schema.decodeUnknownEffect(ProjectWorkKnowledge, strict);
const decodeAttributionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkAttribution),
  strict,
);
type RetainedKnowledge = {
  readonly status: "available" | "disabled" | "degraded";
  readonly records: readonly ProjectWorkKnowledge[];
  readonly omitted: readonly string[];
};
type ContextTextOptions = { readonly optionalTextBudgetBytes: number };
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const receiptFields = (type: string): readonly string[] => {
  if (type.includes("foundation")) return ["foundationRecords"];
  if (type.includes("criterion")) return ["criteria", "tasks"];
  if (type.includes("evidence")) return ["evidence", "criteria", "tasks"];
  if (type.includes("relationship")) return ["relationships", "tasks"];
  if (type.includes("attempt") || type.includes("checkpoint"))
    return ["attempts", "tasks", "checkpoints"];
  if (type.includes("knowledge")) return ["knowledge"];
  if (type.includes("decision")) return ["decisions"];
  if (type.includes("comment")) return ["comments"];
  if (type.includes("attention")) return ["attention", "tasks"];
  return ["tasks"];
};
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
  request_lane: Schema.Literals(["pi", "memory"]),
  request_scope: Schema.String.check(Schema.isMaxLength(64)),
  request_id: Positive,
  route_id: Id,
  provider: Schema.Literals(["command-code", "openai-codex", "openrouter"]),
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
  accounting_mode: Schema.Literals(["hard", "openai-subscription-monitored"]),
  unknown_maximum_tokens: Schema.NullOr(Schema.Literal(64_000)),
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
  const messageAuthorization = yield* Effect.serviceOption(ProjectTeamAuthorization);
  const memoryPorts = yield* Effect.serviceOption(ProjectMemoryPorts);
  const sourceService = yield* makeProjectTeamIntegrationSources({
    environmentId: options.environmentId,
  });
  const journal = yield* makeProjectTeamDispatchJournal(options);
  const reviewTargets = yield* makeProjectTeamReviewTargets(options);
  const readRetained = Effect.fn("ProjectTeamContext.readRetained")(function* (
    projectId: string,
    kind: "decision" | "knowledge",
  ) {
    // Bound metadata before loading bodies, including complete replacement history.
    const metadata = yield* sql<{
      sequence: number;
      bytes: number;
      scalarBytes: number;
    }>`
      SELECT sequence,length(CAST(payload_json AS BLOB)) AS bytes,
      length(CAST(event_id AS BLOB))+length(CAST(project_id AS BLOB))+length(CAST(occurred_at AS BLOB))+length(CAST(command_id AS BLOB))+length(CAST(event_type AS BLOB)) AS scalarBytes
      FROM project_work_events WHERE project_id=${projectId} AND event_type LIKE ${"project-work." + kind + ".%"}
      ORDER BY sequence LIMIT 4097`;
    if (metadata.length > Bounds.ledgerRows)
      return yield* deny("Retained context history exceeds row bounds");
    let bytes = 0;
    for (const row of metadata) {
      if (
        !Number.isSafeInteger(row.sequence) ||
        row.sequence <= 0 ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes <= 0 ||
        row.bytes > Bounds.contextBytes ||
        !Number.isSafeInteger(row.scalarBytes) ||
        row.scalarBytes <= 0 ||
        row.scalarBytes > Bounds.contextBytes
      )
        return yield* deny("Retained context event exceeds bounds");
      bytes = add(bytes, add(row.bytes, row.scalarBytes));
    }
    if (bytes > Bounds.ledgerBytes)
      return yield* deny("Retained context history exceeds byte bounds");
    const rows = yield* sql<{
      sequence: number;
      event_id: string;
      project_id: string;
      revision: number;
      occurred_at: string;
      command_id: string;
      event_type: string;
      payload: string | null;
    }>`SELECT sequence,event_id,project_id,json_extract(payload_json,'$.revision') AS revision,occurred_at,command_id,event_type,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${Bounds.contextBytes} THEN payload_json END AS payload
      FROM project_work_events WHERE project_id=${projectId} AND event_type LIKE ${"project-work." + kind + ".%"} ORDER BY sequence LIMIT 4097`;
    if (rows.length !== metadata.length)
      return yield* deny("Retained context history changed during read");
    const decoded = yield* Effect.forEach(
      rows,
      Effect.fn("ProjectTeamContext.decodeRetained")(function* (row, index) {
        if (row.sequence !== metadata[index]?.sequence || row.payload === null)
          return yield* deny("Retained context event is missing");
        return kind === "decision"
          ? yield* decodeDecisionEvent(row.payload)
          : yield* decodeKnowledgeEvent(row.payload);
      }),
    );
    const commands = new Map<string, typeof decoded>();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const event = decoded[index];
      if (!row || !event) return yield* deny("Retained context event is missing");
      const command = commands.get(row.command_id);
      if (command) command.push(event);
      else commands.set(row.command_id, [event]);
    }
    let reconstructed = emptyProjectWorkReducerState(projectId);
    const audited = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const event = decoded[index];
      if (!row || !event) return yield* deny("Retained context event is missing");
      if (
        event.eventId !== row.event_id ||
        event.projectId !== projectId ||
        event.revision !== row.revision ||
        event.occurredAt !== row.occurred_at ||
        event.type !== row.event_type
      )
        return yield* deny("Retained context event disagrees with physical metadata");
      if (!audited.has(row.command_id)) {
        const receiptMetadata = yield* sql<{ scalarBytes: number; bytes: number }>`SELECT
          COALESCE(length(CAST(actor_kind AS BLOB)),0)+COALESCE(length(CAST(actor_id AS BLOB)),0)+COALESCE(length(CAST(source_kind AS BLOB)),0)+COALESCE(length(CAST(source_id AS BLOB)),0)+length(CAST(created_at AS BLOB)) AS scalarBytes,
          COALESCE(length(CAST(event_ids_json AS BLOB)),0)+COALESCE(length(CAST(result_json AS BLOB)),0) AS bytes
          FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${row.command_id} LIMIT 2`;
        const receiptSize = receiptMetadata[0];
        if (
          receiptMetadata.length !== 1 ||
          !receiptSize ||
          !Number.isSafeInteger(receiptSize.scalarBytes) ||
          receiptSize.scalarBytes <= 0 ||
          receiptSize.scalarBytes > Bounds.contextBytes ||
          !Number.isSafeInteger(receiptSize.bytes) ||
          receiptSize.bytes <= 0 ||
          receiptSize.bytes > 1310720
        )
          return yield* deny("Retained context receipt metadata exceeds bounds");
        bytes = add(bytes, add(receiptSize.bytes, receiptSize.scalarBytes));
        if (bytes > Bounds.ledgerBytes)
          return yield* deny("Retained context receipt history exceeds byte bounds");
        const receipts = yield* sql<{
          actorKind: string | null;
          actorId: string | null;
          sourceKind: string | null;
          sourceId: string | null;
          createdAt: string;
          ids: string | null;
          result: string | null;
        }>`
          SELECT actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId,created_at AS createdAt,
          CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS ids,
          CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result
          FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${row.command_id} LIMIT 2`;
        const receipt = receipts[0];
        if (receipts.length !== 1 || !receipt || receipt.ids === null || receipt.result === null)
          return yield* deny("Retained context original receipt is missing or oversized");
        const ids = yield* decodeAnswerEventIds(receipt.ids);
        const result = yield* decodeAnswerResult(receipt.result);
        const commandMetadata = yield* sql<{
          count: number;
          bytes: number | null;
          payloadBytes: number | null;
        }>`SELECT COUNT(*) AS count,
          SUM(length(CAST(event_id AS BLOB))+length(CAST(occurred_at AS BLOB))+length(CAST(event_type AS BLOB))) AS bytes,
          MAX(length(CAST(payload_json AS BLOB))) AS payloadBytes FROM project_work_events WHERE project_id=${projectId} AND command_id=${row.command_id}`;
        const commandSize = commandMetadata[0];
        if (
          !commandSize ||
          !Number.isSafeInteger(commandSize.count) ||
          commandSize.count <= 0 ||
          commandSize.count > Bounds.ledgerRows ||
          commandSize.bytes === null ||
          !Number.isSafeInteger(commandSize.bytes) ||
          commandSize.bytes <= 0 ||
          commandSize.bytes > Bounds.ledgerBytes ||
          commandSize.payloadBytes === null ||
          commandSize.payloadBytes > Bounds.contextBytes
        )
          return yield* deny("Retained context command metadata exceeds bounds");
        bytes = add(bytes, commandSize.bytes);
        if (bytes > Bounds.ledgerBytes)
          return yield* deny("Retained context command history exceeds byte bounds");
        const commandEvents = yield* sql<{
          event_id: string;
          revision: number;
          occurred_at: string;
          event_type: string;
        }>`
          SELECT event_id,json_extract(payload_json,'$.revision') AS revision,occurred_at,event_type FROM project_work_events WHERE project_id=${projectId} AND command_id=${row.command_id} ORDER BY sequence LIMIT 4097`;
        if (
          ids.length > Bounds.ledgerRows ||
          new Set(ids).size !== ids.length ||
          !same(
            ids,
            commandEvents.map((entry) => entry.event_id),
          ) ||
          result.projectId !== projectId ||
          result.receipt.projectId !== projectId ||
          result.receipt.commandId !== row.command_id ||
          result.receipt.status !== "accepted" ||
          result.receipt.eventCount !== ids.length ||
          result.receipt.revision !== result.revision ||
          result.delta.projectId !== projectId ||
          result.delta.revision !== result.revision ||
          !same(result.delta.eventIds, ids.slice(0, 64)) ||
          !same(
            result.delta.changedFields,
            [...new Set(commandEvents.flatMap((entry) => receiptFields(entry.event_type)))].slice(
              0,
              64,
            ),
          ) ||
          commandEvents.some(
            (entry, index) => entry.revision !== result.revision - ids.length + index + 1,
          ) ||
          commandEvents.at(-1)?.occurred_at !== receipt.createdAt
        )
          return yield* deny("Retained context original receipt disagrees with its exact events");
        // The receipt retains actor/source IDs and event time. Gateway recordedAt is a
        // separate server-clock value; the receipt does not independently retain it.
        for (const produced of commands.get(row.command_id) ?? []) {
          const actor = produced.attribution;
          if (
            !actor ||
            actor.actor.kind !== receipt.actorKind ||
            (actor.actor.id ?? null) !== receipt.actorId ||
            actor.source.kind !== receipt.sourceKind ||
            (actor.source.id ?? null) !== receipt.sourceId ||
            produced.occurredAt !== receipt.createdAt
          )
            return yield* deny(
              "Retained context producer attribution disagrees with its original receipt",
            );
        }
        audited.add(row.command_id);
      }
      if (
        event.type === "project-work.decision.proposed" ||
        event.type === "project-work.decision.superseded" ||
        event.type === "project-work.knowledge.promoted"
      ) {
        const nested =
          event.type === "project-work.decision.proposed"
            ? event.decision.attribution
            : event.type === "project-work.decision.superseded"
              ? event.replacement.attribution
              : event.knowledge.attribution;
        const authenticated = event.attribution;
        if (
          !nested ||
          !authenticated ||
          nested.actor.kind !== authenticated.actor.kind ||
          nested.actor.id !== authenticated.actor.id ||
          nested.source.kind !== authenticated.source.kind ||
          nested.source.id !== authenticated.source.id ||
          nested.recordedAt !== authenticated.recordedAt
        )
          return yield* deny("Retained record attribution disagrees with its authenticated event");
      }
      if (event.type === "project-work.knowledge.promoted") {
        if (
          event.knowledge.projectId !== projectId ||
          reconstructed.knowledge?.some(
            (record) => record.knowledgeId === event.knowledge.knowledgeId,
          ) ||
          event.promotedAt !== event.occurredAt
        )
          return yield* deny("Retained knowledge producer is inconsistent");
      } else if (event.type === "project-work.decision.proposed") {
        if (
          event.decision.projectId !== projectId ||
          event.decision.state !== "proposed" ||
          reconstructed.decisions?.some(
            (record) => record.decisionId === event.decision.decisionId,
          ) ||
          event.proposedAt !== event.occurredAt
        )
          return yield* deny("Retained decision proposal is inconsistent");
      } else {
        const prior = reconstructed.decisions?.find(
          (record) => record.decisionId === event.decisionId,
        );
        if (
          !prior ||
          (event.type === "project-work.decision.superseded"
            ? prior.state !== "accepted"
            : prior.state !== "proposed")
        )
          return yield* deny("Retained decision transition lacks its original proposal");
        const transitionAt =
          event.type === "project-work.decision.accepted"
            ? event.acceptedAt
            : event.type === "project-work.decision.rejected"
              ? event.rejectedAt
              : event.supersededAt;
        if (transitionAt !== event.occurredAt)
          return yield* deny("Retained decision transition time is inconsistent");
        if (
          event.type === "project-work.decision.superseded" &&
          (event.replacement.projectId !== projectId ||
            event.replacement.state !== "proposed" ||
            event.replacement.supersedesDecisionId !== event.decisionId ||
            reconstructed.decisions?.some(
              (record) => record.decisionId === event.replacement.decisionId,
            ))
        )
          return yield* deny("Retained decision replacement is inconsistent");
      }
      reconstructed = applyProjectWorkEvents(reconstructed, [event]);
    }
    return reconstructed;
  });
  const readDecisions = Effect.fn("ProjectTeamContext.readDecisions")(function* (
    state: Awaited<ReturnType<typeof emptyProjectWorkReducerState>>,
  ) {
    const retained = (yield* readRetained(state.projectId, "decision")).decisions ?? [];
    if (!same(retained, state.decisions ?? []))
      return yield* deny("Required decisions disagree with current retained state");
    const metadata = yield* sql<{
      bytes: number;
    }>`SELECT length(CAST(decision_id AS BLOB))+length(CAST(title AS BLOB))+length(CAST(body AS BLOB))+
      COALESCE(length(CAST(attribution_json AS BLOB)),0)+COALESCE(length(CAST(state_transition_attribution_json AS BLOB)),0)+
      COALESCE(length(CAST(rejection_reason AS BLOB)),0)+COALESCE(length(CAST(supersedes_decision_id AS BLOB)),0)+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))+
      COALESCE(length(CAST(rejected_at AS BLOB)),0)+length(CAST(state AS BLOB)) AS bytes FROM project_work_decisions WHERE project_id=${state.projectId} LIMIT 4097`;
    if (
      metadata.length !== retained.length ||
      metadata.length > Bounds.ledgerRows ||
      metadata.some(
        (row) =>
          !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > Bounds.contextBytes,
      ) ||
      metadata.reduce((sum, row) => sum + row.bytes, 0) > Bounds.ledgerBytes
    )
      return yield* deny("Required decision projections exceed retained bounds");
    const rows = yield* sql<{
      decisionId: string;
      projectId: string;
      title: string | null;
      body: string | null;
      state: string;
      supersedesDecisionId: string | null;
      rejectionReason: string | null;
      rejectedAt: string | null;
      revision: number;
      createdAt: string;
      updatedAt: string;
      attribution: string | null;
      transition: string | null;
    }>`
      SELECT decision_id AS decisionId,project_id AS projectId,state,supersedes_decision_id AS supersedesDecisionId,rejected_at AS rejectedAt,revision,created_at AS createdAt,updated_at AS updatedAt,
      CASE WHEN length(CAST(title AS BLOB))<=${Bounds.contextBytes} THEN title END AS title,
      CASE WHEN length(CAST(body AS BLOB))<=${Bounds.contextBytes} THEN body END AS body,
      CASE WHEN length(CAST(rejection_reason AS BLOB))<=${Bounds.contextBytes} THEN rejection_reason END AS rejectionReason,
      CASE WHEN length(CAST(attribution_json AS BLOB))<=${Bounds.contextBytes} THEN attribution_json END AS attribution,
      CASE WHEN length(CAST(state_transition_attribution_json AS BLOB))<=${Bounds.contextBytes} THEN state_transition_attribution_json END AS transition
      FROM project_work_decisions WHERE project_id=${state.projectId} ORDER BY decision_id LIMIT 4097`;
    if (rows.length !== retained.length || rows.length > Bounds.ledgerRows)
      return yield* deny("Required decisions have incomplete physical records");
    for (const row of rows) {
      const physical = yield* decodeDecision({
        decisionId: row.decisionId,
        projectId: row.projectId,
        title: row.title,
        body: row.body,
        state: row.state,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.supersedesDecisionId === null
          ? {}
          : { supersedesDecisionId: row.supersedesDecisionId }),
        ...(row.rejectionReason === null ? {} : { rejectionReason: row.rejectionReason }),
        ...(row.rejectedAt === null ? {} : { rejectedAt: row.rejectedAt }),
        ...(row.attribution === null
          ? {}
          : { attribution: yield* decodeAttributionJson(row.attribution) }),
        ...(row.transition === null
          ? {}
          : { stateTransitionAttribution: yield* decodeAttributionJson(row.transition) }),
      });
      if (
        !same(
          physical,
          retained.find((record) => record.decisionId === physical.decisionId),
        )
      )
        return yield* deny("Required decision projection disagrees with its original events");
    }
    const accepted = retained
      .filter((record) => record.state === "accepted")
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
    if (accepted.length > 64) return yield* deny("Required accepted decisions exceed bounds");
    return accepted;
  });
  const readKnowledge = Effect.fn("ProjectTeamContext.readKnowledge")(function* (
    state: Awaited<ReturnType<typeof emptyProjectWorkReducerState>>,
  ) {
    const metadata = yield* sql<{ bytes: number }>`SELECT
      length(CAST(knowledge_id AS BLOB))+length(CAST(title AS BLOB))+length(CAST(body AS BLOB))+COALESCE(length(CAST(attribution_json AS BLOB)),0)+
      length(CAST(source_kind AS BLOB))+length(CAST(source_id AS BLOB))+COALESCE(length(CAST(supersedes_knowledge_id AS BLOB)),0)+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB)) AS bytes
      FROM project_work_knowledge WHERE project_id=${state.projectId} ORDER BY knowledge_id LIMIT 257`;
    if (
      metadata.length > 256 ||
      metadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > Bounds.contextBytes) ||
      metadata.reduce((sum, row) => sum + row.bytes, 0) > Bounds.ledgerBytes
    )
      return yield* deny("Knowledge closure exceeds bounds");
    const retained = (yield* readRetained(state.projectId, "knowledge")).knowledge ?? [];
    if (retained.length !== metadata.length || !same(retained, state.knowledge ?? []))
      return yield* deny("Knowledge closure disagrees with retained state");
    const rows = yield* sql<{
      knowledgeId: string;
      projectId: string;
      title: string | null;
      body: string | null;
      sourceKind: string;
      sourceId: string;
      revision: number;
      supersedesKnowledgeId: string | null;
      createdAt: string;
      updatedAt: string;
      attribution: string | null;
    }>`
      SELECT knowledge_id AS knowledgeId,project_id AS projectId,source_kind AS sourceKind,source_id AS sourceId,revision,supersedes_knowledge_id AS supersedesKnowledgeId,created_at AS createdAt,updated_at AS updatedAt,
      CASE WHEN length(CAST(title AS BLOB))<=${Bounds.contextBytes} THEN title END AS title,
      CASE WHEN length(CAST(body AS BLOB))<=${Bounds.contextBytes} THEN body END AS body,
      CASE WHEN length(CAST(attribution_json AS BLOB))<=${Bounds.contextBytes} THEN attribution_json END AS attribution
      FROM project_work_knowledge WHERE project_id=${state.projectId} ORDER BY knowledge_id LIMIT 257`;
    for (const row of rows) {
      const physical = yield* decodeKnowledge({
        knowledgeId: row.knowledgeId,
        projectId: row.projectId,
        title: row.title,
        body: row.body,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.supersedesKnowledgeId === null
          ? {}
          : { supersedesKnowledgeId: row.supersedesKnowledgeId }),
        ...(row.attribution === null
          ? {}
          : { attribution: yield* decodeAttributionJson(row.attribution) }),
      });
      if (
        !same(
          physical,
          retained.find((record) => record.knowledgeId === physical.knowledgeId),
        )
      )
        return yield* deny("Knowledge projection disagrees with its original events");
    }
    const selection = selectCurrentProjectWorkKnowledge({
      projectId: state.projectId,
      records: retained,
      complete: true,
    });
    if (selection.status === "degraded") return yield* deny(selection.reason);
    const terminals = selection.records;
    if (terminals.length > 12) return yield* deny("Current knowledge selection exceeds bounds");
    if (Buffer.byteLength(canonicalProjectWorkPayload(terminals), "utf8") > 8192)
      return yield* deny("Current knowledge selection exceeds its UTF8 bound");
    return terminals;
  });
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
      command_id: string;
    }>`SELECT event_id,project_id,occurred_at,command_id,
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
    if (validated.kind === "question" && validated.status === "answered") {
      const answer = validated.answeredBy;
      const receipts = yield* sql<{
        actorKind: string | null;
        actorId: string | null;
        sourceKind: string | null;
        sourceId: string | null;
        createdAt: string;
        eventIds: string | null;
        result: string | null;
      }>`SELECT actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId,created_at AS createdAt,
        CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS eventIds,
        CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result
        FROM project_work_command_receipts WHERE project_id=${validated.projectId} AND command_id=${storedEvent.command_id} LIMIT 2`;
      const receipt = receipts[0];
      if (
        receipts.length !== 1 ||
        receipt === undefined ||
        answer?.actor.kind !== "human" ||
        receipt.actorKind !== answer.actor.kind ||
        receipt.actorId !== (answer.actor.id ?? null) ||
        receipt.sourceKind !== answer.source.kind ||
        receipt.sourceId !== (answer.source.id ?? null) ||
        receipt.createdAt !== answer.recordedAt ||
        receipt.createdAt !== event.occurredAt ||
        receipt.eventIds === null ||
        receipt.result === null
      )
        return yield* deny("Required human answer disagrees with its original receipt");
      const eventIds = yield* decodeAnswerEventIds(receipt.eventIds);
      const result = yield* decodeAnswerResult(receipt.result);
      const index = eventIds.findIndex((id) => id === event.eventId);
      if (
        index < 0 ||
        eventIds.findLastIndex((id) => id === event.eventId) !== index ||
        new Set(eventIds).size !== eventIds.length ||
        result.projectId !== validated.projectId ||
        result.receipt.commandId !== storedEvent.command_id ||
        result.receipt.projectId !== validated.projectId ||
        result.receipt.status !== "accepted" ||
        result.receipt.eventCount !== eventIds.length ||
        result.receipt.revision !== result.revision ||
        result.revision - event.revision !== eventIds.length - index - 1 ||
        result.delta.projectId !== validated.projectId ||
        result.delta.revision !== result.revision ||
        !same(result.delta.eventIds, eventIds.slice(0, 64))
      )
        return yield* deny("Required human answer is not in its exact accepted receipt");
    }
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
      length(CAST(reservation_json AS BLOB))+COALESCE(length(CAST(settlement_json AS BLOB)),0)+
      length(CAST(accounting_mode AS BLOB))+COALESCE(length(CAST(unknown_maximum_tokens AS BLOB)),0) AS bytes
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
    let observedChargedTokens = 0;
    let nominalHeldTokens = 0;
    let unknownChargedTokens = 0;
    let unknownOutcomeCalls = 0;
    let outstandingRequests = 0;
    const monitoredGrant = yield* sql<{
      model: string;
      route_id: string;
      maximum_tokens: number;
      maximum_duration_ms: number;
      deadline_at_ms: number;
      stopped_at_ms: number | null;
      stop_reason: string | null;
    }>`SELECT model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stopped_at_ms,stop_reason
      FROM project_team_pi_subscription_grant WHERE environment_id=${options.environmentId}
      AND project_id=${binding.projectId} AND root_task_id=${limits.rootTaskId} LIMIT 2`;
    const grant = monitoredGrant[0];
    if (
      monitoredGrant.length > 1 ||
      (grant !== undefined &&
        (grant.model !== "gpt-6-luna" ||
          grant.route_id !== "openai-subscription-luna" ||
          grant.maximum_tokens !== 64_000 ||
          grant.maximum_tokens !== limits.maximumTokens ||
          grant.maximum_duration_ms !== 300_000 ||
          grant.deadline_at_ms !== limits.rootDeadlineAtMs))
    )
      return yield* deny("Subscription stopping record is invalid");
    // The original root grant selects aggregate policy; memory retains its hard per-request mode.
    const accountingMode = grant === undefined ? "hard" : "openai-subscription-monitored";
    const receipts: Array<{
      reservationId: string;
      runId: string;
      generation: number;
      status: string;
      capacityState: string;
      chargedTokens: number;
      accountingReceiptId: string | null;
    }> = [];
    const memoryLedgers = new Map<
      string,
      Effect.Success<ReturnType<typeof auditProjectMemoryOperationLedger>> & {
        maximumTokens: number;
      }
    >();
    let hardMemoryRootTokens = 0;
    const hardMemoryAttemptTokens = new Map<string, number>();
    const hardMemoryOperationTokens = new Map<string, number>();
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
        (row.request_lane === "pi" &&
          (row.model !== claim.binding.model ||
            (row.accounting_mode === "hard"
              ? row.provider !== "command-code"
              : row.provider !== "openai-codex" || row.route_id !== "openai-subscription-luna") ||
            row.request_scope !== "")) ||
        (row.request_lane === "memory" &&
          (row.accounting_mode !== "hard" || row.unknown_maximum_tokens !== null)) ||
        row.deadline_at_ms > owner.intent.limits.deadlineAtMs ||
        metadata[index]?.reservation_id !== row.reservation_id ||
        Buffer.byteLength(row.reservation_json) > 8192 ||
        Buffer.byteLength(row.settlement_json ?? "") > 16384
      )
        return yield* deny("Remaining budget owner identity is invalid");
      if (
        row.request_lane === "pi" &&
        (row.accounting_mode !== accountingMode ||
          row.accounting_mode !==
            (claim.binding.model === "gpt-6-luna" ? "openai-subscription-monitored" : "hard"))
      )
        return yield* deny(
          "Remaining Pi accounting mode disagrees with its original binding or root grant",
        );
      if (row.request_lane === "memory") {
        let ledger = memoryLedgers.get(row.operation_id);
        if (ledger === undefined) {
          const auditedLedger = yield* auditProjectMemoryOperationLedger(sql, {
            environmentId: options.environmentId,
            projectId: binding.projectId,
            bindingId: row.run_id,
            generation: row.generation,
            operationId: row.operation_id,
          });
          // The memory audit binds every admitted owner to this exact original operation ceiling.
          const operations = yield* sql<{ maximum_tokens: number }>`SELECT maximum_tokens
            FROM project_team_pi_operation WHERE operation_id=${row.operation_id}
            AND environment_id=${row.environment_id} AND project_id=${row.project_id}
            AND binding_id=${row.run_id} AND generation=${row.generation} LIMIT 2`;
          const operation = operations[0];
          if (
            operations.length !== 1 ||
            operation === undefined ||
            !Number.isSafeInteger(operation.maximum_tokens) ||
            operation.maximum_tokens <= 0
          )
            return yield* deny("Remaining memory operation ceiling is invalid");
          ledger = { ...auditedLedger, maximumTokens: operation.maximum_tokens };
          memoryLedgers.set(row.operation_id, ledger);
        }
        const audited = ledger.rows.find((entry) => entry.reservation_id === row.reservation_id);
        if (
          audited === undefined ||
          audited.reservation_json !== row.reservation_json ||
          audited.settlement_json !== row.settlement_json ||
          audited.charged_input_tokens !== row.charged_input_tokens ||
          audited.charged_output_tokens !== row.charged_output_tokens ||
          audited.status !== row.status ||
          audited.capacity_state !== row.capacity_state
        )
          return yield* deny("Remaining memory ledger disagrees with its original accounting");
        const charged =
          row.status === "held"
            ? add(row.maximum_input_tokens, row.maximum_output_tokens)
            : add(row.charged_input_tokens, row.charged_output_tokens);
        // Monitored Pi may overshoot and hold nominal capacity. Memory's hard
        // operation, attempt and root ceilings still apply cumulatively to its own lane.
        hardMemoryRootTokens = add(hardMemoryRootTokens, charged);
        const attemptTokens = add(hardMemoryAttemptTokens.get(row.run_id) ?? 0, charged);
        const operationTokens = add(hardMemoryOperationTokens.get(row.operation_id) ?? 0, charged);
        if (
          operationTokens > ledger.maximumTokens ||
          attemptTokens > owner.intent.limits.attemptMaximumTokens ||
          hardMemoryRootTokens > limits.maximumTokens
        )
          return yield* deny(
            "Remaining hard memory operation, attempt or root budget is overdrawn",
          );
        hardMemoryAttemptTokens.set(row.run_id, attemptTokens);
        hardMemoryOperationTokens.set(row.operation_id, operationTokens);
        if (row.status === "held") nominalHeldTokens = add(nominalHeldTokens, charged);
        else observedChargedTokens = add(observedChargedTokens, charged);
        rootUsedTokens = add(rootUsedTokens, charged);
        if (row.attempt_id === binding.attemptId)
          attemptUsedTokens = add(attemptUsedTokens, charged);
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
        continue;
      }
      const reservation = yield* decodeReservation(row.reservation_json);
      const monitored = row.accounting_mode === "openai-subscription-monitored";
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
        ...(monitored
          ? { accountingMode: "openai-subscription-monitored", unknownMaximumTokens: 64_000 }
          : {}),
      };
      if (
        row.unknown_maximum_tokens !== (monitored ? 64_000 : null) ||
        reservation.accountingMode !== (monitored ? "openai-subscription-monitored" : undefined) ||
        reservation.unknownMaximumTokens !== (monitored ? 64_000 : undefined) ||
        (monitored
          ? row.provider !== "openai-codex" || row.route_id !== "openai-subscription-luna"
          : row.provider !== "command-code")
      )
        return yield* deny("Remaining budget accounting mode is invalid");
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
        nominalHeldTokens = add(nominalHeldTokens, maximum);
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
              (!monitored &&
                (usage.prompt_tokens > row.maximum_input_tokens ||
                  usage.completion_tokens > row.maximum_output_tokens)) ||
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
          row.status === "reported"
            ? usage!.prompt_tokens
            : monitored
              ? row.charged_input_tokens
              : row.maximum_input_tokens;
        const outputCharge =
          row.status === "reported"
            ? usage!.completion_tokens
            : monitored
              ? row.charged_output_tokens
              : row.maximum_output_tokens;
        if (
          monitored &&
          row.status === "unknown" &&
          (inputCharge !== row.maximum_input_tokens || outputCharge !== row.unknown_maximum_tokens)
        )
          return yield* deny("Unknown subscription usage lacks its conservative charge");
        if (inputCharge !== row.charged_input_tokens || outputCharge !== row.charged_output_tokens)
          return yield* deny("Uncertain model requests must retain their full charge");
        charged = add(inputCharge, outputCharge);
        observedChargedTokens = add(observedChargedTokens, charged);
        if (row.status !== "reported") unknownChargedTokens = add(unknownChargedTokens, charged);
        if (row.status === "unknown") unknownOutcomeCalls++;
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
    if (accountingMode !== "openai-subscription-monitored" && rootUsedTokens > limits.maximumTokens)
      return yield* deny("Root model budget is overdrawn");
    if (
      grant !== undefined &&
      ((grant.stopped_at_ms === null) !== (grant.stop_reason === null) ||
        (grant.stop_reason !== null &&
          grant.stop_reason !== "threshold-reached" &&
          grant.stop_reason !== "unknown-usage") ||
        (grant.stop_reason === "threshold-reached" && observedChargedTokens < 64_000) ||
        (grant.stop_reason === "unknown-usage" && unknownOutcomeCalls === 0) ||
        (grant.stop_reason === null &&
          (observedChargedTokens >= 64_000 || unknownOutcomeCalls > 0)))
    )
      return yield* deny("Subscription stopping record is invalid");
    return {
      rootUsedTokens,
      rootRemainingTokens: Math.max(
        0,
        limits.maximumTokens -
          (accountingMode === "openai-subscription-monitored"
            ? observedChargedTokens
            : rootUsedTokens),
      ),
      ...(accountingMode === "openai-subscription-monitored"
        ? {
            policy: {
              accountingMode,
              thresholdTokens: 64_000,
              ...(monitoredGrant[0]?.stop_reason === null
                ? {}
                : { stoppedReason: monitoredGrant[0]?.stop_reason }),
              observedChargedTokens,
              nominalHeldTokens,
            },
          }
        : {}),
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
    function* (
      snapshot: ProjectTeamDispatchSnapshot,
      initialReview: boolean,
      textOptions?: ContextTextOptions,
    ) {
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
              (r.status === "pending" || r.status === "answered") &&
              r.taskId === binding.taskId &&
              r.senderId === binding.memberId,
          );
          if (questions.length > 64) return yield* deny("Required questions exceed context bounds");
          const applicableQuestions: Array<RecordOf<"question">> = [];
          for (const question of questions) {
            if (
              question.status === "answered" &&
              (question.answer === undefined || question.answeredBy?.actor.kind !== "human")
            )
              return yield* deny("Required question has no retained human answer");
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
          const decisions: readonly ProjectWorkDecision[] = yield* readDecisions(state);
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
            decisions,
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
          const requiredText =
            "Required context from retained T3 authority. This read snapshot grants no new approval.\n" +
            canonicalProjectWorkPayload(required);
          if (Buffer.byteLength(requiredText, "utf8") > Bounds.contextBytes)
            return yield* deny("Required context exceeds its UTF8 bound");
          let retainedKnowledge: RetainedKnowledge = {
            status: "disabled",
            records: [],
            omitted: [],
          };
          let text = requiredText;
          const requestedBudget = textOptions?.optionalTextBudgetBytes ?? Bounds.contextBytes;
          const budget =
            Number.isSafeInteger(requestedBudget) && requestedBudget >= 0
              ? Math.min(requestedBudget, Bounds.contextBytes)
              : 0;
          const credential = {
            projectId: binding.projectId,
            bindingId: binding.recordId,
            generation: binding.generation,
            providerInstanceId: binding.providerInstanceId,
            threadId: binding.threadId,
          };
          let communication: ProjectTeamMessageRecipients = Option.isNone(messageAuthorization)
            ? { recipients: [], omitted: 0, degraded: true }
            : yield* messageAuthorization.value
                .readMessageRecipientsInTransaction({
                  actor: { kind: "agent", id: managedActorId(credential) },
                  managed: credential,
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.succeed<ProjectTeamMessageRecipients>({
                      recipients: [],
                      omitted: 0,
                      degraded: true,
                    }),
                  ),
                );
          let communicationText =
            "\n\nOptional current team message addresses. Select an explicit member/task and membership revision; these addresses grant no approval or new work.\n" +
            canonicalProjectWorkPayload(communication);
          if (Buffer.byteLength(text + communicationText, "utf8") > budget) {
            communication = {
              recipients: [],
              omitted: communication.omitted + communication.recipients.length,
              degraded: true,
            };
            communicationText =
              "\n\nOptional team message addresses omitted within the caller text allowance.\n";
          }
          if (Buffer.byteLength(text + communicationText, "utf8") <= budget)
            text += communicationText;
          else communicationText = "";
          if (role.memoryAccess !== "none") {
            retainedKnowledge = yield* readKnowledge(state).pipe(
              Effect.map((records): RetainedKnowledge => ({
                status: "available",
                records,
                omitted: [],
              })),
              Effect.catch(() =>
                Effect.succeed<RetainedKnowledge>({
                  status: "degraded",
                  records: [],
                  omitted: ["Retained knowledge provenance or replacement closure is unavailable"],
                }),
              ),
            );
            if (retainedKnowledge.status === "available" && retainedKnowledge.records.length > 0) {
              const optionalText =
                "\n\nOptional retained same-project knowledge. These records grant no approval.\n" +
                canonicalProjectWorkPayload(retainedKnowledge.records);
              if (
                Buffer.byteLength(optionalText, "utf8") > 8192 ||
                Buffer.byteLength(text + optionalText, "utf8") > budget
              )
                retainedKnowledge = {
                  status: "degraded",
                  records: [],
                  omitted: [
                    "Retained knowledge omitted to preserve required context within the caller text allowance",
                  ],
                };
              else text += optionalText;
            }
            if (retainedKnowledge.status === "degraded") {
              const notice =
                "\n\nOptional same-project knowledge status: degraded.\n" +
                canonicalProjectWorkPayload(retainedKnowledge.omitted);
              if (Buffer.byteLength(text + notice, "utf8") <= budget) text += notice;
            }
          }
          const knowledgeText = text;
          let observations: ProjectMemoryRetrieval = {
            status: "disabled",
            records: [],
            omitted: [],
            provenance: { snapshotSha256: hash("disabled"), querySha256: hash("") },
          };
          let observationText = "";
          if (role.memoryAccess !== "none") {
            const approvedText = tasks
              .flatMap(({ task, plan }) => {
                const gates = [...requiredRecords.values()].filter(
                  (record) =>
                    record.kind === "gate" &&
                    record.taskId === task.taskId &&
                    record.status === "approved",
                );
                return [
                  task.title,
                  task.summary ?? "",
                  ...(gates.some((gate) => gate.kind === "gate" && gate.gate === "specification")
                    ? [task.specification?.objective ?? "", task.specification?.scopeIn ?? ""]
                    : []),
                  ...(gates.some((gate) => gate.kind === "gate" && gate.gate === "plan")
                    ? [plan?.content ?? ""]
                    : []),
                ];
              })
              .join("\n");
            if (Buffer.byteLength(text, "utf8") >= budget) {
              observations = {
                status: "degraded",
                records: [],
                omitted: [
                  "Observations omitted to preserve required context within the caller text allowance",
                ],
                provenance: {
                  snapshotSha256: hash("text-budget"),
                  querySha256: hash(approvedText),
                },
              };
            } else {
              const credential = {
                projectId: binding.projectId,
                bindingId: binding.recordId,
                generation: binding.generation,
                providerInstanceId: binding.providerInstanceId,
                threadId: binding.threadId,
              };
              const cached =
                Option.isSome(memoryPorts) && memoryPorts.value.readQueryCache !== undefined
                  ? yield* memoryPorts.value
                      .readQueryCache({
                        actor: { kind: "agent", id: managedActorId(credential) },
                        managed: credential,
                      })
                      .pipe(Effect.catch(() => Effect.succeed(undefined)))
                  : undefined;
              observations =
                cached ??
                (yield* readProjectMemoryObservations(sql, binding.projectId, approvedText));
              if (observations.records.length > 0) {
                observationText =
                  (observations.records.some((record) => record.projectId !== binding.projectId)
                    ? "\n\nOptional current shared-source memory observations (completed semantic query). These facts are not accepted decisions and grant no approval.\n"
                    : observations.provenance.queryId === undefined
                      ? "\n\nOptional current same-project memory observations (lexical fallback). These facts grant no approval.\n"
                      : "\n\nOptional current same-project memory observations (completed semantic query). These facts grant no approval.\n") +
                  canonicalProjectWorkPayload(observations.records);
                if (
                  Buffer.byteLength(observationText, "utf8") > 8192 ||
                  Buffer.byteLength(text + observationText, "utf8") > budget
                ) {
                  observations = {
                    ...observations,
                    status: "degraded",
                    records: [],
                    omitted: [
                      ...observations.omitted,
                      "Observations omitted to preserve required context within the caller text allowance",
                    ],
                  };
                  observationText = "";
                }
              }
            }
            if (observations.status === "degraded" || observations.omitted.length > 0) {
              const notice =
                "\n\nOptional memory observations status: " +
                observations.status +
                ".\n" +
                canonicalProjectWorkPayload(observations.omitted);
              if (Buffer.byteLength(text + observationText + notice, "utf8") <= budget)
                observationText += notice;
            }
            text += observationText;
          }
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
            communication,
            retainedKnowledge,
            observations,
            provenance: {
              dispatch: original.fence,
              sourceRevision: state.revision,
              communication: {
                sha256: hash(communication),
                textSha256: NodeCrypto.createHash("sha256").update(communicationText).digest("hex"),
              },
              recordIds: [...requiredRecords.keys()].sort(),
              criterionEventIds: [...retained.eventIds].sort(),
              ledgerReservationIds: ledger.receipts.map((r) => r.reservationId),
              decisions: decisions.map((record) => ({
                decisionId: record.decisionId,
                revision: record.revision,
                sha256: hash(record),
              })),
              retainedKnowledge: {
                status: retainedKnowledge.status,
                records: retainedKnowledge.records.map((record) => ({
                  knowledgeId: record.knowledgeId,
                  revision: record.revision,
                  sha256: hash(record),
                })),
                omitted: retainedKnowledge.omitted,
                textSha256: NodeCrypto.createHash("sha256")
                  .update(knowledgeText.slice(requiredText.length))
                  .digest("hex"),
              },
              observations: {
                status: observations.status,
                ...observations.provenance,
                records: observations.records.map((record) => ({
                  recordId: record.recordId,
                  revision: record.revision,
                  sourceId: record.sourceId,
                  sourceRevision: record.sourceRevision,
                  sourceGeneration: record.sourceGeneration,
                  sha256: hash(record),
                })),
                omitted: observations.omitted,
                textSha256: NodeCrypto.createHash("sha256").update(observationText).digest("hex"),
              },
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
    textOptions?: ContextTextOptions,
  ) {
    return yield* readRequiredContext(snapshot, false, textOptions);
  });
  const readForOperation = Effect.fn("ProjectTeamContext.readForOperation")(function* (
    input: typeof OperationInput.Type,
    textOptions?: ContextTextOptions,
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
    return yield* readRequiredContext(
      snapshot,
      operation.operationKind === "initialize",
      textOptions,
    );
  });
  return { readRequired, readForOperation };
});
