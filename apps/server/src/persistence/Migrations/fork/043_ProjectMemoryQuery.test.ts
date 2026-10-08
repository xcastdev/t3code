import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "upgrades retained source jobs without rewriting owners and bounds immutable query stage custody",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 42 });
      // These physical custody fixtures confer no operation or model authority.
      yield* sql`INSERT INTO project_team_memory_job
      (effect_id,environment_id,project_id,input_json,status,owner_json)
      VALUES('source','environment','project','{}','pending',${encode({ version: 1, operationId: "original-source-operation" })})`;
      const source = yield* sql`SELECT * FROM project_team_memory_job`;
      yield* runForkMigrations(43);
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual(source);
      yield* sql`INSERT INTO project_team_memory_query
      (query_id,environment_id,project_id,task_id,binding_id,generation,operation_id,command_id,owner_json,status)
      VALUES('query','environment','project','task','binding',1,'operation','command',${encode({ version: 2, fixture: true })},'pending')`;
      const original = yield* sql`SELECT * FROM project_team_memory_query`;
      for (const mutation of [
        sql`UPDATE project_team_memory_query SET owner_json=${encode({ version: 2, fixture: false })}`,
        sql`UPDATE project_team_memory_query SET operation_id='other-operation'`,
        sql`UPDATE project_team_memory_query SET task_id='other-task'`,
        sql`UPDATE project_team_memory_query SET generation=2`,
        sql`UPDATE project_team_memory_query SET search_drain_json=${encode({ padding: "x".repeat(4097) })}`,
        sql`UPDATE project_team_memory_query SET embedding_json=${encode({ padding: "x".repeat(131073) })}`,
        sql`DELETE FROM project_team_memory_query`,
      ]) {
        expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_team_memory_query`).toEqual(original);
      }
      const stage = encode({ fixture: "original-stage" });
      yield* sql`UPDATE project_team_memory_query SET embedding_json=${stage},embedding_result_json=${stage},
      search_json=${stage},search_result_json=${stage},search_drain_json=${stage},result_json=${stage}`;
      const retained = yield* sql`SELECT * FROM project_team_memory_query`;
      for (const mutation of [
        sql`UPDATE project_team_memory_query SET embedding_json=NULL`,
        sql`UPDATE project_team_memory_query SET embedding_result_json='{}'`,
        sql`UPDATE project_team_memory_query SET search_json='{}'`,
        sql`UPDATE project_team_memory_query SET search_result_json='{}'`,
        sql`UPDATE project_team_memory_query SET search_drain_json='{}'`,
        sql`UPDATE project_team_memory_query SET result_json='{}'`,
      ]) {
        expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_team_memory_query`).toEqual(retained);
      }
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual(source);
      expect(yield* runForkMigrations(43)).toEqual([]);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
