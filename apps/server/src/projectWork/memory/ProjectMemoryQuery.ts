import {
  EventId,
  ProjectTeamEffect,
  ProjectTeamMemoryQueryIntent,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkWriteResult,
  canonicalProjectWorkPayload,
  projectWorkPayloadFingerprint,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import type {
  ProjectTeamAuthority,
  ProjectTeamPrincipal,
  ProjectTeamAuthorizationError,
} from "../ProjectTeamAuthorization.ts";
import { ProjectWorkRepository, readCurrentState } from "../ProjectWorkRepository.ts";
import { ProjectWorkContentGuard } from "../ProjectWorkContentGuard.ts";
import {
  ProjectMemoryOperation,
  ProjectMemoryTaskOwner,
  ProjectMemoryQueryOwner,
  auditProjectMemoryTaskOwner,
  auditProjectMemoryOperationLedger,
  makeProjectMemoryModelAccounting,
  ProjectMemoryReservation,
  ProjectMemorySettlement,
} from "./ProjectMemoryModelAccounting.ts";
import {
  ProjectMemoryPorts,
  ProjectMemoryProcessingConfiguration,
  type ProjectMemoryModelExchange,
  type ProjectMemoryModelResponse,
} from "./ProjectMemoryPorts.ts";
import {
  MemoryVector,
  MemoryBackendCandidate,
  MemoryBackendError,
  type MemoryBackendTransport,
} from "./MemoryBackend.ts";
import { makeMem0Backend } from "./Mem0Backend.ts";
import {
  readProjectMemoryObservations,
  type ProjectMemoryRetrieval,
} from "./ProjectMemoryRetrieval.ts";
import { qualifyProjectMemorySharedSource } from "./ProjectMemorySharing.ts";
import { ProjectTeamAuthorization } from "../ProjectTeamAuthorization.ts";
import { ProjectMemoryServiceError, projectMemoryHash } from "./ProjectMemoryService.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const strict = { onExcessProperty: "error" } as const;
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isServiceError = Schema.is(ProjectMemoryServiceError);
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const EmbeddingIntent = Schema.Struct({
  version: Schema.Literal(1),
  queryId: Id,
  ownerSha256: Hash,
  querySha256: Hash,
  configuration: ProjectMemoryProcessingConfiguration,
  requestId: Schema.Literal(1),
  maximumInputTokens: Positive,
  maximumOutputTokens: Positive,
  deadlineAtMs: Positive,
});
const EmbeddingResult = Schema.Struct({
  version: Schema.Literal(1),
  queryId: Id,
  reservationId: Id,
  reservationSha256: Hash,
  accountingReceiptId: Id,
  outcome: Schema.Literals(["reported", "failed", "unknown"]),
  vector: Schema.optionalKey(MemoryVector),
});
const SearchIntent = Schema.Struct({
  version: Schema.Literal(1),
  queryId: Id,
  requestId: Id,
  ownerSha256: Hash,
  configurationSha256: Hash,
  vectorSha256: Hash,
  deadlineAtMs: Positive,
  limit: Schema.Literal(12),
});
const SearchResult = Schema.Struct({
  version: Schema.Literal(1),
  queryId: Id,
  requestId: Id,
  intentSha256: Hash,
  outcome: Schema.Literals(["completed", "unknown"]),
  transportDrained: Schema.Boolean,
  candidates: Schema.Array(MemoryBackendCandidate).check(Schema.isMaxLength(12)),
});
const SearchDrain = Schema.Struct({
  version: Schema.Literal(1),
  queryId: Id,
  requestId: Id,
  intentSha256: Hash,
  resultSha256: Hash,
  transportDrained: Schema.Literal(true),
});
const CacheResult = Schema.Struct({
  kind: Schema.Literal("memory-query-result"),
  version: Schema.Literal(1),
  queryId: Id,
  outcome: Schema.Literals(["completed", "failed"]),
  embeddingSha256: Schema.optionalKey(Hash),
  searchSha256: Schema.optionalKey(Hash),
  searchDrainSha256: Schema.optionalKey(Hash),
  snapshotSha256: Schema.optionalKey(Hash),
  hitIds: Schema.Array(Id).check(Schema.isMaxLength(12)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  reflection: Schema.Struct({
    at: Schema.String,
    expectedRevision: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
    ),
  }),
});
const decodeEmbeddingIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EmbeddingIntent),
  strict,
);
const decodeEmbeddingResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EmbeddingResult),
  strict,
);
const decodeSearchIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchIntent), strict);
const decodeSearchResult = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchResult), strict);
const decodeSearchDrain = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchDrain), strict);
const decodeCacheResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheResult), strict);
const decodeVectors = Schema.decodeUnknownEffect(
  Schema.Array(MemoryVector).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  strict,
);
const decodeReservationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryReservation),
  strict,
);
const decodeSettlementJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemorySettlement),
  strict,
);
export { ProjectMemoryQueryOwner };
const decodeOwner = Schema.decodeUnknownEffect(ProjectMemoryQueryOwner, strict);
const decodeOwnerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryQueryOwner),
  strict,
);
const decodeRequest = Schema.decodeUnknownEffect(ProjectTeamMemoryQueryIntent, strict);
const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand, strict);
const decodeEffect = Schema.decodeUnknownEffect(ProjectTeamEffect, strict);
const decodeEffectJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamEffect),
  strict,
);
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(EventId)), strict);
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const finalCommand = Effect.fn("ProjectMemoryQuery.finalCommand")(function* (
  owner: ProjectMemoryQueryOwner,
  result: typeof CacheResult.Type,
) {
  const at = result.reflection.at;
  if (!Number.isFinite(Date.parse(at)) || result.queryId !== owner.admittedEffect.effectId)
    return yield* deny("Query result identity or time changed");
  return yield* decodeCommand({
    type: "project-work.foundation.commit",
    commandId: `${result.queryId}:result`,
    projectId: owner.request.projectId,
    expectedRevision: result.reflection.expectedRevision,
    attribution: {
      actor: { kind: "system", id: "project-memory-query" },
      source: { kind: "system", id: "project-memory-query" },
      recordedAt: at,
    },
    records: [
      {
        ...owner.admittedEffect,
        revision: owner.admittedEffect.revision + 1,
        status: result.outcome === "completed" ? "succeeded" : "failed",
        updatedAt: at,
        outcome: canonicalProjectWorkPayload({
          kind: result.kind,
          version: result.version,
          queryId: result.queryId,
          outcome: result.outcome,
          reflection: result.reflection,
          resultSha256: projectMemoryHash(result),
        }),
      },
    ],
    committedAt: at,
  });
});
const auditFinalResult = Effect.fn("ProjectMemoryQuery.auditFinalResult")(function* (
  sql: SqlClient.SqlClient,
  owner: ProjectMemoryQueryOwner,
  result: typeof CacheResult.Type,
) {
  const command = yield* finalCommand(owner, result);
  const metadata = yield* sql<{ bytes: number }>`SELECT length(CAST(payload_fingerprint AS BLOB))+
    length(CAST(actor_kind AS BLOB))+length(CAST(actor_id AS BLOB))+length(CAST(source_kind AS BLOB))+
    length(CAST(source_id AS BLOB))+length(CAST(created_at AS BLOB))+length(CAST(event_ids_json AS BLOB))+
    length(CAST(result_json AS BLOB)) AS bytes FROM project_work_command_receipts
    WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
  if (
    metadata.length !== 1 ||
    !Number.isSafeInteger(metadata[0]?.bytes) ||
    (metadata[0]?.bytes ?? 524289) > 524288
  )
    return yield* deny("Query completion has no bounded original command receipt");
  const receipts = yield* sql<{
    fingerprint: string;
    actorKind: string;
    actorId: string;
    sourceKind: string;
    sourceId: string;
    at: string;
    ids: string;
    result: string;
  }>`SELECT payload_fingerprint AS fingerprint,actor_kind AS actorKind,actor_id AS actorId,
    source_kind AS sourceKind,source_id AS sourceId,created_at AS at,event_ids_json AS ids,result_json AS result
    FROM project_work_command_receipts WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
  const receipt = receipts[0];
  if (
    receipt === undefined ||
    receipt.actorKind !== "system" ||
    receipt.actorId !== "project-memory-query" ||
    receipt.sourceKind !== "system" ||
    receipt.sourceId !== "project-memory-query" ||
    receipt.at !== result.reflection.at ||
    receipt.fingerprint !==
      projectWorkPayloadFingerprint({
        ...command,
        attribution: { actor: command.attribution.actor, source: command.attribution.source },
      })
  )
    return yield* deny("Query completion command authority or fingerprint changed");
  const ids = yield* decodeIds(receipt.ids);
  const original = yield* decodeResult(receipt.result);
  const eventId = `${command.commandId}:project-work:0`;
  const revision = command.expectedRevision + 1;
  if (
    !same(ids, [eventId]) ||
    original.projectId !== command.projectId ||
    original.revision !== revision ||
    original.receipt.commandId !== command.commandId ||
    original.receipt.projectId !== command.projectId ||
    original.receipt.status !== "accepted" ||
    original.receipt.revision !== revision ||
    original.receipt.eventCount !== 1 ||
    original.delta.projectId !== command.projectId ||
    original.delta.revision !== revision ||
    !same(original.delta.eventIds, ids) ||
    !same(original.delta.changedFields, ["foundationRecords"])
  )
    return yield* deny("Query completion receipt does not cover its exact event");
  const eventMetadata = yield* sql<{
    bytes: number;
  }>`SELECT length(CAST(event_id AS BLOB))+length(CAST(event_type AS BLOB))+
    length(CAST(occurred_at AS BLOB))+length(CAST(payload_json AS BLOB)) AS bytes FROM project_work_events
    WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
  if (
    eventMetadata.length !== 1 ||
    !Number.isSafeInteger(eventMetadata[0]?.bytes) ||
    (eventMetadata[0]?.bytes ?? 262145) > 262144
  )
    return yield* deny("Query completion event exceeds its exact bounded membership");
  const events = yield* sql<{
    id: string;
    type: string;
    at: string;
    payload: string;
  }>`SELECT event_id AS id,event_type AS type,
    occurred_at AS at,payload_json AS payload FROM project_work_events
    WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
  if (events[0] === undefined) return yield* deny("Query completion event is missing");
  const event = yield* decodeEvent(events[0].payload);
  const expected = command.records[0];
  if (
    events[0].id !== eventId ||
    events[0].type !== "project-work.foundation.recorded" ||
    events[0].at !== result.reflection.at ||
    event.eventId !== eventId ||
    event.projectId !== command.projectId ||
    event.revision !== revision ||
    event.occurredAt !== result.reflection.at ||
    !same(event.record, expected)
  )
    return yield* deny("Query completion event disagrees with its immutable stages");
  const physical = yield* sql<{
    bytes: number;
  }>`SELECT length(CAST(payload_json AS BLOB))+length(CAST(project_id AS BLOB))+
    length(CAST(status AS BLOB))+length(CAST(revision AS BLOB))+length(CAST(generation AS BLOB))+length(CAST(updated_at AS BLOB)) AS bytes
    FROM project_team_effect WHERE record_id=${owner.admittedEffect.effectId} LIMIT 2`;
  if (
    physical.length !== 1 ||
    !Number.isSafeInteger(physical[0]?.bytes) ||
    (physical[0]?.bytes ?? 262145) > 262144
  )
    return yield* deny("Query completion physical effect is unavailable");
  const projection = yield* sql<{
    projectId: string;
    status: string;
    revision: number;
    generation: number;
    at: string;
    payload: string;
  }>`SELECT
    project_id AS projectId,status,revision,generation,updated_at AS at,payload_json AS payload
    FROM project_team_effect WHERE record_id=${owner.admittedEffect.effectId} LIMIT 2`;
  const row = projection[0];
  if (
    expected === undefined ||
    row === undefined ||
    row.projectId !== expected.projectId ||
    row.status !== expected.status ||
    row.revision !== expected.revision ||
    row.generation !== expected.generation ||
    row.at !== expected.updatedAt ||
    !same(yield* decodeEffectJson(row.payload), expected)
  )
    return yield* deny("Query completion physical projection changed");
});
const decodeEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: EventId,
      projectId: ProjectTeamMemoryQueryIntent.fields.projectId,
      revision: ProjectTeamMemoryQueryIntent.fields.expectedRevision,
      occurredAt: Schema.String,
      type: Schema.Literal("project-work.foundation.recorded"),
      record: ProjectTeamEffect,
    }),
  ),
  strict,
);

type Qualification = {
  readonly operation: ProjectMemoryTaskOwner;
  readonly configurationSha256: string;
  readonly taskScopeSha256: string;
  readonly intentFingerprint: string;
  readonly sharedSource?: NonNullable<ProjectMemoryQueryOwner["sharedSource"]>;
};
export class ProjectMemoryQueryQualification extends Context.Service<
  ProjectMemoryQueryQualification,
  Qualification
>()("t3/projectWork/memory/ProjectMemoryQuery/ProjectMemoryQueryQualification") {}

/** Only protected task facts enter applicability; accounting and the query's own
 * completion revision cannot invalidate an otherwise unchanged task snapshot. */
export const projectMemoryQueryTaskScope = (authority: ProjectTeamAuthority) => {
  const task = authority.state.tasks.find((entry) => entry.taskId === authority.binding.taskId);
  return projectMemoryHash({
    task,
    plans: (authority.state.foundationRecords ?? []).filter(
      (entry) => entry.kind === "plan-revision" && entry.taskId === authority.binding.taskId,
    ),
    approvals: (authority.state.foundationRecords ?? []).filter(
      (record) => record.kind === "gate" && record.taskId === authority.binding.taskId,
    ),
    roleSha256: projectMemoryHash(authority.role),
    configurationSha256: projectMemoryHash(authority.binding.configuration),
    bindingId: authority.binding.recordId,
    generation: authority.binding.generation,
  });
};
const fingerprint = (
  request: ProjectTeamMemoryQueryIntent,
  principal: ProjectTeamPrincipal,
  attribution: ProjectWorkAttribution,
  qualified: Omit<Qualification, "intentFingerprint">,
) =>
  "project-team-query:" +
  projectMemoryHash({
    request,
    actor: { kind: principal.actor.kind, id: principal.actor.id },
    source: { kind: attribution.source.kind, id: attribution.source.id },
    managed: principal.managed,
    ...qualified,
  });
const originalFingerprint = (owner: ProjectMemoryQueryOwner) =>
  fingerprint(
    owner.request,
    {
      actor: { kind: "agent", id: owner.actorId },
      managed: {
        projectId: owner.operation.projectId,
        bindingId: owner.operation.bindingId,
        generation: owner.operation.generation,
        providerInstanceId: owner.operation.providerInstanceId,
        threadId: owner.operation.threadId,
      },
    },
    {
      actor: { kind: "agent", id: owner.actorId },
      source: { kind: "mcp", id: owner.sourceId },
      recordedAt: owner.admittedAt,
    },
    {
      operation: owner.operation,
      configurationSha256: owner.configurationSha256,
      taskScopeSha256: owner.taskScopeSha256,
      ...(owner.sharedSource === undefined ? {} : { sharedSource: owner.sharedSource }),
    },
  );
const admittedEffect = (
  request: ProjectTeamMemoryQueryIntent,
  qualified: Qualification,
  at: string,
) => {
  const effectId =
    "memory-query-" +
    projectMemoryHash({ projectId: request.projectId, commandId: request.commandId });
  return {
    kind: "effect",
    recordId: effectId,
    effectId,
    projectId: request.projectId,
    revision: 0,
    generation: qualified.operation.generation,
    updatedAt: at,
    status: "pending",
    effectKind: "memory-query",
    taskId: request.taskId,
    runId: qualified.operation.bindingId,
    targetId: request.commandId,
    payload: {
      recordIds: [],
      expectedRevision: request.expectedRevision,
      summary: projectMemoryHash({ query: request.query, ...qualified }),
    },
    claimGeneration: 0,
    availableAt: at,
  };
};

export const readProjectMemoryQueryOwner = Effect.fn("ProjectMemoryQuery.readOwner")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  commandId: string,
) {
  const metadata = yield* sql<{ bytes: number }>`SELECT length(CAST(owner_json AS BLOB))+
      length(CAST(query_id AS BLOB))+length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+
      length(CAST(task_id AS BLOB))+length(CAST(binding_id AS BLOB))+length(CAST(generation AS BLOB))+
      length(CAST(operation_id AS BLOB))+length(CAST(command_id AS BLOB)) AS bytes
      FROM project_team_memory_query WHERE project_id=${projectId} AND command_id=${commandId} LIMIT 2`;
  if (metadata.length === 0) return undefined;
  if (
    metadata.length !== 1 ||
    !Number.isSafeInteger(metadata[0]?.bytes) ||
    (metadata[0]?.bytes ?? 270337) > 270336
  )
    return yield* deny("Query owner exceeds its retained bound");
  const rows = yield* sql<{
    owner: string;
    id: string;
    environmentId: string;
    taskId: string;
    bindingId: string;
    generation: number;
    operationId: string;
  }>`SELECT owner_json AS owner,query_id AS id,environment_id AS environmentId,task_id AS taskId,
      binding_id AS bindingId,generation,operation_id AS operationId FROM project_team_memory_query
      WHERE project_id=${projectId} AND command_id=${commandId} LIMIT 2`;
  if (rows.length !== 1 || rows[0] === undefined)
    return yield* deny("Original query owner changed");
  const owner = yield* decodeOwnerJson(rows[0].owner);
  if (
    owner.request.projectId !== projectId ||
    owner.request.commandId !== commandId ||
    owner.admittedEffect.effectId !== rows[0].id ||
    owner.operation.environmentId !== rows[0].environmentId ||
    owner.operation.taskId !== rows[0].taskId ||
    owner.operation.bindingId !== rows[0].bindingId ||
    owner.operation.generation !== rows[0].generation ||
    owner.operation.operationId !== rows[0].operationId
  )
    return yield* deny("Original query identity changed");
  return owner;
});

export const readProjectMemoryQueryOwnerById = Effect.fn("ProjectMemoryQuery.readOwnerById")(
  function* (sql: SqlClient.SqlClient, queryId: string) {
    const rows = yield* sql<{ projectId: string | null; commandId: string | null }>`SELECT
    CASE WHEN length(CAST(project_id AS BLOB))<=1024 THEN project_id END AS projectId,
    CASE WHEN length(CAST(command_id AS BLOB))<=1024 THEN command_id END AS commandId
    FROM project_team_memory_query WHERE query_id=${queryId} LIMIT 2`;
    if (
      rows.length !== 1 ||
      rows[0]?.projectId === null ||
      rows[0]?.projectId === undefined ||
      rows[0]?.commandId === null ||
      rows[0]?.commandId === undefined
    )
      return yield* deny("Query identity is unavailable");
    const owner = yield* readProjectMemoryQueryOwner(sql, rows[0].projectId, rows[0].commandId);
    if (owner === undefined || owner.admittedEffect.effectId !== queryId)
      return yield* deny("Query owner identity changed");
    return owner;
  },
);

const readStages = Effect.fn("ProjectMemoryQuery.readStages")(function* (
  sql: SqlClient.SqlClient,
  queryId: string,
) {
  const bounds = yield* sql<{ bytes: number }>`SELECT length(CAST(status AS BLOB))+
    COALESCE(length(CAST(embedding_json AS BLOB)),0)+COALESCE(length(CAST(embedding_result_json AS BLOB)),0)+
    COALESCE(length(CAST(search_json AS BLOB)),0)+COALESCE(length(CAST(search_result_json AS BLOB)),0)+
    COALESCE(length(CAST(result_json AS BLOB)),0)+COALESCE(length(CAST(search_drain_json AS BLOB)),0) AS bytes FROM project_team_memory_query WHERE query_id=${queryId} LIMIT 2`;
  if (
    bounds.length !== 1 ||
    !Number.isSafeInteger(bounds[0]?.bytes) ||
    (bounds[0]?.bytes ?? 659521) > 659520
  )
    return yield* deny("Query stage receipts exceed their bound");
  const rows = yield* sql<{
    status: string;
    embedding: string | null;
    embedded: string | null;
    search: string | null;
    searched: string | null;
    drained: string | null;
    result: string | null;
  }>`SELECT status,
    embedding_json AS embedding,embedding_result_json AS embedded,search_json AS search,
    search_result_json AS searched,search_drain_json AS drained,result_json AS result FROM project_team_memory_query WHERE query_id=${queryId} LIMIT 2`;
  if (rows.length !== 1 || rows[0] === undefined)
    return yield* deny("Query stage receipts missing");
  return rows[0];
});

type QueryModelRow = {
  readonly reservation_id: string;
  readonly reservation_json: string;
  readonly settlement_json: string | null;
  readonly accounting_receipt_id: string | null;
  readonly status: string;
  readonly capacity_state: string;
};
export const auditProjectMemoryQueryStages = Effect.fn("ProjectMemoryQuery.auditStages")(function* (
  sql: SqlClient.SqlClient,
  owner: ProjectMemoryQueryOwner,
  ledger: readonly QueryModelRow[],
) {
  const id = owner.admittedEffect.effectId;
  const row = yield* readStages(sql, id);
  const models: QueryModelRow[] = [];
  for (const entry of ledger) {
    const reservation = yield* decodeReservationJson(entry.reservation_json);
    if (reservation.effectId === id) models.push(entry);
  }
  let intent: typeof EmbeddingIntent.Type | undefined;
  if (row.embedding !== null) {
    intent = yield* decodeEmbeddingIntent(row.embedding);
    if (
      intent.queryId !== id ||
      intent.ownerSha256 !== projectMemoryHash(owner) ||
      intent.querySha256 !== projectMemoryHash(owner.request.query) ||
      projectMemoryHash(intent.configuration) !== owner.configurationSha256 ||
      intent.maximumInputTokens !==
        Math.min(
          intent.configuration.embedding.maximumInputTokens,
          owner.operation.operationMaximumTokens - 1,
        ) ||
      intent.maximumOutputTokens !== 1 ||
      intent.deadlineAtMs !==
        Math.min(
          owner.operation.rootDeadlineAtMs,
          owner.operation.attemptDeadlineAtMs,
          owner.operation.operationDeadlineAtMs,
          owner.operation.leaseDeadlineAtMs,
        )
    )
      return yield* deny("Query embedding intent changed");
  }
  if (models.length > 1 || (intent === undefined && models.length !== 0))
    return yield* deny("Query embedding reservation is ambiguous");
  let embedded: typeof EmbeddingResult.Type | undefined;
  if (row.embedded !== null) {
    embedded = yield* decodeEmbeddingResult(row.embedded);
    const model = models[0];
    if (intent === undefined || model === undefined || model.settlement_json === null)
      return yield* deny("Query embedding result has no original accounting");
    const reservation = yield* decodeReservationJson(model.reservation_json);
    const settlement = yield* decodeSettlementJson(model.settlement_json);
    if (
      reservation.version !== 2 ||
      reservation.effectId !== id ||
      reservation.phase !== "query-embed" ||
      reservation.scope !==
        projectMemoryHash({
          version: 2,
          ownerSha256: intent.ownerSha256,
          phase: "query-embed",
          routeId: intent.configuration.embedding.routeId,
          provider: "openrouter",
          model: "nvidia/nemotron-3-embed-1b:free",
        }) ||
      reservation.requestId !== intent.requestId ||
      reservation.ownerSha256 !== intent.ownerSha256 ||
      reservation.routeId !== intent.configuration.embedding.routeId ||
      reservation.maxInputTokens !== intent.maximumInputTokens ||
      reservation.maxOutputTokens !== intent.maximumOutputTokens ||
      reservation.deadlineAtMs !== intent.deadlineAtMs ||
      embedded.queryId !== id ||
      embedded.reservationId !== model.reservation_id ||
      embedded.reservationSha256 !== projectMemoryHash(reservation) ||
      embedded.accountingReceiptId !== model.accounting_receipt_id ||
      embedded.outcome !== settlement.outcome ||
      (embedded.outcome === "reported") !== (embedded.vector !== undefined)
    )
      return yield* deny("Query embedding result disagrees with original reservation");
    if (
      model.status === "held" ||
      model.capacity_state !== "released" ||
      !settlement.transportDrained
    )
      return false;
  }
  if (row.search !== null) {
    const search = yield* decodeSearchIntent(row.search);
    if (
      embedded?.vector === undefined ||
      search.queryId !== id ||
      search.ownerSha256 !== projectMemoryHash(owner) ||
      search.configurationSha256 !== owner.configurationSha256 ||
      search.vectorSha256 !== projectMemoryHash(embedded.vector) ||
      search.deadlineAtMs !== intent?.deadlineAtMs ||
      search.requestId !== id + ":search"
    )
      return yield* deny("Query search intent changed");
    if (row.searched === null) return false;
    const searched = yield* decodeSearchResult(row.searched);
    if (
      searched.queryId !== id ||
      searched.requestId !== search.requestId ||
      searched.intentSha256 !== projectMemoryHash(search)
    )
      return yield* deny("Query search receipt changed");
    const drain = row.drained === null ? undefined : yield* decodeSearchDrain(row.drained);
    if (
      drain !== undefined &&
      (drain.queryId !== id ||
        drain.requestId !== search.requestId ||
        drain.intentSha256 !== projectMemoryHash(search) ||
        drain.resultSha256 !== projectMemoryHash(searched))
    )
      return yield* deny("Query late search drain changed");
    if (!searched.transportDrained && drain === undefined) return false;
    if (row.result === null) return false;
    const result = yield* decodeCacheResult(row.result);
    if (result.outcome === "failed") {
      if (
        row.status !== "failed" ||
        result.queryId !== id ||
        result.hitIds.length !== 0 ||
        result.reason === undefined ||
        result.embeddingSha256 !== projectMemoryHash(embedded) ||
        result.searchSha256 !== projectMemoryHash(searched) ||
        result.searchDrainSha256 !== (drain === undefined ? undefined : projectMemoryHash(drain))
      )
        return yield* deny("Query failure has no authenticated search drain");
      yield* auditFinalResult(sql, owner, result);
      return true;
    }
    if (
      searched.outcome !== "completed" ||
      !searched.transportDrained ||
      drain !== undefined ||
      result.searchDrainSha256 !== undefined ||
      row.status !== "completed" ||
      result.outcome !== "completed" ||
      result.queryId !== id ||
      result.embeddingSha256 !== projectMemoryHash(embedded) ||
      result.searchSha256 !== projectMemoryHash(searched) ||
      result.snapshotSha256 === undefined ||
      new Set(result.hitIds).size !== result.hitIds.length ||
      !result.hitIds.every((hit) =>
        searched.candidates.some(
          (candidate) =>
            candidate.observationId === hit &&
            candidate.environmentId === owner.operation.environmentId &&
            candidate.projectId ===
              (owner.sharedSource?.ownerProjectId ?? owner.operation.projectId) &&
            (owner.sharedSource === undefined ||
              (candidate.sourceRecordId === owner.sharedSource.selection.sourceRecordId &&
                candidate.sourceRevision === owner.sharedSource.selection.sourceRevision &&
                candidate.sourceGeneration === owner.sharedSource.selection.sourceGeneration)),
        ),
      )
    )
      return yield* deny("Query cache has no completed original search");
    yield* auditFinalResult(sql, owner, result);
    return true;
  }
  if (row.result !== null) {
    const result = yield* decodeCacheResult(row.result);
    if (
      row.status !== "failed" ||
      result.queryId !== id ||
      result.outcome !== "failed" ||
      result.hitIds.length !== 0 ||
      result.reason === undefined ||
      (models.length > 0 && embedded === undefined) ||
      result.embeddingSha256 !==
        (embedded === undefined ? undefined : projectMemoryHash(embedded)) ||
      result.searchSha256 !== undefined ||
      result.searchDrainSha256 !== undefined ||
      row.drained !== null
    )
      return yield* deny("Query failure receipt disagrees with its stages");
    yield* auditFinalResult(sql, owner, result);
    return true;
  }
  if (row.drained !== null) return yield* deny("Query drain has no original search");
  if (row.status === "completed" || row.status === "failed")
    return yield* deny("Settled query lacks its terminal receipt");
  return false;
});

export const auditProjectMemoryQueryAdmission = Effect.fn("ProjectMemoryQuery.auditAdmission")(
  function* (sql: SqlClient.SqlClient, owner: ProjectMemoryQueryOwner) {
    if (
      (owner.request.sharedSource === undefined) !== (owner.sharedSource === undefined) ||
      (owner.sharedSource !== undefined &&
        (owner.sharedSource.ownerProjectId === owner.request.projectId ||
          !same(owner.sharedSource.selection, owner.request.sharedSource))) ||
      owner.intentFingerprint !== originalFingerprint(owner) ||
      !same(
        owner.admittedEffect,
        admittedEffect(
          owner.request,
          {
            operation: owner.operation,
            configurationSha256: owner.configurationSha256,
            taskScopeSha256: owner.taskScopeSha256,
            intentFingerprint: owner.intentFingerprint,
            ...(owner.sharedSource === undefined ? {} : { sharedSource: owner.sharedSource }),
          },
          owner.admittedAt,
        ),
      ) ||
      owner.sourceId !== owner.operation.workerId ||
      owner.request.projectId !== owner.operation.projectId ||
      owner.request.taskId !== owner.operation.taskId ||
      owner.admittedEffect.effectKind !== "memory-query" ||
      owner.admittedEffect.taskId !== owner.operation.taskId ||
      owner.admittedEffect.runId !== owner.operation.bindingId ||
      owner.admittedEffect.targetId !== owner.request.commandId ||
      owner.admittedEffect.status !== "pending" ||
      owner.admittedEffect.claimGeneration !== 0
    )
      return yield* deny("Query admission has no original worker and request association");
    const metadata = yield* sql<{ bytes: number }>`SELECT
      length(CAST(payload_fingerprint AS BLOB))+COALESCE(length(CAST(actor_kind AS BLOB)),0)+
      COALESCE(length(CAST(actor_id AS BLOB)),0)+COALESCE(length(CAST(source_kind AS BLOB)),0)+
      COALESCE(length(CAST(source_id AS BLOB)),0)+length(CAST(created_at AS BLOB))+
      length(CAST(event_ids_json AS BLOB))+length(CAST(result_json AS BLOB)) AS bytes
      FROM project_work_command_receipts WHERE project_id=${owner.request.projectId}
      AND command_id=${owner.request.commandId} LIMIT 2`;
    if (
      metadata.length !== 1 ||
      !Number.isSafeInteger(metadata[0]?.bytes) ||
      (metadata[0]?.bytes ?? 524289) > 524288
    )
      return yield* deny("Original query receipt exceeds its bound");
    const receipts = yield* sql<{
      fingerprint: string;
      actorKind: string;
      actorId: string;
      sourceKind: string;
      sourceId: string;
      at: string;
      ids: string | null;
      result: string | null;
    }>`SELECT payload_fingerprint AS fingerprint,actor_kind AS actorKind,
      actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId,created_at AS at,
      CASE WHEN length(CAST(event_ids_json AS BLOB))<=262144 THEN event_ids_json END AS ids,
      CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result FROM project_work_command_receipts
      WHERE project_id=${owner.request.projectId} AND command_id=${owner.request.commandId} LIMIT 2`;
    const receipt = receipts[0];
    if (
      receipts.length !== 1 ||
      receipt === undefined ||
      receipt.ids === null ||
      receipt.result === null ||
      receipt.fingerprint !== owner.intentFingerprint ||
      receipt.actorKind !== "agent" ||
      receipt.actorId !== owner.actorId ||
      receipt.sourceKind !== "mcp" ||
      receipt.sourceId !== owner.sourceId ||
      receipt.at !== owner.admittedAt
    )
      return yield* deny("Original query receipt authority changed");
    const events = yield* sql<{ eventId: string; bytes: number }>`SELECT event_id AS eventId,
      length(CAST(payload_json AS BLOB)) AS bytes FROM project_work_events
      WHERE project_id=${owner.request.projectId} AND command_id=${owner.request.commandId} ORDER BY sequence LIMIT 2`;
    if (
      events.length !== 1 ||
      !Number.isSafeInteger(events[0]?.bytes) ||
      (events[0]?.bytes ?? 262145) > 262144
    )
      return yield* deny("Original query event exceeds its retained bound");
    const payloads = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM project_work_events
      WHERE project_id=${owner.request.projectId} AND command_id=${owner.request.commandId} ORDER BY sequence LIMIT 2`;
    if (payloads.length !== 1 || payloads[0] === undefined)
      return yield* deny("Original query event is missing");
    const event = yield* decodeEvent(payloads[0].payload);
    const ids = yield* decodeIds(receipt.ids);
    const result = yield* decodeResult(receipt.result);
    if (
      event.eventId !== events[0]?.eventId ||
      event.eventId !== `${owner.request.commandId}:project-work:0` ||
      event.revision !== owner.request.expectedRevision + 1 ||
      event.projectId !== owner.request.projectId ||
      event.occurredAt !== owner.admittedAt ||
      !same(event.record, owner.admittedEffect) ||
      !same(ids, [event.eventId]) ||
      !same(result.delta.eventIds, ids) ||
      result.projectId !== owner.request.projectId ||
      result.receipt.projectId !== owner.request.projectId ||
      result.revision !== event.revision ||
      result.receipt.revision !== event.revision ||
      result.receipt.status !== "accepted" ||
      result.receipt.commandId !== owner.request.commandId ||
      result.receipt.eventCount !== 1
    )
      return yield* deny("Original query command event membership changed");
    yield* auditProjectMemoryTaskOwner(sql, owner.operation);
  },
);

export const makeProjectMemoryQuery = Effect.fn("makeProjectMemoryQuery")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const guard = yield* Effect.serviceOption(ProjectWorkContentGuard);
    const loan = Effect.gen(function* () {
      const current = yield* Effect.serviceOption(SqlClient.SqlClient);
      const repo = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(current) ||
        current.value !== sql ||
        Option.isNone(repo) ||
        repo.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Query admission requires its captured gateway transaction");
    });
    const qualifyCurrent = Effect.fn("ProjectMemoryQuery.qualifyCurrent")(
      function* (
        request: ProjectTeamMemoryQueryIntent,
        principal: ProjectTeamPrincipal,
        attribution: ProjectWorkAttribution,
        resolve: (
          principal: ProjectTeamPrincipal,
        ) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>,
      ) {
        yield* loan;
        if (
          principal.actor.kind !== "agent" ||
          principal.actor.id === undefined ||
          principal.managed === undefined ||
          attribution.actor.kind !== "agent" ||
          attribution.actor.id !== principal.actor.id ||
          attribution.source.kind !== "mcp"
        )
          return yield* deny("Semantic query requires the authenticated executing task");
        const authority = yield* resolve(principal);
        const operation = yield* Effect.serviceOption(ProjectMemoryOperation);
        const ports = yield* Effect.serviceOption(ProjectMemoryPorts);
        if (
          authority === undefined ||
          Option.isNone(operation) ||
          Option.isNone(guard) ||
          Option.isNone(ports) ||
          ports.value.readConfiguration === undefined ||
          authority.role.memoryAccess === "none" ||
          !authority.role.tools.includes("project-work.write") ||
          !authority.binding.configuration.toolIds.includes("project-work.write") ||
          authority.binding.status !== "running" ||
          authority.binding.projectId !== request.projectId ||
          authority.binding.taskId !== request.taskId
        )
          return yield* deny("Query requires current task authority and configured memory ports");
        const task = authority.state.tasks.find((entry) => entry.taskId === request.taskId);
        if (
          authority.state.revision !== request.expectedRevision ||
          task?.revision !== request.expectedTaskRevision ||
          task.specRevision !== request.specRevision ||
          authority.binding.planRevision !== request.planRevision ||
          task.state !== "in-progress"
        )
          return yield* deny("Query task, specification or plan changed");
        const sharedSource =
          request.sharedSource === undefined
            ? undefined
            : authority.role.memoryAccess !== "shared"
              ? yield* deny("Cross-project query requires shared memory access")
              : yield* qualifyProjectMemorySharedSource(
                  sql,
                  request.projectId,
                  request.sharedSource,
                );
        yield* ports.value.assertConfigured();
        const configuration = yield* ports.value.readConfiguration();
        if (configuration === undefined)
          return yield* deny("Query memory configuration is disabled");
        const owner = yield* operation.value.readCurrentInTransaction(principal);
        if (owner.workerId !== attribution.source.id)
          return yield* deny("Query source is not its original worker");
        const currentAuthority = yield* resolve(principal);
        const currentConfiguration = yield* ports.value.readConfiguration();
        if (
          currentAuthority === undefined ||
          currentAuthority.state.revision !== request.expectedRevision ||
          projectMemoryQueryTaskScope(currentAuthority) !==
            projectMemoryQueryTaskScope(authority) ||
          !same(currentConfiguration, configuration)
        )
          return yield* deny("Query configuration or approved task changed after qualification");
        yield* guard.value.assertSafe(request.query);
        if (
          sharedSource !== undefined &&
          !same(
            sharedSource,
            yield* qualifyProjectMemorySharedSource(sql, request.projectId, sharedSource.selection),
          )
        )
          return yield* deny("Shared source changed during query qualification");
        const qualified = {
          operation: owner,
          configurationSha256: projectMemoryHash(configuration),
          taskScopeSha256: projectMemoryQueryTaskScope(authority),
          ...(sharedSource === undefined ? {} : { sharedSource }),
        };
        return {
          ...qualified,
          intentFingerprint: fingerprint(request, principal, attribution, qualified),
        };
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Query qualification is unavailable"),
      ),
    );
    const qualify = Effect.fn("ProjectMemoryQuery.qualify")(
      function* (
        request: ProjectTeamMemoryQueryIntent,
        principal: ProjectTeamPrincipal,
        attribution: ProjectWorkAttribution,
        resolve: (
          principal: ProjectTeamPrincipal,
        ) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>,
      ) {
        yield* loan;
        const retained = yield* readProjectMemoryQueryOwner(
          sql,
          request.projectId,
          request.commandId,
        );
        if (retained === undefined)
          return yield* qualifyCurrent(request, principal, attribution, resolve);
        if (
          principal.actor.kind !== "agent" ||
          principal.managed === undefined ||
          attribution.actor.kind !== "agent" ||
          attribution.actor.id !== principal.actor.id ||
          attribution.source.kind !== "mcp" ||
          !same(retained.request, request) ||
          retained.actorId !== principal.actor.id ||
          retained.sourceId !== attribution.source.id ||
          retained.operation.bindingId !== principal.managed.bindingId ||
          retained.operation.generation !== principal.managed.generation ||
          retained.operation.providerInstanceId !== principal.managed.providerInstanceId ||
          retained.operation.threadId !== principal.managed.threadId
        )
          return yield* deny("Original semantic query identity changed");
        yield* auditProjectMemoryQueryAdmission(sql, retained);
        return {
          operation: retained.operation,
          configurationSha256: retained.configurationSha256,
          taskScopeSha256: retained.taskScopeSha256,
          intentFingerprint: retained.intentFingerprint,
          ...(retained.sharedSource === undefined ? {} : { sharedSource: retained.sharedSource }),
        };
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Query qualification is unavailable"),
      ),
    );
    const compileInTransaction = Effect.fn("ProjectMemoryQuery.compileInTransaction")(
      function* (
        supplied: ProjectTeamMemoryQueryIntent,
        principal: ProjectTeamPrincipal,
        attribution: ProjectWorkAttribution,
        resolve: (
          principal: ProjectTeamPrincipal,
        ) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>,
        duplicate: boolean,
      ) {
        yield* loan;
        const request = yield* decodeRequest(supplied);
        const expected = yield* Effect.serviceOption(ProjectMemoryQueryQualification);
        if (Option.isNone(expected)) return yield* deny("Original query qualification is missing");
        let owner = yield* readProjectMemoryQueryOwner(sql, request.projectId, request.commandId);
        if (duplicate) {
          if (
            owner === undefined ||
            owner.intentFingerprint !== expected.value.intentFingerprint ||
            !same(owner.request, request) ||
            principal.actor.kind !== "agent" ||
            owner.actorId !== principal.actor.id ||
            principal.managed === undefined ||
            owner.operation.bindingId !== principal.managed.bindingId ||
            owner.operation.generation !== principal.managed.generation ||
            owner.operation.providerInstanceId !== principal.managed.providerInstanceId ||
            owner.operation.threadId !== principal.managed.threadId ||
            attribution.source.kind !== owner.sourceKind ||
            attribution.source.id !== owner.sourceId
          )
            return yield* deny("Original query retry authority changed");
          yield* auditProjectMemoryQueryAdmission(sql, owner);
        } else if (owner === undefined) {
          const qualified = yield* qualifyCurrent(request, principal, attribution, resolve);
          if (!same(qualified, expected.value))
            return yield* deny("Query qualification changed before admission");
          const effect = yield* decodeEffect(
            admittedEffect(request, qualified, attribution.recordedAt),
          );
          owner = yield* decodeOwner({
            version: 2,
            kind: "query",
            ...qualified,
            request,
            actorId: principal.actor.id,
            sourceKind: "mcp",
            sourceId: attribution.source.id,
            admittedAt: attribution.recordedAt,
            admittedEffect: effect,
          });
          yield* sql`INSERT INTO project_team_memory_query(query_id,environment_id,project_id,task_id,binding_id,generation,
        operation_id,command_id,owner_json,status) VALUES(${effect.effectId},${owner.operation.environmentId},${request.projectId},
        ${request.taskId},${owner.operation.bindingId},${owner.operation.generation},${owner.operation.operationId},
        ${request.commandId},${canonicalProjectWorkPayload(owner)},'pending')`;
        } else if (
          !same(owner.request, request) ||
          owner.intentFingerprint !== expected.value.intentFingerprint ||
          owner.actorId !== principal.actor.id ||
          owner.sourceId !== attribution.source.id
        ) {
          return yield* deny("Original query admission changed in its owning transaction");
        } else {
          const qualified = yield* qualifyCurrent(request, principal, attribution, resolve);
          if (!same(qualified, expected.value))
            return yield* deny("Query qualification changed in its final transaction fence");
        }
        if (owner === undefined) return yield* deny("Original query owner missing");
        return yield* decodeCommand({
          type: "project-work.foundation.commit",
          commandId: request.commandId,
          projectId: request.projectId,
          expectedRevision: request.expectedRevision,
          attribution: { ...attribution, recordedAt: owner.admittedAt },
          records: [owner.admittedEffect],
          committedAt: owner.admittedAt,
        });
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Query admission is unavailable"),
      ),
    );
    return { qualify, compileInTransaction };
  },
  Effect.mapError((error) =>
    isServiceError(error) ? error : deny("Semantic query authority is unavailable"),
  ),
);

import type { ProjectMemoryCompanionForwardFence } from "./ProjectMemoryCompanionJournal.ts";

export interface ProjectMemoryQueryConsumerOptions {
  readonly environmentId: string;
  readonly maximumConcurrentCalls: number;
  readonly maximumConcurrentModelCalls: number;
  readonly readConfiguration: Effect.Effect<
    ProjectMemoryProcessingConfiguration | undefined,
    ProjectMemoryServiceError
  >;
  readonly assertAdmission: Effect.Effect<void, ProjectMemoryServiceError>;
  readonly readCredential: (reference: string) => Effect.Effect<string, ProjectMemoryServiceError>;
  readonly exchange: (
    request: ProjectMemoryModelExchange,
    id: string,
    assertCurrent: Effect.Effect<void, ProjectMemoryServiceError>,
  ) => Effect.Effect<ProjectMemoryModelResponse, ProjectMemoryServiceError>;
  readonly confirmModelTransportDrained: (
    id: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly releaseModelTransportObservation?: (reservationId: string) => Effect.Effect<void>;
  readonly companion?: (
    owner: ProjectMemoryQueryOwner,
    configuration: ProjectMemoryProcessingConfiguration,
    bytes: Uint8Array,
    assertForwardInTransaction: ProjectMemoryCompanionForwardFence,
  ) => ReturnType<MemoryBackendTransport>;
  readonly observeCompanionCleanup?: (effectId: string) => Effect.Effect<void>;
  readonly confirmSearchTransportDrained?: (
    id: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
}

/** Called after admission commits; constructors and context reads never forward. */
export const makeProjectMemoryQueryConsumer = Effect.fn("makeProjectMemoryQueryConsumer")(
  function* (options: ProjectMemoryQueryConsumerOptions) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectTeamAuthorization;
    const guard = yield* ProjectWorkContentGuard;
    const crypto = yield* Crypto.Crypto;
    const publishFinal = Effect.fn("ProjectMemoryQuery.publishFinal")(
      function* (
        owner: ProjectMemoryQueryOwner,
        draft: Effect.Effect<
          Omit<typeof CacheResult.Type, "reflection">,
          ProjectMemoryServiceError
        >,
        verify: Effect.Effect<void, ProjectMemoryServiceError>,
      ) {
        let expected: typeof CacheResult.Type | undefined;
        yield* repository.executeAtomic(
          Effect.gen(function* () {
            yield* verify;
            const finalDraft = yield* draft;
            const retained = yield* readProjectMemoryQueryOwnerById(
              sql,
              owner.admittedEffect.effectId,
            );
            if (!same(retained, owner)) return yield* deny("Query result original owner changed");
            yield* auditProjectMemoryQueryAdmission(sql, owner);
            const stages = yield* readStages(sql, owner.admittedEffect.effectId);
            if (stages.result !== null) {
              const result = yield* decodeCacheResult(stages.result);
              const { reflection: _reflection, ...prior } = result;
              if (!same(prior, finalDraft))
                return yield* deny("Query original final result changed");
              expected = result;
              yield* auditFinalResult(sql, owner, result);
              return [];
            }
            const state = yield* readCurrentState(sql, owner.operation.projectId);
            const effects = (state.foundationRecords ?? []).filter(
              (record) => record.recordId === owner.admittedEffect.effectId,
            );
            if (effects.length !== 1 || !same(effects[0], owner.admittedEffect))
              return yield* deny("Query original pending effect changed before completion");
            expected = yield* decodeCacheResult(
              canonicalProjectWorkPayload({
                ...finalDraft,
                reflection: {
                  at: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
                  expectedRevision: state.revision,
                },
              }),
            );
            const changed = yield* sql<{ id: string }>`UPDATE project_team_memory_query
          SET result_json=${canonicalProjectWorkPayload(expected)},status=${expected.outcome === "completed" ? "completed" : "failed"}
          WHERE query_id=${owner.admittedEffect.effectId} AND result_json IS NULL RETURNING query_id AS id`;
            if (changed.length !== 1)
              return yield* deny("Query final result CAS lost its original winner");
            return [yield* finalCommand(owner, expected)];
          }),
          Effect.gen(function* () {
            if (expected === undefined) return yield* deny("Query final result was not retained");
            const stages = yield* readStages(sql, owner.admittedEffect.effectId);
            if (stages.result === null || !same(yield* decodeCacheResult(stages.result), expected))
              return yield* deny("Query final result changed at commit");
            yield* auditFinalResult(sql, owner, expected);
            yield* verify;
          }),
        );
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Query final result remains uncommitted"),
      ),
    );
    const consumeQuery = Effect.fn("ProjectMemoryQuery.consume")(
      function* (principal: ProjectTeamPrincipal, queryId: string) {
        let claimed: ProjectMemoryQueryOwner | undefined;
        const work = Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
            return yield* deny("Query processing follows its original commit");
          const owner = yield* readProjectMemoryQueryOwnerById(sql, queryId);
          const stages = yield* readStages(sql, queryId);
          if (
            stages.status !== "pending" ||
            stages.embedding !== null ||
            stages.search !== null ||
            stages.result !== null
          )
            return yield* deny("Original query stages are retained without resend");
          const executing = yield* Effect.serviceOption(ProjectMemoryOperation);
          if (Option.isNone(executing)) return yield* deny("Query waits for its executing bridge");
          const configured = Effect.gen(function* () {
            const configuration = yield* options.readConfiguration;
            if (
              configuration === undefined ||
              projectMemoryHash(configuration) !== owner.configurationSha256
            )
              return yield* deny("Original query configuration changed");
            yield* options.assertAdmission;
            return configuration;
          });
          const fence = Effect.gen(function* () {
            yield* configured;
            yield* auditProjectMemoryQueryAdmission(sql, owner);
            const authority = yield* authorization.resolve(principal);
            if (
              authority === undefined ||
              authority.role.memoryAccess === "none" ||
              principal.actor.kind !== "agent" ||
              principal.actor.id !== owner.actorId ||
              principal.managed?.bindingId !== owner.operation.bindingId ||
              principal.managed.generation !== owner.operation.generation ||
              principal.managed.providerInstanceId !== owner.operation.providerInstanceId ||
              principal.managed.threadId !== owner.operation.threadId ||
              projectMemoryQueryTaskScope(authority) !== owner.taskScopeSha256 ||
              !same(yield* executing.value.readCurrentInTransaction(principal), owner.operation)
            )
              return yield* deny("Original query owner, scope or grants changed");
            if (owner.request.sharedSource !== undefined) {
              if (
                authority.role.memoryAccess !== "shared" ||
                owner.sharedSource === undefined ||
                !same(
                  owner.sharedSource,
                  yield* qualifyProjectMemorySharedSource(
                    sql,
                    owner.request.projectId,
                    owner.request.sharedSource,
                  ),
                )
              )
                return yield* deny("Original shared source grant changed");
            } else if (owner.sharedSource !== undefined)
              return yield* deny("Local query cannot have a shared source");
            yield* guard.assertSafe(owner.request.query);
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
            Effect.mapError((error) =>
              isServiceError(error) ? error : deny("Query fence denied"),
            ),
          );
          const check = () => sql.withTransaction(fence);
          const configuration = yield* configured;
          const intent = {
            version: 1,
            queryId,
            ownerSha256: projectMemoryHash(owner),
            querySha256: projectMemoryHash(owner.request.query),
            configuration,
            requestId: 1,
            maximumInputTokens: Math.min(
              configuration.embedding.maximumInputTokens,
              owner.operation.operationMaximumTokens - 1,
            ),
            maximumOutputTokens: 1,
            deadlineAtMs: Math.min(
              owner.operation.rootDeadlineAtMs,
              owner.operation.attemptDeadlineAtMs,
              owner.operation.operationDeadlineAtMs,
              owner.operation.leaseDeadlineAtMs,
            ),
          };
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* fence;
                const changed = yield* sql<{
                  id: string;
                }>`UPDATE project_team_memory_query SET status='embedding',embedding_json=${canonicalProjectWorkPayload(intent)}
        WHERE query_id=${queryId} AND status='pending' AND embedding_json IS NULL RETURNING query_id AS id`;
                if (changed.length !== 1) return yield* deny("Query embedding is already claimed");
                yield* fence;
              }),
            )
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  claimed = owner;
                }),
              ),
              Effect.uninterruptible,
            );
          const accounting = yield* makeProjectMemoryModelAccounting({
            environmentId: options.environmentId,
            maximumConcurrentCalls: options.maximumConcurrentCalls,
            maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
            assertCurrentInTransaction: () =>
              Effect.fail(deny("Query cannot authorize a source stage")),
            assertQueryCurrentInTransaction: (saved) =>
              same(saved, owner) ? fence : Effect.fail(deny("Query model owner changed")),
            assertTransportDrainedInTransaction: (id) => options.confirmModelTransportDrained(id),
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
            Effect.provideService(Crypto.Crypto, crypto),
          );
          const credential = yield* options.readCredential(configuration.embedding.credentialRef);
          yield* guard.registerKnownSecrets([credential]);
          yield* check();
          const held = yield* accounting.reserve(owner, {
            phase: "query-embed",
            requestId: 1,
            routeId: configuration.embedding.routeId,
            maxInputTokens: intent.maximumInputTokens,
            maxOutputTokens: intent.maximumOutputTokens,
            deadlineAtMs: intent.deadlineAtMs,
          });
          if (held.status !== "reserved")
            return yield* deny("Retained query reservation cannot be resent");
          yield* executing.value.assertForward;
          yield* check();
          const response = yield* options
            .exchange(
              {
                phase: "embed",
                endpoint: configuration.embedding.endpoint,
                credential,
                model: held.reservation.model,
                maximumInputTokens: intent.maximumInputTokens,
                maximumOutputTokens: intent.maximumOutputTokens,
                deadlineAtMs: intent.deadlineAtMs,
                input: [owner.request.query],
              },
              held.reservationId,
              check().pipe(
                Effect.mapError((error) =>
                  isServiceError(error) ? error : deny("Final query model fence denied"),
                ),
              ),
            )
            .pipe(Effect.result);
          const drained =
            (yield* options.confirmModelTransportDrained(held.reservationId).pipe(Effect.result))
              ._tag === "Success";
          const decoded =
            response._tag === "Success"
              ? yield* decodeVectors(response.success.value).pipe(Effect.result)
              : undefined;
          const reported = response._tag === "Success" && decoded?._tag === "Success";
          const settlement = yield* accounting.settle({
            ...held.reservation,
            reservationId: held.reservationId,
            outcome: reported ? "reported" : "unknown",
            transportDrained: drained,
            chargedInputTokens: reported
              ? response.success.inputTokens
              : held.reservation.maxInputTokens,
            chargedOutputTokens: reported
              ? response.success.outputTokens
              : held.reservation.maxOutputTokens,
            ...(reported
              ? {
                  reportedModel: response.success.reportedModel,
                  reportedInputTokens: response.success.inputTokens,
                  reportedOutputTokens: response.success.outputTokens,
                }
              : {}),
          });
          // Settlement commits audited drain proof before the local observation is forgotten.
          if (drained)
            yield* options.releaseModelTransportObservation?.(held.reservationId) ?? Effect.void;
          const vector = reported ? decoded.success[0] : undefined;
          const embedded = {
            version: 1,
            queryId,
            reservationId: held.reservationId,
            reservationSha256: projectMemoryHash(held.reservation),
            accountingReceiptId: settlement.accountingReceiptId,
            outcome: reported ? "reported" : "unknown",
            ...(vector === undefined ? {} : { vector }),
          };
          yield* sql`UPDATE project_team_memory_query SET embedding_result_json=${canonicalProjectWorkPayload(embedded)},status=${reported && drained ? "searching" : "embedding"}
      WHERE query_id=${queryId} AND embedding_result_json IS NULL AND status='embedding'`;
          if (!reported || !drained || vector === undefined)
            return yield* deny("Query embedding is uncertain; no resend");
          yield* check();
          if ((yield* Clock.currentTimeMillis) >= intent.deadlineAtMs)
            return yield* deny("Original query deadline expired");
          const companion = options.companion;
          const confirmSearchDrain = options.confirmSearchTransportDrained;
          if (companion === undefined || confirmSearchDrain === undefined)
            return yield* deny("Query search waits for captured resource and drain authority");
          const search = {
            version: 1,
            queryId,
            requestId: queryId + ":search",
            ownerSha256: projectMemoryHash(owner),
            configurationSha256: owner.configurationSha256,
            vectorSha256: projectMemoryHash(vector),
            deadlineAtMs: intent.deadlineAtMs,
            limit: 12,
          };
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* fence;
              const changed = yield* sql<{
                id: string;
              }>`UPDATE project_team_memory_query SET search_json=${canonicalProjectWorkPayload(search)}
        WHERE query_id=${queryId} AND status='searching' AND search_json IS NULL RETURNING query_id AS id`;
              if (changed.length !== 1) return yield* deny("Query search already claimed");
              yield* fence;
            }),
          );
          const backend = makeMem0Backend((bytes) =>
            executing.value.assertForward.pipe(
              Effect.andThen(check()),
              Effect.flatMap(() => companion(owner, configuration, bytes, fence)),
              Effect.mapError(
                () =>
                  new MemoryBackendError({
                    code: "fenced",
                    message: "Query companion fence denied",
                  }),
              ),
            ),
          );
          const found = yield* backend
            .search(search.requestId, {
              environmentId: owner.operation.environmentId,
              projectId: owner.sharedSource?.ownerProjectId ?? owner.operation.projectId,
              ...(owner.sharedSource === undefined
                ? {}
                : {
                    source: {
                      sourceRecordId: owner.sharedSource.selection.sourceRecordId,
                      sourceRevision: owner.sharedSource.selection.sourceRevision,
                      sourceGeneration: owner.sharedSource.selection.sourceGeneration,
                    },
                  }),
              vector,
              limit: 12,
            })
            .pipe(Effect.result);
          const searchDrained =
            (yield* confirmSearchDrain(search.requestId).pipe(Effect.result))._tag === "Success";
          const searched = {
            version: 1,
            queryId,
            requestId: search.requestId,
            intentSha256: projectMemoryHash(search),
            outcome: found._tag === "Success" ? "completed" : "unknown",
            transportDrained: searchDrained,
            candidates: found._tag === "Success" ? found.success.candidates : [],
          };
          yield* sql`UPDATE project_team_memory_query SET search_result_json=${canonicalProjectWorkPayload(searched)}
      WHERE query_id=${queryId} AND search_result_json IS NULL`;
          if (found._tag !== "Success" || !searchDrained)
            return yield* deny("Query search is uncertain; no resend");
          const hits = found.success.candidates.filter(
            (hit) =>
              hit.environmentId === owner.operation.environmentId &&
              hit.projectId === (owner.sharedSource?.ownerProjectId ?? owner.operation.projectId),
          );
          const hitIds = [...new Set(hits.map((hit) => hit.observationId))];
          yield* publishFinal(
            owner,
            Effect.gen(function* () {
              yield* fence;
              const hydrated = yield* readProjectMemoryObservations(
                sql,
                owner.request.projectId,
                owner.request.query,
                hitIds,
                owner.sharedSource,
              );
              if (hydrated.status !== "available")
                return yield* deny("Current query hit authority unavailable");
              if (
                hydrated.records.some(
                  (record) =>
                    !hits.some(
                      (hit) =>
                        hit.observationId === record.recordId &&
                        hit.sourceRecordId === record.sourceId &&
                        hit.sourceRevision === record.sourceRevision &&
                        hit.sourceGeneration === record.sourceGeneration &&
                        hit.extractionId === record.extractionId,
                    ),
                )
              )
                return yield* deny("Backend selectors disagree with current source tuples");
              yield* guard.assertSafe(hydrated.records);
              return {
                kind: "memory-query-result" as const,
                version: 1 as const,
                queryId,
                outcome: "completed" as const,
                embeddingSha256: projectMemoryHash(embedded),
                searchSha256: projectMemoryHash(searched),
                snapshotSha256: hydrated.provenance.snapshotSha256,
                // Cache hydration must audit the same candidates and rejections.
                hitIds,
              };
            }).pipe(
              Effect.mapError((error) =>
                isServiceError(error) ? error : deny("Current query hydration is unavailable"),
              ),
            ),
            fence,
          );
        });
        return yield* work.pipe(
          Effect.onExit((exit) => {
            if (claimed === undefined || Exit.isSuccess(exit)) return Effect.void;
            const owner = claimed;
            const unreserved = Effect.gen(function* () {
              yield* auditProjectMemoryQueryAdmission(sql, owner);
              const stages = yield* readStages(sql, queryId);
              const reservations = yield* sql`SELECT 1 FROM project_team_model_request
                WHERE environment_id=${owner.operation.environmentId} AND project_id=${owner.operation.projectId}
                AND operation_id=${owner.operation.operationId} AND request_lane='memory'
                AND json_extract(reservation_json,'$.effectId')=${queryId} LIMIT 1`;
              return (
                reservations.length === 0 &&
                stages.embedding !== null &&
                stages.embedded === null &&
                stages.search === null &&
                stages.searched === null &&
                stages.drained === null &&
                ((stages.status === "embedding" && stages.result === null) ||
                  (stages.status === "failed" && stages.result !== null))
              );
            }).pipe(
              Effect.mapError((error) =>
                isServiceError(error) ? error : deny("Query failure provenance denied"),
              ),
            );
            const finish = Effect.gen(function* () {
              if (Cause.hasInterrupts(exit.cause)) return;
              const eligible = yield* sql.withTransaction(
                Effect.gen(function* () {
                  const stages = yield* readStages(sql, queryId);
                  return (
                    stages.status === "embedding" && stages.result === null && (yield* unreserved)
                  );
                }),
              );
              if (!eligible) return;
              yield* publishFinal(
                owner,
                Effect.succeed({
                  kind: "memory-query-result",
                  version: 1,
                  queryId,
                  outcome: "failed",
                  hitIds: [],
                  reason: "Query stopped before its first reservation",
                }),
                unreserved.pipe(
                  Effect.flatMap((eligible) =>
                    eligible
                      ? Effect.void
                      : Effect.fail(deny("Query failure cannot settle a forwarded stage")),
                  ),
                ),
              );
            });
            return finish.pipe(
              Effect.onExit(() =>
                sql
                  .withTransaction(sql`UPDATE project_team_memory_query SET status='uncertain'
                WHERE query_id=${queryId} AND status IN ('embedding','searching') AND result_json IS NULL`)
                  .pipe(Effect.mapError(() => deny("Query owner relinquishment failed"))),
              ),
            );
          }),
        );
      },
      Effect.mapError((error) =>
        isServiceError(error)
          ? error
          : deny("Query processing remains retained for reconciliation"),
      ),
      (effect, _principal, queryId) =>
        effect.pipe(
          Effect.catch((error) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const owner = yield* readProjectMemoryQueryOwnerById(sql, queryId);
                  yield* auditProjectMemoryQueryAdmission(sql, owner);
                  const stages = yield* readStages(sql, queryId);
                  const reservations = yield* sql`SELECT 1 FROM project_team_model_request
        WHERE environment_id=${owner.operation.environmentId} AND project_id=${owner.operation.projectId}
        AND operation_id=${owner.operation.operationId} AND request_lane='memory'
        AND json_extract(reservation_json,'$.effectId')=${queryId} LIMIT 1`;
                  if (
                    reservations.length === 0 &&
                    stages.status === "pending" &&
                    stages.embedding === null &&
                    stages.search === null &&
                    stages.result === null
                  )
                    return owner;
                  return undefined;
                }),
              )
              .pipe(
                Effect.mapError((failure) =>
                  isServiceError(failure) ? failure : deny("Query failure remains retained"),
                ),
                Effect.flatMap((owner) =>
                  owner === undefined
                    ? Effect.void
                    : publishFinal(
                        owner,
                        Effect.succeed({
                          kind: "memory-query-result",
                          version: 1,
                          queryId,
                          outcome: "failed",
                          hitIds: [],
                          reason: "Query stopped before its first reservation",
                        }),
                        Effect.gen(function* () {
                          yield* auditProjectMemoryQueryAdmission(sql, owner);
                          const stages = yield* readStages(sql, queryId);
                          const reservations = yield* sql`SELECT 1 FROM project_team_model_request
                      WHERE environment_id=${owner.operation.environmentId} AND project_id=${owner.operation.projectId}
                      AND operation_id=${owner.operation.operationId} AND request_lane='memory'
                      AND json_extract(reservation_json,'$.effectId')=${queryId} LIMIT 1`;
                          if (
                            reservations.length !== 0 ||
                            stages.status !== "pending" ||
                            stages.embedding !== null ||
                            stages.search !== null
                          )
                            return yield* deny("Query failure cannot settle a forwarded stage");
                        }).pipe(
                          Effect.mapError((failure) =>
                            isServiceError(failure)
                              ? failure
                              : deny("Query failure provenance denied"),
                          ),
                        ),
                      ),
                ),
                Effect.andThen(Effect.fail(error)),
              ),
          ),
        ),
    );
    const readQueryCache: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectMemoryRetrieval | undefined, ProjectMemoryServiceError> = Effect.fn(
      "ProjectMemoryQuery.readCache",
    )(
      function* (principal: ProjectTeamPrincipal) {
        const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (
          Option.isNone(currentSql) ||
          currentSql.value !== sql ||
          Option.isNone(yield* Effect.serviceOption(sql.transactionService))
        )
          return yield* deny("Query cache must use the captured context transaction");
        const authority = yield* authorization.resolve(principal);
        if (authority === undefined || authority.role.memoryAccess === "none") return undefined;
        const configuration = yield* options.readConfiguration;
        if (configuration === undefined) return undefined;
        const rows = yield* sql<{
          id: string;
        }>`SELECT q.query_id AS id FROM project_team_memory_query q
      JOIN project_work_events e ON e.project_id=q.project_id AND e.command_id=q.command_id
      WHERE q.environment_id=${options.environmentId} AND q.project_id=${authority.binding.projectId} AND q.task_id=${authority.binding.taskId}
      AND q.binding_id=${authority.binding.recordId} AND q.generation=${authority.binding.generation} AND q.status='completed'
      ORDER BY e.sequence DESC LIMIT 33`;
        if (rows.length > 32) return yield* deny("Completed query candidates exceed their bound");
        for (const row of rows) {
          const owner = yield* readProjectMemoryQueryOwnerById(sql, row.id);
          if (
            owner.taskScopeSha256 !== projectMemoryQueryTaskScope(authority) ||
            owner.configurationSha256 !== projectMemoryHash(configuration)
          )
            continue;
          if (
            owner.request.sharedSource !== undefined &&
            (authority.role.memoryAccess !== "shared" ||
              owner.sharedSource === undefined ||
              !same(
                owner.sharedSource,
                yield* qualifyProjectMemorySharedSource(
                  sql,
                  owner.request.projectId,
                  owner.request.sharedSource,
                ),
              ))
          )
            continue;
          yield* auditProjectMemoryQueryAdmission(sql, owner);
          yield* guard.assertSafe(owner.request.query);
          const { auditProjectMemoryOperationLedger } = yield* Effect.promise(
            () => import("./ProjectMemoryModelAccounting.ts"),
          );
          if (!(yield* auditProjectMemoryOperationLedger(sql, owner.operation)).settled) continue;
          const stages = yield* readStages(sql, row.id);
          if (stages.result === null) continue;
          const result = yield* decodeCacheResult(stages.result);
          const hydrated = yield* readProjectMemoryObservations(
            sql,
            owner.request.projectId,
            owner.request.query,
            result.hitIds,
            owner.sharedSource,
          );
          if (
            hydrated.status !== "available" ||
            hydrated.provenance.snapshotSha256 !== result.snapshotSha256
          )
            continue;
          yield* guard.assertSafe(owner.request.query);
          yield* guard.assertSafe(hydrated.records);
          const finalAuthority = yield* authorization.resolve(principal);
          const finalConfiguration = yield* options.readConfiguration;
          if (
            finalAuthority === undefined ||
            finalAuthority.role.memoryAccess === "none" ||
            projectMemoryQueryTaskScope(finalAuthority) !== owner.taskScopeSha256 ||
            projectMemoryHash(finalConfiguration) !== owner.configurationSha256
          )
            continue;
          if (
            owner.sharedSource !== undefined &&
            (finalAuthority.role.memoryAccess !== "shared" ||
              !same(
                owner.sharedSource,
                yield* qualifyProjectMemorySharedSource(
                  sql,
                  owner.request.projectId,
                  owner.sharedSource.selection,
                ),
              ))
          )
            continue;
          return {
            ...hydrated,
            provenance: {
              ...hydrated.provenance,
              queryId: row.id,
              configurationSha256: owner.configurationSha256,
              admissionEventId: `${owner.request.commandId}:project-work:0`,
            },
          };
        }
        return undefined;
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Completed query cache is unavailable"),
      ),
    );
    const reconcileQuery = Effect.fn("ProjectMemoryQuery.reconcileTransportDrain")(
      function* (queryId: string) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Query drain cleanup owns its original SQL transaction");
        const owner = yield* readProjectMemoryQueryOwnerById(sql, queryId);
        yield* auditProjectMemoryQueryAdmission(sql, owner);
        const original = yield* readStages(sql, queryId);
        let ledger = yield* auditProjectMemoryOperationLedger(sql, owner.operation);
        if (original.result !== null) return;
        if (original.status !== "uncertain")
          return yield* deny("Query owner has not relinquished unfinished work");
        const models = [];
        for (const row of ledger.rows) {
          const reservation = yield* decodeReservationJson(row.reservation_json);
          if (reservation.effectId === queryId) models.push({ row, reservation });
        }
        if (models.length > 1) return yield* deny("Query drain reservation is ambiguous");
        const model = models[0];
        const accounting = yield* makeProjectMemoryModelAccounting({
          environmentId: options.environmentId,
          maximumConcurrentCalls: options.maximumConcurrentCalls,
          maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
          assertCurrentInTransaction: () =>
            Effect.fail(deny("Drain cleanup cannot start a source stage")),
          assertQueryCurrentInTransaction: () =>
            Effect.fail(deny("Drain cleanup cannot start a query stage")),
          assertTransportDrainedInTransaction: (id) => options.confirmModelTransportDrained(id),
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        if (model !== undefined) {
          if (model.reservation.version !== 2)
            return yield* deny("Query drain requires its original query lane");
          if (model.row.status === "held") {
            yield* accounting.settle({
              ...model.reservation,
              reservationId: model.row.reservation_id,
              outcome: "unknown",
              transportDrained: false,
              chargedInputTokens: model.reservation.maxInputTokens,
              chargedOutputTokens: model.reservation.maxOutputTokens,
            });
          }
          const alreadyDrained =
            model.row.settlement_json !== null &&
            (yield* decodeSettlementJson(model.row.settlement_json)).transportDrained;
          // A prior durable confirmation survives local observation release and consumer restart.
          const receipt = alreadyDrained
            ? { accountingReceiptId: model.row.accounting_receipt_id }
            : yield* accounting.confirmTransportDrained(queryId, model.row.reservation_id);
          if (receipt.accountingReceiptId === null)
            return yield* deny("Query drain accounting receipt is missing");
          if (original.embedded === null) {
            // An interrupted exchange cannot be upgraded into a reported vector.
            const embedded = {
              version: 1,
              queryId,
              reservationId: model.row.reservation_id,
              reservationSha256: projectMemoryHash(model.reservation),
              accountingReceiptId: receipt.accountingReceiptId,
              outcome: "unknown",
            };
            yield* sql`UPDATE project_team_memory_query SET embedding_result_json=${canonicalProjectWorkPayload(embedded)},status='uncertain'
              WHERE query_id=${queryId} AND embedding_result_json IS NULL`;
          }
        }
        let stages = yield* readStages(sql, queryId);
        if (stages.search !== null) {
          const search = yield* decodeSearchIntent(stages.search);
          if (stages.drained === null) {
            const confirm = options.confirmSearchTransportDrained;
            if (confirm === undefined)
              return yield* deny("Query search drain observation unavailable");
            yield* confirm(search.requestId);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* auditProjectMemoryQueryAdmission(sql, owner);
                const current = yield* readStages(sql, queryId);
                const searched =
                  current.searched === null
                    ? {
                        version: 1,
                        queryId,
                        requestId: search.requestId,
                        intentSha256: projectMemoryHash(search),
                        outcome: "unknown",
                        transportDrained: false,
                        candidates: [],
                      }
                    : yield* decodeSearchResult(current.searched);
                if (current.searched === null)
                  yield* sql`UPDATE project_team_memory_query SET search_result_json=${canonicalProjectWorkPayload(searched)},status='uncertain'
                  WHERE query_id=${queryId} AND search_result_json IS NULL`;
                const drain = {
                  version: 1,
                  queryId,
                  requestId: search.requestId,
                  intentSha256: projectMemoryHash(search),
                  resultSha256: projectMemoryHash(searched),
                  transportDrained: true,
                };
                yield* sql`UPDATE project_team_memory_query SET search_drain_json=${canonicalProjectWorkPayload(drain)}
                WHERE query_id=${queryId} AND search_drain_json IS NULL`;
              }),
            );
          }
        }
        stages = yield* readStages(sql, queryId);
        const embedded =
          stages.embedded === null ? undefined : yield* decodeEmbeddingResult(stages.embedded);
        const searched =
          stages.searched === null ? undefined : yield* decodeSearchResult(stages.searched);
        const drain =
          stages.drained === null ? undefined : yield* decodeSearchDrain(stages.drained);
        const verify = Effect.gen(function* () {
          yield* auditProjectMemoryQueryAdmission(sql, owner);
          ledger = yield* auditProjectMemoryOperationLedger(sql, owner.operation);
          for (const entry of ledger.rows) {
            const reservation = yield* decodeReservationJson(entry.reservation_json);
            if (
              reservation.effectId === queryId &&
              (entry.status === "held" ||
                entry.capacity_state !== "released" ||
                entry.settlement_json === null ||
                !(yield* decodeSettlementJson(entry.settlement_json)).transportDrained)
            )
              return yield* deny("Query model drain remains unconfirmed");
          }
          const current = yield* readStages(sql, queryId);
          if (current.search !== null && current.drained === null)
            return yield* deny("Query search drain remains unconfirmed");
        }).pipe(
          Effect.mapError((error) =>
            isServiceError(error) ? error : deny("Query drain provenance denied"),
          ),
        );
        yield* publishFinal(
          owner,
          Effect.succeed({
            kind: "memory-query-result",
            version: 1,
            queryId,
            outcome: "failed",
            hitIds: [],
            reason: "Original query stopped; authenticated transports drained without resend",
            ...(embedded === undefined ? {} : { embeddingSha256: projectMemoryHash(embedded) }),
            ...(searched === undefined ? {} : { searchSha256: projectMemoryHash(searched) }),
            ...(drain === undefined ? {} : { searchDrainSha256: projectMemoryHash(drain) }),
          }),
          verify,
        );
        if (model !== undefined)
          yield* (
            options.releaseModelTransportObservation?.(model.row.reservation_id) ?? Effect.void
          );
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Query drain remains retained"),
      ),
    );
    return {
      consumeQuery: (principal: ProjectTeamPrincipal, queryId: string) =>
        consumeQuery(principal, queryId).pipe(
          Effect.onExit(() =>
            sql<{
              status: string;
            }>`SELECT status FROM project_team_memory_query WHERE query_id=${queryId}`.pipe(
              Effect.flatMap((rows) =>
                rows[0]?.status === "uncertain" ||
                rows[0]?.status === "completed" ||
                rows[0]?.status === "failed"
                  ? (options.observeCompanionCleanup?.(queryId) ?? Effect.void)
                  : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        ),
      readQueryCache,
      reconcileQuery,
    };
  },
);
