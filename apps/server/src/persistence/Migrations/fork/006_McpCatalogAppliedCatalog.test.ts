import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "../../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork 006 MCP catalog applied catalog", (it) => {
  it.effect("backfills only provably equal-revision applied catalogs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 5 });
      yield* sql`
        INSERT INTO projection_mcp_catalog_sessions (
          catalog_session_id, thread_id, provider_instance_id,
          baseline_json, desired_catalog_json, desired_revision,
          applied_revision, application_error, disposed_at
        ) VALUES
          ('equal', 'thread-equal', 'codex', '[1]', '[2]', 3, 3, NULL, NULL),
          ('stale', 'thread-stale', 'codex', '[1]', '[2]', 4, 2, NULL, NULL)
      `;

      yield* runMigrations({ toForkMigrationInclusive: 6 });

      const rows = yield* sql<{
        readonly sessionId: string;
        readonly applied: string | null;
      }>`
        SELECT catalog_session_id AS "sessionId", applied_catalog_json AS "applied"
        FROM projection_mcp_catalog_sessions
        ORDER BY catalog_session_id
      `;
      assert.deepEqual(rows, [
        { sessionId: "equal", applied: "[2]" },
        { sessionId: "stale", applied: null },
      ]);
    }),
  );
});
