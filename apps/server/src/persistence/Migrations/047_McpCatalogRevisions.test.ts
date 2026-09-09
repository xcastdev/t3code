import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047 MCP catalog revisions", (it) => {
  it.effect("backfills deterministic identities, revisions, and application state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      const transport =
        '{"type":"streamable-http","url":"https://catalog.example/mcp","headers":[],"authorization":{"type":"none"}}';
      yield* sql`
        INSERT INTO projection_mcp_definitions (
          definition_id, logical_server_id, scope_type, scope_id, name,
          transport_json, enabled, provider_instance_ids_json, revision
        ) VALUES
          ('definition-global-old', 'server-global', 'global', 'environment-1', 'Old', ${transport}, 1, '["codex"]', 2),
          ('definition-global-new', 'server-global', 'global', 'environment-1', 'New', ${transport}, 1, '["codex"]', 3),
          ('definition-project', 'server-project', 'project', 'project-1', 'Project', ${transport}, 1, '["codex"]', 4)
      `;
      yield* sql`
        INSERT INTO projection_mcp_overrides (
          override_id, scope_type, scope_id, target_logical_server_id, patch_json, revision
        ) VALUES (
          'override-1', 'project', 'project-1', 'server-project',
          '{"id":"override-1","scope":"project","scopeId":"project-1","targetId":"server-project","patch":{"enabled":false},"revision":7}',
          7
        )
      `;
      yield* sql`
        INSERT INTO projection_mcp_catalog_sessions (
          catalog_session_id, thread_id, provider_instance_id,
          baseline_json, desired_catalog_json, desired_revision,
          applied_revision, application_error, disposed_at
        ) VALUES (
          'catalog-session-1', 'thread-1', 'codex', '[]', '[]', 4, 2, 'adapter failed', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const definitions = yield* sql<{
        readonly definitionId: string;
        readonly logicalServerId: string;
        readonly revision: number;
      }>`
        SELECT
          definition_id AS "definitionId",
          logical_server_id AS "logicalServerId",
          revision
        FROM projection_mcp_definitions
        ORDER BY scope_type, scope_id, logical_server_id
      `;
      assert.deepEqual(definitions, [
        {
          definitionId: "definition-global-new",
          logicalServerId: "server-global",
          revision: 3,
        },
        {
          definitionId: "definition-project",
          logicalServerId: "server-project",
          revision: 4,
        },
      ]);

      const revisions = yield* sql<{
        readonly scopeType: string;
        readonly scopeId: string;
        readonly revision: number;
      }>`
        SELECT
          scope_type AS "scopeType",
          scope_id AS "scopeId",
          revision
        FROM projection_mcp_catalog_revisions
        ORDER BY scope_type, scope_id
      `;
      assert.deepEqual(revisions, [
        { scopeType: "global", scopeId: "environment-1", revision: 3 },
        { scopeType: "project", scopeId: "project-1", revision: 7 },
      ]);

      const application = yield* sql<{
        readonly status: string | null;
        readonly revision: number | null;
        readonly error: string | null;
        readonly failedAt: string | null;
      }>`
        SELECT
          application_status AS status,
          application_revision AS revision,
          application_error AS error,
          application_failed_at AS "failedAt"
        FROM projection_mcp_catalog_sessions
        WHERE catalog_session_id = 'catalog-session-1'
      `;
      assert.equal(application[0]?.status, "failed");
      assert.equal(application[0]?.revision, 4);
      assert.equal(application[0]?.error, "adapter failed");
      assert.isNotNull(application[0]?.failedAt);
    }),
  );
});
