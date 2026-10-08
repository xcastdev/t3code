import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect(
  "preserves legacy model capacity and populated mailbox foreign keys while adding memory lanes",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 41 });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }]);
      yield* sql`INSERT INTO project_team_model_budget VALUES('environment','project','root',10000,2000)`;
      for (const [index, status, capacity] of [
        [0, "held", "held"],
        [1, "unknown", "quarantine"],
        [2, "reported", "released"],
      ] as const) {
        yield* sql`INSERT INTO project_team_model_request (
        reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
        operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
        maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
        charged_input_tokens,charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json)
        VALUES(${"legacy-" + index},'environment','project','root','binding','attempt','worker',1,
          'original-operation',${index + 1},'original-route','command-code',${"model-" + index},
          ${index},0,100,100,2000,${status},${capacity},${status === "held" ? 0 : 100},
          ${status === "held" ? 0 : 100},${status === "held" ? null : "receipt-" + index},
          '{}',${status === "held" ? null : "{}"})`;
      }
      // These are retained physical migration fixtures, not new execution authority.
      yield* sql`INSERT INTO project_team_run_binding
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES('binding','project','running',0,1,'2026-01-01T00:00:00.000Z','{}')`;
      yield* sql`INSERT INTO project_team_dispatch (
      dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,worktree,branch,
      root_task_id,root_maximum_tokens,root_deadline_at_ms,attempt_maximum_tokens,attempt_deadline_at_ms,
      delegation_depth,maximum_delegation_depth,repair_allowance,stage,revision,claim_generation,
      intent_json,created_at,updated_at)
      VALUES('dispatch','environment','project','binding',1,'task','attempt','/workspace','work',
        'root',10000,2000,1000,1000,0,0,0,'settled',0,0,'{}','2026-01-01','2026-01-01')`;
      yield* sql`INSERT INTO project_team_pi_operation (
      operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
      operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,
      deadline_at_ms,status,intent_json)
      VALUES('original-operation','environment','project','binding',1,'pi','thread','worker',0,'prompt',
        'hash','binding','root',1000,1000,'settled','{}')`;
      const hash = "a".repeat(64);
      yield* sql`INSERT INTO project_team_mailbox_batch (
      operation_id,batch_id,environment_id,project_id,dispatch_id,binding_id,generation,manifest_json,
      manifest_sha256,system_text,system_text_sha256,revision,status)
      VALUES('original-operation','batch','environment','project','dispatch','binding',1,'{}',
        ${hash},'original system text',${hash},0,'sealed')`;
      yield* sql`INSERT INTO project_team_mailbox_input
      VALUES('legacy-0','original-operation',1,'worker',1,'original-route','command-code','model-0',${hash},${hash})`;
      yield* sql`INSERT INTO project_team_memory_job
      VALUES('effect','environment','project','{}',0,'pending',NULL)`;
      const requests = yield* sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
      const mailbox = yield* sql`SELECT * FROM project_team_mailbox_input`;
      const job = yield* sql`SELECT * FROM project_team_memory_job`;
      expect(yield* runForkMigrations(42)).toEqual([[42, "ProjectMemoryProcessing"]]);
      expect(yield* sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`).toEqual(
        requests.map((row) => ({ ...row, request_lane: "pi", request_scope: "" })),
      );
      expect(yield* sql`SELECT * FROM project_team_mailbox_input`).toEqual(mailbox);
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual(
        job.map((row) => ({ ...row, owner_json: null })),
      );
      expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }]);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      expect(
        yield* sql`SELECT "table" AS target FROM pragma_foreign_key_list('project_team_mailbox_input')
      WHERE "from"='reservation_id'`,
      ).toEqual([{ target: "project_team_model_request" }]);
      for (const index of [0, 1]) {
        expect(
          yield* sql`INSERT INTO project_team_model_request (
        reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
        operation_id,request_id,request_lane,request_scope,route_id,provider,model,environment_slot,model_slot,
        maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
        charged_input_tokens,charged_output_tokens,reservation_json)
        VALUES(${"blocked-memory-" + index},'environment','project','root','binding','attempt','worker',1,
          'original-operation',1,'memory',${hash},'embedding','openrouter','embedding-model',${index},3,
          100,1,1000,'held','held',0,0,'{}')`.pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }
      yield* sql`INSERT INTO project_team_model_request (
      reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
      operation_id,request_id,request_lane,request_scope,route_id,provider,model,environment_slot,model_slot,
      maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,capacity_state,
      charged_input_tokens,charged_output_tokens,reservation_json)
      VALUES('memory-stage','environment','project','root','binding','attempt','worker',1,
        'original-operation',1,'memory',${hash},'embedding','openrouter','embedding-model',2,0,
        100,1,1000,'held','held',0,0,'{}')`;
      expect(
        yield* sql`SELECT reservation_id FROM project_team_model_request
      WHERE worker_id='worker' AND generation=1 AND operation_id='original-operation' AND request_id=1
      ORDER BY reservation_id`,
      ).toEqual([{ reservation_id: "legacy-0" }, { reservation_id: "memory-stage" }]);
      expect(
        yield* sql`UPDATE project_team_mailbox_input SET model='changed'`.pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* sql`DELETE FROM project_team_mailbox_input`.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      yield* sql`UPDATE project_team_memory_job SET owner_json='{"version":1,"operationId":"original-operation"}'
      WHERE effect_id='effect'`;
      expect(
        yield* sql`UPDATE project_team_memory_job SET owner_json='{"version":1,"operationId":"other"}'
      WHERE effect_id='effect'`.pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* sql`SELECT status,receipt_json FROM project_team_memory_job`).toEqual([
        { status: "pending", receipt_json: null },
      ]);
      expect(yield* runForkMigrations(42)).toEqual([]);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
