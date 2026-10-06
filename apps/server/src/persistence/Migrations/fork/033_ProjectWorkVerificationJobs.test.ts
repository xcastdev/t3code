import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect(
  "adds immutable prepared retention after the existing fork sequence and replays safely",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 32 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO project_work_artifacts VALUES
      ('environment','artifact','project','task','source','{}',${"a".repeat(64)},0,${new Uint8Array()})`;
      const prior = yield* sql`SELECT * FROM project_work_artifacts`;
      yield* runForkMigrations();
      yield* sql`INSERT INTO project_work_verification_jobs VALUES
      ('environment','job','project','task','{}',${"a".repeat(64)})`;
      const first = yield* sql`SELECT * FROM project_work_verification_jobs`;
      yield* sql`INSERT OR REPLACE INTO project_work_verification_jobs VALUES
      ('environment','job','different','different','{}',${"b".repeat(64)})`;
      expect(yield* sql`SELECT * FROM project_work_verification_jobs`).toEqual(first);
      expect(
        (yield* sql`UPDATE project_work_verification_jobs SET manifest_json='{}'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(yield* runForkMigrations()).toEqual([]);
      expect(yield* sql`SELECT * FROM project_work_verification_jobs`).toEqual(first);
      expect(yield* sql`SELECT * FROM project_work_artifacts`).toEqual(prior);
      yield* sql`INSERT INTO project_work_verification_jobs VALUES
      ('other-environment','job','project','task','{}',${"b".repeat(64)})`;
      expect(yield* sql`SELECT count(*) AS count FROM project_work_verification_jobs`).toEqual([
        { count: 2 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("enforces physical prepared envelope identifier, JSON-byte and digest bounds", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const invalid of [
      {
        environmentId: "",
        jobId: "job",
        projectId: "project",
        taskId: "task",
        manifest: "{}",
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "x".repeat(257),
        projectId: "project",
        taskId: "task",
        manifest: "{}",
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "",
        taskId: "task",
        manifest: "{}",
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "project",
        taskId: "",
        manifest: "{}",
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "project",
        taskId: "task",
        manifest: "invalid",
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "project",
        taskId: "task",
        manifest: '"' + "é".repeat(32_768) + '"',
        hash: "a".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "project",
        taskId: "task",
        manifest: "{}",
        hash: "A".repeat(64),
      },
      {
        environmentId: "environment",
        jobId: "job",
        projectId: "project",
        taskId: "task",
        manifest: "{}",
        hash: "a".repeat(63),
      },
    ])
      expect(
        (yield* sql`INSERT INTO project_work_verification_jobs VALUES
        (${invalid.environmentId},${invalid.jobId},${invalid.projectId},${invalid.taskId},${invalid.manifest},${invalid.hash})`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    expect(yield* sql`SELECT * FROM project_work_verification_jobs`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
