import { ProjectIssueRepositoryCursor } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  bindIssueRepositoryProject,
  ensureIssueRepositoryTables,
  claimIssueRepositoryRead,
  readIssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCursor = Schema.decodeUnknownEffect(ProjectIssueRepositoryCursor);
const at = "2026-10-01T00:00:00.123Z";
const key = { host: "github.com", repositoryNodeId: "R_legacy" };
const setup = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 21 });
  const sql = yield* SqlClient.SqlClient;
  for (const project of ["a", "b"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES(${project},'Migration','/unused','[]',${at},${at})`;
  return sql;
});
const seed = Effect.fn("seedLegacyIssueCursor")(function* (
  sql: SqlClient.SqlClient,
  input: {
    recordId?: string;
    repositoryNodeId?: string;
    accountId?: string;
    cursor?: string;
    status?: "ready" | "syncing" | "unavailable" | "detached";
    overlapSince?: string;
    lastSuccessfulPageAt?: string;
  } = {},
) {
  const cursor = yield* decodeCursor({
    kind: "intake-cursor",
    recordId: input.recordId ?? "legacy",
    projectId: "a",
    revision: 7,
    generation: 3,
    updatedAt: at,
    status: input.status ?? "syncing",
    host: key.host,
    repositoryNodeId: input.repositoryNodeId ?? key.repositoryNodeId,
    accountId: input.accountId ?? "U_legacy",
    cursor: input.cursor ?? "opaque-page-9",
    etag: "old-etag",
    overlapSince: input.overlapSince ?? at,
    lastSuccessfulPageAt: input.lastSuccessfulPageAt ?? "2026-10-01T00:00:01.987Z",
    error: "previous transport failure",
  });
  const payload = yield* encodeJson(cursor);
  const unique = yield* encodeJson([cursor.host, cursor.repositoryNodeId]);
  yield* sql`INSERT INTO project_team_intake_cursor(record_id,project_id,status,revision,generation,updated_at,unique_key,payload_json)
    VALUES(${cursor.recordId},${cursor.projectId},${cursor.status},${cursor.revision},${cursor.generation},${cursor.updatedAt},${unique},${payload})`;
  return { cursor, payload };
});
const memory = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("migration retains exact legacy progress and cannot grant a read epoch or dispatch", () =>
  memory(
    Effect.gen(function* () {
      const sql = yield* setup;
      const before = yield* seed(sql, { cursor: "x".repeat(4000) });
      yield* runMigrations();
      const state = (yield* readIssueRepositoryState(sql, key))!;
      expect(state).toMatchObject({
        revision: 7,
        authorityGeneration: 3,
        status: "unavailable",
        credentialEpoch: "",
        repositoryName: "",
        accountNodeId: "U_legacy",
        since: "2026-10-01T00:00:00Z",
        lastSuccessfulPageAt: "2026-10-01T00:00:01Z",
        nextPage: 1,
        legacyCursor: null,
        lease: null,
      });
      expect(yield* sql`SELECT payload_json FROM project_issue_repository_legacy`).toEqual([
        { payload_json: before.payload },
      ]);
      expect(yield* sql`SELECT payload_json FROM project_team_intake_cursor`).toEqual([
        { payload_json: before.payload },
      ]);
      expect(yield* sql`SELECT project_id,revision,generation FROM project_issue_binding`).toEqual([
        { project_id: "a", revision: 7, generation: 3 },
      ]);
      expect(
        yield* claimIssueRepositoryRead(sql, key, {
          leaseId: "no-auth",
          durationMs: 1000,
          sweepStartedAt: "2026-10-01T00:00:00Z",
        }),
      ).toBeUndefined();
      expect(yield* sql`SELECT * FROM project_work_events`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
      expect(yield* runMigrations()).toEqual([]);
      expect(yield* readIssueRepositoryState(sql, key)).toEqual(state);
    }),
  ),
);

for (const recordId of ["", null])
  it.effect(
    `invalid physical ${recordId === null ? "null" : "empty"} key cannot register a partial import`,
    () =>
      memory(
        Effect.gen(function* () {
          const sql = yield* setup;
          yield* seed(sql, { recordId: "first", repositoryNodeId: "R_first" });
          yield* seed(sql, { recordId: "corrupt", repositoryNodeId: "R_corrupt" });
          yield* sql`UPDATE project_team_intake_cursor SET record_id=${recordId},payload_json='broken-json' WHERE record_id='corrupt'`;
          const source = yield* sql`SELECT * FROM project_team_intake_cursor ORDER BY record_id`;
          expect((yield* runMigrations().pipe(Effect.exit))._tag).toBe("Failure");
          expect(yield* sql`SELECT * FROM t3_fork_migrations WHERE migration_id=22`).toEqual([]);
          expect(
            yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'project_issue_%'`,
          ).toEqual([]);
          expect(yield* sql`SELECT * FROM project_team_intake_cursor ORDER BY record_id`).toEqual(
            source,
          );
        }),
      ),
  );

for (const field of ["overlapSince", "lastSuccessfulPageAt"] as const)
  it.effect(`unsupported legacy ${field} is retained without binding or read authority`, () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* setup;
        const source = yield* seed(sql, { [field]: "not-a-timestamp" });
        yield* runMigrations();
        expect(
          yield* sql`SELECT payload_json,import_status FROM project_issue_repository_legacy`,
        ).toEqual([{ payload_json: source.payload, import_status: "unsupported" }]);
        expect(yield* sql`SELECT payload_json FROM project_team_intake_cursor`).toEqual([
          { payload_json: source.payload },
        ]);
        expect(yield* sql`SELECT * FROM project_issue_repository`).toEqual([]);
        expect(yield* sql`SELECT * FROM project_issue_binding`).toEqual([]);
        expect(yield* sql`SELECT * FROM t3_fork_migrations WHERE migration_id=22`).toHaveLength(1);
      }),
    ),
  );

it.effect(
  "an already archived legacy owner cannot block another project's freshly verified reads",
  () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* setup;
        const source = yield* seed(sql);
        yield* sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/unused',1,${at})`;
        yield* runMigrations();
        expect(yield* sql`SELECT * FROM project_issue_binding`).toEqual([]);
        expect(yield* sql`SELECT payload_json FROM project_issue_repository_legacy`).toEqual([
          { payload_json: source.payload },
        ]);
        yield* bindIssueRepositoryProject(sql, {
          key,
          projectId: "b",
          repositoryName: "verified/repository",
          accountNodeId: "U_legacy",
          credentialEpoch: "fresh-verified",
          since: "2026-10-01T00:00:00Z",
          expectedBindingRevision: null,
        });
        expect(
          (yield* claimIssueRepositoryRead(sql, key, {
            leaseId: "fresh-read",
            durationMs: 1000,
            sweepStartedAt: "2026-10-01T00:00:00Z",
          }))?.lease?.bindings.map((binding) => binding.projectId),
        ).toEqual(["b"]);
      }),
    ),
);

it.effect(
  "bounded keyset migration imports more than one page without choosing extra project bindings",
  () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* setup;
        for (let i = 0; i < 129; i++)
          yield* seed(sql, {
            recordId: `legacy-${String(i).padStart(3, "0")}`,
            repositoryNodeId: `R_${i}`,
          });
        yield* runMigrations();
        expect(yield* sql`SELECT * FROM project_issue_repository`).toHaveLength(129);
        expect(yield* sql`SELECT * FROM project_issue_repository_legacy`).toHaveLength(129);
        expect(yield* sql`SELECT * FROM project_issue_binding WHERE project_id='a'`).toHaveLength(
          129,
        );
        expect(yield* sql`SELECT * FROM project_issue_binding WHERE project_id='b'`).toEqual([]);
      }),
    ),
);

it.effect(
  "valid older metadata outside the new domain remains inspectable with no read authority",
  () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* setup;
        const original = yield* seed(sql, { accountId: "a".repeat(4000) });
        yield* runMigrations();
        expect(yield* readIssueRepositoryState(sql, key)).toBeUndefined();
        expect(yield* sql`SELECT * FROM project_issue_binding`).toEqual([]);
        expect(
          yield* sql`SELECT payload_json,import_status FROM project_issue_repository_legacy`,
        ).toEqual([{ payload_json: original.payload, import_status: "unsupported" }]);
      }),
    ),
);

it.effect(
  "an existing verified repository is retained without authorizing the legacy owner/account",
  () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* seed(sql);
        // The old version may already have the private tables; it has not registered migration 22.
        yield* ensureIssueRepositoryTables(sql);
        yield* bindIssueRepositoryProject(sql, {
          key,
          projectId: "b",
          repositoryName: "verified/repository",
          accountNodeId: "U_verified",
          credentialEpoch: "fresh-verified-epoch",
          since: "2026-10-01T00:00:00Z",
          expectedBindingRevision: null,
        });
        const before = yield* readIssueRepositoryState(sql, key);
        yield* runMigrations();
        expect(yield* readIssueRepositoryState(sql, key)).toEqual(before);
        expect(yield* sql`SELECT project_id FROM project_issue_binding`).toEqual([
          { project_id: "b" },
        ]);
        expect(yield* sql`SELECT import_status FROM project_issue_repository_legacy`).toEqual([
          { import_status: "retained" },
        ]);
      }),
    ),
);

it.effect("cross-key legacy corruption rolls back registration and every earlier import", () =>
  memory(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seed(sql, { recordId: "first", repositoryNodeId: "R_first" });
      yield* seed(sql, { recordId: "second", repositoryNodeId: "R_second" });
      const wrongKey = yield* encodeJson(["github.com", "R_wrong"]);
      yield* sql`UPDATE project_team_intake_cursor SET unique_key=${wrongKey} WHERE record_id='second'`;
      expect((yield* runMigrations().pipe(Effect.exit))._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM t3_fork_migrations WHERE migration_id=22`).toEqual([]);
      expect(yield* sql`SELECT * FROM sqlite_master WHERE name='project_issue_repository'`).toEqual(
        [],
      );
      expect(yield* sql`SELECT * FROM project_team_intake_cursor`).toHaveLength(2);
    }),
  ),
);

it.effect(
  "registered file-backed migration survives close/reopen without reviving old authority",
  () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-migration-" });
      const filename = path.join(directory, "state.sqlite");
      let saved: string | undefined;
      let unsupported: string | undefined;
      yield* Effect.gen(function* () {
        const sql = yield* setup;
        saved = (yield* seed(sql)).payload;
        unsupported = (yield* seed(sql, {
          recordId: "unsupported",
          repositoryNodeId: "R_unsupported",
          overlapSince: "not-a-timestamp",
        })).payload;
        yield* runMigrations();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(yield* runMigrations()).toEqual([]);
        expect((yield* readIssueRepositoryState(sql, key))?.credentialEpoch).toBe("");
        expect(
          yield* sql`SELECT payload_json FROM project_issue_repository_legacy ORDER BY record_id`,
        ).toEqual([{ payload_json: saved }, { payload_json: unsupported }]);
        expect(
          yield* readIssueRepositoryState(sql, { ...key, repositoryNodeId: "R_unsupported" }),
        ).toBeUndefined();
        expect(
          yield* sql`SELECT import_status FROM project_issue_repository_legacy WHERE record_id='unsupported'`,
        ).toEqual([{ import_status: "unsupported" }]);
        expect(
          yield* claimIssueRepositoryRead(sql, key, {
            leaseId: "after-restart",
            durationMs: 1000,
            sweepStartedAt: "2026-10-01T00:00:00Z",
          }),
        ).toBeUndefined();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer));
  },
);
