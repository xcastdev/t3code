import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 24 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_model_budget VALUES('env','project','root',1000,2000)`;
  const insert = (
    id: string,
    status: string,
    slot = 0,
  ) => sql`INSERT INTO project_team_model_request
    (reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
     operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
     maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,
     charged_input_tokens,charged_output_tokens,reservation_json)
    VALUES(${id},'env','project','root','run','attempt',${id},1,'prompt',1,'route',
      'command-code','cheap',${slot},${slot},100,100,2000,${status},0,0,'{}')`;
  return { sql, insert };
});

it.effect("upgrades reused historical slots without inventing transport drain", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert("old-reported", "reported");
    yield* f.insert("old-unknown", "unknown");
    yield* f.insert("current", "held");
    yield* runMigrations();
    expect(
      yield* f.sql`SELECT reservation_id,capacity_state FROM project_team_model_request ORDER BY reservation_id`,
    ).toEqual([
      { reservation_id: "current", capacity_state: "held" },
      { reservation_id: "old-reported", capacity_state: "legacy" },
      { reservation_id: "old-unknown", capacity_state: "legacy" },
    ]);
    yield* runMigrations();
    expect(
      yield* f.sql`SELECT capacity_state FROM project_team_model_request WHERE reservation_id='current'`,
    ).toEqual([{ capacity_state: "held" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("quarantines capacity independently of a settled usage outcome", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert("current", "held");
    yield* runMigrations();
    yield* f.sql`UPDATE project_team_model_request SET status='unknown',capacity_state='quarantine' WHERE reservation_id='current'`;
    yield* f.insert("next", "reported", 1);
    expect(
      (yield* f.sql`UPDATE project_team_model_request SET capacity_state='held',environment_slot=0 WHERE reservation_id='next'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.sql`UPDATE project_team_model_request SET capacity_state='held',model_slot=0 WHERE reservation_id='next'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* f.sql`UPDATE project_team_model_request SET capacity_state='released' WHERE reservation_id='current'`;
    yield* f.sql`UPDATE project_team_model_request SET capacity_state='held',environment_slot=0,model_slot=0 WHERE reservation_id='next'`;
    expect(
      (yield* f.sql`UPDATE project_team_model_request SET capacity_state='invented'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
