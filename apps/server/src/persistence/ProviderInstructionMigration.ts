import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_instruction_deliveries",
    sql: `CREATE TABLE t3_workflow_v2_instruction_deliveries (
    run_attempt_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL,
    provider_session_id TEXT NOT NULL,
    run_ordinal INTEGER NOT NULL,
    requested_snapshot_json TEXT NOT NULL,
    applied_snapshot_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'blocked')),
    reason TEXT,
    created_at TEXT NOT NULL,
    applied_at TEXT
  )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_idx_instruction_deliveries_session",
    sql: `CREATE INDEX t3_workflow_v2_idx_instruction_deliveries_session ON t3_workflow_v2_instruction_deliveries(provider_session_id, run_ordinal)`,
  },
] as const;

export const providerInstructionMigration: WorkflowFeatureMigration = {
  id: 6,
  name: "ProviderInstruction",
  statements: objects.map((object) => object.sql),
  objects,
};
