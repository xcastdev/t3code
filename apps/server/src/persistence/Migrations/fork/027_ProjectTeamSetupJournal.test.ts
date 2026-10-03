import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 26 });
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
      'root',1000,10000,500,9000,0,2,2,'reserved',0,0,'{}',
      '2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')`;
  return sql;
});

it.effect("upgrades legacy setup without inventing input, child identity or completion", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_team_setup_process VALUES
      ('setup','dispatch','owned.service','{"selection":true}','{"allocation":true}',
        'completed','{"owner":true}','{"drain":true}')`;
    yield* runMigrations();
    yield* runMigrations();
    expect(yield* sql`SELECT * FROM project_team_setup_process`).toEqual([
      {
        setup_id: "setup",
        dispatch_id: "dispatch",
        unit: "owned.service",
        selection_json: '{"selection":true}',
        allocation_json: '{"allocation":true}',
        status: "completed",
        owner_json: '{"owner":true}',
        drain_json: '{"drain":true}',
        input_json: null,
        activation: "owned",
        started_pid: null,
        receipt_json: null,
        uncertainty_json: null,
      },
    ]);
    expect(
      (yield* sql`UPDATE project_team_setup_process SET input_json='{}'`.pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "permits exactly one allocation after durable selection and fences every retained identity",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture;
      yield* runMigrations();
      yield* sql`INSERT INTO project_team_setup_process
      (setup_id,dispatch_id,selection_json,status,input_json,activation)
      VALUES ('setup','dispatch','{}','selected','{}','unlaunched')`;
      yield* sql`UPDATE project_team_setup_process
      SET allocation_json='{}',unit='owned.service',status='allocated'`;
      for (const column of ["selection_json", "allocation_json", "input_json"])
        expect(
          (yield* sql`UPDATE project_team_setup_process SET ${sql(column)}='{"changed":true}'`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      yield* sql`UPDATE project_team_setup_process SET activation='claimed',status='claimed'`;
      yield* sql`UPDATE project_team_setup_process SET owner_json='{}',activation='owned',status='captured',started_pid=123`;
      expect(
        (yield* sql`UPDATE project_team_setup_process SET started_pid=124`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* sql`UPDATE project_team_setup_process SET activation='unlaunched'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      yield* sql`UPDATE project_team_setup_process SET status='uncertain',uncertainty_json='{"reason":"held"}'`;
      expect(
        (yield* sql`UPDATE project_team_setup_process SET uncertainty_json=NULL`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        yield* sql`SELECT owner_json,started_pid,activation FROM project_team_setup_process`,
      ).toEqual([{ owner_json: "{}", started_pid: 123, activation: "owned" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("failed migration rolls back the table rebuild and retains the legacy owner", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_team_setup_process VALUES
      ('setup','dispatch','owned.service','{}','{}','allocated',NULL,NULL)`;
    yield* sql`CREATE TABLE project_team_setup_process_legacy (sentinel TEXT)`;
    expect((yield* runMigrations().pipe(Effect.exit))._tag).toBe("Failure");
    expect(yield* sql`SELECT setup_id,unit,status FROM project_team_setup_process`).toEqual([
      { setup_id: "setup", unit: "owned.service", status: "allocated" },
    ]);
    expect(
      yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND name='project_team_setup_identity_immutable'`,
    ).toEqual([{ name: "project_team_setup_identity_immutable" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
