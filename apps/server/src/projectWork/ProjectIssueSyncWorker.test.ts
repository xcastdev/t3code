import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as RateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  readIssueRepositoryState,
  recordIssueRepositoryReadFailure,
  rotateIssueRepositoryCredential,
} from "./ProjectIssueRepositoryState.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import * as Worker from "./ProjectIssueSyncWorker.ts";
import { retireProjectIssueRepositories } from "./ProjectIssueRepositoryLifecycle.ts";
import { writeCommittedIssuePage } from "./github/GitHubIssuePageStore.ts";
import type { IssueSyncRequest } from "./github/GitHubIssueSync.ts";

const at = "2026-10-01T00:00:00Z";
const now = "2026-10-01T01:00:00Z";
const nowMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(now));
const key = { host: "github.com", repositoryNodeId: "R_repository" };
const repository = {
  host: key.host,
  nodeId: key.repositoryNodeId,
  nameWithOwner: "owner/repository",
};
const rawRepository = {
  id: 42,
  node_id: repository.nodeId,
  full_name: repository.nameWithOwner,
  url: "https://api.github.com/repos/owner/repository",
  html_url: "https://github.com/owner/repository",
  updated_at: at,
};
const rawIssue = (number = 1) => ({
  node_id: `I_${number}`,
  number,
  title: "Captured issue",
  body: "Description",
  state: "open",
  comments: 0,
  updated_at: "2026-10-01T00:10:00Z",
  closed_at: null,
  url: `${rawRepository.url}/issues/${number}`,
  html_url: `${rawRepository.html_url}/issues/${number}`,
  repository_url: rawRepository.url,
});
const response = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  `HTTP/2.0 ${status} OK\n${Object.entries({ "Content-Type": "application/json", ...headers })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("")}\r\n${status === 304 ? "" : JSON.stringify(body)}`;
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const setup = Effect.fn("issueWorkerTest.setup")(function* () {
  yield* TestClock.setTime(nowMillis);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const project of ["a", "b"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${project},'Test','/unused','[]',${at},${at}) ON CONFLICT(project_id) DO NOTHING`;
  const repo = yield* ProjectWorkRepository.pipe(Effect.provide(ProjectWorkRepositoryLive));
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  let read: ProcessRunner.ProcessRunner["Service"]["run"] = () =>
    Effect.succeed(output(response([rawIssue()], { Etag: '"page"' })));
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        const endpoint = input.args.at(-1);
        return endpoint === "user"
          ? Effect.succeed(output(response({ node_id: "U_account" })))
          : endpoint === "repos/owner/repository"
            ? Effect.succeed(output(response(rawRepository)))
            : read(input);
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
  const bind = (projectId = "a") =>
    bindIssueRepositoryProject(sql, {
      key,
      projectId,
      expectedBindingRevision: null,
      repositoryName: repository.nameWithOwner,
      accountNodeId: "U_account",
      credentialEpoch: "epoch",
      since: at,
    });
  const resolve: Worker.IssueSyncWorkerOptions["resolveCredential"] = (state) =>
    Effect.succeed({
      cwd: "/trusted/repository",
      host: state.host,
      accountNodeId: state.accountNodeId,
      credentialEpoch: state.credentialEpoch,
      token: Redacted.make("synthetic-token"),
    });
  const start = (resolveCredential = resolve) =>
    Worker.make({ resolveCredential }).pipe(
      Effect.provideService(ProjectWorkRepository, repo),
      Effect.provideService(Client.GitHubIssueClient, client),
    );
  return {
    sql,
    repo,
    calls,
    bind,
    start,
    setRead: (next: typeof read) => {
      read = next;
    },
  };
});
const memory = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(ProjectWorkEventBusLive, NodeSqliteClient.layerMemory())),
  );

it.effect(
  "imports one shared repository page into both projects without creating tasks or dispatch",
  () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          yield* f.bind("b");
          const worker = yield* f.start();
          expect((yield* worker.readOnce(key)).status).toBe("committed");
          for (const project of ["a", "b"]) {
            const state = yield* readCurrentState(f.sql, project);
            expect(
              state.foundationRecords?.filter((record) => record.kind === "issue"),
            ).toHaveLength(1);
            expect(state.tasks).toEqual([]);
          }
          expect(yield* f.sql`SELECT * FROM project_issue_page`).toHaveLength(1);
          expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
          expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
          for (const call of f.calls) {
            expect(call.cwd).toBe("/trusted/repository");
            expect(call.env?.GH_TOKEN).toBe("synthetic-token");
          }
          yield* worker.stop;
        }),
      ),
    ),
);

it.effect("two parallel callers share one SQL lease and remote page", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setRead(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return output(response([rawIssue()]));
          }),
        );
        const worker = yield* f.start();
        const first = yield* Effect.forkScoped(worker.readOnce(key));
        yield* Deferred.await(held);
        const second = yield* worker.readOnce(key);
        expect(second.status).toBe("no-claim");
        expect((yield* readIssueRepositoryState(f.sql, key))?.lease).not.toBeNull();
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first)).status).toBe("committed");
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
      }),
    ),
  ),
);

for (const change of ["rotation", "archive", "deletion", "detach", "expiry"] as const)
  it.effect(`held remote response cannot commit after ${change}`, () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.setRead(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
              return output(response([rawIssue()]));
            }),
          );
          const worker = yield* f.start();
          const pending = yield* Effect.forkScoped(worker.readOnce(key));
          yield* Deferred.await(held);
          const claimed = (yield* readIssueRepositoryState(f.sql, key))!;
          if (change === "rotation")
            yield* rotateIssueRepositoryCredential(f.sql, key, {
              accountNodeId: claimed.accountNodeId,
              expectedRevision: claimed.revision,
              credentialEpoch: "rotated",
            });
          if (change === "archive")
            yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/unused',1,${now})`;
          if (change === "deletion" || change === "detach")
            yield* f.sql.withTransaction(
              retireProjectIssueRepositories(f.sql, "a", change === "deletion"),
            );
          if (change === "expiry") yield* TestClock.setTime(claimed.lease!.expiresAt);
          yield* Deferred.succeed(release, undefined);
          expect(["obsolete", ...(change === "expiry" ? ["failure"] : [])]).toContain(
            (yield* Fiber.join(pending)).status,
          );
          expect(yield* f.sql`SELECT * FROM project_issue_page`).toEqual([]);
          expect(yield* f.sql`SELECT * FROM project_work_events`).toEqual([]);
          expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
        }),
      ),
    ),
  );

for (const kind of ["authentication", "rate-limit", "invalid-page", "transport"] as const)
  it.effect(`records ${kind} without moving page progress or immediately retrying`, () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          f.setRead(() =>
            kind === "transport"
              ? Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "gh",
                    argumentCount: 1,
                    cause: "synthetic",
                  }),
                )
              : Effect.succeed(
                  output(
                    response(
                      kind === "invalid-page"
                        ? [{ ...rawIssue(), number: -1 }]
                        : { message: "denied" },
                      kind === "rate-limit" ? { "Retry-After": "7200" } : {},
                      kind === "invalid-page" ? 200 : kind === "authentication" ? 401 : 429,
                    ),
                    kind === "invalid-page" ? 0 : 1,
                  ),
                ),
          );
          const worker = yield* f.start();
          const receipt = yield* worker.readOnce(key);
          expect(receipt).toMatchObject({ status: "failure", reason: kind });
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          expect(state.nextPage).toBe(1);
          expect(state.since).toBe(at);
          expect(state.lastSuccessfulPageAt).toBeNull();
          expect(state.error).toBe(kind);
          expect(state.retryAt).toBeGreaterThanOrEqual(nowMillis + 30_000);
          expect(state.retryAt).toBeLessThanOrEqual(nowMillis + 3_600_000);
          expect((yield* worker.readOnce(key)).status).toBe("no-claim");
          expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
          expect(yield* f.sql`SELECT * FROM project_issue_page`).toEqual([]);
        }),
      ),
    ),
  );

for (const mismatch of ["missing", "host", "account", "epoch", "resolver-error"] as const)
  it.effect(
    `refuses ${mismatch} credentials before any transport and never uses ambient authentication`,
    () =>
      memory(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* setup();
            yield* f.bind();
            const worker = yield* f.start(() =>
              mismatch === "missing"
                ? Effect.succeed(undefined)
                : mismatch === "resolver-error"
                  ? Effect.fail(new Worker.IssueSyncCredentialError({ reason: "authentication" }))
                  : Effect.succeed({
                      cwd: "/trusted",
                      host: mismatch === "host" ? "other.example" : key.host,
                      accountNodeId: mismatch === "account" ? "U_other" : "U_account",
                      credentialEpoch: mismatch === "epoch" ? "stale" : "epoch",
                      token: Redacted.make("synthetic-token"),
                    }),
            );
            expect(yield* worker.readOnce(key)).toMatchObject({
              status: "failure",
              reason: "authentication",
            });
            expect(f.calls).toEqual([]);
          }),
        ),
      ),
  );

it.effect("stop joins the pending read and resolves both active and queued receipts", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const held = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let active = 0;
        f.setRead(() =>
          Effect.gen(function* () {
            active++;
            yield* Deferred.succeed(held, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }).pipe(Effect.andThen(Deferred.succeed(exited, undefined))),
            ),
          ),
        );
        const worker = yield* f.start();
        const read = yield* Effect.forkScoped(worker.readOnce(key));
        yield* Deferred.await(held);
        const drain = yield* Effect.forkScoped(worker.drain);
        yield* worker.stop;
        yield* Deferred.await(exited);
        expect(active).toBe(0);
        expect((yield* Fiber.join(read)).status).toBe("obsolete");
        expect(yield* Fiber.join(drain)).toEqual([]);
        expect((yield* worker.readOnce(key)).status).toBe("obsolete");
        expect(yield* worker.drain).toEqual([]);
        yield* worker.wake;
        yield* worker.stop;
        expect(yield* f.sql`SELECT * FROM project_issue_page`).toEqual([]);
      }),
    ),
  ),
);

it.effect(
  "closing the service scope interrupts its worker while preserving restart authority",
  () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          const held = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          f.setRead(() =>
            Deferred.succeed(held, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(exited, undefined)),
            ),
          );
          const scope = yield* Scope.make();
          const worker = yield* f.start().pipe(Scope.provide(scope));
          const read = yield* Effect.forkScoped(worker.readOnce(key));
          yield* Deferred.await(held);
          yield* Scope.close(scope, Exit.void);
          yield* Deferred.await(exited);
          expect((yield* Fiber.join(read)).status).toBe("obsolete");
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          expect(state.nextPage).toBe(1);
          expect(state.lease).not.toBeNull();
          expect(yield* f.sql`SELECT * FROM project_work_events`).toEqual([]);
        }),
      ),
    ),
);

const seedCache = Effect.fn("issueWorkerTest.seedCache")(function* (sql: SqlClient.SqlClient) {
  const state = (yield* claimIssueRepositoryRead(sql, key, {
    leaseId: "seed",
    durationMs: 60_000,
    sweepStartedAt: now,
  }))!;
  const request: IssueSyncRequest = {
    repository,
    account: {
      host: state.host,
      nodeId: state.accountNodeId,
      credentialFingerprint: state.credentialEpoch,
    },
    query: { since: state.since, pageSize: 25, state: "all", sort: "updated", direction: "asc" },
    page: state.nextPage,
    generation: state.authorityGeneration,
    leaseId: state.lease!.id,
  };
  yield* sql.withTransaction(
    writeCommittedIssuePage(sql, request, {
      repository,
      account: request.account,
      query: request.query,
      page: request.page,
      generation: request.generation,
      etag: '"cached"',
      entries: [],
      nextPage: null,
      rawEntryCount: 0,
    }),
  );
  yield* recordIssueRepositoryReadFailure(sql, key, state.lease!, {
    retryAt: nowMillis,
    error: "transport",
  });
});

for (const lost of [false, true])
  it.effect(
    `conditional 304 ${lost ? "cannot advance after losing" : "reuses only"} an actual matching committed snapshot`,
    () =>
      memory(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* setup();
            yield* f.bind();
            yield* seedCache(f.sql);
            f.setRead((input) =>
              Effect.gen(function* () {
                expect(input.args).toContain('If-None-Match: "cached"');
                if (lost) yield* f.sql`DELETE FROM project_issue_page`.pipe(Effect.orDie);
                return output(response(null, { Etag: '"cached"' }, 304), 1);
              }),
            );
            const worker = yield* f.start();
            expect(yield* worker.readOnce(key)).toMatchObject(
              lost
                ? { status: "failure", reason: "invalid-page" }
                : { status: "committed", page: 1, nextPage: null },
            );
            expect((yield* readIssueRepositoryState(f.sql, key))?.since).toBe(
              lost ? at : "2026-10-01T00:55:00Z",
            );
          }),
        ),
      ),
  );

it.effect("an absent committed snapshot causes an unconditional read", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const worker = yield* f.start();
        expect((yield* worker.readOnce(key)).status).toBe("committed");
        expect(
          f.calls.flatMap((input) => input.args).some((arg) => arg.startsWith("If-None-Match:")),
        ).toBe(false);
      }),
    ),
  ),
);

it.effect("a terminal page schedules the next overlapping sweep durably", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const worker = yield* f.start();
        expect((yield* worker.readOnce(key)).status).toBe("committed");
        expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
          since: "2026-10-01T00:55:00Z",
          sweepStartedAt: null,
          nextPage: 1,
          retryAt: nowMillis + 60_000,
        });
        expect((yield* worker.readOnce(key)).status).toBe("no-claim");
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
      }),
    ),
  ),
);

it.effect("failed second-page progress survives file-backed service and SQL restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(yield* fs.makeTempDirectoryScoped(), "worker.sqlite");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          const worker = yield* f.start();
          f.setRead(() =>
            Effect.succeed(
              output(
                response([rawIssue()], {
                  Etag: '"first"',
                  Link: `<https://api.github.com/repos/owner/repository/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(at)}&per_page=25&page=2>; rel="next"`,
                }),
              ),
            ),
          );
          expect(yield* worker.readOnce(key)).toMatchObject({
            status: "committed",
            page: 1,
            nextPage: 2,
          });
          f.setRead(() =>
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: "gh",
                argumentCount: 1,
                timeoutMs: 1000,
              }),
            ),
          );
          expect(yield* worker.readOnce(key)).toMatchObject({
            status: "failure",
            reason: "transport",
          });
          expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
            nextPage: 2,
            since: at,
            sweepStartedAt: now,
            lastSuccessfulPageAt: now,
          });
          expect(yield* f.sql`SELECT * FROM project_issue_page`).toHaveLength(1);
          yield* worker.stop;
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(NodeSqliteClient.layer({ filename }), ProjectWorkEventBusLive),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* TestClock.setTime(nowMillis + 30_000);
          f.setRead((input) => {
            expect(input.args.at(-1)).toContain("page=2");
            return Effect.succeed(output(response([rawIssue(2)])));
          });
          const worker = yield* f.start();
          expect(yield* worker.drain).toMatchObject([
            { status: "committed", page: 2, nextPage: null },
          ]);
          expect(
            (yield* readCurrentState(f.sql, "a")).foundationRecords?.filter(
              (record) => record.kind === "issue",
            ),
          ).toHaveLength(2);
          expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
            nextPage: 1,
            since: "2026-10-01T00:55:00Z",
            sweepStartedAt: null,
          });
          expect(yield* f.sql`SELECT * FROM project_issue_page`).toHaveLength(2);
          expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(NodeSqliteClient.layer({ filename }), ProjectWorkEventBusLive),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "restart respects an active lease then recovers its exact pending page after expiry",
  () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.bind();
          const old = (yield* claimIssueRepositoryRead(f.sql, key, {
            leaseId: "old-server",
            durationMs: 1000,
            sweepStartedAt: now,
          }))!;
          const worker = yield* f.start();
          expect((yield* worker.readOnce(key)).status).toBe("no-claim");
          expect(f.calls).toEqual([]);
          yield* TestClock.setTime(old.lease!.expiresAt);
          expect((yield* worker.readOnce(key)).status).toBe("committed");
          expect((yield* readIssueRepositoryState(f.sql, key))?.lease).toBeNull();
        }),
      ),
    ),
);

it.effect("a stalled read is cancelled within its SQL lease and records a bounded retry", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const held = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        f.setRead(() =>
          Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
        );
        const worker = yield* f.start();
        const pending = yield* Effect.forkScoped(worker.readOnce(key));
        yield* Deferred.await(held);
        yield* TestClock.adjust("55 seconds");
        yield* Deferred.await(cancelled);
        expect(yield* Fiber.join(pending)).toMatchObject({
          status: "failure",
          reason: "transport",
          retryAt: nowMillis + 85_000,
        });
        expect((yield* readIssueRepositoryState(f.sql, key))?.lease).toBeNull();
        expect(yield* f.sql`SELECT * FROM project_issue_page`).toEqual([]);
      }),
    ),
  ),
);

it.effect(
  "each drain scans at most32 SQL keys and later drains fairly traverse the primary index",
  () =>
    memory(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup();
          for (let index = 0; index < 33; index++)
            yield* bindIssueRepositoryProject(f.sql, {
              key: { host: key.host, repositoryNodeId: `R_${String(index).padStart(3, "0")}` },
              projectId: "a",
              repositoryName: repository.nameWithOwner,
              expectedBindingRevision: null,
              accountNodeId: "U_account",
              credentialEpoch: "epoch",
              since: at,
            });
          const worker = yield* f.start(() => Effect.succeed(undefined));
          const first = yield* worker.drain;
          expect(first).toHaveLength(32);
          expect(first[0]?.key.repositoryNodeId).toBe("R_000");
          const second = yield* worker.drain;
          expect(second).toHaveLength(1);
          expect(second[0]?.key.repositoryNodeId).toBe("R_032");
          expect(f.calls).toEqual([]);
          const plan = yield* f.sql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN SELECT host,repository_node_id FROM project_issue_repository WHERE (host,repository_node_id)>('github.com','R_031') ORDER BY host,repository_node_id LIMIT 32`;
          expect(plan.map((row) => row.detail).join(" ")).toContain("SEARCH");
        }),
      ),
    ),
);

it.effect("independent service instances cannot acquire the same durable repository lease", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setRead(() =>
          Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(output(response([rawIssue()]))),
          ),
        );
        const first = yield* f.start();
        const second = yield* f.start();
        const read = yield* Effect.forkScoped(first.readOnce(key));
        yield* Deferred.await(held);
        expect((yield* second.readOnce(key)).status).toBe("no-claim");
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(read)).status).toBe("committed");
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
      }),
    ),
  ),
);

it.effect("coalesced startup wakes and periodic ticks respect the durable terminal delay", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const worker = yield* f.start();
        yield* worker.wake;
        yield* worker.wake;
        yield* worker.drain;
        expect(yield* f.sql`SELECT * FROM project_issue_page`).toHaveLength(1);
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain;
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain;
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(2);
        expect((yield* readIssueRepositoryState(f.sql, key))?.retryAt).toBe(nowMillis + 120_000);
      }),
    ),
  ),
);

it.effect("periodic intake continues during no-claim traffic for another bound repository", () =>
  memory(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.bind();
        const unavailable = { host: key.host, repositoryNodeId: "R_unavailable" };
        yield* bindIssueRepositoryProject(f.sql, {
          key: unavailable,
          projectId: "b",
          expectedBindingRevision: null,
          repositoryName: "owner/unavailable",
          accountNodeId: "U_account",
          credentialEpoch: "epoch",
          since: at,
        });
        const worker = yield* f.start((state) =>
          Effect.succeed(
            state.repositoryNodeId === unavailable.repositoryNodeId
              ? undefined
              : {
                  cwd: "/trusted/repository",
                  host: state.host,
                  accountNodeId: state.accountNodeId,
                  credentialEpoch: state.credentialEpoch,
                  token: Redacted.make("synthetic-token"),
                },
          ),
        );
        expect(yield* worker.readOnce(unavailable)).toMatchObject({
          status: "failure",
          reason: "authentication",
        });
        expect((yield* readIssueRepositoryState(f.sql, unavailable))?.status).toBe("unavailable");
        for (let index = 0; index < 3; index++) {
          yield* TestClock.adjust("20 seconds");
          expect((yield* worker.readOnce(unavailable)).status).toBe("no-claim");
        }
        expect(f.calls.filter((call) => call.args.at(-1)?.includes("issues?"))).toHaveLength(1);
        expect((yield* readIssueRepositoryState(f.sql, key))?.lastSuccessfulPageAt).not.toBeNull();
        const state = yield* readCurrentState(f.sql, "a");
        expect(state.foundationRecords?.filter((record) => record.kind === "issue")).toHaveLength(
          1,
        );
        expect(state.tasks).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
        yield* worker.stop;
      }),
    ),
  ),
);
