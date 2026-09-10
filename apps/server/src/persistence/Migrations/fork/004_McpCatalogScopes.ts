import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Normalized storage for scoped catalogs. The legacy project MCP projection is
 * intentionally left in place for compatibility RPCs and is backfilled into
 * project-local definitions here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN mcp_catalog_session_id TEXT
  `;

  yield* sql`
    CREATE TABLE projection_mcp_definitions (
      definition_id TEXT PRIMARY KEY,
      logical_server_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      provider_instance_ids_json TEXT NOT NULL,
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE projection_mcp_overrides (
      override_id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      target_logical_server_id TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE projection_mcp_catalog_sessions (
      catalog_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      baseline_json TEXT NOT NULL,
      desired_catalog_json TEXT NOT NULL,
      desired_revision INTEGER NOT NULL,
      applied_revision INTEGER NOT NULL,
      application_error TEXT,
      disposed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_definitions_scope
    ON projection_mcp_definitions(scope_type, scope_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_definitions_logical
    ON projection_mcp_definitions(logical_server_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_overrides_scope
    ON projection_mcp_overrides(scope_type, scope_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_overrides_logical
    ON projection_mcp_overrides(target_logical_server_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_catalog_sessions_thread
    ON projection_mcp_catalog_sessions(thread_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_mcp_catalog_sessions_active
    ON projection_mcp_catalog_sessions(thread_id, disposed_at)
  `;

  // URL-only rows are the original project MCP wire shape. Preserve their
  // logical server id and turn the URL into the equivalent explicit transport.
  yield* sql`
    INSERT INTO projection_mcp_definitions (
      definition_id,
      logical_server_id,
      scope_type,
      scope_id,
      name,
      transport_json,
      enabled,
      provider_instance_ids_json,
      revision
    )
    SELECT
      'project-mcp-definition-' || server_id,
      server_id,
      'project',
      project_id,
      name,
      COALESCE(
        transport_json,
        json_object(
          'type', 'streamable-http',
          'url', url,
          'headers', json('[]'),
          'authorization', json_object('type', 'none')
        )
      ),
      enabled,
      provider_instance_ids_json,
      1
    FROM projection_project_mcp_servers
  `;
});
