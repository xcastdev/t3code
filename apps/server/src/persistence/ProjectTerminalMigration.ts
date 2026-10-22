import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_project_terminals",
    sql: `CREATE TABLE t3_workflow_v2_project_terminals (
    project_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(project_id, terminal_id)
  )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_terminal_completions",
    sql: `CREATE TABLE t3_workflow_v2_terminal_completions (
    project_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    recipient_thread_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    authority_json TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('subscribed', 'pending', 'delivered', 'unknown', 'cancelled')),
    PRIMARY KEY(project_id, terminal_id, generation, recipient_thread_id)
  )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_terminal_exits",
    sql: `CREATE TABLE t3_workflow_v2_terminal_exits (
    project_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    terminal_json TEXT NOT NULL,
    PRIMARY KEY(project_id,terminal_id,generation)
  )`,
  },
] as const;
export const projectTerminalMigration: WorkflowFeatureMigration = {
  id: 8,
  name: "ProjectTerminal",
  statements: objects.map((object) => object.sql),
  objects,
};
