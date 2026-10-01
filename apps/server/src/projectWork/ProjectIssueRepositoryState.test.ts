import { CommandId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkEventBus } from "./ProjectWorkEventBus.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  commitIssueRepositoryRead,
  ensureIssueRepositoryTables,
  readIssueRepositoryState,
  recordIssueRepositoryReadFailure,
  rotateIssueRepositoryCredential,
} from "./ProjectIssueRepositoryState.ts";

const key = { host: "github.com", repositoryNodeId: "R_repository" };
const at = "2026-10-01T00:00:00Z";
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(100);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* ensureIssueRepositoryTables(sql);
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Test','/unused','[]',${at},${at})`;
  return sql;
});
const bind = (
  sql: SqlClient.SqlClient,
  projectId = "a",
  expectedBindingRevision: number | null = null,
  accountNodeId = "U_account",
) =>
  bindIssueRepositoryProject(sql, {
    key,
    projectId,
    expectedBindingRevision,
    accountNodeId,
    repositoryName: "owner/repository",
    credentialEpoch: "opaque-epoch-1",
    since: at,
  });
const claim = (sql: SqlClient.SqlClient, leaseId = "read-1", now = 100) =>
  TestClock.setTime(now).pipe(
    Effect.andThen(
      claimIssueRepositoryRead(sql, key, { leaseId, durationMs: 1000, sweepStartedAt: at }),
    ),
  );
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect(
  "shared bindings have one canonical read and reject account or stale binding changes",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        yield* bind(sql, "b");
        const state = yield* claim(sql);
        expect(state?.lease?.bindings.map((binding) => binding.projectId)).toEqual(["a", "b"]);
        expect(yield* claim(sql, "parallel")).toBeUndefined();
        expect((yield* bind(sql, "b", null).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* bind(sql, "c", null, "U_other").pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_issue_repository`).toHaveLength(1);
        expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(2);
      }),
    ),
);

it.effect(
  "expired leases and same-account rotation fence delayed failures without advancing progress",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        const first = (yield* claim(sql))!;
        const second = (yield* claim(sql, "read-2", 1100))!;
        expect(
          yield* recordIssueRepositoryReadFailure(sql, key, first.lease!, {
            retryAt: 1200,
            error: "transport",
          }),
        ).toBe(false);
        const rotated = yield* rotateIssueRepositoryCredential(sql, key, {
          accountNodeId: "U_account",
          credentialEpoch: "opaque-epoch-2",
          expectedRevision: second.revision,
        });
        expect(rotated.nextPage).toBe(1);
        expect(rotated.since).toBe(at);
        expect(
          yield* recordIssueRepositoryReadFailure(sql, key, second.lease!, {
            retryAt: 1200,
            error: "transport",
          }),
        ).toBe(false);
        expect((yield* readIssueRepositoryState(sql, key))?.error).toBeNull();
        expect(
          (yield* rotateIssueRepositoryCredential(sql, key, {
            accountNodeId: "U_other",
            credentialEpoch: "opaque-epoch-3",
            expectedRevision: rotated.revision,
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "a later archived binding invalidates the entire shared page without preparing writes",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        yield* bind(sql, "b");
        const claimed = (yield* claim(sql))!;
        yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('b','archived','/unused',1,${at})`;
        let prepared = false;
        const result = yield* commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
          Effect.sync(() => {
            prepared = true;
            return {
              commands: [],
              progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
            };
          }),
        ).pipe(Effect.provide(ProjectWorkRepositoryLive));
        expect(result.accepted).toBe(false);
        expect(prepared).toBe(false);
        expect((yield* readIssueRepositoryState(sql, key))?.nextPage).toBe(1);
      }),
    ),
);

it.effect(
  "page progress and cache writes roll back with a failed intake receipt, then publish after commit",
  () => {
    const published: number[] = [];
    return run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        const claimed = (yield* claim(sql))!;
        const prepare = () =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO project_issue_external(host,repository_node_id,issue_node_id,issue_number,source_revision,payload_json) VALUES(${key.host},${key.repositoryNodeId},'I_issue',1,${at},'{}')`;
            return {
              commands: [
                {
                  type: "project-work.task.create" as const,
                  projectId: ProjectId.make("a"),
                  taskId: ProjectWorkTaskId.make("task"),
                  commandId: CommandId.make("intake"),
                  title: "Task",
                  createdAt: at,
                },
              ],
              progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
            };
          });
        yield* sql`CREATE TRIGGER refuse_intake BEFORE INSERT ON project_work_command_receipts WHEN NEW.command_id='intake' BEGIN SELECT RAISE(ABORT,'rollback'); END`;
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(ProjectWorkRepositoryLive),
            Effect.provideService(ProjectWorkEventBus, {
              publish: () =>
                sql`SELECT issue_node_id FROM project_issue_external`.pipe(
                  Effect.tap((rows) =>
                    Effect.sync(() => {
                      published.push(rows.length);
                    }),
                  ),
                  Effect.asVoid,
                  Effect.orDie,
                ),
              subscribe: Effect.die("unused"),
            }),
          );
        expect(
          (yield* provide(commitIssueRepositoryRead(sql, key, claimed.lease!, prepare)).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_issue_external`).toEqual([]);
        expect((yield* readIssueRepositoryState(sql, key))?.nextPage).toBe(1);
        expect(published).toEqual([]);
        yield* sql`DROP TRIGGER refuse_intake`;
        expect(
          (yield* provide(commitIssueRepositoryRead(sql, key, claimed.lease!, prepare))).accepted,
        ).toBe(true);
        expect((yield* readIssueRepositoryState(sql, key))?.nextPage).toBe(2);
        expect((yield* readIssueRepositoryState(sql, key))?.lease).toBeNull();
        expect(published).toEqual([1]);
        let repeated = false;
        expect(
          (yield* provide(
            commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
              Effect.sync(() => {
                repeated = true;
                return {
                  commands: [],
                  progress: {
                    since: at,
                    nextPage: 3,
                    sweepStartedAt: at,
                    lastSuccessfulPageAt: at,
                  },
                };
              }),
            ),
          )).accepted,
        ).toBe(false);
        expect(repeated).toBe(false);
      }),
    );
  },
);

it.effect("binding fan-out is capped at eight without partially adding a ninth", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) yield* bind(sql, id);
      expect((yield* bind(sql, "i").pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(8);
      expect((yield* claim(sql))?.lease?.bindings).toHaveLength(8);
    }),
  ),
);

it.effect(
  "two concurrent SQL claims have one winner and a changed binding fences its callback",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        const results = yield* Effect.all([claim(sql, "one"), claim(sql, "two")], {
          concurrency: "unbounded",
        });
        expect(results.filter((item) => item !== undefined)).toHaveLength(1);
        const won = results.find((item) => item !== undefined)!;
        yield* bind(sql, "a", 0);
        let prepared = false;
        const result = yield* commitIssueRepositoryRead(sql, key, won.lease!, () =>
          Effect.sync(() => {
            prepared = true;
            return {
              commands: [],
              progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
            };
          }),
        ).pipe(Effect.provide(ProjectWorkRepositoryLive));
        expect(result.accepted).toBe(false);
        expect(prepared).toBe(false);
      }),
    ),
);

it.effect("a failed binding receipt rolls back the shared authority change", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const before = yield* readIssueRepositoryState(sql, key);
      yield* sql`CREATE TRIGGER refuse_binding BEFORE INSERT ON project_issue_binding WHEN NEW.project_id='b' BEGIN SELECT RAISE(ABORT,'binding'); END`;
      expect((yield* bind(sql, "b").pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* readIssueRepositoryState(sql, key)).toEqual(before);
      expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(1);
    }),
  ),
);

it.effect("invalid progress rolls back prepared cache writes and retains the owned lease", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const claimed = (yield* claim(sql))!;
      const effect = commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'page','issues','{}')`;
          return {
            commands: [],
            progress: {
              since: "2026-02-30T00:00:00Z",
              nextPage: 2,
              sweepStartedAt: at,
              lastSuccessfulPageAt: at,
            },
          };
        }),
      ).pipe(Effect.provide(ProjectWorkRepositoryLive));
      expect((yield* effect.pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
      expect(yield* readIssueRepositoryState(sql, key)).toEqual(claimed);
    }),
  ),
);

it.effect("a prepared command for an unbound project cannot commit its auxiliary writes", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const claimed = (yield* claim(sql))!;
      const effect = commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'page','issues','{}')`;
          return {
            commands: [
              {
                type: "project-work.task.create" as const,
                projectId: ProjectId.make("b"),
                taskId: ProjectWorkTaskId.make("foreign"),
                commandId: CommandId.make("foreign"),
                title: "Foreign",
                createdAt: at,
              },
            ],
            progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
          };
        }),
      ).pipe(Effect.provide(ProjectWorkRepositoryLive));
      expect((yield* effect.pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
      expect(yield* readIssueRepositoryState(sql, key)).toEqual(claimed);
    }),
  ),
);

it.effect(
  "server-clock expiry during preparation rolls back its writes rather than using captured time",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* bind(sql);
        const claimed = (yield* claim(sql))!;
        const effect = commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'expired','issues','{}')`;
            yield* TestClock.setTime(claimed.lease!.expiresAt);
            return {
              commands: [],
              progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
            };
          }),
        ).pipe(Effect.provide(ProjectWorkRepositoryLive));
        expect((yield* effect.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
        expect(yield* readIssueRepositoryState(sql, key)).toEqual(claimed);
      }),
    ),
);

it.effect("authentication failure blocks reads until a fresh same-account credential epoch", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const claimed = (yield* claim(sql))!;
      expect(
        yield* recordIssueRepositoryReadFailure(sql, key, claimed.lease!, {
          retryAt: 200,
          error: "authentication",
        }),
      ).toBe(true);
      expect(yield* claim(sql, "stale-auth", 200)).toBeUndefined();
      const failed = (yield* readIssueRepositoryState(sql, key))!;
      yield* rotateIssueRepositoryCredential(sql, key, {
        accountNodeId: "U_account",
        credentialEpoch: "opaque-epoch-2",
        expectedRevision: failed.revision,
      });
      expect((yield* claim(sql, "fresh-auth", 200))?.lease?.credentialEpoch).toBe("opaque-epoch-2");
    }),
  ),
);

it.effect("rejects valid repository payloads stored under another immutable SQL key", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const foreignKey = { host: "github.com", repositoryNodeId: "R_foreign" };
      const foreign = yield* bindIssueRepositoryProject(sql, {
        key: foreignKey,
        projectId: "b",
        repositoryName: "foreign/repository",
        accountNodeId: "U_foreign",
        credentialEpoch: "foreign-epoch",
        since: at,
        expectedBindingRevision: null,
      });
      const leased = (yield* claimIssueRepositoryRead(sql, foreignKey, {
        leaseId: "foreign-lease",
        durationMs: 1000,
        sweepStartedAt: at,
      }))!;
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(leased);
      yield* sql`UPDATE project_issue_repository SET payload_json=${payload} WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
      expect((yield* readIssueRepositoryState(sql, key).pipe(Effect.result))._tag).toBe("Failure");
      let prepared = false;
      const outcome = yield* commitIssueRepositoryRead(sql, key, leased.lease!, () =>
        Effect.sync(() => {
          prepared = true;
          return {
            commands: [],
            progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
          };
        }),
      ).pipe(Effect.provide(ProjectWorkRepositoryLive), Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect(prepared).toBe(false);
      expect(yield* readIssueRepositoryState(sql, foreignKey)).toEqual(leased);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
      expect(foreign.state.accountNodeId).toBe("U_foreign");
    }),
  ),
);

it.effect("adding or updating a binding cannot revive an authentication-failed epoch", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* bind(sql);
      const leased = (yield* claim(sql))!;
      yield* recordIssueRepositoryReadFailure(sql, key, leased.lease!, {
        retryAt: 100,
        error: "authentication",
      });
      const failed = yield* readIssueRepositoryState(sql, key);
      for (const [project, expected] of [
        ["a", 0],
        ["b", null],
      ] as const) {
        expect((yield* bind(sql, project, expected).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readIssueRepositoryState(sql, key)).toEqual(failed);
        expect(yield* claim(sql, "blocked")).toBeUndefined();
      }
      expect(yield* sql`SELECT * FROM project_issue_binding`).toHaveLength(1);
      const fresh = yield* bindIssueRepositoryProject(sql, {
        key,
        projectId: "b",
        expectedBindingRevision: null,
        accountNodeId: "U_account",
        repositoryName: "owner/repository",
        credentialEpoch: "opaque-epoch-2",
        since: at,
      });
      expect(fresh.state.status).toBe("ready");
      expect(fresh.state.error).toBeNull();
      expect((yield* claim(sql, "fresh"))?.lease?.credentialEpoch).toBe("opaque-epoch-2");
    }),
  ),
);

it.effect("a retained repository cannot commit shared page progress on another SQL client", () =>
  run(
    Effect.gen(function* () {
      const ownerSql = yield* setup;
      return yield* Effect.gen(function* () {
        const ownerRepository = yield* ProjectWorkRepository;
        yield* Effect.gen(function* () {
          const otherSql = yield* setup;
          expect(otherSql).not.toBe(ownerSql);
          yield* bind(otherSql);
          const leased = (yield* claim(otherSql))!;
          yield* ownerSql`CREATE TRIGGER reject_foreign_receipt BEFORE INSERT ON project_work_command_receipts BEGIN SELECT RAISE(ABORT,'owner receipt'); END`;
          let prepared = false;
          const result = yield* commitIssueRepositoryRead(otherSql, key, leased.lease!, () =>
            Effect.gen(function* () {
              prepared = true;
              yield* otherSql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'foreign','issues','{}')`;
              return {
                commands: [
                  {
                    type: "project-work.task.create" as const,
                    commandId: CommandId.make("foreign"),
                    taskId: ProjectWorkTaskId.make("foreign"),
                    projectId: ProjectId.make("a"),
                    title: "foreign",
                    createdAt: at,
                  },
                ],
                progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
              };
            }),
          ).pipe(Effect.provideService(ProjectWorkRepository, ownerRepository), Effect.result);
          expect(result._tag).toBe("Failure");
          expect(prepared).toBe(false);
          expect(yield* readIssueRepositoryState(otherSql, key)).toEqual(leased);
          expect(yield* otherSql`SELECT * FROM project_issue_page`).toEqual([]);
          expect(yield* ownerSql`SELECT * FROM project_work_command_receipts`).toEqual([]);
        }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));
      }).pipe(Effect.provide(ProjectWorkRepositoryLive));
    }),
  ),
);
