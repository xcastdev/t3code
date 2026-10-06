import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

it.effect("retains immutable initial-review bytes and removes them with their operation", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toForkMigrationInclusive: 30 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_team_pi_operation
      (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,
       thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,
       root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
      VALUES ('initialize','environment','project','binding',0,'provider','thread','worker',
        0,'initialize','hash','binding','task',100,10000,'settled','{}')`;
    const prior = yield* sql`SELECT * FROM project_team_pi_operation`;
    yield* runMigrations();
    yield* sql`INSERT INTO project_team_review_freshness VALUES
      ('initialize','environment','project','binding',0,'provider','thread','session','{}','raw\n')`;
    const winner = yield* sql`SELECT * FROM project_team_review_freshness`;
    yield* runMigrations();
    expect(yield* sql`SELECT * FROM project_team_pi_operation`).toEqual(prior);
    for (const [column, value] of [
      ["operation_id", "other"],
      ["environment_id", "other"],
      ["project_id", "other"],
      ["binding_id", "other"],
      ["generation", 1],
      ["provider_instance_id", "other"],
      ["thread_id", "other"],
      ["session_id", "other"],
      ["manifest_json", '{"changed":true}'],
      ["native_jsonl", "changed"],
    ] as const) {
      expect(
        (yield* sql`UPDATE project_team_review_freshness SET ${sql(column)}=${value}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    yield* sql`INSERT OR REPLACE INTO project_team_review_freshness VALUES
      ('initialize','foreign','foreign','foreign',1,'foreign','foreign','foreign','{}','changed')`;
    expect(yield* sql`SELECT * FROM project_team_review_freshness`).toEqual(winner);
    yield* sql`DELETE FROM project_team_pi_operation WHERE operation_id='initialize'`;
    expect(yield* sql`SELECT * FROM project_team_review_freshness`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses orphaned, malformed and byte-oversized freshness records", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_team_pi_operation
      (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,
       thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,
       root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
      VALUES ('initialize','environment','project','binding',0,'provider','thread','worker',
        0,'initialize','hash','binding','task',100,10000,'settled','{}')`;
    for (const [operation, manifest, raw] of [
      ["missing", "{}", "raw"],
      ["initialize", "bad", "raw"],
      ["initialize", '"' + "é".repeat(16384) + '"', "raw"],
      ["initialize", "{}", "é".repeat(2097153)],
    ] as const) {
      expect(
        (yield* sql`INSERT INTO project_team_review_freshness VALUES
        (${operation},'environment','project','binding',0,'provider','thread','session',${manifest},${raw})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    expect(yield* sql`SELECT * FROM project_team_review_freshness`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
