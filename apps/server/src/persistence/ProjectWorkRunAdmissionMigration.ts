import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "index",
    name: "t3_workflow_v2_idx_team_binding_thread",
    sql: `CREATE INDEX t3_workflow_v2_idx_team_binding_thread ON t3_workflow_v2_team_records(json_extract(payload_json,'$.threadId')) WHERE kind = 'run-binding'`,
  },

  {
    type: "table",
    name: "t3_workflow_v2_admission_controls",
    sql: `CREATE TABLE t3_workflow_v2_admission_controls (
    control_id TEXT PRIMARY KEY,
    admission_id TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  },

  {
    type: "table",
    name: "t3_workflow_v2_run_admissions",
    sql: `CREATE TABLE t3_workflow_v2_run_admissions (
    admission_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    root_task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    run_attempt_id TEXT,
    generation INTEGER NOT NULL,
    fence INTEGER NOT NULL,
    command_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('prepared', 'queued', 'admitted', 'launched', 'stopping', 'settled')),
    depth INTEGER NOT NULL,
    writable INTEGER NOT NULL,
    root_deadline TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    control_id TEXT,
    control_thread_id TEXT,
    snapshot_json TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    parent_admission_id TEXT,
    uncertain INTEGER NOT NULL DEFAULT 0,
    native_terminal INTEGER NOT NULL DEFAULT 0,
    UNIQUE(thread_id, run_id)
  )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_run_admissions_root",
    sql: `CREATE INDEX t3_workflow_v2_idx_run_admissions_root ON t3_workflow_v2_run_admissions(root_id, phase)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_run_admissions_thread",
    sql: `CREATE INDEX t3_workflow_v2_idx_run_admissions_thread ON t3_workflow_v2_run_admissions(thread_id)`,
  },
] as const;
export const projectWorkRunAdmissionMigration: WorkflowFeatureMigration = {
  id: 5,
  name: "ProjectWorkRunAdmission",
  statements: objects.map((object) => object.sql),
  objects,
};
