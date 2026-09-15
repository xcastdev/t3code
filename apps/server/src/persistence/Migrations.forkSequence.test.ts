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
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const layer = it.layer(Layer.mergeAll(Layer.fresh(SqlitePersistenceMemory)));

layer("fork migration sequence", (it) => {
  it.effect("runs independently after the upstream sequence and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const upstream = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(
        upstream.map((row) => row.id),
        migrationEntries.map(([id]) => id),
      );
      const fork = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`;
      assert.deepEqual(
        fork.map((row) => row.id),
        forkMigrationEntries.map(([id]) => id),
      );
      assert.deepEqual(yield* runForkMigrations(), []);
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turns') WHERE name = 'model'`;
      assert.equal(columns.length, 1);
    }),
  );
});
