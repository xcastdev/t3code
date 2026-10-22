import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const definitions = [
  [
    "archives",
    "archive_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, reason TEXT NOT NULL, operation_json TEXT, state TEXT NOT NULL CHECK(state IN ('preparing','ready','executing','completed','releasing','released')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ],
  [
    "archive_rows",
    "archive_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, source_order TEXT NOT NULL, run_id TEXT, item_type TEXT, message_id TEXT, fragment INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(archive_id,position)",
  ],
  [
    "archive_refs",
    "archive_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, cwd TEXT NOT NULL, source_ref TEXT NOT NULL, retained_ref TEXT NOT NULL, commit_oid TEXT, PRIMARY KEY(archive_id,checkpoint_id)",
  ],
  [
    "archive_attachments",
    "archive_id TEXT NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY(archive_id,attachment_id)",
  ],
] as const;
const objects: WorkflowFeatureMigration["objects"] = [
  ...definitions.map(([suffix, columns]) => ({
    type: "table" as const,
    name: `t3_workflow_v2_history_${suffix}`,
    sql: `CREATE TABLE t3_workflow_v2_history_${suffix} (${columns})`,
  })),
  {
    type: "index",
    name: "t3_workflow_v2_history_thread_idx",
    sql: "CREATE INDEX t3_workflow_v2_history_thread_idx ON t3_workflow_v2_history_archives(thread_id,created_at,archive_id)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_history_source_ref_idx",
    sql: "CREATE INDEX t3_workflow_v2_history_source_ref_idx ON t3_workflow_v2_history_archive_refs(source_ref)",
  },
  {
    type: "index",
    name: "t3_workflow_v2_history_attachment_idx",
    sql: "CREATE INDEX t3_workflow_v2_history_attachment_idx ON t3_workflow_v2_history_archive_attachments(attachment_id)",
  },
  {
    type: "trigger",
    name: "t3_workflow_v2_history_immutable_rows",
    sql: "CREATE TRIGGER t3_workflow_v2_history_immutable_rows BEFORE UPDATE ON t3_workflow_v2_history_archive_rows BEGIN SELECT RAISE(ABORT,'History payloads are immutable'); END",
  },
];
export const threadHistoryArchiveMigration: WorkflowFeatureMigration = {
  id: 17,
  name: "ThreadHistoryArchive",
  objects,
  statements: objects.map(({ sql }) => sql),
};
