import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_assistants",
    sql: `CREATE TABLE t3_workflow_v2_assistants (
      environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      owner_revision INTEGER NOT NULL, configuration_revision INTEGER NOT NULL,
      lifecycle TEXT NOT NULL, provisioning_state TEXT NOT NULL, workspace_root TEXT,
      create_command_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(environment_id,assistant_id),
      UNIQUE(environment_id,project_id), UNIQUE(environment_id,thread_id),
      UNIQUE(environment_id,create_command_id)
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_assistant_commands",
    sql: `CREATE TABLE t3_workflow_v2_assistant_commands (
      environment_id TEXT NOT NULL, command_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(environment_id,command_id)
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_assistant_admissions",
    sql: `CREATE TABLE t3_workflow_v2_assistant_admissions (
      thread_id TEXT NOT NULL, run_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      configuration_revision INTEGER NOT NULL, configuration_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(thread_id,run_id)
    )`,
  },
] as const;

export const assistantMigration: WorkflowFeatureMigration = {
  id: 14,
  name: "Assistants",
  objects,
  statements: objects.map(({ sql }) => sql),
};
