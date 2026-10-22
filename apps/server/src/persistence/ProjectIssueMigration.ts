import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_issue_bindings",
    sql: `CREATE TABLE t3_workflow_v2_issue_bindings (
      project_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository_node_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (project_id, host, repository_node_id)
    ) WITHOUT ROWID`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_issue_pages",
    sql: `CREATE TABLE t3_workflow_v2_issue_pages (
      project_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository_node_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (project_id, host, repository_node_id)
    ) WITHOUT ROWID`,
  },
] as const;

export const projectIssueMigration: WorkflowFeatureMigration = {
  id: 4,
  name: "ProjectIssueIntake",
  objects,
  statements: objects.map((object) => object.sql),
};
