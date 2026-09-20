import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Project lifecycle state is deliberately separate from the legacy project
 * projection.  The projection can keep its historical `deleted_at` row for
 * old clients while lifecycle operations retain a stable tombstone and local
 * deletion audit.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_lifecycle (
      project_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'tombstoned')),
      workspace_root TEXT NOT NULL,
      repository_key TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      changed_at TEXT NOT NULL,
      tombstone_json TEXT,
      UNIQUE(project_id, revision)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_lifecycle_state
    ON project_lifecycle(state, changed_at, project_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_lifecycle_operations (
      project_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, command_id)
    )
  `;
});
