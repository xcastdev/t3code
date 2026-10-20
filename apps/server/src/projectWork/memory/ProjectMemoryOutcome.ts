import {
  CommandId,
  ProjectId,
  ProjectTeamRecord,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectWorkEvidence,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkWriteResult,
  canonicalProjectWorkPayload,
  projectWorkPayloadFingerprint,
} from "@t3tools/contracts";
import { COMMAND_CODE_EXTRACTION, LIQUID_EXTRACTION } from "./ProjectMemoryModelRoutes.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { decideProjectWorkCommand, type ProjectWorkReducerState } from "../ProjectWorkDecider.ts";
import { readCurrentState, type ProjectWorkRepositoryShape } from "../ProjectWorkRepository.ts";
import { PROJECT_TEAM_TABLES } from "../ProjectTeamsPersistence.ts";
import type {
  ProjectMemoryOutcomePort,
  ProjectMemoryVerifiedOutcome,
} from "./ProjectMemoryIndexReactor.ts";
import { MemoryIndexManifest } from "./MemoryBackend.ts";
import {
  ProjectMemoryJobInput,
  ProjectMemoryServiceError,
  makeProjectMemoryManifestStore,
  projectMemoryHash,
  projectMemoryId,
} from "./ProjectMemoryService.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Receipt = Schema.Struct({
  effectId: Id,
  claimGeneration: Counter,
  kind: Schema.Literals(["index-complete", "delete-source-complete", "no-facts"]),
  sourceId: Id,
  sourceRevision: Counter,
  sourceGeneration: Counter,
  observationIds: Schema.Array(Id).check(Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter(
    (r) =>
      r.claimGeneration > 0 &&
      new Set(r.observationIds).size === r.observationIds.length &&
      (r.kind === "index-complete" ? r.observationIds.length > 0 : r.observationIds.length === 0),
    { message: "Memory outcome requires its unique complete observation set" },
  ),
);
const Reflection = Schema.Struct({
  mode: Schema.Literals(["domain", "purged-cleanup"]),
  commandId: Schema.optionalKey(Id),
  eventIds: Schema.Array(Id).check(Schema.isMaxLength(2)),
  projectRevision: Schema.optionalKey(Counter),
  outcome: Receipt,
});
const Recorded = Schema.Struct({
  type: Schema.Literal("project-work.foundation.recorded"),
  eventId: Id,
  projectId: Id,
  revision: Counter,
  occurredAt: Schema.String,
  record: ProjectTeamRecord,
});
const RetainedBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comment"), record: ProjectWorkComment }),
  Schema.Struct({ kind: Schema.Literal("evidence"), record: ProjectWorkEvidence }),
  Schema.Struct({ kind: Schema.Literal("decision"), record: ProjectWorkDecision }),
]);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isServiceError = Schema.is(ProjectMemoryServiceError);
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => deny("Invalid retained memory outcome evidence")),
  );
const equal = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const systemAttribution = (at: string) => ({
  actor: { kind: "system" as const, id: "project-memory-indexer" },
  source: { kind: "system" as const, id: "project-memory-indexer" },
  recordedAt: at,
});

/** The immutable physical job supplies the project/environment. A caller supplies
 * only the verified original outcome, never replacement authority or observations.
 */
const makeProjectMemoryOutcomeAudit = (dependencies: {
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: string;
}) => {
  const { sql, environmentId } = dependencies;
  const manifests = makeProjectMemoryManifestStore(sql);
  const loadJob = Effect.fn("ProjectMemoryOutcome.loadJob")(function* (
    outcome: ProjectMemoryVerifiedOutcome,
  ) {
    const rows = yield* sql<{
      environmentId: string;
      projectId: string;
      generation: number;
      status: string;
      inputBytes: number;
      receiptBytes: number | null;
    }>`SELECT environment_id AS environmentId,project_id AS projectId,
      claim_generation AS generation,status,length(CAST(input_json AS BLOB)) AS inputBytes,
      length(CAST(receipt_json AS BLOB)) AS receiptBytes FROM project_team_memory_job WHERE effect_id=${outcome.effectId}`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.environmentId !== environmentId ||
      row.status !== "settled" ||
      row.generation !== outcome.claimGeneration ||
      row.inputBytes > 262144 ||
      row.receiptBytes === null ||
      row.receiptBytes > 262144
    )
      return yield* deny("Memory outcome lacks its original settled journal owner");
    const payloads = yield* sql<{
      input: string;
      receipt: string;
    }>`SELECT input_json AS input,receipt_json AS receipt
      FROM project_team_memory_job WHERE effect_id=${outcome.effectId}
      AND length(CAST(input_json AS BLOB))<=262144 AND length(CAST(receipt_json AS BLOB))<=262144`;
    if (payloads.length !== 1) return yield* deny("Memory job payload changed");
    const payload = payloads[0]!;
    const input = yield* decode(Schema.fromJsonString(ProjectMemoryJobInput), payload.input);
    const receipt = yield* decode(Schema.fromJsonString(Receipt), payload.receipt);
    if (
      Buffer.byteLength(payload.input) !== row.inputBytes ||
      Buffer.byteLength(payload.receipt) !== row.receiptBytes ||
      input.environmentId !== environmentId ||
      input.projectId !== row.projectId ||
      input.effect.recordId !== outcome.effectId ||
      input.effect.effectId !== outcome.effectId ||
      input.effect.projectId !== row.projectId ||
      input.source.projectId !== row.projectId ||
      input.effect.targetId !== input.source.recordId ||
      input.effect.payload.recordIds[0] !== input.source.recordId ||
      input.effect.payload.expectedRevision !== input.source.sourceRevision ||
      input.effect.generation !== input.source.generation ||
      input.effect.status !== "pending" ||
      input.effect.revision !== 0 ||
      input.effect.claimGeneration !== 0 ||
      input.effect.outcome !== undefined ||
      receipt.sourceId !== input.source.recordId ||
      receipt.sourceRevision !== input.source.sourceRevision ||
      receipt.sourceGeneration !== input.source.generation ||
      !equal(receipt, outcome) ||
      Buffer.byteLength(input.source.content) > 32000 ||
      input.source.contentHash !== projectMemoryHash(input.source.content) ||
      (receipt.kind === "delete-source-complete"
        ? input.effect.effectKind !== "memory-delete" ||
          input.effect.payload.recordIds.length !== 1 ||
          input.source.status === "current" ||
          input.extraction !== undefined
        : input.effect.effectKind !== "memory-index" ||
          input.effect.payload.recordIds.length !== 2 ||
          input.source.status !== "current" ||
          input.extraction === undefined ||
          input.extraction.recordId !== input.effect.payload.recordIds[1] ||
          input.extraction.projectId !== row.projectId ||
          input.extraction.sourceId !== input.source.recordId ||
          input.extraction.sourceRevision !== input.source.sourceRevision ||
          input.extraction.sourceGeneration !== input.source.generation ||
          input.extraction.generation !== input.source.generation ||
          input.extraction.status !== "pending" ||
          input.extraction.revision !== 0 ||
          input.extraction.expectedObservationIds.length !== 0 ||
          input.extraction.completedObservationIds.length !== 0 ||
          input.extraction.extractionHash !== undefined)
    )
      return yield* deny("Memory outcome does not match its immutable original job");
    return { input, receipt, receiptJson: canonicalProjectWorkPayload(receipt) };
  });
  const available = Effect.fn("ProjectMemoryOutcome.available")(function* (projectId: string) {
    const rows = yield* sql`SELECT p.project_id FROM projection_projects p
      LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
      WHERE p.project_id=${projectId} AND p.deleted_at IS NULL
      AND (l.state IS NULL OR l.state='active') AND l.tombstone_json IS NULL`;
    return rows.length === 1;
  });
  const physical = Effect.fn("ProjectMemoryOutcome.physical")(function* (
    record: typeof ProjectTeamRecord.Type,
  ) {
    const rows = yield* sql<{
      payload: string;
      projectId: string;
      status: string;
      revision: number;
      generation: number;
      updatedAt: string;
      bytes: number;
    }>`
      SELECT payload_json AS payload,project_id AS projectId,status,revision,generation,updated_at AS updatedAt,
      length(CAST(payload_json AS BLOB)) AS bytes FROM ${sql(`project_team_${record.kind.replaceAll("-", "_")}`)}
      WHERE record_id=${record.recordId} AND length(CAST(payload_json AS BLOB))<=262144`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.bytes > 262144 ||
      row.projectId !== record.projectId ||
      row.status !== record.status ||
      row.revision !== record.revision ||
      row.generation !== record.generation ||
      row.updatedAt !== record.updatedAt
    )
      return yield* deny("Memory physical record metadata does not match current authority");
    const decoded = yield* decode(Schema.fromJsonString(ProjectTeamRecord), row.payload);
    yield* decode(Schema.Array(Counter), [record.revision, record.generation]);
    if (Buffer.byteLength(row.payload) !== row.bytes || !equal(decoded, record))
      return yield* deny("Memory physical record payload does not match current authority");
  });
  const current = Effect.fn("ProjectMemoryOutcome.current")(function* (
    job: Effect.Success<ReturnType<typeof loadJob>>,
    state: ProjectWorkReducerState,
    reflected: boolean,
  ) {
    const { input, receipt } = job;
    const records = state.foundationRecords ?? [];
    const owned = records.filter((record) => record.recordId === receipt.effectId);
    const effect = owned[0];
    if (
      owned.length !== 1 ||
      effect?.kind !== "effect" ||
      effect.effectId !== receipt.effectId ||
      !equal(
        {
          ...effect,
          status: input.effect.status,
          revision: input.effect.revision,
          updatedAt: input.effect.updatedAt,
          claimGeneration: input.effect.claimGeneration,
          outcome: undefined,
        },
        input.effect,
      ) ||
      (reflected && (effect.status !== "succeeded" || effect.outcome !== job.receiptJson)) ||
      (!reflected &&
        effect.status !== "pending" &&
        effect.status !== "claimed" &&
        effect.status !== "uncertain") ||
      (receipt.kind !== "delete-source-complete" &&
        effect.claimGeneration !== receipt.claimGeneration)
    )
      return yield* deny("Memory original effect/current claim identity changed");
    yield* physical(effect);
    const sources = records.filter((record) => record.recordId === receipt.sourceId);
    const source = sources[0];
    if (
      sources.length !== 1 ||
      source?.kind !== "memory-source" ||
      source.projectId !== input.projectId
    )
      return yield* deny("Memory current source is missing or foreign");
    yield* physical(source);
    if (receipt.kind === "delete-source-complete") {
      if (
        source.status === "current" ||
        source.sourceRevision !== receipt.sourceRevision ||
        source.generation < receipt.sourceGeneration ||
        source.sourceId !== input.source.sourceId ||
        source.sourceKind !== input.source.sourceKind ||
        !equal(source.attribution, input.source.attribution)
      )
        return yield* deny("Cleanup cannot reflect a current or replaced source");
      return { effect, source };
    }
    if (
      !(yield* available(input.projectId)) ||
      source.status !== "current" ||
      !equal(source, input.source)
    )
      return yield* deny("Indexed outcome no longer has the exact current source");
    const retained = yield* decode(Schema.fromJsonString(RetainedBody), source.content);
    const live =
      retained.kind === "comment"
        ? state.comments?.find((record) => record.commentId === retained.record.commentId)
        : retained.kind === "evidence"
          ? state.evidence.find((record) => record.evidenceId === retained.record.evidenceId)
          : state.decisions?.find(
              (record) =>
                record.decisionId === retained.record.decisionId && record.state === "accepted",
            );
    if (!equal(live, retained.record)) return yield* deny("Retained memory source changed");
    const extractions = records.filter((record) => record.recordId === input.extraction!.recordId);
    const extraction = extractions[0];
    if (
      extractions.length !== 1 ||
      extraction?.kind !== "memory-extraction" ||
      (extraction.extractionModel !== input.extraction!.extractionModel &&
        !(
          input.extraction!.extractionModel === COMMAND_CODE_EXTRACTION.model &&
          extraction.extractionModel === LIQUID_EXTRACTION.model
        )) ||
      !equal(
        {
          ...extraction,
          // The immutable capture predates route selection. Only the fixed
          // default-to-Liquid finalization above may differ from that input.
          extractionModel: input.extraction!.extractionModel,
          status: input.extraction!.status,
          revision: input.extraction!.revision,
          updatedAt: input.extraction!.updatedAt,
          extractionHash: undefined,
          expectedObservationIds: [],
          completedObservationIds: [],
        },
        input.extraction,
      ) ||
      extraction.extractionHash === undefined ||
      !/^[0-9a-f]{64}$/.test(extraction.extractionHash) ||
      extraction.expectedObservationIds.length !== receipt.observationIds.length ||
      new Set(extraction.expectedObservationIds).size !== receipt.observationIds.length ||
      extraction.expectedObservationIds.some((id) => !receipt.observationIds.includes(id)) ||
      (receipt.kind === "no-facts"
        ? extraction.status !== "no-facts" ||
          extraction.extractionHash !== projectMemoryHash([]) ||
          extraction.completedObservationIds.length !== 0
        : extraction.status !== (reflected ? "indexed" : "extracted") ||
          !equal(
            extraction.completedObservationIds,
            reflected ? extraction.expectedObservationIds : [],
          ))
    )
      return yield* deny("Memory reflection extraction tuple or completed manifest changed");
    yield* physical(extraction);
    const observations = records.filter(
      (record) =>
        record.kind === "memory-observation" && record.extractionId === extraction.recordId,
    );
    if (
      observations.length !== receipt.observationIds.length ||
      new Set(observations.map((record) => record.recordId)).size !== observations.length
    )
      return yield* deny("Memory reflection lacks the whole retained observation set");
    for (const observation of observations) {
      if (
        observation.kind !== "memory-observation" ||
        !receipt.observationIds.includes(observation.recordId) ||
        observation.projectId !== input.projectId ||
        observation.status !== "current" ||
        observation.sourceId !== source.recordId ||
        observation.sourceRevision !== source.sourceRevision ||
        observation.sourceGeneration !== source.generation ||
        observation.generation !== source.generation ||
        !equal(observation.provenance, source.attribution) ||
        observation.recordId !==
          projectMemoryId("memory-observation", [extraction.recordId, observation.observationKey])
      )
        return yield* deny("Memory observation payload/provenance is stale or foreign");
      yield* physical(observation);
    }
    const loadedManifest = yield* manifests.load(extraction.recordId);
    const manifest =
      loadedManifest === undefined ? undefined : yield* decode(MemoryIndexManifest, loadedManifest);
    if (receipt.kind === "no-facts") {
      if (manifest !== undefined)
        return yield* deny("No-facts outcome has unexpected indexed vectors");
    } else if (
      manifest === undefined ||
      manifest.environmentId !== environmentId ||
      manifest.projectId !== input.projectId ||
      manifest.sourceRecordId !== source.recordId ||
      manifest.sourceRevision !== source.sourceRevision ||
      manifest.sourceGeneration !== source.generation ||
      manifest.observations.length !== observations.length ||
      manifest.observations.some((entry, index) => {
        const observation = observations.find(
          (record) => record.recordId === extraction.expectedObservationIds[index],
        );
        return (
          observation?.kind !== "memory-observation" ||
          entry.observationId !== observation.recordId ||
          entry.body !== observation.body ||
          entry.payloadHash !== projectMemoryHash(observation)
        );
      })
    )
      return yield* deny("Memory outcome lacks its exact full prepared manifest");
    return { effect, source, extraction };
  });
  const loadReflection = Effect.fn("ProjectMemoryOutcome.loadReflection")(function* (
    job: Effect.Success<ReturnType<typeof loadJob>>,
  ) {
    const rows = yield* sql<{
      environmentId: string;
      projectId: string;
      generation: number;
      receipt: string;
      reflection: string;
      receiptBytes: number;
      reflectionBytes: number;
    }>`
      SELECT environment_id AS environmentId,project_id AS projectId,claim_generation AS generation,receipt_json AS receipt,
      reflection_json AS reflection,length(CAST(receipt_json AS BLOB)) AS receiptBytes,length(CAST(reflection_json AS BLOB)) AS reflectionBytes
      FROM project_team_memory_outcome WHERE effect_id=${job.receipt.effectId}
      AND length(CAST(receipt_json AS BLOB))<=262144 AND length(CAST(reflection_json AS BLOB))<=262144`;
    if (rows.length === 0) {
      const exists =
        yield* sql`SELECT effect_id FROM project_team_memory_outcome WHERE effect_id=${job.receipt.effectId}`;
      if (exists.length > 0) return yield* deny("Memory reflection storage exceeds budget");
      return undefined;
    }
    const row = rows[0]!;
    if (
      rows.length !== 1 ||
      row.environmentId !== environmentId ||
      row.projectId !== job.input.projectId ||
      row.generation !== job.receipt.claimGeneration ||
      row.receipt !== job.receiptJson ||
      Buffer.byteLength(row.receipt) !== row.receiptBytes ||
      Buffer.byteLength(row.reflection) !== row.reflectionBytes
    )
      return yield* deny("Memory reflection physical identity changed");
    const reflection = yield* decode(Schema.fromJsonString(Reflection), row.reflection);
    if (
      !equal(reflection.outcome, job.receipt) ||
      (reflection.mode === "domain"
        ? reflection.commandId !== projectMemoryId("memory-reflection", [job.receipt]) ||
          reflection.projectRevision === undefined ||
          reflection.eventIds.length !== (job.receipt.kind === "index-complete" ? 2 : 1) ||
          new Set(reflection.eventIds).size !== reflection.eventIds.length
        : job.receipt.kind !== "delete-source-complete" ||
          reflection.commandId !== undefined ||
          reflection.projectRevision !== undefined ||
          reflection.eventIds.length !== 0)
    )
      return yield* deny("Memory reflection receipt is incomplete or foreign");
    return reflection;
  });
  const suppressed = Effect.fn("ProjectMemoryOutcome.suppressed")(function* (
    job: Effect.Success<ReturnType<typeof loadJob>>,
  ) {
    const state = yield* readCurrentState(sql, job.input.projectId);
    const records = state.foundationRecords ?? [];
    const sources = records.filter((record) => record.recordId === job.receipt.sourceId);
    if (
      sources.length > 1 ||
      sources.some(
        (source) =>
          source.kind !== "memory-source" ||
          source.projectId !== job.input.projectId ||
          source.status === "current",
      )
    )
      return yield* deny("Cleanup must retain domain source suppression");
    const metadata = yield* sql<{
      projectId: string;
      status: string;
      bytes: number;
    }>`SELECT project_id AS projectId,status,
      length(CAST(payload_json AS BLOB)) AS bytes FROM project_team_memory_source WHERE record_id=${job.receipt.sourceId}`;
    if (
      metadata.length > 1 ||
      metadata.some(
        (row) =>
          row.projectId !== job.input.projectId || row.status === "current" || row.bytes > 262144,
      )
    )
      return yield* deny("Cleanup must retain physical source suppression");
    const rows = yield* sql<{
      projectId: string;
      status: string;
      payload: string;
    }>`SELECT project_id AS projectId,status,payload_json AS payload
      FROM project_team_memory_source WHERE record_id=${job.receipt.sourceId} AND length(CAST(payload_json AS BLOB))<=262144`;
    if (rows.length !== metadata.length)
      return yield* deny("Cleanup source physical evidence changed");
    for (const row of rows) {
      const value = yield* decode(Schema.fromJsonString(ProjectTeamRecord), row.payload);
      if (
        value.kind !== "memory-source" ||
        value.status !== row.status ||
        value.projectId !== row.projectId ||
        value.recordId !== job.receipt.sourceId
      )
        return yield* deny("Cleanup source suppression is corrupt");
    }
  });
  const verifyReflection = Effect.fn("ProjectMemoryOutcome.verifyReflection")(function* (
    job: Effect.Success<ReturnType<typeof loadJob>>,
    expected: typeof Reflection.Type,
  ) {
    if (!equal(yield* loadReflection(job), expected))
      return yield* deny("Memory reflection receipt write was ignored or changed");
    if (expected.mode === "purged-cleanup") {
      if (yield* available(job.input.projectId))
        return yield* deny("Purged cleanup cannot replace current project authority");
      yield* suppressed(job);
      return;
    }
    if (job.receipt.kind === "delete-source-complete") {
      // A completed domain cleanup survives the later permanent purge. Its original
      // immutable receipt remains the acknowledgment; partial deletion cannot hide
      // a missing or corrupt domain event/command receipt.
      let purged = true;
      for (const table of [
        "projection_projects",
        ...PROJECT_TEAM_TABLES,
        "project_work_events",
        "project_work_command_receipts",
        "project_work_reducer_checkpoints",
      ]) {
        const retained =
          yield* sql`SELECT project_id FROM ${sql(table)} WHERE project_id=${job.input.projectId} LIMIT 1`;
        if (retained.length !== 0) {
          purged = false;
          break;
        }
      }
      if (purged) {
        yield* suppressed(job);
        return;
      }
    }
    const state = yield* readCurrentState(sql, job.input.projectId);
    const work = yield* current(job, state, true);
    const metadata = yield* sql<{
      bytes: number;
    }>`SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM project_work_events
      WHERE project_id=${job.input.projectId} AND command_id=${expected.commandId!} ORDER BY sequence LIMIT 3`;
    if (metadata.length !== expected.eventIds.length || metadata.some((row) => row.bytes > 262144))
      return yield* deny("Memory reflection event receipt exceeds its exact bounded budget");
    const rows = yield* sql<{
      payload: string;
      eventId: string;
      eventType: string;
      occurredAt: string;
    }>`SELECT payload_json AS payload,event_id AS eventId,event_type AS eventType,occurred_at AS occurredAt FROM project_work_events
      WHERE project_id=${job.input.projectId} AND command_id=${expected.commandId!}
      AND length(CAST(payload_json AS BLOB))<=262144 ORDER BY sequence LIMIT 3`;
    if (rows.length !== expected.eventIds.length)
      return yield* deny("Memory reflection event receipt is missing or incomplete");
    const events = yield* Effect.forEach(rows, (row) =>
      decode(Schema.fromJsonString(Recorded), row.payload),
    );
    const at = work.effect.updatedAt;
    const command = yield* decode(ProjectWorkFoundationCommitCommand, {
      type: "project-work.foundation.commit",
      commandId: expected.commandId,
      projectId: job.input.projectId,
      expectedRevision: expected.projectRevision! - events.length,
      records: [],
      transition: {
        kind: "memory.reflect",
        effectId: job.receipt.effectId,
        claimGeneration: job.receipt.claimGeneration,
        outcomeKind: job.receipt.kind,
        sourceId: job.receipt.sourceId,
        sourceRevision: job.receipt.sourceRevision,
        sourceGeneration: job.receipt.sourceGeneration,
        observationIds: job.receipt.observationIds,
        expectedEffectRevision: work.effect.revision - 1,
        ...(work.extraction === undefined
          ? {}
          : {
              expectedExtractionRevision:
                work.extraction.revision - (job.receipt.kind === "index-complete" ? 1 : 0),
            }),
      },
      attribution: systemAttribution(at),
      committedAt: at,
    });
    // Derive order, identity, timestamps and records from the verified private
    // transition. The returned event kind must never select its own comparator.
    const before: ProjectWorkReducerState = {
      ...state,
      revision: command.expectedRevision,
      foundationRecords: state.foundationRecords!.map((record) => {
        if (record.recordId === work.effect.recordId) {
          const { outcome: _outcome, ...effect } = work.effect;
          return {
            ...effect,
            revision: work.effect.revision - 1,
            status: work.effect.claimGeneration === 0 ? "pending" : "claimed",
          };
        }
        if (job.receipt.kind === "index-complete" && record.recordId === work.extraction?.recordId)
          return {
            ...work.extraction,
            revision: work.extraction.revision - 1,
            status: "extracted",
            completedObservationIds: [],
          };
        return record;
      }),
    };
    const required = yield* Effect.try({
      try: () => decideProjectWorkCommand(before, command),
      catch: () => deny("Memory original typed reflection cannot be reconstructed"),
    });
    if (
      !equal(
        required.map((event) => event.eventId),
        expected.eventIds,
      ) ||
      required.length !== events.length
    )
      return yield* deny("Memory original reflection event order or identity changed");
    for (const [index, event] of events.entries()) {
      const row = rows[index]!;
      if (
        !equal(event, required[index]) ||
        row.eventId !== event.eventId ||
        row.eventType !== event.type ||
        row.occurredAt !== event.occurredAt
      )
        return yield* deny("Memory reflection durable event/current record mismatch");
    }
    const receiptRows = yield* sql<{
      fingerprint: string;
      actorKind: string;
      actorId: string;
      sourceKind: string;
      sourceId: string;
      result: string;
      bytes: number;
    }>`
      SELECT payload_fingerprint AS fingerprint,actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId,
      result_json AS result,length(CAST(result_json AS BLOB)) AS bytes FROM project_work_command_receipts
      WHERE project_id=${job.input.projectId} AND command_id=${expected.commandId!} AND length(CAST(result_json AS BLOB))<=262144`;
    const receipt = receiptRows[0];
    if (
      receiptRows.length !== 1 ||
      receipt === undefined ||
      receipt.actorKind !== "system" ||
      receipt.actorId !== "project-memory-indexer" ||
      receipt.sourceKind !== "system" ||
      receipt.sourceId !== "project-memory-indexer" ||
      receipt.fingerprint !==
        projectWorkPayloadFingerprint({
          ...command,
          attribution: { actor: command.attribution.actor, source: command.attribution.source },
        }) ||
      Buffer.byteLength(receipt.result) !== receipt.bytes
    )
      return yield* deny("Memory original command receipt is missing or tampered");
    const result = yield* decode(Schema.fromJsonString(ProjectWorkWriteResult), receipt.result);
    if (
      result.projectId !== job.input.projectId ||
      result.revision !== expected.projectRevision ||
      result.receipt.commandId !== expected.commandId ||
      result.receipt.status !== "accepted" ||
      result.receipt.projectId !== job.input.projectId ||
      result.receipt.revision !== expected.projectRevision ||
      result.receipt.eventCount !== events.length ||
      result.delta.projectId !== job.input.projectId ||
      result.delta.revision !== expected.projectRevision ||
      !equal(result.delta.eventIds, expected.eventIds) ||
      !equal(result.delta.changedFields, ["foundationRecords"])
    )
      return yield* deny("Memory original command result does not cover the exact reflection");
  });
  return { loadJob, loadReflection, verifyReflection, current, available, suppressed };
};

/** Read-only pre-purge proof: a raw settled status cannot replace its domain receipt. */
export const readProjectMemoryCompletedDeletionInTransaction = Effect.fn(
  "readProjectMemoryCompletedDeletionInTransaction",
)(function* (
  sql: SqlClient.SqlClient,
  environmentId: string,
  effectId: string,
  phase: "before-purge" | "projection-sync" = "before-purge",
) {
  if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
    return yield* deny("Memory cleanup audit requires the owning transaction");
  const metadata = yield* sql<{ bytes: number }>`SELECT length(CAST(receipt_json AS BLOB)) AS bytes
    FROM project_team_memory_job WHERE effect_id=${effectId} LIMIT 2`;
  const savedMetadata = metadata[0];
  if (
    metadata.length !== 1 ||
    savedMetadata === undefined ||
    !Number.isSafeInteger(savedMetadata.bytes) ||
    savedMetadata.bytes > 262144
  )
    return yield* deny("Memory cleanup receipt is missing or exceeds its bound");
  const rows = yield* sql<{ receipt: string }>`SELECT receipt_json AS receipt
    FROM project_team_memory_job WHERE effect_id=${effectId} AND length(CAST(receipt_json AS BLOB))<=262144`;
  const savedReceipt = rows[0];
  if (rows.length !== 1 || savedReceipt === undefined)
    return yield* deny("Memory cleanup receipt changed");
  const receipt = yield* decode(Schema.fromJsonString(Receipt), savedReceipt.receipt);
  if (receipt.kind !== "delete-source-complete")
    return yield* deny("Memory source cleanup is not complete");
  const audit = makeProjectMemoryOutcomeAudit({ sql, environmentId });
  const job = yield* audit.loadJob(receipt);
  const reflection = yield* audit.loadReflection(job);
  if (reflection?.mode !== "domain")
    return yield* deny("Memory cleanup lacks pre-purge domain authority");
  // Projection synchronization first proves the recorded lifecycle purge and
  // absence of domain authority. Its deleted events cannot be re-authenticated;
  // only the retained immutable journal tuple is evidence on that path.
  if (phase === "before-purge") yield* audit.verifyReflection(job, reflection);
  return job;
});

export const makeProjectMemoryOutcome = (dependencies: {
  readonly sql: SqlClient.SqlClient;
  readonly repository: ProjectWorkRepositoryShape;
  readonly environmentId: string;
}): ProjectMemoryOutcomePort => {
  const { sql, repository, environmentId } = dependencies;
  const { loadJob, loadReflection, verifyReflection, current, available, suppressed } =
    makeProjectMemoryOutcomeAudit({ sql, environmentId });
  const commitVerifiedOutcome = Effect.fn("ProjectMemoryOutcome.commitVerifiedOutcome")(
    function* (
      raw: ProjectMemoryVerifiedOutcome,
      verifyFinal: Effect.Effect<void, ProjectMemoryServiceError>,
    ) {
      const outcome = yield* decode(Receipt, raw);
      let expected: typeof Reflection.Type | undefined;
      let originalJob: Effect.Success<ReturnType<typeof loadJob>> | undefined;
      yield* repository.executeAtomic(
        Effect.gen(function* () {
          if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
            return yield* deny("Memory reflection requires the captured SQL transaction");
          const job = yield* loadJob(outcome);
          originalJob = job;
          const existing = yield* loadReflection(job);
          if (existing !== undefined) {
            expected = existing;
            yield* verifyReflection(job, existing);
            return [];
          }
          const state = yield* readCurrentState(sql, job.input.projectId);
          if (
            outcome.kind === "delete-source-complete" &&
            !(yield* available(job.input.projectId))
          ) {
            yield* suppressed(job);
            expected = { mode: "purged-cleanup", eventIds: [], outcome };
          } else {
            const work = yield* current(job, state, false);
            const at = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            const command = yield* decode(ProjectWorkFoundationCommitCommand, {
              type: "project-work.foundation.commit",
              commandId: CommandId.make(projectMemoryId("memory-reflection", [outcome])),
              projectId: ProjectId.make(job.input.projectId),
              expectedRevision: state.revision,
              records: [],
              transition: {
                kind: "memory.reflect",
                effectId: outcome.effectId,
                claimGeneration: outcome.claimGeneration,
                outcomeKind: outcome.kind,
                sourceId: outcome.sourceId,
                sourceRevision: outcome.sourceRevision,
                sourceGeneration: outcome.sourceGeneration,
                observationIds: outcome.observationIds,
                expectedEffectRevision: work.effect.revision,
                ...(work.extraction === undefined
                  ? {}
                  : { expectedExtractionRevision: work.extraction.revision }),
              },
              attribution: systemAttribution(at),
              committedAt: at,
            });
            const events = yield* Effect.try({
              try: () => decideProjectWorkCommand(state, command),
              catch: () => deny("Memory typed authority transition rejected reflection"),
            });
            expected = {
              mode: "domain",
              commandId: command.commandId,
              eventIds: events.map((event) => event.eventId),
              projectRevision: state.revision + events.length,
              outcome,
            };
            yield* sql`INSERT INTO project_team_memory_outcome (effect_id,environment_id,project_id,claim_generation,receipt_json,reflection_json)
            VALUES (${outcome.effectId},${environmentId},${job.input.projectId},${outcome.claimGeneration},${job.receiptJson},${canonicalProjectWorkPayload(expected)})
            ON CONFLICT(effect_id) DO NOTHING`;
            if (!equal(yield* loadReflection(job), expected))
              return yield* deny(
                "Memory immutable reflection winner changed or insertion was ignored",
              );
            return [command];
          }
          yield* sql`INSERT INTO project_team_memory_outcome (effect_id,environment_id,project_id,claim_generation,receipt_json,reflection_json)
          VALUES (${outcome.effectId},${environmentId},${job.input.projectId},${outcome.claimGeneration},${job.receiptJson},${canonicalProjectWorkPayload(expected)})
          ON CONFLICT(effect_id) DO NOTHING`;
          return [];
        }),
        Effect.gen(function* () {
          if (expected === undefined)
            return yield* deny("Memory reflection did not retain its expected receipt");
          const job = yield* loadJob(outcome);
          if (originalJob === undefined || !equal(job, originalJob))
            return yield* deny("Memory original job changed before reflection");
          yield* verifyReflection(job, expected);
          yield* verifyFinal;
        }),
      );
    },
    Effect.mapError((error) =>
      isServiceError(error) ? error : deny("Memory atomic reflection failed"),
    ),
  );
  return { commitVerifiedOutcome };
};
