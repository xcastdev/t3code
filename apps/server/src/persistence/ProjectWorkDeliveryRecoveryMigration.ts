import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_delivery_previews",
    sql: "CREATE TABLE t3_workflow_v2_delivery_previews (project_id TEXT NOT NULL, task_id TEXT NOT NULL, command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, gate_id TEXT NOT NULL, base_ref TEXT NOT NULL)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_delivery_previews_task",
    sql: "CREATE INDEX t3_workflow_v2_delivery_previews_task ON t3_workflow_v2_delivery_previews(project_id,task_id,command_id)",
  },
] as const;
export const projectWorkDeliveryRecoveryMigration: WorkflowFeatureMigration = {
  id: 15,
  name: "ProjectWorkDeliveryRecovery",
  objects,
  statements: objects.map(({ sql }) => sql),
};
