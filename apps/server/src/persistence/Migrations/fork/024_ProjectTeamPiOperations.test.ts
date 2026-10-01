import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const insert = (id: string, ordinal: number, status = "prepared", thread = "thread") =>
    sql`INSERT INTO project_team_pi_operation VALUES (
      ${id},'environment','project','binding',0,'pi-instance',${thread},${id},${ordinal},
      'prompt','hash','root-binding','root-task',1000,10000,${status},'{}',NULL,NULL)`;
  return { sql, insert };
});

it.effect(
  "blocks replacement while ownership is active or quarantined and retains ordinal history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert("first", 0);
      expect((yield* f.insert("second", 1).pipe(Effect.result))._tag).toBe("Failure");
      yield* f.sql`UPDATE project_team_pi_operation SET status='quarantine' WHERE operation_id='first'`;
      expect((yield* f.insert("second", 1).pipe(Effect.result))._tag).toBe("Failure");
      yield* f.sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id='first'`;
      expect((yield* f.insert("duplicate-ordinal", 0).pipe(Effect.result))._tag).toBe("Failure");
      yield* f.insert("second", 1);
      yield* f.insert("other-thread", 0, "prepared", "other-thread");
      yield* runMigrations();
      expect(
        yield* f.sql`SELECT operation_id FROM project_team_pi_operation ORDER BY operation_id`,
      ).toEqual([
        { operation_id: "first" },
        { operation_id: "other-thread" },
        { operation_id: "second" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("requires durable operation ownership before process and control receipts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(
      (yield* f.sql`INSERT INTO project_team_pi_process VALUES ('unit','missing','{}','allocated',NULL,NULL)`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* f.insert("first", 0);
    yield* f.sql`INSERT INTO project_team_pi_process VALUES ('unit','first','{}','allocated',NULL,NULL)`;
    yield* f.sql`INSERT INTO project_team_pi_control VALUES ('first',1,'interrupt','received','{}')`;
    expect(
      (yield* f.sql`INSERT INTO project_team_pi_control VALUES ('first',1,'interrupt','received','{}')`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.sql`UPDATE project_team_pi_process SET operation_id='missing' WHERE unit='unit'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.sql`INSERT INTO project_team_pi_catalogue VALUES ('https://example.com/models','2026-10-01T00:00:00.000Z','{}')`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${"x".repeat(1048577)} WHERE operation_id='first'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* runMigrations();
    expect(yield* f.sql`SELECT unit,status FROM project_team_pi_process`).toEqual([
      { unit: "unit", status: "allocated" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
