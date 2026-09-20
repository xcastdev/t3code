import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable project-work read models.
 *
 * The event log remains authoritative. These tables deliberately keep nested
 * contract values as JSON while giving every searchable/ordered field a
 * first-class column. The projector can therefore rebuild rows without
 * coupling this migration to a future command or event decoder.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // This is the sole authoritative project-work log. It is intentionally
  // separate from legacy orchestration_events so rebuilds and leases cannot
  // accidentally depend on a capped read-model stream.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (project_id, event_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_events_project_sequence
    ON project_work_events(project_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_events_project_type_sequence
    ON project_work_events(project_id, event_type, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_events_project_command_sequence
    ON project_work_events(project_id, command_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      state TEXT NOT NULL,
      specification_json TEXT,
      assignee_json TEXT,
      watchers_json TEXT NOT NULL DEFAULT '[]',
      approval_json TEXT,
      revision INTEGER NOT NULL,
      spec_revision INTEGER NOT NULL,
      active_attempt_id TEXT,
      failure_kind TEXT,
      blocker_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      canceled_at TEXT,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_attempts (
      attempt_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      lease_token TEXT,
      leased_until TEXT,
      started_at TEXT,
      ended_at TEXT,
      failure_kind TEXT,
      failure_reason TEXT,
      failure_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      failure_resolved_at TEXT,
      failure_resolution_reason TEXT,
      failure_resolution_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      failure_resolution_attribution_json TEXT,
      checkpoint_ids_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_criteria (
      criterion_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      description TEXT NOT NULL,
      required INTEGER NOT NULL,
      status TEXT NOT NULL,
      satisfied_by_evidence_ids_json TEXT NOT NULL,
      waiver_json TEXT,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_evidence (
      evidence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      criterion_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      uri TEXT,
      recorded_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_relationships (
      relationship_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_task_id TEXT NOT NULL,
      to_task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_blockers (
      blocker_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      resolver TEXT NOT NULL,
      reference_ids_json TEXT NOT NULL,
      attention INTEGER NOT NULL,
      resolved_at TEXT,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_knowledge (
      knowledge_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      supersedes_knowledge_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_decisions (
      decision_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      supersedes_decision_id TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attribution_json TEXT,
      rejection_reason TEXT,
      rejected_at TEXT,
      state_transition_attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_comments (
      comment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )
  `;

  // Activity and checkpoint rows are append-only companions to attempts. They
  // keep the stable timeline and captured refs available after lease expiry or
  // a projection rebuild, without making the task row a growing event log.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_activity (
      activity_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      occurred_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      ref TEXT,
      captured_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_attention (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      seen_at TEXT,
      resolved_at TEXT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, task_id)
    )
  `;

  // This cursor is separate from legacy projectors so a work-model rebuild can
  // reset its own progress without replaying or disturbing existing clients.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL DEFAULT 0,
      rebuild_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS project_work_search_fts USING fts5(
      project_id UNINDEXED,
      record_kind UNINDEXED,
      record_id UNINDEXED,
      title,
      body,
      provenance_json UNINDEXED,
      revision UNINDEXED,
      tokenize = 'unicode61'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_tasks_project_state_updated
    ON project_work_tasks(project_id, state, updated_at, task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_tasks_project_updated
    ON project_work_tasks(project_id, updated_at, task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_attempts_project_task_updated
    ON project_work_attempts(project_id, task_id, updated_at)
  `;

  // SQLite's partial unique index is the storage-level fence for one active
  // attempt. Terminal history remains appendable for the same task.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_work_attempts_one_active_task
    ON project_work_attempts(task_id)
    WHERE state IN ('leased', 'running')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_attempts_project_state
    ON project_work_attempts(project_id, state, leased_until, attempt_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_criteria_project_task
    ON project_work_criteria(project_id, task_id, criterion_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_evidence_project_recorded
    ON project_work_evidence(project_id, recorded_at, evidence_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_relationships_project_from
    ON project_work_relationships(project_id, from_task_id, kind, to_task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_relationships_project_to
    ON project_work_relationships(project_id, to_task_id, kind, from_task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_blockers_project_attention
    ON project_work_blockers(project_id, attention, task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_knowledge_project_updated
    ON project_work_knowledge(project_id, updated_at, knowledge_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_decisions_project_updated
    ON project_work_decisions(project_id, updated_at, decision_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_comments_project_created
    ON project_work_comments(project_id, created_at, comment_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_activity_project_occurred
    ON project_work_activity(project_id, occurred_at, activity_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_checkpoints_project_attempt
    ON project_work_checkpoints(project_id, attempt_id, captured_at, checkpoint_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_projection_state_sequence
    ON project_work_projection_state(last_applied_sequence)
  `;

  // These columns are additive so databases created before P2 retain all
  // existing command receipts and can be upgraded without rewriting history.
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN fingerprint TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN actor_kind TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN actor_id TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN source_kind TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN source_id TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts ADD COLUMN result_json TEXT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_fingerprint
    ON orchestration_command_receipts(fingerprint)
  `;
});
