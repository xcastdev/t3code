import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 33 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_run_binding (record_id,project_id,status,revision,generation,updated_at,payload_json)
    VALUES ('binding','project','reserved',0,0,'2026-10-03T00:00:00.000Z','{}')`;
  yield* sql`INSERT INTO project_team_model_budget VALUES ('environment','project','root',1000,10000)`;
  yield* sql`INSERT INTO project_team_dispatch
    (dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
    VALUES ('dispatch','environment','project','binding',0,'task','attempt','/assigned','branch','root',1000,10000,500,9000,0,2,2,'reserved',0,0,'{}','2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')`;
  const prior = yield* sql`SELECT * FROM project_team_dispatch`;
  yield* runForkMigrations();
  return { sql, prior };
});

it.effect("retains one immutable reviewer target, preserves dispatch and cascades deletion", () =>
  Effect.gen(function* () {
    const { sql, prior } = yield* fixture;
    yield* sql`INSERT INTO project_team_review_target VALUES ('environment','dispatch','project','binding',0,${"a".repeat(64)},'{}',${"b".repeat(64)})`;
    const first = yield* sql`SELECT * FROM project_team_review_target`;
    yield* sql`INSERT OR REPLACE INTO project_team_review_target VALUES ('environment','dispatch','changed','changed',1,${"c".repeat(64)},'{"changed":true}',${"d".repeat(64)})`;
    expect(yield* sql`SELECT * FROM project_team_review_target`).toEqual(first);
    expect(
      (yield* sql`UPDATE project_team_review_target SET manifest_json='{}'`.pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    expect(yield* runForkMigrations()).toEqual([]);
    expect(yield* sql`SELECT * FROM project_team_dispatch`).toEqual(prior);
    expect(
      (yield* sql`INSERT INTO project_team_review_target VALUES ('environment','missing','project','other',0,${"a".repeat(64)},'{}',${"b".repeat(64)})`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`DELETE FROM project_team_dispatch WHERE dispatch_id='dispatch'`;
    expect(yield* sql`SELECT * FROM project_team_review_target`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("bounds reviewer envelope generations, digests and UTF8 JSON bytes", () =>
  Effect.gen(function* () {
    const { sql } = yield* fixture;
    for (const [generation, digest, json] of [
      [-1, "a".repeat(64), "{}"],
      [9007199254740992, "a".repeat(64), "{}"],
      [0, "A".repeat(64), "{}"],
      [0, "a".repeat(64), "broken"],
      [0, "a".repeat(64), canonicalProjectWorkPayload("界".repeat(43691))],
    ] as const) {
      expect(
        (yield* sql`INSERT INTO project_team_review_target VALUES ('environment','dispatch','project','binding',${generation},${digest},${json},${"b".repeat(64)})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    expect(yield* sql`SELECT * FROM project_team_review_target`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
