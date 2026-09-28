import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionAgentTranscriptActivityIndex", (it) => {
  it.effect("adds ordered lookup columns and the agent transcript index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_activities)
      `;
      assert.ok(columns.some((column) => column.name === "agent_key"));
      assert.ok(columns.some((column) => column.name === "event_sequence"));
      assert.ok(columns.some((column) => column.name === "first_event_sequence"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_thread_activities_agent_event"),
      );
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_thread_activities_agent_kind_event"),
      );
    }),
  );
});
