import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";
import { makeProjectTaskResources } from "../ProjectTaskResources.ts";
import { PiManagedProcessAllocationSchema } from "../../provider/pi/PiManagedProcess.ts";
import type {
  PiManagedDrain,
  PiManagedProcessAllocation,
  PiManagedProcessOwner,
  PiManagedProcessReconciliation,
} from "../../provider/pi/PiManagedProcess.ts";
import {
  ProjectMemoryJobOwner,
  ProjectMemoryQueryOwner,
  auditProjectMemoryAdmission,
  auditProjectMemoryTaskOwner,
} from "./ProjectMemoryModelAccounting.ts";
import { qualifyProjectMemorySharedSource } from "./ProjectMemorySharing.ts";
import { ProjectMemoryProcessingConfiguration } from "./ProjectMemoryPorts.ts";
import {
  MEMORY_BACKEND_MAX_BYTES,
  MemoryBackendSearch,
  MemoryBackendSource,
  MemoryIndexManifest,
} from "./MemoryBackend.ts";
import {
  ProjectMemoryJobInput,
  ProjectMemoryServiceError,
  projectMemoryHash,
  projectMemoryId,
} from "./ProjectMemoryService.ts";

const MemoryId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const MemoryHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ProjectMemoryCompanionIntent = Schema.Struct({
  version: Schema.Literal(1),
  invocationId: MemoryId,
  owner: Schema.Union([ProjectMemoryJobOwner, ProjectMemoryQueryOwner]),
  configuration: ProjectMemoryProcessingConfiguration,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requestId: MemoryId,
  operation: Schema.Literals(["index", "reconcile", "search", "delete-source"]),
  requestSha256: MemoryHash,
  configurationSha256: MemoryHash,
  deadlineAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
  allocation: PiManagedProcessAllocationSchema,
});
export type ProjectMemoryCompanionIntent = typeof ProjectMemoryCompanionIntent.Type;

export type ProjectMemoryCompanionForwardFence = Effect.Effect<void, ProjectMemoryServiceError>;
export type ProjectMemoryCompanionOwner = ProjectMemoryJobOwner | ProjectMemoryQueryOwner;
const encode = canonicalProjectWorkPayload;
const same = (a: unknown, b: unknown) => encode(a) === encode(b);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Request = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestId: Id,
  operation: Schema.Literals(["index", "reconcile", "search", "delete-source"]),
  input: Schema.Unknown,
});
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Request), strict);
export const decodeProjectMemoryCompanionIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryCompanionIntent),
  strict,
);
const NativeOwner = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Schema.String,
  invocation: Schema.String,
  cgroup: Schema.String,
  pid: Schema.Int,
  memoryBytes: Schema.Int,
  swapBytes: Schema.Int,
  oomGroup: Schema.Int,
  nonce: Schema.String,
});
const decodeNativeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeOwner), strict);
const ReceiptFields = {
  unit: Schema.String,
  invocation: Schema.String,
  cgroup: Schema.String,
  kernel: Schema.String,
};
const Receipt = Schema.Union([
  Schema.Struct({ ...ReceiptFields, state: Schema.Literal("drained") }),
  Schema.Struct({
    ...ReceiptFields,
    ownerPid: Schema.NullOr(Schema.Int),
    memoryBytes: Schema.Int,
    swapBytes: Schema.Int,
    oomGroup: Schema.Int,
    launcherPid: Schema.Int,
    childPid: Schema.NullOr(Schema.Int),
    childExitCode: Schema.NullOr(Schema.Int),
  }),
]);
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt), strict);
const decodeJob = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemoryJobInput), strict);
const decodeSearch = Schema.decodeUnknownEffect(MemoryBackendSearch, strict);
const decodeSource = Schema.decodeUnknownEffect(MemoryBackendSource, strict);
const decodeManifest = Schema.decodeUnknownEffect(MemoryIndexManifest, strict);
const decodeManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MemoryIndexManifest),
  strict,
);
const decodeSearchIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      queryId: Id,
      requestId: Id,
      ownerSha256: Schema.String,
      configurationSha256: Schema.String,
      vectorSha256: Schema.String,
      deadlineAtMs: Schema.Int,
      limit: Schema.Literal(12),
    }),
  ),
  strict,
);
const isServiceError = Schema.is(ProjectMemoryServiceError);
export const companionBytesHash = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => deny("Companion envelope is not UTF-8"),
  });

/** Only durable admitted jobs/queries supply authority. Cleanup records no new work. */
export const makeProjectMemoryCompanionJournal = Effect.fn("makeProjectMemoryCompanionJournal")(
  function* (environmentId: string) {
    const sql = yield* SqlClient.SqlClient;
    const resources = yield* makeProjectTaskResources(environmentId);
    const transaction = Effect.gen(function* () {
      if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("Companion journal requires its original transaction");
    });
    const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isServiceError(error) ? error : deny("Original companion journal is unavailable"),
        ),
      );
    const auditOwner = (owner: ProjectMemoryCompanionOwner) =>
      Effect.gen(function* () {
        if (owner.operation.environmentId !== environmentId)
          return yield* deny("Companion belongs to another environment");
        if (owner.version === 1) {
          yield* auditProjectMemoryAdmission(sql, owner);
          const rows = yield* sql<{
            owner: string | null;
          }>`SELECT CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner FROM project_team_memory_job WHERE environment_id=${environmentId} AND project_id=${owner.operation.projectId} AND effect_id=${owner.admittedEffect.effectId} LIMIT 2`;
          if (rows.length !== 1 || rows[0]?.owner !== encode(owner))
            return yield* deny("Companion original job owner changed");
        } else {
          const { auditProjectMemoryQueryAdmission } = yield* Effect.promise(
            () => import("./ProjectMemoryQuery.ts"),
          );
          yield* auditProjectMemoryQueryAdmission(sql, owner);
        }
      });
    const auditRetainedOwner = (owner: ProjectMemoryCompanionOwner) =>
      Effect.gen(function* () {
        if (owner.operation.environmentId !== environmentId)
          return yield* deny("Retained companion belongs to another environment");
        yield* auditProjectMemoryTaskOwner(sql, owner.operation);
        const rows =
          owner.version === 1
            ? yield* sql<{
                owner: string | null;
              }>`SELECT CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner FROM project_team_memory_job WHERE environment_id=${environmentId} AND project_id=${owner.operation.projectId} AND effect_id=${owner.admittedEffect.effectId} LIMIT 2`
            : yield* sql<{
                owner: string | null;
              }>`SELECT CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner FROM project_team_memory_query WHERE environment_id=${environmentId} AND project_id=${owner.operation.projectId} AND query_id=${owner.admittedEffect.effectId} LIMIT 2`;
        if (rows.length !== 1 || rows[0]?.owner !== encode(owner))
          return yield* deny("Retained companion original owner changed");
      });
    const readWithOwnerAudit = (id: string, ownerAudit: typeof auditOwner) =>
      Effect.gen(function* () {
        yield* transaction;
        const rows = yield* sql<{
          project_id: string;
          task_id: string;
          effect_id: string;
          request_id: string;
          generation: number;
          phase: string;
          intent: string | null;
          owner: string | null;
          drain: string | null;
          responseBytes: number | null;
        }>`SELECT CASE WHEN length(CAST(project_id AS BLOB))<=1024 THEN project_id END AS project_id,
      CASE WHEN length(CAST(task_id AS BLOB))<=1024 THEN task_id END AS task_id,
      CASE WHEN length(CAST(effect_id AS BLOB))<=1024 THEN effect_id END AS effect_id,
      CASE WHEN length(CAST(request_id AS BLOB))<=1024 THEN request_id END AS request_id,
      CASE WHEN typeof(generation)='integer' THEN generation END AS generation,
      CASE WHEN length(CAST(phase AS BLOB))<=32 THEN phase END AS phase,
      CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent,
      CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json END AS owner,
      CASE WHEN length(CAST(drain_json AS BLOB))<=262144 THEN drain_json END AS drain,
      length(response) AS responseBytes FROM project_memory_companion_invocation WHERE environment_id=${environmentId} AND invocation_id=${id} LIMIT 2`;
        if (rows.length === 0) return undefined;
        const row = rows[0];
        if (rows.length !== 1 || !row?.intent)
          return yield* deny("Companion retained identity is unavailable");
        const intent = yield* decodeProjectMemoryCompanionIntent(row.intent);
        if (
          intent.invocationId !== id ||
          intent.owner.operation.environmentId !== environmentId ||
          intent.owner.operation.projectId !== row.project_id ||
          intent.owner.operation.taskId !== row.task_id ||
          intent.owner.admittedEffect.effectId !== row.effect_id ||
          intent.requestId !== row.request_id ||
          intent.generation !== row.generation ||
          !Number.isSafeInteger(row.generation) ||
          row.generation < 0 ||
          (row.responseBytes !== null &&
            (!Number.isSafeInteger(row.responseBytes) ||
              row.responseBytes < 1 ||
              row.responseBytes > MEMORY_BACKEND_MAX_BYTES))
        )
          return yield* deny("Companion retained partition changed");
        if (
          !["prepared", "activating", "owned", "uncertain", "drained"].includes(row.phase) ||
          intent.configurationSha256 !== projectMemoryHash(intent.configuration) ||
          intent.deadlineAtMs !==
            Math.min(
              intent.owner.operation.rootDeadlineAtMs,
              intent.owner.operation.attemptDeadlineAtMs,
              intent.owner.operation.operationDeadlineAtMs,
              intent.owner.operation.leaseDeadlineAtMs,
            ) ||
          intent.allocation.policy.memoryBytes !== intent.configuration.companion.memoryBytes ||
          intent.allocation.policy.runtimeSeconds >
            intent.owner.operation.allocation.policy.runtimeSeconds ||
          (intent.owner.version === 2 &&
            (intent.operation !== "search" ||
              intent.generation !== 0 ||
              intent.configurationSha256 !== intent.owner.configurationSha256)) ||
          (intent.owner.version === 1 &&
            (intent.generation < 1 ||
              (intent.owner.admittedEffect.effectKind === "memory-delete"
                ? intent.operation !== "delete-source"
                : !["index", "reconcile"].includes(intent.operation))))
        )
          return yield* deny("Companion frozen configuration or limits changed");
        yield* ownerAudit(intent.owner);
        const owner = row.owner === null ? undefined : yield* decodeNativeOwner(row.owner);
        if (
          owner &&
          (owner.unit !== intent.allocation.unit ||
            owner.nonce !== intent.allocation.nonce ||
            owner.memoryBytes !== intent.allocation.policy.memoryBytes ||
            owner.swapBytes !== 0 ||
            owner.oomGroup !== 1)
        )
          return yield* deny("Companion retained physical owner changed");
        if (
          ((row.phase === "prepared" || row.phase === "activating") &&
            (owner !== undefined || row.drain !== null || row.responseBytes !== null)) ||
          (row.phase === "owned" && (!owner || row.drain !== null)) ||
          (row.phase === "uncertain" && row.drain !== null) ||
          (row.phase === "drained" && (!owner || row.drain === null)) ||
          (row.responseBytes !== null && row.phase !== "drained")
        )
          return yield* deny("Companion retained lifecycle is inconsistent");
        if (row.drain !== null) {
          const receipt = yield* decodeReceipt(row.drain);
          const populated = receipt.kernel
            .split("\n")
            .filter((line) => /^populated(?:\s|$)/u.test(line));
          if (
            !owner ||
            receipt.unit !== owner.unit ||
            receipt.invocation !== owner.invocation ||
            receipt.cgroup !== owner.cgroup ||
            (receipt.kernel !== "removed" &&
              (receipt.kernel.length > 4096 ||
                populated.length !== 1 ||
                populated[0] !== "populated 0")) ||
            (!("state" in receipt) &&
              (receipt.ownerPid !== owner.pid ||
                receipt.memoryBytes !== owner.memoryBytes ||
                receipt.swapBytes !== 0 ||
                receipt.oomGroup !== 1))
          )
            return yield* deny("Companion retained drain changed its physical owner");
        }
        return {
          intent,
          phase: row.phase,
          owner,
          drain: row.drain,
          responseBytes: row.responseBytes,
        };
      });
    const read = (id: string) => readWithOwnerAudit(id, auditOwner);
    const requestAuthority = (
      owner: ProjectMemoryCompanionOwner,
      configuration: ProjectMemoryProcessingConfiguration,
      bytes: Uint8Array,
    ) =>
      Effect.gen(function* () {
        yield* transaction;
        yield* auditOwner(owner);
        if (bytes.byteLength < 1 || bytes.byteLength > MEMORY_BACKEND_MAX_BYTES)
          return yield* deny("Companion request exceeds its byte bound");
        const text = yield* decodeUtf8(bytes);
        const request = yield* decodeRequest(text);
        let generation = 0;
        if (owner.version === 2) {
          if (
            request.operation !== "search" ||
            projectMemoryHash(configuration) !== owner.configurationSha256
          )
            return yield* deny("Query companion configuration or operation changed");
          const input = yield* decodeSearch(request.input);
          const shared = owner.sharedSource;
          if (
            shared !== undefined &&
            !same(
              shared,
              yield* qualifyProjectMemorySharedSource(
                sql,
                owner.request.projectId,
                shared.selection,
              ),
            )
          )
            return yield* deny("Query companion shared grant changed");
          const rows = yield* sql<{
            status: string;
            search: string | null;
          }>`SELECT CASE WHEN length(CAST(status AS BLOB))<=32 THEN status END AS status,CASE WHEN length(CAST(search_json AS BLOB))<=32768 THEN search_json END AS search FROM project_team_memory_query WHERE environment_id=${environmentId} AND query_id=${owner.admittedEffect.effectId} LIMIT 2`;
          if (rows.length !== 1 || !rows[0]?.search || rows[0].status !== "searching")
            return yield* deny("Query companion has no frozen search intent");
          const search = yield* decodeSearchIntent(rows[0].search);
          if (
            search.queryId !== owner.admittedEffect.effectId ||
            search.requestId !== request.requestId ||
            request.requestId !== search.queryId + ":search" ||
            search.ownerSha256 !== projectMemoryHash(owner) ||
            search.configurationSha256 !== projectMemoryHash(configuration) ||
            search.vectorSha256 !== projectMemoryHash(input.vector) ||
            input.limit !== search.limit ||
            search.deadlineAtMs !==
              Math.min(
                owner.operation.rootDeadlineAtMs,
                owner.operation.attemptDeadlineAtMs,
                owner.operation.operationDeadlineAtMs,
                owner.operation.leaseDeadlineAtMs,
              ) ||
            input.environmentId !== environmentId ||
            input.projectId !== (shared?.ownerProjectId ?? owner.operation.projectId) ||
            !same(
              input.source,
              shared === undefined
                ? undefined
                : {
                    sourceRecordId: shared.selection.sourceRecordId,
                    sourceRevision: shared.selection.sourceRevision,
                    sourceGeneration: shared.selection.sourceGeneration,
                  },
            )
          )
            return yield* deny("Query companion changed its frozen search");
        } else {
          const rows = yield* sql<{
            generation: number;
            status: string;
            input: string | null;
          }>`SELECT CASE WHEN typeof(claim_generation)='integer' THEN claim_generation END AS generation,
            CASE WHEN length(CAST(status AS BLOB))<=32 THEN status END AS status,CASE WHEN length(CAST(input_json AS BLOB))<=262144 THEN input_json END AS input FROM project_team_memory_job WHERE environment_id=${environmentId} AND effect_id=${owner.admittedEffect.effectId} LIMIT 2`;
          if (
            rows.length !== 1 ||
            !rows[0]?.input ||
            rows[0].status !== "claimed" ||
            !Number.isSafeInteger(rows[0].generation) ||
            rows[0].generation < 1
          )
            return yield* deny("Companion requires its original claimed job");
          generation = rows[0].generation;
          const job = yield* decodeJob(rows[0].input);
          if (
            job.environmentId !== environmentId ||
            job.projectId !== owner.operation.projectId ||
            job.effect.effectId !== owner.admittedEffect.effectId ||
            job.source.recordId !== owner.selection.sourceRecordId ||
            job.source.sourceRevision !== owner.selection.sourceRevision ||
            job.source.generation !== owner.selection.sourceGeneration
          )
            return yield* deny("Companion source claim changed");
          if (owner.admittedEffect.effectKind === "memory-delete") {
            const input = yield* decodeSource(request.input);
            if (
              request.operation !== "delete-source" ||
              request.requestId !== projectMemoryId("memory-cleanup", [job.effect.effectId]) ||
              !same(input, {
                environmentId,
                projectId: job.projectId,
                sourceRecordId: job.source.recordId,
                sourceRevision: job.source.sourceRevision,
                sourceGeneration: job.source.generation,
              })
            )
              return yield* deny("Companion cleanup changed its selected source");
          } else {
            if (!["index", "reconcile"].includes(request.operation))
              return yield* deny("Processing companion operation is not admitted");
            const input = yield* decodeManifest(request.input);
            const expectedIds =
              request.operation === "index"
                ? [projectMemoryId("memory-index-request", [job.effect.effectId])]
                : [
                    projectMemoryId("memory-reconcile-before", [job.effect.effectId, generation]),
                    projectMemoryId("memory-reconcile-after", [job.effect.effectId, generation]),
                  ];
            const manifests = yield* sql<{
              manifest: string | null;
            }>`SELECT CASE WHEN length(CAST(manifest_json AS BLOB))<=4194304 THEN manifest_json END AS manifest FROM project_team_memory_manifest WHERE extraction_id=${input.extractionId} AND environment_id=${environmentId} AND project_id=${job.projectId} LIMIT 2`;
            if (
              !expectedIds.includes(request.requestId) ||
              input.sourceRecordId !== job.source.recordId ||
              input.sourceRevision !== job.source.sourceRevision ||
              input.sourceGeneration !== job.source.generation ||
              manifests.length !== 1 ||
              !manifests[0]?.manifest
            )
              return yield* deny("Companion index has no exact retained manifest");
            const original = yield* decodeManifestJson(manifests[0].manifest);
            if (!same(input, original)) return yield* deny("Companion index manifest changed");
          }
        }
        const configurationSha256 = projectMemoryHash(configuration);
        const prior = yield* sql<{
          intent: string | null;
        }>`SELECT CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent FROM project_memory_companion_invocation WHERE environment_id=${environmentId} AND effect_id=${owner.admittedEffect.effectId} ORDER BY invocation_id LIMIT 257`;
        if (prior.length > 256)
          return yield* deny("Companion invocation history exceeds its bound");
        for (const row of prior) {
          if (
            !row.intent ||
            (yield* decodeProjectMemoryCompanionIntent(row.intent)).configurationSha256 !==
              configurationSha256
          )
            return yield* deny("Companion configuration cannot change for a retained effect");
        }
        const invocationId = projectMemoryId("memory-companion", [
          environmentId,
          owner.operation.projectId,
          owner.admittedEffect.effectId,
          generation,
          request.requestId,
        ]);
        return {
          invocationId,
          generation,
          request,
          configurationSha256,
          requestSha256: companionBytesHash(bytes),
          deadlineAtMs: Math.min(
            owner.operation.rootDeadlineAtMs,
            owner.operation.attemptDeadlineAtMs,
            owner.operation.operationDeadlineAtMs,
            owner.operation.leaseDeadlineAtMs,
          ),
        };
      });
    const inspect = (
      owner: ProjectMemoryCompanionOwner,
      configuration: ProjectMemoryProcessingConfiguration,
      bytes: Uint8Array,
      fence: ProjectMemoryCompanionForwardFence,
    ) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* fence;
            const authority = yield* requestAuthority(owner, configuration, bytes);
            const original = yield* read(authority.invocationId);
            if (
              original &&
              (!same(original.intent.owner, owner) ||
                !same(original.intent.configuration, configuration) ||
                original.intent.requestSha256 !== authority.requestSha256)
            )
              return yield* deny("Companion retry changed its original request");
            return { authority, original };
          }),
        ),
      );
    const prepare = (
      owner: ProjectMemoryCompanionOwner,
      configuration: ProjectMemoryProcessingConfiguration,
      bytes: Uint8Array,
      allocation: PiManagedProcessAllocation,
      fence: ProjectMemoryCompanionForwardFence,
    ) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* fence;
            const a = yield* requestAuthority(owner, configuration, bytes);
            if (
              (yield* Clock.currentTimeMillis) >= a.deadlineAtMs ||
              allocation.policy.memoryBytes !== configuration.companion.memoryBytes ||
              allocation.policy.runtimeSeconds > owner.operation.allocation.policy.runtimeSeconds
            )
              return yield* deny("Companion allocation exceeds its original limits");
            const intent: ProjectMemoryCompanionIntent = {
              version: 1,
              invocationId: a.invocationId,
              owner,
              configuration,
              generation: a.generation,
              requestId: a.request.requestId,
              operation: a.request.operation,
              requestSha256: a.requestSha256,
              configurationSha256: a.configurationSha256,
              deadlineAtMs: a.deadlineAtMs,
              allocation,
            };
            const original = yield* read(a.invocationId);
            if (original) {
              if (!same(original.intent, intent))
                return yield* deny("Companion retained allocation changed");
              return original;
            }
            yield* sql`INSERT INTO project_memory_companion_invocation(invocation_id,environment_id,project_id,task_id,effect_id,request_id,generation,intent_json,phase) VALUES(${a.invocationId},${environmentId},${owner.operation.projectId},${owner.operation.taskId},${owner.admittedEffect.effectId},${a.request.requestId},${a.generation},${encode(intent)},'prepared')`;
            yield* resources.memoryCompanion(a.invocationId, allocation).reserve;
            return (yield* read(a.invocationId))!;
          }),
        ),
      );
    const claim = (
      intent: ProjectMemoryCompanionIntent,
      fence: ProjectMemoryCompanionForwardFence,
    ) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* fence;
            const row = yield* read(intent.invocationId);
            if (!row || !same(row.intent, intent) || row.phase !== "prepared")
              return yield* deny("Companion activation is already consumed");
            yield* resources.memoryCompanion(intent.invocationId, intent.allocation).reserve;
            yield* sql`UPDATE project_memory_companion_invocation SET phase='activating' WHERE invocation_id=${intent.invocationId} AND phase='prepared'`;
          }),
        ),
      );
    const captureInTransaction = (
      intent: ProjectMemoryCompanionIntent,
      owner: PiManagedProcessOwner,
    ) =>
      Effect.gen(function* () {
        const row = yield* read(intent.invocationId);
        if (
          !row ||
          !same(row.intent, intent) ||
          !["activating", "owned", "uncertain", "drained"].includes(row.phase)
        )
          return yield* deny("Companion cleanup capture has no original activation");
        if (row.owner && !same(row.owner, owner))
          return yield* deny("Companion cleanup physical owner changed");
        if (row.drain !== null) {
          if (!row.owner) return yield* deny("Drained companion cannot adopt an owner");
          yield* resources
            .memoryCompanion(intent.invocationId, intent.allocation)
            .captureCleanup(owner);
          return;
        }
        yield* sql`UPDATE project_memory_companion_invocation SET owner_json=${encode(owner)},phase='owned' WHERE invocation_id=${intent.invocationId}`;
        yield* resources
          .memoryCompanion(intent.invocationId, intent.allocation)
          .captureCleanup(owner);
      });
    const capture = (intent: ProjectMemoryCompanionIntent, owner: PiManagedProcessOwner) =>
      guard(sql.withTransaction(captureInTransaction(intent, owner)));
    const beforeStart = (
      intent: ProjectMemoryCompanionIntent,
      owner: PiManagedProcessOwner,
      fence: ProjectMemoryCompanionForwardFence,
    ) =>
      capture(intent, owner).pipe(
        Effect.andThen(
          guard(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* fence;
                const row = yield* read(intent.invocationId);
                if (
                  !row ||
                  !same(row.intent, intent) ||
                  row.phase !== "owned" ||
                  !same(row.owner, owner)
                )
                  return yield* deny("Companion original START authority changed");
                const resource = resources.memoryCompanion(intent.invocationId, intent.allocation);
                yield* resource.reserve;
                yield* resource.capture(owner);
              }),
            ),
          ),
        ),
      );
    const drain = (
      intent: ProjectMemoryCompanionIntent,
      receipt: PiManagedDrain | PiManagedProcessReconciliation,
      capturedOwner?: PiManagedProcessOwner,
    ) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            if (capturedOwner) yield* captureInTransaction(intent, capturedOwner);
            const row = yield* read(intent.invocationId);
            if (!row || !same(row.intent, intent) || !row.owner)
              return yield* deny("Companion drain has no exact retained physical owner");
            yield* decodeReceipt(encode(receipt));
            const populated = receipt.kernel
              .split("\n")
              .filter((line) => /^populated(?:\s|$)/u.test(line));
            if (
              receipt.unit !== row.owner.unit ||
              receipt.invocation !== row.owner.invocation ||
              receipt.cgroup !== row.owner.cgroup ||
              (receipt.kernel !== "removed" &&
                (receipt.kernel.length > 4096 ||
                  populated.length !== 1 ||
                  populated[0] !== "populated 0")) ||
              ("state" in receipt
                ? receipt.state !== "drained"
                : receipt.ownerPid !== row.owner.pid ||
                  receipt.memoryBytes !== row.owner.memoryBytes ||
                  receipt.swapBytes !== 0 ||
                  receipt.oomGroup !== 1 ||
                  !Number.isSafeInteger(receipt.launcherPid) ||
                  receipt.launcherPid < 1)
            )
              return yield* deny("Companion release requires its matched observed drain");
            yield* resources.memoryCompanion(intent.invocationId, intent.allocation).drain(receipt);
            if (row.drain === null)
              yield* sql`UPDATE project_memory_companion_invocation SET drain_json=${encode(receipt)},phase='drained' WHERE invocation_id=${intent.invocationId}`;
          }),
        ),
      );
    const response = (intent: ProjectMemoryCompanionIntent, bytes: Uint8Array) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* read(intent.invocationId);
            if (
              !row ||
              !same(row.intent, intent) ||
              row.phase !== "drained" ||
              row.drain === null ||
              bytes.byteLength < 1 ||
              bytes.byteLength > MEMORY_BACKEND_MAX_BYTES
            )
              return yield* deny("Companion response waits for its original drain");
            const observed = yield* decodeReceipt(row.drain);
            if ("state" in observed || observed.childExitCode !== 0)
              return yield* deny(
                "Companion response requires its original successful exit receipt",
              );
            if (row.responseBytes !== null) {
              const existing = yield* replay(intent);
              if (!existing || !Buffer.from(existing).equals(Buffer.from(bytes)))
                return yield* deny("Companion response cannot change");
              return;
            }
            yield* sql`UPDATE project_memory_companion_invocation SET response=${bytes} WHERE invocation_id=${intent.invocationId} AND response IS NULL`;
          }),
        ),
      );
    const replay = (intent: ProjectMemoryCompanionIntent) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* read(intent.invocationId);
            if (
              !row ||
              !same(row.intent, intent) ||
              row.phase !== "drained" ||
              row.drain === null ||
              row.responseBytes === null
            )
              return undefined;
            const rows = yield* sql<{
              response: Uint8Array;
            }>`SELECT response FROM project_memory_companion_invocation WHERE invocation_id=${intent.invocationId} AND typeof(response)='blob' AND length(response)<=16777216 LIMIT 2`;
            if (rows.length !== 1 || rows[0]!.response.byteLength !== row.responseBytes)
              return yield* deny("Companion replay bytes changed");
            return rows[0]!.response;
          }),
        ),
      );
    const uncertain = (intent: ProjectMemoryCompanionIntent) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* read(intent.invocationId);
            if (!row || !same(row.intent, intent))
              return yield* deny("Companion uncertain owner changed");
            if (row.drain === null)
              yield* sql`UPDATE project_memory_companion_invocation SET phase='uncertain' WHERE invocation_id=${intent.invocationId}`;
          }),
        ),
      );
    const retained = (effectId: string) =>
      guard(
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              id: string | null;
            }>`SELECT CASE WHEN length(CAST(invocation_id AS BLOB))<=256 THEN invocation_id END AS id FROM project_memory_companion_invocation WHERE environment_id=${environmentId} AND effect_id=${effectId} ORDER BY invocation_id LIMIT 257`;
            if (rows.length > 256) return yield* deny("Companion recovery exceeds its bound");
            const result = [];
            for (const row of rows) {
              if (!row.id) return yield* deny("Companion recovery identity exceeds its bound");
              const original = yield* read(row.id);
              if (!original) return yield* deny("Companion recovery identity disappeared");
              result.push(original);
            }
            return result;
          }),
        ),
      );
    const auditDrained = (projectId: string, maximumBytes: number, reader: typeof read) =>
      guard(
        Effect.gen(function* () {
          yield* transaction;
          if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 4194304)
            return yield* deny("Companion readiness byte allowance is exhausted");
          const rows = yield* sql<{
            id: string | null;
            phase: string | null;
            bytes: number;
            responseBytes: number | null;
          }>`SELECT CASE WHEN length(CAST(invocation_id AS BLOB))<=256 THEN invocation_id END AS id,CASE WHEN length(CAST(phase AS BLOB))<=32 THEN phase END AS phase,
      length(CAST(invocation_id AS BLOB))+length(CAST(environment_id AS BLOB))+length(CAST(project_id AS BLOB))+length(CAST(task_id AS BLOB))+length(CAST(effect_id AS BLOB))+length(CAST(request_id AS BLOB))+length(CAST(phase AS BLOB))+length(CAST(intent_json AS BLOB))+COALESCE(length(CAST(owner_json AS BLOB)),0)+COALESCE(length(CAST(drain_json AS BLOB)),0)
      +COALESCE((SELECT length(CAST(json_extract(c.drain_json,'$.kernel') AS BLOB)) FROM project_task_resource_child c WHERE c.unit=json_extract(project_memory_companion_invocation.intent_json,'$.allocation.unit')),0) AS bytes,
      length(response) AS responseBytes FROM project_memory_companion_invocation WHERE project_id=${projectId} ORDER BY invocation_id LIMIT 257`;
          if (
            rows.length > 256 ||
            rows.some(
              (row) =>
                !row.id ||
                !Number.isSafeInteger(row.bytes) ||
                row.bytes < 1 ||
                row.bytes > 4194304 ||
                row.phase !== "drained" ||
                (row.responseBytes !== null &&
                  (!Number.isSafeInteger(row.responseBytes) ||
                    row.responseBytes < 1 ||
                    row.responseBytes > MEMORY_BACKEND_MAX_BYTES)),
            ) ||
            rows.reduce((sum, row) => sum + row.bytes, 0) > maximumBytes
          )
            return yield* deny("Project retains held or over-bound companion evidence");
          for (const row of rows) {
            if (!row.id) return yield* deny("Companion readiness identity exceeds its bound");
            const original = yield* reader(row.id);
            if (!original || !original.owner || original.drain === null)
              return yield* deny("Project companion has no original matched drain");
            const children = yield* sql<{
              kernel: string | null;
            }>`SELECT CASE WHEN length(CAST(json_extract(drain_json,'$.kernel') AS BLOB))<=4096 THEN json_extract(drain_json,'$.kernel') END AS kernel FROM project_task_resource_child
        WHERE unit=${original.intent.allocation.unit} AND nonce=${original.intent.allocation.nonce}
        AND environment_id=${environmentId} AND project_id=${projectId}
        AND (task_id=${original.intent.owner.operation.rootTaskId} OR task_id=${original.intent.owner.operation.taskId})
        AND authority_kind='memory-companion' AND authority_id=${original.intent.invocationId}
        AND length(CAST(allocation_json AS BLOB))<=262144 AND allocation_json=${encode(original.intent.allocation)}
        AND length(CAST(owner_json AS BLOB))<=16384 AND owner_json=${encode(original.owner)}
        AND json_type(drain_json,'$.kernel')='text'
        AND json_extract(drain_json,'$.unit')=${original.owner.unit} AND json_extract(drain_json,'$.invocation')=${original.owner.invocation}
        AND json_extract(drain_json,'$.cgroup')=${original.owner.cgroup}
        AND NOT EXISTS(SELECT 1 FROM json_each(drain_json) WHERE key NOT IN ('unit','invocation','cgroup','kernel','state','ownerPid','memoryBytes','swapBytes','oomGroup','launcherPid','childPid','childExitCode'))
        AND ((json_extract(drain_json,'$.state')='drained' AND (SELECT COUNT(*) FROM json_each(drain_json))=5)
          OR (json_type(drain_json,'$.state') IS NULL AND (SELECT COUNT(*) FROM json_each(drain_json))=11
            AND json_type(drain_json,'$.ownerPid')='integer' AND json_extract(drain_json,'$.ownerPid')=${original.owner.pid}
            AND json_type(drain_json,'$.memoryBytes')='integer' AND json_extract(drain_json,'$.memoryBytes')=${original.owner.memoryBytes}
            AND json_type(drain_json,'$.swapBytes')='integer' AND json_extract(drain_json,'$.swapBytes')=0
            AND json_type(drain_json,'$.oomGroup')='integer' AND json_extract(drain_json,'$.oomGroup')=1
            AND json_type(drain_json,'$.launcherPid')='integer' AND json_extract(drain_json,'$.launcherPid') BETWEEN 1 AND 9007199254740991
            AND json_type(drain_json,'$.childPid') IN ('integer','null') AND json_type(drain_json,'$.childExitCode') IN ('integer','null'))) LIMIT 2`;
            const kernel = children[0]?.kernel;
            const populated = kernel
              ?.split("\n")
              .filter((line) => /^populated(?:\s|$)/u.test(line));
            if (
              children.length !== 1 ||
              typeof kernel !== "string" ||
              (kernel !== "removed" && (populated?.length !== 1 || populated[0] !== "populated 0"))
            )
              return yield* deny("Project companion resource custody or matched drain changed");
          }
          return rows.reduce((sum, row) => sum + row.bytes, 0);
        }),
      );
    const auditProjectDrained = (projectId: string, maximumBytes = 4194304) =>
      auditDrained(projectId, maximumBytes, read);
    // Only the exact tombstone synchronization consumer uses frozen custody after domain purge.
    const auditRetainedProjectDrained = (projectId: string, maximumBytes = 4194304) =>
      auditDrained(projectId, maximumBytes, (id) => readWithOwnerAudit(id, auditRetainedOwner));
    return {
      inspect,
      prepare,
      claim,
      capture,
      beforeStart,
      drain,
      response,
      replay,
      uncertain,
      retained,
      auditProjectDrained,
      auditRetainedProjectDrained,
    };
  },
);
