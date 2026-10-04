import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";
import { purgeProjectTeamRecords } from "../../../projectWork/ProjectTeamsPersistence.ts";

const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 28 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_memory_source
    (record_id,project_id,status,revision,generation,updated_at,payload_json)
    VALUES ('source','project','current',0,0,'2026-10-04T00:00:00.000Z','{}')`;
  const original = yield* sql`SELECT * FROM project_team_memory_source`;
  yield* runMigrations();
  yield* runMigrations();
  expect(yield* sql`SELECT * FROM project_team_memory_source`).toEqual(original);
  return sql;
});

it.effect("retains immutable cleanup and manifest bytes after source projections are purged", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_team_memory_manifest VALUES
      ('extraction','environment','project','source',0,0,'{"prepared":true}')`;
    yield* sql`INSERT INTO project_team_memory_job VALUES
      ('effect','environment','project','{"original":true}',0,'pending',NULL)`;
    for (const [column, replacement] of [
      ["extraction_id", "changed"],
      ["environment_id", "changed"],
      ["project_id", "changed"],
      ["source_id", "changed"],
      ["source_revision", 1],
      ["source_generation", 1],
      ["manifest_json", "{}"],
    ] as const)
      expect(
        (yield* sql`UPDATE project_team_memory_manifest SET ${sql(column)}=${replacement}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    for (const column of ["effect_id", "environment_id", "project_id", "input_json"])
      expect(
        (yield* sql`UPDATE project_team_memory_job SET ${sql(column)}='changed'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    yield* sql`INSERT INTO project_team_memory_job VALUES
      ('effect','foreign','foreign','{}',0,'pending',NULL) ON CONFLICT(effect_id) DO NOTHING`;
    yield* sql.withTransaction(purgeProjectTeamRecords(sql, "project"));
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toEqual([]);
    expect(
      yield* sql`SELECT environment_id,project_id,input_json FROM project_team_memory_job`,
    ).toEqual([
      { environment_id: "environment", project_id: "project", input_json: '{"original":true}' },
    ]);
    expect(yield* sql`SELECT manifest_json FROM project_team_memory_manifest`).toEqual([
      { manifest_json: '{"prepared":true}' },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("fences recovery epochs and makes completed receipts absorbing", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_team_memory_job VALUES
      ('effect','environment','project','{}',0,'pending',NULL)`;
    expect(
      (yield* sql`UPDATE project_team_memory_job SET status='settled',receipt_json='{}'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=1`;
    yield* sql`UPDATE project_team_memory_job SET status='uncertain'`;
    yield* runMigrations();
    expect(
      yield* sql`SELECT status,claim_generation,receipt_json FROM project_team_memory_job`,
    ).toEqual([{ status: "uncertain", claim_generation: 1, receipt_json: null }]);
    expect(
      (yield* sql`UPDATE project_team_memory_job SET status='pending',claim_generation=0`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_team_memory_job SET status='claimed'`.pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=2`;
    yield* sql`UPDATE project_team_memory_job SET status='settled',receipt_json='{"complete":true}'`;
    for (const mutation of [
      sql`UPDATE project_team_memory_job SET status='claimed',receipt_json=NULL`,
      sql`UPDATE project_team_memory_job SET receipt_json='{}'`,
      sql`UPDATE project_team_memory_job SET claim_generation=3`,
    ])
      expect((yield* mutation.pipe(Effect.result))._tag).toBe("Failure");
    expect(
      yield* sql`SELECT status,claim_generation,receipt_json FROM project_team_memory_job`,
    ).toEqual([{ status: "settled", claim_generation: 2, receipt_json: '{"complete":true}' }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses invalid ownership states, fractional counters and oversized UTF8 storage", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    const oversizedJob = yield* encodeString("é".repeat(131072));
    const oversizedManifest = yield* encodeString("é".repeat(2097152));
    for (const [id, input, claim, status, receipt] of [
      [null, "{}", 0, "pending", null],
      ["effect", "bad", 0, "pending", null],
      ["effect", oversizedJob, 0, "pending", null],
      ["effect", "{}", 0.5, "claimed", null],
      ["effect", "{}", 0, "claimed", null],
      ["effect", "{}", 1, "pending", null],
      ["effect", "{}", 1, "settled", null],
      ["effect", "{}", 1, "claimed", "{}"],
      ["effect", "{}", 1, "settled", oversizedJob],
      ["effect", "{}", 1, "settled", "bad"],
    ] as const)
      expect(
        (yield* sql`INSERT INTO project_team_memory_job VALUES
        (${id},'environment','project',${input},${claim},${status},${receipt})`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    for (const [id, revision, generation, manifest] of [
      [null, 0, 0, "{}"],
      ["extraction", 0.5, 0, "{}"],
      ["extraction", 0, -1, "{}"],
      ["extraction", 0, 0, "bad"],
      ["extraction", 0, 0, oversizedManifest],
    ] as const)
      expect(
        (yield* sql`INSERT INTO project_team_memory_manifest VALUES
        (${id},'environment','project','source',${revision},${generation},${manifest})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_team_memory_manifest`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
