import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_mcp_catalog_aliases",
    sql: `CREATE TABLE t3_workflow_v2_mcp_catalog_aliases (
    catalog_session_id TEXT PRIMARY KEY,
    aliases_json TEXT NOT NULL
  )`,
  },
] as const;

export const mcpCatalogAliasMigration: WorkflowFeatureMigration = {
  id: 20,
  name: "McpCatalogAliases",
  objects,
  statements: objects.map(({ sql }) => sql),
};
