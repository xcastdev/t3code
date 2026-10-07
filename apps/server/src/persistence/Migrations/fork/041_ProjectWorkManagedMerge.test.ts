import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations, runForkMigrations } from "../../Migrations.ts";
const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 40 });
  const sql = yield* SqlClient.SqlClient;
  expect(
    yield* sql`SELECT name FROM sqlite_master WHERE name='project_work_managed_merge'`,
  ).toEqual([]);
  yield* runForkMigrations();
  return sql;
});
const decision = (operationId = "operation", revision = 0) =>
  canonicalProjectWorkPayload({
    environmentId: "environment",
    operationId,
    publication: { target: { projectId: "project", taskId: "task" } },
    gate: { recordId: "gate", revision },
  });
// Structural SQL fixtures have no review or merge authority; service tests retain actual original proofs.
it.effect("managed merge migration keeps one immutable operation per approved gate snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    const insert = (id: string, revision: number) =>
      sql`INSERT INTO project_work_managed_merge(environment_id,operation_id,project_id,task_id,gate_id,gate_revision,gate_sha256,decision_json,decision_sha256,status,claim_generation) VALUES ('environment',${id},'project','task','gate',${revision},${"a".repeat(64)},${decision(id, revision)},${"b".repeat(64)},'pending',0)`;
    yield* insert("first", 0);
    expect((yield* insert("duplicate", 0).pipe(Effect.result))._tag).toBe("Failure");
    yield* insert("fresh", 1);
    expect(
      (yield* sql`UPDATE project_work_managed_merge SET decision_json='{}' WHERE operation_id='first'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`DELETE FROM project_work_managed_merge WHERE operation_id='first'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(yield* runForkMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
it.effect("managed merge migration denies replacement writes and unclaimed delivery", () =>
  Effect.gen(function* () {
    const sql = yield* fixture;
    yield* sql`INSERT INTO project_work_managed_merge(environment_id,operation_id,project_id,task_id,gate_id,gate_revision,gate_sha256,decision_json,decision_sha256,status,claim_generation) VALUES ('environment','operation','project','task','gate',0,${"a".repeat(64)},${decision()},${"b".repeat(64)},'pending',0)`;
    expect(
      (yield* sql`UPDATE project_work_managed_merge SET status='confirmed',claim_generation=1,receipt_json='{}',receipt_sha256=${"c".repeat(64)}`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* sql`UPDATE project_work_managed_merge SET status='claimed',claim_generation=1`;
    yield* sql`UPDATE project_work_managed_merge SET status='uncertain',attention_json='{}'`;
    expect(
      (yield* sql`UPDATE project_work_managed_merge SET status='claimed',claim_generation=2`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* sql`UPDATE project_work_managed_merge SET attention_json='{"changed":true}'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
