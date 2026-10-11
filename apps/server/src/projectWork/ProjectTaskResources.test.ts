import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeProjectTaskResources, PROJECT_TASK_MEMORY_BYTES } from "./ProjectTaskResources.ts";
import type {
  PiManagedProcessAllocation,
  PiManagedProcessOwner,
} from "../provider/pi/PiManagedProcess.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const now = yield* Clock.currentTimeMillis;
  const taskDeadline = now + 100000;
  yield* sql`INSERT INTO project_task_resource_budget VALUES('environment','project','task',${taskDeadline},2147483648)`;
  const resources = yield* makeProjectTaskResources("environment");
  // These bounded SQL custody fixtures grant no approval or native activation.
  // The journal suites exercise production current-approval checks separately.
  const child = Effect.fn("resourceFixture.child")(function* (
    number: number,
    memoryBytes = PROJECT_TASK_MEMORY_BYTES / 2,
    scope = { environment: "environment", project: "project", task: "task" },
    nonceOverride?: string,
  ) {
    const nonce = nonceOverride ?? `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const allocation: PiManagedProcessAllocation = {
      version: 1,
      nonce,
      unit: `t3-pi-managed-${nonce}.service`,
      policy: { memoryBytes, runtimeSeconds: 30 },
      launch: {
        workspaceRoot: "/workspace",
        workspaceAccess: "readonly",
        protectedRoots: ["/protected"],
        runtimeFiles: [{ source: "/runtime/true", target: "/bin/true", dev: 1, ino: 1 }],
        argv: ["/bin/true"],
        memoryBytes,
        runtimeSeconds: 30,
        workspace: { path: "/workspace", dev: 1, ino: 1 },
        protectedWorkspaceEntries: [],
      },
    };
    const id = `verification-${number}`;
    const deadline = now + 30000;
    yield* sql`INSERT INTO project_work_verification_execution(environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
      VALUES(${scope.environment},${id},${scope.project},${scope.task},${id},${"a".repeat(64)},'gate',0,${canonicalProjectWorkPayload({ allocation })},${"a".repeat(64)},${"a".repeat(64)},${deadline},'claimed',0)`;
    const owner: PiManagedProcessOwner = {
      type: "owner",
      unit: allocation.unit,
      nonce,
      invocation: String(number).padStart(32, "a"),
      cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
      pid: number,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const loan = resources.verification(id, allocation);
    const drain = {
      state: "drained" as const,
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      kernel: "removed",
    };
    return { allocation, owner, loan, drain, id, deadline };
  });
  return { sql, resources, child, now, taskDeadline };
});
const test = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const rejected = <A, E>(body: Effect.Effect<A, E>) =>
  body.pipe(
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure")),
  );

it.effect("task resources atomically admit two children and reject combined excess", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      const children = yield* Effect.forEach([1, 2, 3], (id) => f.child(id));
      const results = yield* Effect.all(
        children.map((c) => f.sql.withTransaction(c.loan.reserve).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(2);
      expect(results.filter((r) => r._tag === "Failure")).toHaveLength(1);
      expect(
        yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
      ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES }]);
    }),
  ),
);

it.effect(
  "task resources retain expired uncaptured reservations through restart and reject renewal",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1, PROJECT_TASK_MEMORY_BYTES);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* rejected(first.loan.reserve);
        yield* TestClock.setTime(first.deadline);
        yield* rejected(f.sql.withTransaction(first.loan.reserve));
        const resumed = yield* makeProjectTaskResources("environment");
        yield* rejected(
          f.sql.withTransaction(
            resumed.verification(first.id, first.allocation).drain(first.drain),
          ),
        );
        yield* rejected(
          f.sql`UPDATE project_task_resource_budget SET deadline_at_ms=${f.taskDeadline + 1}`,
        );
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES }]);
      }),
    ),
);

it.effect(
  "task resources release only matched captured kernel drain and reuse it after restart",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1, PROJECT_TASK_MEMORY_BYTES);
        const waiting = yield* f.child(2);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.capture(first.owner));
        for (const receipt of [
          { ...first.drain, kernel: "populated 1" },
          { ...first.drain, invocation: "b".repeat(32) },
          { ...first.drain, cgroup: "/sys/fs/cgroup/foreign" },
          { ...first.drain, state: "owned" as const },
        ])
          yield* rejected(f.sql.withTransaction(first.loan.drain(receipt)));
        yield* rejected(f.sql.withTransaction(waiting.loan.reserve));
        yield* TestClock.setTime(first.deadline + 1);
        const resumed = yield* makeProjectTaskResources("environment");
        const loan = resumed.verification(first.id, first.allocation);
        const liveDrain = {
          unit: first.owner.unit,
          invocation: first.owner.invocation,
          cgroup: first.owner.cgroup,
          ownerPid: first.owner.pid,
          memoryBytes: first.owner.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
          launcherPid: 100,
          childPid: 101,
          childExitCode: 0,
          kernel: "removed",
        };
        yield* f.sql.withTransaction(loan.drain(liveDrain));
        yield* f.sql.withTransaction(loan.drain(first.drain));
        yield* rejected(f.sql.withTransaction(loan.reserve));
        expect(yield* f.sql`SELECT drain_json FROM project_task_resource_child`).toEqual([
          { drain_json: canonicalProjectWorkPayload(liveDrain) },
        ]);
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: null }]);
      }),
    ),
);

it.effect("task resources reject foreign partitions, allocation changes and nonce collisions", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.child(1);
      yield* f.sql.withTransaction(first.loan.reserve);
      const foreign = yield* makeProjectTaskResources("foreign-environment");
      yield* rejected(
        f.sql.withTransaction(foreign.verification(first.id, first.allocation).reserve),
      );
      const changed = {
        ...first.allocation,
        policy: { ...first.allocation.policy, memoryBytes: 33554432 },
      };
      yield* rejected(f.sql.withTransaction(f.resources.verification(first.id, changed).reserve));
      for (const scope of [
        { environment: "environment", project: "project", task: "other-task" },
        { environment: "environment", project: "other-project", task: "task" },
      ]) {
        yield* f.sql`INSERT INTO project_task_resource_budget VALUES(${scope.environment},${scope.project},${scope.task},${f.taskDeadline},2147483648)`;
        const second = yield* f.child(
          scope.task === "other-task" ? 2 : 3,
          PROJECT_TASK_MEMORY_BYTES,
          scope,
        );
        yield* f.sql.withTransaction(second.loan.reserve);
        // A separate immutable authority retains the colliding physical unit under
        // its foreign partition; exact allocation matching alone must not move it.
        const collision = yield* f.child(
          scope.task === "other-task" ? 4 : 5,
          first.allocation.policy.memoryBytes,
          scope,
          first.allocation.nonce,
        );
        yield* rejected(f.sql.withTransaction(collision.loan.reserve));
      }
      expect(yield* f.sql`SELECT COUNT(*) AS children FROM project_task_resource_child`).toEqual([
        { children: 3 },
      ]);
    }),
  ),
);

it.effect(
  "task resources hold canceled children and deny forward authority after project deletion",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.child(1);
        yield* f.sql.withTransaction(first.loan.reserve);
        yield* f.sql.withTransaction(first.loan.capture(first.owner));
        yield* f.sql`UPDATE project_work_verification_execution SET phase='quarantine',reason='canceled',revision=revision+1 WHERE attempt_id=${first.id}`;
        yield* rejected(f.sql.withTransaction(first.loan.reserve));
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: PROJECT_TASK_MEMORY_BYTES / 2 }]);
        const next = yield* f.child(2);
        yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at,tombstone_json)
      VALUES('project','tombstoned','/workspace',1,'2026-10-11T00:00:00.000Z','{}')`;
        yield* rejected(f.sql.withTransaction(next.loan.reserve));
        yield* rejected(f.sql.withTransaction(first.loan.capture(first.owner)));
        // Cleanup can observe the already captured drain after cancellation/deletion.
        yield* f.sql.withTransaction(first.loan.drain(first.drain));
        expect(
          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
        ).toEqual([{ held: null }]);
      }),
    ),
);
