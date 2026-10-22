import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_memory_owners",
    sql: "CREATE TABLE t3_workflow_v2_memory_owners (\n environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,\n revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,\n PRIMARY KEY(environment_id,owner_kind,owner_id)\n)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_sources",
    sql: "CREATE TABLE t3_workflow_v2_memory_sources (\n environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,\n source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, generation INTEGER NOT NULL,\n owner_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL,\n work_kind TEXT NOT NULL, work_id TEXT NOT NULL, work_revision INTEGER NOT NULL,\n task_id TEXT NOT NULL, payload_json TEXT NOT NULL,\n PRIMARY KEY(environment_id,owner_kind,owner_id,source_id,source_revision,generation)\n)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_grants",
    sql: "CREATE TABLE t3_workflow_v2_memory_grants (\n id TEXT PRIMARY KEY, environment_id TEXT NOT NULL,\n owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_revision INTEGER NOT NULL,\n source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,\n recipient_kind TEXT NOT NULL, recipient_id TEXT NOT NULL, recipient_revision INTEGER NOT NULL,\n revoked_at TEXT, payload_json TEXT NOT NULL\n)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_cleanup",
    sql: "CREATE TABLE t3_workflow_v2_memory_cleanup (\n id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,\n owner_revision INTEGER NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,\n generation INTEGER NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL,\n payload_json TEXT NOT NULL\n)",
  },
  {
    type: "table",
    name: "t3_workflow_v2_memory_forgotten",
    sql: "CREATE TABLE t3_workflow_v2_memory_forgotten (\n environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,\n source_id TEXT NOT NULL, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL,\n PRIMARY KEY(environment_id,owner_kind,owner_id,source_id,content_hash)\n)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_memory_current",
    sql: "CREATE INDEX t3_workflow_v2_memory_current ON t3_workflow_v2_memory_sources(environment_id,owner_kind,owner_id,status,source_id)",
  },
] as const;

export const projectMemoryMigration: WorkflowFeatureMigration = {
  id: 12,
  name: "ProjectMemory",
  objects,
  statements: objects.map(({ sql }) => sql),
};
