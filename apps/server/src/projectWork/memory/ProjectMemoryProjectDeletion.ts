import {
  canonicalProjectWorkPayload,
  ProjectMemorySource,
  ProjectLifecycleMutationResult,
  ProjectLifecyclePermanentDeleteInput,
  ProjectLifecycleTombstone,
  projectWorkPayloadFingerprint,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readCurrentState } from "../ProjectWorkRepository.ts";
import {
  PROJECT_TEAM_TABLES,
  PROJECT_WORK_CHECKPOINT_VERSION,
} from "../ProjectTeamsPersistence.ts";
import {
  auditProjectMemoryAdmission,
  auditProjectMemoryOperationLedger,
  ProjectMemoryJobOwner,
  ProjectMemoryQueryOwner,
  ProjectMemoryReservation,
  ProjectMemorySettlement,
} from "./ProjectMemoryModelAccounting.ts";
import { readProjectMemoryCompletedDeletionInTransaction } from "./ProjectMemoryOutcome.ts";
import { readProjectMemoryQueryOwnerById } from "./ProjectMemoryQuery.ts";
import {
  ProjectMemoryServiceError,
  ProjectMemoryJobInput,
  projectMemoryHash,
} from "./ProjectMemoryService.ts";

const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isServiceError = Schema.is(ProjectMemoryServiceError);
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemoryJobOwner));
const equal = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);
const strict = { onExcessProperty: "error" } as const;
const decodeLifecycleResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectLifecycleMutationResult),
  strict,
);
const decodeLifecycleInput = Schema.decodeUnknownEffect(
  ProjectLifecyclePermanentDeleteInput,
  strict,
);
const decodeTombstone = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectLifecycleTombstone),
  strict,
);
const decodeJob = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemoryJobInput), strict);
const decodeReservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryReservation),
  strict,
);
const decodeSettlement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemorySettlement),
  strict,
);
const decodeObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  strict,
);

const domainTables = [
  ...PROJECT_TEAM_TABLES,
  "project_work_tasks",
  "project_work_attempts",
  "project_work_criteria",
  "project_work_evidence",
  "project_work_relationships",
  "project_work_blockers",
  "project_work_knowledge",
  "project_work_decisions",
  "project_work_comments",
  "project_work_attention",
  "project_work_attention_occurrences",
  "project_work_notification_publications",
  "project_work_activity",
  "project_work_checkpoints",
  "project_work_search_fts",
  "project_work_command_receipts",
  "project_work_approvals",
  "project_work_reducer_checkpoints",
  "project_work_events",
] as const;

const auditRetainedProjectionJournals = Effect.fn("ProjectMemoryProjectDeletion.retainedJournals")(
  function* (sql: SqlClient.SqlClient, projectId: string, environmentId: string) {
    let bytes = 0;
    const jobs = yield* sql<{ id: string; bytes: number }>`SELECT effect_id AS id,
    length(CAST(input_json AS BLOB))+COALESCE(length(CAST(owner_json AS BLOB)),0)+
    COALESCE(length(CAST(receipt_json AS BLOB)),0) AS bytes FROM project_team_memory_job
    WHERE project_id=${projectId} ORDER BY effect_id LIMIT 257`;
    const manifests = yield* sql<{
      sourceId: string;
      revision: number;
      generation: number;
      bytes: number;
    }>`SELECT
    source_id AS sourceId,source_revision AS revision,source_generation AS generation,
    length(CAST(manifest_json AS BLOB)) AS bytes FROM project_team_memory_manifest
    WHERE project_id=${projectId} ORDER BY extraction_id LIMIT 257`;
    const queries = yield* sql<{ id: string; bytes: number }>`SELECT query_id AS id,
    length(CAST(owner_json AS BLOB))+COALESCE(length(CAST(embedding_json AS BLOB)),0)+
    COALESCE(length(CAST(embedding_result_json AS BLOB)),0)+COALESCE(length(CAST(search_json AS BLOB)),0)+
    COALESCE(length(CAST(search_result_json AS BLOB)),0)+COALESCE(length(CAST(search_drain_json AS BLOB)),0)+
    COALESCE(length(CAST(result_json AS BLOB)),0) AS bytes FROM project_team_memory_query
    WHERE project_id=${projectId} ORDER BY query_id LIMIT 257`;
    const models = yield* sql<{ id: string | null; bytes: number }>`SELECT
    CASE WHEN length(CAST(reservation_id AS BLOB))<=524288 THEN reservation_id END AS id,
    length(CAST(reservation_json AS BLOB))+COALESCE(length(CAST(settlement_json AS BLOB)),0)+
    length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+length(CAST(root_task_id AS BLOB))+
    length(CAST(run_id AS BLOB))+length(CAST(attempt_id AS BLOB))+length(CAST(worker_id AS BLOB))+
    length(CAST(operation_id AS BLOB))+length(CAST(request_scope AS BLOB))+length(CAST(route_id AS BLOB))+
    length(CAST(provider AS BLOB))+length(CAST(model AS BLOB))+
    length(CAST(reservation_id AS BLOB))+COALESCE(length(CAST(accounting_receipt_id AS BLOB)),0) AS bytes
    FROM project_team_model_request WHERE project_id=${projectId} AND request_lane='memory'
    ORDER BY reservation_id LIMIT 257`;
    const outcomes = yield* sql<{ id: string; bytes: number }>`SELECT effect_id AS id,
    length(CAST(receipt_json AS BLOB))+length(CAST(reflection_json AS BLOB)) AS bytes
    FROM project_team_memory_outcome WHERE project_id=${projectId} ORDER BY effect_id LIMIT 257`;
    for (const rows of [jobs, manifests, queries, models, outcomes]) {
      if (
        rows.length > 256 ||
        rows.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 4194304)
      )
        return yield* deny("Retained cleanup journals exceed their synchronization bound");
      bytes += rows.reduce((total, row) => total + row.bytes, 0);
    }
    if (bytes > 4194304)
      return yield* deny("Retained cleanup journals exceed their byte allowance");
    if (
      (yield* sql`SELECT reservation_id FROM project_team_model_request WHERE project_id=${projectId}
    AND (environment_id<>${environmentId} OR capacity_state<>'released' OR status='held') LIMIT 1`)
        .length !== 0
    )
      return yield* deny("Deleted project still has held or quarantined model capacity");
    const coverage = new Map<string, { revision: number; generation: number }>();
    const inputs: Array<typeof ProjectMemoryJobInput.Type> = [];
    const owners = new Map<
      string,
      typeof ProjectMemoryJobOwner.Type | typeof ProjectMemoryQueryOwner.Type
    >();
    const embeddedReceipts = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      if (job.bytes > 786432) return yield* deny("Retained memory job exceeds its bound");
      const rows = yield* sql<{ input: string; owner: string | null; status: string }>`SELECT
      input_json AS input,owner_json AS owner,status FROM project_team_memory_job
      WHERE project_id=${projectId} AND effect_id=${job.id} LIMIT 2`;
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) return yield* deny("Retained memory job changed");
      const input = yield* decodeJob(row.input);
      if (
        input.projectId !== projectId ||
        input.environmentId !== environmentId ||
        input.effect.effectId !== job.id ||
        input.effect.recordId !== job.id ||
        input.effect.targetId !== input.source.recordId ||
        input.effect.generation !== input.source.generation ||
        input.effect.payload.expectedRevision !== input.source.sourceRevision ||
        input.effect.payload.recordIds[0] !== input.source.recordId ||
        input.source.projectId !== projectId ||
        input.source.contentHash !== projectMemoryHash(input.source.content)
      )
        return yield* deny("Retained memory job has a foreign or corrupt original tuple");
      inputs.push(input);
      if (row.owner !== null) {
        const owner = yield* decodeOwner(row.owner);
        if (
          owner.operation.projectId !== projectId ||
          owner.operation.environmentId !== environmentId ||
          owner.request.projectId !== projectId ||
          owner.request.taskId !== owner.operation.taskId ||
          !equal(owner.request.selection, owner.selection) ||
          owner.selection.effectId !== job.id ||
          owner.admittedEffect.effectId !== job.id ||
          owner.selection.sourceRecordId !== input.source.recordId ||
          owner.selection.sourceRevision !== input.source.sourceRevision ||
          owner.selection.sourceGeneration !== input.source.generation
        )
          return yield* deny("Retained memory owner changed its original source tuple");
        owners.set(job.id, owner);
      }
      if (input.effect.effectKind === "memory-delete") {
        if (row.owner === null || row.status !== "settled")
          return yield* deny("Recorded source deletion is incomplete");
        const proof = yield* readProjectMemoryCompletedDeletionInTransaction(
          sql,
          environmentId,
          job.id,
          "projection-sync",
        );
        const prior = coverage.get(proof.receipt.sourceId);
        if (prior !== undefined && prior.revision !== proof.receipt.sourceRevision)
          return yield* deny("Retained source deletion revision disagrees");
        coverage.set(proof.receipt.sourceId, {
          revision: proof.receipt.sourceRevision,
          generation: Math.max(prior?.generation ?? 0, proof.receipt.sourceGeneration),
        });
      } else if (input.effect.effectKind !== "memory-index")
        return yield* deny("Unknown retained memory intent");
      else if (row.owner !== null && row.status !== "settled")
        return yield* deny("An admitted memory index stage remains unsettled");
    }
    if (
      inputs.some((input) => {
        const deleted = coverage.get(input.source.recordId);
        return (
          deleted === undefined ||
          deleted.revision !== input.source.sourceRevision ||
          deleted.generation < input.source.generation ||
          (input.effect.effectKind === "memory-index" &&
            deleted.generation <= input.source.generation)
        );
      }) ||
      manifests.some((manifest) => {
        const deleted = coverage.get(manifest.sourceId);
        return (
          deleted === undefined ||
          deleted.revision !== manifest.revision ||
          deleted.generation <= manifest.generation
        );
      }) ||
      outcomes.some((outcome) => !jobs.some((job) => job.id === outcome.id))
    )
      return yield* deny("Retained cleanup does not fence every original source and index tuple");
    for (const query of queries) {
      if (query.bytes > 1048576) return yield* deny("Retained query exceeds its bound");
      const rows = yield* sql<{
        owner: string;
        status: string;
        embedding: string | null;
        embedded: string | null;
        search: string | null;
        searched: string | null;
        drained: string | null;
        result: string | null;
      }>`SELECT
      owner_json AS owner,status,embedding_json AS embedding,embedding_result_json AS embedded,
      search_json AS search,search_result_json AS searched,search_drain_json AS drained,result_json AS result
      FROM project_team_memory_query WHERE project_id=${projectId} AND query_id=${query.id} LIMIT 2`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        row.result === null ||
        (row.status !== "completed" && row.status !== "failed")
      )
        return yield* deny("Deleted project has an incomplete semantic query");
      const owner = yield* readProjectMemoryQueryOwnerById(sql, query.id);
      const result = yield* decodeObject(row.result);
      if (
        owner.operation.projectId !== projectId ||
        owner.operation.environmentId !== environmentId ||
        owner.admittedEffect.effectId !== query.id ||
        result.kind !== "memory-query-result" ||
        result.version !== 1 ||
        result.queryId !== query.id ||
        result.outcome !== row.status ||
        result.embeddingSha256 !==
          (row.embedded === null
            ? undefined
            : projectMemoryHash(yield* decodeObject(row.embedded))) ||
        result.searchSha256 !==
          (row.searched === null
            ? undefined
            : projectMemoryHash(yield* decodeObject(row.searched))) ||
        result.searchDrainSha256 !==
          (row.drained === null ? undefined : projectMemoryHash(yield* decodeObject(row.drained)))
      )
        return yield* deny("Retained query completion changed its stage receipts");
      if (
        (row.embedding === null) !== (row.embedded === null) ||
        (row.search === null) !== (row.searched === null)
      )
        return yield* deny("Retained query has an unacknowledged stage");
      if (row.embedding !== null && row.embedded !== null) {
        const intent = yield* decodeObject(row.embedding);
        const embedded = yield* decodeObject(row.embedded);
        if (
          intent.version !== 1 ||
          intent.queryId !== query.id ||
          intent.requestId !== 1 ||
          intent.ownerSha256 !== projectMemoryHash(owner) ||
          intent.querySha256 !== projectMemoryHash(owner.request.query) ||
          projectMemoryHash(intent.configuration) !== owner.configurationSha256 ||
          embedded.version !== 1 ||
          embedded.queryId !== query.id ||
          (embedded.outcome !== "reported" &&
            embedded.outcome !== "failed" &&
            embedded.outcome !== "unknown")
        )
          return yield* deny("Retained query embedding changed its original intent");
        embeddedReceipts.set(query.id, embedded);
      }
      if (row.searched !== null) {
        const searched = yield* decodeObject(row.searched);
        const search = row.search === null ? undefined : yield* decodeObject(row.search);
        const drain = row.drained === null ? undefined : yield* decodeObject(row.drained);
        if (
          search === undefined ||
          search.queryId !== query.id ||
          search.ownerSha256 !== projectMemoryHash(owner) ||
          searched.queryId !== query.id ||
          searched.requestId !== search.requestId ||
          searched.intentSha256 !== projectMemoryHash(search) ||
          (searched.transportDrained !== true &&
            (drain?.transportDrained !== true ||
              drain.queryId !== query.id ||
              drain.requestId !== search.requestId ||
              drain.intentSha256 !== projectMemoryHash(search) ||
              drain.resultSha256 !== projectMemoryHash(searched)))
        )
          return yield* deny("Retained semantic search has no exact drain proof");
      }
      owners.set(query.id, owner);
    }
    for (const model of models) {
      if (model.id === null || model.bytes > 524288)
        return yield* deny("Retained model accounting exceeds its bound");
      const rows = yield* sql<{
        reservation: string;
        settlement: string | null;
        capacity: string;
        status: string;
        receipt: string | null;
        environment: string;
        project: string;
        root: string;
        binding: string;
        attempt: string;
        worker: string;
        generation: number;
        operation: string;
        request: number;
        scope: string;
        route: string;
        provider: string;
        model: string;
        maximumInput: number;
        maximumOutput: number;
        deadline: number;
        input: number;
        output: number;
      }>`SELECT
      reservation_json AS reservation,settlement_json AS settlement,capacity_state AS capacity,status,
      accounting_receipt_id AS receipt,environment_id AS environment,project_id AS project,
      root_task_id AS root,run_id AS binding,attempt_id AS attempt,worker_id AS worker,generation,
      operation_id AS operation,request_id AS request,request_scope AS scope,route_id AS route,provider,model,
      maximum_input_tokens AS maximumInput,maximum_output_tokens AS maximumOutput,deadline_at_ms AS deadline,
      charged_input_tokens AS input,charged_output_tokens AS output FROM project_team_model_request
      WHERE project_id=${projectId} AND reservation_id=${model.id} AND request_lane='memory' LIMIT 2`;
      const row = rows[0];
      if (rows.length !== 1 || row === undefined || row.settlement === null || row.receipt === null)
        return yield* deny("Retained model accounting lacks its settlement");
      const reservation = yield* decodeReservation(row.reservation);
      const settlement = yield* decodeSettlement(row.settlement);
      const {
        reservationId,
        outcome,
        chargedInputTokens,
        chargedOutputTokens,
        transportDrained,
        reportedModel: _model,
        reportedInputTokens: _input,
        reportedOutputTokens: _output,
        ...original
      } = settlement;
      const owner = owners.get(reservation.effectId);
      if (
        owner === undefined ||
        owner.version !== reservation.version ||
        reservation.ownerSha256 !== projectMemoryHash(owner) ||
        owner.operation.environmentId !== row.environment ||
        owner.operation.projectId !== row.project ||
        owner.operation.rootTaskId !== row.root ||
        owner.operation.bindingId !== row.binding ||
        owner.operation.attemptId !== row.attempt ||
        owner.operation.workerId !== row.worker ||
        owner.operation.operationId !== row.operation ||
        owner.operation.generation !== row.generation ||
        reservation.workerId !== row.worker ||
        reservation.operationId !== row.operation ||
        reservation.generation !== row.generation ||
        reservation.requestId !== row.request ||
        reservation.scope !== row.scope ||
        reservation.routeId !== row.route ||
        reservation.provider !== row.provider ||
        reservation.model !== row.model ||
        reservation.maxInputTokens !== row.maximumInput ||
        reservation.maxOutputTokens !== row.maximumOutput ||
        reservation.deadlineAtMs !== row.deadline ||
        reservation.deadlineAtMs >
          Math.min(
            owner.operation.operationDeadlineAtMs,
            owner.operation.attemptDeadlineAtMs,
            owner.operation.rootDeadlineAtMs,
            owner.operation.leaseDeadlineAtMs,
          ) ||
        reservation.maxInputTokens + reservation.maxOutputTokens >
          owner.operation.operationMaximumTokens ||
        reservationId !== model.id ||
        !equal(reservation, original) ||
        outcome !== row.status ||
        chargedInputTokens !== row.input ||
        chargedOutputTokens !== row.output ||
        !transportDrained ||
        row.capacity !== "released"
      )
        return yield* deny("Retained model settlement changed its original owner or drain");
      if (
        outcome === "reported"
          ? settlement.reportedInputTokens !== chargedInputTokens ||
            settlement.reportedOutputTokens !== chargedOutputTokens ||
            chargedInputTokens > reservation.maxInputTokens ||
            chargedOutputTokens > reservation.maxOutputTokens
          : chargedInputTokens !== reservation.maxInputTokens ||
            chargedOutputTokens !== reservation.maxOutputTokens
      )
        return yield* deny("Retained model settlement changed its original charges");
      if (reservation.version === 2) {
        const embedded = embeddedReceipts.get(reservation.effectId);
        if (
          embedded === undefined ||
          embedded.reservationId !== model.id ||
          embedded.reservationSha256 !== projectMemoryHash(reservation) ||
          embedded.accountingReceiptId !== row.receipt ||
          embedded.outcome !== outcome
        )
          return yield* deny("Retained query embedding has no identical accounting receipt");
        embeddedReceipts.delete(reservation.effectId);
      }
    }
    if (embeddedReceipts.size !== 0)
      return yield* deny("Retained query has orphan embedding accounting");
  },
);

/** Settings commits the lifecycle purge before sending the legacy projection event.
 * This recognizes that exact retained transition; it grants no post-purge cleanup authority.
 */
export const readProjectMemoryProjectionSyncInTransaction = Effect.fn(
  "readProjectMemoryProjectionSyncInTransaction",
)(
  function* (sql: SqlClient.SqlClient, projectId: string, environmentId: string | undefined) {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* deny("Projection synchronization requires the owning transaction");
    const exists =
      yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='project_lifecycle'`;
    if (exists.length === 0) return false;
    const metadata = yield* sql<{ state: string; bytes: number }>`SELECT state,
    length(CAST(tombstone_json AS BLOB)) AS bytes FROM project_lifecycle WHERE project_id=${projectId} LIMIT 2`;
    if (metadata.length === 0 || metadata[0]?.state !== "tombstoned") return false;
    if (
      metadata.length !== 1 ||
      environmentId === undefined ||
      !Number.isSafeInteger(metadata[0]?.bytes) ||
      (metadata[0]?.bytes ?? 65537) > 65536
    )
      return yield* deny("Recorded project deletion is missing or exceeds its bound");
    const rows = yield* sql<{
      path: string;
      revision: number;
      at: string;
      tombstone: string;
    }>`SELECT
    workspace_root AS path,revision,changed_at AS at,tombstone_json AS tombstone
    FROM project_lifecycle WHERE project_id=${projectId} LIMIT 2`;
    const row = rows[0];
    if (row === undefined || rows.length !== 1)
      return yield* deny("Recorded project deletion changed");
    const tombstone = yield* decodeTombstone(row.tombstone);
    if (
      tombstone.projectId !== projectId ||
      tombstone.environmentId !== environmentId ||
      tombstone.reason !== "permanent-local-delete" ||
      tombstone.workspaceRoot !== row.path ||
      tombstone.tombstonedAt !== row.at
    )
      return yield* deny("Recorded deletion does not match this host and project");
    const projection = yield* sql<{
      path: string;
    }>`SELECT workspace_root AS path FROM projection_projects
    WHERE project_id=${projectId} AND deleted_at IS NULL LIMIT 2`;
    if (projection.length !== 1 || projection[0]?.path !== row.path)
      return yield* deny("Projection synchronization changed the deleted project path");
    const operations = yield* sql<{ id: string; bytes: number }>`SELECT command_id AS id,
    length(CAST(result_json AS BLOB)) AS bytes FROM project_lifecycle_operations
    WHERE project_id=${projectId} AND operation='permanent-local-delete' ORDER BY command_id LIMIT 2`;
    if (
      operations.length !== 1 ||
      !Number.isSafeInteger(operations[0]?.bytes) ||
      (operations[0]?.bytes ?? 65537) > 65536
    )
      return yield* deny("Recorded deletion lacks one bounded original result");
    const saved = yield* sql<{ id: string; fingerprint: string; result: string; at: string }>`SELECT
    command_id AS id,request_fingerprint AS fingerprint,result_json AS result,created_at AS at
    FROM project_lifecycle_operations WHERE project_id=${projectId} AND operation='permanent-local-delete' LIMIT 2`;
    const operation = saved[0];
    if (saved.length !== 1 || operation === undefined || operation.id !== operations[0]?.id)
      return yield* deny("Recorded deletion receipt changed");
    const input = yield* decodeLifecycleInput({
      commandId: operation.id,
      projectId,
      workspaceRoot: row.path,
      confirmation: "permanent-local-delete",
    });
    const result = yield* decodeLifecycleResult(operation.result);
    if (
      operation.fingerprint !== projectWorkPayloadFingerprint(input) ||
      operation.at !== row.at ||
      result.project.projectId !== projectId ||
      result.project.environmentId !== environmentId ||
      result.project.state !== "tombstoned" ||
      result.project.workspaceRoot !== row.path ||
      result.project.revision !== row.revision ||
      result.project.changedAt !== row.at ||
      !equal(result.tombstone, tombstone)
    )
      return yield* deny("Recorded deletion result does not cover this exact transition");
    for (const table of domainTables) {
      const residual =
        yield* sql`SELECT project_id FROM ${sql(table)} WHERE project_id=${projectId} LIMIT 1`;
      if (residual.length !== 0)
        return yield* deny("Project deletion left residual domain authority");
    }
    if (
      (yield* sql`SELECT projector FROM project_work_projection_state
    WHERE projector=${"project-work:" + projectId} LIMIT 1`).length !== 0
    )
      return yield* deny("Project deletion left a residual work checkpoint");
    yield* auditRetainedProjectionJournals(sql, projectId, environmentId);
    return true;
  },
  Effect.mapError((error) =>
    isServiceError(error)
      ? error
      : deny("Recorded deletion cannot authorize projection synchronization"),
  ),
);

/** Both deletion entry points call this before changing project authority. It never funds cleanup. */
export const assertProjectMemoryDeletionReadyInTransaction = Effect.fn(
  "assertProjectMemoryDeletionReadyInTransaction",
)(
  function* (sql: SqlClient.SqlClient, projectId: string, environmentId: string | undefined) {
    const currentSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (
      Option.isNone(currentSql) ||
      currentSql.value !== sql ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* deny("Memory deletion requires its original owning transaction");
    let bytes = 0;
    const records = new Map<string, ReadonlyArray<{ recordId: string; bytes: number }>>();
    for (const kind of ["source", "extraction", "observation"]) {
      const rows = yield* sql<{ recordId: string; bytes: number }>`SELECT record_id AS recordId,
      length(CAST(payload_json AS BLOB)) AS bytes FROM ${sql(`project_team_memory_${kind}`)}
      WHERE project_id=${projectId} ORDER BY record_id LIMIT 257`;
      if (
        rows.length > 256 ||
        rows.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 262144)
      )
        return yield* deny("Retained memory exceeds the bounded deletion audit");
      bytes += rows.reduce((total, row) => total + row.bytes, 0);
      records.set(kind, rows);
    }
    const jobs = yield* sql<{
      effectId: string;
      bytes: number;
      status: string;
      ownerBytes: number | null;
    }>`SELECT
    effect_id AS effectId,status,length(CAST(owner_json AS BLOB)) AS ownerBytes,
    length(CAST(input_json AS BLOB))+COALESCE(length(CAST(receipt_json AS BLOB)),0)+
    COALESCE(length(CAST(owner_json AS BLOB)),0) AS bytes FROM project_team_memory_job
    WHERE project_id=${projectId} ORDER BY effect_id LIMIT 257`;
    const queries = yield* sql<{ queryId: string; bytes: number }>`SELECT query_id AS queryId,
    length(CAST(owner_json AS BLOB)) AS bytes FROM project_team_memory_query
    WHERE project_id=${projectId} ORDER BY query_id LIMIT 257`;
    const manifests = yield* sql<{
      sourceId: string;
      sourceRevision: number;
      sourceGeneration: number;
      bytes: number;
    }>`SELECT source_id AS sourceId,source_revision AS sourceRevision,source_generation AS sourceGeneration,
    length(CAST(manifest_json AS BLOB)) AS bytes FROM project_team_memory_manifest
    WHERE project_id=${projectId} ORDER BY extraction_id LIMIT 257`;
    const outcomes = yield* sql<{ effectId: string }>`SELECT effect_id AS effectId
    FROM project_team_memory_outcome WHERE project_id=${projectId} ORDER BY effect_id LIMIT 257`;
    const modelRows = yield* sql<{
      environmentId: string | null;
      projectId: string | null;
      rootTaskId: string | null;
      bindingId: string | null;
      attemptId: string | null;
      workerId: string | null;
      generation: number;
      operationId: string | null;
      bytes: number;
    }>`SELECT
    CASE WHEN length(CAST(environment_id AS BLOB))<=1024 THEN environment_id END AS environmentId,
    CASE WHEN length(CAST(project_id AS BLOB))<=1024 THEN project_id END AS projectId,
    CASE WHEN length(CAST(root_task_id AS BLOB))<=1024 THEN root_task_id END AS rootTaskId,
    CASE WHEN length(CAST(run_id AS BLOB))<=1024 THEN run_id END AS bindingId,
    CASE WHEN length(CAST(attempt_id AS BLOB))<=1024 THEN attempt_id END AS attemptId,
    CASE WHEN length(CAST(worker_id AS BLOB))<=1024 THEN worker_id END AS workerId,generation,
    CASE WHEN length(CAST(operation_id AS BLOB))<=1024 THEN operation_id END AS operationId,
    length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+length(CAST(root_task_id AS BLOB))+
    length(CAST(run_id AS BLOB))+length(CAST(attempt_id AS BLOB))+length(CAST(worker_id AS BLOB))+
    length(CAST(operation_id AS BLOB)) AS bytes
    FROM project_team_model_request WHERE project_id=${projectId} AND request_lane='memory'
    ORDER BY reservation_id LIMIT 257`;
    if (
      jobs.length > 256 ||
      queries.length > 256 ||
      manifests.length > 256 ||
      outcomes.length > 256 ||
      modelRows.length > 256 ||
      modelRows.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 7168) ||
      jobs.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 786432) ||
      jobs.some(
        (row) =>
          row.ownerBytes !== null &&
          (!Number.isSafeInteger(row.ownerBytes) || row.ownerBytes > 262144),
      ) ||
      queries.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 262144) ||
      manifests.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 4194304)
    )
      return yield* deny("Memory cleanup history exceeds its bounded deletion audit");
    bytes += [...jobs, ...queries, ...manifests, ...modelRows].reduce(
      (total, row) => total + row.bytes,
      0,
    );
    if (bytes > 4194304) return yield* deny("Memory cleanup history exceeds its byte allowance");
    const sources = records.get("source") ?? [];
    const recordedMemory = yield* sql`SELECT event_id FROM project_work_events
    WHERE project_id=${projectId} AND event_type='project-work.foundation.recorded'
    AND (json_extract(payload_json,'$.record.kind') IN ('memory-source','memory-extraction','memory-observation')
      OR json_extract(payload_json,'$.record.effectKind') IN ('memory-index','memory-delete')) LIMIT 1`;
    // The authority reader can retain foundation records from a valid checkpoint
    // even when their original rows are missing. Inspect presence without
    // transferring its body or imposing memory history limits on ordinary work.
    const checkpointMemory = yield* sql`SELECT project_id FROM project_work_reducer_checkpoints
      WHERE project_id=${projectId} AND CASE WHEN json_valid(state_json) THEN
        CASE WHEN json_extract(state_json,'$.checkpointVersion')=${PROJECT_WORK_CHECKPOINT_VERSION}
          AND json_extract(state_json,'$.projectId')=${projectId}
          AND json_type(state_json,'$.tasks')='array' THEN EXISTS (
            SELECT 1 FROM json_each(state_json,'$.foundationRecords') AS record
            WHERE CASE WHEN record.type='object' THEN
              json_extract(record.value,'$.kind') IN ('memory-source','memory-extraction','memory-observation')
              OR json_extract(record.value,'$.effectKind') IN ('memory-index','memory-delete')
            ELSE 0 END
          ) ELSE 0 END
        ELSE 0 END LIMIT 1`;
    if (
      sources.length === 0 &&
      jobs.length === 0 &&
      queries.length === 0 &&
      manifests.length === 0 &&
      outcomes.length === 0 &&
      modelRows.length === 0 &&
      recordedMemory.length === 0 &&
      checkpointMemory.length === 0 &&
      [...records.values()].every((rows) => rows.length === 0)
    )
      return;
    const eventMetadata = yield* sql<{
      bytes: number;
    }>`SELECT length(CAST(payload_json AS BLOB)) AS bytes
    FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence LIMIT 8193`;
    if (
      eventMetadata.length > 8192 ||
      eventMetadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 1048576) ||
      eventMetadata.reduce((total, row) => total + row.bytes, 0) > 16777216
    )
      return yield* deny("Original memory authority history exceeds its audit bound");
    if (environmentId === undefined)
      return yield* deny("Memory deletion lacks the current host identity");
    if (sources.length === 0 && (recordedMemory.length > 0 || checkpointMemory.length > 0))
      return yield* deny("Recorded memory authority has missing physical sources");
    const checkpoint = yield* sql<{
      bytes: number;
    }>`SELECT length(CAST(state_json AS BLOB)) AS bytes
    FROM project_work_reducer_checkpoints WHERE project_id=${projectId} LIMIT 2`;
    if (
      checkpoint.length > 1 ||
      checkpoint.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 16777216) ||
      checkpoint.reduce((total, row) => total + row.bytes, 0) +
        eventMetadata.reduce((total, row) => total + row.bytes, 0) >
        16777216
    )
      return yield* deny("Memory authority checkpoint exceeds its bounded audit");
    const state = yield* readCurrentState(sql, projectId);
    for (const [kind, physical] of records) {
      const retained = (state.foundationRecords ?? []).filter(
        (record) => record.kind === `memory-${kind}`,
      );
      if (
        retained.length !== physical.length ||
        retained.some((record) => !physical.some((row) => row.recordId === record.recordId))
      )
        return yield* deny("Memory foundation and physical storage disagree");
    }
    const auditedOperations = new Set<string>();
    const auditOperation = Effect.fn("ProjectMemoryProjectDeletion.auditOperation")(function* (
      operation: typeof ProjectMemoryJobOwner.Type.operation,
    ) {
      if (operation.projectId !== projectId || operation.environmentId !== environmentId)
        return yield* deny("Memory cleanup owner belongs to another project or host");
      const key = canonicalProjectWorkPayload([
        operation.environmentId,
        operation.projectId,
        operation.rootTaskId,
        operation.bindingId,
        operation.attemptId,
        operation.workerId,
        operation.generation,
        operation.operationId,
      ]);
      if (auditedOperations.has(key)) return;
      const ledger = yield* auditProjectMemoryOperationLedger(sql, operation);
      if (!ledger.settled)
        return yield* deny("Memory cleanup still has pending or undrained stages");
      auditedOperations.add(key);
    });
    const deleteCoverage = new Set<string>();
    const indexedSources: Array<typeof ProjectMemoryJobInput.Type> = [];
    const deletedSources = new Map<string, typeof ProjectMemorySource.Type>();
    for (const job of jobs) {
      const rows = yield* sql<{
        sourceId: string;
        kind: string;
        owner: string | null;
        input: string;
      }>`SELECT
      json_extract(input_json,'$.source.recordId') AS sourceId,
      json_extract(input_json,'$.effect.effectKind') AS kind,owner_json AS owner,input_json AS input
      FROM project_team_memory_job WHERE effect_id=${job.effectId} AND length(CAST(input_json AS BLOB))<=262144`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        !sources.some((source) => source.recordId === row.sourceId)
      )
        return yield* deny("Memory job has no retained source authority");
      const input = yield* decodeJob(row.input);
      if (
        input.projectId !== projectId ||
        input.environmentId !== environmentId ||
        input.effect.effectId !== job.effectId ||
        input.effect.recordId !== job.effectId ||
        input.effect.projectId !== projectId ||
        input.effect.effectKind !== row.kind ||
        input.effect.targetId !== input.source.recordId ||
        input.source.projectId !== projectId ||
        input.effect.payload.recordIds[0] !== input.source.recordId ||
        input.effect.payload.expectedRevision !== input.source.sourceRevision ||
        input.effect.generation !== input.source.generation ||
        input.source.contentHash !== projectMemoryHash(input.source.content)
      )
        return yield* deny("Retained memory intent changed its original source tuple");
      if (row.owner !== null) {
        if (!Number.isSafeInteger(job.ownerBytes) || (job.ownerBytes ?? 262145) > 262144)
          return yield* deny("Memory cleanup owner exceeds its bound");
        const owner = yield* decodeOwner(row.owner);
        yield* auditProjectMemoryAdmission(sql, owner);
        yield* auditOperation(owner.operation);
      }
      if (row.kind === "memory-delete") {
        if (row.owner === null || job.status !== "settled")
          return yield* deny("Memory source cleanup is still waiting");
        const proof = yield* readProjectMemoryCompletedDeletionInTransaction(
          sql,
          environmentId,
          job.effectId,
        );
        if (proof.input.projectId !== projectId)
          return yield* deny("Memory cleanup receipt is foreign");
        const sourceRows = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM project_team_memory_source
        WHERE project_id=${projectId} AND record_id=${proof.receipt.sourceId} AND length(CAST(payload_json AS BLOB))<=262144`;
        const savedSource = sourceRows[0];
        if (sourceRows.length !== 1 || savedSource === undefined)
          return yield* deny("Memory cleanup source changed");
        const source = yield* decodeSource(savedSource.payload);
        if (
          source.status === "current" ||
          source.status === "conflicted" ||
          source.sourceRevision !== proof.receipt.sourceRevision ||
          source.generation !== proof.receipt.sourceGeneration ||
          !equal(
            source,
            state.foundationRecords?.find((record) => record.recordId === source.recordId),
          )
        )
          return yield* deny("Memory cleanup does not cover the latest retained source generation");
        deleteCoverage.add(source.recordId);
        deletedSources.set(source.recordId, source);
      } else if (row.kind === "memory-index") {
        if (
          input.source.status !== "current" ||
          input.extraction === undefined ||
          input.effect.payload.recordIds.length !== 2 ||
          input.effect.payload.recordIds[1] !== input.extraction.recordId ||
          input.extraction.projectId !== projectId ||
          input.extraction.sourceId !== input.source.recordId ||
          input.extraction.sourceRevision !== input.source.sourceRevision ||
          input.extraction.sourceGeneration !== input.source.generation
        )
          return yield* deny("Retained index intent has a corrupt source or extraction tuple");
        indexedSources.push(input);
      } else return yield* deny("Unknown retained memory job kind");
    }
    if (
      indexedSources.some((input) => {
        const deleted = deletedSources.get(input.source.recordId);
        return (
          deleted === undefined ||
          deleted.sourceRevision !== input.source.sourceRevision ||
          deleted.generation <= input.source.generation
        );
      })
    )
      return yield* deny("Completed source deletion does not fence retained index intents");
    if (
      sources.some((source) => !deleteCoverage.has(source.recordId)) ||
      manifests.some((manifest) => {
        const deleted = deletedSources.get(manifest.sourceId);
        return (
          deleted === undefined ||
          deleted.sourceRevision !== manifest.sourceRevision ||
          deleted.generation <= manifest.sourceGeneration
        );
      }) ||
      outcomes.some((outcome) => !jobs.some((job) => job.effectId === outcome.effectId))
    )
      return yield* deny("Retained memory lacks complete authenticated source cleanup");
    for (const query of queries) {
      const owner = yield* readProjectMemoryQueryOwnerById(sql, query.queryId);
      if (owner.request.projectId !== projectId || owner.operation.environmentId !== environmentId)
        return yield* deny("Memory query belongs to another project or host");
      yield* auditOperation(owner.operation);
    }
    if (
      modelRows.some(
        (row) =>
          !auditedOperations.has(
            canonicalProjectWorkPayload([
              row.environmentId,
              row.projectId,
              row.rootTaskId,
              row.bindingId,
              row.attemptId,
              row.workerId,
              row.generation,
              row.operationId,
            ]),
          ),
      )
    )
      return yield* deny("Orphan memory accounting cannot establish drained cleanup");
    for (const kind of ["extraction", "observation"]) {
      const rows = yield* sql<{
        sourceId: string;
      }>`SELECT json_extract(payload_json,'$.sourceId') AS sourceId
      FROM ${sql(`project_team_memory_${kind}`)} WHERE project_id=${projectId} LIMIT 257`;
      if (rows.some((row) => !deleteCoverage.has(row.sourceId)))
        return yield* deny("Memory derivations lack covered source cleanup");
    }
  },
  Effect.mapError((error) =>
    isServiceError(error) ? error : deny("Retained memory cleanup cannot be authenticated"),
  ),
);
