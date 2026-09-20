import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runForkMigrations, runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("012_ProjectLifecycle", (it) => {
  it.effect("creates durable lifecycle state and operation idempotency tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runForkMigrations(12);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('project_lifecycle', 'project_lifecycle_operations')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map(({ name }) => name),
        ["project_lifecycle", "project_lifecycle_operations"],
      );

      const lifecycleColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('project_lifecycle')
      `;
      for (const name of [
        "project_id",
        "state",
        "workspace_root",
        "repository_key",
        "revision",
        "changed_at",
        "tombstone_json",
      ]) {
        assert.ok(
          lifecycleColumns.some((column) => column.name === name),
          `missing ${name}`,
        );
      }

      const operationColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('project_lifecycle_operations')
      `;
      for (const name of [
        "project_id",
        "command_id",
        "operation",
        "request_fingerprint",
        "result_json",
      ]) {
        assert.ok(
          operationColumns.some((column) => column.name === name),
          `missing ${name}`,
        );
      }

      // Rollout/restart reruns must not duplicate either table or its index.
      yield* runForkMigrations(12);
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('project_lifecycle')
      `;
      assert.ok(indexes.some(({ name }) => name === "idx_project_lifecycle_state"));
    }),
  );
});
