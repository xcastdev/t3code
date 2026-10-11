import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectWorkFoundationCommitCommand,
  ProviderInstanceId,
  ProviderDriverKind,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll, describe } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Workflow from "../git/GitWorkflowService.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { makeProjectManagedSetupJournal } from "../project/ProjectManagedSetupJournal.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import {
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
} from "../provider/pi/PiManagedRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";
import {
  makeProjectTeamPreparationRuntime,
  ProjectTeamPreparationRuntimeError,
} from "./ProjectTeamPreparationRuntime.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

class ControlledRootOwner extends Context.Service<
  ControlledRootOwner,
  { readonly token: object }
>()("t3/projectWork/ProjectTeamPreparationRuntime.test/ControlledRootOwner") {}
const nativeFs = process.getBuiltinModule("fs");
const capturedPids: number[] = [];
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const unused = Effect.fail(
  new PiManagedRuntimeError({ code: "denied", detail: "Fixture never runs a Pi operation" }),
);
// The registry is real; its loan carries controlled files and a runtime that refuses every worker operation.
const runtime: PiManagedRuntimeInstance = {
  inspect: unused,
  prepareOperation: () => unused,
  readSession: () => unused,
  readThread: () => unused,
  requestStop: () => unused,
  stopAll: unused,
  authorizeSkills: () => unused,
  discoverNativeSkills: () => unused,
};
const queryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
);
const workflowLayer = Workflow.layer.pipe(
  Layer.provide(
    Layer.mock(Registry.VcsDriverRegistry)({
      resolve: () => Effect.die("Managed Git must bypass ordinary discovery"),
    }),
  ),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provide(Git.layer.pipe(Layer.provideMerge(VcsProcess.layer))),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "preparation-runtime-" })),
);
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(queryLayer),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "preparation-engine-" })),
);
const withServices = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  scoped(
    body.pipe(
      Effect.provide(
        Layer.mergeAll(
          queryLayer,
          workflowLayer,
          engineLayer,
          ServerSettings.layerTest({
            projectWorkEnabled: true,
            projectTeamExecutionEnabled: true,
            providerInstances: {
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("piAgent"),
                enabled: true,
                config: {},
              },
            },
          }),
        ),
      ),
    ),
  );
const git = Effect.fn("preparationTest.git")(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/git", ["-C", cwd, ...args], {
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          extendEnv: false,
          stdin: "ignore",
          shell: false,
        }),
      );
      capturedPids.push(Number(child.pid));
      const [out, err, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(code), err.text).toBe(0);
      return out.text.trim();
    }),
  );
});
const fixture = Effect.fn("preparationTest.fixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "preparation-runtime-" });
  const primary = path.join(scratch, "primary");
  const worktree = path.join(scratch, "assigned");
  const protectedRoot = path.join(scratch, "protected");
  yield* fs.makeDirectory(primary);
  yield* fs.makeDirectory(protectedRoot);
  yield* git(primary, ["init", "--initial-branch=main"]);
  yield* git(primary, ["config", "user.name", "Workspace test"]);
  yield* git(primary, ["config", "user.email", "workspace@test.invalid"]);
  yield* fs.writeFileString(path.join(primary, "file.txt"), "base\n");
  yield* git(primary, ["add", "file.txt"]);
  yield* git(primary, ["commit", "-m", "base"]);
  const oid = yield* git(primary, ["rev-parse", "HEAD"]);
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
    issueCredential: false,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain fixture claim"));
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  if (!pending || pending.transition?.kind !== "claim") return yield* Effect.die("Missing claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "configure-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 1,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 60000,
        },
      ],
    }),
  );
  yield* TestClock.setTime(Date.parse(at) + 1);
  yield* sql`UPDATE projection_projects SET workspace_root=${primary},scripts_json='[]' WHERE project_id=${projectId}`;
  const claim = yield* decodeCommit({
    ...pending,
    expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
    transition: {
      ...pending.transition,
      binding: {
        ...pending.transition.binding,
        branch: "refs/heads/assigned",
        worktree,
        configuration: { ...pending.transition.binding.configuration, maxDurationMs: 60000 },
      },
    },
  });
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "dispatch",
    claim,
    git: {
      effectId: "dispatch",
      runId: "binding",
      generation: 0,
      primaryRoot: primary,
      commonGitDirectory: path.join(primary, ".git"),
      worktreePath: worktree,
      branchRef: "refs/heads/assigned",
      baseRef: "refs/heads/main",
      baseOid: oid,
      ownershipToken: "owner",
      policyHash: "b".repeat(64),
    },
    setupId: "setup",
    initializeOperationId: "initialize",
    assignmentOperationId: "assignment",
    assignment: "Approved task",
  };
  const dispatch = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const reserved = yield* dispatch.reserve(request);
  const pi = yield* makeProjectTeamPiRuntime();
  const source = path.join(scratch, "controlled-bash");
  yield* fs.writeFileString(source, "Controlled asset; no native setup or Pi execution is claimed");
  yield* pi.publishAssets(
    ProviderInstanceId.make("pi"),
    {
      instanceConfiguration: { enabled: true, configuration: {} },
      runtimeFiles: [{ source, target: "/bin/bash" }],
      revalidate: Effect.void,
      borrow: (effect) => effect,
    },
    runtime,
  );
  const modelSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("pi"),
    model: "test",
    options: [],
  };
  const options = {
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    launchPolicy: { memoryBytes: 67108864, runtimeSeconds: 60 },
    protectedRoots: [primary, protectedRoot],
  };
  let revoked = false;
  let loanCalls = 0;
  let hook: (snapshot: typeof reserved) => Effect.Effect<void> = () => Effect.void;
  let capturedCallback: Effect.Effect<void, ProjectTeamPreparationRuntimeError> | undefined;
  type FactoryOptions = Parameters<typeof makeProjectTeamPreparationRuntime>[0];
  type Loan = Parameters<Parameters<FactoryOptions["withCurrent"]>[1]>[0];
  const withCurrent: FactoryOptions["withCurrent"] = <A, E, R>(
    snapshot: ProjectTeamDispatchSnapshot,
    run: (loan: Loan) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      loanCalls++;
      const original = snapshot.intent;
      const owner = Object.freeze({});
      const assertCurrent = (expected: typeof snapshot) =>
        Effect.gen(function* () {
          yield* Scope.Scope;
          yield* hook(expected);
          const registered = yield* Effect.serviceOption(ControlledRootOwner);
          if (
            Option.isNone(registered) ||
            registered.value.token !== owner ||
            revoked ||
            canonicalProjectWorkPayload(expected.intent) !== canonicalProjectWorkPayload(original)
          )
            return yield* new ProjectTeamDispatchJournalError({
              reason: "Controlled Root owner changed",
            });
        });
      const work = run({
        modelSelection,
        assertCurrent,
        assertResources: Effect.gen(function* () {
          yield* Scope.Scope;
          if (revoked)
            return yield* new ProjectTeamDispatchJournalError({
              reason: "Controlled Root resources changed",
            });
        }),
      });
      const guarded = work.pipe(Effect.provideService(ControlledRootOwner, { token: owner }));
      capturedCallback = guarded.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new ProjectTeamPreparationRuntimeError({ reason: "Controlled callback failed", cause }),
        ),
        Effect.provide(yield* Effect.context<R>()),
      );
      return yield* guarded;
    });
  const make = () =>
    makeProjectTeamPreparationRuntime({ ...options, withCurrent }).pipe(
      Effect.provideService(ProjectTeamPiRuntime, pi),
    );
  const preparation = yield* make();
  const workspace = yield* makeProjectTeamWorkspace({
    ...options,
    assertCurrent: () => Effect.void,
  }).pipe(Effect.provideService(ProjectTeamPiRuntime, pi));
  const transition = claim.transition;
  if (transition?.kind !== "claim") return yield* Effect.die("Missing original claim");
  const input = {
    setupId: request.setupId,
    dispatchId: request.dispatchId,
    bindingId: request.git.runId,
    generation: request.git.generation,
    threadId: transition.binding.threadId,
    worktreePath: worktree,
    deadlineAtMs: reserved.intent.limits.deadlineAtMs,
  };
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("original-project-create"),
    projectId,
    title: "Project",
    workspaceRoot: primary,
    createdAt: at,
  });
  const settings = yield* ServerSettings.ServerSettingsService;
  return {
    sql,
    fs,
    path,
    primary,
    worktree,
    protectedRoot,
    request,
    reserved,
    dispatch,
    preparation,
    workspace,
    pi,
    make,
    options,
    input,
    engine,
    settings,
    loanCalls: () => loanCalls,
    revoke: () => {
      revoked = true;
    },
    setHook: (next: typeof hook) => {
      hook = next;
    },
    replayCallback: () => capturedCallback ?? Effect.die("No captured callback"),
  };
});

describe("actual SQLite/Git preparation with controlled Root/Pi metadata loans", () => {
  it.effect(
    "concurrent preparations return the original physical receipts and one creation event",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const [first, second] = yield* Effect.all(
              [f.preparation.prepare("dispatch"), f.preparation.prepare("dispatch")],
              { concurrency: "unbounded" },
            );
            expect(second).toEqual(first);
            expect(first.snapshot.fence).toMatchObject({
              stage: "setup-complete",
              claimGeneration: 1,
              revision: 3,
            });
            expect(first.workspace.assignment).toEqual(f.request.git);
            expect(first.setup.outcome).toBe("skipped");
            expect(yield* git(f.worktree, ["symbolic-ref", "HEAD"])).toBe(f.request.git.branchRef);
            expect(
              yield* f.sql`SELECT event_type FROM orchestration_events WHERE aggregate_kind='thread'`,
            ).toEqual([{ event_type: "thread.created" }]);
            expect((yield* f.dispatch.readStageReceipts("dispatch")).map((r) => r.stage)).toEqual([
              "workspace-ready",
              "setup-complete",
            ]);
            expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
              { status: "held" },
            ]);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
          }),
        ),
      ),
  );
  it.effect(
    "lost response and new factory reconcile original identities without another claim",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const original = yield* f.preparation.prepare("dispatch");
            const reopened = yield* f.make();
            expect(yield* reopened.prepare("dispatch")).toEqual(original);
            expect(
              yield* f.sql`SELECT claim_generation,revision FROM project_team_dispatch`,
            ).toEqual([{ claim_generation: 1, revision: 3 }]);
            expect(yield* f.sql`SELECT setup_id FROM project_team_setup_process`).toEqual([
              { setup_id: "setup" },
            ]);
            expect(
              yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt ORDER BY revision`,
            ).toEqual([
              { receipt_id: projectTeamDerivedRecordId("dispatch", "stage:workspace-ready") },
              { receipt_id: projectTeamDerivedRecordId("dispatch", "stage:setup-complete") },
            ]);
          }),
        ),
      ),
  );
  it.effect("retained Git receipt reconciles a lost stage response using its original claim", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.sql`CREATE TRIGGER hold_stage BEFORE INSERT ON project_team_dispatch_receipt BEGIN SELECT RAISE(ABORT,'controlled stage outage'); END`;
          expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          const retained = yield* f.dispatch.inspect("dispatch", { requireClaim: true });
          expect(retained.fence).toMatchObject({
            stage: "reserved",
            claimGeneration: 1,
            revision: 1,
          });
          const workspace = yield* f.workspace.readWorkspace(retained);
          expect(workspace).not.toBeNull();
          yield* f.sql`DROP TRIGGER hold_stage`;
          const prepared = yield* f.preparation.prepare("dispatch");
          expect(prepared.workspace).toEqual(workspace);
          expect(prepared.snapshot.fence.claimGeneration).toBe(1);
        }),
      ),
    ),
  );
  it.effect("a claimed dispatch without original physical evidence requires Root recovery", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const claimed = yield* f.dispatch.claimEffect(f.reserved.fence);
          expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* f.dispatch.inspect("dispatch")).fence).toEqual(claimed.fence);
          expect(yield* f.fs.exists(f.worktree)).toBe(false);
          expect(yield* f.sql`SELECT * FROM project_team_dispatch_receipt`).toEqual([]);
        }),
      ),
    ),
  );
  for (const change of ["disabled", "provider-disabled", "configuration"] as const) {
    it.effect(`current ${change} settings refuse a new claim and physical effects`, () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.settings.updateSettings(
              change === "disabled"
                ? { projectTeamExecutionEnabled: false }
                : {
                    providerInstances: {
                      [ProviderInstanceId.make("pi")]: {
                        driver: ProviderDriverKind.make("piAgent"),
                        enabled: change !== "provider-disabled",
                        config:
                          change === "configuration"
                            ? { agentDirectory: "/controlled/changed" }
                            : {},
                      },
                    },
                  },
            );
            expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* f.dispatch.inspect("dispatch")).fence.claimGeneration).toBe(0);
            expect(yield* f.fs.exists(f.worktree)).toBe(false);
          }),
        ),
      ),
    );
  }
  for (const change of ["branch", "pointer", "setup", "root"] as const) {
    it.effect(
      `current ${change} changes reject retained preparation and keep writer ownership`,
      () =>
        withServices(
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.preparation.prepare("dispatch");
              if (change === "branch") yield* git(f.worktree, ["switch", "-c", "foreign"]);
              if (change === "pointer")
                yield* f.fs.writeFileString(
                  f.path.join(f.worktree, ".git"),
                  "gitdir: /tmp/foreign\n",
                );
              if (change === "setup")
                yield* f.sql`UPDATE projection_projects SET scripts_json=${encodeJson([{ id: "setup", name: "Prepare", icon: "configure", command: "printf prepared", runOnWorktreeCreate: true, async: true }])} WHERE project_id=${projectId}`;
              if (change === "root")
                yield* f.sql`UPDATE projection_projects SET workspace_root=${f.protectedRoot} WHERE project_id=${projectId}`;
              expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
                "Failure",
              );
              expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
                { status: "held" },
              ]);
              expect((yield* f.dispatch.readRetained("dispatch")).fence.stage).toBe(
                "setup-complete",
              );
              expect(
                yield* f.sql`SELECT event_type FROM orchestration_events WHERE aggregate_kind='thread'`,
              ).toHaveLength(1);
            }),
          ),
        ),
    );
  }
  it.effect(
    "setup completion is durable before thread creation and a lost thread response reconciles",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            let observed = false;
            const engine = {
              ...f.engine,
              dispatch: (command: Parameters<typeof f.engine.dispatch>[0]) =>
                Effect.gen(function* () {
                  if (command.type === "thread.create") {
                    const snapshot = yield* f.dispatch.inspect("dispatch", { requireClaim: true });
                    expect(snapshot.fence.stage).toBe("setup-complete");
                    expect((yield* f.workspace.readSetup(snapshot))?.outcome).toBe("skipped");
                    observed = true;
                  }
                  const result = yield* f.engine.dispatch(command);
                  if (command.type === "thread.create")
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: "thread.create",
                      detail: "Controlled lost response after actual creation commit",
                    });
                  return result;
                }),
            };
            const preparation = yield* f
              .make()
              .pipe(Effect.provideService(OrchestrationEngineService, engine));
            const result = yield* preparation.prepare("dispatch");
            expect(observed).toBe(true);
            expect(yield* f.preparation.prepare("dispatch")).toEqual(result);
          }),
        ),
      ),
  );
  it.effect("uncertain original setup cannot be replayed and never creates a thread", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.sql`CREATE TRIGGER hold_setup_stage BEFORE INSERT ON project_team_dispatch_receipt WHEN NEW.stage='setup-complete' BEGIN SELECT RAISE(ABORT,'controlled setup stage outage'); END`;
          expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* f.sql`DROP TRIGGER hold_setup_stage`;
          const journal = yield* makeProjectManagedSetupJournal({
            ...f.options,
            validateSelection: () => Effect.void,
          });
          const retained = yield* journal.read(f.input);
          if (!retained) return yield* Effect.die("Missing original setup");
          const { uncertain: _uncertain, ...expected } = retained;
          yield* journal.markUncertain(f.input, {
            expected,
            selection: retained.selection,
            allocation: retained.allocation,
            owner: retained.owner,
            drain: null,
            reconciliation: null,
            reason: "Controlled uncertainty",
          });
          expect((yield* f.preparation.prepare("dispatch").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* journal.read(f.input))?.uncertain).toBe(true);
          expect((yield* f.dispatch.readRetained("dispatch")).fence.stage).toBe("workspace-ready");
          expect(
            yield* f.sql`SELECT * FROM orchestration_events WHERE aggregate_kind='thread'`,
          ).toEqual([]);
          expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
            { status: "held" },
          ]);
        }),
      ),
    ),
  );
  it.effect("the callback loan is revoked after return and cannot repeat physical effects", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.preparation.prepare("dispatch");
          expect((yield* f.replayCallback().pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* f.dispatch.readRetained("dispatch")).fence.revision).toBe(3);
          expect(
            yield* f.sql`SELECT * FROM orchestration_events WHERE aggregate_kind='thread'`,
          ).toHaveLength(1);
        }),
      ),
    ),
  );
  it.effect("a foreign SQL caller cannot redirect the captured assignment", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const other = Context.get(
            yield* Layer.build(Layer.fresh(SqlitePersistenceMemory)),
            SqlClient.SqlClient,
          );
          expect(
            (yield* f.preparation
              .prepare("dispatch")
              .pipe(Effect.provideService(SqlClient.SqlClient, other), Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* f.dispatch.inspect("dispatch")).fence.claimGeneration).toBe(0);
          expect(yield* f.fs.exists(f.worktree)).toBe(false);
        }),
      ),
    ),
  );
  it.effect("revocation during a held original-owner check refuses allocation", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.setHook(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            ),
          );
          const running = yield* f.preparation.prepare("dispatch").pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          f.revoke();
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(running).pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* f.dispatch.readRetained("dispatch")).fence.claimGeneration).toBe(0);
          expect(yield* f.fs.exists(f.worktree)).toBe(false);
        }),
      ),
    ),
  );
});

afterAll(() => {
  const remaining = capturedPids.filter((pid) => nativeFs.existsSync(`/proc/${pid}`));
  expect(remaining).toEqual([]);
});
