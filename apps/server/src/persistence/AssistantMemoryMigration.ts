import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";

const tables = [
  [
    "t3_workflow_v2_assistant_memory_forget_fences",
    "environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL, forgotten_at TEXT NOT NULL, PRIMARY KEY(environment_id,assistant_id)",
  ],
  [
    "t3_workflow_v2_assistant_memory_receipts",
    "environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, source_json TEXT NOT NULL, reteach INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(environment_id,assistant_id,message_id,revision)",
  ],
  [
    "t3_workflow_v2_assistant_memory_epochs",
    "environment_id TEXT NOT NULL, assistant_id TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(environment_id,assistant_id)",
  ],
  [
    "t3_workflow_v2_memory_fact_tombstones",
    "environment_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, fact_key TEXT NOT NULL, fingerprint TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(environment_id,owner_kind,owner_id,fact_key,fingerprint,source_id)",
  ],
] as const;
const objects: WorkflowFeatureMigration["objects"][number][] = tables.map(([name, fields]) => ({
  type: "table",
  name,
  sql: `CREATE TABLE ${name} (${fields})`,
}));
for (const [table, events, ownerColumn, condition] of [
  ["memory_sources", ["INSERT", "UPDATE"], "owner_id", "NEW.owner_kind='assistant'"],
  ["memory_observations", ["INSERT", "UPDATE"], "owner_id", "NEW.owner_kind='assistant'"],
  ["memory_grants", ["INSERT", "UPDATE"], "owner_id", "NEW.owner_kind='assistant'"],
  ["memory_grants", ["INSERT", "UPDATE"], "recipient_id", "NEW.recipient_kind='assistant'"],
] as const)
  for (const event of events) {
    const name = `t3_workflow_v2_assistant_epoch_${table}_${ownerColumn}_${event.toLowerCase()}`;
    objects.push({
      type: "trigger",
      name,
      sql: `CREATE TRIGGER ${name} AFTER ${event} ON t3_workflow_v2_${table} WHEN ${condition} BEGIN INSERT INTO t3_workflow_v2_assistant_memory_epochs(environment_id,assistant_id,epoch) VALUES(NEW.environment_id,NEW.${ownerColumn},1) ON CONFLICT(environment_id,assistant_id) DO UPDATE SET epoch=epoch+1; END`,
    });
  }
for (const table of ["memory_sources", "memory_observations"] as const)
  for (const event of ["INSERT", "UPDATE"] as const) {
    const name = `t3_workflow_v2_assistant_epoch_shared_${table}_${event.toLowerCase()}`;
    objects.push({
      type: "trigger",
      name,
      sql: `CREATE TRIGGER ${name} AFTER ${event} ON t3_workflow_v2_${table} BEGIN INSERT INTO t3_workflow_v2_assistant_memory_epochs(environment_id,assistant_id,epoch) SELECT DISTINCT g.environment_id,g.recipient_id,1 FROM t3_workflow_v2_memory_grants g WHERE g.environment_id=NEW.environment_id AND g.owner_kind=NEW.owner_kind AND g.owner_id=NEW.owner_id AND g.source_id=NEW.source_id AND g.source_revision=NEW.source_revision AND g.recipient_kind='assistant' AND g.revoked_at IS NULL ON CONFLICT(environment_id,assistant_id) DO UPDATE SET epoch=epoch+1; END`,
    });
  }
objects.push({
  type: "trigger",
  name: "t3_workflow_v2_assistant_epoch_fact_suppression",
  sql: `CREATE TRIGGER t3_workflow_v2_assistant_epoch_fact_suppression AFTER INSERT ON t3_workflow_v2_memory_fact_tombstones WHEN NEW.owner_kind='assistant' BEGIN INSERT INTO t3_workflow_v2_assistant_memory_epochs(environment_id,assistant_id,epoch) VALUES(NEW.environment_id,NEW.owner_id,1) ON CONFLICT(environment_id,assistant_id) DO UPDATE SET epoch=epoch+1; INSERT INTO t3_workflow_v2_assistant_memory_epochs(environment_id,assistant_id,epoch) SELECT DISTINCT g.environment_id,g.recipient_id,1 FROM t3_workflow_v2_memory_grants g WHERE g.environment_id=NEW.environment_id AND g.owner_kind=NEW.owner_kind AND g.owner_id=NEW.owner_id AND g.recipient_kind='assistant' AND g.revoked_at IS NULL ON CONFLICT(environment_id,assistant_id) DO UPDATE SET epoch=epoch+1; END`,
});
export const assistantMemoryMigration: WorkflowFeatureMigration = {
  id: 16,
  name: "AssistantMemory",
  objects,
  statements: objects.map(({ sql }) => sql),
};
