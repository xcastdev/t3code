import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations, runForkMigrations } from "../../Migrations.ts";

it.effect("subscription migration preserves request journals and mailbox foreign keys", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 45 });
    yield* sql`INSERT INTO project_team_model_budget VALUES('env','project','root',64000,900000)`;
    yield* sql`INSERT INTO project_team_model_request (
      reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
      operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
      maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,charged_input_tokens,
      charged_output_tokens,reservation_json
    ) VALUES ('legacy','env','project','root','run','attempt','worker',1,'operation',1,
      'command-route','command-code','command-model',0,0,100,200,900000,'held',0,0,'{}')`;
    const before = yield* sql`SELECT * FROM project_team_model_request`;
    yield* runForkMigrations(46);
    expect(yield* sql`SELECT * FROM project_team_model_request`).toEqual(
      before.map((row) => ({
        ...row,
        accounting_mode: "hard",
        unknown_maximum_tokens: null,
      })),
    );
    const mailboxForeignKeys = yield* sql`PRAGMA foreign_key_list(project_team_mailbox_input)`;
    expect(mailboxForeignKeys.some((key) => key.table === "project_team_model_request")).toBe(true);
    expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      (yield* sql`UPDATE project_team_model_request SET accounting_mode='openai-subscription-monitored',unknown_maximum_tokens=64000 WHERE reservation_id='legacy'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`INSERT INTO project_team_model_request (
      reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
      operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
      maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,charged_input_tokens,
      charged_output_tokens,reservation_json,accounting_mode,unknown_maximum_tokens
    ) VALUES ('invalid-subscription','env','project','root','run','attempt','worker',1,'operation2',2,
      'openai-subscription-luna','openai-codex','gpt-6-luna',1,0,100,200,900000,'held',0,0,'{}','hard',NULL)`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`INSERT INTO project_team_pi_subscription_grant
      (environment_id,project_id,root_task_id,model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms)
      VALUES ('env','project','root','gpt-6-luna','openai-subscription-luna',64000,300000,900000)`;
    yield* sql`UPDATE project_team_pi_subscription_grant SET stopped_at_ms=800000,stop_reason='threshold-reached'
      WHERE environment_id='env' AND project_id='project' AND root_task_id='root'`;
    expect(
      (yield* sql`UPDATE project_team_pi_subscription_grant SET stopped_at_ms=700000,stop_reason='unknown-usage'
      WHERE environment_id='env' AND project_id='project' AND root_task_id='root'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("subscription migration retains existing memory request lanes and scopes", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toForkMigrationInclusive: 45 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_team_model_budget VALUES('env','project','root',64000,900000)`;

    for (const [lane, scope, provider, status, capacityState, environmentSlot, modelSlot] of [
      ["pi", "", "command-code", "held", "held", 0, 0],
      ["memory", "a".repeat(64), "command-code", "reported", "legacy", 1, 1],
      ["memory", "b".repeat(64), "openrouter", "unknown", "quarantine", 2, 2],
    ] as const) {
      yield* sql`INSERT INTO project_team_model_request (
        reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
        operation_id,request_id,request_lane,request_scope,route_id,provider,model,environment_slot,model_slot,
        maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
        charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
        VALUES(${lane + "-" + provider},'env','project','root','run','attempt','worker',7,
          'shared-operation',1,${lane},${scope},'route',${provider},'model',${environmentSlot},${modelSlot},
          100,200,900000,${status},${capacityState},0,0,NULL,'{}',NULL)`;
    }

    yield* sql`INSERT INTO project_team_run_binding
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES('binding','project','running',0,7,'2026-01-01T00:00:00.000Z','{}')`;
    yield* sql`INSERT INTO project_team_dispatch (
      dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,worktree,branch,
      root_task_id,root_maximum_tokens,root_deadline_at_ms,attempt_maximum_tokens,attempt_deadline_at_ms,
      delegation_depth,maximum_delegation_depth,repair_allowance,stage,revision,claim_generation,
      intent_json,created_at,updated_at)
      VALUES('dispatch','env','project','binding',7,'task','attempt','/workspace','work',
        'root',64000,900000,1000,900000,0,0,0,'settled',0,0,'{}','2026-01-01','2026-01-01')`;
    yield* sql`INSERT INTO project_team_pi_operation (
      operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,
      deadline_at_ms,status,intent_json)
      VALUES('shared-operation','env','project','binding',7,'pi','thread','worker',0,'prompt',
        'hash','binding','root',1000,900000,'settled','{}')`;
    const hash = "c".repeat(64);
    yield* sql`INSERT INTO project_team_mailbox_batch (
      operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,manifest_json,
      manifest_sha256,system_text,system_text_sha256,revision,status)
      VALUES('shared-operation','batch','env','project','dispatch','binding',7,'{}',
        ${hash},'system text',${hash},0,'sealed')`;
    yield* sql`INSERT INTO project_team_mailbox_input
      VALUES('pi-command-code','shared-operation',1,'worker',7,'route','command-code','model',${hash},${hash})`;

    const requestsBefore =
      yield* sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
    const mailboxBefore = yield* sql`SELECT * FROM project_team_mailbox_input`;
    yield* runForkMigrations(46);

    expect(yield* sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`).toEqual(
      requestsBefore.map((row) => ({
        ...row,
        accounting_mode: "hard",
        unknown_maximum_tokens: null,
      })),
    );
    expect(yield* sql`SELECT * FROM project_team_mailbox_input`).toEqual(mailboxBefore);
    expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      yield* sql`SELECT "table" AS target FROM pragma_foreign_key_list('project_team_mailbox_input')
        WHERE "from"='reservation_id'`,
    ).toEqual([{ target: "project_team_model_request" }]);
    expect(
      (yield* sql`UPDATE project_team_mailbox_input SET model='changed'`.pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* sql`DELETE FROM project_team_mailbox_input`.pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
    });
    expect(
      yield* sql`SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='project_team_model_request'
          AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
    ).toEqual([
      { name: "project_team_model_budget_usage" },
      { name: "project_team_model_environment_capacity" },
      { name: "project_team_model_operation_usage" },
      { name: "project_team_model_pending_deadline" },
      { name: "project_team_model_route_capacity" },
      { name: "project_team_transport_environment_slot" },
      { name: "project_team_transport_model_slot" },
      { name: "project_team_transport_recovery" },
    ]);
    expect(
      yield* sql`SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='project_team_mailbox_input'
          AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
    ).toEqual([{ name: "project_team_mailbox_input_operation" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
