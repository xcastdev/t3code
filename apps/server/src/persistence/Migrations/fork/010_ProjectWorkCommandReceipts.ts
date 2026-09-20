import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Actor-bound command receipts make retries idempotent without allowing a
 * command id to be replayed with a different payload or principal. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_command_receipts (
      project_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT,
      source_kind TEXT,
      source_id TEXT,
      event_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result_json TEXT,
      PRIMARY KEY (project_id, command_id)
    )
  `;
  // Fork databases created during the P4/P5 work may already have this table.
  // Keep the migration additive for those databases.
  yield* sql`ALTER TABLE project_work_command_receipts ADD COLUMN result_json TEXT`.pipe(
    Effect.catch(() => Effect.succeed([])),
  );
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_command_receipts_project
    ON project_work_command_receipts(project_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_approvals (
      approval_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      spec_revision INTEGER NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      approved_by_id TEXT NOT NULL,
      approved_by_display_name TEXT,
      source_kind TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_approvals_agent
    ON project_work_approvals(project_id, task_id, agent_id, expires_at)
  `;
});
