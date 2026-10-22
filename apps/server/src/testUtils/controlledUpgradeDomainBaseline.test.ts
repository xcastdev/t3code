import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { assertControlledUpgradeDomainEmpty } from "./controlledUpgradeDomainBaseline.ts";

it.effect(
  "admits a fresh domain and refuses copied assistant receipts or model-route configuration",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* assertControlledUpgradeDomainEmpty();
      yield* sql`INSERT INTO t3_workflow_v2_assistant_memory_forget_fences(environment_id,assistant_id,forgotten_at) VALUES ('private-env','private-assistant','2026-01-01T00:00:00.000Z')`;
      assert.equal((yield* Effect.exit(assertControlledUpgradeDomainEmpty()))._tag, "Failure");
      yield* sql`DELETE FROM t3_workflow_v2_assistant_memory_forget_fences`;
      yield* sql`INSERT INTO t3_workflow_v2_memory_configuration(environment_id,owner_kind,owner_id,owner_revision,payload_json) VALUES ('private-env','assistant','private-assistant',1,'{}')`;
      assert.equal((yield* Effect.exit(assertControlledUpgradeDomainEmpty()))._tag, "Failure");
      assert.equal(
        (yield* sql`SELECT COUNT(*) AS count FROM t3_workflow_v2_memory_configuration`)[0]?.count,
        1,
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("refuses copied routine configuration and fire history without consuming either", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* assertControlledUpgradeDomainEmpty();
    yield* sql`INSERT INTO t3_workflow_v2_assistant_routines(task_id,environment_id,assistant_id,project_id,thread_id,configuration_revision,enabled,deleted) VALUES ('copied-task','private-env','private-assistant','private-project','private-thread',1,0,1)`;
    assert.equal((yield* Effect.exit(assertControlledUpgradeDomainEmpty()))._tag, "Failure");
    assert.equal(
      (yield* sql`SELECT COUNT(*) AS count FROM t3_workflow_v2_assistant_routines`)[0]?.count,
      1,
    );
    yield* sql`DELETE FROM t3_workflow_v2_assistant_routines`;
    yield* sql`INSERT INTO t3_workflow_v2_assistant_routine_fires(fire_key,task_id,environment_id,assistant_id,thread_id,configuration_revision,trigger_kind,trigger_identity,command_id,message_id,prompt_hash,started_at,dispatched) VALUES ('copied-fire','copied-task','private-env','private-assistant','private-thread',1,'manual','copied-trigger','copied-command','copied-message','copied-hash','2026-01-01T00:00:00.000Z',0)`;
    assert.equal((yield* Effect.exit(assertControlledUpgradeDomainEmpty()))._tag, "Failure");
    assert.equal(
      (yield* sql`SELECT COUNT(*) AS count FROM t3_workflow_v2_assistant_routine_fires`)[0]?.count,
      1,
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
