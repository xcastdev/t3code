import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runForkMigrations, runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("009_ProjectWork", (it) => {
  it.effect("creates normalized work projections, FTS, rebuild state, and receipt metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type IN ('table', 'virtual table')
          AND (name LIKE 'project_work_%' OR name = 'orchestration_command_receipts')
        ORDER BY name
      `;
      const names = tables.map(({ name }) => name);
      for (const name of [
        "project_work_events",
        "project_work_tasks",
        "project_work_attempts",
        "project_work_criteria",
        "project_work_evidence",
        "project_work_relationships",
        "project_work_blockers",
        "project_work_knowledge",
        "project_work_decisions",
        "project_work_comments",
        "project_work_attention",
        "project_work_projection_state",
        "project_work_search_fts",
      ]) {
        assert.ok(names.includes(name), `missing ${name}`);
      }

      const receiptColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('orchestration_command_receipts')
      `;
      for (const name of [
        "fingerprint",
        "actor_kind",
        "actor_id",
        "source_kind",
        "source_id",
        "result_json",
      ]) {
        assert.ok(
          receiptColumns.some((column) => column.name === name),
          `missing ${name}`,
        );
      }

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('project_work_attempts')
      `;
      assert.ok(indexes.some(({ name }) => name === "idx_project_work_attempts_one_active_task"));

      yield* sql`
        INSERT INTO project_work_attempts (
          attempt_id, project_id, task_id, state, checkpoint_ids_json, revision, updated_at
        ) VALUES ('attempt-active-1', 'project-1', 'task-1', 'running', '[]', 0,
          '2026-01-01T00:00:00.000Z')
      `;
      const duplicateActive = yield* Effect.result(sql`
        INSERT INTO project_work_attempts (
          attempt_id, project_id, task_id, state, checkpoint_ids_json, revision, updated_at
        ) VALUES ('attempt-active-2', 'project-1', 'task-1', 'leased', '[]', 0,
          '2026-01-01T00:00:00.000Z')
      `);
      assert.equal(duplicateActive._tag, "Failure");

      yield* sql`
        INSERT INTO project_work_search_fts
          (project_id, record_kind, record_id, title, body, provenance_json, revision)
        VALUES ('project-1', 'task', 'task-1', 'Durable task', 'searchable body', '{}', 1)
      `;
      const matches = yield* sql<{ readonly recordId: string }>`
        SELECT record_id AS "recordId"
        FROM project_work_search_fts
        WHERE project_work_search_fts MATCH 'searchable'
      `;
      assert.deepEqual(matches, [{ recordId: "task-1" }]);
    }),
  );
});
