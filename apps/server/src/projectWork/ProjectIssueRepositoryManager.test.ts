import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as RateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Snapshot from "./ProjectIssueCredentialSnapshot.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import * as Manager from "./ProjectIssueRepositoryManager.ts";
import {
  bindIssueRepositoryProject,
  claimIssueRepositoryRead,
  readIssueRepositoryState,
  renameIssueRepository,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";

const at = "2026-10-01T00:00:00Z";
const key = { host: "github.com", repositoryNodeId: "R_repo" };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
const http = (body: unknown, code = 200) =>
  `HTTP/2.0 ${code} OK\r\nContent-Type: application/json\r\n\r\n${encode(body)}`;
const setup = Effect.fn("managerTest.setup")(function* () {
  yield* TestClock.setTime(100);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const state = {
    remote: "origin git@github.com:owner/repo.git (fetch)\n",
    nodeId: "R_repo",
    name: "owner/repo",
    account: "U_user",
    login: "alice",
    token: "synthetic-token",
    failAuth: false,
    apiStatus: 200,
  };
  let boundary: ((input: ProcessRunner.ProcessRunInput) => Effect.Effect<void>) | undefined;
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("managerTest.run")(function* (input) {
      calls.push(input);
      if (boundary !== undefined) yield* boundary(input);
      if (input.command === "git")
        return output(input.args.includes("remote") ? state.remote : `${input.args[1]}\n`);
      if (input.args[0] === "auth") {
        if (state.failAuth) return output("", 1);
        return output(
          input.args[1] === "token"
            ? `${state.token}\n`
            : encode({
                hosts: {
                  "github.com": [
                    { host: "github.com", login: state.login, active: true, state: "success" },
                  ],
                },
              }),
        );
      }
      const user = { node_id: state.account, login: state.login };
      if (input.args.at(-1) === "user")
        return output(
          input.args.includes("--include") ? http(user, state.apiStatus) : encode(user),
        );
      return output(
        http({
          id: 1,
          node_id: state.nodeId,
          full_name: state.name,
          url: `https://api.github.com/repos/${state.name}`,
          html_url: `https://github.com/${state.name}`,
          updated_at: at,
        }),
      );
    }),
  });
  const identities = yield* Identity.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const vcs = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const gh = yield* GitHubCli.make.pipe(Effect.provideService(VcsProcess.VcsProcess, vcs));
  const snapshot = yield* Snapshot.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(GitHubCli.GitHubCli, gh),
  );
  const rates = yield* RateLimit.make;
  const client = yield* Client.make.pipe(
    Effect.provideService(GitHubCli.GitHubCli, gh),
    Effect.provideService(RateLimit.SourceControlRateLimit, rates),
  );
  const start = (options: Parameters<typeof Manager.make>[0] = {}) =>
    Manager.make(options).pipe(
      Effect.provideService(Identity.RepositoryIdentityResolver, identities),
      Effect.provideService(Snapshot.ProjectIssueCredentialSnapshot, snapshot),
      Effect.provideService(Client.GitHubIssueClient, client),
    );
  const project = Effect.fn("managerTest.project")(function* (id = "a") {
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Fixture',${`/fixture/${id}`},'[]',${at},${at})`;
  });
  const stored = () => readIssueRepositoryState(sql, key);
  const editState = Effect.fn("managerTest.editState")(function* (
    change: Partial<IssueRepositoryState>,
  ) {
    const previous = (yield* stored())!;
    yield* sql`UPDATE project_issue_repository SET payload_json=${encode({ ...previous, ...change })} WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
  });
  return {
    sql,
    state,
    calls,
    start,
    project,
    stored,
    editState,
    setBoundary: (hook: typeof boundary) => {
      boundary = hook;
    },
  };
});
const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope | import("effect/Crypto").Crypto>,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeSqliteClient.layerMemory(), NodeCrypto.layer)),
  );
const readyManager = Effect.fn("managerTest.readyManager")(function* () {
  const fixture = yield* setup();
  yield* fixture.project();
  const ready = yield* Deferred.make<void>();
  let readyCount = 0;
  const manager = yield* fixture.start({
    onReady: Effect.sync(() => {
      readyCount++;
    }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.asVoid),
  });
  yield* Deferred.await(ready);
  return { ...fixture, manager, readyCount: () => readyCount };
});

it.effect(
  "startup binds through the actual canonical resolver, snapshot and GitHub client without dispatch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const state = (yield* f.stored())!;
        expect(state).toMatchObject({
          status: "ready",
          repositoryName: "owner/repo",
          accountNodeId: "U_user",
          accountLogin: "alice",
        });
        expect(state.credentialEpoch).toMatch(/^[a-f0-9-]{36}$/u);
        const credential = (yield* f.manager.resolveCredential(state))!;
        expect(Redacted.value(credential.token)).toBe("synthetic-token");
        expect(credential.cwd).toBe("/fixture/a");
        expect(encode(yield* f.sql`SELECT * FROM project_issue_repository`)).not.toContain(
          "synthetic-token",
        );
        expect(yield* f.sql`SELECT * FROM project_work_events`).toHaveLength(0);
        expect(f.calls.some((call) => call.command !== "git" && call.command !== "gh")).toBe(false);
      }),
    ),
);

it.effect("deduplicates shared repository lookups and preserves successful deadlines", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.project("a");
      yield* f.project("b");
      const ready = yield* Deferred.make<void>();
      const manager = yield* f.start({
        onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      });
      yield* Deferred.await(ready);
      expect(f.calls.filter((call) => call.args.at(-1) === "repos/owner/repo")).toHaveLength(1);
      expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(2);
      yield* f.editState({ retryAt: 60100, lastSuccessfulPageAt: at });
      f.state.token = "rotated-token";
      const old = (yield* f.stored())!;
      yield* manager.refresh;
      const current = (yield* f.stored())!;
      expect(current.retryAt).toBe(60100);
      expect(current.lastSuccessfulPageAt).toBe(at);
      expect(current.credentialEpoch).not.toBe(old.credentialEpoch);
      expect(yield* manager.resolveCredential(old)).toBeUndefined();
      expect((yield* manager.resolveCredential(current))?.credentialEpoch).toBe(
        current.credentialEpoch,
      );
    }),
  ),
);

it.effect("canonical upstream wins and missing remotes never fall back to old bindings", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup();
      f.state.remote += "upstream https://github.com/trusted/upstream.git (fetch)\n";
      f.state.name = "trusted/upstream";
      yield* f.project();
      const ready = yield* Deferred.make<void>();
      const manager = yield* f.start({
        onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      });
      yield* Deferred.await(ready);
      expect((yield* f.stored())?.repositoryName).toBe("trusted/upstream");
      f.state.remote = "";
      expect(yield* manager.refresh).toEqual([
        { projectId: "a", status: "human-required", reason: "identity-unavailable" },
      ]);
      expect((yield* f.stored())?.status).toBe("unavailable");
      expect(yield* manager.resolveCredential((yield* f.stored())!)).toBeUndefined();
    }),
  ),
);

it.effect("same node rename preserves progress and fences the old lease", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      yield* f.editState({ since: at, retryAt: 0, lastSuccessfulPageAt: at });
      const claimed = (yield* claimIssueRepositoryRead(f.sql, key, {
        leaseId: "lease",
        durationMs: 1000,
        sweepStartedAt: at,
      }))!;
      f.state.name = "owner/renamed";
      f.state.remote = "origin git@github.com:owner/renamed.git (fetch)\n";
      expect((yield* f.manager.refresh)[0]?.status).toBe("ready");
      const current = (yield* f.stored())!;
      expect(current.repositoryName).toBe("owner/renamed");
      expect(current.since).toBe(at);
      expect(current.retryAt).toBe(0);
      expect(current.lease).toBeNull();
      expect(current.authorityGeneration).toBeGreaterThan(claimed.authorityGeneration);
    }),
  ),
);

it.effect("changed stable node requires a human and retains the old source and binding", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      const old = (yield* f.stored())!;
      f.state.nodeId = "R_replaced";
      expect(yield* f.manager.refresh).toEqual([
        { projectId: "a", status: "human-required", reason: "repository-changed" },
      ]);
      expect((yield* f.stored())?.repositoryNodeId).toBe("R_repo");
      expect(
        (yield* f.sql`SELECT repository_node_id AS repositoryNodeId FROM project_issue_binding`)[0]
          ?.repositoryNodeId,
      ).toBe("R_repo");
      expect(yield* f.sql`SELECT * FROM project_issue_repository`).toHaveLength(1);
      expect(yield* f.manager.resolveCredential(old)).toBeUndefined();
    }),
  ),
);

it.effect(
  "account replacement and authentication failure revoke credentials without losing successful history",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        yield* f.editState({ since: at, lastSuccessfulPageAt: at, retryAt: 60100 });
        const old = (yield* f.stored())!;
        f.state.account = "U_other";
        expect((yield* f.manager.refresh)[0]).toMatchObject({
          status: "human-required",
          reason: "account-mismatch",
        });
        expect((yield* f.stored())?.accountNodeId).toBe("U_user");
        f.state.failAuth = true;
        expect((yield* f.manager.refresh)[0]?.reason).toBe("authentication");
        const failed = (yield* f.stored())!;
        expect(failed).toMatchObject({
          status: "unavailable",
          error: "authentication",
          since: at,
          lastSuccessfulPageAt: at,
          retryAt: 60100,
        });
        expect(yield* f.manager.resolveCredential(old)).toBeUndefined();
      }),
    ),
);

it.effect("additional binding cannot silently take another account's shared repository", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      const old = (yield* f.stored())!;
      yield* f.project("b");
      f.state.account = "U_other";
      f.state.login = "bob";
      const receipts = yield* f.manager.refresh;
      expect(receipts.find((receipt) => receipt.projectId === "b")).toMatchObject({
        status: "human-required",
        reason: "account-mismatch",
      });
      expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(1);
      expect((yield* f.stored())?.accountNodeId).toBe(old.accountNodeId);
    }),
  ),
);

it.effect(
  "restart rotates an opaque epoch and keeps the stored account login and successful deadline",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.project();
        yield* bindIssueRepositoryProject(f.sql, {
          key,
          projectId: "a",
          repositoryName: "owner/repo",
          accountNodeId: "U_user",
          accountLogin: "alice",
          credentialEpoch: "prior-process-epoch",
          since: at,
          expectedBindingRevision: null,
        });
        yield* f.editState({ retryAt: 60100, lastSuccessfulPageAt: at });
        const ready = yield* Deferred.make<void>();
        const manager = yield* f.start({
          onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        });
        yield* Deferred.await(ready);
        const current = (yield* f.stored())!;
        expect(current.credentialEpoch).not.toBe("prior-process-epoch");
        expect(current.retryAt).toBe(60100);
        expect(f.calls.find((call) => call.args[1] === "token")?.args).toContain("alice");
        expect((yield* manager.resolveCredential(current))?.accountNodeId).toBe("U_user");
      }),
    ),
);

for (const action of ["archive", "delete", "workspace", "binding"] as const) {
  it.effect(`refuses a ${action} race after the remote read`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.state.token = "new-token";
        f.setBoundary((input) =>
          input.args.at(-1) === "repos/owner/repo"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const refreshing = yield* Effect.forkChild(f.manager.refresh);
        yield* Deferred.await(entered);
        const before = (yield* f.stored())!;
        if (action === "archive")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/fixture/a',1,${at})`;
        if (action === "delete")
          yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id='a'`;
        if (action === "workspace")
          yield* f.sql`UPDATE projection_projects SET workspace_root='/replacement' WHERE project_id='a'`;
        if (action === "binding")
          yield* f.sql`UPDATE project_issue_binding SET generation=generation+1 WHERE project_id='a'`;
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(refreshing))[0]?.status).toBe("obsolete");
        expect(yield* f.stored()).toEqual(before);
        expect(yield* f.manager.resolveCredential(before)).toBeUndefined();
      }),
    ),
  );
}

it.effect("a concurrent repository write wins over a stale failure observation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.state.failAuth = true;
      f.setBoundary((input) =>
        input.args[1] === "status"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const refreshing = yield* Effect.forkChild(f.manager.refresh);
      yield* Deferred.await(entered);
      const previous = (yield* f.stored())!;
      yield* renameIssueRepository(f.sql, key, {
        repositoryName: "owner/new",
        accountNodeId: "U_user",
        expectedRevision: previous.revision,
      });
      const before = yield* f.stored();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(refreshing))[0]?.status).toBe("obsolete");
      expect(yield* f.stored()).toEqual(before);
    }),
  ),
);

it.effect(
  "joins interrupted remote work, settles coalesced refresh callers and denies retained post-stop reads",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const entered = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        f.setBoundary((input) =>
          input.args[1] === "status"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finalized, undefined)),
              )
            : Effect.void,
        );
        const old = (yield* f.stored())!;
        const first = yield* Effect.forkChild(f.manager.refresh);
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(f.manager.refresh);
        yield* f.manager.stop;
        expect(yield* Deferred.isDone(finalized)).toBe(true);
        expect(yield* Fiber.join(first)).toEqual([]);
        expect(yield* Fiber.join(second)).toEqual([]);
        expect(yield* f.stored()).toEqual(old);
        const count = f.calls.length;
        expect(yield* f.manager.refresh).toEqual([]);
        expect(yield* f.manager.resolveCredential(old)).toBeUndefined();
        expect(f.calls).toHaveLength(count);
      }),
    ),
);

it.effect(
  "stop joins an in-flight onReady callback and scope release makes retained handles inert",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.project();
        const scope = yield* Scope.make();
        const entered = yield* Deferred.make<void>();
        const joined = yield* Deferred.make<void>();
        const manager = yield* f
          .start({
            onReady: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(joined, undefined)),
            ),
          })
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* Deferred.await(entered);
        yield* Scope.close(scope, Exit.void);
        expect(yield* Deferred.isDone(joined)).toBe(true);
        expect(yield* manager.resolveCredential((yield* f.stored())!)).toBeUndefined();
        expect(yield* manager.refresh).toEqual([]);
      }),
    ),
);

it.effect("pages active projects in bounded keyset batches with bounded retained credentials", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup();
      for (let index = 0; index < 65; index++)
        yield* f.project(`p${String(index).padStart(2, "0")}`);
      // Different stable repositories avoid the existing eight-owner bound.
      f.setBoundary((input) =>
        Effect.sync(() => {
          if (input.command === "git") {
            f.state.remote = `origin git@github.com:owner/${input.args[1]?.split("/").at(-1)}.git (fetch)\n`;
          }
          if (input.command === "gh") {
            const id = input.cwd?.split("/").at(-1);
            f.state.nodeId = `R_${id}`;
            f.state.name = `owner/${id}`;
          }
        }),
      );
      const ready = yield* Deferred.make<void>();
      const manager = yield* f.start({
        onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      });
      yield* Deferred.await(ready);
      expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(32);
      expect(yield* manager.refresh).toHaveLength(32);
      expect(yield* manager.refresh).toHaveLength(1);
      expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(65);
      const oldest = (yield* readIssueRepositoryState(f.sql, {
        host: key.host,
        repositoryNodeId: "R_p00",
      }))!;
      expect(yield* manager.resolveCredential(oldest)).toBeUndefined();
      const newest = (yield* readIssueRepositoryState(f.sql, {
        host: key.host,
        repositoryNodeId: "R_p64",
      }))!;
      expect((yield* manager.resolveCredential(newest))?.cwd).toBe("/fixture/p64");
    }),
  ),
);

it.effect(
  "detached historical bindings and legacy accountless state require human intervention",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        yield* f.sql`UPDATE project_issue_binding SET status='detached' WHERE project_id='a'`;
        expect((yield* f.manager.refresh)[0]?.status).toBe("human-required");
        expect((yield* f.sql`SELECT status FROM project_issue_binding`)[0]?.status).toBe(
          "detached",
        );
        yield* f.sql`UPDATE project_issue_binding SET status='active' WHERE project_id='a'`;
        const prior = (yield* f.stored())!;
        const { accountLogin: _accountLogin, ...legacy } = prior;
        yield* f.sql`UPDATE project_issue_repository SET payload_json=${encode(legacy)}`;
        const count = f.calls.length;
        expect((yield* f.manager.refresh)[0]?.reason).toBe("account-mismatch");
        expect(f.calls.slice(count).every((call) => call.command === "git")).toBe(true);
      }),
    ),
);

it.effect(
  "initial authentication refusal has a bounded receipt and invents no repository authority",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.project();
        f.state.failAuth = true;
        const manager = yield* f.start();
        const receipts = yield* manager.refresh;
        expect(receipts).toEqual([
          { projectId: "a", status: "unavailable", reason: "authentication" },
        ]);
        expect(yield* f.sql`SELECT * FROM project_issue_repository`).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(0);
        expect(encode(receipts)).not.toContain(f.state.token);
      }),
    ),
);

it.effect("new project deletion after lookup cannot create a first binding", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup();
      const manager = yield* f.start();
      yield* manager.refresh;
      yield* f.project();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setBoundary((input) =>
        input.args.at(-1) === "repos/owner/repo"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const refreshing = yield* Effect.forkChild(manager.refresh);
      yield* Deferred.await(entered);
      yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id='a'`;
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(refreshing))[0]?.status).toBe("obsolete");
      expect(yield* f.sql`SELECT * FROM project_issue_repository`).toHaveLength(0);
    }),
  ),
);

it.effect(
  "recovering verified transport failure preserves history and reinstates only current credentials",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        yield* f.editState({ since: at, lastSuccessfulPageAt: at });
        f.state.apiStatus = 503;
        expect((yield* f.manager.refresh)[0]?.reason).toBe("transport");
        const unavailable = (yield* f.stored())!;
        expect(unavailable.status).toBe("unavailable");
        expect(unavailable.error).toBe("transport");
        f.state.apiStatus = 200;
        expect((yield* f.manager.refresh)[0]?.status).toBe("ready");
        const restored = (yield* f.stored())!;
        expect(restored).toMatchObject({ status: "ready", since: at, lastSuccessfulPageAt: at });
        expect(restored.credentialEpoch).toBe(unavailable.credentialEpoch);
        expect((yield* f.manager.resolveCredential(restored))?.accountNodeId).toBe("U_user");
      }),
    ),
);

it.effect("fresh token recovery rotates the failed epoch and revokes an existing lease", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      const leased = (yield* claimIssueRepositoryRead(f.sql, key, {
        leaseId: "old-lease",
        durationMs: 1000,
        sweepStartedAt: at,
      }))!;
      f.state.failAuth = true;
      yield* f.manager.refresh;
      f.state.failAuth = false;
      f.state.token = "verified-new-token";
      expect((yield* f.manager.refresh)[0]?.status).toBe("ready");
      const current = (yield* f.stored())!;
      expect(current.credentialEpoch).not.toBe(leased.credentialEpoch);
      expect(current.lease).toBeNull();
      expect(yield* f.manager.resolveCredential(leased)).toBeUndefined();
      expect(Redacted.value((yield* f.manager.resolveCredential(current))!.token)).toBe(
        "verified-new-token",
      );
    }),
  ),
);

it.effect(
  "periodic keyset work continues without manual refresh and unchanged refreshes do not wake sync",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const completed = yield* Deferred.make<void>();
        yield* f.project("b");
        f.setBoundary((input) =>
          input.cwd === "/fixture/b" && input.args[1] === "status"
            ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(completed);
        // Refresh is a receipt barrier for the completed periodic pass's writes.
        yield* f.manager.refresh;
        expect(yield* f.sql`SELECT * FROM project_issue_binding`).toHaveLength(2);
        const wakes = f.readyCount();
        expect((yield* f.manager.refresh).every((receipt) => receipt.status === "unchanged")).toBe(
          true,
        );
        expect(f.readyCount()).toBe(wakes);
      }),
    ),
);

it.effect("oversized stored state denies before decode and never grants cached credentials", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      const before = (yield* f.stored())!;
      yield* f.sql`UPDATE project_issue_repository SET payload_json=${encode({ ...before, unexpected: "x".repeat(65536) })}`;
      const count = f.calls.length;
      expect((yield* f.manager.refresh)[0]?.status).toBe("human-required");
      expect(f.calls).toHaveLength(count);
      expect(yield* f.manager.resolveCredential(before)).toBeUndefined();
    }),
  ),
);

it.effect("a healthy shared owner cannot reactivate a project whose remote changed", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      yield* f.project("b");
      yield* f.manager.refresh;
      f.setBoundary((input) =>
        Effect.sync(() => {
          const cwd = input.command === "git" ? input.args[1] : input.cwd;
          const changed = cwd === "/fixture/a";
          f.state.remote = `origin git@github.com:owner/${changed ? "other" : "repo"}.git (fetch)\n`;
          f.state.name = changed ? "owner/other" : "owner/repo";
          f.state.nodeId = changed ? "R_other" : "R_repo";
        }),
      );
      expect((yield* f.manager.refresh)[0]?.reason).toBe("repository-changed");
      const bindings = yield* f.sql<{
        projectId: string;
        status: string;
      }>`SELECT project_id AS projectId,status FROM project_issue_binding ORDER BY project_id`;
      expect(bindings).toEqual([
        { projectId: "a", status: "detached" },
        { projectId: "b", status: "active" },
      ]);
      const current = (yield* f.stored())!;
      expect(current.status).toBe("ready");
      expect((yield* f.manager.resolveCredential(current))?.cwd).toBe("/fixture/b");
      const claim = (yield* claimIssueRepositoryRead(f.sql, key, {
        leaseId: "healthy-owner",
        durationMs: 1000,
        sweepStartedAt: at,
      }))!;
      expect(claim.lease?.bindings.map((binding) => binding.projectId)).toEqual(["b"]);
      expect((yield* f.manager.refresh)[0]).toMatchObject({
        status: "human-required",
        reason: "binding-conflict",
      });
      expect(yield* f.sql`SELECT * FROM project_issue_repository`).toHaveLength(1);
    }),
  ),
);

it.effect("factory refuses an inherited transaction before invoking any remote boundary", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.project();
      const denied = yield* f.sql.withTransaction(f.start()).pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(denied.failure).toMatchObject({
          _tag: "IssueSyncCredentialError",
          reason: "unavailable",
        });
      expect(f.calls).toHaveLength(0);
      expect(yield* f.sql`SELECT * FROM project_issue_repository`).toHaveLength(0);
    }),
  ),
);

it.effect(
  "same verified token recovers authentication with a fresh epoch that repeated refresh preserves",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const old = (yield* f.stored())!;
        f.state.failAuth = true;
        expect((yield* f.manager.refresh)[0]?.reason).toBe("authentication");
        f.state.failAuth = false;
        expect((yield* f.manager.refresh)[0]?.status).toBe("ready");
        const recovered = (yield* f.stored())!;
        expect(recovered.credentialEpoch).not.toBe(old.credentialEpoch);
        expect(recovered.credentialEpoch).toMatch(/^[a-f0-9-]{36}$/u);
        expect(yield* f.manager.resolveCredential(old)).toBeUndefined();
        expect(Redacted.value((yield* f.manager.resolveCredential(recovered))!.token)).toBe(
          "synthetic-token",
        );
        expect((yield* f.manager.refresh)[0]?.status).toBe("unchanged");
        expect(yield* f.stored()).toEqual(recovered);
      }),
    ),
);

it.effect(
  "retained readers refuse a borrowed transaction instead of granting its old snapshot",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* readyManager();
        const state = (yield* f.stored())!;
        const calls = f.calls.length;
        const denied = yield* f.sql
          .withTransaction(f.manager.resolveCredential(state))
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
        expect(yield* f.sql.withTransaction(f.manager.refresh)).toEqual([]);
        expect(f.calls).toHaveLength(calls);
        expect((yield* f.manager.resolveCredential(state))?.credentialEpoch).toBe(
          state.credentialEpoch,
        );
      }),
    ),
);

it.effect("counter exhaustion refuses detachment without changing history or authority", () =>
  run(
    Effect.gen(function* () {
      const f = yield* readyManager();
      yield* f.sql`UPDATE project_issue_binding SET revision=${Number.MAX_SAFE_INTEGER} WHERE project_id='a'`;
      const previous = yield* f.stored();
      f.state.nodeId = "R_other";
      expect((yield* f.manager.refresh)[0]?.status).toBe("obsolete");
      expect(yield* f.stored()).toEqual(previous);
      expect((yield* f.sql`SELECT status FROM project_issue_binding`)[0]?.status).toBe("active");
    }),
  ),
);
