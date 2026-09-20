import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Attention is a semantic occurrence, while notification publication is a
 * retryable side effect. Keeping both records durable makes a restart safe:
 * projection rebuilds can restore the current attention row without sending a
 * second notification for the same occurrence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_attention_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE (project_id, task_id, reason, revision)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_attention_occurrences_active
    ON project_work_attention_occurrences(project_id, task_id, resolved_at, revision)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_notification_publications (
      publication_id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      task_state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      owner_id TEXT,
      claim_token TEXT,
      claimed_until TEXT,
      delivered_destination_ids_json TEXT NOT NULL DEFAULT '[]',
      failed_destination_ids_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      outcome_json TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_notification_publications_queue
    ON project_work_notification_publications(status, available_at, claimed_until, publication_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_notification_publications_project
    ON project_work_notification_publications(project_id, revision, publication_id)
  `;
});
