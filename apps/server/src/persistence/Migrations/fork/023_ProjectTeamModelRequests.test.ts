import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const environment of ["env-a", "env-b"])
    yield* sql`INSERT INTO project_team_model_budget VALUES(${environment},'project','root',1000,2000)`;
  const insert = (id: string, environment = "env-a", model = "cheap", slot = 0) =>
    sql`INSERT INTO project_team_model_request (
      reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,
      worker_id,generation,operation_id,request_id,route_id,provider,model,
      environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,
      deadline_at_ms,status,charged_input_tokens,charged_output_tokens,reservation_json
    ) VALUES(${id},${environment},'project','root','run','attempt',${id},1,'prompt',1,
      'configured','command-code',${model},${slot},0,100,100,2000,'held',0,0,'{}')`;
  return { sql, insert };
});

it.effect(
  "holds one environment slot across projects/models and releases only settled requests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert("first");
      expect((yield* f.insert("competitor", "env-a", "other-model").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* f.insert("other-environment", "env-b");
      yield* f.sql`UPDATE project_team_model_request SET status='unknown',charged_input_tokens=100,charged_output_tokens=100,accounting_receipt_id='receipt' WHERE reservation_id='first'`;
      yield* f.insert("competitor", "env-a", "other-model");
      expect(
        yield* f.sql`SELECT status,charged_input_tokens FROM project_team_model_request WHERE reservation_id='first'`,
      ).toEqual([{ status: "unknown", charged_input_tokens: 100 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "refuses duplicate operation requests, model oversubscription and dangling budget ownership",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert("first");
      expect((yield* f.insert("same-model", "env-a", "cheap", 1).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* f.sql`UPDATE project_team_model_request SET root_task_id='missing' WHERE reservation_id='first'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql`UPDATE project_team_model_request SET provider='ambient' WHERE reservation_id='first'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      yield* f.sql`UPDATE project_team_model_request SET status='reported' WHERE reservation_id='first'`;
      yield* f.insert("second");
      expect(
        (yield* f.sql`UPDATE project_team_model_request SET worker_id='first' WHERE reservation_id='second'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      yield* runMigrations();
      expect(
        yield* f.sql`SELECT reservation_id FROM project_team_model_request ORDER BY reservation_id`,
      ).toEqual([{ reservation_id: "first" }, { reservation_id: "second" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
