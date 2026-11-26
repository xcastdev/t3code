import type { WorkflowFeatureMigration } from "./WorkflowFeatureSchema.ts";
const objects = [
  {
    type: "table",
    name: "t3_workflow_v2_external_notifications",
    sql: "CREATE TABLE t3_workflow_v2_external_notifications (fact_id TEXT NOT NULL, destination_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(fact_id,destination_id))",
  },
] as const;
export const externalNotificationMigration: WorkflowFeatureMigration = {
  id: 18,
  name: "ExternalNotifications",
  objects,
  statements: objects.map(({ sql }) => sql),
};

const occurrenceObjects = [
  {
    type: "table",
    name: "t3_workflow_v2_external_notification_occurrences",
    sql: `CREATE TABLE t3_workflow_v2_external_notification_occurrences (
      environment_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY(environment_id,occurrence_id,destination_id)
    )`,
  },
] as const;

export const externalNotificationOccurrenceMigration: WorkflowFeatureMigration = {
  id: 21,
  name: "ExternalNotificationOccurrences",
  objects: occurrenceObjects,
  statements: occurrenceObjects.map(({ sql }) => sql),
};
