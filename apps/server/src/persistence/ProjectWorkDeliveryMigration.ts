import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_verification_jobs",
    sql: "CREATE TABLE t3_workflow_v2_verification_jobs (project_id TEXT NOT NULL, job_id TEXT NOT NULL, manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, runtime_files_json TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('prepared','claimed','finished','applied')), claim_id TEXT, result_json TEXT, PRIMARY KEY(project_id,job_id))",
  },
  {
    type: "table",
    name: "t3_workflow_v2_team_reviews",
    sql: "CREATE TABLE t3_workflow_v2_team_reviews(environment_id TEXT NOT NULL,project_id TEXT NOT NULL,review_binding_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,completion_json TEXT,proposal_json TEXT,PRIMARY KEY(environment_id,project_id,review_binding_id))",
  },
  {
    type: "table",
    name: "t3_workflow_v2_delivery_operations",
    sql: "CREATE TABLE t3_workflow_v2_delivery_operations (operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, gate_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create-pr','merge')), decision_hash TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('approved','claimed','uncertain','confirmed')), payload_json TEXT NOT NULL, UNIQUE(kind,decision_hash), UNIQUE(project_id,task_id,kind,gate_id))",
  },
  {
    type: "index",
    name: "t3_workflow_v2_delivery_operations_recovery",
    sql: "CREATE INDEX t3_workflow_v2_delivery_operations_recovery ON t3_workflow_v2_delivery_operations(stage,operation_id)",
  },
] as const;

export const projectWorkDeliveryMigration: WorkflowFeatureMigration = {
  id: 11,
  name: "ProjectWorkDelivery",
  objects,
  statements: objects.map(({ sql }) => sql),
};
