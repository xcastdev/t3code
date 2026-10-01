import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as RateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
  rotateIssueRepositoryCredential,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { make, IssueCommentsError } from "./ProjectIssueComments.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-01T00:00:00Z";
const now = "2026-10-01T01:00:00Z";
const nowMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(now));
const key = { host: "github.com", repositoryNodeId: "R_repository" };
const repository = {
  host: key.host,
  nodeId: key.repositoryNodeId,
  nameWithOwner: "owner/repository",
};
const input = { projectId: "a", issueRecordId: "issue-a", expectedRevision: 0 };
const token = Redacted.make("synthetic-token");
const credential = (state: IssueRepositoryState) =>
  Effect.succeed({
    cwd: "/unused",
    host: state.host,
    accountNodeId: state.accountNodeId,
    credentialEpoch: state.credentialEpoch,
    token,
  });
const rawRepository = {
  id: 123,
  node_id: repository.nodeId,
  full_name: repository.nameWithOwner,
  url: "https://api.github.com/repos/owner/repository",
  html_url: "https://github.com/owner/repository",
  updated_at: at,
};
const rawIssue = {
  node_id: "I_issue",
  number: 1,
  title: "Source title",
  body: "Source body",
  state: "open",
  comments: 2,
  updated_at: at,
  closed_at: null,
  url: "https://api.github.com/repos/owner/repository/issues/1",
  html_url: "https://github.com/owner/repository/issues/1",
  repository_url: rawRepository.url,
};
const externalIssue = {
  nodeId: rawIssue.node_id,
  number: 1,
  title: rawIssue.title,
  titleTruncated: false,
  body: rawIssue.body,
  bodyTruncated: false,
  state: "open",
  updatedAt: at,
  closedAt: null,
  url: rawIssue.html_url,
  commentCount: 2,
};
const intake = (projectId = "a") => ({
  kind: "issue",
  recordId: `issue-${projectId}`,
  projectId,
  revision: 0,
  generation: 0,
  updatedAt: at,
  status: "open",
  identity: { ...key, issueNodeId: rawIssue.node_id, number: 1 },
  repositoryName: repository.nameWithOwner,
  title: rawIssue.title,
  body: rawIssue.body,
  sourceRevision: at,
  observedAt: at,
});
const rawComment = (id = 1, body = "Comment") => ({
  node_id: `IC_${id}`,
  body,
  updated_at: at,
  html_url: `${rawIssue.html_url}#issuecomment-${id}`,
  issue_url: rawIssue.url,
});
const http = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  `HTTP/2.0 ${status} ${status === 304 ? "Not Modified" : "OK"}\n${Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("")}\r\n${status === 304 ? "" : encodeJson(body)}`;
const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(stdout.startsWith("HTTP/2.0 304") ? 1 : 0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const addIssue = Effect.fn("commentsTest.addIssue")(function* (
  sql: SqlClient.SqlClient,
  projectId = "a",
) {
  const record = intake(projectId);
  yield* sql`INSERT INTO project_team_issue(record_id,project_id,status,revision,generation,updated_at,payload_json) VALUES(${record.recordId},${projectId},'open',0,0,${at},${encodeJson(record)})`;
});
const database = <A, E, R>(body: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      return yield* body.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: path.join(dir, "state.sqlite") })),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const fixture = Effect.fn("commentsTest.fixture")(function* (options?: {
  sql?: SqlClient.SqlClient;
  resolveCredential?: Parameters<typeof make>[0]["resolveCredential"];
}) {
  yield* TestClock.setTime(nowMillis);
  yield* runMigrations();
  const native = yield* SqlClient.SqlClient;
  for (const projectId of ["a", "b"]) {
    yield* native`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Test','/unused','[]',${at},${at})`;
    yield* bindIssueRepositoryProject(native, {
      key,
      projectId,
      repositoryName: repository.nameWithOwner,
      accountNodeId: "U_account",
      credentialEpoch: "epoch",
      since: at,
      expectedBindingRevision: null,
    });
    yield* addIssue(native, projectId);
  }
  yield* native`INSERT INTO project_issue_external(host,repository_node_id,issue_node_id,issue_number,source_revision,payload_json) VALUES(${key.host},${key.repositoryNodeId},${rawIssue.node_id},1,${at},${encodeJson({ repository, issue: externalIssue })})`;
  let sourceIssue = rawIssue;
  let response = http([rawComment()], { Etag: '"v1"' });
  let onComments: Effect.Effect<void> = Effect.void;
  const requests: ProcessRunner.ProcessRunInput[] = [];
  let comments = 0;
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("commentsTest.run")(function* (request) {
      requests.push(request);
      const endpoint = request.args.at(-1);
      if (endpoint === "user") return output(http({ node_id: "U_account" }));
      if (endpoint === "repos/owner/repository") return output(http(rawRepository));
      if (endpoint === "repos/owner/repository/issues/1") return output(http(sourceIssue));
      comments++;
      yield* onComments;
      return output(response);
    }),
  });
  const vcs = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const gh = yield* GitHubCli.make.pipe(Effect.provideService(VcsProcess.VcsProcess, vcs));
  const rates = yield* RateLimit.make;
  const client = yield* Client.make.pipe(
    Effect.provideService(GitHubCli.GitHubCli, gh),
    Effect.provideService(RateLimit.SourceControlRateLimit, rates),
  );
  const create = (
    resolveCredential = options?.resolveCredential ?? credential,
    sql = options?.sql ?? native,
  ) =>
    make({ resolveCredential }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(Client.GitHubIssueClient, client),
    );
  const reader = yield* create();
  return {
    sql: native,
    reader,
    create,
    serveIssue: (issue: typeof rawIssue) => {
      sourceIssue = issue;
    },
    requests,
    commentCount: () => comments,
    serve: (value: string) => {
      response = value;
    },
    hold: (effect: Effect.Effect<void>) => {
      onComments = effect;
    },
  };
});
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const pages = (f: Fixture) =>
  f.sql`SELECT * FROM project_issue_page WHERE page_kind='comments' ORDER BY commit_sequence`;
const reason = <A>(effect: Effect.Effect<A, IssueCommentsError>) =>
  effect.pipe(Effect.match({ onSuccess: () => "success", onFailure: (error) => error.reason }));
const authorities = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows: Record<string, ReadonlyArray<unknown>> = {};
    for (const table of [
      "project_work_events",
      "project_work_command_receipts",
      "project_work_tasks",
      "project_work_attempts",
      "project_team_effect",
      "project_team_reservation",
    ])
      rows[table] = yield* sql`SELECT * FROM ${sql(table)}`;
    return rows;
  });

it.effect(
  "reads bounded comments through actual GitHub layers, commits once per repository and reuses exact committed ETags",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.serve(
          http([rawComment(1, "x".repeat(40000)), rawComment(2)], {
            Etag: '"v1"',
            Link: '<https://api.github.com/repos/owner/repository/issues/1/comments?per_page=25&page=2>; rel="next"',
          }),
        );
        const before = yield* authorities(f.sql);
        const first = yield* f.reader.read(input);
        expect(first).toMatchObject({
          projectId: "a",
          issueRevision: 0,
          sourceRevision: at,
          page: 1,
          nextPage: 2,
          observedAt: now,
        });
        expect(first.entries[0]).toMatchObject({ nodeId: "IC_1", bodyTruncated: true });
        expect(first.entries[0]?.body.length).toBe(32000);
        expect(first.entries).toHaveLength(2);
        expect(yield* pages(f)).toHaveLength(1);
        f.serve(http(null, { Etag: '"v1"' }, 304));
        const second = yield* f.reader.read({
          projectId: "b",
          issueRecordId: "issue-b",
          expectedRevision: 0,
        });
        expect(second.entries).toEqual(first.entries);
        expect(second.nextPage).toBe(2);
        expect(yield* pages(f)).toHaveLength(1);
        const commentRequests = f.requests.filter((request) =>
          request.args.at(-1)?.includes("comments?"),
        );
        expect(commentRequests[0]?.args).not.toContain('If-None-Match: "v1"');
        expect(commentRequests[1]?.args).toContain('If-None-Match: "v1"');
        expect(
          commentRequests.every((request) => request.args.at(-1)?.includes("per_page=25&page=1")),
        ).toBe(true);
        expect(f.requests.every((request) => request.env?.GH_TOKEN === "synthetic-token")).toBe(
          true,
        );
        expect(
          f.requests.every((request) => !request.args.join(" ").includes("synthetic-token")),
        ).toBe(true);
        expect(yield* authorities(f.sql)).toEqual(before);
      }),
    ),
);

it.effect(
  "304 without an exact committed snapshot fails and empty 200 is a valid committed page",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.serve(http(null, { Etag: '"v1"' }, 304));
        expect(yield* f.reader.read(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "github", githubReason: "invalid-response" },
        });
        expect(yield* pages(f)).toEqual([]);
        f.serve(http([], { Etag: '"empty"' }));
        expect((yield* f.reader.read(input)).entries).toEqual([]);
        expect(yield* pages(f)).toHaveLength(1);
        f.serve(http(null, { Etag: '"different"' }, 304));
        expect(yield* reason(f.reader.read(input))).toBe("invalid-response");
      }),
    ),
);

it.effect("stable comment IDs deduplicate repeated entries and preserve the newest content", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.serve(
        http([
          rawComment(1),
          rawComment(2),
          { ...rawComment(1, "Edited"), updated_at: "2026-10-01T00:10:00Z" },
        ]),
      );
      expect(
        (yield* f.reader.read(input)).entries.map((entry) => [entry.nodeId, entry.body]),
      ).toEqual([
        ["IC_1", "Edited"],
        ["IC_2", "Comment"],
      ]);
      f.serve(http([rawComment(1), rawComment(1, "Conflicting")]));
      expect(yield* reason(f.reader.read(input))).toBe("invalid-response");
    }),
  ),
);

for (const test of [
  { label: "unexpected properties", value: { ...input, token: "injected" } },
  { label: "empty project ID", value: { ...input, projectId: "" } },
  { label: "control issue ID", value: { ...input, issueRecordId: "issue\na" } },
  { label: "unsafe revision", value: { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 } },
  { label: "negative page", value: { ...input, page: 0 } },
  { label: "overflow page", value: { ...input, page: 10001 } },
])
  it.effect(`rejects ${test.label} before transport`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* reason(f.reader.read(test.value))).toBe("invalid-input");
        expect(f.requests).toEqual([]);
      }),
    ),
  );

for (const change of [
  "rotation",
  "archive",
  "delete",
  "rebind",
  "rename",
  "issue-edit",
  "external-edit",
  "detach",
] as const)
  it.effect(`denies delayed ${change} without writing derived cache`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.hold(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
        const read = yield* f.reader.read(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (change === "rotation") {
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          yield* rotateIssueRepositoryCredential(f.sql, key, {
            accountNodeId: state.accountNodeId,
            credentialEpoch: "rotated",
            expectedRevision: state.revision,
          });
        } else if (change === "archive")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/unused',1,${at})`;
        else if (change === "delete")
          yield* f.sql`DELETE FROM projection_projects WHERE project_id='a'`;
        else if (change === "rebind")
          yield* f.sql`UPDATE project_issue_binding SET generation=generation+1,revision=revision+1 WHERE project_id='a'`;
        else if (change === "rename") {
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          yield* f.sql`UPDATE project_issue_repository SET payload_json=${encodeJson({ ...state, repositoryName: "owner/renamed" })}`;
        } else if (change === "issue-edit")
          yield* f.sql`UPDATE project_team_issue SET revision=1,payload_json=${encodeJson({ ...intake(), revision: 1 })} WHERE project_id='a'`;
        else if (change === "external-edit")
          yield* f.sql`UPDATE project_issue_external SET source_revision='2026-10-01T00:10:00Z',payload_json=${encodeJson({ repository, issue: { ...externalIssue, updatedAt: "2026-10-01T00:10:00Z" } })}`;
        else yield* f.sql`UPDATE project_issue_binding SET status='detached' WHERE project_id='a'`;
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(read))).toBe(true);
        expect(yield* pages(f)).toEqual([]);
      }),
    ),
  );

it.effect("source revisions and pages have distinct cache keys and never borrow ETags", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.reader.read(input);
      yield* f.reader.read({ ...input, page: 2 });
      const updated = "2026-10-01T00:10:00Z";
      yield* f.sql`UPDATE project_team_issue SET revision=1,payload_json=${encodeJson({ ...intake(), revision: 1, sourceRevision: updated })} WHERE project_id='a'`;
      yield* f.sql`UPDATE project_issue_external SET source_revision=${updated},payload_json=${encodeJson({ repository, issue: { ...externalIssue, updatedAt: updated } })}`;
      f.serveIssue({ ...rawIssue, updated_at: updated });
      yield* f.reader.read({ ...input, expectedRevision: 1 });
      expect(yield* pages(f)).toHaveLength(3);
      expect(
        f.requests
          .filter((request) => request.args.at(-1)?.includes("comments?"))
          .every((request) => !request.args.some((arg) => arg.startsWith("If-None-Match"))),
      ).toBe(true);
    }),
  ),
);

it.effect(
  "credential resolver runs without a SQL lock and exact credentials cannot fall back",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* f.create((state) =>
          f.sql`SELECT * FROM project_issue_binding`.pipe(
            Effect.mapError(() => new IssueCommentsError({ reason: "storage" })),
            Effect.andThen(credential(state)),
          ),
        );
        yield* reader.read(input);
        const mismatch = yield* f.create((state) =>
          credential(state).pipe(Effect.map((value) => ({ ...value, accountNodeId: "U_other" }))),
        );
        const count = f.requests.length;
        expect(yield* reason(mismatch.read(input))).toBe("credential-mismatch");
        expect(f.requests).toHaveLength(count);
      }),
    ),
);

for (const corruption of ["malformed", "oversized", "invalid-url", "wrong-key"] as const)
  it.effect(`refuses ${corruption} committed cache before remote read`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.reader.read(input);
        if (corruption === "malformed")
          yield* f.sql`UPDATE project_issue_page SET payload_json='{'`;
        else if (corruption === "oversized")
          yield* f.sql`UPDATE project_issue_page SET payload_json=${" ".repeat(2 * 1024 * 1024 + 1)}`;
        else if (corruption === "invalid-url")
          yield* f.sql`UPDATE project_issue_page SET payload_json=json_set(payload_json,'$.entries[0].url','https://github.com/other/repository/issues/1#issuecomment-1')`;
        else
          yield* f.sql`UPDATE project_issue_page SET payload_json=json_set(payload_json,'$.readKey','[]')`;
        const count = f.requests.length;
        expect(yield* reason(f.reader.read(input))).toBe(
          corruption === "oversized" ? "payload-too-large" : "invalid-storage",
        );
        expect(f.requests).toHaveLength(count);
      }),
    ),
  );

it.effect("retains only 64 committed comment pages and preserves unrelated issue pages", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${key.host},${key.repositoryNodeId},'retained','issues','{}')`;
      for (let page = 1; page <= 65; page++) yield* f.reader.read({ ...input, page });
      const stored = yield* pages(f);
      expect(stored).toHaveLength(64);
      expect(yield* f.sql`SELECT * FROM project_issue_page WHERE page_kind='issues'`).toHaveLength(
        1,
      );
      f.serve(http(null, { Etag: '"v1"' }, 304));
      expect(yield* f.reader.read(input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "github", githubReason: "invalid-response" },
      });
    }),
  ),
);

it.effect("stop and caller interruption join in-flight transport and deny retained readers", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<void>();
      f.hold(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleanup, undefined)),
        ),
      );
      const read = yield* f.reader.read(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.reader.stop;
      expect(yield* Deferred.isDone(cleanup)).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(read))).toBe(true);
      expect(yield* reason(f.reader.read(input))).toBe("stopped");
      expect(yield* pages(f)).toEqual([]);
      const next = yield* f.create();
      const enteredAgain = yield* Deferred.make<void>();
      const cleanupAgain = yield* Deferred.make<void>();
      f.hold(
        Deferred.succeed(enteredAgain, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleanupAgain, undefined)),
        ),
      );
      const canceled = yield* next.read(input).pipe(Effect.forkChild);
      yield* Deferred.await(enteredAgain);
      yield* Fiber.interrupt(canceled);
      expect(yield* Deferred.isDone(cleanupAgain)).toBe(true);
      yield* next.stop;
    }),
  ),
);

it.effect(
  "scope finalization joins transport, preserves no cache and denies the retained service",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const cleanup = yield* Deferred.make<void>();
        f.hold(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleanup, undefined)),
          ),
        );
        const scope = yield* Scope.make();
        const reader = yield* f.create().pipe(Effect.provideService(Scope.Scope, scope));
        const read = yield* reader.read(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Scope.close(scope, Exit.void);
        expect(yield* Deferred.isDone(cleanup)).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(read))).toBe(true);
        expect(yield* reason(reader.read(input))).toBe("stopped");
        expect(yield* pages(f)).toEqual([]);
      }),
    ),
);

it.effect("cache replacement rolls back atomically on native SQL failure", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.reader.read(input);
      const prior = yield* pages(f);
      const sequence = yield* f.sql`SELECT * FROM sqlite_sequence ORDER BY name`;
      yield* f.sql`CREATE TRIGGER reject_comments BEFORE INSERT ON project_issue_page WHEN NEW.page_kind='comments' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`;
      f.serve(http([rawComment(1, "Edited")], { Etag: '"v2"' }));
      expect(yield* reason(f.reader.read(input))).toBe("storage");
      expect(yield* pages(f)).toEqual(prior);
      expect(yield* f.sql`SELECT * FROM sqlite_sequence ORDER BY name`).toEqual(sequence);
      yield* f.sql`DROP TRIGGER reject_comments`;
      expect((yield* f.reader.read(input)).entries[0]?.body).toBe("Edited");
    }),
  ),
);

for (const boundary of [
  "current-project-read",
  "cache-insert-receipt",
  "retention-receipt",
] as const)
  it.effect(`expiry at ${boundary} rolls back the entire derived page`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        const connection = yield* f.sql.reserve;
        let projectReads = 0;
        let held = false;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const observedConnection: Connection = {
          ...connection,
          execute(query, parameters, transform) {
            return connection.execute(query, parameters, transform).pipe(
              Effect.tap(() => {
                if (query.includes("SELECT p.project_id")) projectReads++;
                const selected =
                  boundary === "current-project-read"
                    ? projectReads === 2 && query.includes("SELECT p.project_id")
                    : boundary === "cache-insert-receipt"
                      ? query.includes("INSERT INTO project_issue_page")
                      : query.includes("OFFSET 64");
                if (!selected || held) return Effect.void;
                held = true;
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                );
              }),
            );
          },
        };
        const sql = yield* SqlClient.make({
          acquirer: Effect.succeed(observedConnection),
          transactionAcquirer: Effect.succeed(observedConnection),
          compiler: Statement.makeCompilerSqlite(),
          spanAttributes: [],
        }).pipe(Effect.provide(Reactivity.layer));
        const reader = yield* f.create(credential, sql);
        const read = yield* reader.read(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("55 seconds");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(read).pipe(reason)).toBe("deadline");
        expect(yield* sql`SELECT * FROM project_issue_page`).toEqual([]);
      }),
    ),
  );

it.effect(
  "rejects excessive admitted readers and stop drains queued reads without remote work",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        f.hold(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)));
        const first = yield* f.reader.read(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiting = yield* Effect.forEach(Array.from({ length: 31 }), () =>
          f.reader.read(input).pipe(Effect.forkChild),
        );
        yield* Effect.yieldNow;
        expect(yield* reason(f.reader.read(input))).toBe("busy");
        yield* f.reader.stop;
        for (const fiber of [first, ...waiting])
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        expect(f.commentCount()).toBe(1);
        expect(yield* pages(f)).toEqual([]);
      }),
    ),
);

it.effect("encoded comment pages over 2 MiB are rejected before cache mutation", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.serve(
        http(
          Array.from({ length: 25 }, (_, index) => rawComment(index + 1, "\u0000".repeat(32000))),
        ),
      );
      expect(yield* reason(f.reader.read(input))).toBe("payload-too-large");
      expect(yield* pages(f)).toEqual([]);
    }),
  ),
);

it.effect(
  "a remote issue edit denies an old committed page before conditional comments delivery",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.reader.read(input);
        const committed = yield* pages(f);
        f.serveIssue({ ...rawIssue, updated_at: "2026-10-01T00:10:00Z" });
        f.serve(http(null, { Etag: '"v1"' }, 304));
        expect(yield* f.reader.read(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "github", githubReason: "issue-mismatch" },
        });
        expect(f.commentCount()).toBe(1);
        expect(yield* pages(f)).toEqual(committed);
      }),
    ),
);
