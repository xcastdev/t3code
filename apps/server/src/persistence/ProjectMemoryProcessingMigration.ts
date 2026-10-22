import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_memory_processing",
    sql: "CREATE TABLE t3_workflow_v2_memory_processing (\n operation_key TEXT PRIMARY KEY, environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL,\n owner_id TEXT NOT NULL, owner_revision INTEGER NOT NULL, source_id TEXT NOT NULL,\n source_revision INTEGER NOT NULL, generation INTEGER NOT NULL, content_hash TEXT NOT NULL,\n operation TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL,\n result_json TEXT, destination_json TEXT, index_json TEXT, updated_at TEXT NOT NULL\n)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_observations",
    sql: "CREATE TABLE t3_workflow_v2_memory_observations (\n operation_key TEXT NOT NULL, observation_key TEXT NOT NULL, environment_id TEXT NOT NULL,\n owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_revision INTEGER NOT NULL,\n source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, generation INTEGER NOT NULL,\n content_hash TEXT NOT NULL, body TEXT NOT NULL, quote TEXT NOT NULL, source_start INTEGER NOT NULL,\n source_end INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'current', body_hash TEXT NOT NULL DEFAULT '', PRIMARY KEY(operation_key,observation_key)\n)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_memory_processing_pending",
    sql: "CREATE INDEX t3_workflow_v2_memory_processing_pending ON t3_workflow_v2_memory_processing(status,operation_key)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_configuration",
    sql: "CREATE TABLE t3_workflow_v2_memory_configuration (\n environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,\n owner_revision INTEGER NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,\n PRIMARY KEY(environment_id,owner_kind,owner_id,owner_revision)\n)",
  },
] as const;
export const projectMemoryProcessingMigration: WorkflowFeatureMigration = {
  id: 13,
  name: "ProjectMemoryProcessing",
  objects,
  statements: objects.map(({ sql }) => sql),
};
