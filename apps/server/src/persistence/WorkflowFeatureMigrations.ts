import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  isWorkflowFeatureName,
  normalizeWorkflowSchemaSql,
  workflowFeatureLedger,
  workflowFeatureMigrations,
  type WorkflowFeatureMigration,
} from "./WorkflowFeatureSchema.ts";

export class WorkflowFeatureCompatibilityError extends Schema.TaggedError<WorkflowFeatureCompatibilityError>()(
  "WorkflowFeatureCompatibilityError",
  { reason: Schema.Literals(["manifest", "ledger-history", "object-schema"]) },
) {
  override get message() {
    return `Upgrade refused: incompatible workflow feature ${this.reason}.`;
  }
}

/** Read-only, including when there is no feature ledger yet. */
export const assertWorkflowFeatureCompatibility = Effect.fn(
  "WorkflowFeatureMigrations.assertCompatibility",
)(function* (migrations: ReadonlyArray<WorkflowFeatureMigration> = workflowFeatureMigrations) {
  const sql = yield* SqlClient.SqlClient;
  const ids = new Set<number>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.id) ||
      migration.id <= 0 ||
      ids.has(migration.id) ||
      migration.id <= Math.max(0, ...ids) ||
      migration.name.length === 0 ||
      migration.objects.some(
        (object) =>
          !isWorkflowFeatureName(object.name) ||
          object.name.toLowerCase() === workflowFeatureLedger.name,
      )
    ) {
      return yield* new WorkflowFeatureCompatibilityError({ reason: "manifest" });
    }
    ids.add(migration.id);
  }
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`SELECT type, name, tbl_name, sql FROM sqlite_master`;
  const ledger = objects.find(({ name }) => name.toLowerCase() === workflowFeatureLedger.name);
  if (
    ledger &&
    (ledger.type !== "table" ||
      normalizeWorkflowSchemaSql(ledger.sql ?? "") !==
        normalizeWorkflowSchemaSql(workflowFeatureLedger.sql))
  ) {
    return yield* new WorkflowFeatureCompatibilityError({ reason: "object-schema" });
  }
  const rows = ledger
    ? yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id AS migration_id, name AS name FROM t3_workflow_v2_migrations ORDER BY migration_id
      `
    : [];
  for (const [index, row] of rows.entries()) {
    if (row.migration_id !== migrations[index]?.id || row.name !== migrations[index]?.name) {
      return yield* new WorkflowFeatureCompatibilityError({ reason: "ledger-history" });
    }
  }
  const expected = new Map([[workflowFeatureLedger.name, workflowFeatureLedger]]);
  for (const migration of migrations.slice(0, rows.length)) {
    for (const object of migration.objects) expected.set(object.name.toLowerCase(), object);
  }
  for (const object of objects) {
    if (!isWorkflowFeatureName(object.name) && !isWorkflowFeatureName(object.tbl_name)) continue;
    // SQLite generates these indexes from the already validated table's UNIQUE constraints.
    if (object.name.startsWith("sqlite_autoindex_") && object.sql === null) continue;
    const declaration = expected.get(object.name.toLowerCase());
    if (
      !declaration ||
      object.type !== declaration.type ||
      normalizeWorkflowSchemaSql(object.sql ?? "") !== normalizeWorkflowSchemaSql(declaration.sql)
    ) {
      return yield* new WorkflowFeatureCompatibilityError({ reason: "object-schema" });
    }
    expected.delete(object.name.toLowerCase());
  }
  if (!ledger) expected.delete(workflowFeatureLedger.name);
  if (expected.size > 0) {
    return yield* new WorkflowFeatureCompatibilityError({ reason: "object-schema" });
  }
  return rows.length;
});

export const runWorkflowFeatureMigrations = Effect.fn("WorkflowFeatureMigrations.run")(function* (
  migrations: ReadonlyArray<WorkflowFeatureMigration> = workflowFeatureMigrations,
) {
  const sql = yield* SqlClient.SqlClient;
  // A single transaction covers DDL, data and history; failure or interruption rolls them all back.
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const applied = yield* assertWorkflowFeatureCompatibility(migrations);
      const ledger =
        yield* sql`SELECT name FROM sqlite_master WHERE lower(name) = 't3_workflow_v2_migrations'`;
      if (ledger.length === 0) yield* sql.unsafe(workflowFeatureLedger.sql);
      const completed: Array<readonly [number, string]> = [];
      for (const migration of migrations.slice(applied)) {
        for (const statement of migration.statements) yield* sql.unsafe(statement);
        yield* sql`INSERT INTO t3_workflow_v2_migrations (migration_id, name)
          VALUES (${migration.id}, ${migration.name})`;
        completed.push([migration.id, migration.name]);
      }
      yield* assertWorkflowFeatureCompatibility(migrations);
      return completed;
    }),
  );
});
