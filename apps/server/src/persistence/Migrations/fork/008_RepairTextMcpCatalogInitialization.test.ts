import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork 008 MCP catalog initialization repair", (it) => {
  it.effect("repairs only a swapped nonnegative integral TEXT-affinity revision", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 7 });
      yield* sql`
        INSERT INTO projection_mcp_catalog_sessions (
          catalog_session_id, thread_id, provider_instance_id,
          baseline_json, desired_catalog_json, desired_revision,
          applied_catalog_json, applied_revision, application_error, application_status,
          application_revision, application_applied_at, application_failed_at,
          disposed_at
        ) VALUES
          (
            'corrupted', 'thread-corrupted', 'codex', '[]', '[]', '[]',
            2, 0, NULL, NULL, NULL, NULL, NULL, NULL
          ),
          (
            'fractional', 'thread-fractional', 'codex', '[]', '[]', '[]',
            0.5, 0, NULL, NULL, NULL, NULL, NULL, NULL
          ),
          (
            'negative', 'thread-negative', 'codex', '[]', '[]', '[]',
            -1, 0, NULL, NULL, NULL, NULL, NULL, NULL
          ),
          (
            'malformed', 'thread-malformed', 'codex', '[]', '[]', 'not-json',
            2, 0, NULL, NULL, NULL, NULL, NULL, NULL
          ),
          (
            'intact', 'thread-intact', 'codex', '[]', '[]', 3,
            '["already-applied"]', 2, NULL, NULL, NULL, NULL, NULL, NULL
          )
      `;

      yield* runMigrations({ toForkMigrationInclusive: 8 });

      const rows = yield* sql<{
        readonly catalogSessionId: string;
        readonly desiredRevision: string | number;
        readonly applied: string | number | null;
        readonly appliedRevision: number;
      }>`
        SELECT
          catalog_session_id AS "catalogSessionId",
          desired_revision AS "desiredRevision",
          applied_catalog_json AS "applied",
          applied_revision AS "appliedRevision"
        FROM projection_mcp_catalog_sessions
        ORDER BY catalog_session_id
      `;
      assert.deepEqual(rows, [
        { catalogSessionId: "corrupted", desiredRevision: 2, applied: "[]", appliedRevision: 0 },
        {
          catalogSessionId: "fractional",
          desiredRevision: "[]",
          applied: "0.5",
          appliedRevision: 0,
        },
        {
          catalogSessionId: "intact",
          desiredRevision: 3,
          applied: '["already-applied"]',
          appliedRevision: 2,
        },
        {
          catalogSessionId: "malformed",
          desiredRevision: "not-json",
          applied: "2",
          appliedRevision: 0,
        },
        { catalogSessionId: "negative", desiredRevision: "[]", applied: "-1", appliedRevision: 0 },
      ]);
    }),
  );
});
