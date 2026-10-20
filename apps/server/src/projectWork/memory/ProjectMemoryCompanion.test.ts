import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { at, projectId, taskId, scoped, seed } from "../ProjectTeamAuthorization.testFixtures.ts";
import {
  PiManagedProcessError,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
  type PiManagedProcessReconciliation,
} from "../../provider/pi/PiManagedProcess.ts";
import { makeProjectMemoryCompanion } from "./ProjectMemoryCompanion.ts";
import { ProjectMemoryCompanionIntent } from "./ProjectMemoryCompanionJournal.ts";
import { ProjectMemoryServiceError, projectMemoryHash } from "./ProjectMemoryService.ts";

const encode = canonicalProjectWorkPayload;
const decodeIntent = Schema.decodeUnknownEffect(ProjectMemoryCompanionIntent);
const environmentId = "cleanup-environment";
const effectId = "cleanup-effect";
const memoryBytes = 16777216;

// Retained SQL custody only. The injected reconciler supplies observed native
// results; these cases do not launch a provider or establish native runtime proof.
const fixture = Effect.gen(function* () {
  const { binding: originalBinding, role } = yield* seed("investigator", "reserved");
  const sql = yield* SqlClient.SqlClient;
  const deadlineAtMs = 100000;
  const binding = { ...originalBinding, environmentId };
  const allocation: PiManagedProcessAllocation = {
    version: 1,
    unit: "t3-pi-managed-cleanup.service",
    nonce: "cleanup-nonce",
    policy: { memoryBytes, runtimeSeconds: 30 },
    launch: {
      workspaceRoot: "/fixture/workspace",
      workspaceAccess: "readonly",
      workspace: { path: "/fixture/workspace", dev: 1, ino: 1 },
      protectedRoots: [],
      protectedWorkspaceEntries: [],
      runtimeFiles: [],
      argv: [],
      memoryBytes,
      runtimeSeconds: 30,
    },
  };
  const configuration = {
    version: 1,
    extraction: {
      routeId: "fixture-extraction",
      credentialRef: "unused-extraction",
      maximumInputTokens: 1,
      maximumOutputTokens: 1,
      endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
    },
    embedding: {
      routeId: "fixture-embedding",
      credentialRef: "unused-embedding",
      maximumInputTokens: 1,
      maximumOutputTokens: 1,
      endpoint: "https://openrouter.ai/api/v1/embeddings",
    },
    companion: {
      executable: "/bin/python",
      scriptTarget: "/runtime/companion.py",
      storeRoot: "/fixture/store",
      runtimeFiles: [{ source: "/fixture/python", target: "/bin/python" }],
      memoryBytes,
    },
  };
  const operation = {
    version: 1,
    environmentId,
    projectId,
    taskId,
    bindingId: binding.recordId,
    generation: binding.generation,
    providerInstanceId: binding.providerInstanceId,
    threadId: binding.threadId,
    operationId: "cleanup-operation",
    workerId: "cleanup-worker",
    ordinal: 0,
    attemptId: binding.attemptId,
    rootBindingId: binding.recordId,
    rootTaskId: taskId,
    rootMaximumTokens: 100,
    rootDeadlineAtMs: deadlineAtMs,
    attemptMaximumTokens: binding.configuration.maxTokens,
    attemptDeadlineAtMs: deadlineAtMs,
    operationMaximumTokens: 100,
    operationDeadlineAtMs: deadlineAtMs,
    leaseDeadlineAtMs: deadlineAtMs,
    roleSha256: projectMemoryHash(role),
    configurationSha256: projectMemoryHash(binding.configuration),
    requestSha256: projectMemoryHash("original request"),
    allocation,
  };
  const selection = {
    kind: "comment",
    retainedId: "cleanup-comment",
    retainedRevision: 0,
    expectedSourceRecordRevision: 0,
    contentHash: projectMemoryHash("source"),
    expectedEffectRevision: 0,
    expectedClaimGeneration: 0,
    effectId,
    sourceRecordId: "cleanup-source",
    sourceRevision: 0,
    sourceGeneration: 0,
  };
  const request = {
    type: "project-team.memory.process",
    commandId: "cleanup-command",
    projectId,
    taskId,
    expectedRevision: 0,
    expectedTaskRevision: 0,
    specRevision: 0,
    planRevision: 0,
    selection,
  };
  const effect = {
    kind: "effect",
    recordId: effectId,
    effectId,
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "pending",
    effectKind: "memory-index",
    taskId,
    targetId: "cleanup-source",
    payload: { recordIds: [], expectedRevision: 0 },
    claimGeneration: 0,
    availableAt: at,
  };
  const fingerprint =
    "project-team-intent:" +
    projectMemoryHash({
      intent: request,
      actor: { kind: "agent", id: operation.workerId },
      source: { kind: "mcp", id: operation.workerId },
      managed: {
        projectId,
        bindingId: binding.recordId,
        generation: binding.generation,
        providerInstanceId: binding.providerInstanceId,
        threadId: binding.threadId,
      },
    });
  const intent = yield* decodeIntent({
    version: 1,
    invocationId: "cleanup-invocation",
    owner: {
      version: 1,
      operation,
      selection,
      request,
      admittedEffect: effect,
      commandId: request.commandId,
      intentFingerprint: fingerprint,
      actorId: operation.workerId,
      sourceKind: "mcp",
      sourceId: operation.workerId,
      admittedAt: at,
    },
    configuration,
    generation: 1,
    requestId: "cleanup-index",
    operation: "index",
    requestSha256: projectMemoryHash("original companion request"),
    configurationSha256: projectMemoryHash(configuration),
    deadlineAtMs,
    allocation,
  });
  const operationIntent = {
    binding,
    role,
    allocation,
    rootBudget: { rootTaskId: taskId, maximumTokens: 100, deadlineAtMs },
    operationLimits: { maximumTokens: 100, deadlineAtMs },
  };
  yield* sql`INSERT INTO project_team_pi_operation(operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    VALUES(${operation.operationId},${environmentId},${projectId},${binding.recordId},${binding.generation},${binding.providerInstanceId},${binding.threadId},${operation.workerId},0,'prompt',${operation.requestSha256},${binding.recordId},${taskId},100,${deadlineAtMs},'quarantine',${encode(operationIntent)})`;
  const eventId = "cleanup-admission-event";
  const event = {
    type: "project-work.foundation.recorded",
    eventId,
    projectId,
    revision: 1,
    occurredAt: at,
    record: intent.owner.admittedEffect,
  };
  const result = {
    projectId,
    revision: 1,
    receipt: {
      commandId: request.commandId,
      projectId,
      revision: 1,
      status: "accepted",
      eventCount: 1,
    },
    delta: { projectId, revision: 1, eventIds: [eventId], changedFields: ["foundationRecords"] },
  };
  yield* sql`INSERT INTO project_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
    VALUES(${eventId},${projectId},${event.type},${at},${request.commandId},${encode(event)})`;
  yield* sql`INSERT INTO project_work_command_receipts(project_id,command_id,payload_fingerprint,actor_kind,actor_id,source_kind,source_id,event_ids_json,created_at,result_json)
    VALUES(${projectId},${request.commandId},${fingerprint},'agent',${operation.workerId},'mcp',${operation.workerId},${encode([eventId])},${at},${encode(result)})`;
  yield* sql`INSERT INTO project_team_memory_job(effect_id,environment_id,project_id,input_json,claim_generation,status,owner_json)
    VALUES(${effectId},${environmentId},${projectId},'{}',1,'uncertain',${encode(intent.owner)})`;
  yield* sql`INSERT INTO project_memory_companion_invocation(invocation_id,environment_id,project_id,task_id,effect_id,request_id,generation,intent_json,phase)
    VALUES(${intent.invocationId},${environmentId},${projectId},${taskId},${effectId},${intent.requestId},1,${encode(intent)},'uncertain')`;
  yield* sql`INSERT INTO project_task_resource_budget VALUES(${environmentId},${projectId},${taskId},${deadlineAtMs},2147483648)`;
  yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
    VALUES(${allocation.unit},${allocation.nonce},${environmentId},${projectId},${taskId},'memory-companion',${intent.invocationId},${encode(allocation)},${memoryBytes},${deadlineAtMs})`;
  const owner: PiManagedProcessOwner = {
    type: "owner",
    unit: allocation.unit,
    nonce: allocation.nonce,
    invocation: "a".repeat(32),
    cgroup: `/sys/fs/cgroup/fixture/${allocation.unit}`,
    pid: 123,
    memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
  };
  const capture = Effect.gen(function* () {
    yield* sql`UPDATE project_memory_companion_invocation SET owner_json=${encode(owner)} WHERE invocation_id=${intent.invocationId}`;
    yield* sql`UPDATE project_task_resource_child SET owner_json=${encode(owner)} WHERE unit=${allocation.unit}`;
  });
  const receipt = {
    state: "drained" as const,
    unit: owner.unit,
    invocation: owner.invocation,
    cgroup: owner.cgroup,
    kernel: "populated 0\n",
  } satisfies PiManagedProcessReconciliation;
  const held = sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`;
  return { sql, intent, owner, receipt, capture, held };
});

for (const denial of [
  "Memory processing is disabled",
  "Memory processing is not configured",
  "Memory runtime is revoked",
])
  it.effect(`cleans exact retained ownership after forward admission fails: ${denial}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.capture;
        let admitted = true;
        let reconciliations = 0;
        const assertAdmission = Effect.suspend(() =>
          admitted ? Effect.void : Effect.fail(new ProjectMemoryServiceError({ reason: denial })),
        );
        const companion = yield* makeProjectMemoryCompanion({
          environmentId,
          protectedRoots: [],
          assertAdmission,
          allocate: () => Effect.die("Cleanup must not allocate"),
          launch: () => Effect.die("Cleanup must not launch"),
          reconcile: (original, options) =>
            Effect.sync(() => {
              reconciliations++;
              expect(original).toEqual({
                allocation: f.intent.allocation,
                activation: "owned",
                owner: f.owner,
              });
              expect(options).toEqual({ stop: true });
              return f.receipt;
            }),
        });
        yield* assertAdmission;
        admitted = false;
        expect(yield* f.held).toEqual([{ held: memoryBytes }]);
        yield* companion.cleanup(effectId);
        expect(yield* f.held).toEqual([{ held: null }]);
        expect(
          yield* f.sql`SELECT phase,drain_json AS drain FROM project_memory_companion_invocation`,
        ).toEqual([{ phase: "drained", drain: encode(f.receipt) }]);
        expect(
          yield* companion
            .companion(f.intent.owner, f.intent.configuration, new Uint8Array([1]), Effect.void)
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { message: denial } });
        yield* companion.cleanup(effectId);
        expect(reconciliations).toBe(1);
      }),
    ),
  );

it.effect("refuses uncaptured ownership after admission is revoked and keeps capacity held", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const companion = yield* makeProjectMemoryCompanion({
        environmentId,
        protectedRoots: [],
        assertAdmission: Effect.fail(new ProjectMemoryServiceError({ reason: "Runtime revoked" })),
        reconcile: () => Effect.die("An uncaptured process cannot be reconciled"),
      });
      const before = yield* f.sql`SELECT * FROM project_memory_companion_invocation`;
      expect(yield* companion.cleanup(effectId).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "Uncaptured companion retains capacity until genuine owner evidence exists",
        },
      });
      expect(yield* f.sql`SELECT * FROM project_memory_companion_invocation`).toEqual(before);
      expect(yield* f.held).toEqual([{ held: memoryBytes }]);
    }),
  ),
);

for (const invalid of [
  "unit",
  "invocation",
  "cgroup",
  "populated",
  "missing-kernel",
  "unavailable",
] as const)
  it.effect(`keeps capacity after revoked admission when reconciliation is ${invalid}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.capture;
        const receipt = {
          ...f.receipt,
          ...(invalid === "unit" ? { unit: "foreign.service" } : {}),
          ...(invalid === "invocation" ? { invocation: "b".repeat(32) } : {}),
          ...(invalid === "cgroup" ? { cgroup: "/sys/fs/cgroup/foreign" } : {}),
          ...(invalid === "populated" ? { kernel: "populated 1\n" } : {}),
          ...(invalid === "missing-kernel" ? { kernel: "" } : {}),
        };
        let reconciled = false;
        const companion = yield* makeProjectMemoryCompanion({
          environmentId,
          protectedRoots: [],
          assertAdmission: Effect.fail(
            new ProjectMemoryServiceError({ reason: "Runtime revoked" }),
          ),
          reconcile: () =>
            Effect.gen(function* () {
              reconciled = true;
              if (invalid === "unavailable")
                return yield* new PiManagedProcessError({
                  phase: "quarantine",
                  message: "Kernel observation unavailable",
                });
              return receipt;
            }),
        });
        const before = yield* f.sql`SELECT * FROM project_memory_companion_invocation`;
        expect(yield* companion.cleanup(effectId).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(reconciled).toBe(true);
        expect(yield* f.sql`SELECT * FROM project_memory_companion_invocation`).toEqual(before);
        expect(yield* f.held).toEqual([{ held: memoryBytes }]);
      }),
    ),
  );
