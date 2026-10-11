import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect(
  "task resources migration preserves legacy receipts without trusting their active allocations",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 43 });
      yield* sql`INSERT INTO project_team_pi_operation(operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
      VALUES('legacy','environment','project','binding',1,'pi','thread','worker',0,'prompt','hash','binding','task',100,10000,'quarantine','{}')`;
      yield* sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status,owner_json)
      VALUES('legacy.service','legacy','{}','quarantine','{}')`;
      const before =
        yield* sql`SELECT operation_id,allocation_json,status,owner_json,drain_json FROM project_team_pi_process`;
      yield* runForkMigrations(44);
      expect(
        yield* sql`SELECT operation_id,allocation_json,status,owner_json,drain_json FROM project_team_pi_process`,
      ).toEqual(before);
      expect(yield* sql`SELECT unit FROM project_task_resource_child`).toEqual([]);
      expect(yield* sql`SELECT task_id FROM project_task_resource_budget`).toEqual([]);
      expect(yield* runForkMigrations(44)).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("task resources migration enforces combined capacity and immutable bounded custody", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO project_task_resource_budget VALUES('environment','project','task',10000,2147483648)`;
    yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
      VALUES('unit','nonce','environment','project','task','pi','operation','{}',2147483648,9000)`;
    const before =
      yield* sql`SELECT unit,nonce,memory_bytes,deadline_at_ms,owner_json,drain_json FROM project_task_resource_child`;
    for (const mutation of [
      sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES('excess','excess','environment','project','task','verification','verification','{}',16777216,9000)`,
      sql`UPDATE project_task_resource_budget SET memory_bytes=4294967296`,
      sql`UPDATE project_task_resource_budget SET deadline_at_ms=20000`,
      sql`UPDATE project_task_resource_child SET memory_bytes=16777216`,
      sql`UPDATE project_task_resource_child SET deadline_at_ms=20000`,
      sql`UPDATE project_task_resource_child SET nonce='replacement'`,
      sql`UPDATE project_task_resource_child SET task_id='other'`,
      sql`UPDATE project_task_resource_child SET owner_json=${canonicalProjectWorkPayload({ padding: "x".repeat(16384) })}`,
      sql`DELETE FROM project_task_resource_child`,
      sql`DELETE FROM project_task_resource_budget`,
    ]) {
      expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
      expect(
        yield* sql`SELECT unit,nonce,memory_bytes,deadline_at_ms,owner_json,drain_json FROM project_task_resource_child`,
      ).toEqual(before);
    }
    for (const deadline of [0, 9007199254740992, 1.5])
      expect(
        (yield* sql`INSERT INTO project_task_resource_budget VALUES('environment','project',${String(deadline)},${deadline},2147483648)`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
