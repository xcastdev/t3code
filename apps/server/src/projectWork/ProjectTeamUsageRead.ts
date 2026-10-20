import {
  ProjectId,
  ProjectTeamRunBinding,
  type ProjectTeamBindingAccounting,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isPiBrokerManagedModel, piBrokerModelRoute } from "../provider/pi/PiManagedModels.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProjectTeamAuthorization } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamPiOperations,
  type ProjectTeamPiUsageHistory,
} from "./ProjectTeamPiOperations.ts";
import {
  auditProjectTeamRecordedPiModelRow,
  decodeProjectTeamRecordedModelRow,
} from "./ProjectTeamModelAccounting.ts";
import { auditProjectMemoryOperationLedger } from "./memory/ProjectMemoryModelAccounting.ts";

type BindingSelection = {
  readonly recordId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly generation: number;
};
class ProjectTeamUsageReadError extends Schema.TaggedError<ProjectTeamUsageReadError>()(
  "ProjectTeamUsageReadError",
  { reason: Schema.String },
) {}
type UnavailableReason = Extract<
  ProjectTeamBindingAccounting,
  { availability: "unavailable" }
>["reason"];
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRunBinding), {
  onExcessProperty: "error",
});
type ModelRow = Effect.Success<ReturnType<typeof decodeProjectTeamRecordedModelRow>>;
const recordedUsage = (
  rows: readonly ModelRow[],
  maximumTokens: number,
  deadlineAtMs: number,
  stoppedReason?: "threshold-reached" | "unknown-usage",
  monitoredGrant = false,
) => {
  const monitored = monitoredGrant;
  let hardUsedTokens = 0;
  let chargedTokens = 0;
  let reservedTokens = 0;
  let unknownChargedTokens = 0;
  let heldCalls = 0;
  let quarantinedCalls = 0;
  for (const row of rows) {
    chargedTokens += row.charged_input_tokens + row.charged_output_tokens;
    if (row.accounting_mode === "hard")
      hardUsedTokens +=
        row.status === "held"
          ? row.maximum_input_tokens + row.maximum_output_tokens
          : row.charged_input_tokens + row.charged_output_tokens;
    if (row.status === "held")
      reservedTokens += row.maximum_input_tokens + row.maximum_output_tokens;
    else if (row.status !== "reported")
      unknownChargedTokens += row.charged_input_tokens + row.charged_output_tokens;
    if (row.capacity_state === "held") heldCalls++;
    if (row.capacity_state === "quarantine") quarantinedCalls++;
    if (
      [
        hardUsedTokens,
        chargedTokens,
        reservedTokens,
        unknownChargedTokens,
        heldCalls,
        quarantinedCalls,
      ].some((value) => !Number.isSafeInteger(value))
    )
      return undefined;
  }
  const total = chargedTokens + reservedTokens;
  if (
    !Number.isSafeInteger(total) ||
    hardUsedTokens > maximumTokens ||
    (!monitored && total > maximumTokens)
  )
    return undefined;
  return {
    maximumTokens,
    deadlineAtMs,
    chargedTokens,
    reservedTokens,
    unknownChargedTokens,
    remainingTokens: Math.max(0, maximumTokens - (monitored ? chargedTokens : total)),
    heldCalls,
    quarantinedCalls,
    ...(monitored
      ? {
          policy: {
            accountingMode: "openai-subscription-monitored" as const,
            thresholdTokens: 64_000 as const,
            observedChargedTokens: chargedTokens,
            nominalHeldTokens: reservedTokens,
            ...(stoppedReason === undefined ? {} : { stoppedReason }),
          },
        }
      : {}),
  };
};

/** Optional accounting metadata belongs to the caller's snapshot, never to command authority. */
export const readProjectTeamBindingAccountingInTransaction = Effect.fn("ProjectTeamUsage.read")(
  function* (sql: SqlClient.SqlClient, projectId: string, bindings: readonly BindingSelection[]) {
    if (bindings.length === 0 || bindings.length > 128) return [];
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const host = yield* Effect.serviceOption(ServerEnvironmentIdentity);
    const environmentId = Option.isSome(host) ? yield* host.value.getEnvironmentId : undefined;
    const identity = (binding: BindingSelection) => ({
      projectId: ProjectId.make(projectId),
      ...(environmentId === undefined ? {} : { environmentId }),
      bindingId: binding.recordId,
      generation: binding.generation,
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      observedAt,
    });
    const unavailable = (
      binding: BindingSelection,
      reason: UnavailableReason,
    ): ProjectTeamBindingAccounting => ({
      ...identity(binding),
      availability: "unavailable",
      reason,
    });
    const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (environmentId === undefined)
      return bindings.map((binding) => unavailable(binding, "host-unavailable"));
    if (
      Option.isNone(suppliedSql) ||
      suppliedSql.value !== sql ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return bindings.map((binding) => unavailable(binding, "journal-unavailable"));
    const ids = bindings.map((binding) => binding.recordId);
    const read = yield* Effect.gen(function* () {
      const metadata = yield* sql<{
        id: string;
        bytes: number;
        valid: number;
      }>`SELECT record_id AS id,
        length(CAST(payload_json AS BLOB)) + length(CAST(record_id AS BLOB))
          + length(CAST(generation AS BLOB))
          + COALESCE(length(CAST(task_id AS BLOB)),0)
          + COALESCE(length(CAST(attempt_id AS BLOB)),0) AS bytes,
        CASE WHEN typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991
          AND typeof(task_id)='text' AND length(CAST(task_id AS BLOB)) BETWEEN 1 AND 1024
          AND typeof(attempt_id)='text' AND length(CAST(attempt_id AS BLOB)) BETWEEN 1 AND 1024
          THEN 1 ELSE 0 END AS valid FROM project_team_run_binding
        WHERE project_id=${projectId} AND ${sql.in("record_id", ids)} LIMIT 129`;
      if (
        metadata.length > 128 ||
        metadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 1048576) ||
        metadata.reduce((total, row) => total + row.bytes, 0) > 4194304
      )
        return bindings.map((binding) => unavailable(binding, "read-bound"));
      if (metadata.some((row) => row.valid !== 1))
        return bindings.map((binding) => unavailable(binding, "owner-invalid"));
      const rows = yield* sql<{
        id: string;
        generation: number;
        taskId: string | null;
        attemptId: string | null;
        payload: string;
      }>`SELECT record_id AS id,generation,task_id AS taskId,attempt_id AS attemptId,payload_json AS payload
        FROM project_team_run_binding WHERE project_id=${projectId} AND ${sql.in("record_id", ids)} LIMIT 129`;
      // Presence is not admission. A budget row or mutable configuration alone
      // cannot establish original ceilings; retained history must be qualified.
      const journals = yield* sql<{ id: string }>`SELECT binding_id AS id FROM project_team_dispatch
        WHERE project_id=${projectId} AND ${sql.in("binding_id", ids)}
        UNION SELECT binding_id AS id FROM project_team_pi_operation
        WHERE project_id=${projectId} AND ${sql.in("binding_id", ids)}
        UNION SELECT run_id AS id FROM project_team_model_request
        WHERE project_id=${projectId} AND ${sql.in("run_id", ids)} LIMIT 129`;
      const authorization = yield* Effect.serviceOption(ProjectTeamAuthorization);
      const repository = yield* Effect.serviceOption(ProjectWorkRepository);
      // Bound retained authority before its existing historical readers load bodies.
      const historyMetadata =
        journals.length === 0
          ? []
          : yield* sql<{ bytes: number }>`SELECT
        length(CAST(payload_json AS BLOB))+length(CAST(event_id AS BLOB))+
        length(CAST(project_id AS BLOB))+length(CAST(command_id AS BLOB))+
        length(CAST(event_type AS BLOB))+length(CAST(occurred_at AS BLOB))+
        length(CAST(sequence AS BLOB)) AS bytes FROM project_work_events
        WHERE project_id=${projectId} LIMIT 8193`;
      const historyBound =
        historyMetadata.length <= 8192 &&
        historyMetadata.every((row) => Number.isSafeInteger(row.bytes) && row.bytes <= 1048576) &&
        historyMetadata.reduce((total, row) => total + row.bytes, 0) <= 4194304;
      const checkpointMetadata =
        journals.length === 0
          ? []
          : yield* sql<{ bytes: number }>`SELECT
        length(CAST(state_json AS BLOB))+length(CAST(last_sequence AS BLOB)) AS bytes
        FROM project_work_reducer_checkpoints WHERE project_id=${projectId} LIMIT 2`;
      const checkpointBound =
        checkpointMetadata.length <= 1 &&
        checkpointMetadata.every((row) => Number.isSafeInteger(row.bytes) && row.bytes <= 4194304);
      const proofMetadata =
        journals.length === 0
          ? []
          : yield* sql<{ bytes: number }>`SELECT
        length(CAST(dispatch_id AS BLOB))+length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+
        length(CAST(binding_id AS BLOB))+length(CAST(generation AS BLOB))+length(CAST(task_id AS BLOB))+
        length(CAST(attempt_id AS BLOB))+length(CAST(worktree AS BLOB))+length(CAST(branch AS BLOB))+
        length(CAST(root_task_id AS BLOB))+length(CAST(root_maximum_tokens AS BLOB))+
        length(CAST(root_deadline_at_ms AS BLOB))+length(CAST(attempt_maximum_tokens AS BLOB))+
        length(CAST(attempt_deadline_at_ms AS BLOB))+length(CAST(delegation_depth AS BLOB))+
        length(CAST(maximum_delegation_depth AS BLOB))+length(CAST(repair_allowance AS BLOB))+
        length(CAST(stage AS BLOB))+length(CAST(revision AS BLOB))+length(CAST(claim_generation AS BLOB))+
        length(CAST(intent_json AS BLOB))+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB)) AS bytes
        FROM project_team_dispatch WHERE project_id=${projectId}
        UNION ALL SELECT length(CAST(receipt.receipt_id AS BLOB))+length(CAST(receipt.dispatch_id AS BLOB))+
          length(CAST(receipt.revision AS BLOB))+length(CAST(receipt.claim_generation AS BLOB))+
          length(CAST(receipt.stage AS BLOB))+length(CAST(receipt.evidence_json AS BLOB))+length(CAST(receipt.recorded_at AS BLOB))
          FROM project_team_dispatch_receipt receipt JOIN project_team_dispatch dispatch ON dispatch.dispatch_id=receipt.dispatch_id
          WHERE dispatch.project_id=${projectId}
        UNION ALL SELECT length(CAST(command_id AS BLOB))+length(CAST(project_id AS BLOB))+
          length(CAST(payload_fingerprint AS BLOB))+COALESCE(length(CAST(actor_kind AS BLOB)),0)+
          COALESCE(length(CAST(actor_id AS BLOB)),0)+COALESCE(length(CAST(source_kind AS BLOB)),0)+
          COALESCE(length(CAST(source_id AS BLOB)),0)+length(CAST(event_ids_json AS BLOB))+
          COALESCE(length(CAST(result_json AS BLOB)),0)+length(CAST(created_at AS BLOB))
          FROM project_work_command_receipts WHERE project_id=${projectId}
        UNION ALL SELECT length(CAST(record_id AS BLOB))+length(CAST(project_id AS BLOB))+
          length(CAST(status AS BLOB))+length(CAST(revision AS BLOB))+length(CAST(generation AS BLOB))+
          length(CAST(updated_at AS BLOB))+COALESCE(length(CAST(task_id AS BLOB)),0)+
          COALESCE(length(CAST(attempt_id AS BLOB)),0)+COALESCE(length(CAST(member_id AS BLOB)),0)+
          COALESCE(length(CAST(source_id AS BLOB)),0)+COALESCE(length(CAST(scope_key AS BLOB)),0)+
          COALESCE(length(CAST(slot AS BLOB)),0)+COALESCE(length(CAST(unique_key AS BLOB)),0)+
          COALESCE(length(CAST(provider_instance_id AS BLOB)),0)+COALESCE(length(CAST(thread_id AS BLOB)),0)+
          COALESCE(length(CAST(session_id AS BLOB)),0)+length(CAST(payload_json AS BLOB))
          FROM project_team_effect WHERE project_id=${projectId}
        UNION ALL SELECT length(CAST(operation_id AS BLOB))+length(CAST(environment_id AS BLOB))+
          length(CAST(project_id AS BLOB))+length(CAST(binding_id AS BLOB))+length(CAST(generation AS BLOB))+
          length(CAST(provider_instance_id AS BLOB))+length(CAST(thread_id AS BLOB))+length(CAST(worker_id AS BLOB))+
          length(CAST(operation_ordinal AS BLOB))+length(CAST(operation_kind AS BLOB))+length(CAST(request_hash AS BLOB))+
          length(CAST(root_binding_id AS BLOB))+length(CAST(root_task_id AS BLOB))+length(CAST(maximum_tokens AS BLOB))+
          length(CAST(deadline_at_ms AS BLOB))+length(CAST(status AS BLOB))+
          COALESCE(length(CAST(native_json AS BLOB)),0)+COALESCE(length(CAST(terminal_json AS BLOB)),0)+length(CAST(intent_json AS BLOB))
          FROM project_team_pi_operation WHERE project_id=${projectId}
        UNION ALL SELECT length(CAST(process.unit AS BLOB))+length(CAST(process.allocation_json AS BLOB))
          FROM project_team_pi_process process JOIN project_team_pi_operation operation ON operation.operation_id=process.operation_id
          WHERE operation.project_id=${projectId} LIMIT 8193`;
      const proofBound =
        proofMetadata.length <= 8192 &&
        proofMetadata.every((row) => Number.isSafeInteger(row.bytes) && row.bytes <= 1048576) &&
        [...historyMetadata, ...checkpointMetadata, ...proofMetadata].reduce(
          (total, row) => total + row.bytes,
          0,
        ) <= 4194304;
      const allModelMetadata =
        journals.length === 0
          ? []
          : yield* sql<{ rootTaskId: string | null; bytes: number; memory: number }>`SELECT
              CASE WHEN request_lane='memory' THEN 1 ELSE 0 END AS memory,
              CASE WHEN length(CAST(root_task_id AS BLOB))<=1024 THEN root_task_id END AS rootTaskId,
              length(CAST(reservation_id AS BLOB))+length(CAST(environment_id AS BLOB))+
              length(CAST(project_id AS BLOB))+length(CAST(root_task_id AS BLOB))+
              length(CAST(run_id AS BLOB))+length(CAST(attempt_id AS BLOB))+
              length(CAST(worker_id AS BLOB))+length(CAST(generation AS BLOB))+
              length(CAST(operation_id AS BLOB))+length(CAST(request_lane AS BLOB))+
              length(CAST(request_scope AS BLOB))+length(CAST(request_id AS BLOB))+
              length(CAST(route_id AS BLOB))+length(CAST(provider AS BLOB))+length(CAST(model AS BLOB))+
              length(CAST(maximum_input_tokens AS BLOB))+length(CAST(maximum_output_tokens AS BLOB))+
              length(CAST(deadline_at_ms AS BLOB))+length(CAST(status AS BLOB))+length(CAST(capacity_state AS BLOB))+
              length(CAST(charged_input_tokens AS BLOB))+length(CAST(charged_output_tokens AS BLOB))+
              length(CAST(accounting_mode AS BLOB))+COALESCE(length(CAST(unknown_maximum_tokens AS BLOB)),0)+
              COALESCE(length(CAST(accounting_receipt_id AS BLOB)),0)+length(CAST(reservation_json AS BLOB))+
              COALESCE(length(CAST(settlement_json AS BLOB)),0) AS bytes FROM project_team_model_request
              WHERE project_id=${projectId} LIMIT 4097`;
      const modelsBound =
        allModelMetadata.length <= 4096 &&
        allModelMetadata.every(
          (row) => row.rootTaskId !== null && Number.isSafeInteger(row.bytes) && row.bytes <= 32768,
        ) &&
        allModelMetadata.reduce((total, row) => total + row.bytes, 0) <= 4194304;
      // The operation audit caches source owners, but reads query owners in both
      // its reservation and query loops. Bound the whole batch, including the
      // admission/final-receipt rereads, before invoking any of those body reads.
      const memoryMetadata = !allModelMetadata.some((row) => row.memory === 1)
        ? []
        : yield* sql<{
            bytes: number;
            proofReads: number;
          }>`SELECT 2*length(CAST(owner_json AS BLOB))+
          length(CAST(query_id AS BLOB))+length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+
          length(CAST(task_id AS BLOB))+length(CAST(binding_id AS BLOB))+length(CAST(generation AS BLOB))+
          length(CAST(operation_id AS BLOB))+length(CAST(command_id AS BLOB))+length(CAST(status AS BLOB))+
          COALESCE(length(CAST(embedding_json AS BLOB)),0)+COALESCE(length(CAST(embedding_result_json AS BLOB)),0)+
          COALESCE(length(CAST(search_json AS BLOB)),0)+COALESCE(length(CAST(search_result_json AS BLOB)),0)+
          COALESCE(length(CAST(search_drain_json AS BLOB)),0)+COALESCE(length(CAST(result_json AS BLOB)),0) AS bytes,
          3 AS proofReads FROM project_team_memory_query WHERE project_id=${projectId}
        UNION ALL SELECT length(CAST(owner_json AS BLOB))+length(CAST(effect_id AS BLOB))+
          length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB)) AS bytes,
          1 AS proofReads FROM project_team_memory_job WHERE project_id=${projectId} AND owner_json IS NOT NULL
        LIMIT 4097`;
      const memoryProofReads = memoryMetadata.reduce((total, row) => total + row.proofReads, 0);
      const memoryBound =
        memoryMetadata.length <= 4096 &&
        memoryMetadata.every((row) => Number.isSafeInteger(row.bytes) && row.bytes <= 1048576) &&
        memoryMetadata.reduce((total, row) => total + row.bytes, 0) +
          allModelMetadata
            .filter((row) => row.memory === 1)
            .reduce((total, row) => total + row.bytes, 0) +
          [...historyMetadata, ...proofMetadata].reduce((total, row) => total + row.bytes, 0) *
            memoryProofReads <=
          4194304;
      const originalProofs = new Map<
        string,
        ProjectTeamPiUsageHistory & { readonly binding: typeof ProjectTeamRunBinding.Type }
      >();
      let historyAttempted = false;
      const rootModels = new Map<string, readonly ModelRow[]>();
      const modelRootsAttempted = new Set<string>();
      const results: ProjectTeamBindingAccounting[] = [];
      for (const selected of bindings) {
        const physical = rows.filter((row) => row.id === selected.recordId);
        const row = physical[0];
        if (physical.length !== 1 || row === undefined) {
          results.push(unavailable(selected, "owner-invalid"));
          continue;
        }
        const decoded = yield* decodeBinding(row.payload).pipe(Effect.result);
        if (decoded._tag === "Failure") {
          results.push(unavailable(selected, "owner-invalid"));
          continue;
        }
        const binding = decoded.success;
        if (
          binding.projectId !== projectId ||
          binding.environmentId !== environmentId ||
          binding.recordId !== row.id ||
          binding.generation !== row.generation ||
          binding.taskId !== row.taskId ||
          binding.attemptId !== row.attemptId ||
          binding.generation !== selected.generation ||
          binding.taskId !== selected.taskId ||
          binding.attemptId !== selected.attemptId
        ) {
          results.push(unavailable(selected, "owner-invalid"));
          continue;
        }
        if (!journals.some((journal) => journal.id === binding.recordId)) {
          const orphanBudget = yield* sql`SELECT 1 AS present FROM project_team_model_budget
            WHERE project_id=${projectId} AND root_task_id=${binding.taskId} LIMIT 1`;
          results.push(
            orphanBudget.length > 0
              ? unavailable(selected, "budget-invalid")
              : { ...identity(selected), availability: "not-admitted" },
          );
          continue;
        }
        if (!historyBound || !checkpointBound || !proofBound || !modelsBound || !memoryBound) {
          results.push(unavailable(selected, "read-bound"));
          continue;
        }
        if (Option.isNone(authorization) || Option.isNone(repository)) {
          results.push(unavailable(selected, "journal-unavailable"));
          continue;
        }
        const capturedAuthorization = authorization.value;
        const capturedRepository = repository.value;
        const usage = yield* Effect.gen(function* () {
          const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(ProjectTeamAuthorization, capturedAuthorization),
              Effect.provideService(ProjectWorkRepository, capturedRepository),
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          const operations = yield* services(makeProjectTeamPiOperations({ environmentId }));
          const readOriginal = Effect.fn("ProjectTeamUsage.readOriginal")(function* (
            id: string,
            generation: number,
          ) {
            const key = id + ":" + generation;
            const cached = originalProofs.get(key);
            if (cached) return cached;
            if (historyAttempted)
              return yield* new ProjectTeamUsageReadError({
                reason: "Historical owner batch unavailable",
              });
            historyAttempted = true;
            const owners = yield* sql<{
              bindingId: string | null;
              generation: number | null;
            }>`SELECT
              CASE WHEN length(CAST(binding_id AS BLOB))<=1024 THEN binding_id END AS bindingId,
              CASE WHEN typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991 THEN generation END AS generation
              FROM project_team_dispatch WHERE project_id=${projectId}
              UNION SELECT CASE WHEN length(CAST(binding_id AS BLOB))<=1024 THEN binding_id END,
                CASE WHEN typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991 THEN generation END
                FROM project_team_pi_operation WHERE project_id=${projectId} LIMIT 129`;
            if (
              owners.length === 0 ||
              owners.length > 128 ||
              owners.some((owner) => owner.bindingId === null || owner.generation === null)
            )
              return yield* new ProjectTeamUsageReadError({
                reason: "Historical owner batch unavailable",
              });
            const identities = owners.flatMap((owner) =>
              owner.bindingId === null || owner.generation === null
                ? []
                : [{ bindingId: owner.bindingId, generation: owner.generation }],
            );
            const proofs = yield* services(
              operations.readUsageHistoryBatchInTransaction(projectId, identities),
            );
            for (const proof of proofs) {
              // These intents have just passed the historical reader's owner,
              // hash and allocation audit. Mutable binding rows are not grants.
              let owners = yield* sql<{ payload: string | null }>`SELECT
                json_extract(intent_json,'$.binding') AS payload
                FROM project_team_pi_operation WHERE project_id=${projectId}
                AND binding_id=${proof.bindingId} AND generation=${proof.generation}
                ORDER BY operation_ordinal LIMIT 1`;
              if (owners.length === 0)
                owners = yield* sql<{ payload: string | null }>`SELECT
                  json_extract(intent_json,'$.compiledClaim.transition.binding') AS payload
                  FROM project_team_dispatch WHERE project_id=${projectId}
                  AND binding_id=${proof.bindingId} AND generation=${proof.generation} LIMIT 2`;
              if (owners.length !== 1 || owners[0]?.payload == null)
                return yield* new ProjectTeamUsageReadError({
                  reason: "Historical binding unavailable",
                });
              const ownerBinding = yield* decodeBinding(owners[0].payload);
              if (
                ownerBinding.recordId !== proof.bindingId ||
                ownerBinding.generation !== proof.generation ||
                ownerBinding.projectId !== projectId ||
                ownerBinding.environmentId !== environmentId ||
                ownerBinding.taskId !== proof.taskId ||
                ownerBinding.attemptId !== proof.attemptId
              )
                return yield* new ProjectTeamUsageReadError({
                  reason: "Historical binding owner differs",
                });
              originalProofs.set(proof.bindingId + ":" + proof.generation, {
                ...proof,
                binding: ownerBinding,
              });
            }
            const proof = originalProofs.get(key);
            if (proof === undefined)
              return yield* new ProjectTeamUsageReadError({
                reason: "Historical owner missing from batch",
              });
            return proof;
          });
          const original = yield* readOriginal(binding.recordId, binding.generation);
          const members = yield* sql<{ bindingId: string | null; generation: number | null }>`SELECT
            CASE WHEN length(CAST(binding_id AS BLOB))<=1024 THEN binding_id END AS bindingId,
            CASE WHEN typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991 THEN generation END AS generation
            FROM project_team_dispatch WHERE project_id=${projectId} AND root_task_id=${original.rootTaskId}
            UNION SELECT CASE WHEN length(CAST(binding_id AS BLOB))<=1024 THEN binding_id END,
              CASE WHEN typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991 THEN generation END
              FROM project_team_pi_operation WHERE project_id=${projectId} AND root_task_id=${original.rootTaskId} LIMIT 129`;
          if (members.length > 128) return unavailable(selected, "read-bound");
          for (const member of members) {
            if (member.bindingId === null || member.generation === null)
              return unavailable(selected, "owner-invalid");
            const proof = yield* readOriginal(member.bindingId, member.generation);
            if (
              proof.rootTaskId !== original.rootTaskId ||
              proof.rootMaximumTokens !== original.rootMaximumTokens ||
              proof.rootDeadlineAtMs !== original.rootDeadlineAtMs
            )
              return unavailable(selected, "budget-invalid");
          }
          const anchors = yield* sql<{ bindingId: string }>`SELECT root_binding_id AS bindingId
            FROM project_team_pi_operation WHERE project_id=${projectId}
            AND root_task_id=${original.rootTaskId} ORDER BY rowid LIMIT 1`;
          const rootOwners =
            anchors.length > 0
              ? anchors
              : yield* sql<{ bindingId: string }>`SELECT binding_id AS bindingId
            FROM project_team_dispatch WHERE project_id=${projectId}
            AND root_task_id=${original.rootTaskId} AND task_id=${original.rootTaskId}
            ORDER BY rowid LIMIT 1`;
          const rootProofs = [...originalProofs.values()].filter(
            (proof) => proof.bindingId === rootOwners[0]?.bindingId,
          );
          const rootProof = rootProofs[0];
          if (
            rootProofs.length !== 1 ||
            rootProof === undefined ||
            rootProof.taskId !== original.rootTaskId ||
            rootProof.binding.parentRunId !== undefined
          )
            return unavailable(selected, "budget-invalid");
          const monitored = rootProof.binding.model === "gpt-6-luna";
          const budgets = yield* sql<{
            environmentId: string | null;
            maximumTokens: number | null;
            deadlineAtMs: number | null;
          }>`SELECT
            CASE WHEN length(CAST(environment_id AS BLOB))<=1024 THEN environment_id END AS environmentId,
            CASE WHEN typeof(maximum_tokens)='integer' AND maximum_tokens BETWEEN 1 AND 9007199254740991 THEN maximum_tokens END AS maximumTokens,
            CASE WHEN typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991 THEN deadline_at_ms END AS deadlineAtMs
            FROM project_team_model_budget WHERE project_id=${projectId} AND root_task_id=${original.rootTaskId} LIMIT 2`;
          const budget = budgets[0];
          if (
            budgets.length > 1 ||
            (budget !== undefined &&
              (budget.environmentId !== environmentId ||
                budget.maximumTokens !== original.rootMaximumTokens ||
                budget.deadlineAtMs !== original.rootDeadlineAtMs))
          )
            return unavailable(selected, "budget-invalid");
          let modelRows = rootModels.get(original.rootTaskId);
          if (modelRows === undefined) {
            if (modelRootsAttempted.has(original.rootTaskId))
              return unavailable(selected, "ledger-invalid");
            modelRootsAttempted.add(original.rootTaskId);
            const modelMetadata = allModelMetadata.filter(
              (row) => row.rootTaskId === original.rootTaskId,
            );
            if (modelMetadata.length > 0 && budget === undefined)
              return unavailable(selected, "budget-invalid");
            if (
              modelMetadata.length > 4096 ||
              modelMetadata.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > 32768) ||
              modelMetadata.reduce((total, row) => total + row.bytes, 0) > 4194304
            )
              return unavailable(selected, "read-bound");
            const physicalModels =
              yield* sql`SELECT reservation_id,environment_id,project_id,root_task_id,
              run_id,attempt_id,worker_id,generation,operation_id,request_lane,request_scope,request_id,
              route_id,provider,model,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
              charged_input_tokens,charged_output_tokens,accounting_mode,unknown_maximum_tokens,
              accounting_receipt_id,reservation_json,settlement_json
              FROM project_team_model_request WHERE project_id=${projectId} AND root_task_id=${original.rootTaskId} LIMIT 4097`;
            if (physicalModels.length !== modelMetadata.length)
              return unavailable(selected, "ledger-invalid");
            const decodedRows: ModelRow[] = [];
            const memoryAudited = new Set<string>();
            for (const physicalModel of physicalModels) {
              const model = yield* decodeProjectTeamRecordedModelRow(physicalModel);
              if (model.capacity_state === "legacy")
                return unavailable(selected, "legacy-capacity");
              const owner = yield* readOriginal(model.run_id, model.generation);
              const operation = owner.operations.find(
                (item) => item.operationId === model.operation_id,
              );
              if (
                model.environment_id !== environmentId ||
                model.attempt_id !== owner.attemptId ||
                owner.rootTaskId !== original.rootTaskId ||
                owner.rootMaximumTokens !== original.rootMaximumTokens ||
                owner.rootDeadlineAtMs !== original.rootDeadlineAtMs ||
                operation === undefined ||
                operation.workerId !== model.worker_id ||
                !Number.isSafeInteger(model.maximum_input_tokens + model.maximum_output_tokens) ||
                model.maximum_input_tokens + model.maximum_output_tokens >
                  operation.maximumTokens ||
                model.deadline_at_ms > operation.deadlineAtMs
              )
                return unavailable(selected, "ledger-invalid");
              if (model.request_lane === "pi") {
                if (!isPiBrokerManagedModel(owner.binding.model))
                  return unavailable(selected, "ledger-invalid");
                const route = piBrokerModelRoute(owner.binding.model);
                if (
                  model.model !== owner.binding.model ||
                  model.provider !== route.provider ||
                  model.route_id !== route.routeId ||
                  model.request_scope !== "" ||
                  model.accounting_mode !==
                    (owner.binding.model === "gpt-6-luna"
                      ? "openai-subscription-monitored"
                      : "hard")
                )
                  return unavailable(selected, "ledger-invalid");
                yield* auditProjectTeamRecordedPiModelRow(model, operation.terminalAccounting);
              } else {
                if (model.accounting_mode !== "hard" || model.unknown_maximum_tokens !== null)
                  return unavailable(selected, "ledger-invalid");
                if (!memoryAudited.has(model.operation_id)) {
                  yield* auditProjectMemoryOperationLedger(sql, {
                    environmentId,
                    projectId,
                    bindingId: model.run_id,
                    generation: model.generation,
                    operationId: model.operation_id,
                  });
                  memoryAudited.add(model.operation_id);
                }
              }
              decodedRows.push(model);
            }
            modelRows = decodedRows;
            rootModels.set(original.rootTaskId, modelRows);
          }
          const subscriptionGrants = yield* sql<{
            model: string | null;
            routeId: string | null;
            maximumTokens: number | null;
            maximumDurationMs: number | null;
            deadlineAtMs: number | null;
            stoppedAtMs: number | null;
            stopReason: string | null;
          }>`SELECT
            CASE WHEN model='gpt-6-luna' THEN model END AS model,
            CASE WHEN route_id='openai-subscription-luna' THEN route_id END AS routeId,
            CASE WHEN typeof(maximum_tokens)='integer' THEN maximum_tokens ELSE -1 END AS maximumTokens,
            CASE WHEN typeof(maximum_duration_ms)='integer' THEN maximum_duration_ms ELSE -1 END AS maximumDurationMs,
            CASE WHEN typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991 THEN deadline_at_ms ELSE -1 END AS deadlineAtMs,
            CASE WHEN stopped_at_ms IS NULL THEN NULL
              WHEN typeof(stopped_at_ms)='integer' AND stopped_at_ms BETWEEN 1 AND 9007199254740991 THEN stopped_at_ms ELSE -1 END AS stoppedAtMs,
            CASE WHEN stop_reason IS NULL OR stop_reason IN ('threshold-reached','unknown-usage') THEN stop_reason ELSE '__invalid__' END AS stopReason
            FROM project_team_pi_subscription_grant WHERE environment_id=${environmentId}
            AND project_id=${projectId} AND root_task_id=${original.rootTaskId} LIMIT 2`;
          if (subscriptionGrants.length > 1) return unavailable(selected, "ledger-invalid");
          const grant = subscriptionGrants[0];
          const hasMonitoredRows = modelRows.some(
            (model) => model.accounting_mode === "openai-subscription-monitored",
          );
          if (
            (hasMonitoredRows && !monitored) ||
            monitored !== (grant !== undefined) ||
            (grant !== undefined &&
              (grant.model !== "gpt-6-luna" ||
                grant.routeId !== "openai-subscription-luna" ||
                grant.maximumTokens !== 64_000 ||
                original.rootMaximumTokens !== 64_000 ||
                grant.maximumDurationMs !== 300_000 ||
                grant.deadlineAtMs !== original.rootDeadlineAtMs ||
                (grant.stoppedAtMs === null) !== (grant.stopReason === null) ||
                (grant.stopReason !== null &&
                  grant.stopReason !== "threshold-reached" &&
                  grant.stopReason !== "unknown-usage")))
          )
            return unavailable(selected, "ledger-invalid");
          const stoppedReason =
            grant?.stopReason === "threshold-reached" || grant?.stopReason === "unknown-usage"
              ? grant.stopReason
              : undefined;
          const chargedTotal = modelRows.reduce(
            (total, model) => total + model.charged_input_tokens + model.charged_output_tokens,
            0,
          );
          const hasUnknown = modelRows.some(
            (model) =>
              model.accounting_mode === "openai-subscription-monitored" &&
              model.status === "unknown",
          );
          if (
            grant !== undefined &&
            (!Number.isSafeInteger(chargedTotal) ||
              (stoppedReason === "threshold-reached" && chargedTotal < 64_000) ||
              (stoppedReason === "unknown-usage" && !hasUnknown) ||
              (stoppedReason === undefined && (chargedTotal >= 64_000 || hasUnknown)))
          )
            return unavailable(selected, "ledger-invalid");
          for (const member of members) {
            if (member.bindingId === null || member.generation === null)
              return unavailable(selected, "owner-invalid");
            const owner = yield* readOriginal(member.bindingId, member.generation);
            const hardRows = modelRows.filter(
              (model) =>
                model.accounting_mode === "hard" &&
                model.run_id === owner.bindingId &&
                model.generation === owner.generation,
            );
            if (!recordedUsage(hardRows, owner.attemptMaximumTokens, owner.attemptDeadlineAtMs))
              return unavailable(selected, "limit-exceeded");
            for (const operation of owner.operations)
              if (
                !recordedUsage(
                  hardRows.filter((model) => model.operation_id === operation.operationId),
                  operation.maximumTokens,
                  operation.deadlineAtMs,
                )
              )
                return unavailable(selected, "limit-exceeded");
          }
          const root = recordedUsage(
            modelRows,
            original.rootMaximumTokens,
            original.rootDeadlineAtMs,
            stoppedReason,
            monitored,
          );
          const attempt = recordedUsage(
            modelRows.filter(
              (model) =>
                model.run_id === binding.recordId &&
                model.generation === binding.generation &&
                model.attempt_id === binding.attemptId,
            ),
            original.attemptMaximumTokens,
            original.attemptDeadlineAtMs,
            stoppedReason,
            monitored,
          );
          if (!root || !attempt) return unavailable(selected, "limit-exceeded");
          const latest = original.operations.at(-1);
          const operation = latest
            ? recordedUsage(
                modelRows.filter((model) => model.operation_id === latest.operationId),
                latest.maximumTokens,
                latest.deadlineAtMs,
                stoppedReason,
                monitored,
              )
            : undefined;
          if (latest && !operation) return unavailable(selected, "limit-exceeded");
          return {
            ...identity(selected),
            environmentId,
            availability: "available" as const,
            root: { ...root, taskId: original.rootTaskId },
            attempt,
            ...(latest && operation
              ? {
                  operation: {
                    ...operation,
                    operationId: latest.operationId,
                    workerId: latest.workerId,
                  },
                }
              : {}),
          } satisfies ProjectTeamBindingAccounting;
        }).pipe(Effect.result);
        results.push(
          usage._tag === "Success" ? usage.success : unavailable(selected, "ledger-invalid"),
        );
      }
      return results;
    }).pipe(Effect.result);
    return read._tag === "Success"
      ? read.success
      : bindings.map((binding) => unavailable(binding, "journal-unavailable"));
  },
);
