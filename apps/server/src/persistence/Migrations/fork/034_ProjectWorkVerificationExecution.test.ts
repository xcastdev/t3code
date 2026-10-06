import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const insert = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_work_verification_execution
    (environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,
     intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
    VALUES ('environment','job','project','task','attempt',${"a".repeat(64)},'gate',1,
    '{}',${"b".repeat(64)},${"c".repeat(64)},1000,'claimed',0)`;
});

it.effect("adds one-shot execution after prepared jobs without replacing existing evidence", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toForkMigrationInclusive: 33 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_work_verification_jobs VALUES
      ('environment','prepared','project','task','{}',${"a".repeat(64)})`;
    const prepared = yield* sql`SELECT * FROM project_work_verification_jobs`;
    yield* runForkMigrations();
    expect(
      (yield* sql`SELECT * FROM project_work_verification_execution`.pipe(Effect.result))._tag,
    ).toBe("Success");
    yield* insert;
    const first = yield* sql`SELECT * FROM project_work_verification_execution`;
    yield* sql`INSERT OR REPLACE INTO project_work_verification_execution
      (environment_id,job_id,project_id,task_id,attempt_id,manifest_hash,gate_id,gate_revision,
       intent_json,intent_hash,allocation_hash,deadline_at_ms,phase,revision)
      VALUES ('environment','job','foreign','foreign','replacement',${"d".repeat(64)},'foreign',0,
      '{}',${"e".repeat(64)},${"f".repeat(64)},2000,'claimed',0)`;
    expect(yield* sql`SELECT * FROM project_work_verification_execution`).toEqual(first);
    expect(yield* sql`SELECT * FROM project_work_verification_jobs`).toEqual(prepared);
    expect(yield* runForkMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("fences immutable intent, one-way activation, captured owner and terminal result", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* insert;
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET intent_json='[]',revision=1`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_verification_execution SET phase='activating',revision=1`;
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET phase='claimed',revision=2`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET phase='owner-captured',revision=2`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_verification_execution SET phase='owner-captured',owner_json='{}',revision=2`;
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET owner_json='[]',revision=3`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_verification_execution SET phase='terminal',result_json='{}',result_hash=${"d".repeat(64)},revision=3`;
    const winner = yield* sql`SELECT * FROM project_work_verification_execution`;
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET result_json='[]',revision=4`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_work_verification_execution SET phase='activating',result_json=NULL,result_hash=NULL,revision=4`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_verification_execution SET result_json=result_json`;
    expect(yield* sql`SELECT * FROM project_work_verification_execution`).toEqual(winner);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("bounds physical execution JSON and counters without partial updates", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* insert;
    const first = yield* sql`SELECT * FROM project_work_verification_execution`;
    for (const update of [
      sql`UPDATE project_work_verification_execution SET revision=9007199254740992`,
      sql`UPDATE project_work_verification_execution SET owner_json='not JSON',phase='owner-captured',revision=1`,
      sql`UPDATE project_work_verification_execution SET owner_json=${canonicalProjectWorkPayload("é".repeat(8192))},phase='owner-captured',revision=1`,
      sql`UPDATE project_work_verification_execution SET phase='terminal',result_json=${canonicalProjectWorkPayload("é".repeat(32768))},result_hash=${"d".repeat(64)},revision=1`,
      sql`UPDATE project_work_verification_execution SET phase='terminal',result_json='{}',result_hash=${"D".repeat(64)},revision=1`,
      sql`UPDATE project_work_verification_execution SET phase='terminal',result_json='{}',revision=1`,
    ])
      expect((yield* update.pipe(Effect.result))._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_work_verification_execution`).toEqual(first);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
