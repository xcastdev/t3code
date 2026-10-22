import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_skill_catalog_revision",
    sql: `CREATE TABLE t3_workflow_v2_skill_catalog_revision (
    id INTEGER PRIMARY KEY CHECK(id=1),
    revision INTEGER NOT NULL CHECK(revision >= 0)
  )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_skill_session_overlays",
    sql: `CREATE TABLE t3_workflow_v2_skill_session_overlays (
    thread_id TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    PRIMARY KEY(thread_id,provider_instance_id,skill_key)
  )`,
  },
  {
    type: "table",
    name: "t3_workflow_v2_skill_instruction_resources",
    sql: `CREATE TABLE t3_workflow_v2_skill_instruction_resources (
    resource_revision TEXT PRIMARY KEY,
    catalog_revision INTEGER NOT NULL CHECK(catalog_revision >= 0),
    resources_json TEXT NOT NULL
  )`,
  },
] as const;

export const managedSkillsMigration: WorkflowFeatureMigration = {
  id: 9,
  name: "ManagedSkills",
  objects,
  statements: objects.map(({ sql }) => sql),
};
