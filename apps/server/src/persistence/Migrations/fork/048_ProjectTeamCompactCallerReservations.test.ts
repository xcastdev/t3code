import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

it.effect("reserves against cleanup reciprocally and freezes caller ownership", () =>
  Effect.gen(function* () {
    yield* runMigrations();
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
    const reserve = (request: string) => sql`INSERT INTO project_team_compact_caller
      (environment_id,dispatch_id,binding_id,generation,provider_instance_id,thread_id,request_id,
       request_json,predecessor_operation_id,authority_json,admission_revision,claim_generation,deadline_at_ms,status)
      VALUES ('environment','dispatch','binding',0,'provider','thread',${request},'{}','predecessor','{}',6,1,300000,'pending')`;
    yield* reserve("first");
    expect((yield* reserve("second").pipe(Effect.result))._tag).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=6`.pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_team_compact_caller SET deadline_at_ms=400000`.pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_team_compact_caller SET status='released'`;
    expect(
      (yield* sql`UPDATE project_team_compact_caller SET status='pending'`.pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_team_dispatch SET cleanup_claim_revision=6`;
    expect((yield* reserve("second").pipe(Effect.result))._tag).toBe("Failure");
    expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
