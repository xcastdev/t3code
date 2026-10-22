import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "./Migrations.ts";
import { assertWorkflowFeatureCompatibility } from "./WorkflowFeatureMigrations.ts";

export class UpstreamUpgradeCompatibilityError extends Schema.TaggedError<UpstreamUpgradeCompatibilityError>()(
  "UpstreamUpgradeCompatibilityError",
  { reason: Schema.Literals(["ledger-shape", "ledger-history", "reserved-namespace"]) },
) {
  override get message() {
    return `Upgrade refused: incompatible ${this.reason}. Update the upstream foundation or reconcile the database provenance before retrying.`;
  }
}

/** Read-only: this must precede PRAGMAs, migrations and feature/runtime startup. */
export const assertUpstreamUpgradeCompatibility = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
  }>`SELECT type, name FROM sqlite_master`;
  yield* assertWorkflowFeatureCompatibility().pipe(
    Effect.catchTags({
      WorkflowFeatureCompatibilityError: () =>
        new UpstreamUpgradeCompatibilityError({ reason: "reserved-namespace" }),
    }),
  );
  const ledger = objects.find(({ name }) => name.toLowerCase() === "effect_sql_migrations");
  if (!ledger) {
    // An unledgered populated database has no provable upgrade path.
    if (objects.some(({ name }) => !name.startsWith("sqlite_"))) {
      return yield* new UpstreamUpgradeCompatibilityError({ reason: "ledger-shape" });
    }
    return;
  }
  // The unchanged upstream runner reads exact sqlite_master names and result column keys.
  if (ledger.type !== "table" || ledger.name !== "effect_sql_migrations") {
    return yield* new UpstreamUpgradeCompatibilityError({ reason: "ledger-shape" });
  }
  const columns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly pk: number;
    readonly notnull: number;
  }>`PRAGMA table_info(effect_sql_migrations)`;
  const id = columns.find(({ name }) => name === "migration_id");
  const name = columns.find((column) => column.name === "name");
  const created = columns.find((column) => column.name === "created_at");
  if (
    columns.length !== 3 ||
    id?.type.toUpperCase() !== "INTEGER" ||
    id.pk !== 1 ||
    name?.type.toUpperCase() !== "VARCHAR(255)" ||
    name.notnull !== 1 ||
    created?.type.toUpperCase() !== "DATETIME" ||
    created.notnull !== 1
  ) {
    return yield* new UpstreamUpgradeCompatibilityError({ reason: "ledger-shape" });
  }
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  // Published previews have an explicit lossless reconciliation in reconcileV2PreviewMigration.
  // Accept only those complete histories; arbitrary mismatches still fail before any writes.
  const prefix = migrationManifest.filter(([id]) => id <= 52);
  const previewHistories: ReadonlyArray<ReadonlyArray<readonly [number, string]>> = [
    [...prefix, [53, "OrchestrationV2"]],
    [...prefix, [53, "PullRequestFilesViewed"], [54, "OrchestrationV2"]],
    [
      ...prefix,
      [53, "PullRequestFilesViewed"],
      [54, "OrchestrationV2"],
      [55, "RemoveRedundantProjectionIndexes"],
    ],
  ];
  if (
    previewHistories.some(
      (history) =>
        history.length === rows.length &&
        rows.every(
          (row, index) =>
            row.migration_id === history[index]?.[0] && row.name === history[index]?.[1],
        ),
    )
  )
    return;
  for (const [index, row] of rows.entries()) {
    const expected = migrationManifest[index];
    if (!expected || row.migration_id !== expected[0] || row.name !== expected[1]) {
      return yield* new UpstreamUpgradeCompatibilityError({ reason: "ledger-history" });
    }
  }
});
