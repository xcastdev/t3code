import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_mcp_catalog_scopes",
    sql: `CREATE TABLE t3_workflow_v2_mcp_catalog_scopes (
    scope TEXT NOT NULL CHECK(scope IN ('global','project')),
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    definitions_json TEXT NOT NULL,
    overrides_json TEXT NOT NULL,
    PRIMARY KEY(scope, scope_id)
  )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_mcp_catalog_sessions",
    sql: `CREATE TABLE t3_workflow_v2_mcp_catalog_sessions (
    catalog_session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    definitions_json TEXT NOT NULL,
    overrides_json TEXT NOT NULL,
    pending_apply INTEGER NOT NULL CHECK(pending_apply IN (0,1))
  )`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_mcp_catalog_thread",
    sql: `CREATE INDEX t3_workflow_v2_mcp_catalog_thread ON t3_workflow_v2_mcp_catalog_sessions(thread_id)`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_mcp_catalog_active_thread",
    sql: `CREATE UNIQUE INDEX t3_workflow_v2_mcp_catalog_active_thread ON t3_workflow_v2_mcp_catalog_sessions(thread_id) WHERE json_extract(snapshot_json,'$.disposedAt') IS NULL`,
  },
  {
    type: "index",
    name: "t3_workflow_v2_mcp_catalog_pending",
    sql: `CREATE INDEX t3_workflow_v2_mcp_catalog_pending ON t3_workflow_v2_mcp_catalog_sessions(pending_apply,catalog_session_id)`,
  },
] as const;
export const mcpCatalogMigration: WorkflowFeatureMigration = {
  id: 7,
  name: "McpCatalog",
  objects,
  statements: objects.map(({ sql }) => sql),
};
