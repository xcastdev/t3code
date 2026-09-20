import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { assertProjectAcceptsMutations } from "./ProjectMutationFence.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("ProjectMutationFence", (it) => {
  it.effect("observes tombstones in SQL order and fails closed for legacy deletion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations(12);
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES
          ('ordered-project', 'Ordered', '/workspace/ordered', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('legacy-deleted', 'Deleted', '/workspace/deleted', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-01-02T00:00:00.000Z'
        WHERE project_id = 'legacy-deleted'
      `;

      yield* assertProjectAcceptsMutations(sql, "ordered-project");
      const ordered = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO project_lifecycle
              (project_id, state, workspace_root, revision, changed_at)
            VALUES ('ordered-project', 'tombstoned', '/workspace/ordered', 1,
              '2026-01-02T00:00:00.000Z')
          `;
          return yield* Effect.result(assertProjectAcceptsMutations(sql, "ordered-project"));
        }),
      );
      const legacy = yield* Effect.result(assertProjectAcceptsMutations(sql, "legacy-deleted"));

      expect(ordered._tag).toBe("Failure");
      expect(legacy._tag).toBe("Failure");
      if (ordered._tag === "Failure") expect(ordered.failure.reason).toBe("project-tombstoned");
      if (legacy._tag === "Failure") expect(legacy.failure.reason).toBe("project-tombstoned");
    }),
  );
});
