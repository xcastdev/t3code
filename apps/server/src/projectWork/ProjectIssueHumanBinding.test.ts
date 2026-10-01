import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectIssueIntake,
} from "@t3tools/contracts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Resolver from "../project/RepositoryIdentityResolver.ts";
import * as Settings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as RateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Snapshot from "./ProjectIssueCredentialSnapshot.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import * as Human from "./ProjectIssueHumanBinding.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
  claimIssueRepositoryRead,
  recordIssueRepositoryReadFailure,
} from "./ProjectIssueRepositoryState.ts";

const decodeIntake = Schema.decodeUnknownEffect(ProjectIssueIntake);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-01T00:00:00Z";
const key = { host: "github.com", repositoryNodeId: "R_target" };
const input = {
  projectId: "a",
  expectedRepositoryKey: key,
  expectedTargetBindingRevision: null,
  accountLogin: "alice",
};
const http = (body: unknown) =>
  `HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n${json(body)}`;
const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const fixture = Effect.fn("humanBindingTest.fixture")(function* () {
  yield* TestClock.setTime(1790812800000);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  for (const id of ["a", "b"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Test','/repo','[]',${at},${at})`;
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const state = {
    root: "/repo",
    repositoryResponse: undefined as string | undefined,
    remote:
      "upstream https://github.com/owner/target.git (fetch)\norigin https://github.com/fork/other.git (fetch)\n",
    node: key.repositoryNodeId,
    name: "owner/target",
    account: "U_alice",
    login: "alice",
    onRepository: Effect.void as Effect.Effect<void>,
    onStatus: Effect.void as Effect.Effect<void>,
    onGit: Effect.void as Effect.Effect<void>,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("humanBindingTest.process")(function* (request) {
      expect(Option.isNone(yield* Effect.serviceOption(sql.transactionService))).toBe(true);
      calls.push(request);
      if (request.command === "git") {
        yield* state.onGit;
        return output(request.args.includes("--show-toplevel") ? `${state.root}\n` : state.remote);
      }
      if (request.args[0] === "auth") {
        if (request.args[1] === "token") return output("synthetic-token\n");
        yield* state.onStatus;
        return output(
          json({
            hosts: {
              fixture: [
                { host: key.host, login: "alice", active: false, state: "success" },
                { host: key.host, login: "bob", active: true, state: "success" },
              ],
            },
          }),
        );
      }
      if (request.args.at(-1) === "user") {
        const user = { node_id: state.account, login: state.login };
        return output(request.args.includes("--include") ? http(user) : json(user));
      }
      yield* state.onRepository;
      return output(
        state.repositoryResponse ??
          http({
            id: 123,
            node_id: state.node,
            full_name: state.name,
            url: `https://api.github.com/repos/${state.name}`,
            html_url: `https://github.com/${state.name}`,
            updated_at: at,
          }),
      );
    }),
  });
  const resolver = yield* Resolver.make().pipe(
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
  const create = Human.make.pipe(
    Effect.provideService(Resolver.RepositoryIdentityResolver, resolver),
    Effect.provideService(Snapshot.ProjectIssueCredentialSnapshot, snapshot),
    Effect.provideService(Client.GitHubIssueClient, client),
  );
  const service = yield* create;
  const seed = (oldKey = key, projectId = "a") =>
    bindIssueRepositoryProject(sql, {
      key: oldKey,
      projectId,
      repositoryName: "owner/old",
      accountNodeId: "U_alice",
      accountLogin: "alice",
      credentialEpoch: "old-epoch",
      since: at,
      expectedBindingRevision: null,
    });
  return { sql, settings, calls, state, service, create, seed };
});
const run = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient | Settings.ServerSettingsService>,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeSqliteClient.layerMemory(),
        Settings.layerTest({ projectWorkEnabled: true }),
        NodeServices.layer,
      ),
    ),
  );

it.effect(
  "binds the canonical upstream with the explicit verified login and returns only a safe receipt",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* f.service.bind(input)).toEqual({
          ...key,
          bindingRevision: 0,
          status: "ready",
        });
        expect((yield* readIssueRepositoryState(f.sql, key))?.accountLogin).toBe("alice");
        expect(f.calls.find((call) => call.args.at(-1) === "repos/owner/target")?.args.at(-1)).toBe(
          "repos/owner/target",
        );
        expect(f.calls.find((call) => call.args[1] === "token")?.args.at(-1)).toBe("alice");
        expect(
          f.calls.find((call) => call.args.at(-1) === "repos/owner/target")?.env?.GH_TOKEN,
        ).toBe("synthetic-token");
        expect(yield* f.sql`SELECT count(*) AS count FROM project_work_events`).toEqual([
          { count: 0 },
        ]);
      }),
    ),
);
for (const reason of [
  "feature-off",
  "wrong-repository",
  "null-canonical",
  "previous-required",
] as const)
  it.effect(`denies ${reason} without installing the target`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        if (reason === "feature-off")
          yield* f.settings.updateSettings({ projectWorkEnabled: false });
        if (reason === "wrong-repository") f.state.node = "R_wrong";
        if (reason === "null-canonical") f.state.remote = "";
        if (reason === "previous-required")
          yield* f.seed({ host: "github.com", repositoryNodeId: "R_old" });
        expect((yield* f.service.bind(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
      }),
    ),
  );
it.effect(
  "rejects a workspace change during remote verification without holding the SQL lock",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const binding = yield* f.service.bind(input).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* f.sql.withTransaction(
          f.sql`UPDATE projection_projects SET workspace_root='/changed' WHERE project_id='a'`,
        );
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(binding))._tag).toBe("Failure");
        expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
      }),
    ),
);

const seedHistory = Effect.fn("humanBindingTest.seedHistory")(function* (sql: SqlClient.SqlClient) {
  yield* Effect.gen(function* () {
    const repo = yield* ProjectWorkRepository;
    const projectId = ProjectId.make("a"),
      taskId = ProjectWorkTaskId.make("local-investigation");
    const created = yield* repo.execute({
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("history-task"),
      title: "Local investigation",
      createdAt: at,
    });
    const issue = yield* decodeIntake({
      kind: "issue",
      recordId: "old-issue",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      observedAt: at,
      sourceRevision: at,
      status: "open",
      identity: {
        host: "github.com",
        repositoryNodeId: "R_old",
        issueNodeId: "I_history",
        number: 1,
      },
      repositoryName: "owner/old",
      title: "Original issue",
      body: "Original source",
      taskId,
    });
    const imported = yield* repo.execute({
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("history-issue"),
      expectedRevision: created.revision,
      attribution: {
        actor: { kind: "system", id: "intake" },
        source: { kind: "import", id: "intake" },
        recordedAt: at,
      },
      records: [issue],
      committedAt: at,
    });
    yield* repo.execute({
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("history-investigate"),
      expectedRevision: imported.revision,
      attribution: {
        actor: { kind: "human", id: "trusted-test-human" },
        source: { kind: "web", id: "test-client" },
        recordedAt: at,
      },
      records: [],
      committedAt: at,
      guided: {
        intent: {
          type: "project-team.investigation.start",
          projectId,
          taskId,
          commandId: CommandId.make("history-investigate"),
          expectedRevision: imported.revision,
          expectedTaskRevision: imported.state.tasks.find((task) => task.taskId === taskId)!
            .revision,
          objective: "Find the cause",
          outputDescriptions: ["Retained sourced findings"],
          issueRecordId: issue.recordId,
          expectedIssueRevision: issue.revision,
        },
      },
    });
  }).pipe(Effect.provide(ProjectWorkRepositoryLive));
  const state = yield* readCurrentState(sql, "a");
  expect(
    state.foundationRecords?.some(
      (record) => record.kind === "gate" && record.gate === "investigation",
    ),
  ).toBe(true);
});
const oldKey = { host: "github.com", repositoryNodeId: "R_old" };
const seedAuthorization = Effect.fn("humanBindingTest.seedAuthorization")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES('human-binding','test-human',${json([AuthOrchestrationOperateScope])},'pairing-code',${at},'2026-10-02T00:00:00Z')`;
  let checks = 0;
  const check = Effect.gen(function* () {
    checks++;
    expect(Option.isSome(yield* Effect.serviceOption(sql.transactionService))).toBe(true);
    const rows = yield* sql`SELECT revoked_at FROM auth_sessions WHERE session_id='human-binding'`;
    if (rows.length !== 1 || rows[0]?.revoked_at !== null)
      return yield* new Human.IssueHumanBindingError({ reason: "human-required" });
  }).pipe(Effect.mapError(() => new Human.IssueHumanBindingError({ reason: "human-required" })));
  return { check, checks: () => checks };
});
for (const authorization of [
  "healthy",
  "preflight-revoked",
  "during-remote",
  "after-helper",
] as const)
  it.effect(`rechecks durable human authorization atomically (${authorization})`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(oldKey);
        yield* seedHistory(f.sql);
        const leased = (yield* claimIssueRepositoryRead(f.sql, oldKey, {
          leaseId: "authorization-read",
          durationMs: 1000,
          sweepStartedAt: at,
        }))!;
        const history = yield* readCurrentState(f.sql, "a");
        const events = yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`;
        const bindings =
          yield* f.sql`SELECT * FROM project_issue_binding ORDER BY repository_node_id`;
        const auth = yield* seedAuthorization(f.sql);
        if (authorization === "preflight-revoked")
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id='human-binding'`;
        if (authorization === "after-helper")
          yield* f.sql`CREATE TRIGGER revoke_human_on_binding AFTER INSERT ON project_issue_binding WHEN NEW.repository_node_id='R_target' BEGIN UPDATE auth_sessions SET revoked_at='2026-10-01T00:00:00Z' WHERE session_id='human-binding'; END`;
        const intent = { ...input, previous: { key: oldKey, expectedBindingRevision: 0 } };
        const result = yield* Effect.gen(function* () {
          if (authorization !== "during-remote")
            return yield* f.service.bind(intent, auth.check).pipe(Effect.result);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const pending = yield* f.service
            .bind(intent, auth.check)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* f.sql`UPDATE auth_sessions SET revoked_at=${at} WHERE session_id='human-binding'`;
          yield* Deferred.succeed(release, undefined);
          return yield* Fiber.join(pending);
        });
        if (authorization === "healthy") {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success).toEqual({ ...key, bindingRevision: 0, status: "ready" });
          expect((yield* readIssueRepositoryState(f.sql, oldKey))?.lease).toBeNull();
          expect(
            yield* recordIssueRepositoryReadFailure(f.sql, oldKey, leased.lease!, {
              error: "transport",
              retryAt: 1790812800000,
            }),
          ).toBe(false);
        } else {
          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "human-required" } });
          expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
          expect(yield* readIssueRepositoryState(f.sql, oldKey)).toEqual(leased);
          expect(
            yield* f.sql`SELECT * FROM project_issue_binding ORDER BY repository_node_id`,
          ).toEqual(bindings);
        }
        expect(auth.checks()).toBe(
          authorization === "preflight-revoked" ? 1 : authorization === "during-remote" ? 2 : 3,
        );
        if (authorization === "preflight-revoked") expect(f.calls).toHaveLength(0);
        expect(
          yield* f.sql`SELECT revoked_at FROM auth_sessions WHERE session_id='human-binding'`,
        ).toEqual([
          {
            revoked_at:
              authorization === "preflight-revoked" || authorization === "during-remote"
                ? at
                : null,
          },
        ]);
        expect(yield* readCurrentState(f.sql, "a")).toEqual(history);
        expect(yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(events);
      }),
    ),
  );
for (const size of [1024, 1100, 4096, 4097])
  it.effect(`validates the canonical workspace boundary (${size})`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const workspace = `/${`${"a".repeat(200)}/`.repeat(Math.ceil(size / 201))}`.slice(0, size);
        f.state.root = workspace;
        yield* f.sql`UPDATE projection_projects SET workspace_root=${workspace} WHERE project_id='a'`;
        yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','active',${workspace},0,${at})`;
        yield* seedHistory(f.sql);
        const history = yield* readCurrentState(f.sql, "a");
        const events = yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`;
        if (size > 4096) {
          expect((yield* f.service.bind(input).pipe(Effect.flip)).reason).toBe("invalid-storage");
          expect(f.calls).toHaveLength(0);
          expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
        } else {
          expect(yield* f.service.bind(input)).toEqual({
            ...key,
            bindingRevision: 0,
            status: "ready",
          });
          expect(
            f.calls.some((call) => call.command === "git" && call.args.includes(workspace)),
          ).toBe(true);
          expect(
            f.calls.filter((call) => call.command === "gh").every((call) => call.cwd === workspace),
          ).toBe(true);
        }
        expect(yield* readCurrentState(f.sql, "a")).toEqual(history);
        expect(yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(events);
      }),
    ),
  );
for (const capacity of ["31-new", "32-new", "32-rebind", "32-reactivate"] as const)
  it.effect(`retains binding history at the capacity boundary (${capacity})`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const existingTarget = capacity === "32-rebind" || capacity === "32-reactivate";
        const count = capacity === "31-new" ? 31 : 32;
        yield* f.seed(oldKey);
        for (let index = 1; index < count - (existingTarget ? 1 : 0); index++)
          yield* f.seed({ host: key.host, repositoryNodeId: `R_history_${index}` });
        if (existingTarget) yield* f.seed();
        yield* f.sql`UPDATE project_issue_binding SET status='detached' WHERE project_id='a'`;
        yield* seedHistory(f.sql);
        const history = yield* readCurrentState(f.sql, "a");
        const events = yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`;
        const before =
          yield* f.sql`SELECT repository_node_id FROM project_issue_binding WHERE project_id='a' ORDER BY repository_node_id`;
        expect(before).toHaveLength(count);
        const intent = {
          ...input,
          expectedTargetBindingRevision: existingTarget ? 0 : null,
          previous: {
            key: capacity === "32-reactivate" ? key : oldKey,
            expectedBindingRevision: 0,
          },
        };
        if (capacity === "32-new") {
          expect((yield* f.service.bind(intent).pipe(Effect.flip)).reason).toBe("binding-limit");
          expect(f.calls).toHaveLength(0);
        } else {
          expect((yield* f.service.bind(intent)).bindingRevision).toBe(existingTarget ? 1 : 0);
        }
        const after =
          yield* f.sql`SELECT repository_node_id FROM project_issue_binding WHERE project_id='a' ORDER BY repository_node_id`;
        expect(after).toHaveLength(32);
        for (const retained of before) expect(after).toContainEqual(retained);
        expect(yield* readCurrentState(f.sql, "a")).toEqual(history);
        expect(yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(events);
      }),
    ),
  );
for (const status of ["active", "detached"] as const)
  it.effect(`explicitly rebinds an exact-revision ${status} source and preserves old history`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(oldKey);
        yield* f.sql`INSERT INTO project_issue_external VALUES('github.com','R_old','I_history',1,${at},'{}')`;
        yield* seedHistory(f.sql);
        const history = yield* readCurrentState(f.sql, "a");
        const events = yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`;
        const lease = (yield* claimIssueRepositoryRead(f.sql, oldKey, {
          leaseId: "old-read",
          durationMs: 1000,
          sweepStartedAt: at,
        }))!.lease!;
        if (status === "detached")
          yield* f.sql`UPDATE project_issue_binding SET status='detached' WHERE project_id='a'`;
        expect(
          yield* f.service.bind({
            ...input,
            previous: { key: oldKey, expectedBindingRevision: 0 },
          }),
        ).toEqual({ ...key, bindingRevision: 0, status: "ready" });
        expect((yield* readIssueRepositoryState(f.sql, oldKey))?.status).toBe("detached");
        expect(
          yield* recordIssueRepositoryReadFailure(f.sql, oldKey, lease, {
            error: "transport",
            retryAt: 1790812800000,
          }),
        ).toBe(false);
        expect(yield* f.sql`SELECT issue_node_id FROM project_issue_external`).toEqual([
          { issue_node_id: "I_history" },
        ]);
        expect(yield* readCurrentState(f.sql, "a")).toEqual(history);
        expect(yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(events);
        expect(
          yield* f.sql`SELECT status,revision,generation FROM project_issue_binding WHERE repository_node_id='R_old'`,
        ).toEqual([{ status: "detached", revision: 1, generation: 1 }]);
      }),
    ),
  );
it.effect("keeps a healthy shared old repository available to its surviving owner", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(oldKey);
      yield* f.seed(oldKey, "b");
      const previous = (yield* claimIssueRepositoryRead(f.sql, oldKey, {
        leaseId: "shared",
        durationMs: 1000,
        sweepStartedAt: at,
      }))!;
      yield* f.service.bind({ ...input, previous: { key: oldKey, expectedBindingRevision: 0 } });
      expect(yield* readIssueRepositoryState(f.sql, oldKey)).toMatchObject({
        status: "ready",
        accountNodeId: "U_alice",
        lease: null,
        since: previous.since,
        revision: previous.revision + 1,
      });
      expect(
        yield* f.sql`SELECT project_id,status,revision FROM project_issue_binding WHERE repository_node_id='R_old' ORDER BY project_id`,
      ).toEqual([
        { project_id: "a", status: "detached", revision: 1 },
        { project_id: "b", status: "active", revision: 0 },
      ]);
    }),
  ),
);
it.effect(
  "reactivates an exact historical same-key binding and rejects stale duplicate intent",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed();
        yield* f.sql`UPDATE project_issue_binding SET status='detached' WHERE project_id='a'`;
        const explicit = {
          ...input,
          expectedTargetBindingRevision: 0,
          previous: { key, expectedBindingRevision: 0 },
        };
        expect((yield* f.service.bind(explicit)).bindingRevision).toBe(1);
        const calls = f.calls.length;
        expect((yield* f.service.bind(explicit).pipe(Effect.flip)).reason).toBe("stale-state");
        expect(f.calls).toHaveLength(calls);
        expect(yield* f.sql`SELECT status,revision FROM project_issue_binding`).toEqual([
          { status: "active", revision: 1 },
        ]);
      }),
    ),
);
it.effect("accepts a verified rename of the same stable repository node", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = yield* f.seed();
      f.state.name = "renamed/target";
      yield* f.service.bind({ ...input, expectedTargetBindingRevision: 0 });
      expect(yield* readIssueRepositoryState(f.sql, key)).toMatchObject({
        repositoryName: "renamed/target",
        since: original.state.since,
        authorityGeneration: original.state.authorityGeneration + 1,
      });
    }),
  ),
);
for (const mismatch of ["node", "login"] as const)
  it.effect(`never switches the existing verified target account (${mismatch})`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.seed();
        if (mismatch === "node") f.state.account = "U_bob";
        else f.state.login = "bob";
        expect(
          (yield* f.service.bind({ ...input, expectedTargetBindingRevision: 0 }).pipe(Effect.flip))
            .reason,
        ).toBe("account-mismatch");
        expect(yield* readIssueRepositoryState(f.sql, key)).toEqual(original.state);
        expect(f.calls.some((call) => call.args.at(-1)?.startsWith("repos/"))).toBe(false);
      }),
    ),
  );
it.effect("allows an explicitly verified different account on a different new repository", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(oldKey);
      f.state.account = "U_new";
      yield* f.service.bind({ ...input, previous: { key: oldKey, expectedBindingRevision: 0 } });
      expect((yield* readIssueRepositoryState(f.sql, key))?.accountNodeId).toBe("U_new");
      expect((yield* readIssueRepositoryState(f.sql, oldKey))?.accountNodeId).toBe("U_alice");
    }),
  ),
);
for (const mutation of [
  "archive",
  "delete",
  "lifecycle",
  "workspace",
  "updated-at",
  "state",
  "binding",
  "extra-active",
  "remote",
  "feature",
] as const)
  it.effect(`fences ${mutation} changed while GitHub is awaited`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const pending = yield* f.service
          .bind({ ...input, expectedTargetBindingRevision: 0 })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        if (mutation === "archive" || mutation === "lifecycle")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a',${mutation === "archive" ? "archived" : "active"},'/repo',1,${at})`;
        if (mutation === "delete")
          yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id='a'`;
        if (mutation === "workspace")
          yield* f.sql`UPDATE projection_projects SET workspace_root='/moved' WHERE project_id='a'`;
        if (mutation === "updated-at")
          yield* f.sql`UPDATE projection_projects SET updated_at='2026-10-02T00:00:00Z' WHERE project_id='a'`;
        if (mutation === "state") {
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          yield* f.sql`UPDATE project_issue_repository SET payload_json=${json({ ...state, revision: state.revision + 1 })}`;
        }
        if (mutation === "binding")
          yield* f.sql`UPDATE project_issue_binding SET generation=generation+1 WHERE project_id='a'`;
        if (mutation === "extra-active") yield* f.seed(oldKey);
        if (mutation === "remote")
          f.state.remote = "upstream https://github.com/other/repo.git (fetch)\n";
        if (mutation === "feature") yield* f.settings.updateSettings({ projectWorkEnabled: false });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        expect((yield* readIssueRepositoryState(f.sql, key))?.credentialEpoch).toBe("old-epoch");
      }),
    ),
  );
it.effect("two concurrent first binds produce one revision and one stale denial", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let count = 0;
      f.state.onRepository = Effect.gen(function* () {
        if (++count === 2) yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      });
      const first = yield* f.service.bind(input).pipe(Effect.result, Effect.forkChild);
      const second = yield* f.service.bind(input).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
      expect(yield* f.sql`SELECT revision,generation FROM project_issue_binding`).toEqual([
        { revision: 0, generation: 0 },
      ]);
    }),
  ),
);
it.effect(
  "denies inherited transactions at construction and on a retained callable before any remote read",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        expect((yield* f.sql.withTransaction(f.create).pipe(Effect.flip)).reason).toBe(
          "invalid-input",
        );
        expect((yield* f.sql.withTransaction(f.service.bind(input)).pipe(Effect.flip)).reason).toBe(
          "invalid-input",
        );
        expect(f.calls).toHaveLength(0);
      }),
    ),
);
it.effect("stop cancels and joins an in-flight GitHub read and denies retained binds", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const pending = yield* f.service.bind(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.service.stop;
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      const calls = f.calls.length;
      expect((yield* f.service.bind(input).pipe(Effect.flip)).reason).toBe("stopped");
      expect(f.calls).toHaveLength(calls);
      expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
    }),
  ),
);
it.effect("scope close cancels reads and fences retained service writes", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const scope = yield* Scope.make();
      const service = yield* f.create.pipe(Effect.provideService(Scope.Scope, scope));
      const entered = yield* Deferred.make<void>();
      f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const pending = yield* service.bind(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      expect((yield* service.bind(input).pipe(Effect.flip)).reason).toBe("stopped");
      expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
    }),
  ),
);
it.effect("the actual operation deadline cancels a remote read with no target installation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      f.state.onRepository = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const pending = yield* f.service.bind(input).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("55 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "deadline" },
      });
      expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
    }),
  ),
);

it.effect(
  "recovers an authentication error with the same freshly verified token and a fresh opaque epoch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.service.bind(input);
        const original = (yield* readIssueRepositoryState(f.sql, key))!;
        const lease = (yield* claimIssueRepositoryRead(f.sql, key, {
          leaseId: "auth-failed",
          durationMs: 1000,
          sweepStartedAt: at,
        }))!.lease!;
        yield* recordIssueRepositoryReadFailure(f.sql, key, lease, {
          error: "authentication",
          retryAt: 1790812800000,
        });
        const receipt = yield* f.service.bind({ ...input, expectedTargetBindingRevision: 0 });
        expect(receipt.bindingRevision).toBe(1);
        const recovered = (yield* readIssueRepositoryState(f.sql, key))!;
        expect(recovered).toMatchObject({
          status: "ready",
          error: null,
          accountNodeId: original.accountNodeId,
          retryAt: 0,
        });
        expect(recovered.credentialEpoch).not.toBe(original.credentialEpoch);
        expect(json(receipt)).not.toContain(recovered.credentialEpoch);
        expect(json(receipt)).not.toContain("synthetic-token");
      }),
    ),
);
for (const exhausted of [
  "binding-revision",
  "binding-generation",
  "state-revision",
  "authority-generation",
] as const)
  it.effect(`denies exhausted ${exhausted} before remote verification`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed();
        if (exhausted === "binding-revision")
          yield* f.sql`UPDATE project_issue_binding SET revision=${Number.MAX_SAFE_INTEGER}`;
        if (exhausted === "binding-generation")
          yield* f.sql`UPDATE project_issue_binding SET generation=${Number.MAX_SAFE_INTEGER}`;
        if (exhausted === "state-revision" || exhausted === "authority-generation") {
          const state = (yield* readIssueRepositoryState(f.sql, key))!;
          yield* f.sql`UPDATE project_issue_repository SET payload_json=${json({ ...state, [exhausted === "state-revision" ? "revision" : "authorityGeneration"]: Number.MAX_SAFE_INTEGER })}`;
        }
        expect(
          (yield* f.service
            .bind({
              ...input,
              expectedTargetBindingRevision:
                exhausted === "binding-revision" ? Number.MAX_SAFE_INTEGER : 0,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("counter-exhausted");
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );
for (const invalid of ["broken-json", "oversized-state", "bad-generation"] as const)
  it.effect(`denies ${invalid} persisted authority before remote reads`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed();
        if (invalid === "bad-generation")
          yield* f.sql`UPDATE project_issue_binding SET generation=0.5`;
        else
          yield* f.sql`UPDATE project_issue_repository SET payload_json=${invalid === "broken-json" ? "{" : "x".repeat(262145)}`;
        expect(
          (yield* f.service.bind({ ...input, expectedTargetBindingRevision: 0 }).pipe(Effect.flip))
            .reason,
        ).toBe("invalid-storage");
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );
it.effect("refuses an omitted previous key even when the old history is detached", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(oldKey);
      yield* f.sql`UPDATE project_issue_binding SET status='detached'`;
      expect((yield* f.service.bind(input).pipe(Effect.flip)).reason).toBe("human-required");
      expect(f.calls).toHaveLength(0);
    }),
  ),
);
it.effect("refuses multiple active bindings even when both keys were supplied", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(oldKey);
      yield* f.seed();
      expect(
        (yield* f.service
          .bind({
            ...input,
            expectedTargetBindingRevision: 0,
            previous: { key: oldKey, expectedBindingRevision: 0 },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("human-required");
      expect(f.calls).toHaveLength(0);
    }),
  ),
);
it.effect("bounds admitted work to 32 in-flight operations and joins all on stop", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      let count = 0;
      f.state.onGit = Effect.gen(function* () {
        if (++count === 32) yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      });
      const pending: Array<
        Fiber.Fiber<Human.HumanRepositoryBindingReceipt, Human.IssueHumanBindingError>
      > = [];
      for (let index = 0; index < 32; index++)
        pending.push(yield* f.service.bind(input).pipe(Effect.forkChild));
      yield* Deferred.await(entered);
      const calls = f.calls.length;
      expect((yield* f.service.bind(input).pipe(Effect.flip)).reason).toBe("busy");
      expect(f.calls).toHaveLength(calls);
      yield* f.service.stop;
      for (const fiber of pending) expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
      expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
    }),
  ),
);
for (const response of [
  "HTTP/2.0 401 Unauthorized\nContent-Type: application/json\r\n\r\n{}",
  "HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n{}",
  "HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\nmalformed-secret",
])
  it.effect("sanitizes failed remote verification without partial binding", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.state.repositoryResponse = response;
        const error = yield* f.service.bind(input).pipe(Effect.flip);
        expect(error.reason).toBe("github");
        expect(json(error)).not.toContain("malformed-secret");
        expect(json(error)).not.toContain("synthetic-token");
        expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
      }),
    ),
  );
