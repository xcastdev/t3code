import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "../../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const PROVENANCE_COLUMNS = [
  "model",
  "effort",
  "command_count",
  "tool_call_count",
  "subagent_count",
  "changed_file_count",
] as const;

layer("fork 001 ProjectionTurnsProvenance", (it) => {
  it.effect("adds the per-turn provenance columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 0 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      const beforeNames = new Set(before.map((column) => column.name));
      for (const column of PROVENANCE_COLUMNS) {
        assert.isFalse(beforeNames.has(column), `expected ${column} to be absent at 43`);
      }

      yield* runMigrations({ toForkMigrationInclusive: 1 });

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      const afterNames = new Set(after.map((column) => column.name));
      for (const column of PROVENANCE_COLUMNS) {
        assert.ok(afterNames.has(column), `expected ${column} to be added by 44`);
      }
    }),
  );

  it.effect("leaves existing turn rows readable with null provenance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 0 });

      // A turn that settled before the migration must survive it untouched:
      // the columns are additive and nullable, and nothing is backfilled.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES ('thread-1', 'turn-1', 'completed', '2026-01-01T00:00:00.000Z', '[]')
      `;

      yield* runMigrations({ toForkMigrationInclusive: 1 });

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly model: string | null;
        readonly commandCount: number | null;
      }>`
        SELECT
          turn_id AS "turnId",
          state,
          model,
          command_count AS "commandCount"
        FROM projection_turns
      `;

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.turnId, "turn-1");
      assert.strictEqual(rows[0]?.state, "completed");
      assert.strictEqual(rows[0]?.model, null);
      assert.strictEqual(rows[0]?.commandCount, null);
    }),
  );

  it.effect("is idempotent when the columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 1 });
      yield* runMigrations({ toForkMigrationInclusive: 1 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      for (const column of PROVENANCE_COLUMNS) {
        assert.strictEqual(
          columns.filter((entry) => entry.name === column).length,
          1,
          `expected exactly one ${column} column`,
        );
      }
    }),
  );
});
