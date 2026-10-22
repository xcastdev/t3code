// @effect-diagnostics nodeBuiltinImport:off -- Only caller-owned temporary synthetic SQLite is used.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { prepareUpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationBaseRuntime } from "./upgradeValidationRuntime.ts";
import {
  ControlledRoutineIsolation,
  layerControlledRoutineIsolation,
} from "./controlledRoutineIsolation.ts";

it.live("shadows copied running schedules and every webhook table on reads and transactions", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-routine-isolation-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    NodeFS.mkdirSync(NodePath.join(root, "source"));
    const dbPath = NodePath.join(root, "source", "statev2.sqlite");
    const disposableRoot = NodePath.join(root, "disposable");
    NodeFS.mkdirSync(disposableRoot);
    const copiedId = `assistant-routine-${"a".repeat(64)}`;
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,webhook_token,webhook_secret) VALUES (${copiedId},'private','private',1,'{}','private','{}','{}','full-access','default','user','web','2026-01-01','2026-01-01','2026-01-01','running',7,'private-token','private-secret')`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending VALUES ('copied-delivery',${copiedId},'copied-key',0,'pending','{}','{}','[]')`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys VALUES (${copiedId},'copied-replay','copied-delivery',0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries VALUES ('copied-relay',${copiedId},'2026-01-01')`;
      yield* sql`INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES ('copied-delivery',${copiedId},'2026-01-01','POST','','{}','private',7,0,'accepted',1,'[]')`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const snapshot = yield* Effect.promise(() =>
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot,
        activeDatabasePaths: [dbPath],
      }),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const isolation = yield* ControlledRoutineIsolation;
      assert.equal((yield* sql`SELECT COUNT(*) AS count FROM scheduled_tasks`)[0]?.count, 0);
      assert.equal(
        (yield* sql
          .withTransaction(sql`SELECT COUNT(*) AS count FROM scheduled_tasks`)
          .pipe(NodeSqliteClient.readOnly))[0]?.count,
        0,
      );
      assert.equal((yield* sql`SELECT COUNT(*) AS count FROM main.scheduled_tasks`)[0]?.count, 1);
      const reused =
        yield* sql`INSERT INTO scheduled_tasks SELECT * FROM main.scheduled_tasks`.pipe(
          Effect.exit,
        );
      assert.equal(reused._tag, "Failure");
      const ownedId = `assistant-routine-${"b".repeat(64)}`;
      yield* sql`INSERT INTO scheduled_tasks SELECT ${ownedId},title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count,webhook_token,webhook_secret,last_run_webhook_delivery_id FROM main.scheduled_tasks`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending VALUES ('owned-delivery',${ownedId},'owned-key',0,'pending','{}','{}','[]')`;
      assert.equal(
        (yield* sql`INSERT INTO scheduled_task_webhook_pending VALUES ('duplicate-delivery',${ownedId},'owned-key',0,'pending','{}','{}','[]')`.pipe(
          Effect.exit,
        ))._tag,
        "Failure",
      );
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id=${ownedId}`;
      assert.equal(
        (yield* sql`SELECT COUNT(*) AS count FROM scheduled_task_webhook_pending`)[0]?.count,
        0,
      );
      yield* isolation.assertCopiedUnchanged;
    }).pipe(
      Effect.provide(
        layerControlledRoutineIsolation.pipe(
          Layer.provideMerge(upgradeValidationBaseRuntime(snapshot)),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
