import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("014_ProjectWorkActiveLeaseDueIndex", (it) => {
  it.effect("uses the partial index for the bounded deadline/keyset sweep", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 13 });
      assert.deepEqual(yield* runForkMigrations(14), [[14, "ProjectWorkActiveLeaseDueIndex"]]);
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT attempt_id, project_id, task_id, leased_until
        FROM project_work_attempts
        WHERE state IN ('leased', 'running')
          AND leased_until IS NOT NULL
          AND leased_until <= ${"2026-01-01T00:00:00.000Z"}
          AND (leased_until > ${"2025-01-01T00:00:00.000Z"}
            OR (leased_until = ${"2025-01-01T00:00:00.000Z"} AND attempt_id > ${"attempt-0"}))
        ORDER BY leased_until ASC, attempt_id ASC
        LIMIT 100
      `;
      assert.ok(
        plan.some(({ detail }) => detail.includes("idx_project_work_attempts_active_lease_due")),
        plan.map(({ detail }) => detail).join("\n"),
      );
    }),
  );
});
