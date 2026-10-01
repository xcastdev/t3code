import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkEventBus, type ProjectWorkCommittedEvent } from "./ProjectWorkEventBus.ts";

const command = (id: string): ProjectWorkCommand => ({
  type: "project-work.task.create",
  projectId: ProjectId.make(`atomic-${id}`),
  taskId: ProjectWorkTaskId.make(`atomic-task-${id}`),
  commandId: CommandId.make(`atomic-command-${id}`),
  title: `Imported work ${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, ProjectWorkRepository | SqlClient.SqlClient>,
  publish: (
    events: ReadonlyArray<ProjectWorkCommittedEvent>,
  ) => Effect.Effect<void, never, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* effect.pipe(
      Effect.provide(ProjectWorkRepositoryLive),
      Effect.provideService(ProjectWorkEventBus, {
        publish: (events) => publish(events).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        subscribe: Effect.die("unused subscription"),
      }),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* runForkMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE atomic_external_page (id TEXT PRIMARY KEY)`;
  return { sql, repository: yield* ProjectWorkRepository };
});

it.effect("publishes both projects only after their shared page and all receipts commit", () => {
  const published: Array<ProjectWorkCommittedEvent> = [];
  const visibleCounts: Array<number> = [];
  return withDatabase(
    Effect.gen(function* () {
      const { sql, repository } = yield* setup;
      const prepare = Effect.gen(function* () {
        yield* sql`INSERT INTO atomic_external_page VALUES ('page')`;
        expect(published).toEqual([]);
        return [command("one"), command("two")];
      });
      const results = yield* repository.executeAtomic(prepare);
      expect(results).toHaveLength(2);
      expect(published).toHaveLength(2);
      expect(visibleCounts).toEqual([2, 2]);
      expect(published.map((event) => event.cursor)).toEqual(
        published.map((event) => event.cursor).sort((a, b) => a - b),
      );
      yield* repository.executeAtomic(Effect.succeed([command("one"), command("two")]));
      expect(published).toHaveLength(2);
    }),
    (events) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT id FROM atomic_external_page`).toHaveLength(1);
        const rows = yield* sql`SELECT command_id FROM project_work_command_receipts`;
        visibleCounts.push(rows.length);
        published.push(...events);
      }).pipe(Effect.orDie),
  );
});

it.effect(
  "a second-project receipt failure rolls back the first project and auxiliary page",
  () => {
    const published: Array<ProjectWorkCommittedEvent> = [];
    return withDatabase(
      Effect.gen(function* () {
        const { sql, repository } = yield* setup;
        yield* sql`CREATE TRIGGER atomic_reject_receipt BEFORE INSERT ON project_work_command_receipts WHEN NEW.command_id='atomic-command-two' BEGIN SELECT RAISE(ABORT,'second receipt'); END`;
        const prepare = Effect.gen(function* () {
          yield* sql`INSERT INTO atomic_external_page VALUES ('page')`;
          return [command("one"), command("two")];
        });
        expect((yield* repository.executeAtomic(prepare).pipe(Effect.result))._tag).toBe("Failure");
        expect(published).toEqual([]);
        for (const table of [
          "atomic_external_page",
          "project_work_command_receipts",
          "project_work_events",
          "project_work_tasks",
        ])
          expect(yield* sql`SELECT * FROM ${sql(table)}`).toHaveLength(0);
        yield* sql`DROP TRIGGER atomic_reject_receipt`;
        yield* repository.executeAtomic(prepare);
        expect(published).toHaveLength(2);
        expect(yield* sql`SELECT * FROM atomic_external_page`).toHaveLength(1);
        expect(yield* sql`SELECT * FROM project_work_command_receipts`).toHaveLength(2);
      }),
      (events) =>
        Effect.sync(() => {
          published.push(...events);
        }),
    );
  },
);

it.effect("oversized atomic fanout rolls back prepared auxiliary writes", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, repository } = yield* setup;
      const result = yield* repository
        .executeAtomic(
          Effect.gen(function* () {
            yield* sql`INSERT INTO atomic_external_page VALUES ('oversize')`;
            return Array.from({ length: 17 }, (_, index) => command(String(index)));
          }),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM atomic_external_page`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
    }),
    () => Effect.die("must not publish"),
  ),
);

it.effect("refuses an existing SQL transaction before running preparation", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, repository } = yield* setup;
      let prepared = false;
      const result = yield* sql
        .withTransaction(
          repository.executeAtomic(
            Effect.sync(() => {
              prepared = true;
              return [command("nested")];
            }),
          ),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(prepared).toBe(false);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
    }),
    () => Effect.die("must not publish"),
  ),
);

it.effect("rejects a retained repository under another SQL client before auxiliary writes", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql: owner, repository } = yield* setup;
      yield* owner`CREATE TRIGGER atomic_reject_owner_receipt BEFORE INSERT ON project_work_command_receipts BEGIN SELECT RAISE(ABORT,'owner receipt'); END`;
      yield* Effect.gen(function* () {
        const other = yield* SqlClient.SqlClient;
        expect(other).not.toBe(owner);
        yield* other`CREATE TABLE atomic_foreign_page (id TEXT PRIMARY KEY)`;
        let prepared = false;
        const result = yield* repository
          .executeAtomic(
            Effect.gen(function* () {
              prepared = true;
              yield* other`INSERT INTO atomic_foreign_page VALUES ('must-not-escape')`;
              return [command("foreign")];
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(prepared).toBe(false);
        expect(yield* other`SELECT * FROM atomic_foreign_page`).toEqual([]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));
      expect(yield* owner`SELECT * FROM project_work_command_receipts`).toEqual([]);
      expect(yield* owner`SELECT * FROM project_work_events`).toEqual([]);
    }),
    () => Effect.die("must not publish"),
  ),
);
