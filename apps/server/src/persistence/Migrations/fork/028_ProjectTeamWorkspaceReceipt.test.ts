import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";
const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 27 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_run_binding
    (record_id,project_id,status,revision,generation,updated_at,payload_json)
    VALUES ('binding','project','reserved',0,0,'2026-10-03T00:00:00.000Z','{}')`;
  yield* sql`INSERT INTO project_team_model_budget VALUES ('environment','project','root',1000,10000)`;
  yield* sql`INSERT INTO project_team_dispatch
    (dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,
      worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,
      attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,
      repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
    VALUES ('dispatch','environment','project','binding',0,'task','attempt','/assigned','branch',
      'root',1000,10000,500,9000,0,2,2,'reserved',1,1,'{}',
      '2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')`;
  return sql;
});

it.effect("retains the original workspace receipt without changing prior dispatches", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    const original = yield* sql`SELECT * FROM project_team_dispatch`;
    yield* runMigrations();
    yield* sql`INSERT INTO project_team_workspace_receipt VALUES
      ('dispatch','environment','binding',0,1,'{"assignment":true}','{"receipt":true}')`;
    yield* runMigrations();
    expect(yield* sql`SELECT * FROM project_team_dispatch`).toEqual(original);
    expect(yield* sql`SELECT * FROM project_team_workspace_receipt`).toEqual([
      {
        dispatch_id: "dispatch",
        environment_id: "environment",
        binding_id: "binding",
        generation: 0,
        claim_generation: 1,
        assignment_json: '{"assignment":true}',
        receipt_json: '{"receipt":true}',
      },
    ]);
    for (const [column, replacement] of [
      ["dispatch_id", "changed"],
      ["environment_id", "changed"],
      ["binding_id", "changed"],
      ["generation", 1],
      ["claim_generation", 2],
      ["assignment_json", '{"assignment":false}'],
      ["receipt_json", '{"receipt":false}'],
    ] as const) {
      expect(
        (yield* sql`UPDATE project_team_workspace_receipt SET ${sql(column)}=${replacement}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    yield* sql`INSERT INTO project_team_workspace_receipt VALUES
      ('dispatch','changed','changed',1,2,'{}','{}') ON CONFLICT(dispatch_id) DO NOTHING`;
    expect((yield* sql`SELECT receipt_json FROM project_team_workspace_receipt`)[0]).toEqual({
      receipt_json: '{"receipt":true}',
    });
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses unclaimed, foreign, malformed and oversized workspace receipts", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* runMigrations();
    for (const [dispatch, generation, claim, assignment, receipt] of [
      ["missing", 0, 1, "{}", "{}"],
      [null, 0, 1, "{}", "{}"],
      ["dispatch", -1, 1, "{}", "{}"],
      ["dispatch", 0.5, 1, "{}", "{}"],
      ["dispatch", 0, 0, "{}", "{}"],
      ["dispatch", 0, 1.5, "{}", "{}"],
      ["dispatch", 0, 1, "bad", "{}"],
      ["dispatch", 0, 1, "{}", "bad"],
      ["dispatch", 0, 1, yield* encodeString("x".repeat(262144)), "{}"],
      ["dispatch", 0, 1, "{}", yield* encodeString("é".repeat(131072))],
    ] as const) {
      expect(
        (yield* sql`INSERT INTO project_team_workspace_receipt VALUES
          (${dispatch},'environment','binding',${generation},${claim},${assignment},${receipt})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    expect(yield* sql`SELECT * FROM project_team_workspace_receipt`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
