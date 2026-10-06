import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

it.effect("preserves the first raw artifact through replacement and migration replay", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_work_artifacts VALUES
      ('environment','artifact','project','task','source','{}',${"a".repeat(64)},3,${new Uint8Array([0, 255, 128])})`;
    const first = yield* sql`SELECT * FROM project_work_artifacts`;
    yield* sql`INSERT OR REPLACE INTO project_work_artifacts VALUES
      ('environment','artifact','other','other','other','{}',${"b".repeat(64)},0,${new Uint8Array()})`;
    expect(yield* sql`SELECT * FROM project_work_artifacts`).toEqual(first);
    expect(
      (yield* sql`UPDATE project_work_artifacts SET source_id='other'`.pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* runMigrations();
    expect(yield* sql`SELECT * FROM project_work_artifacts`).toEqual(first);
    yield* sql`INSERT INTO project_work_artifacts VALUES
      ('second-environment','artifact','project','task','source','{}',${"a".repeat(64)},0,${new Uint8Array()})`;
    expect(
      yield* sql`SELECT byte_count FROM project_work_artifacts ORDER BY environment_id`,
    ).toEqual([{ byte_count: 3 }, { byte_count: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects malformed hashes, manifest bounds and mismatched raw lengths", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [hash, manifest, count, bytes] of [
      ["G".repeat(64), "{}", 0, new Uint8Array()],
      ["a".repeat(63), "{}", 0, new Uint8Array()],
      ["a".repeat(64), "invalid", 0, new Uint8Array()],
      ["a".repeat(64), '"' + "é".repeat(32768) + '"', 0, new Uint8Array()],
      ["a".repeat(64), "{}", 1, new Uint8Array()],
      ["a".repeat(64), "{}", 1048577, new Uint8Array(1048577)],
    ] as const) {
      expect(
        (yield* sql`INSERT INTO project_work_artifacts VALUES
        ('environment','artifact','project','task','source',${manifest},${hash},${count},${bytes})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    expect(yield* sql`SELECT * FROM project_work_artifacts`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
