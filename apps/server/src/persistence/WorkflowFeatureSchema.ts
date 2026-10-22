import { assistantRoutineMigration } from "./AssistantRoutineMigration.ts";
import { threadHistoryArchiveMigration } from "./ThreadHistoryArchiveMigration.ts";
import { externalNotificationMigration } from "./ExternalNotificationMigration.ts";
import { assistantMemoryMigration } from "./AssistantMemoryMigration.ts";
import { projectWorkDeliveryRecoveryMigration } from "./ProjectWorkDeliveryRecoveryMigration.ts";
import { assistantMigration } from "./AssistantMigration.ts";
import { projectTeamDispatchMigration } from "./ProjectTeamDispatchMigration.ts";
import { projectWorkDeliveryMigration } from "./ProjectWorkDeliveryMigration.ts";
import { projectMemoryMigration } from "./ProjectMemoryMigration.ts";
import { projectMemoryProcessingMigration } from "./ProjectMemoryProcessingMigration.ts";
import { managedSkillsMigration } from "./ManagedSkillsMigration.ts";
import { projectTerminalMigration } from "./ProjectTerminalMigration.ts";
import { mcpCatalogMigration } from "./McpCatalogMigration.ts";
import { providerInstructionMigration } from "./ProviderInstructionMigration.ts";
import { projectWorkRunAdmissionMigration } from "./ProjectWorkRunAdmissionMigration.ts";
import { projectIssueMigration } from "./ProjectIssueMigration.ts";
import { projectTeamsMigration } from "./ProjectTeamsMigration.ts";
import { projectWorkMigration } from "./ProjectWorkMigration.ts";
export interface WorkflowFeatureObject {
  readonly type: "table" | "index" | "view" | "trigger";
  readonly name: string;
  readonly sql: string;
}

export interface WorkflowFeatureMigration {
  readonly id: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
  // Redeclare an object's resulting CREATE statement when a later migration alters it.
  readonly objects: ReadonlyArray<WorkflowFeatureObject>;
}

export const workflowFeatureLedger: WorkflowFeatureObject = {
  type: "table",
  name: "t3_workflow_v2_migrations",
  sql: `CREATE TABLE t3_workflow_v2_migrations (
    migration_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
};

// Domain slices append their own migrations; the foundation owns only the ledger.
export const workflowFeatureMigrations: ReadonlyArray<WorkflowFeatureMigration> = [
  { id: 1, name: "Foundation", statements: [], objects: [] },
  projectWorkMigration,
  projectTeamsMigration,
  projectIssueMigration,
  projectWorkRunAdmissionMigration,
  providerInstructionMigration,
  mcpCatalogMigration,
  projectTerminalMigration,
  managedSkillsMigration,
  projectTeamDispatchMigration,
  projectWorkDeliveryMigration,
  projectMemoryMigration,
  projectMemoryProcessingMigration,
  assistantMigration,
  projectWorkDeliveryRecoveryMigration,
  assistantMemoryMigration,
  threadHistoryArchiveMigration,
  externalNotificationMigration,
  assistantRoutineMigration,
];

export const isWorkflowFeatureName = (name: string) =>
  name.toLowerCase().startsWith("t3_workflow_v2_");

// Token boundaries and string literal case matter; SQL keyword/identifier case does not.
export const normalizeWorkflowSchemaSql = (sql: string) =>
  (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[\w$]+|[^\s;]/g) ?? [])
    .map((token) => (token.startsWith("'") ? token : token.toLowerCase()))
    .join(" ");
