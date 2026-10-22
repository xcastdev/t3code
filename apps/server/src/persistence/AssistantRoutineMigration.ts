import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_assistant_routines",
    sql: `CREATE TABLE t3_workflow_v2_assistant_routines (
      task_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      configuration_revision INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_assistant_routine_fires",
    sql: `CREATE TABLE t3_workflow_v2_assistant_routine_fires (
      fire_key TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, configuration_revision INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL, trigger_identity TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, prompt_hash TEXT NOT NULL,
      started_at TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id,trigger_kind,trigger_identity)
    )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_routine_owner_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_routine_owner_idx ON t3_workflow_v2_assistant_routines(environment_id,assistant_id,task_id)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_routine_fire_owner_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_routine_fire_owner_idx ON t3_workflow_v2_assistant_routine_fires(environment_id,assistant_id,fire_key)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_admission_owner_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_admission_owner_idx ON t3_workflow_v2_assistant_admissions(assistant_id,created_at DESC,run_id DESC,thread_id)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_run_attention_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_run_attention_idx ON orchestration_v2_projection_runs(status,thread_id,run_id)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_routine_recovery_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_routine_recovery_idx ON t3_workflow_v2_assistant_routine_fires(task_id,started_at DESC,fire_key DESC)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_assistant_run_command_idx",
    sql: "CREATE INDEX t3_workflow_v2_assistant_run_command_idx ON orchestration_events(stream_id,json_extract(metadata_json,'$.runId'),sequence) WHERE aggregate_kind='thread' AND command_id IS NOT NULL",
  },
] as const;

export const assistantRoutineMigration: WorkflowFeatureMigration = {
  id: 19,
  name: "AssistantRoutines",
  objects,
  statements: objects.map(({ sql }) => sql),
};
