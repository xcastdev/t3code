import {
  canonicalProjectWorkPayload,
  ProjectTeamRunBinding,
  ProjectVerificationJobManifest,
  ProjectTeamGate,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PiManagedProcessAllocationSchema,
  PiManagedProcessError,
  type PiManagedDrain,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
  type PiManagedProcessReconciliation,
} from "../provider/pi/PiManagedProcess.ts";

export const PROJECT_TASK_MEMORY_BYTES = 2_147_483_648;
const encode = canonicalProjectWorkPayload;
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Intent = Schema.Struct({
  binding: ProjectTeamRunBinding,
  allocation: PiManagedProcessAllocationSchema,
  rootBudget: Schema.Struct({
    rootTaskId: Schema.String,
    maximumTokens: Positive,
    deadlineAtMs: Positive,
  }),
  operationLimits: Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive }),
});
const decodeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
);
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent));
const decodeSetupIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.Struct({ setupId: Schema.String, dispatchId: Schema.String }),
      compiledClaim: Schema.Struct({
        transition: Schema.Struct({
          kind: Schema.Literal("claim"),
          binding: ProjectTeamRunBinding,
        }),
      }),
      limits: Schema.Struct({
        rootTaskId: Schema.String,
        rootDeadlineAtMs: Positive,
        deadlineAtMs: Positive,
      }),
    }),
  ),
);
const decodeSetupInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      setupId: Schema.String,
      bindingId: Schema.String,
      generation: Schema.Int,
      threadId: Schema.String,
      worktreePath: Schema.String,
      deadlineAtMs: Positive,
    }),
  ),
);

const decodeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Schema.String,
      nonce: Schema.String,
      invocation: Schema.String,
      cgroup: Schema.String,
      pid: Positive,
      memoryBytes: Positive,
      swapBytes: Schema.Literal(0),
      oomGroup: Schema.Literal(1),
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeCleanupVerificationIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      allocation: PiManagedProcessAllocationSchema,
      deadlineAtMs: Positive,
      receipt: Schema.Struct({
        manifest: ProjectVerificationJobManifest,
        sha256: Schema.String,
      }),
      gate: ProjectTeamGate,
    }),
  ),
);
const decodeVerificationIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      allocation: PiManagedProcessAllocationSchema,
      receipt: Schema.Struct({
        manifest: Schema.Struct({
          environmentId: Schema.String,
          projectId: Schema.String,
          taskId: Schema.String,
          dispatchId: Schema.String,
          bindingId: Schema.String,
          generation: Schema.Int,
        }),
      }),
    }),
  ),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encode(value)).digest("hex");
const decodeCleanupPiIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...Intent.fields,
      request: Schema.Unknown,
    }),
  ),
);
const decodeCleanupPiRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    kind: Schema.String,
    threadId: Schema.String,
    operationId: Schema.optionalKey(Schema.String),
  }),
);
const deny = (message: string) => new PiManagedProcessError({ phase: "quarantine", message });
const isProcessError = Schema.is(PiManagedProcessError);
type Child = {
  unit: string;
  nonce: string;
  environment_id: string;
  project_id: string;
  task_id: string;
  authority_kind: "pi" | "verification" | "setup" | "memory-companion";
  authority_id: string;
  allocation_json: string;
  memory_bytes: number;
  deadline_at_ms: number;
  owner_json: string | null;
  drain_json: string | null;
};

/** Private journal seam. Journals validate current approval in the same transaction.
 * Owner and partition come from their durable rows, never caller-supplied task IDs.
 */
export const makeProjectTaskResources = Effect.fn("makeProjectTaskResources")(function* (
  environmentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const transaction = Effect.gen(function* () {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* deny("Task resource ownership requires the journal transaction");
  });
  const bind = (
    kind: "pi" | "verification" | "setup" | "memory-companion",
    id: string,
    supplied: PiManagedProcessAllocation,
  ) => {
    const allocation = structuredClone(supplied);
    const identity = Effect.fn("ProjectTaskResources.identity")(function* (cleanup = false) {
      yield* transaction;
      if (kind === "memory-companion") {
        const rows = yield* sql<{
          project_id: string;
          task_id: string;
          effect_id: string;
          request_id: string;
          generation: number;
          phase: string;
          intent: string | null;
        }>`SELECT CASE WHEN length(CAST(project_id AS BLOB))<=1024 THEN project_id END AS project_id,
          CASE WHEN length(CAST(task_id AS BLOB))<=1024 THEN task_id END AS task_id,
          CASE WHEN length(CAST(effect_id AS BLOB))<=1024 THEN effect_id END AS effect_id,
          CASE WHEN length(CAST(request_id AS BLOB))<=1024 THEN request_id END AS request_id,
          CASE WHEN typeof(generation)='integer' THEN generation END AS generation,
          CASE WHEN length(CAST(phase AS BLOB))<=32 THEN phase END AS phase,
          CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent
          FROM project_memory_companion_invocation WHERE environment_id=${environmentId} AND invocation_id=${id} LIMIT 2`;
        const row = rows[0];
        if (rows.length !== 1 || !row?.intent)
          return yield* deny("Original companion resource authority unavailable");
        const { decodeProjectMemoryCompanionIntent } = yield* Effect.promise(
          () => import("./memory/ProjectMemoryCompanionJournal.ts"),
        );
        const { auditProjectMemoryTaskOwner, auditProjectMemoryAdmission } = yield* Effect.promise(
          () => import("./memory/ProjectMemoryModelAccounting.ts"),
        );
        const intent = yield* decodeProjectMemoryCompanionIntent(row.intent);
        const owner = intent.owner;
        const operation = owner.operation;
        if (
          intent.invocationId !== id ||
          operation.environmentId !== environmentId ||
          operation.projectId !== row.project_id ||
          operation.taskId !== row.task_id ||
          owner.admittedEffect.effectId !== row.effect_id ||
          intent.requestId !== row.request_id ||
          intent.generation !== row.generation ||
          encode(intent.allocation) !== encode(allocation)
        )
          return yield* deny("Original companion resource identity changed");
        yield* auditProjectMemoryTaskOwner(sql, operation);
        if (owner.version === 1) yield* auditProjectMemoryAdmission(sql, owner);
        else {
          const { auditProjectMemoryQueryAdmission } = yield* Effect.promise(
            () => import("./memory/ProjectMemoryQuery.ts"),
          );
          yield* auditProjectMemoryQueryAdmission(sql, owner);
        }
        return {
          projectId: row.project_id,
          taskId: operation.rootTaskId,
          logicalTaskId: row.task_id,
          taskDeadline: operation.rootDeadlineAtMs,
          deadline: intent.deadlineAtMs,
          active: ["prepared", "activating", "owned"].includes(row.phase),
        };
      }
      if (kind === "pi") {
        const rows = yield* sql<{
          project_id: string;
          binding_id: string;
          generation: number;
          root_task_id: string;
          intent: string | null;
          deadline_at_ms: number;
          status: string;
        }>`SELECT project_id,binding_id,generation,root_task_id,deadline_at_ms,status,
          CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent
          FROM project_team_pi_operation WHERE environment_id=${environmentId} AND operation_id=${id} LIMIT 2`;
        const row = rows[0];
        if (rows.length !== 1 || !row?.intent)
          return yield* deny("Original Pi resource authority unavailable");
        const intent = yield* decodeIntent(row.intent);
        if (
          intent.binding.environmentId !== environmentId ||
          intent.binding.projectId !== row.project_id ||
          intent.binding.recordId !== row.binding_id ||
          intent.binding.generation !== row.generation ||
          intent.rootBudget.rootTaskId !== row.root_task_id ||
          intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
          encode(intent.allocation) !== encode(allocation)
        )
          return yield* deny("Original Pi resource allocation changed");
        return {
          projectId: row.project_id,
          taskId: intent.rootBudget.rootTaskId,
          logicalTaskId: intent.binding.taskId,
          taskDeadline: intent.rootBudget.deadlineAtMs,
          deadline: row.deadline_at_ms,
          active: ["prepared", "starting", "running"].includes(row.status),
        };
      }
      if (kind === "setup") {
        const rows = yield* sql<{
          project_id: string;
          dispatch_id: string;
          binding_id: string;
          generation: number;
          task_id: string;
          root_task_id: string;
          root_deadline_at_ms: number;
          stage: string;
          status: string;
          allocation: string | null;
          input: string | null;
          intent: string | null;
        }>`SELECT
          d.project_id,d.dispatch_id,d.binding_id,d.generation,d.task_id,d.root_task_id,d.root_deadline_at_ms,d.stage,s.status,
          CASE WHEN length(CAST(s.allocation_json AS BLOB))<=262144 THEN s.allocation_json END AS allocation,
          CASE WHEN length(CAST(s.input_json AS BLOB))<=262144 THEN s.input_json END AS input,
          CASE WHEN length(CAST(d.intent_json AS BLOB))<=1048576 THEN d.intent_json END AS intent
          FROM project_team_setup_process s JOIN project_team_dispatch d ON d.dispatch_id=s.dispatch_id
          WHERE d.environment_id=${environmentId} AND s.setup_id=${id} LIMIT 2`;
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row?.allocation ||
          (!cleanup && !row.input) ||
          !row.intent ||
          encode(yield* decodeAllocation(row.allocation)) !== encode(allocation)
        )
          return yield* deny("Original setup resource allocation unavailable");
        const intent = yield* decodeSetupIntent(row.intent);
        const binding = intent.compiledClaim.transition.binding;
        if (
          binding.environmentId !== environmentId ||
          binding.projectId !== row.project_id ||
          binding.recordId !== row.binding_id ||
          binding.generation !== row.generation ||
          binding.taskId !== row.task_id ||
          intent.limits.rootTaskId !== row.root_task_id ||
          intent.limits.rootDeadlineAtMs !== row.root_deadline_at_ms ||
          intent.request.dispatchId !== row.dispatch_id ||
          intent.request.setupId !== id
        )
          return yield* deny("Original setup task resource authority changed");
        if (!cleanup) {
          if (!row.input) return yield* deny("Original setup launch input unavailable");
          const input = yield* decodeSetupInput(row.input);
          if (
            input.setupId !== id ||
            input.bindingId !== binding.recordId ||
            input.generation !== binding.generation ||
            input.threadId !== binding.threadId ||
            input.worktreePath !== binding.worktree ||
            input.deadlineAtMs !== intent.limits.deadlineAtMs
          )
            return yield* deny("Original setup task resource authority changed");
        }
        return {
          projectId: row.project_id,
          taskId: intent.limits.rootTaskId,
          logicalTaskId: binding.taskId,
          taskDeadline: intent.limits.rootDeadlineAtMs,
          deadline: intent.limits.deadlineAtMs,
          active:
            ["allocated", "claimed", "captured"].includes(row.status) &&
            row.stage === "workspace-ready",
        };
      }
      const rows = yield* sql<{
        project_id: string;
        task_id: string;
        deadline_at_ms: number;
        phase: string;
        intent: string | null;
      }>`SELECT project_id,task_id,deadline_at_ms,phase,
        CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json END AS intent
        FROM project_work_verification_execution WHERE environment_id=${environmentId} AND attempt_id=${id} LIMIT 2`;
      const row = rows[0];
      if (rows.length !== 1 || !row?.intent)
        return yield* deny("Original verification resource allocation changed");
      const intent = yield* decodeVerificationIdentity(row.intent);
      const manifest = intent.receipt.manifest;
      if (
        manifest.environmentId !== environmentId ||
        manifest.projectId !== row.project_id ||
        manifest.taskId !== row.task_id ||
        encode(intent.allocation) !== encode(allocation)
      )
        return yield* deny("Original verification resource identity changed");
      const dispatches = yield* sql<{
        task_id: string;
        binding_id: string;
        generation: number;
        root_task_id: string;
        root_deadline_at_ms: number;
        intent: string | null;
      }>`SELECT task_id,binding_id,generation,root_task_id,root_deadline_at_ms,
        CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent
        FROM project_team_dispatch WHERE dispatch_id=${manifest.dispatchId}
        AND environment_id=${environmentId} AND project_id=${row.project_id} LIMIT 2`;
      const dispatch = dispatches[0];
      // Historical cleanup authenticates the full immutable verification intent separately.
      // It needs no new dispatch or aggregate budget to release its original child partition.
      if (cleanup && dispatches.length === 0)
        return {
          projectId: row.project_id,
          taskId: row.task_id,
          logicalTaskId: row.task_id,
          taskDeadline: row.deadline_at_ms,
          deadline: row.deadline_at_ms,
          active: false,
        };
      if (dispatches.length !== 1 || !dispatch?.intent)
        return yield* deny("Verification requires its original dispatch resource authority");
      const original = yield* decodeSetupIntent(dispatch.intent);
      const binding = original.compiledClaim.transition.binding;
      if (
        dispatch.task_id !== row.task_id ||
        dispatch.binding_id !== manifest.bindingId ||
        dispatch.generation !== manifest.generation ||
        binding.environmentId !== environmentId ||
        binding.projectId !== row.project_id ||
        binding.taskId !== row.task_id ||
        binding.recordId !== manifest.bindingId ||
        binding.generation !== manifest.generation ||
        original.limits.rootTaskId !== dispatch.root_task_id ||
        original.limits.rootDeadlineAtMs !== dispatch.root_deadline_at_ms ||
        original.request.dispatchId !== manifest.dispatchId
      )
        return yield* deny("Original verification dispatch resource authority changed");
      return {
        projectId: row.project_id,
        taskId: original.limits.rootTaskId,
        logicalTaskId: row.task_id,
        taskDeadline: original.limits.rootDeadlineAtMs,
        deadline: row.deadline_at_ms,
        active: ["claimed", "activating", "owner-captured"].includes(row.phase),
      };
    });
    const retained = Effect.fn("ProjectTaskResources.retained")(function* (cleanup = false) {
      const authority = yield* identity(cleanup);
      const rows =
        yield* sql<Child>`SELECT unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,memory_bytes,deadline_at_ms,
        CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json END AS allocation_json,
        CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json END AS owner_json,
        CASE WHEN length(CAST(drain_json AS BLOB))<=262144 THEN drain_json END AS drain_json
        FROM project_task_resource_child WHERE unit=${allocation.unit} LIMIT 2`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.environment_id !== environmentId ||
        row.project_id !== authority.projectId ||
        (row.task_id !== authority.taskId &&
          (!cleanup || row.task_id !== authority.logicalTaskId)) ||
        row.authority_kind !== kind ||
        row.authority_id !== id ||
        row.nonce !== allocation.nonce ||
        row.allocation_json !== encode(allocation) ||
        row.memory_bytes !== allocation.policy.memoryBytes ||
        row.deadline_at_ms !== Math.min(authority.taskDeadline, authority.deadline)
      )
        return yield* deny("Original task child reservation unavailable or changed");
      return { row, authority };
    });
    const assertBudget = (authority: { projectId: string; taskId: string; taskDeadline: number }) =>
      Effect.gen(function* () {
        const budgets = yield* sql<{
          deadline_at_ms: number;
          memory_bytes: number;
        }>`SELECT deadline_at_ms,memory_bytes
        FROM project_task_resource_budget WHERE environment_id=${environmentId} AND project_id=${authority.projectId} AND task_id=${authority.taskId} LIMIT 2`;
        if (
          budgets.length !== 1 ||
          budgets[0]?.deadline_at_ms !== authority.taskDeadline ||
          budgets[0].memory_bytes !== PROJECT_TASK_MEMORY_BYTES
        )
          return yield* deny("Original task resource budget cannot change or renew");
      });
    const matchesOwner = (row: Child, owner: PiManagedProcessOwner) =>
      owner.unit === row.unit &&
      owner.nonce === row.nonce &&
      owner.memoryBytes === row.memory_bytes &&
      owner.swapBytes === 0 &&
      owner.oomGroup === 1 &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid >= 1 &&
      /^[a-f0-9]{32}$/u.test(owner.invocation) &&
      owner.cgroup.startsWith("/sys/fs/cgroup/") &&
      owner.cgroup.endsWith("/" + row.unit) &&
      !owner.cgroup.split("/").some((part) => part === "." || part === "..") &&
      (row.owner_json === null || row.owner_json === encode(owner));
    const assertOwned = (owner: PiManagedProcessOwner) =>
      Effect.gen(function* () {
        const { row, authority } = yield* retained();
        yield* assertBudget(authority);
        const deleted =
          yield* sql`SELECT 1 FROM project_lifecycle WHERE project_id=${authority.projectId} AND state='tombstoned' LIMIT 1`;
        if (
          deleted.length ||
          !authority.active ||
          authority.deadline > authority.taskDeadline ||
          (yield* Clock.currentTimeMillis) >= row.deadline_at_ms ||
          row.drain_json !== null ||
          row.owner_json === null ||
          !matchesOwner(row, owner)
        )
          return yield* deny("Task child ownership is absent, changed or expired");
      });
    const reserve = Effect.gen(function* () {
      const authority = yield* identity();
      const deleted =
        yield* sql`SELECT 1 FROM project_lifecycle WHERE project_id=${authority.projectId} AND state='tombstoned' LIMIT 1`;
      if (deleted.length) return yield* deny("Deleted project cannot acquire task resources");
      const now = yield* Clock.currentTimeMillis;
      const deadline = Math.min(authority.taskDeadline, authority.deadline);
      if (
        !authority.active ||
        authority.deadline > authority.taskDeadline ||
        now >= deadline ||
        allocation.unit !== `t3-pi-managed-${allocation.nonce}.service` ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          allocation.nonce,
        ) ||
        allocation.policy.memoryBytes !== allocation.launch.memoryBytes ||
        allocation.policy.runtimeSeconds !== allocation.launch.runtimeSeconds
      )
        return yield* deny("Task child reservation is inactive, expired or inconsistent");
      if (kind === "pi" || kind === "setup")
        yield* sql`INSERT OR IGNORE INTO project_task_resource_budget VALUES(${environmentId},${authority.projectId},${authority.taskId},${authority.taskDeadline},${PROJECT_TASK_MEMORY_BYTES})`;
      yield* assertBudget(authority);
      const unaccountedMemory = yield* sql`SELECT 1 FROM project_memory_companion_invocation m
        WHERE m.environment_id=${environmentId} AND m.project_id=${authority.projectId}
        AND (json_extract(m.intent_json,'$.owner.operation.rootTaskId')=${authority.taskId}
          OR m.task_id=${authority.taskId} OR EXISTS
            (SELECT 1 FROM project_team_dispatch d WHERE d.environment_id=m.environment_id
             AND d.project_id=m.project_id AND d.task_id=m.task_id AND d.root_task_id=${authority.taskId}))
        AND m.phase IN ('activating','owned','uncertain') AND m.drain_json IS NULL AND NOT EXISTS
          (SELECT 1 FROM project_task_resource_child c WHERE c.unit=json_extract(m.intent_json,'$.allocation.unit')
           AND c.environment_id=m.environment_id AND c.project_id=m.project_id
           AND (c.task_id=${authority.taskId} OR (c.task_id=m.task_id AND c.drain_json IS NOT NULL))
           AND c.authority_kind='memory-companion' AND c.authority_id=m.invocation_id
           AND (c.drain_json IS NULL OR c.owner_json=m.owner_json)
           AND c.nonce=json_extract(m.intent_json,'$.allocation.nonce') AND c.allocation_json=json_extract(m.intent_json,'$.allocation')) LIMIT 1`;
      const unaccountedPi = yield* sql`SELECT 1 FROM project_team_pi_process p
        JOIN project_team_pi_operation o ON o.operation_id=p.operation_id
        WHERE o.environment_id=${environmentId} AND o.project_id=${authority.projectId}
        AND o.root_task_id=${authority.taskId}
        AND p.status IN ('claimed','captured','quarantine') AND NOT EXISTS
          (SELECT 1 FROM project_task_resource_child c WHERE c.unit=p.unit AND c.environment_id=o.environment_id
           AND c.project_id=o.project_id
           AND (c.task_id=${authority.taskId} OR (c.task_id=json_extract(o.intent_json,'$.binding.taskId') AND c.drain_json IS NOT NULL))
           AND c.authority_kind='pi' AND c.authority_id=o.operation_id
           AND (c.drain_json IS NULL OR c.owner_json=p.owner_json)
           AND c.nonce=json_extract(p.allocation_json,'$.nonce') AND c.allocation_json=p.allocation_json) LIMIT 1`;
      const unaccountedVerification = yield* sql`SELECT 1 FROM project_work_verification_execution v
        WHERE v.environment_id=${environmentId} AND v.project_id=${authority.projectId}
        AND (v.task_id=${authority.taskId} OR EXISTS
          (SELECT 1 FROM project_team_dispatch d WHERE d.environment_id=v.environment_id
           AND d.project_id=v.project_id AND d.task_id=v.task_id AND d.root_task_id=${authority.taskId}
           AND d.dispatch_id=json_extract(v.intent_json,'$.receipt.manifest.dispatchId')
           AND d.binding_id=json_extract(v.intent_json,'$.receipt.manifest.bindingId')
           AND d.generation=json_extract(v.intent_json,'$.receipt.manifest.generation'))
          OR NOT EXISTS (SELECT 1 FROM project_team_dispatch d WHERE d.environment_id=v.environment_id
           AND d.project_id=v.project_id AND d.task_id=v.task_id
           AND d.dispatch_id=json_extract(v.intent_json,'$.receipt.manifest.dispatchId')
           AND d.binding_id=json_extract(v.intent_json,'$.receipt.manifest.bindingId')
           AND d.generation=json_extract(v.intent_json,'$.receipt.manifest.generation')))
        AND v.phase IN ('activating','owner-captured','quarantine') AND NOT EXISTS
          (SELECT 1 FROM project_task_resource_child c WHERE c.unit=json_extract(v.intent_json,'$.allocation.unit')
           AND c.environment_id=v.environment_id AND c.project_id=v.project_id
           AND (c.task_id=${authority.taskId} OR (c.task_id=v.task_id AND c.drain_json IS NOT NULL))
           AND c.authority_kind='verification' AND c.authority_id=v.attempt_id
           AND (c.drain_json IS NULL OR c.owner_json=v.owner_json)
           AND c.nonce=json_extract(v.intent_json,'$.allocation.nonce')
           AND c.allocation_json=json_extract(v.intent_json,'$.allocation')) LIMIT 1`;
      const unaccountedSetup = yield* sql`SELECT 1 FROM project_team_setup_process s
        JOIN project_team_dispatch d ON d.dispatch_id=s.dispatch_id
        WHERE d.environment_id=${environmentId} AND d.project_id=${authority.projectId}
        AND d.root_task_id=${authority.taskId}
        AND s.status IN ('claimed','captured','uncertain') AND s.activation!='unlaunched'
        AND NOT EXISTS (SELECT 1 FROM project_task_resource_child c WHERE c.unit=s.unit
          AND c.environment_id=d.environment_id AND c.project_id=d.project_id
          AND (c.task_id=${authority.taskId} OR (c.task_id=d.task_id AND c.drain_json IS NOT NULL))
          AND c.authority_kind='setup' AND c.authority_id=s.setup_id
          AND (c.drain_json IS NULL OR c.owner_json=s.owner_json)
          AND c.nonce=json_extract(s.allocation_json,'$.nonce') AND c.allocation_json=s.allocation_json) LIMIT 1`;
      // Old descendant partitions remain immutable. Even unactivated reservations hold
      // capacity until their exact owner drains; they cannot be ignored by the root sum.
      const historicalChildren = yield* sql`SELECT 1 FROM project_task_resource_child c
        WHERE c.environment_id=${environmentId} AND c.project_id=${authority.projectId}
        AND c.task_id!=${authority.taskId} AND c.drain_json IS NULL AND (
          EXISTS (SELECT 1 FROM project_team_dispatch d WHERE d.environment_id=c.environment_id
            AND d.project_id=c.project_id AND d.task_id=c.task_id AND d.root_task_id=${authority.taskId})
          OR EXISTS (SELECT 1 FROM project_team_pi_operation o WHERE c.authority_kind='pi'
            AND o.environment_id=c.environment_id AND o.project_id=c.project_id
            AND o.operation_id=c.authority_id AND o.root_task_id=${authority.taskId})
          OR EXISTS (SELECT 1 FROM project_memory_companion_invocation m WHERE c.authority_kind='memory-companion'
            AND m.environment_id=c.environment_id AND m.project_id=c.project_id
            AND m.invocation_id=c.authority_id
            AND json_extract(m.intent_json,'$.owner.operation.rootTaskId')=${authority.taskId})
          OR (
            NOT EXISTS (SELECT 1 FROM project_team_dispatch d WHERE d.environment_id=c.environment_id
              AND d.project_id=c.project_id AND d.task_id=c.task_id)
            AND NOT EXISTS (SELECT 1 FROM project_team_pi_operation o WHERE c.authority_kind='pi'
              AND o.environment_id=c.environment_id AND o.project_id=c.project_id AND o.operation_id=c.authority_id)
            AND NOT EXISTS (SELECT 1 FROM project_memory_companion_invocation m WHERE c.authority_kind='memory-companion'
              AND m.environment_id=c.environment_id AND m.project_id=c.project_id AND m.invocation_id=c.authority_id)
          )
        ) LIMIT 1`;
      if (
        unaccountedPi.length ||
        unaccountedVerification.length ||
        unaccountedSetup.length ||
        unaccountedMemory.length ||
        historicalChildren.length
      )
        return yield* deny("Original task contains an unaccounted native child");
      const exists =
        yield* sql`SELECT 1 FROM project_task_resource_child WHERE unit=${allocation.unit} OR nonce=${allocation.nonce} LIMIT 2`;
      if (exists.length) {
        const { row } = yield* retained();
        if (row.drain_json !== null) return yield* deny("Drained task child cannot reactivate");
        return row.deadline_at_ms;
      }
      yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES(${allocation.unit},${allocation.nonce},${environmentId},${authority.projectId},${authority.taskId},${kind},${id},${encode(allocation)},${allocation.policy.memoryBytes},${deadline})`;
      return (yield* retained()).row.deadline_at_ms;
    });
    const capture = (owner: PiManagedProcessOwner, cleanup = false) =>
      Effect.gen(function* () {
        const { row, authority } = yield* retained(cleanup);
        const deleted =
          yield* sql`SELECT 1 FROM project_lifecycle WHERE project_id=${authority.projectId} AND state='tombstoned' LIMIT 1`;
        if (kind !== "setup" && !cleanup && deleted.length)
          return yield* deny("Deleted project cannot activate task resources");
        if (
          (kind !== "setup" &&
            !cleanup &&
            (!authority.active || (yield* Clock.currentTimeMillis) >= row.deadline_at_ms)) ||
          row.drain_json !== null ||
          !matchesOwner(row, owner)
        )
          return yield* deny("Task child captured owner differs or expired");
        yield* sql`UPDATE project_task_resource_child SET owner_json=${encode(owner)} WHERE unit=${row.unit}`;
      });
    const drain = (receipt: PiManagedDrain | PiManagedProcessReconciliation, cleanup = false) =>
      Effect.gen(function* () {
        const { row } = yield* retained(cleanup);
        if (!row.owner_json) return yield* deny("Uncaptured task child cannot release capacity");
        const owner = yield* decodeOwner(row.owner_json);
        if (
          receipt.unit !== row.unit ||
          receipt.invocation !== owner.invocation ||
          receipt.cgroup !== owner.cgroup ||
          (receipt.kernel !== "removed" && !receipt.kernel.split("\n").includes("populated 0")) ||
          ("state" in receipt
            ? receipt.state !== "drained"
            : receipt.ownerPid !== owner.pid ||
              receipt.memoryBytes !== row.memory_bytes ||
              receipt.swapBytes !== 0 ||
              receipt.oomGroup !== 1)
        )
          return yield* deny("Task child capacity requires its exact captured kernel drain");
        // A later reconciliation proves the same drain with fewer fields. Retain the first receipt.
        if (row.drain_json === null)
          yield* sql`UPDATE project_task_resource_child SET drain_json=${encode(receipt)} WHERE unit=${row.unit}`;
      });
    const cleanupOwner = Effect.gen(function* () {
      yield* transaction;
      let original: string | null | undefined;
      if (kind === "memory-companion") {
        yield* identity(true);
        const rows = yield* sql<{
          owner: string | null;
        }>`SELECT CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json END AS owner
          FROM project_memory_companion_invocation WHERE environment_id=${environmentId} AND invocation_id=${id} LIMIT 2`;
        if (rows.length !== 1 || !rows[0]?.owner)
          return yield* deny("Original companion cleanup owner unavailable");
        original = rows[0].owner;
      } else if (kind === "verification") {
        // Legacy verification has no aggregate budget. Cleanup audits its original journal directly.
        const rows = yield* sql<{
          project_id: string;
          task_id: string;
          job_id: string;
          deadline_at_ms: number;
          intent: string | null;
          intent_hash: string;
          allocation_hash: string;
          manifest_hash: string;
          gate_id: string;
          gate_revision: number;
          owner: string | null;
        }>`SELECT project_id,task_id,job_id,deadline_at_ms,intent_hash,allocation_hash,manifest_hash,gate_id,gate_revision,
          CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN intent_json END AS intent,
          CASE WHEN length(CAST(owner_json AS BLOB))<=16384 THEN owner_json END AS owner
          FROM project_work_verification_execution WHERE environment_id=${environmentId} AND attempt_id=${id} LIMIT 2`;
        const row = rows[0];
        if (rows.length !== 1 || !row?.intent)
          return yield* deny("Original verification cleanup authority unavailable");
        const intent = yield* decodeCleanupVerificationIntent(row.intent);
        const manifest = intent.receipt.manifest;
        const raw = yield* decodeJson(row.intent);
        if (
          manifest.environmentId !== environmentId ||
          manifest.projectId !== row.project_id ||
          manifest.taskId !== row.task_id ||
          manifest.jobId !== row.job_id ||
          intent.deadlineAtMs !== row.deadline_at_ms ||
          intent.receipt.sha256 !== row.manifest_hash ||
          hash(manifest) !== row.manifest_hash ||
          intent.gate.recordId !== row.gate_id ||
          intent.gate.revision !== row.gate_revision ||
          hash(raw) !== row.intent_hash ||
          hash(allocation) !== row.allocation_hash ||
          encode(intent.allocation) !== encode(allocation)
        )
          return yield* deny("Original verification cleanup allocation changed");
        original = row.owner;
      } else {
        yield* identity(true);
        if (kind === "pi") {
          const rows = yield* sql<{
            provider_instance_id: string;
            thread_id: string;
            operation_kind: string;
            root_task_id: string;
            maximum_tokens: number;
            request_hash: string;
            intent: string | null;
          }>`SELECT provider_instance_id,thread_id,operation_kind,root_task_id,maximum_tokens,request_hash,
            CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent
            FROM project_team_pi_operation WHERE environment_id=${environmentId} AND operation_id=${id} LIMIT 2`;
          const row = rows[0];
          if (rows.length !== 1 || !row?.intent)
            return yield* deny("Original Pi cleanup authority unavailable");
          const intent = yield* decodeCleanupPiIntent(row.intent);
          const request = yield* decodeCleanupPiRequest(intent.request);
          if (
            row.provider_instance_id !== intent.binding.providerInstanceId ||
            row.thread_id !== intent.binding.threadId ||
            request.threadId !== row.thread_id ||
            request.kind !== row.operation_kind ||
            row.root_task_id !== intent.rootBudget.rootTaskId ||
            row.maximum_tokens !== intent.operationLimits.maximumTokens ||
            (request.operationId !== undefined &&
              (request.operationId !== id || hash(intent.request) !== row.request_hash))
          )
            return yield* deny("Original Pi cleanup request or limits changed");
        }
        const rows =
          kind === "pi"
            ? yield* sql<{ owner: string | null; allocation: string | null }>`SELECT
              CASE WHEN length(CAST(p.owner_json AS BLOB))<=16384 THEN p.owner_json END AS owner,
              CASE WHEN length(CAST(p.allocation_json AS BLOB))<=262144 THEN p.allocation_json END AS allocation
              FROM project_team_pi_process p JOIN project_team_pi_operation o ON o.operation_id=p.operation_id
              WHERE o.environment_id=${environmentId} AND o.operation_id=${id} AND p.unit=${allocation.unit} LIMIT 2`
            : yield* sql<{ owner: string | null; allocation: string | null }>`SELECT
              CASE WHEN length(CAST(s.owner_json AS BLOB))<=16384 THEN s.owner_json END AS owner,
              CASE WHEN length(CAST(s.allocation_json AS BLOB))<=262144 THEN s.allocation_json END AS allocation
              FROM project_team_setup_process s JOIN project_team_dispatch d ON d.dispatch_id=s.dispatch_id
              WHERE d.environment_id=${environmentId} AND s.setup_id=${id} AND s.unit=${allocation.unit} AND s.activation='owned' LIMIT 2`;
        if (
          rows.length !== 1 ||
          !rows[0]?.allocation ||
          encode(yield* decodeAllocation(rows[0].allocation)) !== encode(allocation)
        )
          return yield* deny("Original native cleanup allocation unavailable");
        original = rows[0].owner;
      }
      if (!original) return yield* deny("Original captured cleanup owner unavailable");
      const owner = yield* decodeOwner(original);
      if (
        owner.unit !== allocation.unit ||
        owner.nonce !== allocation.nonce ||
        owner.memoryBytes !== allocation.policy.memoryBytes ||
        !/^[a-f0-9]{32}$/u.test(owner.invocation) ||
        !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
        !owner.cgroup.endsWith("/" + owner.unit) ||
        owner.cgroup.split("/").some((part) => part === "." || part === "..")
      )
        return yield* deny("Original captured cleanup owner changed");
      return owner;
    });
    const cleanupChild = Effect.gen(function* () {
      const rows =
        yield* sql`SELECT unit FROM project_task_resource_child WHERE unit=${allocation.unit} OR nonce=${allocation.nonce} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Native cleanup resource identity is ambiguous");
      return yield* retained(true);
    });
    const captureCleanup = (owner: PiManagedProcessOwner) =>
      Effect.gen(function* () {
        const original = yield* cleanupOwner;
        if (encode(owner) !== encode(original))
          return yield* deny("Cleanup capture differs from original retained owner");
        const child = yield* cleanupChild;
        // An authenticated historical owner can be cleaned without inventing aggregate authority.
        if (!child) {
          if (kind === "memory-companion")
            return yield* deny("Companion cleanup lacks its reserved child");
          return;
        }
        if (child.row.owner_json === encode(original)) return;
        if ((kind !== "setup" && kind !== "memory-companion") || child.row.owner_json !== null)
          return yield* deny("Native cleanup cannot replace resource ownership");
        yield* capture(original, true);
      });
    const cleanupDrain = (receipt: PiManagedDrain | PiManagedProcessReconciliation) =>
      Effect.gen(function* () {
        const owner = yield* cleanupOwner;
        const populated = receipt.kernel
          .split("\n")
          .filter((line) => /^populated(?:\s|$)/u.test(line));
        if (
          receipt.unit !== owner.unit ||
          receipt.invocation !== owner.invocation ||
          receipt.cgroup !== owner.cgroup ||
          (receipt.kernel !== "removed" &&
            (receipt.kernel.length > 4096 ||
              populated.length !== 1 ||
              populated[0] !== "populated 0")) ||
          ("state" in receipt
            ? receipt.state !== "drained"
            : receipt.ownerPid !== owner.pid ||
              receipt.memoryBytes !== owner.memoryBytes ||
              receipt.swapBytes !== 0 ||
              receipt.oomGroup !== 1 ||
              !Number.isSafeInteger(receipt.launcherPid) ||
              receipt.launcherPid < 1 ||
              (receipt.childPid !== null &&
                (!Number.isSafeInteger(receipt.childPid) || receipt.childPid < 1)) ||
              (receipt.childExitCode !== null && !Number.isSafeInteger(receipt.childExitCode)))
        )
          return yield* deny("Native cleanup requires original matched captured kernel drain");
        const child = yield* cleanupChild;
        if (!child) return;
        yield* captureCleanup(owner);
        yield* drain(receipt, true);
      });
    const guard = <A, E>(work: Effect.Effect<A, E>) =>
      work.pipe(
        Effect.mapError((error) =>
          isProcessError(error) ? error : deny("Task resource reservation or drain unavailable"),
        ),
      );
    return {
      reserve: guard(reserve),
      capture: (owner: PiManagedProcessOwner) => guard(capture(owner)),
      assertOwned: (owner: PiManagedProcessOwner) => guard(assertOwned(owner)),
      drain: (receipt: PiManagedDrain | PiManagedProcessReconciliation) =>
        guard(drain(receipt, kind === "memory-companion")),
      captureCleanup: (owner: PiManagedProcessOwner) => guard(captureCleanup(owner)),
      cleanupDrain: (receipt: PiManagedDrain | PiManagedProcessReconciliation) =>
        guard(cleanupDrain(receipt)),
    };
  };
  return {
    memoryCompanion: (invocationId: string, allocation: PiManagedProcessAllocation) =>
      bind("memory-companion", invocationId, allocation),
    setup: (setupId: string, allocation: PiManagedProcessAllocation) =>
      bind("setup", setupId, allocation),
    pi: (operationId: string, allocation: PiManagedProcessAllocation) =>
      bind("pi", operationId, allocation),
    verification: (attemptId: string, allocation: PiManagedProcessAllocation) =>
      bind("verification", attemptId, allocation),
  };
});
