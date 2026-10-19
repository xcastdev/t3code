import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations, runForkMigrations } from "../../Migrations.ts";

it.effect("upgrades existing dispatches to open admission and keeps cleanup claims one-way", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toForkMigrationInclusive: 46 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_team_run_binding
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('binding','project','running',0,0,'2026-10-03T00:00:00.000Z','{}')`;
    yield* sql`INSERT INTO project_team_model_budget VALUES ('environment','project','root',64000,300000)`;
    yield* sql`INSERT INTO project_team_dispatch
      (dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,
      worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,
      attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,
      repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
      VALUES ('dispatch','environment','project','binding',0,'task','attempt','/assigned','branch',
      'root',64000,300000,64000,300000,0,2,2,'assignment-observed',6,1,'{}',
      '2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')`;
    const before = yield* sql`SELECT * FROM project_team_dispatch`;
    yield* runForkMigrations(47);
    expect(yield* sql`SELECT * FROM project_team_dispatch`).toEqual(
      before.map((row) => ({ ...row, cleanup_claim_revision: null })),
    );
    for (const revision of [-1, 5, 7]) {
      expect(
        (yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=${revision}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    yield* sql
      .withTransaction(
        sql`UPDATE project_team_dispatch SET cleanup_claim_revision=6`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.result);
    expect(yield* sql`SELECT cleanup_claim_revision FROM project_team_dispatch`).toEqual([
      { cleanup_claim_revision: null },
    ]);
    yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=6`;
    for (const revision of [null, 5, 7]) {
      expect(
        (yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=${revision}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    yield* sql`UPDATE project_team_dispatch SET stage='settled',revision=7`;
    expect(yield* sql`SELECT cleanup_claim_revision FROM project_team_dispatch`).toEqual([
      { cleanup_claim_revision: 6 },
    ]);
    yield* runForkMigrations(47);
    expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
