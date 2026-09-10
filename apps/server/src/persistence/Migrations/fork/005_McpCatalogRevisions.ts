import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Keep catalog revisions independent of live definition rows. A scope must
 * remember its last revision after its final definition is removed, and a
 * session must retain application state across projection reconstruction.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork migration 004 populated definitions from legacy rows. Collapse any
  // duplicate logical identities deterministically before enforcing the
  // replacement invariant used by the SQL projector.
  yield* sql`
    DELETE FROM projection_mcp_definitions
    WHERE rowid NOT IN (
      SELECT rowid
      FROM (
        SELECT
          rowid,
          ROW_NUMBER() OVER (
            PARTITION BY scope_type, scope_id, logical_server_id
            ORDER BY revision DESC, definition_id DESC
          ) AS duplicate_rank
        FROM projection_mcp_definitions
      )
      WHERE duplicate_rank = 1
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_projection_mcp_definitions_identity
    ON projection_mcp_definitions(scope_type, scope_id, logical_server_id)
  `;

  yield* sql`
    CREATE TABLE projection_mcp_catalog_revisions (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(scope_type, scope_id)
    )
  `;

  yield* sql`
    INSERT INTO projection_mcp_catalog_revisions (scope_type, scope_id, revision)
    SELECT scope_type, scope_id, MAX(revision)
    FROM (
      SELECT scope_type, scope_id, revision FROM projection_mcp_definitions
      UNION ALL
      SELECT 'project', scope_id, MAX(revision)
      FROM projection_mcp_overrides
      GROUP BY scope_id
    )
    GROUP BY scope_type, scope_id
  `;

  yield* sql`
    ALTER TABLE projection_mcp_catalog_sessions ADD COLUMN application_status TEXT
  `;
  yield* sql`
    ALTER TABLE projection_mcp_catalog_sessions ADD COLUMN application_revision INTEGER
  `;
  yield* sql`
    ALTER TABLE projection_mcp_catalog_sessions ADD COLUMN application_applied_at TEXT
  `;
  yield* sql`
    ALTER TABLE projection_mcp_catalog_sessions ADD COLUMN application_failed_at TEXT
  `;
  yield* sql`
    UPDATE projection_mcp_catalog_sessions
    SET application_status = CASE WHEN application_error IS NULL THEN NULL ELSE 'failed' END,
        application_revision = CASE WHEN application_error IS NULL THEN NULL ELSE desired_revision END,
        application_failed_at = CASE WHEN application_error IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
    WHERE application_error IS NOT NULL
  `;
});
