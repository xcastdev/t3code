import { expect, it } from "@effect/vitest";
import { ProjectWorkFoundationCommitCommand, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
import { ProjectManagedSetupError } from "../project/ProjectManagedSetup.ts";
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
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-consumer-" })),
);
const withServices = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  scoped(
    body.pipe(
      Effect.provide(Layer.mergeAll(queryLayer, workflowLayer, ServerSettings.layerTest())),
    ),
  );
const git = Effect.fn("workspaceTest.git")(function* (cwd: string, args: readonly string[]) {
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
const fixture = Effect.fn("workspaceTest.fixture")(function* (controlledManager = false) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-consumer-" });
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
  const snapshot = yield* dispatch.claimEffect((yield* dispatch.reserve(request)).fence);
  const pi = yield* makeProjectTeamPiRuntime();
  const source = path.join(scratch, "controlled-bash");
  yield* fs.writeFileString(
    source,
    "Controlled asset; no native service or script execution is claimed",
  );
  let revoked = false;
  let assetChecks = 0;
  const scopes = new Set<Scope.Scope>();
  let hook: () => Effect.Effect<void> = () => Effect.void;
  const assertCurrent = Effect.fn("workspaceTest.assertCurrent")(function* () {
    scopes.add(yield* Scope.Scope);
    yield* hook();
    if (revoked)
      return yield* new ProjectTeamDispatchJournalError({ reason: "Fixture executor revoked" });
  });
  const options = {
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    launchPolicy: { memoryBytes: 67108864, runtimeSeconds: 60 },
    protectedRoots: [primary, protectedRoot],
    assertCurrent,
  };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostCalls = { controls: 0, launches: 0 };
  const controlledOutput = (output: string) =>
    spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          ["--max-old-space-size=512", "-e", `process.stdout.write(${encodeJson(output)})`],
          { env: {}, extendEnv: false },
        ),
      )
      .pipe(Effect.tap((child) => Effect.sync(() => capturedPids.push(Number(child.pid)))));
  // These real byte children model an absent manager and unavailable sandbox. They never start setup.
  const controlledSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = {
    ...spawner,
    spawn: (command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      if (command.command === "/usr/bin/systemd-run") {
        hostCalls.launches++;
        return Effect.die("Controlled fixture refuses native launch");
      }
      if (command.command === "/usr/bin/bwrap") {
        hostCalls.controls++;
        return controlledOutput("controlled-unavailable\n");
      }
      if (command.command === "/usr/bin/systemctl") {
        hostCalls.controls++;
        return controlledOutput(
          "LoadState=not-found\nDescription=\nInvocationID=\nControlGroup=\nActiveState=inactive\nKillMode=\nRestart=\nRuntimeMaxUSec=\nTimeoutStopUSec=\nUnsetEnvironment=\nEnvironment=\n",
        );
      }
      return spawner
        .spawn(command)
        .pipe(Effect.tap((child) => Effect.sync(() => capturedPids.push(Number(child.pid)))));
    },
  };
  const consumer = yield* makeProjectTeamWorkspace(options).pipe(
    Effect.provideService(ProjectTeamPiRuntime, pi),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      controlledManager ? controlledSpawner : spawner,
    ),
  );
  const publish = pi.publishAssets(
    ProviderInstanceId.make("pi"),
    {
      runtimeFiles: [{ source, target: "/bin/bash" }],
      revalidate: Effect.sync(() => {
        assetChecks++;
      }),
      borrow: (effect) => effect,
    },
    runtime,
  );
  const advance = Effect.fn("workspaceTest.advance")(function* (
    receipt: Awaited<Effect.Success<ReturnType<typeof consumer.workspace>>>,
  ) {
    const operationScope = yield* Scope.Scope;
    const stages = yield* makeProjectTeamDispatchJournal({
      ...options,
      verifyStage: (_input, current) =>
        consumer.verifyWorkspace(current, receipt).pipe(
          Effect.provideService(Scope.Scope, operationScope),
          Effect.mapError(
            () => new ProjectTeamDispatchJournalError({ reason: "Workspace verification failed" }),
          ),
        ),
    });
    return yield* stages.advanceStage(snapshot.fence, {
      receiptId: "workspace-ready",
      stage: "workspace-ready",
      evidence: { workspace: receipt },
    });
  });
  if (claim.transition?.kind !== "claim") return yield* Effect.die("Missing original claim");
  const input = {
    setupId: request.setupId,
    dispatchId: request.dispatchId,
    bindingId: request.git.runId,
    generation: request.git.generation,
    threadId: claim.transition.binding.threadId,
    worktreePath: worktree,
    deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
  };
  return {
    sql,
    fs,
    path,
    primary,
    worktree,
    request,
    snapshot,
    consumer,
    dispatch,
    options,
    pi,
    publish,
    advance,
    input,
    scopes,
    hostCalls,
    revoke: () => {
      revoked = true;
    },
    setHook: (next: typeof hook) => {
      hook = next;
    },
    assetChecks: () => assetChecks,
  };
});

describe("actual managed Git and SQLite workspace consumer", () => {
  for (const activation of ["unlaunched", "claimed"] as const) {
    it.effect(
      `reconciles ${activation} setup through actual recovery with controlled host absence and no live driver`,
      () =>
        withServices(
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(true);
              const workspace = yield* f.consumer.workspace(f.snapshot);
              const snapshot = yield* f.advance(workspace);
              yield* f.sql`UPDATE projection_projects SET scripts_json=${encodeJson([{ id: "setup", name: "Prepare", icon: "configure", command: "printf prepared", runOnWorktreeCreate: true, async: true }])} WHERE project_id=${projectId}`;
              const loan = yield* Scope.make();
              yield* f.publish.pipe(Effect.provideService(Scope.Scope, loan));
              expect((yield* f.consumer.setup(snapshot, workspace).pipe(Effect.result))._tag).toBe(
                "Failure",
              );
              const journal = yield* makeProjectManagedSetupJournal({
                ...f.options,
                validateSelection: () => Effect.void,
              });
              const retained = yield* journal.read(f.input);
              if (!retained?.allocation || retained.selection.kind !== "script")
                return yield* Effect.die("Missing original controlled allocation");
              if (activation === "claimed")
                yield* journal.claimActivation(f.input, retained.selection, retained.allocation);
              yield* Scope.close(loan, Exit.void);
              f.revoke();
              const reconciled = yield* f.consumer.reconcile(snapshot).pipe(Effect.result);
              if (activation === "unlaunched") {
                expect(reconciled._tag).toBe("Success");
                if (reconciled._tag === "Success") {
                  expect(reconciled.success.outcome).toBe("failed");
                  expect(reconciled.success.reconciliation?.state).toBe("absent");
                  expect(reconciled.success.reason).toContain("script was not repeated");
                }
              } else {
                expect(reconciled._tag).toBe("Failure");
                expect((yield* journal.read(f.input))?.uncertain).toBe(true);
              }
              expect(f.hostCalls.controls).toBeGreaterThan(0);
              expect(f.hostCalls.launches).toBe(0);
              expect((yield* f.dispatch.readRetained("dispatch")).fence.stage).toBe(
                "workspace-ready",
              );
              expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
                { status: "held" },
              ]);
            }),
          ),
        ),
    );
  }
  it.effect(
    "retains the original receipt before stage append and verifies after service restart",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const receipt = yield* f.consumer.workspace(f.snapshot);
            expect(f.scopes.has(yield* Scope.Scope)).toBe(true);
            expect((yield* f.dispatch.inspect("dispatch")).fence).toEqual(f.snapshot.fence);
            expect(yield* git(f.worktree, ["symbolic-ref", "HEAD"])).toBe(f.request.git.branchRef);
            expect(
              yield* f.sql`SELECT dispatch_id,binding_id,claim_generation FROM project_team_workspace_receipt`,
            ).toEqual([{ dispatch_id: "dispatch", binding_id: "binding", claim_generation: 1 }]);
            const reopened = yield* makeProjectTeamWorkspace(f.options).pipe(
              Effect.provideService(ProjectTeamPiRuntime, f.pi),
            );
            expect(yield* reopened.workspace(f.snapshot)).toEqual(receipt);
            const advanced = yield* f.advance(receipt);
            yield* reopened.verifyWorkspace(advanced, receipt);
            expect((yield* f.dispatch.readStageReceipts("dispatch"))[0]?.evidence).toEqual({
              workspace: receipt,
            });
          }),
        ),
      ),
  );
  for (const change of [
    "pointer",
    "branch",
    "configuration",
    "ownership",
    "registration",
  ] as const) {
    it.effect(`rejects changed ${change} while retaining original receipt`, () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const receipt = yield* f.consumer.workspace(f.snapshot);
            if (change === "pointer")
              yield* f.fs.writeFileString(
                f.path.join(f.worktree, ".git"),
                "gitdir: /tmp/foreign\n",
              );
            if (change === "branch") yield* git(f.worktree, ["switch", "-c", "foreign"]);
            if (change === "configuration")
              yield* git(f.primary, ["config", "core.hooksPath", "/tmp/foreign"]);
            if (change === "ownership")
              yield* f.fs.writeFileString(
                f.path.join(receipt.gitDirectory.path, "t3-managed-owner"),
                "foreign",
              );
            if (change === "registration")
              yield* git(f.primary, ["worktree", "remove", "--force", f.worktree]);
            expect(
              (yield* f.consumer.verifyWorkspace(f.snapshot, receipt).pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              yield* f.sql`SELECT receipt_json FROM project_team_workspace_receipt`,
            ).toHaveLength(1);
            expect((yield* f.dispatch.inspect("dispatch")).fence.stage).toBe("reserved");
          }),
        ),
      ),
    );
  }
  it.effect(
    "lost persistence leaves owned Git state and refuses recreation without its original receipt",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.sql`CREATE TRIGGER deny_workspace BEFORE INSERT ON project_team_workspace_receipt BEGIN SELECT RAISE(ABORT,'fixture receipt unavailable'); END`;
            expect((yield* f.consumer.workspace(f.snapshot).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(yield* f.fs.exists(f.worktree)).toBe(true);
            yield* f.sql`DROP TRIGGER deny_workspace`;
            expect((yield* f.consumer.workspace(f.snapshot).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(yield* f.sql`SELECT * FROM project_team_workspace_receipt`).toEqual([]);
          }),
        ),
      ),
  );
  it.effect("exact retained SQL identity cannot be replaced or adopted as a new claim", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const receipt = yield* f.consumer.workspace(f.snapshot);
          // Deliberate storage corruption tests the consumer independently of migration immutability.
          yield* f.sql`DROP TRIGGER IF EXISTS project_team_workspace_receipt_immutable`;
          yield* f.sql`UPDATE project_team_workspace_receipt SET claim_generation=2`;
          expect((yield* f.consumer.workspace(f.snapshot).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(
            (yield* f.consumer.verifyWorkspace(f.snapshot, receipt).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* f.sql`SELECT claim_generation FROM project_team_workspace_receipt`)[0]
              ?.claim_generation,
          ).toBe(2);
        }),
      ),
    ),
  );
  it.effect("revocation during a held authority receipt blocks Git effects", () =>
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
          const running = yield* f.consumer.workspace(f.snapshot).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          f.revoke();
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(running).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.fs.exists(f.worktree)).toBe(false);
          expect(yield* f.sql`SELECT * FROM project_team_workspace_receipt`).toEqual([]);
        }),
      ),
    ),
  );
  it.effect(
    "captures nested assignment bytes and callback before an asynchronous authority read",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const supplied = {
              ...f.snapshot,
              intent: {
                ...f.snapshot.intent,
                request: {
                  ...f.snapshot.intent.request,
                  git: { ...f.snapshot.intent.request.git },
                },
              },
            };
            f.setHook(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.asVoid,
              ),
            );
            const running = yield* f.consumer.workspace(supplied).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            supplied.intent.request.git.worktreePath = f.path.join(f.primary, "foreign");
            f.options.assertCurrent = () =>
              Effect.fail(new ProjectTeamDispatchJournalError({ reason: "Replacement callback" }));
            yield* Deferred.succeed(release, undefined);
            const receipt = yield* Fiber.join(running);
            expect(receipt.worktree.path).toBe(f.worktree);
            expect(yield* f.fs.exists(f.path.join(f.primary, "foreign"))).toBe(false);
          }),
        ),
      ),
  );
  it.effect(
    "setup verification refuses changed current script configuration with original receipt intact",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const workspace = yield* f.consumer.workspace(f.snapshot);
            const snapshot = yield* f.advance(workspace);
            yield* f.publish;
            const receipt = yield* f.consumer.setup(snapshot, workspace);
            yield* f.sql`UPDATE projection_projects SET scripts_json=${encodeJson([{ id: "changed", name: "Changed", icon: "configure", command: "false", runOnWorktreeCreate: true, async: true }])} WHERE project_id=${projectId}`;
            expect(
              (yield* f.consumer.verifySetup(snapshot, workspace, receipt).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(
              (yield* f.sql`SELECT status,activation,unit FROM project_team_setup_process`)[0],
            ).toEqual({ status: "no-script", activation: "unlaunched", unit: null });
            expect((yield* f.dispatch.inspect("dispatch")).fence.stage).toBe("workspace-ready");
          }),
        ),
      ),
  );
  it.effect(
    "skips through the actual setup runtime loan, replays durably, and cleans up after revocation",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const workspace = yield* f.consumer.workspace(f.snapshot);
            const snapshot = yield* f.advance(workspace);
            yield* f.publish;
            const receipt = yield* f.consumer.setup(snapshot, workspace);
            expect(receipt.outcome).toBe("skipped");
            yield* f.consumer.verifySetup(snapshot, workspace, receipt);
            expect(yield* f.consumer.setup(snapshot, workspace)).toEqual(receipt);
            expect(f.assetChecks()).toBeGreaterThan(0);
            expect(
              yield* f.sql`SELECT status,activation,unit FROM project_team_setup_process`,
            ).toEqual([{ status: "no-script", activation: "unlaunched", unit: null }]);
            f.revoke();
            expect((yield* f.consumer.setup(snapshot, workspace).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(yield* f.consumer.reconcile(snapshot)).toEqual(receipt);
            expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
              { status: "held" },
            ]);
          }),
        ),
      ),
  );
  it.effect("missing/replaced driver cannot authorize setup or verify an old completion", () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const workspace = yield* f.consumer.workspace(f.snapshot);
          const snapshot = yield* f.advance(workspace);
          expect((yield* f.consumer.setup(snapshot, workspace).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          const loan = yield* Scope.make();
          yield* f.publish.pipe(Effect.provideService(Scope.Scope, loan));
          const receipt = yield* f.consumer.setup(snapshot, workspace);
          yield* Scope.close(loan, Exit.void);
          expect(
            (yield* f.consumer.verifySetup(snapshot, workspace, receipt).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.consumer.reconcile(snapshot)).toEqual(receipt);
        }),
      ),
    ),
  );
  it.effect(
    "changed setup receipt and uncertain selection never authorize a worker or repeat a script",
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const workspace = yield* f.consumer.workspace(f.snapshot);
            const snapshot = yield* f.advance(workspace);
            yield* f.publish;
            const receipt = yield* f.consumer.setup(snapshot, workspace);
            expect(
              (yield* f.consumer
                .verifySetup(snapshot, workspace, { ...receipt, reason: "forged" })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            const journal = yield* makeProjectManagedSetupJournal({
              ...f.options,
              validateSelection: () =>
                Effect.fail(new ProjectManagedSetupError({ reason: "No new execution" })),
            });
            const retained = yield* journal.read(f.input);
            if (!retained) return yield* Effect.die("Missing retained setup");
            const { uncertain: _uncertain, ...expected } = retained;
            yield* journal.markUncertain(f.input, {
              expected,
              selection: retained.selection,
              allocation: null,
              owner: null,
              drain: null,
              reconciliation: null,
              reason: "Fixture retains uncertainty",
            });
            expect((yield* f.consumer.setup(snapshot, workspace).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* f.consumer.reconcile(snapshot).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* f.sql`SELECT status FROM project_team_setup_process`)[0]?.status).toBe(
              "uncertain",
            );
            expect((yield* f.dispatch.inspect("dispatch")).fence.stage).toBe("workspace-ready");
          }),
        ),
      ),
  );
});

afterAll(() => {
  for (const pid of capturedPids)
    expect(nativeFs.existsSync(`/proc/${pid}`), `owned Git PID ${pid} drained`).toBe(false);
});
