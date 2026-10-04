import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";
import { purgeProjectTeamRecords } from "../../../projectWork/ProjectTeamsPersistence.ts";

const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 29 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_memory_job VALUES
    ('original-effect','environment','project','{"original":true}',1,'settled','{"complete":true}')`;
  const original = yield* sql`SELECT * FROM project_team_memory_job`;
  yield* runMigrations();
  yield* runMigrations();
  expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual(original);
  return sql;
});

it.effect("retains the first reflection owner through replacement and upsert retries", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_team_memory_outcome VALUES
      ('original-effect','environment','project',1,'{"complete":true}','{"original":true}')`;
    const original = yield* sql`SELECT * FROM project_team_memory_outcome`;
    yield* sql`INSERT OR REPLACE INTO project_team_memory_outcome VALUES
      ('original-effect','foreign','foreign',2,'{}','{}')`;
    yield* sql`INSERT INTO project_team_memory_outcome VALUES
      ('original-effect','foreign','foreign',2,'{}','{}')
      ON CONFLICT(effect_id) DO UPDATE SET environment_id=excluded.environment_id,
        project_id=excluded.project_id,claim_generation=excluded.claim_generation,
        receipt_json=excluded.receipt_json,reflection_json=excluded.reflection_json`;
    expect(yield* sql`SELECT * FROM project_team_memory_outcome`).toEqual(original);
    for (const [column, replacement] of [
      ["effect_id", "changed"],
      ["environment_id", "changed"],
      ["project_id", "changed"],
      ["claim_generation", 2],
      ["receipt_json", "{}"],
      ["reflection_json", "{}"],
    ] as const)
      expect(
        (yield* sql`UPDATE project_team_memory_outcome SET ${sql(column)}=${replacement}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    yield* sql`UPDATE project_team_memory_outcome SET reflection_json=reflection_json`;
    expect(yield* sql`SELECT * FROM project_team_memory_outcome`).toEqual(original);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "keeps original cleanup receipts after project records and ownership rows are purged",
  () =>
    Effect.gen(function* () {
      const sql = yield* fixture;
      yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('project','Disposable','/disposable','[]','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`;
      yield* sql`INSERT INTO project_team_memory_source
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('source','project','retracted',1,1,'2026-10-04T00:00:00.000Z','{}')`;
      yield* sql`INSERT INTO project_team_memory_outcome VALUES
      ('original-effect','environment','project',1,'{"complete":true}','{"mode":"purged-cleanup"}')`;
      const original = yield* sql`SELECT * FROM project_team_memory_outcome`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* purgeProjectTeamRecords(sql, "project");
          yield* sql`DELETE FROM project_team_memory_job WHERE project_id='project'`;
          yield* sql`DELETE FROM projection_projects WHERE project_id='project'`;
        }),
      );
      expect(yield* sql`SELECT * FROM project_team_memory_source`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_memory_job`).toEqual([]);
      expect(yield* sql`SELECT * FROM projection_projects`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_memory_outcome`).toEqual(original);
      expect(yield* sql`PRAGMA foreign_key_list(project_team_memory_outcome)`).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects invalid original counters, identifiers and encoded UTF8 receipt budgets", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    const oversized = yield* encodeString("é".repeat(131072));
    for (const [id, environmentId, projectId, generation, receipt, reflection] of [
      [null, "environment", "project", 1, "{}", "{}"],
      ["", "environment", "project", 1, "{}", "{}"],
      ["x".repeat(257), "environment", "project", 1, "{}", "{}"],
      ["effect", "", "project", 1, "{}", "{}"],
      ["effect", "environment", "", 1, "{}", "{}"],
      ["effect", "environment", "project", 0, "{}", "{}"],
      ["effect", "environment", "project", 1.5, "{}", "{}"],
      ["effect", "environment", "project", Number.MAX_SAFE_INTEGER + 1, "{}", "{}"],
      ["effect", "environment", "project", 1, "invalid", "{}"],
      ["effect", "environment", "project", 1, "{}", "invalid"],
      ["effect", "environment", "project", 1, oversized, "{}"],
      ["effect", "environment", "project", 1, "{}", oversized],
    ] as const)
      expect(
        (yield* sql`INSERT INTO project_team_memory_outcome VALUES
          (${id},${environmentId},${projectId},${generation},${receipt},${reflection})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    yield* sql`INSERT INTO project_team_memory_outcome VALUES
      ('effect','environment','project',${Number.MAX_SAFE_INTEGER},'{}','{}')`;
    expect(yield* sql`SELECT claim_generation FROM project_team_memory_outcome`).toEqual([
      { claim_generation: Number.MAX_SAFE_INTEGER },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
