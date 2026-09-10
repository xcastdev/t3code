import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  FORK_MIGRATIONS_TABLE,
  forkMigrationEntries,
  migrationEntries,
  runForkMigrations,
  runMigrations,
} from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork migration sequence", (it) => {
  it.effect("runs fork migrations even when upstream already claimed those ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      // Upstream ids beyond this fork's history, of the kind a future
      // upstream merge brings along. They must not suppress fork work.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (50, 'SomeFutureUpstreamMigration', CURRENT_TIMESTAMP)
      `;

      const applied = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      assert.deepEqual(
        applied.map((row) => row.id),
        forkMigrationEntries.map(([id]) => id),
      );

      // Re-running is a no-op rather than a replay, and the high upstream id
      // did not hide any fork migration.
      const rerun = yield* runForkMigrations();
      assert.deepEqual(rerun, []);
      const provenance = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turns') WHERE name = 'model'
      `;
      assert.equal(provenance.length, 1);
    }),
  );

  it.effect("keeps the two sequences in separate tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const upstream = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id
        FROM effect_sql_migrations
        WHERE name != 'SomeFutureUpstreamMigration'
        ORDER BY migration_id
      `;
      assert.deepEqual(
        upstream.map((row) => row.id),
        migrationEntries.map(([id]) => id),
      );
      // The fork sequence restarts at 1. Its ids deliberately overlap
      // upstream's, which is safe precisely because each sequence only ever
      // compares an id against the latest id in its own table.
      assert.equal(forkMigrationEntries[0]?.[0], 1);
      const forkRows = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      assert.deepEqual(
        forkRows.map((row) => row.id),
        forkMigrationEntries.map(([id]) => id),
      );
    }),
  );
});
