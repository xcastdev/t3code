import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeProjectMemoryCompanionJournal } from "../../../projectWork/memory/ProjectMemoryCompanionJournal.ts";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect(
  "companion migration retains prior held and drained children and shares immutable task capacity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 44 });
      yield* sql`INSERT INTO project_task_resource_budget VALUES('environment','project','task',10000,2147483648)`;
      for (const [unit, memory] of [
        ["held", 1073741824],
        ["drained", 16777216],
      ] as const) {
        yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES(${unit},${unit},'environment','project','task','pi',${unit},'{}',${memory},9000)`;
      }
      yield* sql`UPDATE project_task_resource_child SET owner_json='{}',drain_json='{}' WHERE unit='drained'`;
      const before =
        yield* sql`SELECT unit,nonce,authority_kind,allocation_json,memory_bytes,deadline_at_ms,owner_json,drain_json FROM project_task_resource_child ORDER BY unit`;
      yield* runForkMigrations(45);
      expect(
        yield* sql`SELECT unit,nonce,authority_kind,allocation_json,memory_bytes,deadline_at_ms,owner_json,drain_json FROM project_task_resource_child ORDER BY unit`,
      ).toEqual(before);
      yield* sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
      VALUES('companion','companion','environment','project','task','memory-companion','request','{}',1073741824,9000)`;
      for (const mutation of [
        sql`INSERT INTO project_task_resource_child(unit,nonce,environment_id,project_id,task_id,authority_kind,authority_id,allocation_json,memory_bytes,deadline_at_ms)
        VALUES('excess','excess','environment','project','task','memory-companion','excess','{}',16777216,9000)`,
        sql`UPDATE project_task_resource_child SET authority_kind='memory-companion' WHERE unit='held'`,
        sql`UPDATE project_task_resource_child SET owner_json='{"changed":true}' WHERE unit='drained'`,
        sql`UPDATE project_task_resource_budget SET deadline_at_ms=20000`,
        sql`DELETE FROM project_task_resource_child`,
      ])
        expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
      expect(
        yield* sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE drain_json IS NULL`,
      ).toEqual([{ held: 2147483648 }]);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      expect(yield* runForkMigrations(45)).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("companion migration retains one bounded response and forbids activation restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const journal = yield* makeProjectMemoryCompanionJournal("environment");
    expect(yield* sql.withTransaction(journal.auditProjectDrained("empty-project", 0))).toBe(0);
    yield* sql`INSERT INTO project_memory_companion_invocation(invocation_id,environment_id,project_id,task_id,effect_id,request_id,generation,intent_json,phase)
      VALUES('invocation','environment','project','task','effect','request',1,'{}','prepared')`;
    yield* sql`UPDATE project_memory_companion_invocation SET phase='activating'`;
    yield* sql`UPDATE project_memory_companion_invocation SET phase='owned',owner_json='{}'`;
    yield* sql`UPDATE project_memory_companion_invocation SET phase='drained',drain_json='{}',response=${new Uint8Array([123, 125])}`;
    for (const mutation of [
      sql`UPDATE project_memory_companion_invocation SET phase='activating'`,
      sql`UPDATE project_memory_companion_invocation SET request_id='replacement'`,
      sql`UPDATE project_memory_companion_invocation SET response=${new Uint8Array([91, 93])}`,
      sql`UPDATE project_memory_companion_invocation SET owner_json='{"changed":true}'`,
      sql`DELETE FROM project_memory_companion_invocation`,
    ])
      expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
    expect(
      yield* sql`SELECT phase,length(response) AS bytes FROM project_memory_companion_invocation`,
    ).toEqual([{ phase: "drained", bytes: 2 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
