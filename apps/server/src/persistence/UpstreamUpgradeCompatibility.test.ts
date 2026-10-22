// @effect-diagnostics nodeBuiltinImport:off -- Database paths belong to temporary synthetic fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlitePersistence from "./Sqlite.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { assertUpstreamUpgradeCompatibility } from "./UpstreamUpgradeCompatibility.ts";
import { workflowFeatureMigrations } from "./WorkflowFeatureSchema.ts";
import { runWorkflowFeatureMigrations } from "./WorkflowFeatureMigrations.ts";

it.effect("accepts a fresh database and an older complete upstream prefix", () =>
  Effect.gen(function* () {
    yield* assertUpstreamUpgradeCompatibility;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* assertUpstreamUpgradeCompatibility;
    yield* runMigrations();
    yield* assertUpstreamUpgradeCompatibility;
    yield* runWorkflowFeatureMigrations();
    yield* assertUpstreamUpgradeCompatibility;
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM effect_sql_migrations`)[0]?.count,
      migrationManifest.length,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  "ahead",
  "name",
  "gap",
  "shape",
  "reserved",
  "reserved-uppercase",
  "view",
] as const)("refuses %s before migrations can change the database", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (scenario === "shape") {
      yield* sql`CREATE TABLE effect_sql_migrations (name TEXT)`;
    } else if (scenario === "view") {
      yield* sql`CREATE VIEW effect_sql_migrations AS SELECT 1 AS migration_id, 'OrchestrationEvents' AS name`;
    } else {
      yield* runMigrations();
      if (scenario === "ahead")
        yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (999,'Unknown')`;
      if (scenario === "name")
        yield* sql`UPDATE effect_sql_migrations SET name = 'Foreign' WHERE migration_id = 1`;
      if (scenario === "gap") yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 2`;
      if (scenario === "reserved") yield* sql`CREATE TABLE t3_workflow_v2_foreign (secret TEXT)`;
      if (scenario === "reserved-uppercase")
        yield* sql`CREATE TABLE T3_WORKFLOW_V2_foreign (secret TEXT)`;
    }
    const before = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    assert.equal((yield* Effect.result(assertUpstreamUpgradeCompatibility))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["53", "54", "54-indexes"] as const)(
  "preserves the supported preview %s reconciliation path",
  (preview) =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          preview === "53"
            ? { "53_OrchestrationV2": OrchestrationV2 }
            : {
                "53_PullRequestFilesViewed": PullRequestFilesViewed,
                "54_OrchestrationV2": OrchestrationV2,
                ...(preview === "54-indexes"
                  ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
                  : {}),
              },
        ),
      });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* assertUpstreamUpgradeCompatibility;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (999,'Unknown')`;
      assert.equal((yield* Effect.result(assertUpstreamUpgradeCompatibility))._tag, "Failure");
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 999`;
      yield* runMigrations();
      yield* assertUpstreamUpgradeCompatibility;
      assert.deepStrictEqual(
        (yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`).map(
          (row) => [row.migration_id, row.name] as const,
        ),
        migrationManifest,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("accepts owned feature identifier case while retaining exact migration names", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`CREATE TABLE T3_WORKFLOW_V2_MIGRATIONS (
      MIGRATION_ID INTEGER PRIMARY KEY,
      NAME TEXT NOT NULL,
      CREATED_AT TEXT NOT NULL DEFAULT (datetime('now'))
    )`;
    yield* sql`INSERT INTO T3_WORKFLOW_V2_MIGRATIONS(MIGRATION_ID,NAME) VALUES (1, 'Foundation')`;
    yield* assertUpstreamUpgradeCompatibility;
    assert.deepStrictEqual(
      yield* runWorkflowFeatureMigrations(),
      workflowFeatureMigrations
        .filter((migration) => migration.id > 1)
        .map((migration) => [migration.id, migration.name]),
    );
    yield* sql`UPDATE T3_WORKFLOW_V2_MIGRATIONS SET NAME = 'foundation'`;
    assert.equal((yield* Effect.result(assertUpstreamUpgradeCompatibility))._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["table", "columns", "table-and-columns"] as const)(
  "production startup refuses upstream ledger %s aliases before any writes",
  (scenario) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ledger-alias-"));
    const dbPath = NodePath.join(directory, "statev2.sqlite");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 52 });
        const sql = yield* SqlClient.SqlClient;
        if (scenario !== "table") {
          yield* sql`ALTER TABLE effect_sql_migrations RENAME COLUMN migration_id TO MIGRATION_ID`;
          yield* sql`ALTER TABLE effect_sql_migrations RENAME COLUMN name TO NAME`;
          yield* sql`ALTER TABLE effect_sql_migrations RENAME COLUMN created_at TO CREATED_AT`;
        }
        if (scenario !== "columns") {
          yield* sql`ALTER TABLE effect_sql_migrations RENAME TO temporary_ledger`;
          yield* sql`ALTER TABLE temporary_ledger RENAME TO EFFECT_SQL_MIGRATIONS`;
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      const beforeBytes = NodeFS.readFileSync(dbPath);
      const beforeDb = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const beforeSchema = beforeDb
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name")
        .all();
      const beforeHistory = beforeDb
        .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
        .all();
      beforeDb.close();
      const result = yield* Effect.result(
        Effect.void.pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath))),
      );
      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(NodeFS.readFileSync(dbPath), beforeBytes);
      const afterDb = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.deepStrictEqual(
          afterDb.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(),
          beforeSchema,
        );
        assert.deepStrictEqual(
          afterDb.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
          beforeHistory,
        );
        assert.equal(
          afterDb.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(afterDb.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
        assert.deepStrictEqual(
          afterDb
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('orchestration_v2_events', 't3_workflow_v2_migrations')",
            )
            .all(),
          [],
        );
      } finally {
        afterDb.close();
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
