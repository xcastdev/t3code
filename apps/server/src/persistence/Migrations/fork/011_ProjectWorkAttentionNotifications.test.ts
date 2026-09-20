import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("011_ProjectWorkAttentionNotifications", (it) => {
  it.effect("registers durable occurrences and fenced publications after 010", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      assert.deepEqual(yield* runForkMigrations(11), [[11, "ProjectWorkAttentionNotifications"]]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('project_work_attention_occurrences', 'project_work_notification_publications')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        ["project_work_attention_occurrences", "project_work_notification_publications"],
      );
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index'
          AND name = 'idx_project_work_notification_publications_queue'
      `;
      assert.equal(indexes.length, 1);
      assert.deepEqual(yield* runForkMigrations(11), []);
    }),
  );
});
