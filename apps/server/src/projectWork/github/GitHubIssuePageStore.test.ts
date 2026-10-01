import { CommandId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  commitIssueRepositoryRead,
  readIssueRepositoryState,
  type IssueRepositoryState,
} from "../ProjectIssueRepositoryState.ts";
import { ProjectWorkRepositoryLive } from "../ProjectWorkRepository.ts";
import {
  acceptPage,
  planPage,
  type IssueSyncRequest,
  type IssuePageSnapshot,
} from "./GitHubIssueSync.ts";
import { readCommittedIssuePage, writeCommittedIssuePage } from "./GitHubIssuePageStore.ts";

const at = "2026-10-01T00:00:00Z";
const key = { host: "github.com", repositoryNodeId: "R_repository" };
const request: IssueSyncRequest = {
  repository: { host: key.host, nodeId: key.repositoryNodeId, nameWithOwner: "owner/repository" },
  account: { host: key.host, nodeId: "U_account", credentialFingerprint: "opaque-epoch" },
  query: { since: at, pageSize: 25, state: "all", sort: "updated", direction: "asc" },
  page: 1,
  generation: 0,
  leaseId: "lease",
};
const snapshot: IssuePageSnapshot = {
  repository: request.repository,
  account: request.account,
  query: request.query,
  page: 1,
  generation: 0,
  etag: '"page"',
  entries: [],
  nextPage: null,
  rawEntryCount: 0,
};
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(100);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('a','Test','/unused','[]',${at},${at})`;
  yield* bindIssueRepositoryProject(sql, {
    key,
    projectId: "a",
    repositoryName: request.repository.nameWithOwner,
    accountNodeId: request.account.nodeId,
    credentialEpoch: request.account.credentialFingerprint,
    since: at,
    expectedBindingRevision: null,
  });
  const claimed = (yield* claimIssueRepositoryRead(sql, key, {
    leaseId: "lease",
    durationMs: 1000,
    sweepStartedAt: at,
  }))!;
  return { sql, claimed };
});
const memory = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("only SQL committed snapshots permit the actual pure 304 consumer", () =>
  memory(
    Effect.gen(function* () {
      const { sql, claimed } = yield* setup;
      expect(yield* readCommittedIssuePage(sql, request)).toBeUndefined();
      expect(planPage({ request, currentFence: request })).toMatchObject({ status: "ready" });
      expect(
        acceptPage({
          request,
          currentFence: request,
          observedAt: at,
          response: { status: "not-modified", repository: request.repository, etag: '"page"' },
        }),
      ).toMatchObject({ status: "rejected", reason: "snapshot-mismatch" });
      let committed;
      const result = yield* commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
        Effect.gen(function* () {
          committed = yield* writeCommittedIssuePage(sql, request, snapshot);
          return {
            commands: [],
            progress: { since: at, nextPage: 2, sweepStartedAt: at, lastSuccessfulPageAt: at },
          };
        }),
      ).pipe(Effect.provide(ProjectWorkRepositoryLive));
      expect(result.accepted).toBe(true);
      const stored = yield* readCommittedIssuePage(sql, { ...request, leaseId: "next-lease" });
      expect(stored).toEqual(committed);
      const planned = planPage({ request, currentFence: request, priorCommittedSnapshot: stored });
      expect(planned).toMatchObject({ status: "ready", etag: '"page"' });
      expect(
        acceptPage({
          request,
          currentFence: request,
          priorCommittedSnapshot: stored,
          sentEtag: '"page"',
          observedAt: at,
          response: { status: "not-modified", repository: request.repository, etag: null },
        }),
      ).toMatchObject({ status: "accepted", snapshot });
      expect(yield* sql`SELECT commit_sequence FROM project_issue_page`).toEqual([
        { commit_sequence: 1 },
      ]);
    }),
  ),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const issue = {
  nodeId: "I_issue",
  number: 1,
  title: "Issue",
  titleTruncated: false,
  body: "",
  bodyTruncated: false,
  state: "open" as const,
  updatedAt: at,
  closedAt: null,
  url: "https://github.com/owner/repository/issues/1",
  commentCount: 0,
};
const store = (
  sql: SqlClient.SqlClient,
  req: IssueSyncRequest = request,
  page: IssuePageSnapshot = snapshot,
) => sql.withTransaction(writeCommittedIssuePage(sql, req, page));
const mutateState = Effect.fn("mutatePageStoreTestState")(function* (
  sql: SqlClient.SqlClient,
  changes: Partial<IssueRepositoryState>,
) {
  const state = (yield* readIssueRepositoryState(sql, key))!;
  const payload = yield* encodeJson({ ...state, ...changes });
  yield* sql`UPDATE project_issue_repository SET payload_json=${payload} WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
});

it.effect(
  "exact read keys distinguish historical query/page tuples and ignore reusable lease ids",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql } = yield* setup;
        const saved = yield* store(sql);
        expect(yield* readCommittedIssuePage(sql, { ...request, leaseId: "another" })).toEqual(
          saved,
        );
        for (const req of [
          { ...request, page: 2 },
          { ...request, query: { ...request.query, since: "2026-10-01T00:00:01Z" } },
        ]) {
          expect(yield* readCommittedIssuePage(sql, req)).toBeUndefined();
          expect(planPage({ request: req, currentFence: req })).toMatchObject({ status: "ready" });
        }
        for (const req of [
          {
            ...request,
            repository: { ...request.repository, host: "enterprise.example" },
            account: { ...request.account, host: "enterprise.example" },
          },
          { ...request, repository: { ...request.repository, nodeId: "R_other" } },
          { ...request, repository: { ...request.repository, nameWithOwner: "owner/renamed" } },
          { ...request, account: { ...request.account, nodeId: "U_other" } },
          { ...request, account: { ...request.account, credentialFingerprint: "new-epoch" } },
          { ...request, generation: 1 },
        ])
          expect(yield* readCommittedIssuePage(sql, req)).toBeUndefined();
        expect(
          (yield* readCommittedIssuePage(sql, {
            ...request,
            query: { ...request.query, pageSize: 100 },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* readCommittedIssuePage(sql, {
            ...request,
            account: { ...request.account, host: "other.example" },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* readCommittedIssuePage(sql, {
            ...request,
            query: { ...request.query, since: "2026-02-30T00:00:00Z" },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* sql`SELECT commit_sequence FROM project_issue_page`).toEqual([
          { commit_sequence: 1 },
        ]);
      }),
    ),
);

it.effect(
  "changed current account/epoch/generation/name/status invalidates prior committed authority",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql, claimed } = yield* setup;
        yield* store(sql);
        for (const changes of [
          { accountNodeId: "U_other" },
          { credentialEpoch: "rotated" },
          { authorityGeneration: 1 },
          { repositoryName: "owner/renamed" },
          { status: "unavailable" as const },
          { status: "detached" as const },
        ]) {
          yield* mutateState(sql, changes);
          expect(yield* readCommittedIssuePage(sql, request)).toBeUndefined();
          yield* mutateState(sql, claimed);
        }
        yield* mutateState(sql, { since: "2026-10-01T00:00:01Z", nextPage: 2, lease: null });
        expect(yield* readCommittedIssuePage(sql, request)).toMatchObject({ commitId: "1" });
        expect(yield* store(sql).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stale-authority" },
        });
      }),
    ),
);

it.effect("writes reject missing/wrong transactions before any cache writes", () =>
  memory(
    Effect.gen(function* () {
      const { sql } = yield* setup;
      expect(
        yield* writeCommittedIssuePage(sql, request, snapshot).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "transaction-required" } });
      yield* Effect.gen(function* () {
        const { sql: other } = yield* setup;
        expect(
          yield* sql
            .withTransaction(writeCommittedIssuePage(other, request, snapshot))
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "transaction-required" } });
        expect(yield* other`SELECT * FROM project_issue_page`).toEqual([]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));
      expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
    }),
  ),
);

it.effect("SQL authority and live lease fence every write tuple", () =>
  memory(
    Effect.gen(function* () {
      const { sql, claimed } = yield* setup;
      for (const req of [
        { ...request, leaseId: "stale" },
        { ...request, generation: 1 },
        { ...request, page: 2 },
        { ...request, query: { ...request.query, since: "2026-10-01T00:00:01Z" } },
        { ...request, account: { ...request.account, nodeId: "U_other" } },
        { ...request, account: { ...request.account, credentialFingerprint: "other" } },
        { ...request, repository: { ...request.repository, nameWithOwner: "owner/other" } },
      ]) {
        const page = {
          ...snapshot,
          repository: req.repository,
          account: req.account,
          query: req.query,
          page: req.page,
          generation: req.generation,
        };
        expect(yield* store(sql, req, page).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stale-authority" },
        });
      }
      for (const lease of [
        null,
        { ...claimed.lease!, credentialEpoch: "other" },
        { ...claimed.lease!, authorityGeneration: 1 },
      ]) {
        yield* mutateState(sql, { lease });
        expect(yield* store(sql).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stale-authority" },
        });
      }
      yield* mutateState(sql, claimed);
      yield* TestClock.setTime(1100);
      expect(yield* store(sql).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-authority" },
      });
      expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
    }),
  ),
);

it.effect(
  "malformed stored JSON, sequence, tuple, page shape and oversized bytes fail closed",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql } = yield* setup;
        yield* store(sql);
        const original = (yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM project_issue_page`)[0]!.payload;
        const invalids: unknown[] = [
          { ...snapshot, account: { ...snapshot.account, nodeId: "U_other" } },
          { ...snapshot, query: { ...snapshot.query, since: "2026-10-01T00:00:01Z" } },
          { ...snapshot, generation: 1 },
          { ...snapshot, page: 2 },
          { ...snapshot, repository: { ...snapshot.repository, nodeId: "R_other" } },
          { ...snapshot, nextPage: 3, rawEntryCount: 1 },
          { ...snapshot, entries: [issue, issue], rawEntryCount: 2 },
          {
            ...snapshot,
            entries: [{ ...issue, url: "https://github.com/other/repo/issues/1" }],
            rawEntryCount: 1,
          },
          { ...snapshot, entries: [issue], rawEntryCount: 0 },
          {
            ...snapshot,
            entries: Array.from({ length: 26 }, (_, i) => ({
              ...issue,
              nodeId: `I_${i}`,
              number: i + 1,
              url: `https://github.com/owner/repository/issues/${i + 1}`,
            })),
            rawEntryCount: 26,
          },
        ];
        for (const invalid of invalids) {
          const payload = yield* encodeJson(invalid);
          yield* sql`UPDATE project_issue_page SET payload_json=${payload}`;
          expect(yield* readCommittedIssuePage(sql, request).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "invalid-storage" },
          });
        }
        yield* sql`UPDATE project_issue_page SET payload_json='not-json'`;
        expect(yield* readCommittedIssuePage(sql, request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid-storage" },
        });
        yield* sql`UPDATE project_issue_page SET payload_json=${"x".repeat(2 * 1024 * 1024 + 1)}`;
        expect(yield* readCommittedIssuePage(sql, request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "payload-too-large" },
        });
        yield* sql`UPDATE project_issue_page SET payload_json=${original},commit_sequence=-1`;
        expect(yield* readCommittedIssuePage(sql, request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid-storage" },
        });
        yield* sql`UPDATE project_issue_page SET commit_sequence=1,read_key='malformed-key'`;
        expect(yield* readCommittedIssuePage(sql, request)).toBeUndefined();
      }),
    ),
);

it.effect(
  "caller commit ids never establish SQL commitment and replacements receive fresh sequences",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql } = yield* setup;
        const forged = { ...snapshot, commitId: "999999" };
        expect((yield* store(sql, request, forged)).commitId).toBe("1");
        expect((yield* store(sql, request, forged)).commitId).toBe("2");
        expect((yield* readCommittedIssuePage(sql, request))?.commitId).toBe("2");
        expect(
          yield* sql`SELECT commit_sequence,payload_json LIKE '%commitId%' AS callerId FROM project_issue_page`,
        ).toEqual([{ commit_sequence: 2, callerId: 0 }]);
      }),
    ),
);

it.effect("renamed changed responses remain unconditional under the old request name", () =>
  memory(
    Effect.gen(function* () {
      const { sql } = yield* setup;
      const renamed = {
        ...snapshot,
        repository: { ...snapshot.repository, nameWithOwner: "owner/renamed" },
        entries: [{ ...issue, url: "https://github.com/owner/renamed/issues/1" }],
        rawEntryCount: 1,
      };
      const stored = yield* store(sql, request, renamed);
      expect(planPage({ request, currentFence: request, priorCommittedSnapshot: stored })).toEqual({
        status: "ready",
        request,
      });
      expect(
        acceptPage({
          request,
          currentFence: request,
          priorCommittedSnapshot: stored,
          sentEtag: '"page"',
          observedAt: at,
          response: { status: "not-modified", repository: request.repository, etag: null },
        }),
      ).toMatchObject({ status: "rejected", reason: "snapshot-mismatch" });
      expect(yield* readCommittedIssuePage(sql, request)).toEqual(stored);
      expect(
        yield* readCommittedIssuePage(sql, { ...request, repository: renamed.repository }),
      ).toBeUndefined();
    }),
  ),
);

it.effect(
  "cached PR-only continuation preserves actual raw pagination without inventing issues",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql } = yield* setup;
        const prOnly = { ...snapshot, rawEntryCount: 25, nextPage: 2 };
        yield* store(sql, request, prOnly);
        const stored = yield* readCommittedIssuePage(sql, request);
        expect(
          acceptPage({
            request,
            currentFence: request,
            priorCommittedSnapshot: stored,
            sentEtag: '"page"',
            observedAt: at,
            response: { status: "not-modified", repository: request.repository, etag: null },
          }),
        ).toMatchObject({
          status: "accepted",
          snapshot: prOnly,
          progress: { overlapSince: at, nextPage: 2 },
        });
      }),
    ),
);

it.effect(
  "bounded write schema rejects malformed tuples, duplicates, urls and oversized UTF-8",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql } = yield* setup;
        for (const invalid of [
          { ...snapshot, account: { ...snapshot.account, credentialFingerprint: "other" } },
          { ...snapshot, query: { ...snapshot.query, pageSize: 100 } },
          { ...snapshot, nextPage: 3, rawEntryCount: 1 },
          { ...snapshot, entries: [issue, issue], rawEntryCount: 2 },
          {
            ...snapshot,
            entries: [{ ...issue, url: "https://evil.example/issues/1" }],
            rawEntryCount: 1,
          },
          { ...snapshot, entries: [issue], rawEntryCount: 0 },
          { ...snapshot, entries: [{ ...issue, title: "" }], rawEntryCount: 1 },
          { ...snapshot, rawEntryCount: 26 },
        ])
          expect(yield* store(sql, request, invalid).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "invalid-snapshot" },
          });
        const oversized = {
          ...snapshot,
          rawEntryCount: 25,
          entries: Array.from({ length: 25 }, (_, i) => ({
            ...issue,
            nodeId: `I_${i}`,
            number: i + 1,
            url: `https://github.com/owner/repository/issues/${i + 1}`,
            body: "\u0800".repeat(32000),
          })),
        };
        expect(yield* store(sql, request, oversized).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "payload-too-large" },
        });
        expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
      }),
    ),
);

it.effect("retention keeps 64 issue pages and isolates comments and other repositories", () =>
  memory(
    Effect.gen(function* () {
      const { sql } = yield* setup;
      yield* sql`INSERT INTO project_issue_repository(host,repository_node_id,payload_json) VALUES('github.com','R_other','{}')`;
      yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'comment','comments','comment-bytes')`;
      yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES('github.com','R_other','other','issues','other-bytes')`;
      yield* Effect.gen(function* () {
        for (let page = 1; page <= 65; page++) {
          const state = (yield* readIssueRepositoryState(sql, key))!;
          const claimed =
            state.lease === null
              ? (yield* claimIssueRepositoryRead(sql, key, {
                  leaseId: `lease-${page}`,
                  durationMs: 1000,
                  sweepStartedAt: at,
                }))!
              : state;
          const req = { ...request, page, leaseId: claimed.lease!.id };
          const committed = yield* commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
            Effect.gen(function* () {
              yield* writeCommittedIssuePage(sql, req, { ...snapshot, page });
              return {
                commands: [],
                progress: {
                  since: at,
                  nextPage: page + 1,
                  sweepStartedAt: at,
                  lastSuccessfulPageAt: at,
                },
              };
            }),
          );
          expect(committed.accepted).toBe(true);
        }
      }).pipe(Effect.provide(ProjectWorkRepositoryLive));
      expect(
        yield* sql`SELECT count(*) AS count,min(commit_sequence) AS first,max(commit_sequence) AS last FROM project_issue_page WHERE repository_node_id=${key.repositoryNodeId} AND page_kind='issues'`,
      ).toEqual([{ count: 64, first: 4, last: 67 }]);
      expect(yield* readCommittedIssuePage(sql, request)).toBeUndefined();
      expect((yield* readCommittedIssuePage(sql, { ...request, page: 2 }))?.commitId).toBe("4");
      expect(
        yield* sql`SELECT payload_json FROM project_issue_page WHERE page_kind='comments' OR repository_node_id='R_other' ORDER BY commit_sequence`,
      ).toEqual([{ payload_json: "comment-bytes" }, { payload_json: "other-bytes" }]);
    }),
  ),
);

it.effect(
  "late actual SQL failure rolls back replacement, retention and SQL sequence allocation",
  () =>
    memory(
      Effect.gen(function* () {
        const { sql, claimed } = yield* setup;
        for (let page = 1; page <= 64; page++) {
          yield* mutateState(sql, { nextPage: page });
          yield* store(sql, { ...request, page }, { ...snapshot, page });
        }
        yield* mutateState(sql, { nextPage: 65 });
        const before = yield* sql`SELECT * FROM project_issue_page ORDER BY commit_sequence`;
        const beforeSequence =
          yield* sql`SELECT * FROM sqlite_sequence WHERE name='project_issue_page'`;
        yield* sql`CREATE TRIGGER refuse_late_page BEFORE INSERT ON project_work_command_receipts WHEN NEW.command_id='late-page' BEGIN SELECT RAISE(ABORT,'late failure'); END`;
        const commit = () =>
          commitIssueRepositoryRead(sql, key, claimed.lease!, () =>
            Effect.gen(function* () {
              const req = { ...request, page: 65 };
              yield* writeCommittedIssuePage(sql, req, { ...snapshot, page: 65 });
              yield* writeCommittedIssuePage(sql, req, {
                ...snapshot,
                page: 65,
                etag: '"replacement"',
              });
              return {
                commands: [
                  {
                    type: "project-work.task.create" as const,
                    projectId: ProjectId.make("a"),
                    taskId: ProjectWorkTaskId.make("cache-task"),
                    commandId: CommandId.make("late-page"),
                    title: "Task",
                    createdAt: at,
                  },
                ],
                progress: { since: at, nextPage: 66, sweepStartedAt: at, lastSuccessfulPageAt: at },
              };
            }),
          ).pipe(Effect.provide(ProjectWorkRepositoryLive));
        expect((yield* commit().pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* sql`SELECT * FROM project_issue_page ORDER BY commit_sequence`).toEqual(
          before,
        );
        expect(yield* sql`SELECT * FROM sqlite_sequence WHERE name='project_issue_page'`).toEqual(
          beforeSequence,
        );
        expect((yield* readIssueRepositoryState(sql, key))?.lease).toEqual(claimed.lease);
        expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
        yield* sql`DROP TRIGGER refuse_late_page`;
        expect((yield* commit()).accepted).toBe(true);
        expect((yield* readCommittedIssuePage(sql, { ...request, page: 65 }))?.commitId).toBe("66");
        expect(yield* readCommittedIssuePage(sql, request)).toBeUndefined();
        expect(yield* sql`SELECT count(*) AS count FROM project_issue_page`).toEqual([
          { count: 64 },
        ]);
      }),
    ),
);

it.effect(
  "file-backed reopen retains SQL-issued commitment and ignores caller lease identity",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "page.sqlite");
      yield* Effect.gen(function* () {
        const { sql } = yield* setup;
        expect((yield* store(sql)).commitId).toBe("1");
        expect((yield* store(sql)).commitId).toBe("2");
        yield* mutateState(sql, { lease: null, nextPage: 2 });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* readCommittedIssuePage(sql, { ...request, leaseId: "fresh-after-reopen" }),
        ).toMatchObject({ commitId: "2", etag: '"page"' });
        expect(yield* readCommittedIssuePage(sql, { ...request, page: 2 })).toBeUndefined();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a caught cache INSERT failure cannot commit deletion of the previous snapshot", () =>
  memory(
    Effect.gen(function* () {
      const { sql } = yield* setup;
      yield* store(sql);
      const before = yield* sql`SELECT * FROM project_issue_page`;
      yield* sql`CREATE TRIGGER reject_cache_insert BEFORE INSERT ON project_issue_page BEGIN SELECT RAISE(ABORT,'cache insert failure'); END`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          expect(
            yield* writeCommittedIssuePage(sql, request, { ...snapshot, etag: '"new"' }).pipe(
              Effect.result,
            ),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "storage" } });
        }),
      );
      expect(yield* sql`SELECT * FROM project_issue_page`).toEqual(before);
      expect((yield* readCommittedIssuePage(sql, request))?.commitId).toBe("1");
    }),
  ),
);
