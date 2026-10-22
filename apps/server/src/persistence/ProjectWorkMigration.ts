import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_work_events",
    sql: `CREATE TABLE t3_workflow_v2_work_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (project_id, event_id)
    )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_events_project_sequence",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_events_project_sequence
    ON t3_workflow_v2_work_events(project_id, sequence)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_events_project_type_sequence",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_events_project_type_sequence
    ON t3_workflow_v2_work_events(project_id, event_type, sequence)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_events_project_command_sequence",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_events_project_command_sequence
    ON t3_workflow_v2_work_events(project_id, command_id, sequence)`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_tasks",
    sql: `CREATE TABLE t3_workflow_v2_work_tasks (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_attempts",
    sql: `CREATE TABLE t3_workflow_v2_work_attempts (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_criteria",
    sql: `CREATE TABLE t3_workflow_v2_work_criteria (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_evidence",
    sql: `CREATE TABLE t3_workflow_v2_work_evidence (
      evidence_id TEXT PRIMARY KEY,
      scope_hash TEXT,
      output_artifact_ids_json TEXT,
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_relationships",
    sql: `CREATE TABLE t3_workflow_v2_work_relationships (
      relationship_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_task_id TEXT NOT NULL,
      to_task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      attribution_json TEXT
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_blockers",
    sql: `CREATE TABLE t3_workflow_v2_work_blockers (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_knowledge",
    sql: `CREATE TABLE t3_workflow_v2_work_knowledge (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_decisions",
    sql: `CREATE TABLE t3_workflow_v2_work_decisions (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_comments",
    sql: `CREATE TABLE t3_workflow_v2_work_comments (
      comment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_activity",
    sql: `CREATE TABLE t3_workflow_v2_work_activity (
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
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_checkpoints",
    sql: `CREATE TABLE t3_workflow_v2_work_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      ref TEXT,
      captured_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attribution_json TEXT
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_attention",
    sql: `CREATE TABLE t3_workflow_v2_work_attention (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      seen_at TEXT,
      resolved_at TEXT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, task_id)
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_projection_state",
    sql: `CREATE TABLE t3_workflow_v2_work_projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL DEFAULT 0,
      rebuild_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_search_fts",
    sql: `CREATE VIRTUAL TABLE t3_workflow_v2_work_search_fts USING fts5(
      project_id UNINDEXED,
      record_kind UNINDEXED,
      record_id UNINDEXED,
      title,
      body,
      provenance_json UNINDEXED,
      revision UNINDEXED,
      tokenize = 'unicode61'
    )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_tasks_project_state_updated",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_tasks_project_state_updated
    ON t3_workflow_v2_work_tasks(project_id, state, updated_at, task_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_tasks_project_updated",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_tasks_project_updated
    ON t3_workflow_v2_work_tasks(project_id, updated_at, task_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_attempts_project_task_updated",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_attempts_project_task_updated
    ON t3_workflow_v2_work_attempts(project_id, task_id, updated_at)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_attempts_one_active_task",
    sql: `CREATE UNIQUE INDEX t3_workflow_v2_idx_work_attempts_one_active_task
    ON t3_workflow_v2_work_attempts(task_id)
    WHERE state IN ('leased', 'running')`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_attempts_project_state",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_attempts_project_state
    ON t3_workflow_v2_work_attempts(project_id, state, leased_until, attempt_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_criteria_project_task",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_criteria_project_task
    ON t3_workflow_v2_work_criteria(project_id, task_id, criterion_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_evidence_project_recorded",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_evidence_project_recorded
    ON t3_workflow_v2_work_evidence(project_id, recorded_at, evidence_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_relationships_project_from",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_relationships_project_from
    ON t3_workflow_v2_work_relationships(project_id, from_task_id, kind, to_task_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_relationships_project_to",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_relationships_project_to
    ON t3_workflow_v2_work_relationships(project_id, to_task_id, kind, from_task_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_blockers_project_attention",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_blockers_project_attention
    ON t3_workflow_v2_work_blockers(project_id, attention, task_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_knowledge_project_updated",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_knowledge_project_updated
    ON t3_workflow_v2_work_knowledge(project_id, updated_at, knowledge_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_decisions_project_updated",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_decisions_project_updated
    ON t3_workflow_v2_work_decisions(project_id, updated_at, decision_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_comments_project_created",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_comments_project_created
    ON t3_workflow_v2_work_comments(project_id, created_at, comment_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_activity_project_occurred",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_activity_project_occurred
    ON t3_workflow_v2_work_activity(project_id, occurred_at, activity_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_checkpoints_project_attempt",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_checkpoints_project_attempt
    ON t3_workflow_v2_work_checkpoints(project_id, attempt_id, captured_at, checkpoint_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_work_projection_state_sequence",
    sql: `CREATE INDEX t3_workflow_v2_idx_work_projection_state_sequence
    ON t3_workflow_v2_work_projection_state(last_applied_sequence)`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_reducer_checkpoints",
    sql: `CREATE TABLE t3_workflow_v2_work_reducer_checkpoints (project_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_command_receipts",
    sql: `CREATE TABLE t3_workflow_v2_work_command_receipts (project_id TEXT NOT NULL, command_id TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, actor_kind TEXT, actor_id TEXT, source_kind TEXT, source_id TEXT, event_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT, PRIMARY KEY (project_id, command_id))`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_work_changed_fts",
    sql: `CREATE TABLE t3_workflow_v2_work_changed_fts (record_kind TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(record_kind, record_id)) WITHOUT ROWID`,
  },
] as const;

export const projectWorkMigration: WorkflowFeatureMigration = {
  id: 2,
  name: "ProjectWork",
  objects: [
    ...objects,
    {
      type: "table",
      name: "t3_workflow_v2_work_search_fts_data",
      sql: `CREATE TABLE 't3_workflow_v2_work_search_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`,
    },
    {
      type: "table",
      name: "t3_workflow_v2_work_search_fts_idx",
      sql: `CREATE TABLE 't3_workflow_v2_work_search_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`,
    },
    {
      type: "table",
      name: "t3_workflow_v2_work_search_fts_content",
      sql: `CREATE TABLE 't3_workflow_v2_work_search_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5, c6)`,
    },
    {
      type: "table",
      name: "t3_workflow_v2_work_search_fts_docsize",
      sql: `CREATE TABLE 't3_workflow_v2_work_search_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`,
    },
    {
      type: "table",
      name: "t3_workflow_v2_work_search_fts_config",
      sql: `CREATE TABLE 't3_workflow_v2_work_search_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`,
    },
  ],
  statements: objects.map((object) => object.sql),
};
