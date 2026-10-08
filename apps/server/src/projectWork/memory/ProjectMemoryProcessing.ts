import {
  canonicalProjectWorkPayload,
  EventId,
  ProjectTeamRecord,
  ProjectTeamMemorySourcesRead,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectWorkEvidence,
  ProjectWorkWriteResult,
  ProjectTeamMemoryProcessIntent,
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
import {
  ProjectMemoryOperation,
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
            source.status !== "current" ||
            effect.effectKind !== "memory-index"
          )
            return;
          const retained = yield* decodeRetained(source.content);
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
            !same(current, retained.record) ||
            (retained.kind !== "decision" && retained.record.taskId !== input.taskId) ||
            (retained.kind === "decision" && retained.record.state !== "accepted")
          )
            return;
          if (
            job.environmentId !== authority.binding.environmentId ||
            job.projectId !== input.projectId ||
            job.effect.effectId !== effect.effectId ||
            effect.targetId !== source.recordId ||
            effect.generation !== source.generation ||
            !same(job.source, source) ||
            source.sourceRevision !== current.revision ||
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
              ? { reason: waitingReason }
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

export interface ProjectMemoryProcessingConsumerOptions {
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
  ) => Effect.Effect<ProjectMemoryModelResponse, ProjectMemoryServiceError>;
  readonly confirmModelTransportDrained: (
    reservationId: string,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
  readonly releaseModelTransportObservation?: (reservationId: string) => Effect.Effect<void>;
  readonly companion: (
    owner: ProjectMemoryJobOwner,
    configuration: ProjectMemoryProcessingConfiguration,
    request: Uint8Array,
  ) => ReturnType<MemoryBackendTransport>;
}

/** The real gateway invokes this consumer after the original admission commits.
 * Context fetching never joins it; ownerless/stopped/uncertain jobs stay retained. */
export const makeProjectMemoryProcessingConsumer = Effect.fn("makeProjectMemoryProcessingConsumer")(
  function* (options: ProjectMemoryProcessingConsumerOptions) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const authorization = yield* ProjectTeamAuthorization;
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
    const reconcileTransportDrain = Effect.fn("ProjectMemoryProcessing.reconcileTransportDrain")(
      function* (reservationId: string) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* deny("Memory drain cleanup owns its original SQL transaction");
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
          if (
            source?.kind !== "memory-source" ||
            source.status !== "current" ||
            source.sourceRevision !== owner.selection.sourceRevision ||
            source.generation !== owner.selection.sourceGeneration ||
            source.contentHash !== owner.selection.contentHash
          )
            return yield* deny("Selected memory source is no longer current");
          yield* contentGuard
            .assertSafe(source)
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
            if (
              source.recordId !== owner.selection.sourceRecordId ||
              source.sourceRevision !== owner.selection.sourceRevision ||
              source.generation !== owner.selection.sourceGeneration
            )
              return yield* deny("Model stage changed its admitted source");
            const port = phase === "extract" ? configuration.extraction : configuration.embedding;
            const credential = yield* options.readCredential(port.credentialRef);
            yield* contentGuard.registerKnownSecrets([credential]);
            const deadlineAtMs = Math.min(
              owner.operation.rootDeadlineAtMs,
              owner.operation.attemptDeadlineAtMs,
              owner.operation.operationDeadlineAtMs,
              owner.operation.leaseDeadlineAtMs,
            );
            yield* sql.withTransaction(fence);
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
          sql.withTransaction(fence).pipe(
            Effect.andThen(options.companion(owner, configuration, request)),
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
        if (original?.status === "uncertain" || original?.status === "claimed")
          return yield* deny("Memory job waits for original model and companion reconciliation");
        yield* guarded.consume(owner.operation.projectId, effectId);
      },
      Effect.mapError((error) =>
        isServiceError(error) ? error : deny("Configured memory processing could not complete"),
      ),
    );
    return ProjectMemoryPorts.of({
      assertConfigured,
      availability,
      consume,
      reconcileTransportDrain,
    });
  },
);
