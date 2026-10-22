import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_team_dispatches",
    sql: `CREATE TABLE t3_workflow_v2_team_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  binding_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  request_json TEXT NOT NULL,
  assignment TEXT NOT NULL,
  result_json TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('reserved','uncertain','observed','stopping','settled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  },
] as const;
export const projectTeamDispatchMigration: WorkflowFeatureMigration = {
  id: 10,
  name: "ProjectTeamDispatch",
  objects,
  statements: objects.map(({ sql }) => sql),
};
