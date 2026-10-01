import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProjectTeamCredential } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Query from "./ProjectWorkQuery.ts";
import * as Search from "./ProjectWorkSearch.ts";
import * as Briefing from "./ProjectWorkBriefing.ts";
import * as Narrative from "./ProjectWorkNarrative.ts";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import * as Comments from "./ProjectIssueComments.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as Rates from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Snapshot from "./ProjectIssueCredentialSnapshot.ts";
import * as Client from "./github/GitHubIssueClient.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import {
  coreLayer,
  makeProjectIssueRuntime,
  type ProjectIssueRuntimeState,
} from "./ProjectWorkRuntime.ts";

const at = "2026-10-01T00:00:00Z";
const decodeStoredRevision = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.Int })),
);
const decodeManagedCredential = Schema.decodeUnknownEffect(ProjectTeamCredential);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
const http = (value: unknown) =>
  `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${encode(value)}`;
const rawIssue = {
  node_id: "I_issue",
  number: 1,
  title: "Proof issue",
  body: "Source",
  state: "open",
  comments: 1,
  updated_at: at,
  closed_at: null,
  url: "https://api.github.com/repos/owner/repo/issues/1",
  html_url: "https://github.com/owner/repo/issues/1",
  repository_url: "https://api.github.com/repos/owner/repo",
};
const key = { host: "github.com", repositoryNodeId: "R_repo" };
const fixture = Effect.fn("issueRuntimeTest.fixture")(function* (enabled = true) {
  yield* TestClock.setTime(1790812800000);
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Runtime','/fixture/runtime','[]',${at},${at})`;
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  let withIssue = false;
  let boundary: ((input: ProcessRunner.ProcessRunInput) => Effect.Effect<void>) | undefined;
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("issueRuntimeTest.run")(function* (input) {
      expect(Option.isNone(yield* Effect.serviceOption(sql.transactionService))).toBe(true);
      calls.push(input);
      if (boundary !== undefined) yield* boundary(input);
      if (input.command === "git")
        return output(
          input.args.includes("remote")
            ? input.args[1] === "/fixture/unseen"
              ? "origin git@github.com:owner/other.git (fetch)\n"
              : "origin git@github.com:owner/repo.git (fetch)\n"
            : `${input.args[1]}\n`,
        );
      if (input.args[0] === "auth")
        return output(
          input.args[1] === "token"
            ? "synthetic-token\n"
            : encode({
                hosts: {
                  "github.com": [
                    { host: "github.com", login: "alice", active: true, state: "success" },
                  ],
                },
              }),
        );
      const endpoint = input.args.at(-1) ?? "";
      if (endpoint === "user")
        return output(
          input.args.includes("--include")
            ? http({ node_id: "U_user", login: "alice" })
            : encode({ node_id: "U_user", login: "alice" }),
        );
      if (endpoint.includes("/issues?")) return output(http(withIssue ? [rawIssue] : []));
      if (endpoint.includes("/issues/1/comments"))
        return output(
          http([
            {
              node_id: "IC_comment",
              body: "Reviewed comment",
              updated_at: at,
              html_url: rawIssue.html_url + "#issuecomment-1",
              issue_url: rawIssue.url,
            },
          ]),
        );
      if (endpoint.endsWith("/issues/1")) return output(http(rawIssue));
      return output(
        http({
          id: 1,
          node_id: endpoint === "repos/owner/other" ? "R_aaa" : "R_repo",
          full_name: endpoint === "repos/owner/other" ? "owner/other" : "owner/repo",
          url:
            endpoint === "repos/owner/other"
              ? "https://api.github.com/repos/owner/other"
              : "https://api.github.com/repos/owner/repo",
          html_url:
            endpoint === "repos/owner/other"
              ? "https://github.com/owner/other"
              : "https://github.com/owner/repo",
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
  const state = yield* Ref.make({ ...DEFAULT_SERVER_SETTINGS, projectWorkEnabled: enabled });
  const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const settings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(state),
    updateSettings: (patch) =>
      Ref.updateAndGet(state, (previous) => ({
        ...previous,
        projectWorkEnabled: patch.projectWorkEnabled ?? previous.projectWorkEnabled,
      })).pipe(Effect.tap((value) => PubSub.publish(changes, value))),
    streamChanges: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });
  const start = (
    onState: (value: ProjectIssueRuntimeState) => Effect.Effect<void> = () => Effect.void,
    currentSettings = settings,
  ) =>
    makeProjectIssueRuntime(onState).pipe(
      Effect.provideService(Identity.RepositoryIdentityResolver, identities),
      Effect.provideService(Snapshot.ProjectIssueCredentialSnapshot, snapshot),
      Effect.provideService(Client.GitHubIssueClient, client),
      Effect.provideService(ServerSettingsService, currentSettings),
    );
  const startGateway = (
    runtime: import("./ProjectWorkRuntime.ts").ProjectIssueRuntime["Service"],
  ) =>
    Effect.gen(function* () {
      const auth = Auth.layer.pipe(
        Layer.provide(Secrets.layer),
        Layer.provide(Environment.identityLayer),
        Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-issue-runtime-gateway-" })),
      );
      const dependencies = Layer.mergeAll(
        TeamAuthorization.layer,
        Query.ProjectWorkQueryLive,
        Search.ProjectWorkSearchLive,
        Narrative.ProjectWorkNarrativeLive,
        Briefing.ProjectWorkBriefingLive.pipe(Layer.provide(Query.ProjectWorkQueryLive)),
      );
      const context = yield* Layer.build(
        Gateway.ProjectWorkGatewayLive.pipe(
          Layer.provide(dependencies),
          Layer.provide(auth),
          Layer.provide(Layer.succeed(ServerSettingsService, settings)),
          Layer.provide(
            Layer.succeed(
              Comments.ProjectIssueComments,
              Comments.ProjectIssueComments.of({
                read: runtime.readComments,
                stop: runtime.stop,
              }),
            ),
          ),
        ),
      );
      return Context.get(context, Gateway.ProjectWorkGateway);
    });
  return {
    startGateway,
    enableIssue: () => {
      withIssue = true;
    },
    sql,
    calls,
    start,
    settings,
    setBoundary: (next: typeof boundary) => {
      boundary = next;
    },
  };
});
const runtimeLayer = coreLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
    | import("effect/Crypto").Crypto
    | import("./ProjectWorkRepository.ts").ProjectWorkRepository
  >,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.merge(runtimeLayer, NodeServices.layer)));

it.effect("disabled startup performs no git/gh calls and retained handles are inert", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const runtime = yield* f.start();
      yield* runtime.ready;
      expect(f.calls).toHaveLength(0);
      expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
      expect(
        (yield* runtime
          .readComments({ projectId: "project", issueRecordId: "issue", expectedRevision: 0 })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* runtime.stop;
      expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
      expect(f.calls).toHaveLength(0);
    }),
  ),
);

it.effect(
  "startup composes real manager and sync, retains successful page deadline and creates no dispatch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const runtime = yield* f.start();
        yield* runtime.refresh;
        const stored = (yield* readIssueRepositoryState(f.sql, key))!;
        expect(stored.status).toBe("ready");
        expect(stored.error).toBeNull();
        expect(stored.lastSuccessfulPageAt).not.toBeNull();
        expect(f.calls.some((input) => input.args.at(-1)?.includes("/issues?"))).toBe(true);
        expect(yield* f.sql`SELECT * FROM project_team_run_binding`).toHaveLength(0);
        const calls = f.calls.length;
        yield* runtime.stop;
        expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
        expect(f.calls).toHaveLength(calls);
      }),
    ),
);

it.effect(
  "cold persisted repository waits for verification instead of recording a false auth failure",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* bindIssueRepositoryProject(f.sql, {
          key,
          projectId: "project",
          repositoryName: "owner/repo",
          accountNodeId: "U_user",
          accountLogin: "alice",
          credentialEpoch: "prior-server-epoch",
          since: at,
          expectedBindingRevision: null,
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setBoundary((input) =>
          input.args.at(-1) === "repos/owner/repo"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const runtime = yield* f.start();
        yield* Deferred.await(entered);
        const pending = yield* readIssueRepositoryState(f.sql, key);
        expect(pending?.error).toBeNull();
        expect(pending?.lease).toBeNull();
        expect(f.calls.filter((input) => input.args.at(-1)?.includes("/issues?"))).toHaveLength(0);
        yield* Deferred.succeed(release, undefined);
        yield* runtime.refresh;
        expect((yield* readIssueRepositoryState(f.sql, key))?.error).toBeNull();
        expect((yield* readIssueRepositoryState(f.sql, key))?.credentialEpoch).not.toBe(
          "prior-server-epoch",
        );
      }),
    ),
);

it.effect("disable joins held verification; re-enable gets one fresh scoped service set", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const joined = yield* Deferred.make<void>();
      const disabled = yield* Deferred.make<void>();
      const secondReady = yield* Deferred.make<void>();
      let readyCount = 0;
      f.setBoundary((input) =>
        input.args[1] === "status"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(joined, undefined)),
            )
          : Effect.void,
      );
      const runtime = yield* f.start((value) =>
        Effect.gen(function* () {
          if (value === "disabled") yield* Deferred.succeed(disabled, undefined);
          if (value === "ready" && ++readyCount === 2)
            yield* Deferred.succeed(secondReady, undefined);
        }),
      );
      yield* Deferred.await(entered);
      yield* f.settings.updateSettings({ projectWorkEnabled: false });
      yield* Deferred.await(disabled);
      expect(yield* Deferred.isDone(joined)).toBe(true);
      expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
      f.setBoundary(undefined);
      yield* f.settings.updateSettings({ projectWorkEnabled: true });
      yield* Deferred.await(secondReady);
      yield* runtime.refresh;
      const stored = yield* readIssueRepositoryState(f.sql, key);
      expect(stored?.status).toBe("ready");
      expect(stored?.lastSuccessfulPageAt).not.toBeNull();
      yield* runtime.stop;
      expect(yield* runtime.refresh).toEqual({ repositories: [], pages: [] });
    }),
  ),
);

it.effect(
  "authenticated lazy comments use the actual reader outside SQL and stopped or inherited-transaction callers cannot fetch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.enableIssue();
        const runtime = yield* f.start();
        yield* runtime.refresh;
        const gateway = yield* f.startGateway(runtime);
        const rows = yield* f.sql<{
          record_id: string;
          payload_json: string;
        }>`SELECT record_id,payload_json FROM project_team_issue`;
        expect(rows).toHaveLength(1);
        const issue = yield* decodeStoredRevision(rows[0]!.payload_json);
        const input = {
          projectId: ProjectId.make("project"),
          operation: "issue-comments" as const,
          issueRecordId: rows[0]!.record_id,
          expectedIssueRevision: issue.revision,
        };
        const page = yield* gateway.read(input, {
          actor: { kind: "human", id: "authenticated-human" },
        });
        expect(page).toMatchObject({ entries: [{ body: "Reviewed comment" }] });
        expect(encode(page)).not.toContain("synthetic-token");
        const calls = f.calls.length;
        expect((yield* f.sql.withTransaction(gateway.read(input)).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(f.calls).toHaveLength(calls);
        expect(
          (yield* gateway
            .read({ projectId: input.projectId, operation: "issue-comments" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(f.calls).toHaveLength(calls);
        const managed = yield* decodeManagedCredential({
          projectId: "project",
          bindingId: "unissued-binding",
          generation: 0,
          providerInstanceId: "pi",
          threadId: "unissued-thread",
        });
        expect(
          (yield* gateway
            .read(input, {
              actor: { kind: "agent", id: "agent:mcp:pi:unissued-thread" },
              managed,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(f.calls).toHaveLength(calls);
        yield* runtime.stop;
        expect((yield* gateway.read(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.calls).toHaveLength(calls);
      }),
    ),
);

it.effect("failed settings subscription construction closes its acquired scope", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      let closed = 0;
      const failedSettings = ServerSettingsService.of({
        ...f.settings,
        subscribeChanges: Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed++;
          }),
        ).pipe(Effect.andThen(Effect.die("subscription construction failed"))),
      });
      const result = yield* Effect.scoped(f.start(() => Effect.void, failedSettings)).pipe(
        Effect.exit,
      );
      expect(result._tag).toBe("Failure");
      expect(closed).toBe(1);
      expect(f.calls).toHaveLength(0);
    }),
  ),
);

for (const count of [32, 33]) {
  it.effect(
    `${count} projects: startup never records false authentication for a repository awaiting manager verification`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          for (let index = 0; index < count - 2; index++) {
            const projectId = `a${String(index).padStart(2, "0")}`;
            yield* f.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Extra','/fixture/runtime','[]',${at},${at})`;
          }
          yield* f.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('zzz-unseen','Unseen','/fixture/unseen','[]',${at},${at})`;
          const unseen = { host: "github.com", repositoryNodeId: "R_aaa" };
          yield* bindIssueRepositoryProject(f.sql, {
            key: unseen,
            projectId: "zzz-unseen",
            repositoryName: "owner/other",
            accountNodeId: "U_user",
            accountLogin: "alice",
            credentialEpoch: "prior-server-epoch",
            since: at,
            expectedBindingRevision: null,
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.setBoundary((input) =>
            input.args.at(-1)?.includes("repos/owner/repo/issues?")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          );
          const runtime = yield* f.start();
          yield* Deferred.await(entered);
          const observed = yield* readIssueRepositoryState(f.sql, unseen);
          const lookups = f.calls.filter((input) => input.args.at(-1) === "repos/owner/other");
          if (count === 32) expect(lookups.length).toBeGreaterThan(0);
          else expect(lookups).toHaveLength(0);
          if (count === 33) expect(observed?.credentialEpoch).toBe("prior-server-epoch");
          expect(observed?.error).toBeNull();
          expect(observed?.lease).toBeNull();
          yield* Deferred.succeed(release, undefined);
          if (count === 33) {
            const refreshed = yield* runtime.refresh;
            expect(
              refreshed.repositories.some(
                (receipt) => receipt.projectId === "zzz-unseen" && receipt.status === "ready",
              ),
            ).toBe(true);
            const completed = yield* readIssueRepositoryState(f.sql, unseen);
            expect(completed?.credentialEpoch).not.toBe("prior-server-epoch");
            expect(completed?.error).toBeNull();
            expect(completed?.lease).toBeNull();
            expect(completed?.lastSuccessfulPageAt).not.toBeNull();
            expect(
              yield* f.sql`SELECT * FROM project_issue_page WHERE repository_node_id='R_aaa'`,
            ).toHaveLength(1);
            expect(yield* f.sql`SELECT * FROM project_team_effect`).toEqual([]);
          }
          yield* runtime.stop;
        }),
      ),
  );
}
