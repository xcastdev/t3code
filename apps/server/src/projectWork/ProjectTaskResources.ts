import { canonicalProjectWorkPayload, ProjectTeamRunBinding } from "@t3tools/contracts";
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
      request: Schema.Struct({ setupId: Schema.String }),
      compiledClaim: Schema.Struct({
        transition: Schema.Struct({
          kind: Schema.Literal("claim"),
          binding: ProjectTeamRunBinding,
        }),
      }),
      limits: Schema.Struct({ rootDeadlineAtMs: Positive, deadlineAtMs: Positive }),
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
const deny = (message: string) => new PiManagedProcessError({ phase: "quarantine", message });
const isProcessError = Schema.is(PiManagedProcessError);
type Child = {
  unit: string;
  nonce: string;
  environment_id: string;
  project_id: string;
  task_id: string;
  authority_kind: "pi" | "verification" | "setup";
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
    kind: "pi" | "verification" | "setup",
    id: string,
    supplied: PiManagedProcessAllocation,
  ) => {
    const allocation = structuredClone(supplied);
    const identity = Effect.gen(function* () {
      yield* transaction;
      if (kind === "pi") {
        const rows = yield* sql<{
          project_id: string;
          binding_id: string;
          generation: number;
          intent: string | null;
          deadline_at_ms: number;
          status: string;
        }>`SELECT project_id,binding_id,generation,deadline_at_ms,status,
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
          intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
          encode(intent.allocation) !== encode(allocation)
        )
          return yield* deny("Original Pi resource allocation changed");
        return {
          projectId: row.project_id,
          taskId: intent.binding.taskId,
          taskDeadline: intent.rootBudget.deadlineAtMs,
          deadline: row.deadline_at_ms,
          active: ["prepared", "starting", "running"].includes(row.status),
        };
      }
      if (kind === "setup") {
        const rows = yield* sql<{
          project_id: string;
          binding_id: string;
          generation: number;
          stage: string;
          status: string;
          allocation: string | null;
          input: string | null;
          intent: string | null;
        }>`SELECT
          d.project_id,d.binding_id,d.generation,d.stage,s.status,
          CASE WHEN length(CAST(s.allocation_json AS BLOB))<=262144 THEN s.allocation_json END AS allocation,
          CASE WHEN length(CAST(s.input_json AS BLOB))<=262144 THEN s.input_json END AS input,
          CASE WHEN length(CAST(d.intent_json AS BLOB))<=1048576 THEN d.intent_json END AS intent
          FROM project_team_setup_process s JOIN project_team_dispatch d ON d.dispatch_id=s.dispatch_id
          WHERE d.environment_id=${environmentId} AND s.setup_id=${id} LIMIT 2`;
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row?.allocation ||
          !row.input ||
          !row.intent ||
          encode(yield* decodeAllocation(row.allocation)) !== encode(allocation)
        )
          return yield* deny("Original setup resource allocation unavailable");
        const intent = yield* decodeSetupIntent(row.intent);
        const input = yield* decodeSetupInput(row.input);
        const binding = intent.compiledClaim.transition.binding;
        if (
          binding.environmentId !== environmentId ||
          binding.projectId !== row.project_id ||
          binding.recordId !== row.binding_id ||
          binding.generation !== row.generation ||
          input.setupId !== id ||
          intent.request.setupId !== id ||
          input.bindingId !== binding.recordId ||
          input.generation !== binding.generation ||
          input.threadId !== binding.threadId ||
          input.worktreePath !== binding.worktree ||
          input.deadlineAtMs !== intent.limits.deadlineAtMs
        )
          return yield* deny("Original setup task resource authority changed");
        return {
          projectId: row.project_id,
          taskId: binding.taskId,
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
        allocation: string | null;
      }>`SELECT project_id,task_id,deadline_at_ms,phase,
        CASE WHEN length(CAST(intent_json AS BLOB))<=262144 THEN json_extract(intent_json,'$.allocation') END AS allocation
        FROM project_work_verification_execution WHERE environment_id=${environmentId} AND attempt_id=${id} LIMIT 2`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row?.allocation ||
        encode(yield* decodeAllocation(row.allocation)) !== encode(allocation)
      )
        return yield* deny("Original verification resource allocation changed");
      const budgets = yield* sql<{ deadline_at_ms: number }>`SELECT deadline_at_ms
        FROM project_task_resource_budget WHERE environment_id=${environmentId} AND project_id=${row.project_id} AND task_id=${row.task_id} LIMIT 2`;
      if (budgets.length !== 1 || !budgets[0])
        return yield* deny("Verification requires the original retained task resource budget");
      return {
        projectId: row.project_id,
        taskId: row.task_id,
        taskDeadline: budgets[0].deadline_at_ms,
        deadline: row.deadline_at_ms,
        active: ["claimed", "activating", "owner-captured"].includes(row.phase),
      };
    });
    const retained = Effect.gen(function* () {
      const authority = yield* identity;
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
        row.task_id !== authority.taskId ||
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
    const reserve = Effect.gen(function* () {
      const authority = yield* identity;
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
      const unaccountedPi = yield* sql`SELECT 1 FROM project_team_pi_process p
        JOIN project_team_pi_operation o ON o.operation_id=p.operation_id
        WHERE o.environment_id=${environmentId} AND o.project_id=${authority.projectId}
        AND json_extract(o.intent_json,'$.binding.taskId')=${authority.taskId}
        AND p.status IN ('claimed','captured','quarantine') AND NOT EXISTS
          (SELECT 1 FROM project_task_resource_child c WHERE c.unit=p.unit AND c.environment_id=o.environment_id
           AND c.project_id=o.project_id AND c.task_id=${authority.taskId} AND c.authority_kind='pi'
           AND c.authority_id=o.operation_id AND c.allocation_json=p.allocation_json) LIMIT 1`;
      const unaccountedVerification = yield* sql`SELECT 1 FROM project_work_verification_execution v
        WHERE v.environment_id=${environmentId} AND v.project_id=${authority.projectId} AND v.task_id=${authority.taskId}
        AND v.phase IN ('activating','owner-captured','quarantine') AND NOT EXISTS
          (SELECT 1 FROM project_task_resource_child c WHERE c.unit=json_extract(v.intent_json,'$.allocation.unit')
           AND c.environment_id=v.environment_id AND c.project_id=v.project_id AND c.task_id=v.task_id
           AND c.authority_kind='verification' AND c.authority_id=v.attempt_id) LIMIT 1`;
      const unaccountedSetup = yield* sql`SELECT 1 FROM project_team_setup_process s
        JOIN project_team_dispatch d ON d.dispatch_id=s.dispatch_id
        WHERE d.environment_id=${environmentId} AND d.project_id=${authority.projectId}
        AND json_extract(d.intent_json,'$.compiledClaim.transition.binding.taskId')=${authority.taskId}
        AND s.status IN ('claimed','captured','uncertain') AND s.activation!='unlaunched'
        AND NOT EXISTS (SELECT 1 FROM project_task_resource_child c WHERE c.unit=s.unit
          AND c.environment_id=d.environment_id AND c.project_id=d.project_id AND c.task_id=${authority.taskId}
          AND c.authority_kind='setup' AND c.authority_id=s.setup_id AND c.allocation_json=s.allocation_json) LIMIT 1`;
      if (unaccountedPi.length || unaccountedVerification.length || unaccountedSetup.length)
        return yield* deny("Original task contains an unaccounted native child");
      const exists =
        yield* sql`SELECT 1 FROM project_task_resource_child WHERE unit=${allocation.unit} OR nonce=${allocation.nonce} LIMIT 2`;
      if (exists.length) {
        const { row } = yield* retained;
        if (row.drain_json !== null) return yield* deny("Drained task child cannot reactivate");
        return row.deadline_at_ms;
      }
      yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES(${allocation.unit},${allocation.nonce},${environmentId},${authority.projectId},${authority.taskId},${kind},${id},${encode(allocation)},${allocation.policy.memoryBytes},${deadline})`;
      return (yield* retained).row.deadline_at_ms;
    });
    const capture = (owner: PiManagedProcessOwner) =>
      Effect.gen(function* () {
        const { row, authority } = yield* retained;
        const deleted =
          yield* sql`SELECT 1 FROM project_lifecycle WHERE project_id=${authority.projectId} AND state='tombstoned' LIMIT 1`;
        if (kind !== "setup" && deleted.length)
          return yield* deny("Deleted project cannot activate task resources");
        if (
          (kind !== "setup" &&
            (!authority.active || (yield* Clock.currentTimeMillis) >= row.deadline_at_ms)) ||
          row.drain_json !== null ||
          owner.unit !== row.unit ||
          owner.nonce !== row.nonce ||
          owner.memoryBytes !== row.memory_bytes ||
          owner.swapBytes !== 0 ||
          owner.oomGroup !== 1 ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid < 1 ||
          !/^[a-f0-9]{32}$/u.test(owner.invocation) ||
          !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
          !owner.cgroup.endsWith("/" + row.unit) ||
          owner.cgroup.split("/").some((part) => part === "." || part === "..") ||
          (row.owner_json !== null && row.owner_json !== encode(owner))
        )
          return yield* deny("Task child captured owner differs or expired");
        yield* sql`UPDATE project_task_resource_child SET owner_json=${encode(owner)} WHERE unit=${row.unit}`;
      });
    const drain = (receipt: PiManagedDrain | PiManagedProcessReconciliation) =>
      Effect.gen(function* () {
        const { row } = yield* retained;
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
    const guard = <A, E>(work: Effect.Effect<A, E>) =>
      work.pipe(
        Effect.mapError((error) =>
          isProcessError(error) ? error : deny("Task resource reservation or drain unavailable"),
        ),
      );
    return {
      reserve: guard(reserve),
      capture: (owner: PiManagedProcessOwner) => guard(capture(owner)),
      drain: (receipt: PiManagedDrain | PiManagedProcessReconciliation) => guard(drain(receipt)),
    };
  };
  return {
    setup: (setupId: string, allocation: PiManagedProcessAllocation) =>
      bind("setup", setupId, allocation),
    pi: (operationId: string, allocation: PiManagedProcessAllocation) =>
      bind("pi", operationId, allocation),
    verification: (attemptId: string, allocation: PiManagedProcessAllocation) =>
      bind("verification", attemptId, allocation),
  };
});
