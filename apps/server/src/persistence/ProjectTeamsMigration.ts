import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_team_records",
    sql: `CREATE TABLE t3_workflow_v2_team_records (
    record_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_id TEXT,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_team_records_project_kind",
    sql: `CREATE INDEX t3_workflow_v2_idx_team_records_project_kind ON t3_workflow_v2_team_records(project_id, kind, record_id)`,
  },
] as const;

export const projectTeamsMigration: WorkflowFeatureMigration = {
  id: 3,
  name: "ProjectTeams",
  statements: objects.map((object) => object.sql),
  objects,
};
