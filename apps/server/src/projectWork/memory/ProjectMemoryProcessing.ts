import {
  projectMemoryExtractionRoute,
  withinProjectMemoryExtractionLimits,
} from "./ProjectMemoryModelRoutes.ts";
import {
  canonicalProjectWorkPayload,
  EventId,
  ProjectTeamRecord,
  ProjectTeamRunBinding,
  ProjectTeamMemorySourcesRead,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectWorkDecisionId,
  ProjectWorkEvidence,
  ProjectWorkWriteResult,
  ProjectTeamMemoryProcessIntent,
  ProjectTeamMemoryRetractIntent,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkAttribution,
  type ProjectWorkReadIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ProjectTeamAuthorization,
  type ProjectTeamAuthority,
  type ProjectTeamPrincipal,
  type ProjectTeamAuthorizationError,
} from "../ProjectTeamAuthorization.ts";
import { ProjectWorkRepository, readCurrentState } from "../ProjectWorkRepository.ts";
import { applyProjectWorkEvents, emptyProjectWorkReducerState } from "../ProjectWorkDecider.ts";
import {
  ProjectMemoryOperation,
  ProjectMemoryOperationIdentity,
  ProjectMemoryJobOwner,
  ProjectMemoryReservation,
  makeProjectMemoryModelAccounting,
  auditProjectMemoryAdmission,
} from "./ProjectMemoryModelAccounting.ts";
import {
  ProjectMemoryPorts,
  type ProjectMemoryProcessingConfiguration,
  type ProjectMemoryModelExchange,
  type ProjectMemoryModelResponse,
} from "./ProjectMemoryPorts.ts";
import * as NodeCrypto from "node:crypto";
import {
  ProjectMemoryJobInput,
  ProjectMemoryServiceError,
  projectMemoryHash,
  makeProjectMemoryService,
  makeProjectMemoryManifestStore,
} from "./ProjectMemoryService.ts";
import { ProjectWorkContentGuard } from "../ProjectWorkContentGuard.ts";
import { makeProjectMemoryIndexReactor } from "./ProjectMemoryIndexReactor.ts";
import { makeProjectMemoryOutcome } from "./ProjectMemoryOutcome.ts";
import { makeMem0Backend } from "./Mem0Backend.ts";
import { MemoryBackendError, type MemoryBackendTransport } from "./MemoryBackend.ts";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import {
  makeProjectMemoryQueryConsumer,
  readProjectMemoryQueryOwnerById,
  auditProjectMemoryQueryAdmission,
  type ProjectMemoryQueryConsumerOptions,
} from "./ProjectMemoryQuery.ts";

import { PiManagedProcessAllocationSchema } from "../../provider/pi/PiManagedProcess.ts";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../../provider/pi/PiWorkerProtocol.ts";

const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Recorded = Schema.Struct({
  type: Schema.Literal("project-work.foundation.recorded"),
  eventId: EventId,
  projectId: Id,
  revision: Safe,
  occurredAt: Schema.String,
  record: ProjectTeamRecord,
});
const Retained = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comment"), record: ProjectWorkComment }),
  Schema.Struct({ kind: Schema.Literal("evidence"), record: ProjectWorkEvidence }),
  Schema.Struct({ kind: Schema.Literal("decision"), record: ProjectWorkDecision }),
]);
const decodeJob = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemoryJobInput), strict);
const decodeRetained = Schema.decodeUnknownEffect(Schema.fromJsonString(Retained), strict);
const decodeDecision = Schema.decodeUnknownEffect(ProjectWorkDecision, strict);
const DecisionEventFields = {
  eventId: EventId,
  projectId: Id,
  revision: Safe,
  occurredAt: Schema.String,
  attribution: ProjectWorkAttribution,
};
const decodeDecisionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        ...DecisionEventFields,
        type: Schema.Literal("project-work.decision.proposed"),
        decision: ProjectWorkDecision,
        proposedAt: Schema.String,
      }),
      Schema.Struct({
        ...DecisionEventFields,
        type: Schema.Literal("project-work.decision.accepted"),
        decisionId: ProjectWorkDecisionId,
        acceptedAt: Schema.String,
      }),
      Schema.Struct({
        ...DecisionEventFields,
        type: Schema.Literal("project-work.decision.rejected"),
        decisionId: ProjectWorkDecisionId,
        reason: Schema.String,
        rejectedAt: Schema.String,
      }),
      Schema.Struct({
        ...DecisionEventFields,
        type: Schema.Literal("project-work.decision.superseded"),
        decisionId: ProjectWorkDecisionId,
        replacement: ProjectWorkDecision,
        supersededAt: Schema.String,
      }),
    ]),
  ),
  strict,
);
const decodeRecorded = Schema.decodeUnknownEffect(Schema.fromJsonString(Recorded), strict);
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRecord), strict);
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const decodeEventIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(EventId)),
  strict,
);
const decodePage = Schema.decodeUnknownEffect(ProjectTeamMemorySourcesRead, strict);
const decodeRequest = Schema.decodeUnknownEffect(ProjectTeamMemoryProcessIntent, strict);
const decodeRetraction = Schema.decodeUnknownEffect(ProjectTeamMemoryRetractIntent, strict);
const decodeOwner = Schema.decodeUnknownEffect(ProjectMemoryJobOwner, strict);
const decodeOwnerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryJobOwner),
  strict,
);
const decodeReservationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryReservation),
  strict,
);
const decodeCommand = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand, strict);
const same = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isServiceError = Schema.is(ProjectMemoryServiceError);

/** Selector discovery shares the gateway's transaction; it transfers no source body. */
export const makeProjectMemoryProcessing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const caller = Effect.gen(function* () {
    const client = yield* Effect.serviceOption(SqlClient.SqlClient);
    const supplied = yield* Effect.serviceOption(ProjectWorkRepository);
    if (
      Option.isNone(client) ||
      client.value !== sql ||
      Option.isNone(supplied) ||
      supplied.value !== repository ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* deny("Memory processing requires its captured SQL, repository and transaction");
  });
  const readSourcesInTransaction = Effect.fn("ProjectMemoryProcessing.readSourcesInTransaction")(
    function* (
      input: ProjectWorkReadIntent,
      authority: ProjectTeamAuthority,
      exactEffectId?: string,
      includeCompletedCleanup = false,
    ) {
      yield* caller;
      if (
        input.taskId !== authority.binding.taskId ||
        input.projectId !== authority.binding.projectId ||
        authority.role.memoryAccess === "none"
      )
        return yield* deny("Memory source task is unavailable");
      const state = yield* readCurrentState(sql, input.projectId);
      const limit = Math.min(32, input.limit ?? 32);
      const metadata = yield* sql<{
        effectId: string;
        bytes: number;
      }>`SELECT effect_id AS effectId,
        length(CAST(input_json AS BLOB)) + length(CAST(effect_id AS BLOB)) +
        length(CAST(environment_id AS BLOB)) + length(CAST(project_id AS BLOB)) +
        length(CAST(status AS BLOB)) + length(CAST(claim_generation AS BLOB)) AS bytes
        FROM project_team_memory_job WHERE environment_id=${authority.binding.environmentId}
        AND project_id=${input.projectId}
        AND ${exactEffectId === undefined ? sql`effect_id>${input.cursor ?? ""}` : sql`effect_id=${exactEffectId}`}
        ORDER BY effect_id LIMIT ${limit + 1}`;
      let pageBytes = 0;
      let degraded = false;
      const permitted = new Set<string>();
      for (const row of metadata) {
        if (
          !Number.isSafeInteger(row.bytes) ||
          row.bytes > 263168 ||
          pageBytes + row.bytes > 4194304
        ) {
          degraded = true;
          continue;
        }
        pageBytes += row.bytes;
        permitted.add(row.effectId);
      }
      const jobs = yield* sql<{
        effectId: string;
        status: string;
        claimGeneration: number;
        payload: string | null;
      }>`SELECT effect_id AS effectId,status,claim_generation AS claimGeneration,
        CASE WHEN effect_id IN ${sql.in(Array.from(permitted))} AND
          length(CAST(input_json AS BLOB))<=262144 THEN input_json END AS payload
        FROM project_team_memory_job WHERE environment_id=${authority.binding.environmentId}
        AND project_id=${input.projectId}
        AND ${exactEffectId === undefined ? sql`effect_id>${input.cursor ?? ""}` : sql`effect_id=${exactEffectId}`}
        ORDER BY effect_id LIMIT ${limit + 1}`;
      if (
        jobs.length !== metadata.length ||
        jobs.some((row, index) => row.effectId !== metadata[index]?.effectId)
      )
        return yield* deny("Memory source page changed during its captured read");
      let auditBytes = pageBytes;
      const auditRecord = Effect.fn("ProjectMemoryProcessing.auditRecord")(function* (
        record: ProjectTeamRecord,
      ) {
        const table = "project_team_" + record.kind.replaceAll("-", "_");
        const sizes = yield* sql<{ bytes: number }>`SELECT
          length(CAST(payload_json AS BLOB)) + length(CAST(record_id AS BLOB)) +
          length(CAST(project_id AS BLOB)) + length(CAST(status AS BLOB)) +
          length(CAST(revision AS BLOB)) + length(CAST(generation AS BLOB)) +
          length(CAST(updated_at AS BLOB)) AS bytes FROM ${sql(table)}
          WHERE record_id=${record.recordId} AND project_id=${input.projectId} LIMIT 2`;
        const size = sizes[0];
        if (
          sizes.length !== 1 ||
          size === undefined ||
          size.bytes > 263168 ||
          !Number.isSafeInteger(size.bytes) ||
          (auditBytes += size.bytes) > 4194304
        )
          return yield* deny("Memory source record exceeds its retained byte bound");
        const physical = yield* sql<{
          status: string;
          revision: number;
          generation: number;
          updatedAt: string;
          payload: string | null;
        }>`SELECT status,revision,generation,updated_at AS updatedAt,
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
          FROM ${sql(table)} WHERE record_id=${record.recordId} AND project_id=${input.projectId} LIMIT 2`;
        const row = physical[0];
        if (
          physical.length !== 1 ||
          row === undefined ||
          row.payload === null ||
          row.status !== record.status ||
          row.revision !== record.revision ||
          row.generation !== record.generation ||
          row.updatedAt !== record.updatedAt ||
          !same(yield* decodeRecord(row.payload), record)
        )
          return yield* deny("Memory source physical record disagrees with current state");
        const events = yield* sql<{
          eventId: string;
          commandId: string;
          occurredAt: string;
          payload: string | null;
        }>`SELECT event_id AS eventId,command_id AS commandId,occurred_at AS occurredAt,
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
          FROM project_work_events WHERE project_id=${input.projectId}
          AND event_type='project-work.foundation.recorded'
          AND json_extract(payload_json,'$.record.recordId')=${record.recordId}
          ORDER BY sequence DESC LIMIT 1`;
        const retainedEvent = events[0];
        if (
          retainedEvent === undefined ||
          retainedEvent.payload === null ||
          (auditBytes += Buffer.byteLength(retainedEvent.payload)) > 4194304
        )
          return yield* deny("Memory source event is unavailable");
        const event = yield* decodeRecorded(retainedEvent.payload);
        if (
          event.eventId !== retainedEvent.eventId ||
          event.projectId !== input.projectId ||
          event.occurredAt !== retainedEvent.occurredAt ||
          !same(event.record, record)
        )
          return yield* deny("Memory source event disagrees with current record");
        const receipts = yield* sql<{ result: string | null; eventIds: string | null }>`SELECT
          CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result,
          CASE WHEN length(CAST(event_ids_json AS BLOB))<=262144 THEN event_ids_json END AS eventIds
          FROM project_work_command_receipts WHERE project_id=${input.projectId}
          AND command_id=${retainedEvent.commandId} LIMIT 2`;
        const receipt = receipts[0];
        if (
          receipts.length !== 1 ||
          receipt === undefined ||
          receipt.result === null ||
          receipt.eventIds === null ||
          (auditBytes += Buffer.byteLength(receipt.result) + Buffer.byteLength(receipt.eventIds)) >
            4194304
        )
          return yield* deny("Memory source command receipt is unavailable");
        const result = yield* decodeResult(receipt.result);
        const ids = yield* decodeEventIds(receipt.eventIds);
        if (
          result.projectId !== input.projectId ||
          result.receipt.projectId !== input.projectId ||
          result.receipt.commandId !== retainedEvent.commandId ||
          result.receipt.status !== "accepted" ||
          ids.length !== result.receipt.eventCount ||
          new Set(ids).size !== ids.length ||
          !same(ids, result.delta.eventIds) ||
          ids.filter((id) => id === event.eventId).length !== 1
        )
          return yield* deny("Memory source command receipt membership is corrupt");
      });
      const items: Array<ProjectTeamMemorySourcesRead["items"][number]> = [];
      // A human tombstone is cleanup authority only through its exact accepted
      // request. Retain the original hash even when the cached body was redacted.
      const auditRetraction = Effect.fn("ProjectMemoryProcessing.auditRetraction")(function* (
        job: typeof ProjectMemoryJobInput.Type,
      ) {
        const tombstones = yield* sql<{
          sequence: number;
          commandId: string;
          payload: string | null;
        }>`SELECT
          sequence,command_id AS commandId,
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
          FROM project_work_events WHERE project_id=${input.projectId}
          AND event_type='project-work.foundation.recorded'
          AND json_extract(payload_json,'$.record.recordId')=${job.source.recordId}
          AND json_extract(payload_json,'$.record.revision')=${job.source.revision}
          ORDER BY sequence LIMIT 2`;
        const tombstone = tombstones[0];
        if (tombstones.length !== 1 || tombstone === undefined || tombstone.payload === null)
          return yield* deny("Human memory retraction event is unavailable");
        const recorded = yield* decodeRecorded(tombstone.payload);
        const priorRows = yield* sql<{ payload: string | null }>`SELECT
          CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
          FROM project_work_events WHERE project_id=${input.projectId}
          AND event_type='project-work.foundation.recorded'
          AND json_extract(payload_json,'$.record.recordId')=${job.source.recordId}
          AND sequence<${tombstone.sequence} ORDER BY sequence DESC LIMIT 1`;
        const priorPayload = priorRows[0]?.payload;
        if (priorPayload === undefined || priorPayload === null)
          return yield* deny("Original selected memory source is unavailable");
        const previous = yield* decodeRecorded(priorPayload);
        const original = previous.record;
        if (
          original.kind !== "memory-source" ||
          original.status !== "current" ||
          original.tombstonedAt !== undefined ||
          original.projectId !== input.projectId ||
          projectMemoryHash(original.content) !== original.contentHash ||
          !same(recorded.record, job.source) ||
          job.source.status !== "retracted" ||
          !same(
            {
              ...original,
              content: job.source.content,
              contentHash: job.source.contentHash,
              revision: original.revision + 1,
              generation: original.generation + 1,
              updatedAt: recorded.occurredAt,
              tombstonedAt: recorded.occurredAt,
              status: "retracted",
              sharedWithProjectIds: [],
            },
            job.source,
          )
        )
          return yield* deny("Human memory tombstone changed its exact selection");
        const sizes = yield* sql<{
          bytes: number;
        }>`SELECT length(CAST(payload_json AS BLOB)) AS bytes
          FROM project_work_events WHERE project_id=${input.projectId}
          AND command_id=${tombstone.commandId} ORDER BY sequence LIMIT 3`;
        const receiptSizes = yield* sql<{ bytes: number }>`SELECT
          length(CAST(result_json AS BLOB))+length(CAST(event_ids_json AS BLOB))+
          length(CAST(payload_fingerprint AS BLOB))+length(CAST(actor_kind AS BLOB))+
          length(CAST(actor_id AS BLOB))+length(CAST(source_kind AS BLOB))+
          length(CAST(source_id AS BLOB)) AS bytes FROM project_work_command_receipts
          WHERE project_id=${input.projectId} AND command_id=${tombstone.commandId} LIMIT 2`;
        if (
          sizes.length !== 2 ||
          sizes.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 262144) ||
          receiptSizes.length !== 1 ||
          !Number.isSafeInteger(receiptSizes[0]?.bytes) ||
          (receiptSizes[0]?.bytes ?? 524289) > 524288 ||
          (auditBytes +=
            Buffer.byteLength(priorPayload) +
            Buffer.byteLength(tombstone.payload) +
            sizes.reduce((total, row) => total + row.bytes, 0) +
            (receiptSizes[0]?.bytes ?? 4194305)) > 4194304
        )
          return yield* deny("Human memory retraction proof exceeds its retained bound");
        const events = yield* sql<{
          id: string;
          payload: string;
        }>`SELECT event_id AS id,payload_json AS payload
          FROM project_work_events WHERE project_id=${input.projectId} AND command_id=${tombstone.commandId}
          ORDER BY sequence LIMIT 2`;
        const rows = yield* sql<{
          fingerprint: string;
          actorKind: string;
          actorId: string | null;
          sourceKind: string;
          sourceId: string | null;
          result: string;
          ids: string;
        }>`SELECT
          payload_fingerprint AS fingerprint,actor_kind AS actorKind,actor_id AS actorId,
          source_kind AS sourceKind,source_id AS sourceId,result_json AS result,event_ids_json AS ids
          FROM project_work_command_receipts WHERE project_id=${input.projectId}
          AND command_id=${tombstone.commandId} LIMIT 2`;
        const receipt = rows[0];
        if (
          rows.length !== 1 ||
          receipt === undefined ||
          receipt.actorKind !== "human" ||
          events.length !== 2
        )
          return yield* deny("Human memory retraction receipt is unavailable");
        const request = yield* decodeRetraction({
          type: "project-team.memory.retract",
          commandId: tombstone.commandId,
          projectId: input.projectId,
          expectedRevision: recorded.revision - 1,
          sourceRecordId: original.recordId,
          expectedSourceRecordRevision: original.revision,
          sourceRevision: original.sourceRevision,
          sourceGeneration: original.generation,
          contentHash: original.contentHash,
        });
        const fingerprint =
          "project-team-intent:" +
          NodeCrypto.createHash("sha256")
            .update(
              canonicalProjectWorkPayload({
                intent: request,
                actor: {
                  kind: receipt.actorKind,
                  ...(receipt.actorId === null ? {} : { id: receipt.actorId }),
                },
                source: {
                  kind: receipt.sourceKind,
                  ...(receipt.sourceId === null ? {} : { id: receipt.sourceId }),
                },
                managed: null,
              }),
            )
            .digest("hex");
        const result = yield* decodeResult(receipt.result);
        const ids = yield* decodeEventIds(receipt.ids);
        const first = events[0],
          second = events[1];
        if (first === undefined || second === undefined)
          return yield* deny("Human memory retraction events missing");
        const sourceEvent = yield* decodeRecorded(first.payload);
        const effectEvent = yield* decodeRecorded(second.payload);
        if (
          receipt.fingerprint !== fingerprint ||
          result.projectId !== input.projectId ||
          result.receipt.projectId !== input.projectId ||
          result.receipt.commandId !== request.commandId ||
          result.receipt.status !== "accepted" ||
          result.receipt.eventCount !== 2 ||
          !same(ids, [first.id, second.id]) ||
          !same(ids, result.delta.eventIds) ||
          sourceEvent.eventId !== first.id ||
          effectEvent.eventId !== second.id ||
          sourceEvent.projectId !== input.projectId ||
          effectEvent.projectId !== input.projectId ||
          sourceEvent.revision !== request.expectedRevision + 1 ||
          effectEvent.revision !== sourceEvent.revision + 1 ||
          result.revision !== effectEvent.revision ||
          result.receipt.revision !== result.revision ||
          sourceEvent.occurredAt !== effectEvent.occurredAt ||
          !same(sourceEvent, recorded) ||
          !same(effectEvent.record, job.effect) ||
          job.effect.effectKind !== "memory-delete"
        )
          return yield* deny("Human memory retraction is not the accepted exact command");
        return original;
      });
      // Decisions have no task field. Cleanup is eligible only through the real
      // accepted replacement history, not a projection's superseded label.
      let decisionHistory: Array<ProjectWorkDecision> | undefined;
      const historicalDecisions: Array<ProjectWorkDecision> = [];
      const auditDecisions = Effect.fn("ProjectMemoryProcessing.auditDecisions")(function* () {
        if (decisionHistory !== undefined) return decisionHistory;
        const metadata = yield* sql<{ bytes: number }>`SELECT
          length(CAST(payload_json AS BLOB)) + length(CAST(event_id AS BLOB)) +
          length(CAST(command_id AS BLOB)) + length(CAST(occurred_at AS BLOB)) AS bytes
          FROM project_work_events WHERE project_id=${input.projectId}
          AND event_type IN ('project-work.decision.proposed','project-work.decision.accepted',
          'project-work.decision.rejected','project-work.decision.superseded') ORDER BY sequence LIMIT 1025`;
        if (
          metadata.length > 1024 ||
          metadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 263168) ||
          (auditBytes += metadata.reduce((sum, row) => sum + row.bytes, 0)) > 4194304
        )
          return yield* deny("Decision cleanup history exceeds its retained bound");
        const rows = yield* sql<{
          id: string;
          commandId: string;
          at: string;
          payload: string;
        }>`SELECT
          event_id AS id,command_id AS commandId,occurred_at AS at,payload_json AS payload
          FROM project_work_events WHERE project_id=${input.projectId}
          AND event_type IN ('project-work.decision.proposed','project-work.decision.accepted',
          'project-work.decision.rejected','project-work.decision.superseded') ORDER BY sequence LIMIT 1024`;
        if (rows.length !== metadata.length) return yield* deny("Decision cleanup history changed");
        let original = emptyProjectWorkReducerState(input.projectId);
        for (const row of rows) {
          const event = yield* decodeDecisionEvent(row.payload);
          const nested =
            event.type === "project-work.decision.proposed"
              ? event.decision
              : event.type === "project-work.decision.superseded"
                ? event.replacement
                : undefined;
          if (
            event.eventId !== row.id ||
            event.projectId !== input.projectId ||
            event.occurredAt !== row.at ||
            (event.type !== "project-work.decision.proposed" &&
              event.attribution.actor.kind !== "human") ||
            (nested !== undefined &&
              (nested.projectId !== input.projectId ||
                nested.attribution === undefined ||
                !same(
                  {
                    actor: { kind: nested.attribution.actor.kind, id: nested.attribution.actor.id },
                    source: {
                      kind: nested.attribution.source.kind,
                      id: nested.attribution.source.id,
                    },
                    recordedAt: nested.attribution.recordedAt,
                  },
                  {
                    actor: { kind: event.attribution.actor.kind, id: event.attribution.actor.id },
                    source: {
                      kind: event.attribution.source.kind,
                      id: event.attribution.source.id,
                    },
                    recordedAt: event.attribution.recordedAt,
                  },
                )))
          )
            return yield* deny("Decision cleanup event attribution changed");
          const sizes = yield* sql<{ bytes: number }>`SELECT length(CAST(result_json AS BLOB)) +
            length(CAST(event_ids_json AS BLOB)) + length(CAST(actor_kind AS BLOB)) +
            length(CAST(actor_id AS BLOB)) + length(CAST(source_kind AS BLOB)) +
            length(CAST(source_id AS BLOB)) AS bytes FROM project_work_command_receipts
            WHERE project_id=${input.projectId} AND command_id=${row.commandId} LIMIT 2`;
          if (
            sizes.length !== 1 ||
            !Number.isSafeInteger(sizes[0]?.bytes) ||
            (sizes[0]?.bytes ?? 524289) > 524288 ||
            (auditBytes += sizes[0]?.bytes ?? 4194305) > 4194304
          )
            return yield* deny("Decision cleanup receipt exceeds its bound");
          const receipts = yield* sql<{
            result: string;
            ids: string;
            actorKind: string;
            actorId: string | null;
            sourceKind: string;
            sourceId: string | null;
          }>`SELECT
            result_json AS result,event_ids_json AS ids,actor_kind AS actorKind,actor_id AS actorId,
            source_kind AS sourceKind,source_id AS sourceId FROM project_work_command_receipts
            WHERE project_id=${input.projectId} AND command_id=${row.commandId} LIMIT 2`;
          const receipt = receipts[0];
          if (
            receipt === undefined ||
            receipt.actorKind !== event.attribution.actor.kind ||
            receipt.actorId !== (event.attribution.actor.id ?? null) ||
            receipt.sourceKind !== event.attribution.source.kind ||
            receipt.sourceId !== (event.attribution.source.id ?? null)
          )
            return yield* deny("Decision cleanup receipt authority changed");
          const result = yield* decodeResult(receipt.result);
          const ids = yield* decodeEventIds(receipt.ids);
          if (
            result.projectId !== input.projectId ||
            result.receipt.projectId !== input.projectId ||
            result.receipt.commandId !== row.commandId ||
            result.receipt.status !== "accepted" ||
            ids.length !== result.receipt.eventCount ||
            new Set(ids).size !== ids.length ||
            !same(ids, result.delta.eventIds) ||
            ids.filter((id) => id === row.id).length !== 1
          )
            return yield* deny("Decision cleanup receipt membership changed");
          if (event.type === "project-work.decision.proposed") {
            if (
              event.decision.state !== "proposed" ||
              original.decisions?.some((record) => record.decisionId === event.decision.decisionId)
            )
              return yield* deny("Decision cleanup proposal is not an original proposal");
          } else {
            const previous = original.decisions?.find(
              (record) => record.decisionId === event.decisionId,
            );
            if (
              previous === undefined ||
              previous.state !==
                (event.type === "project-work.decision.superseded" ? "accepted" : "proposed")
            )
              return yield* deny("Decision cleanup transition lacks its original authority state");
            if (
              event.type === "project-work.decision.superseded" &&
              (event.replacement.state !== "proposed" ||
                event.replacement.supersedesDecisionId !== event.decisionId ||
                original.decisions?.some(
                  (record) => record.decisionId === event.replacement.decisionId,
                ))
            )
              return yield* deny(
                "Decision cleanup replacement is not an original proposed successor",
              );
          }
          original = applyProjectWorkEvents(original, [event]);
          historicalDecisions.push(...(original.decisions ?? []));
        }
        decisionHistory = original.decisions ?? [];
        return decisionHistory;
      });
      for (const row of jobs.slice(0, limit)) {
        if (row.payload === null) {
          degraded = true;
          continue;
        }
        const selected = yield* Effect.gen(function* () {
          const job = yield* decodeJob(row.payload);
          const records = state.foundationRecords ?? [];
          const source = records.find(
            (record) => record.kind === "memory-source" && record.recordId === job.source.recordId,
          );
          const effect = records.find(
            (record) => record.kind === "effect" && record.effectId === row.effectId,
          );
          if (
            source?.kind !== "memory-source" ||
            effect?.kind !== "effect" ||
            (effect.effectKind === "memory-index"
              ? source.status !== "current"
              : effect.effectKind !== "memory-delete" ||
                !["superseded", "retracted"].includes(source.status)) ||
            (effect.effectKind === "memory-delete" &&
              row.status === "settled" &&
              !includeCompletedCleanup)
          )
            return;
          const humanRetraction =
            effect.effectKind === "memory-delete" && source.status === "retracted";
          const originalSource = humanRetraction ? yield* auditRetraction(job) : source;
          const retained = yield* decodeRetained(originalSource.content);
          const current =
            retained.kind === "comment"
              ? state.comments?.find((record) => record.commentId === retained.record.commentId)
              : retained.kind === "evidence"
                ? state.evidence.find((record) => record.evidenceId === retained.record.evidenceId)
                : state.decisions?.find(
                    (record) => record.decisionId === retained.record.decisionId,
                  );
          if (
            current === undefined ||
            (retained.kind !== "decision" && retained.record.taskId !== input.taskId)
          )
            return;
          if (effect.effectKind === "memory-index") {
            if (
              !same(current, retained.record) ||
              (retained.kind === "decision" && retained.record.state !== "accepted")
            )
              return;
          } else if (humanRetraction) {
            if (retained.kind === "decision") {
              const history = yield* auditDecisions();
              if (
                retained.record.state !== "accepted" ||
                !historicalDecisions.some((record) => same(record, retained.record)) ||
                !same(
                  history.find((record) => record.decisionId === retained.record.decisionId),
                  current,
                )
              )
                return yield* deny("Retracted decision lacks its original accepted history");
            }
            if (job.extraction !== undefined || !same(effect.payload.recordIds, [source.recordId]))
              return yield* deny("Human memory cleanup contains obsolete indexing");
          } else {
            // A same-task artifact may change, but must still retain the original
            // captured identity. Decisions additionally need accepted human lineage.
            if (retained.kind === "decision") {
              const currentDecision = yield* decodeDecision(current);
              const history = yield* auditDecisions();
              if (
                !historicalDecisions.some((record) => same(record, retained.record)) ||
                retained.record.state !== "accepted" ||
                currentDecision.state !== "superseded" ||
                !same(
                  history.find((record) => record.decisionId === retained.record.decisionId),
                  currentDecision,
                )
              )
                return yield* deny("Cleanup decision lacks its original accepted history");
              let parentId = retained.record.decisionId;
              const visited = new Set<string>([parentId]);
              for (;;) {
                const children = history.filter(
                  (record) => record.supersedesDecisionId === parentId,
                );
                if (children.length !== 1 || visited.size >= 256)
                  return yield* deny("Cleanup decision replacement chain is ambiguous");
                const child = children[0];
                if (
                  child === undefined ||
                  visited.has(child.decisionId) ||
                  !same(
                    state.decisions?.find((record) => record.decisionId === child.decisionId),
                    child,
                  )
                )
                  return yield* deny("Cleanup decision replacement chain changed");
                visited.add(child.decisionId);
                if (child.state === "accepted") break;
                if (child.state !== "superseded")
                  return yield* deny("Cleanup decision has no current accepted replacement");
                parentId = child.decisionId;
              }
            } else return yield* deny("Cleanup artifact has no approved correction producer");
            if (
              job.extraction !== undefined ||
              effect.payload.recordIds.length !== 1 ||
              effect.payload.recordIds[0] !== source.recordId
            )
              return yield* deny("Cleanup job contains obsolete index work");
          }
          if (
            job.environmentId !== authority.binding.environmentId ||
            job.projectId !== input.projectId ||
            job.effect.effectId !== effect.effectId ||
            job.effect.recordId !== effect.recordId ||
            job.effect.projectId !== effect.projectId ||
            job.effect.effectKind !== effect.effectKind ||
            job.effect.targetId !== effect.targetId ||
            job.effect.taskId !== effect.taskId ||
            job.effect.runId !== effect.runId ||
            job.effect.sourceId !== effect.sourceId ||
            job.effect.sourceGeneration !== effect.sourceGeneration ||
            job.effect.availableAt !== effect.availableAt ||
            job.effect.generation !== effect.generation ||
            !same(job.effect.payload, effect.payload) ||
            effect.targetId !== source.recordId ||
            effect.generation !== source.generation ||
            !same(job.source, source) ||
            source.sourceRevision !== retained.record.revision ||
            projectMemoryHash(source.content) !== source.contentHash
          )
            return yield* deny("Memory source selector disagrees with its immutable captured job");
          yield* auditRecord(source);
          yield* auditRecord(effect);
          const extraction = records.find(
            (record) =>
              record.kind === "memory-extraction" &&
              record.recordId === effect.payload.recordIds[1],
          );
          const status =
            row.status === "uncertain"
              ? ("uncertain" as const)
              : row.status === "claimed"
                ? ("processing" as const)
                : row.status === "settled" &&
                    extraction?.kind === "memory-extraction" &&
                    extraction.status === "no-facts"
                  ? ("no-facts" as const)
                  : row.status === "settled" &&
                      extraction?.kind === "memory-extraction" &&
                      extraction.status === "indexed"
                    ? ("indexed" as const)
                    : ("waiting" as const);
          const ownerMetadata = yield* sql<{ bytes: number | null }>`SELECT
          length(CAST(owner_json AS BLOB)) AS bytes FROM project_team_memory_job
          WHERE effect_id=${row.effectId} LIMIT 2`;
          const ownerBytes = ownerMetadata[0]?.bytes ?? 0;
          if (
            ownerMetadata.length !== 1 ||
            !Number.isSafeInteger(ownerBytes) ||
            ownerBytes > 262144 ||
            (auditBytes += ownerBytes) > 4194304
          )
            return yield* deny("Memory selected owner exceeds its retained page budget");
          const owned = yield* sql<{ owner: string | null }>`SELECT
          CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
          FROM project_team_memory_job WHERE effect_id=${row.effectId} LIMIT 2`;
          let waitingReason =
            "Exact approved owner selection is required; processing may be disabled";
          if (owned[0]?.owner !== null && owned[0]?.owner !== undefined) {
            const original = yield* decodeOwnerJson(owned[0].owner);
            const operation = yield* sql<{
              status: string;
            }>`SELECT status FROM project_team_pi_operation
            WHERE environment_id=${original.operation.environmentId} AND binding_id=${original.operation.bindingId}
            AND generation=${original.operation.generation} AND operation_id=${original.operation.operationId} LIMIT 2`;
            waitingReason =
              operation.length === 1 && operation[0]?.status === "running"
                ? "The original selected operation owns this source; retained stages are never resent"
                : "The original selected operation has stopped; processing waits without a new owner or budget";
          }
          return {
            selection: {
              kind: retained.kind,
              retainedId:
                retained.kind === "comment"
                  ? retained.record.commentId
                  : retained.kind === "evidence"
                    ? retained.record.evidenceId
                    : retained.record.decisionId,
              retainedRevision: current.revision,
              sourceRecordId: source.recordId,
              expectedSourceRecordRevision: source.revision,
              sourceRevision: source.sourceRevision,
              sourceGeneration: source.generation,
              contentHash: source.contentHash,
              effectId: effect.effectId,
              expectedEffectRevision: effect.revision,
              expectedClaimGeneration: effect.claimGeneration,
            },
            status,
            ...(status === "waiting"
              ? {
                  reason:
                    effect.effectKind === "memory-delete"
                      ? "Exact historical-source cleanup; " + waitingReason
                      : waitingReason,
                }
              : status === "uncertain"
                ? {
                    reason: waitingReason.includes("stopped")
                      ? "Original selected operation stopped; uncertain outcome is retained without resend or renewed budget"
                      : "Original model or companion outcome is uncertain; no automatic resend",
                  }
                : {}),
          };
        }).pipe(Effect.result);
        if (selected._tag === "Success") {
          if (selected.success !== undefined) items.push(selected.success);
        } else if (isServiceError(selected.failure) || Schema.isSchemaError(selected.failure))
          degraded = true;
        else return yield* selected.failure;
      }
      const last = jobs[Math.min(jobs.length, limit) - 1];
      const ports = yield* Effect.serviceOption(ProjectMemoryPorts);
      const availability = Option.isNone(ports)
        ? ("disabled" as const)
        : ports.value.availability !== undefined
          ? yield* ports.value.availability
          : (yield* ports.value.assertConfigured().pipe(Effect.result))._tag === "Success"
            ? ("available" as const)
            : ("degraded" as const);
      return yield* decodePage({
        projectId: input.projectId,
        taskId: input.taskId,
        revision: state.revision,
        status: degraded ? "degraded" : availability,
        items,
        ...(jobs.length > limit && last !== undefined ? { nextCursor: last.effectId } : {}),
      });
    },
  );
  const compileInTransaction = Effect.fn("ProjectMemoryProcessing.compileInTransaction")(function* (
    supplied: ProjectTeamMemoryProcessIntent,
    principal: ProjectTeamPrincipal,
    attribution: ProjectWorkAttribution,
    resolve: (
      principal: ProjectTeamPrincipal,
    ) => Effect.Effect<ProjectTeamAuthority | undefined, ProjectTeamAuthorizationError>,
    duplicate: boolean,
  ) {
    yield* caller;
    const request = yield* decodeRequest(supplied);
    if (
      principal.managed === undefined ||
      principal.actor.kind !== "agent" ||
      attribution.actor.kind !== principal.actor.kind ||
      attribution.actor.id !== principal.actor.id ||
      principal.actor.id === undefined
    )
      return yield* deny("Memory selection requires authenticated managed authority");
    const fingerprint =
      "project-team-intent:" +
      NodeCrypto.createHash("sha256")
        .update(
          canonicalProjectWorkPayload({
            intent: request,
            actor: { kind: principal.actor.kind, id: principal.actor.id },
            source: { kind: attribution.source.kind, id: attribution.source.id },
            managed: principal.managed,
          }),
        )
        .digest("hex");
    const saved = yield* sql<{ owner: string | null; bytes: number | null }>`SELECT
      CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner,
      length(CAST(owner_json AS BLOB)) AS bytes
      FROM project_team_memory_job WHERE project_id=${request.projectId}
      AND effect_id=${request.selection.effectId} LIMIT 2`;
    // The job's persisted environment is checked against the authenticated original
    // operation below; selection never supplies an environment or an owner.
    if (saved.length > 1 || saved.some((row) => row.bytes !== null && row.owner === null))
      return yield* deny("Memory job owner is corrupt or exceeds its retained bound");
    const retained =
      saved[0]?.owner === null || saved[0]?.owner === undefined
        ? undefined
        : yield* decodeOwnerJson(saved[0].owner);
    if (duplicate) {
      if (
        retained === undefined ||
        retained.intentFingerprint !== fingerprint ||
        retained.commandId !== request.commandId ||
        !same(retained.request, request) ||
        retained.actorId !== principal.actor.id ||
        retained.sourceKind !== attribution.source.kind ||
        retained.sourceId !== (attribution.source.id ?? null) ||
        retained.operation.bindingId !== principal.managed.bindingId ||
        retained.operation.generation !== principal.managed.generation ||
        retained.operation.providerInstanceId !== principal.managed.providerInstanceId ||
        retained.operation.threadId !== principal.managed.threadId
      )
        return yield* deny("Original memory selection identity changed");
      const events = yield* sql<{
        payload: string | null;
        eventId: string;
      }>`SELECT event_id AS eventId,
        CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
        FROM project_work_events WHERE project_id=${request.projectId} AND command_id=${request.commandId}
        ORDER BY sequence LIMIT 2`;
      const event =
        events[0]?.payload === null || events[0]?.payload === undefined
          ? undefined
          : yield* decodeRecorded(events[0].payload);
      const receipts = yield* sql<{
        fingerprint: string;
        actorId: string | null;
        sourceKind: string | null;
        sourceId: string | null;
        result: string | null;
        ids: string | null;
      }>`SELECT payload_fingerprint AS fingerprint,actor_id AS actorId,source_kind AS sourceKind,
        source_id AS sourceId,
        CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result,
        CASE WHEN length(CAST(event_ids_json AS BLOB))<=262144 THEN event_ids_json END AS ids
        FROM project_work_command_receipts WHERE project_id=${request.projectId}
        AND command_id=${request.commandId} LIMIT 2`;
      const receipt = receipts[0];
      if (
        events.length !== 1 ||
        event === undefined ||
        event.eventId !== events[0]?.eventId ||
        event.projectId !== request.projectId ||
        event.occurredAt !== retained.admittedAt ||
        !same(event.record, retained.admittedEffect) ||
        receipts.length !== 1 ||
        receipt === undefined ||
        receipt.result === null ||
        receipt.ids === null ||
        receipt.fingerprint !== fingerprint ||
        receipt.actorId !== retained.actorId ||
        receipt.sourceKind !== retained.sourceKind ||
        receipt.sourceId !== retained.sourceId
      )
        return yield* deny("Original memory selection event or receipt changed");
      const result = yield* decodeResult(receipt.result);
      const ids = yield* decodeEventIds(receipt.ids);
      if (
        result.receipt.status !== "accepted" ||
        result.receipt.commandId !== request.commandId ||
        result.receipt.eventCount !== 1 ||
        !same(ids, [event.eventId]) ||
        !same(result.delta.eventIds, ids)
      )
        return yield* deny("Original memory selection command receipt is corrupt");
      return yield* decodeCommand({
        type: "project-work.foundation.commit",
        commandId: request.commandId,
        projectId: request.projectId,
        expectedRevision: request.expectedRevision,
        attribution: { ...attribution, recordedAt: retained.admittedAt },
        records: [retained.admittedEffect],
        committedAt: retained.admittedAt,
      });
    }
    const authority = yield* resolve(principal);
    const operation = yield* Effect.serviceOption(ProjectMemoryOperation);
    const ports = yield* Effect.serviceOption(ProjectMemoryPorts);
    if (
      authority === undefined ||
      Option.isNone(operation) ||
      authority.role.memoryAccess === "none" ||
      !authority.role.tools.includes("project-work.write") ||
      !authority.binding.configuration.toolIds.includes("project-work.write") ||
      authority.binding.projectId !== request.projectId ||
      authority.binding.taskId !== request.taskId
    )
      return yield* deny("Memory selection has no current executing approved task owner");
    if (Option.isNone(ports))
      return yield* deny("Memory processing is not configured; source remains ownerless");
    yield* ports.value.assertConfigured();
    const task = authority.state.tasks.find((entry) => entry.taskId === request.taskId);
    if (
      task === undefined ||
      authority.state.revision !== request.expectedRevision ||
      task.revision !== request.expectedTaskRevision ||
      task.specRevision !== request.specRevision ||
      authority.binding.planRevision !== request.planRevision
    )
      return yield* deny("Memory selection task scope changed");
    const page = yield* readSourcesInTransaction(
      {
        operation: "memory-sources",
        projectId: request.projectId,
        taskId: request.taskId,
        limit: 1,
      },
      authority,
      request.selection.effectId,
    );
    const selected = page.items[0];
    if (
      page.items.length !== 1 ||
      selected === undefined ||
      !same(selected.selection, request.selection) ||
      selected.status !== "waiting"
    )
      return yield* deny("Memory source has changed or already has an immutable owner");
    const owner = yield* operation.value.readCurrentInTransaction(principal);
    if (
      !same(operation.value.identity, {
        environmentId: owner.environmentId,
        projectId: owner.projectId,
        taskId: owner.taskId,
        bindingId: owner.bindingId,
        generation: owner.generation,
        providerInstanceId: owner.providerInstanceId,
        threadId: owner.threadId,
        operationId: owner.operationId,
        workerId: owner.workerId,
        ordinal: owner.ordinal,
      })
    )
      return yield* deny("Memory operation context changed");
    const effect = authority.state.foundationRecords?.find(
      (entry) => entry.kind === "effect" && entry.effectId === request.selection.effectId,
    );
    if (effect?.kind !== "effect" || effect.status !== "pending")
      return yield* deny("Memory work is not pending");
    const admittedEffect = {
      ...effect,
      revision: effect.revision + 1,
      updatedAt: attribution.recordedAt,
    };
    const admitted = yield* decodeOwner({
      version: 1,
      operation: owner,
      selection: request.selection,
      request,
      admittedEffect,
      commandId: request.commandId,
      intentFingerprint: fingerprint,
      actorId: principal.actor.id,
      sourceKind: attribution.source.kind,
      sourceId: attribution.source.id ?? null,
      admittedAt: attribution.recordedAt,
    });
    // Repository validates and compiles under the same owning transaction. The
    // second call must reuse the first admission, including its original time.
    const selectedOwner = retained ?? admitted;
    if (
      retained !== undefined &&
      (!same(retained.operation, owner) ||
        retained.intentFingerprint !== fingerprint ||
        !same(retained.request, request) ||
        retained.actorId !== principal.actor.id ||
        retained.sourceKind !== attribution.source.kind ||
        retained.sourceId !== (attribution.source.id ?? null) ||
        !same(retained.admittedEffect, { ...admittedEffect, updatedAt: retained.admittedAt }))
    )
      return yield* deny("Memory source already has a different immutable owner");
    yield* sql`UPDATE project_team_memory_job SET owner_json=${canonicalProjectWorkPayload(selectedOwner)}
      WHERE effect_id=${request.selection.effectId} AND environment_id=${owner.environmentId}
      AND project_id=${owner.projectId} AND owner_json IS NULL AND status='pending' AND claim_generation=0`;
    const committed = yield* sql<{ owner: string | null }>`SELECT
      CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
      FROM project_team_memory_job WHERE effect_id=${request.selection.effectId}
      AND environment_id=${owner.environmentId} AND project_id=${owner.projectId} LIMIT 2`;
    if (
      committed.length !== 1 ||
      committed[0]?.owner !== canonicalProjectWorkPayload(selectedOwner)
    )
      return yield* deny("Memory operation owner lost its immutable admission");
    yield* operation.value.readCurrentInTransaction(principal);
    yield* ports.value.assertConfigured();
    return yield* decodeCommand({
      type: "project-work.foundation.commit",
      commandId: request.commandId,
      projectId: request.projectId,
      expectedRevision: request.expectedRevision,
      attribution: { ...attribution, recordedAt: selectedOwner.admittedAt },
      records: [selectedOwner.admittedEffect],
      committedAt: selectedOwner.admittedAt,
    });
  });
  return { readSourcesInTransaction, compileInTransaction };
});

import type { ProjectMemoryCompanionForwardFence } from "./ProjectMemoryCompanionJournal.ts";

export interface ProjectMemoryProcessingConsumerOptions {
  readonly queryCompanion?: ProjectMemoryQueryConsumerOptions["companion"];
  readonly confirmQueryTransportDrained?: ProjectMemoryQueryConsumerOptions["confirmSearchTransportDrained"];
  readonly environmentId: string;
  readonly maximumConcurrentCalls: number;
  readonly maximumConcurrentModelCalls: number;
  readonly readConfiguration: Effect.Effect<
    ProjectMemoryProcessingConfiguration | undefined,
    ProjectMemoryServiceError
  >;
  /** Existing native admission holds and captured aggregate resource proof apply
   * before immutable admission and every forward stage. Never a config boolean. */
  readonly assertAdmission: Effect.Effect<void, ProjectMemoryServiceError>;
  readonly readCredential: (reference: string) => Effect.Effect<string, ProjectMemoryServiceError>;
  readonly exchange: (
    request: ProjectMemoryModelExchange,
    reservationId: string,
    assertCurrent: Effect.Effect<void, ProjectMemoryServiceError>,
  ) => Effect.Effect<ProjectMemoryModelResponse, ProjectMemoryServiceError>;
  readonly confirmModelTransportDrained: (
    reservationId: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly releaseModelTransportObservation?: (reservationId: string) => Effect.Effect<void>;
  readonly observeCompanionCleanup?: (effectId: string) => Effect.Effect<void>;
  readonly confirmCompanionTransportDrained?: (
    effectId: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly companion: (
    owner: ProjectMemoryJobOwner,
    configuration: ProjectMemoryProcessingConfiguration,
    request: Uint8Array,
    assertForwardInTransaction: ProjectMemoryCompanionForwardFence,
  ) => ReturnType<MemoryBackendTransport>;
}

const JoinedDrain = Schema.Struct({
  unit: Id,
  invocation: Id,
  cgroup: Schema.String.check(Schema.isMaxLength(4096)),
  ownerPid: Schema.NullOr(Safe),
  memoryBytes: Safe,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
  launcherPid: Safe,
  childPid: Schema.NullOr(Safe),
  childExitCode: Schema.NullOr(Schema.Int),
  kernel: Schema.String.check(Schema.isMaxLength(128)),
});
const decodeJoinedTerminal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      identity: PiWorkerIdentity,
      operation: PiWorkerOperation,
      outcome: Schema.Literals(["success", "failed", "canceled"]),
      ownerCaptured: Schema.Literal(true),
      native: Schema.NullOr(PiNativeReference),
      drain: JoinedDrain,
      accountingReceipts: Schema.Array(Schema.Json).check(Schema.isMaxLength(256)),
      failureCode: Schema.optionalKey(Id),
    }),
  ),
  strict,
);
const decodeJoinedProcessOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Id,
      nonce: Id,
      invocation: Id,
      cgroup: Schema.String.check(Schema.isMaxLength(4096)),
      pid: Safe,
      memoryBytes: Safe,
      swapBytes: Schema.Literal(0),
      oomGroup: Schema.Literal(1),
    }),
  ),
  strict,
);
const decodeJoinedIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.JsonObject,
      binding: ProjectTeamRunBinding,
      allocation: PiManagedProcessAllocationSchema,
    }),
  ),
);
const decodeJoinedIdentity = Schema.decodeUnknownEffect(ProjectMemoryOperationIdentity, strict);
const decodeMemoryIdentity = Schema.decodeUnknownEffect(ProjectMemoryOperationIdentity);
const decodeClaimGeneration = Schema.decodeUnknownEffect(Safe);
const decodeJoinedAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  strict,
);
const decodeJoinedDrain = Schema.decodeUnknownEffect(Schema.fromJsonString(JoinedDrain), strict);
const validJoinedKernelDrain = (kernel: string) => {
  if (kernel === "removed") return true;
  if (kernel.length > 128) return false;
  const fields = new Map<string, string>();
  for (const line of (kernel.endsWith("\n") ? kernel.slice(0, -1) : kernel).split("\n")) {
    const match = /^(populated|frozen) ([01])$/.exec(line);
    if (!match || fields.has(match[1]!)) return false;
    fields.set(match[1]!, match[2]!);
  }
  return fields.get("populated") === "0";
};

/** The real gateway invokes this consumer after the original admission commits.
 * Context fetching never joins it; ownerless/stopped/uncertain jobs stay retained. */
export const makeProjectMemoryProcessingConsumer = Effect.fn("makeProjectMemoryProcessingConsumer")(
  function* (options: ProjectMemoryProcessingConsumerOptions) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectTeamAuthorization;
    const processing = yield* makeProjectMemoryProcessing;
    const contentGuard = yield* ProjectWorkContentGuard;
    const crypto = yield* Crypto.Crypto;
    const configured = Effect.fn("ProjectMemoryProcessing.configured")(function* () {
      const configuration = yield* options.readConfiguration;
      if (configuration === undefined) return yield* deny("Memory processing is not configured");
      yield* options.assertAdmission;
      return configuration;
    });
    const assertConfigured = () => configured().pipe(Effect.asVoid);
    const availability = options.readConfiguration.pipe(
      Effect.flatMap((configuration) =>
        configuration === undefined
          ? Effect.succeed("disabled" as const)
          : options.assertAdmission.pipe(
              Effect.match({
                onSuccess: () => "available" as const,
                onFailure: () => "degraded" as const,
              }),
            ),
      ),
    );
    const recoverJoinedOperation = Effect.fn("ProjectMemoryProcessing.recoverJoinedOperation")(
      function* (supplied: ProjectMemoryOperationIdentity) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Joined memory recovery owns its original SQL transaction");
        const identity = yield* decodeJoinedIdentity(supplied);
        if (identity.environmentId !== options.environmentId)
          return yield* deny("Joined memory recovery environment changed");
        yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const wakes = yield* sql.withTransaction(
              Effect.gen(function* () {
                const operations = yield* sql<{
                  environment_id: string;
                  project_id: string;
                  binding_id: string;
                  generation: number;
                  provider_instance_id: string;
                  thread_id: string;
                  operation_id: string;
                  worker_id: string;
                  operation_ordinal: number;
                  operation_kind: string;
                  request_hash: string;
                  intent: string | null;
                  terminal: string | null;
                }>`SELECT environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,
              operation_id,worker_id,operation_ordinal,operation_kind,request_hash,
              CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json END AS intent,
              CASE WHEN length(CAST(terminal_json AS BLOB))<=262144 THEN terminal_json END AS terminal
              FROM project_team_pi_operation WHERE environment_id=${identity.environmentId}
              AND operation_id=${identity.operationId} LIMIT 2`;
                const row = operations[0];
                if (
                  operations.length !== 1 ||
                  !row ||
                  !row.intent ||
                  row.project_id !== identity.projectId ||
                  row.binding_id !== identity.bindingId ||
                  row.generation !== identity.generation ||
                  row.provider_instance_id !== identity.providerInstanceId ||
                  row.thread_id !== identity.threadId ||
                  row.worker_id !== identity.workerId ||
                  row.operation_ordinal !== identity.ordinal ||
                  row.operation_kind !== "prompt"
                )
                  return yield* deny("Joined memory recovery original operation is unavailable");
                const intent = yield* decodeJoinedIntent(row.intent);
                const binding = intent.binding;
                if (
                  binding.environmentId !== identity.environmentId ||
                  binding.projectId !== identity.projectId ||
                  binding.taskId !== identity.taskId ||
                  binding.recordId !== identity.bindingId ||
                  binding.generation !== identity.generation ||
                  binding.providerInstanceId !== identity.providerInstanceId ||
                  binding.threadId !== identity.threadId ||
                  intent.request.kind !== "prompt" ||
                  intent.request.threadId !== identity.threadId ||
                  intent.request.operationId !== identity.operationId ||
                  projectMemoryHash(intent.request) !== row.request_hash
                )
                  return yield* deny("Joined memory recovery original identity changed");
                const queries = yield* sql<{
                  id: string;
                  status: string;
                  result: string | null;
                }>`SELECT query_id AS id,status,result_json AS result FROM project_team_memory_query
              WHERE operation_id=${identity.operationId} LIMIT 129`;
                if (queries.length > 128)
                  return yield* deny("Joined memory query recovery exceeds its bound");
                const jobs = yield* sql<{
                  id: string;
                  generation: number;
                  owner: string | null;
                  status: string;
                  receipt: string | null;
                }>`SELECT effect_id AS id,claim_generation AS generation,status,receipt_json AS receipt,
              CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
              FROM project_team_memory_job WHERE json_extract(owner_json,'$.operation.operationId')=${identity.operationId}
                OR (environment_id=${identity.environmentId} AND project_id=${identity.projectId} AND owner_json IS NOT NULL
                  AND (length(CAST(owner_json AS BLOB))>262144
                    OR COALESCE(json_type(owner_json,'$.operation.operationId'),'')<>'text'
                    OR length(json_extract(owner_json,'$.operation.operationId')) NOT BETWEEN 1 AND 256)) LIMIT 129`;
                if (jobs.length > 128)
                  return yield* deny("Joined memory source recovery exceeds its bound");
                if (queries.length === 0 && jobs.length === 0) return [];
                if (!row.terminal)
                  return yield* deny("Joined memory recovery terminal is unavailable");
                const terminal = yield* decodeJoinedTerminal(row.terminal);
                if (
                  terminal.identity.workerId !== identity.workerId ||
                  terminal.identity.generation !== identity.generation ||
                  terminal.operation.operationId !== identity.operationId ||
                  terminal.operation.operationKind !== "prompt" ||
                  terminal.failureCode === "CALLBACK_DRAIN_UNKNOWN"
                )
                  return yield* deny("Joined memory recovery callback join changed");
                const processes = yield* sql<{
                  unit: string;
                  allocation: string | null;
                  owner: string | null;
                  drain: string | null;
                }>`
              SELECT unit,
              CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json END AS allocation,
              CASE WHEN length(CAST(owner_json AS BLOB))<=32768 THEN owner_json END AS owner,
              CASE WHEN length(CAST(drain_json AS BLOB))<=32768 THEN drain_json END AS drain
              FROM project_team_pi_process WHERE operation_id=${identity.operationId} LIMIT 2`;
                const process = processes[0];
                if (
                  processes.length !== 1 ||
                  !process?.allocation ||
                  !process.owner ||
                  !process.drain
                )
                  return yield* deny("Joined memory recovery process receipts are unavailable");
                const allocation = yield* decodeJoinedAllocation(process.allocation);
                const owner = yield* decodeJoinedProcessOwner(process.owner);
                const drain = yield* decodeJoinedDrain(process.drain);
                if (
                  !same(allocation, intent.allocation) ||
                  !same(drain, terminal.drain) ||
                  !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                    allocation.nonce,
                  ) ||
                  allocation.unit !== `t3-pi-managed-${allocation.nonce}.service` ||
                  process.unit !== allocation.unit ||
                  owner.unit !== allocation.unit ||
                  owner.nonce !== allocation.nonce ||
                  !/^[a-f0-9]{32}$/.test(owner.invocation) ||
                  !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
                  !owner.cgroup.endsWith(`/${owner.unit}`) ||
                  owner.cgroup.split("/").some((part) => part === "." || part === "..") ||
                  owner.pid <= 0 ||
                  allocation.policy.memoryBytes !== allocation.launch.memoryBytes ||
                  allocation.policy.runtimeSeconds !== allocation.launch.runtimeSeconds ||
                  owner.memoryBytes !== allocation.policy.memoryBytes ||
                  owner.memoryBytes <= 0 ||
                  allocation.launch.workspaceRoot !== binding.worktree ||
                  allocation.launch.workspace.path !== binding.worktree ||
                  drain.unit !== owner.unit ||
                  drain.invocation !== owner.invocation ||
                  drain.cgroup !== owner.cgroup ||
                  drain.ownerPid !== owner.pid ||
                  drain.memoryBytes !== owner.memoryBytes ||
                  drain.launcherPid <= 0 ||
                  !validJoinedKernelDrain(drain.kernel)
                )
                  return yield* deny("Joined memory recovery process evidence changed");
                const ids: string[] = [];
                for (const query of queries) {
                  const owner = yield* readProjectMemoryQueryOwnerById(sql, query.id);
                  if (
                    !same(yield* decodeMemoryIdentity(owner.operation), identity) ||
                    !same(owner.operation.allocation, allocation) ||
                    owner.operation.requestSha256 !== row.request_hash
                  )
                    return yield* deny("Joined memory query original owner changed");
                  yield* auditProjectMemoryQueryAdmission(sql, owner);
                  yield* sql`UPDATE project_team_memory_query SET status='uncertain' WHERE query_id=${query.id}
                AND status IN ('embedding','searching') AND result_json IS NULL`;
                  if (
                    query.result === null &&
                    ["embedding", "searching", "uncertain"].includes(query.status)
                  )
                    ids.push(query.id);
                }
                for (const job of jobs) {
                  if (!job.owner) return yield* deny("Joined memory source owner unavailable");
                  const owner = yield* decodeOwnerJson(job.owner);
                  if (
                    !same(yield* decodeMemoryIdentity(owner.operation), identity) ||
                    !same(owner.operation.allocation, allocation) ||
                    owner.operation.requestSha256 !== row.request_hash
                  )
                    return yield* deny("Joined memory source original owner changed");
                  yield* auditProjectMemoryAdmission(sql, owner);
                  const generation = yield* decodeClaimGeneration(job.generation);
                  yield* sql`UPDATE project_team_memory_job SET status='uncertain' WHERE effect_id=${job.id}
                AND claim_generation=${generation} AND status='claimed' AND receipt_json IS NULL AND owner_json=${job.owner}`;
                  if (job.receipt === null && ["claimed", "uncertain"].includes(job.status))
                    ids.push(job.id);
                }
                return ids;
              }),
            );
            for (const id of wakes) yield* options.observeCompanionCleanup?.(id) ?? Effect.void;
          }),
        );
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Joined memory recovery evidence unavailable"),
      ),
    );
    const reconcileTransportDrain = Effect.fn("ProjectMemoryProcessing.reconcileTransportDrain")(
      function* (reservationId: string) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Memory drain cleanup owns its original SQL transaction");
        const query = yield* sql`SELECT 1 FROM project_team_memory_query
          WHERE environment_id=${options.environmentId} AND query_id=${reservationId} LIMIT 1`;
        if (query.length === 1) return yield* queries.reconcileQuery(reservationId);
        const jobs = yield* sql<{
          owner: string | null;
          status: string;
        }>`SELECT status, CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner FROM project_team_memory_job WHERE environment_id=${options.environmentId} AND effect_id=${reservationId} LIMIT 2`;
        if (jobs.length !== 0) {
          if (
            jobs.length !== 1 ||
            !jobs[0]?.owner ||
            options.confirmCompanionTransportDrained === undefined
          )
            return yield* deny("Original job companion cleanup is unavailable");
          if (jobs[0].status !== "uncertain" && jobs[0].status !== "settled")
            return yield* deny("Memory job owner has not relinquished unfinished work");
          const owner = yield* decodeOwnerJson(jobs[0].owner);
          yield* auditProjectMemoryAdmission(sql, owner);
          yield* options.confirmCompanionTransportDrained(reservationId);
          const modelRows = yield* sql<{
            id: string | null;
            status: string;
            reservation: string | null;
          }>`SELECT CASE WHEN length(CAST(reservation_id AS BLOB))<=256 THEN reservation_id END AS id,
            CASE WHEN length(CAST(status AS BLOB))<=32 THEN status END AS status,
            CASE WHEN length(CAST(reservation_json AS BLOB))<=32768 THEN reservation_json END AS reservation FROM project_team_model_request
            WHERE environment_id=${options.environmentId} AND project_id=${owner.operation.projectId} AND operation_id=${owner.operation.operationId}
            AND request_lane='memory' AND json_extract(reservation_json,'$.effectId')=${reservationId} ORDER BY reservation_id LIMIT 129`;
          if (modelRows.length > 128)
            return yield* deny("Original job model cleanup exceeds its bound");
          const accounting = yield* makeProjectMemoryModelAccounting({
            environmentId: options.environmentId,
            maximumConcurrentCalls: options.maximumConcurrentCalls,
            maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
            assertCurrentInTransaction: () =>
              Effect.fail(deny("Drain cleanup cannot start a source stage")),
            assertTransportDrainedInTransaction: (id) => options.confirmModelTransportDrained(id),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
          );
          for (const row of modelRows) {
            if (!row.id || !row.reservation)
              return yield* deny("Original job model cleanup identity changed");
            const reservation = yield* decodeReservationJson(row.reservation);
            if (reservation.version !== 1 || reservation.effectId !== reservationId)
              return yield* deny("Job cleanup cannot adopt a query reservation");
            if (row.status === "held")
              yield* accounting.settle({
                ...reservation,
                reservationId: row.id,
                outcome: "unknown",
                transportDrained: false,
                chargedInputTokens: reservation.maxInputTokens,
                chargedOutputTokens: reservation.maxOutputTokens,
              });
            yield* accounting.confirmTransportDrained(reservationId, row.id);
            yield* options.releaseModelTransportObservation?.(row.id) ?? Effect.void;
          }
          return;
        }
        const rows = yield* sql<{ reservation: string | null }>`SELECT
      CASE WHEN length(CAST(reservation_json AS BLOB))<=32768 THEN reservation_json END AS reservation
      FROM project_team_model_request WHERE environment_id=${options.environmentId}
      AND reservation_id=${reservationId} AND request_lane='memory' LIMIT 2`;
        if (
          rows.length !== 1 ||
          rows[0]?.reservation === null ||
          rows[0]?.reservation === undefined
        )
          return yield* deny("Memory drain has no bounded original reservation");
        const reservation = yield* decodeReservationJson(rows[0].reservation);
        if (reservation.version === 2) return yield* queries.reconcileQuery(reservation.effectId);
        const accounting = yield* makeProjectMemoryModelAccounting({
          environmentId: options.environmentId,
          maximumConcurrentCalls: options.maximumConcurrentCalls,
          maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
          assertCurrentInTransaction: () =>
            Effect.fail(deny("Drain cleanup cannot authorize a model stage")),
          assertTransportDrainedInTransaction: (id) => options.confirmModelTransportDrained(id),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
        );
        yield* accounting.confirmTransportDrained(reservation.effectId, reservationId);
        yield* options.releaseModelTransportObservation?.(reservationId) ?? Effect.void;
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Original memory drain cleanup is unavailable"),
      ),
    );
    const consume = Effect.fn("ProjectMemoryProcessing.consume")(
      function* (principal: ProjectTeamPrincipal, effectId: string) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Memory processing must follow the owning admission commit");
        const configuration = yield* configured();
        const extractionRoute = projectMemoryExtractionRoute(configuration.extraction.endpoint);
        if (extractionRoute === undefined)
          return yield* deny("Memory extraction endpoint is unavailable");
        const executing = yield* Effect.serviceOption(ProjectMemoryOperation);
        if (Option.isNone(executing))
          return yield* deny("Memory processing waits for its captured executing bridge");
        const configurationHash = projectMemoryHash(configuration);
        const owners = yield* sql<{ owner: string | null }>`SELECT
      CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner
      FROM project_team_memory_job WHERE environment_id=${options.environmentId}
      AND effect_id=${effectId} LIMIT 2`;
        const payload = owners[0]?.owner;
        if (owners.length !== 1 || payload === null || payload === undefined)
          return yield* deny("Memory job waits for explicit approved task selection");
        const owner = yield* decodeOwnerJson(payload);
        if (
          principal.actor.kind !== "agent" ||
          principal.actor.id !== owner.actorId ||
          principal.managed === undefined ||
          principal.managed.projectId !== owner.operation.projectId ||
          principal.managed.bindingId !== owner.operation.bindingId ||
          principal.managed.generation !== owner.operation.generation ||
          principal.managed.providerInstanceId !== owner.operation.providerInstanceId ||
          principal.managed.threadId !== owner.operation.threadId
        )
          return yield* deny("Memory job is not owned by this executing managed task");
        const fence = Effect.gen(function* () {
          if (projectMemoryHash(yield* configured()) !== configurationHash)
            return yield* deny("Memory processing configuration changed");
          yield* auditProjectMemoryAdmission(sql, owner);
          const current = yield* executing.value.readCurrentInTransaction(principal);
          if (!same(current, owner.operation))
            return yield* deny("Original memory task owner is no longer current");
          const state = yield* readCurrentState(sql, owner.operation.projectId);
          const source = state.foundationRecords?.find(
            (entry) =>
              entry.kind === "memory-source" && entry.recordId === owner.selection.sourceRecordId,
          );
          const cleanup = owner.admittedEffect.effectKind === "memory-delete";
          if (
            source?.kind !== "memory-source" ||
            (cleanup
              ? !["superseded", "retracted"].includes(source.status)
              : source.status !== "current") ||
            source.sourceRevision !== owner.selection.sourceRevision ||
            source.generation !== owner.selection.sourceGeneration ||
            source.contentHash !== owner.selection.contentHash
          )
            return yield* deny("Selected memory source is no longer current");
          if (cleanup) {
            const authority = yield* authorization.resolve(principal);
            if (authority === undefined)
              return yield* deny("Cleanup task authority is unavailable");
            const page = yield* processing.readSourcesInTransaction(
              {
                operation: "memory-sources",
                projectId: owner.operation.projectId,
                taskId: owner.request.taskId,
                limit: 1,
              },
              authority,
              effectId,
              true,
            );
            const selected = page.items[0]?.selection;
            if (
              page.items.length !== 1 ||
              selected === undefined ||
              !same(selected, {
                ...owner.selection,
                expectedEffectRevision: selected.expectedEffectRevision,
                expectedClaimGeneration: selected.expectedClaimGeneration,
              })
            )
              return yield* deny("Original historical cleanup source changed");
            // Cleanup sends only the captured namespace/source tuple. Its raw
            // body may now be unsafe; it never becomes model or backend text.
            return;
          }
          yield* contentGuard
            .assertSafe(source)
            .pipe(Effect.mapError(() => deny("Selected source failed content safety")));
          const retained = yield* decodeRetained(source.content);
          yield* contentGuard
            .assertSafe(retained.record)
            .pipe(Effect.mapError(() => deny("Selected source failed content safety")));
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
          Effect.mapError((error) =>
            isServiceError(error) ? error : deny("Original memory source authority is unavailable"),
          ),
        );
        yield* sql.withTransaction(fence);
        const accounting = yield* makeProjectMemoryModelAccounting({
          environmentId: options.environmentId,
          extractionEndpoint: configuration.extraction.endpoint,
          maximumConcurrentCalls: options.maximumConcurrentCalls,
          maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
          assertCurrentInTransaction: () => fence,
          assertTransportDrainedInTransaction: (id) => options.confirmModelTransportDrained(id),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectWorkRepository, repository),
        );
        const model = Effect.fn("ProjectMemoryProcessing.model")(
          function* (
            phase: "extract" | "embed",
            source: {
              readonly content: string;
              readonly recordId: string;
              readonly sourceRevision: number;
              readonly generation: number;
            },
            bodies?: readonly string[],
          ) {
            if (owner.admittedEffect.effectKind !== "memory-index")
              return yield* deny("Historical cleanup cannot authorize a model stage");
            if (
              source.recordId !== owner.selection.sourceRecordId ||
              source.sourceRevision !== owner.selection.sourceRevision ||
              source.generation !== owner.selection.sourceGeneration
            )
              return yield* deny("Model stage changed its admitted source");
            const port = phase === "extract" ? configuration.extraction : configuration.embedding;
            if (
              phase === "extract" &&
              !withinProjectMemoryExtractionLimits(
                port.endpoint,
                port.maximumInputTokens,
                port.maximumOutputTokens,
              )
            )
              return yield* deny("Memory extraction exceeds endpoint limits");
            const credential = yield* options.readCredential(port.credentialRef);
            yield* contentGuard.registerKnownSecrets([credential]);
            const deadlineAtMs = Math.min(
              owner.operation.rootDeadlineAtMs,
              owner.operation.attemptDeadlineAtMs,
              owner.operation.operationDeadlineAtMs,
              owner.operation.leaseDeadlineAtMs,
            );
            const modelFence = fence.pipe(
              Effect.andThen(
                phase === "embed"
                  ? contentGuard
                      .assertSafe(bodies ?? [])
                      .pipe(
                        Effect.mapError(() => deny("Memory embedding text failed content safety")),
                      )
                  : Effect.void,
              ),
            );
            yield* sql.withTransaction(modelFence);
            const reserved = yield* accounting.reserve(owner, {
              phase,
              routeId: port.routeId,
              requestId: 1,
              maxInputTokens: port.maximumInputTokens,
              maxOutputTokens: port.maximumOutputTokens,
              deadlineAtMs,
            });
            if (reserved.status === "existing")
              return yield* deny("Retained model stage requires reconciliation, never resend");
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const result = yield* restore(
                  executing.value.assertForward.pipe(
                    Effect.andThen(sql.withTransaction(modelFence)),
                    Effect.andThen(
                      options.exchange(
                        {
                          phase,
                          endpoint: port.endpoint,
                          credential,
                          model: reserved.reservation.model,
                          maximumInputTokens: port.maximumInputTokens,
                          maximumOutputTokens: port.maximumOutputTokens,
                          deadlineAtMs,
                          input: phase === "extract" ? source.content : (bodies ?? []),
                        },
                        reserved.reservationId,
                        sql
                          .withTransaction(modelFence)
                          .pipe(
                            Effect.mapError((error) =>
                              isServiceError(error)
                                ? error
                                : deny("Final memory model fence denied"),
                            ),
                          ),
                      ),
                    ),
                  ),
                ).pipe(Effect.exit);
                if (Exit.isFailure(result)) {
                  yield* accounting.settle({
                    ...reserved.reservation,
                    reservationId: reserved.reservationId,
                    outcome: "unknown",
                    chargedInputTokens: reserved.reservation.maxInputTokens,
                    chargedOutputTokens: reserved.reservation.maxOutputTokens,
                    transportDrained: false,
                  });
                  yield* reconcileTransportDrain(reserved.reservationId).pipe(
                    Effect.catch(() => Effect.void),
                  );
                  return yield* Effect.failCause(result.cause);
                }
                const response = result.value;
                const settlement = {
                  ...reserved.reservation,
                  reservationId: reserved.reservationId,
                  outcome: "reported" as const,
                  chargedInputTokens: response.inputTokens,
                  chargedOutputTokens: response.outputTokens,
                  transportDrained: true,
                  reportedModel: response.reportedModel,
                  reportedInputTokens: response.inputTokens,
                  reportedOutputTokens: response.outputTokens,
                };
                const settled = yield* accounting.settle(settlement).pipe(Effect.result);
                if (settled._tag === "Failure") {
                  yield* accounting.settle({
                    ...reserved.reservation,
                    reservationId: reserved.reservationId,
                    outcome: "unknown",
                    chargedInputTokens: reserved.reservation.maxInputTokens,
                    chargedOutputTokens: reserved.reservation.maxOutputTokens,
                    transportDrained: false,
                  });
                  yield* reconcileTransportDrain(reserved.reservationId).pipe(
                    Effect.catch(() => Effect.void),
                  );
                  return yield* settled.failure;
                }
                yield* reconcileTransportDrain(reserved.reservationId).pipe(
                  Effect.catch(() => Effect.void),
                );
                yield* sql.withTransaction(fence);
                return response.value;
              }),
            );
          },
          Effect.mapError((error) =>
            isServiceError(error) ? error : deny("Original memory model stage is unavailable"),
          ),
        );
        const service = makeProjectMemoryService({
          sql,
          repository,
          authorization,
          contentGuard,
          environmentId: options.environmentId,
          selectedExtractionModel: extractionRoute.model,
          manifests: makeProjectMemoryManifestStore(sql),
          authorizeCapture: () => fence,
          assertProcessingInTransaction: fence,
          models: {
            extract: (input) => model("extract", input.source),
            embed: (input) => model("embed", input.source, input.bodies),
          },
        });
        const outcomes = makeProjectMemoryOutcome({
          sql,
          repository,
          environmentId: options.environmentId,
        });
        const guardedBackend = makeMem0Backend((request) =>
          executing.value.assertForward.pipe(
            Effect.andThen(sql.withTransaction(fence)),
            Effect.andThen(options.companion(owner, configuration, request, fence)),
            Effect.tap(() => sql.withTransaction(fence)),
            Effect.mapError(
              () =>
                new MemoryBackendError({
                  code: "fenced",
                  message: "Original memory companion authority changed",
                }),
            ),
          ),
        );
        // Each backend call must retain the same current owner after awaited model
        // and companion work. The original reactor performs typed manifest checks.
        const guarded = makeProjectMemoryIndexReactor({
          sql,
          repository,
          service,
          backend: guardedBackend,
          environmentId: options.environmentId,
          outcomes,
          assertProcessingInTransaction: fence,
        });
        const original = yield* guarded.load(effectId);
        if (original?.status === "uncertain") {
          // An explicit retry consumes cleanup proof, then the original reactor retains
          // its new claim generation under the still-current original task fence.
          yield* reconcileTransportDrain(effectId);
          yield* sql.withTransaction(fence);
          yield* guarded.consume(owner.operation.projectId, effectId, {
            generation: original.claimGeneration,
            confirmDrained: reconcileTransportDrain(effectId),
          });
          return;
        }
        yield* guarded.consume(owner.operation.projectId, effectId);
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Configured memory processing could not complete"),
      ),
    );
    const queries = yield* makeProjectMemoryQueryConsumer({
      environmentId: options.environmentId,
      maximumConcurrentCalls: options.maximumConcurrentCalls,
      maximumConcurrentModelCalls: options.maximumConcurrentModelCalls,
      readConfiguration: options.readConfiguration,
      assertAdmission: options.assertAdmission,
      readCredential: options.readCredential,
      exchange: options.exchange,
      confirmModelTransportDrained: options.confirmModelTransportDrained,
      ...(options.releaseModelTransportObservation === undefined
        ? {}
        : { releaseModelTransportObservation: options.releaseModelTransportObservation }),
      ...(options.observeCompanionCleanup === undefined
        ? {}
        : { observeCompanionCleanup: options.observeCompanionCleanup }),
      ...(options.queryCompanion === undefined ? {} : { companion: options.queryCompanion }),
      ...(options.confirmQueryTransportDrained === undefined
        ? {}
        : { confirmSearchTransportDrained: options.confirmQueryTransportDrained }),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectWorkRepository, repository),
      Effect.provideService(ProjectTeamAuthorization, authorization),
      Effect.provideService(ProjectWorkContentGuard, contentGuard),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    return ProjectMemoryPorts.of({
      ...queries,
      assertConfigured,
      readConfiguration: () => options.readConfiguration,
      availability,
      consume: (principal, effectId) =>
        consume(principal, effectId).pipe(
          Effect.onExit(() =>
            sql<{
              status: string;
            }>`SELECT status FROM project_team_memory_job WHERE effect_id=${effectId}`.pipe(
              Effect.flatMap((rows) =>
                rows[0]?.status === "uncertain" || rows[0]?.status === "settled"
                  ? (options.observeCompanionCleanup?.(effectId) ?? Effect.void)
                  : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        ),
      reconcileTransportDrain,
      recoverJoinedOperation,
    });
  },
);
