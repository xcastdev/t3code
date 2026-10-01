import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProjectTeamCredential,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { authIdentityForSession, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as Rates from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Gateway from "./ProjectIssueBindingGateway.ts";
import * as Snapshot from "./ProjectIssueCredentialSnapshot.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  coreLayer,
  makeProjectIssueRuntime,
  ProjectIssueRuntime,
  type ProjectIssueRuntimeState,
} from "./ProjectWorkRuntime.ts";
import * as Client from "./github/GitHubIssueClient.ts";

const at = "2026-10-01T00:00:00Z";
const key = { host: "github.com", repositoryNodeId: "R_target" };
const projectId = ProjectId.make("a");
const input = {
  projectId,
  expectedRepositoryKey: key,
  expectedTargetBindingRevision: null,
  accountLogin: "alice",
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManagedCredential = Schema.decodeUnknownSync(ProjectTeamCredential);
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
const http = (body: unknown) =>
  `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${json(body)}`;
const fixture = Effect.fn("bindingGatewayTest.fixture")(function* (enabled = true) {
  yield* TestClock.setTime(Date.parse(at));
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.make;
  const session: AuthenticatedSession = {
    sessionId: AuthSessionId.make("binding-human"),
    subject: "user:alice",
    method: "browser-session-cookie",
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    identity: authIdentityForSession({ subject: "user:alice" }),
  };
  yield* sessions.create({
    ...session,
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "desktop",
      os: null,
      browser: null,
    },
    issuedAt: DateTime.makeUnsafe(at),
    expiresAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
  });
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const control = { boundary: Effect.void as Effect.Effect<void> };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("bindingGatewayTest.process")(function* (request) {
      expect(Option.isNone(yield* Effect.serviceOption(sql.transactionService))).toBe(true);
      calls.push(request);
      if (request.command === "git")
        return output(
          request.args.includes("--show-toplevel")
            ? "/repo\n"
            : "upstream https://github.com/owner/target.git (fetch)\n",
        );
      if (request.args[0] === "auth")
        return output(
          request.args[1] === "token"
            ? "synthetic-token\n"
            : json({
                hosts: {
                  "github.com": [
                    { host: "github.com", login: "alice", active: true, state: "success" },
                  ],
                },
              }),
        );
      if (request.args.at(-1) === "user") {
        const user = { node_id: "U_alice", login: "alice" };
        return output(request.args.includes("--include") ? http(user) : json(user));
      }
      if (request.args.at(-1)?.includes("/issues?")) return output(http([]));
      yield* control.boundary;
      return output(
        http({
          id: 1,
          node_id: key.repositoryNodeId,
          full_name: "owner/target",
          url: "https://api.github.com/repos/owner/target",
          html_url: "https://github.com/owner/target",
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
  const rates = yield* Rates.make;
  const client = yield* Client.make.pipe(
    Effect.provideService(GitHubCli.GitHubCli, gh),
    Effect.provideService(Rates.SourceControlRateLimit, rates),
  );
  const state = yield* Ref.make({ ...DEFAULT_SERVER_SETTINGS, projectWorkEnabled: false });
  const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const settingsBoundary = { boundary: Effect.void as Effect.Effect<void> };
  const settings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(state).pipe(Effect.tap(() => settingsBoundary.boundary)),
    updateSettings: (patch) =>
      Ref.updateAndGet(state, (previous) => ({
        ...previous,
        projectWorkEnabled: patch.projectWorkEnabled ?? previous.projectWorkEnabled,
      })).pipe(Effect.tap((value) => PubSub.publish(changes, value))),
    streamChanges: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  });
  const states = yield* Queue.unbounded<ProjectIssueRuntimeState>();
  const runtimeScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
  const runtime = yield* makeProjectIssueRuntime((value) =>
    Queue.offer(states, value).pipe(Effect.asVoid),
  ).pipe(
    Effect.provideService(Identity.RepositoryIdentityResolver, identities),
    Effect.provideService(Snapshot.ProjectIssueCredentialSnapshot, snapshot),
    Effect.provideService(Client.GitHubIssueClient, client),
    Effect.provideService(ServerSettingsService, settings),
    Effect.provideService(Scope.Scope, runtimeScope),
  );
  expect(yield* Queue.take(states)).toBe("disabled");
  if (enabled) {
    yield* settings.updateSettings({ projectWorkEnabled: true });
    expect(yield* Queue.take(states)).toBe("ready");
    // Drain startup while there are no projects, before installing explicit human intent.
    expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
  }
  for (const id of ["a", "b"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},'Test','/repo','[]',${at},${at})`;
  const gateway = yield* Gateway.make.pipe(Effect.provideService(ProjectIssueRuntime, runtime));
  const authorize = yield* Gateway.makeBindingSessionAuthorization;
  const seed = (repositoryKey = key, owner = "a") =>
    bindIssueRepositoryProject(sql, {
      key: repositoryKey,
      projectId: owner,
      repositoryName: "owner/old",
      accountNodeId: "U_alice",
      accountLogin: "alice",
      credentialEpoch: "secret-epoch",
      since: at,
      expectedBindingRevision: null,
    });
  return {
    sql,
    sessions,
    session,
    calls,
    control,
    runtime,
    runtimeScope,
    gateway,
    authorize,
    settings,
    settingsBoundary,
    states,
    seed,
  };
});
const run = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient | ProjectWorkRepository>,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        coreLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
        NodeServices.layer,
      ),
    ),
  );

it.effect(
  "binds through the actual runtime and lists a safe durable receipt without dispatch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const receipt = yield* f.gateway.bind(input, f.session);
        expect(receipt).toEqual({ ...key, bindingRevision: 0, status: "ready" });
        expect(yield* f.gateway.list({ projectId }, f.session)).toEqual({
          items: [
            {
              ...key,
              bindingRevision: 0,
              status: "active",
              repositoryName: "owner/target",
              accountLogin: "alice",
            },
          ],
        });
        const stored = (yield* readIssueRepositoryState(f.sql, key))!;
        expect(json(receipt)).not.toContain(stored.credentialEpoch);
        expect(json(receipt)).not.toContain("synthetic-token");
        expect(f.calls.some((call) => call.args.at(-1) === "repos/owner/target")).toBe(true);
        yield* f.runtime.stop;
        expect(yield* f.sql`SELECT * FROM project_team_run_binding`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
      }),
    ),
);

for (const mutation of [
  "revoked",
  "expired",
  "scope",
  "subject",
  "method",
  "principal",
  "deleted",
  "corrupt",
] as const)
  it.effect(`denies durable ${mutation} before any Git or GitHub read`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        if (mutation === "revoked")
          yield* f.sessions.revoke({
            sessionId: f.session.sessionId,
            revokedAt: DateTime.makeUnsafe(at),
          });
        if (mutation === "expired") yield* f.sql`UPDATE auth_sessions SET expires_at=${at}`;
        if (mutation === "scope")
          yield* f.sql`UPDATE auth_sessions SET scopes=${json([AuthOrchestrationReadScope])}`;
        if (mutation === "subject") yield* f.sql`UPDATE auth_sessions SET subject='user:other'`;
        if (mutation === "method")
          yield* f.sql`UPDATE auth_sessions SET method='bearer-access-token'`;
        if (mutation === "principal")
          yield* f.sql`UPDATE auth_sessions SET client_device_type='bot',subject='alice'`;
        if (mutation === "deleted") yield* f.sql`DELETE FROM auth_sessions`;
        if (mutation === "corrupt") yield* f.sql`UPDATE auth_sessions SET scopes='{'`;
        const captured = mutation === "principal" ? { ...f.session, subject: "alice" } : f.session;
        expect((yield* f.gateway.bind(input, captured).pipe(Effect.flip)).reason).toBe(
          "human-required",
        );
        expect(f.calls).toHaveLength(0);
        expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
      }),
    ),
  );

for (const kind of ["unmanaged", "managed", "managed-with-user-principal", "forged-user"] as const)
  it.effect(`denies ${kind} agents with broad scopes for binding and inspection`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const managed = decodeManagedCredential({
          projectId: "a",
          bindingId: "unissued",
          generation: 0,
          providerInstanceId: "pi",
          threadId: "unissued",
        });
        const subject =
          kind === "managed"
            ? `agent:project-team:${Buffer.from(json(managed)).toString("base64url")}`
            : kind === "managed-with-user-principal"
              ? f.session.subject
              : "agent:worker";
        yield* f.sql`UPDATE auth_sessions SET subject=${subject}`;
        const agent: AuthenticatedSession = {
          ...f.session,
          subject,
          identity:
            kind === "forged-user" || kind === "managed-with-user-principal"
              ? f.session.identity
              : authIdentityForSession({ subject }),
          ...(kind === "managed" || kind === "managed-with-user-principal" ? { managed } : {}),
        };
        expect((yield* f.gateway.bind(input, agent).pipe(Effect.flip)).reason).toBe(
          "human-required",
        );
        expect((yield* f.gateway.list({ projectId }, agent).pipe(Effect.flip)).reason).toBe(
          "human-required",
        );
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );

it.effect("requires its own live SQL transaction and compares the captured principal", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        (yield* f.authorize(f.session, AuthOrchestrationOperateScope).pipe(Effect.flip)).reason,
      ).toBe("human-required");
      yield* f.sql.withTransaction(f.authorize(f.session, AuthOrchestrationOperateScope));
      expect(
        (yield* Effect.gen(function* () {
          const other = yield* SqlClient.SqlClient;
          return yield* other
            .withTransaction(f.authorize(f.session, AuthOrchestrationOperateScope))
            .pipe(Effect.flip);
        }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layerMemory())))).reason,
      ).toBe("human-required");
      expect(
        (yield* f.sql
          .withTransaction(
            f.authorize(
              { ...f.session, identity: { kind: "user", id: "user:other" } },
              AuthOrchestrationOperateScope,
            ),
          )
          .pipe(Effect.flip)).reason,
      ).toBe("human-required");
      expect(
        (yield* f.sql.withTransaction(f.gateway.bind(input, f.session)).pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      expect(f.calls).toHaveLength(0);
    }),
  ),
);

for (const mutation of ["revoked", "expired", "scope"] as const)
  it.effect(
    `rolls back binding when the durable session becomes ${mutation} during a held remote read`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          if (mutation === "expired")
            yield* f.sql`UPDATE auth_sessions SET expires_at='2026-10-01T00:00:01Z'`;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.control.boundary = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const pending = yield* f.gateway
            .bind(input, f.session)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* f.sql.withTransaction(
            Effect.gen(function* () {
              if (mutation === "revoked")
                yield* f.sessions.revoke({
                  sessionId: f.session.sessionId,
                  revokedAt: DateTime.makeUnsafe(at),
                });
              if (mutation === "expired") yield* TestClock.adjust("1 second");
              if (mutation === "scope")
                yield* f.sql`UPDATE auth_sessions SET scopes=${json([AuthOrchestrationReadScope])}`;
            }),
          );
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(pending)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "human-required" },
          });
          expect(yield* f.sql`SELECT * FROM project_issue_binding`).toEqual([]);
          expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
        }),
      ),
  );

it.effect(
  "rechecks durable authorization after the final SQL mutation and rolls trigger changes back",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.sql`CREATE TRIGGER revoke_binding_human AFTER INSERT ON project_issue_binding BEGIN UPDATE auth_sessions SET revoked_at='2026-10-01T00:00:00Z' WHERE session_id='binding-human'; END`;
        expect((yield* f.gateway.bind(input, f.session).pipe(Effect.flip)).reason).toBe(
          "human-required",
        );
        expect(yield* f.sql`SELECT * FROM project_issue_binding`).toEqual([]);
        expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
        expect(yield* f.sql`SELECT revoked_at FROM auth_sessions`).toEqual([{ revoked_at: null }]);
      }),
    ),
);

it.effect(
  "inspection uses read scope, includes detached history, and preserves local work on an archived project",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        yield* f.seed();
        const old = { host: key.host, repositoryNodeId: "R_old" };
        yield* f.seed(old);
        yield* f.seed({ host: key.host, repositoryNodeId: "R_other" }, "b");
        yield* f.sql`UPDATE project_issue_binding SET status='detached',revision=7 WHERE repository_node_id='R_old'`;
        yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','archived','/repo',1,${at})`;
        const repository = yield* ProjectWorkRepository;
        yield* repository.execute({
          type: "project-work.task.create",
          projectId,
          taskId: ProjectWorkTaskId.make("retained-history"),
          commandId: CommandId.make("create-history"),
          title: "Retained investigation",
          createdAt: at,
        });
        const before = yield* readCurrentState(f.sql, "a");
        const events = yield* f.sql`SELECT * FROM project_work_events`;
        yield* f.sql`UPDATE auth_sessions SET scopes=${json([AuthOrchestrationReadScope])}`;
        const reader = { ...f.session, scopes: [AuthOrchestrationReadScope] };
        expect(yield* f.gateway.list({ projectId }, reader)).toEqual({
          items: [
            {
              ...old,
              bindingRevision: 7,
              status: "detached",
              repositoryName: "owner/old",
              accountLogin: "alice",
            },
            {
              ...key,
              bindingRevision: 0,
              status: "active",
              repositoryName: "owner/old",
              accountLogin: "alice",
            },
          ],
        });
        expect((yield* f.gateway.bind(input, reader).pipe(Effect.flip)).reason).toBe(
          "human-required",
        );
        expect(yield* readCurrentState(f.sql, "a")).toEqual(before);
        expect(yield* f.sql`SELECT * FROM project_work_events`).toEqual(events);
        expect(f.calls).toHaveLength(0);
      }),
    ),
);

for (const lifecycle of ["missing", "deleted", "tombstoned"] as const)
  it.effect(`denies inspection of ${lifecycle} projects`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        if (lifecycle === "missing")
          yield* f.sql`DELETE FROM projection_projects WHERE project_id='a'`;
        if (lifecycle === "deleted")
          yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id='a'`;
        if (lifecycle === "tombstoned")
          yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,revision,changed_at) VALUES('a','tombstoned','/repo',1,${at})`;
        expect((yield* f.gateway.list({ projectId }, f.session).pipe(Effect.flip)).reason).toBe(
          "inactive-project",
        );
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );

it.effect(
  "returns at most 32 own-project bindings and rejects persisted overflow without truncation",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        for (let index = 0; index < 32; index++)
          yield* f.seed({
            host: key.host,
            repositoryNodeId: `R_${String(index).padStart(2, "0")}`,
          });
        yield* f.seed({ host: key.host, repositoryNodeId: "R_foreign" }, "b");
        const listed = yield* f.gateway.list({ projectId }, f.session);
        expect(listed.items).toHaveLength(32);
        expect(listed.items.map((item) => item.repositoryNodeId)).toEqual(
          Array.from({ length: 32 }, (_, index) => `R_${String(index).padStart(2, "0")}`),
        );
        expect(json(listed)).not.toContain("secret-epoch");
        expect(json(listed)).not.toContain("U_alice");
        yield* f.seed({ host: key.host, repositoryNodeId: "R_overflow" });
        expect((yield* f.gateway.list({ projectId }, f.session).pipe(Effect.flip)).reason).toBe(
          "invalid-storage",
        );
        expect(f.calls).toHaveLength(0);
      }),
    ),
);

it.effect("lists legacy empty repository names without inventing a current canonical name", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* f.seed();
      const stored = (yield* readIssueRepositoryState(f.sql, key))!;
      yield* f.sql`UPDATE project_issue_repository SET payload_json=${json({ ...stored, repositoryName: "" })}`;
      expect((yield* f.gateway.list({ projectId }, f.session)).items[0]?.repositoryName).toBe("");
      expect(f.calls).toHaveLength(0);
    }),
  ),
);

for (const invalid of ["corrupt", "oversized", "account"] as const)
  it.effect(
    `rejects ${invalid} repository payloads without returning partial binding history`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(false);
          yield* f.seed();
          if (invalid === "corrupt")
            yield* f.sql`UPDATE project_issue_repository SET payload_json='{'`;
          if (invalid === "oversized")
            yield* f.sql`UPDATE project_issue_repository SET payload_json=${"x".repeat(262145)}`;
          if (invalid === "account")
            yield* f.sql`UPDATE project_issue_binding SET account_node_id='U_other'`;
          expect((yield* f.gateway.list({ projectId }, f.session).pipe(Effect.flip)).reason).toBe(
            "invalid-storage",
          );
          expect(f.calls).toHaveLength(0);
        }),
      ),
  );

for (const shutdown of ["disable", "stop", "scope"] as const)
  it.effect(
    `${shutdown} cancels and joins a binding read and fences captured gateway handles`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const entered = yield* Deferred.make<void>();
          const joined = yield* Deferred.make<void>();
          f.control.boundary = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(joined, undefined)),
          );
          const pending = yield* f.gateway.bind(input, f.session).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          if (shutdown === "disable") {
            yield* f.settings.updateSettings({ projectWorkEnabled: false });
            expect(yield* Queue.take(f.states)).toBe("disabled");
          } else if (shutdown === "stop") yield* f.runtime.stop;
          else yield* Scope.close(f.runtimeScope, Exit.void);
          expect(yield* Deferred.isDone(joined)).toBe(true);
          expect((yield* Fiber.await(pending))._tag).toBe("Failure");
          const calls = f.calls.length;
          expect((yield* f.gateway.bind(input, f.session).pipe(Effect.flip)).reason).toBe(
            "feature-disabled",
          );
          expect(f.calls).toHaveLength(calls);
          expect(yield* readIssueRepositoryState(f.sql, key)).toBeUndefined();
          expect(yield* f.runtime.refresh).toEqual({ repositories: [], pages: [] });
        }),
      ),
  );

it.effect(
  "captured handles follow feature enable, disable and re-enable with no surviving setup",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        expect((yield* f.gateway.bind(input, f.session).pipe(Effect.flip)).reason).toBe(
          "feature-disabled",
        );
        expect(f.calls).toHaveLength(0);
        yield* f.sql`DELETE FROM projection_projects`;
        yield* f.settings.updateSettings({ projectWorkEnabled: true });
        expect(yield* Queue.take(f.states)).toBe("ready");
        yield* f.runtime.refresh;
        yield* f.settings.updateSettings({ projectWorkEnabled: false });
        expect(yield* Queue.take(f.states)).toBe("disabled");
        expect((yield* f.gateway.bind(input, f.session).pipe(Effect.flip)).reason).toBe(
          "feature-disabled",
        );
        expect(f.calls).toHaveLength(0);
        yield* f.settings.updateSettings({ projectWorkEnabled: true });
        expect(yield* Queue.take(f.states)).toBe("ready");
        yield* f.runtime.refresh;
        yield* f.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('a','Test','/repo','[]',${at},${at})`;
        expect(yield* f.gateway.bind(input, f.session)).toEqual({
          ...key,
          bindingRevision: 0,
          status: "ready",
        });
        yield* f.runtime.stop;
        expect(yield* Queue.take(f.states)).toBe("stopped");
        const calls = f.calls.length;
        expect((yield* f.gateway.bind(input, f.session).pipe(Effect.flip)).reason).toBe(
          "feature-disabled",
        );
        expect(f.calls).toHaveLength(calls);
      }),
    ),
);

it.effect("requires both captured and durable read scopes before exposing binding history", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* f.seed();
      expect(
        (yield* f.gateway
          .list({ projectId }, { ...f.session, scopes: [AuthOrchestrationOperateScope] })
          .pipe(Effect.flip)).reason,
      ).toBe("human-required");
      yield* f.sql`UPDATE auth_sessions SET scopes=${json([AuthOrchestrationOperateScope])}`;
      expect((yield* f.gateway.list({ projectId }, f.session).pipe(Effect.flip)).reason).toBe(
        "human-required",
      );
      expect(f.calls).toHaveLength(0);
    }),
  ),
);

for (const expires of [false, true])
  it.effect(`checks durable human authority after final settings receipt, expiry=${expires}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.sql`UPDATE auth_sessions SET expires_at='2026-10-01T00:00:01Z'`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.settingsBoundary.boundary = Effect.gen(function* () {
          if (Option.isNone(yield* Effect.serviceOption(f.sql.transactionService))) return;
          const rows =
            yield* f.sql`SELECT revision FROM project_issue_binding WHERE project_id='a'`;
          if (rows.length === 0) return;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }).pipe(Effect.orDie);
        const pending = yield* f.gateway
          .bind(input, f.session)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        if (expires) yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        const stored = yield* f.sql`SELECT project_id,status,revision FROM project_issue_binding`;
        if (expires) {
          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "human-required" } });
          expect(stored).toEqual([]);
          expect(yield* f.sql`SELECT repository_node_id FROM project_issue_repository`).toEqual([]);
          expect(yield* f.sql`SELECT event_id FROM project_work_events`).toEqual([]);
        } else {
          expect(result).toMatchObject({
            _tag: "Success",
            success: { ...key, bindingRevision: 0, status: "ready" },
          });
          expect(stored).toEqual([{ project_id: "a", status: "active", revision: 0 }]);
        }
      }),
    ),
  );
