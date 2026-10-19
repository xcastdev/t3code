import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  ThreadId,
  ProjectWorkFoundationCommitCommand,
  ProviderInstanceId,
  type ProjectTeamRecord,
  type ProjectTeamGuidedIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll, vi } from "vite-plus/test";
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
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import {
  at,
  attribution,
  projectId,
  seed,
  gatewayRuntime,
  createManagedAssignment,
  taskId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";
import {
  makeProjectTeamDispatch,
  ProjectTeamDispatchError,
  type ProjectTeamDispatchPorts,
  type ProjectTeamDispatchReceipt,
  type ProjectTeamDispatchSnapshot,
} from "./ProjectTeamDispatch.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
const nativeFs = process.getBuiltinModule("fs");
const capturedPids: number[] = [];
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeStageEvidence = Schema.decodeUnknownEffect(Schema.JsonObject);
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
  body.pipe(
    Effect.provide(
      Layer.mergeAll(queryLayer, workflowLayer, ProjectWorkProjectionLive).pipe(
        Layer.provideMerge(gatewayRuntime),
      ),
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

// This OS fixture replaces the provider port, not the SQL ownership policy or managed Git.
// A cooperative parent reaps its descendant; cancellation deliberately leaves the latter
// alive until the test releases it. IPC acknowledgments replace timing assumptions.
const processMessage = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: Schema.String,
    pid: Schema.Int,
    cwd: Schema.String,
  }),
);
const childSource = `
const { fork } = require('node:child_process');
const fs = require('node:fs');
if (process.env.OWNERSHIP_DESCENDANT === '1') {
  process.on('message', message => {
    if (message === 'hold') process.send({kind:'holding',pid:process.pid,cwd:process.cwd()});
    if (message === 'release') process.exit(0);
  });
  process.send({kind:'descendant',pid:process.pid,cwd:process.cwd()});
} else {
  const descendant = fork(__filename, [], {
    cwd: process.cwd(), env: {...process.env, OWNERSHIP_DESCENDANT:'1'},
    stdio: ['ignore','ignore','ignore','ipc']
  });
  descendant.on('message', message => process.send(message));
  descendant.on('exit', (code, signal) => process.exit(code === 0 && !signal ? 0 : 1));
  process.on('message', message => {
    if (message === 'stop') descendant.send('hold');
    if (message === 'release') descendant.send('release');
    if (message === 'write') {
      fs.appendFileSync('ownership.txt', 'owned write\\n');
      process.send({kind:'written',pid:process.pid,cwd:process.cwd()});
    }
  });
  process.send({kind:'parent',pid:process.pid,cwd:process.cwd()});
}
`;
const startWriter = Effect.fn("concurrentOwnership.startWriter")(function* (
  source: string,
  cwd: string,
) {
  const cp = process.getBuiltinModule("child_process");
  const child = cp.fork(source, [], {
    cwd,
    env: {},
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (!child.pid) return yield* Effect.die("Child has no captured PID");
  capturedPids.push(child.pid);
  const messages: ReturnType<typeof processMessage>[] = [];
  const waiters = new Map<string, (message: ReturnType<typeof processMessage>) => void>();
  child.on("message", (raw) => {
    const message = processMessage(raw);
    if (message.kind === "descendant") capturedPids.push(message.pid);
    const waiter = waiters.get(message.kind);
    if (waiter) {
      waiters.delete(message.kind);
      waiter(message);
    } else messages.push(message);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Owned child failed: ${code}/${signal}`));
    });
  });
  // Install cleanup before awaiting startup. Only this captured child and its own
  // IPC-controlled descendant are stopped; the parent waits for descendant exit.
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null && child.connected)
        child.send("release");
      await closed;
    }),
  );
  const awaitMessage = (kind: string) =>
    Effect.promise(() => {
      const index = messages.findIndex((message) => message.kind === kind);
      const retained = index < 0 ? undefined : messages.splice(index, 1)[0];
      return retained
        ? Promise.resolve(retained)
        : new Promise<ReturnType<typeof processMessage>>((resolve) => waiters.set(kind, resolve));
    });
  const parent = yield* awaitMessage("parent");
  const descendant = yield* awaitMessage("descendant");
  expect(parent.cwd).toBe(cwd);
  expect(descendant.cwd).toBe(cwd);
  expect(parent.pid).toBe(child.pid);
  expect(nativeFs.readlinkSync(`/proc/${parent.pid}/cwd`)).toBe(cwd);
  expect(nativeFs.readlinkSync(`/proc/${descendant.pid}/cwd`)).toBe(cwd);
  const command = (message: "stop" | "write", response: string) =>
    Effect.sync(() => child.send(message)).pipe(Effect.andThen(awaitMessage(response)));
  const join = Effect.promise(() => closed);
  return { parent, descendant, command, join, release: Effect.sync(() => child.send("release")) };
});

const fixture = Effect.fn("concurrentOwnership.fixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "concurrent-ownership-" });
  const primary = path.join(scratch, "primary");
  yield* fs.makeDirectory(primary);
  yield* git(primary, ["init", "--initial-branch=main"]);
  yield* git(primary, ["config", "user.name", "Ownership test"]);
  yield* git(primary, ["config", "user.email", "ownership@test.invalid"]);
  yield* fs.writeFileString(path.join(primary, "base.txt"), "base\n");
  yield* git(primary, ["add", "base.txt"]);
  yield* git(primary, ["commit", "-m", "base"]);
  const oid = yield* git(primary, ["rev-parse", "HEAD"]);
  const source = path.join(scratch, "writer.cjs");
  yield* fs.writeFileString(source, childSource);
  const claims: (typeof ProjectWorkFoundationCommitCommand.Type)[] = [];
  const intercept: ProjectWorkRepository["Service"] = {
    ...repository,
    execute: (command) => {
      if (
        command.type === "project-work.foundation.commit" &&
        command.transition?.kind === "claim"
      ) {
        claims.push(command);
        return Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain uncommitted claim"));
      }
      return repository.execute(command);
    },
  };
  expect(
    (yield* seed("implementer", "reserved", {
      roleTools: ["pi.read", "pi.write"],
      toolIds: ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(Effect.provideService(ProjectWorkRepository, intercept), Effect.result))._tag,
  ).toBe("Failure");
  const state = yield* readCurrentState(sql, projectId);
  const role = state.foundationRecords!.find((r) => r.kind === "role-revision");
  const member = state.foundationRecords!.find((r) => r.kind === "member");
  if (role?.kind !== "role-revision" || member?.kind !== "member")
    return yield* Effect.die("Missing role/member");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "concurrency",
      expectedRevision: state.revision,
      attribution,
      committedAt: at,
      records: [
        { ...member, recordId: "other-member", name: "Other" },
        { ...member, recordId: "successor", name: "Successor" },
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 2,
          modelCalls: 4,
          delegationDepth: 2,
          repairAllowance: 2,
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 60000,
        },
      ],
    }),
  );
  const secondTask = ProjectWorkTaskId.make("concurrent-other-task");
  expect(
    (yield* createManagedAssignment({
      taskId: secondTask,
      recordId: "other-binding",
      attemptId: "other-attempt",
      commandId: "other-claim",
      providerInstanceId: ProviderInstanceId.make("pi"),
      threadId: ThreadId.make("other-thread"),
      role,
      status: "reserved",
      memberId: "other-member",
      configuration: {
        instructionsHash: "hash",
        toolIds: ["pi.read", "pi.write"],
        skillIds: [],
        runtimeVersion: "test",
        maxTokens: 1000,
        maxDurationMs: 60000,
        paidFallback: false,
      },
    }).pipe(Effect.provideService(ProjectWorkRepository, intercept), Effect.result))._tag,
  ).toBe("Failure");
  yield* TestClock.setTime(Date.parse(at) + 1);
  yield* sql`UPDATE projection_projects SET workspace_root=${primary},scripts_json='[]' WHERE project_id=${projectId}`;
  const request = Effect.fn("concurrentOwnership.request")(function* (
    original: typeof ProjectWorkFoundationCommitCommand.Type,
    label: string,
  ) {
    if (original.transition?.kind !== "claim") return yield* Effect.die("Missing claim");
    const worktree = path.join(scratch, label);
    const branch = `refs/heads/${label}`;
    const claim = yield* decodeCommit({
      ...original,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...original.transition,
        binding: {
          ...original.transition.binding,
          branch,
          worktree,
          configuration: { ...original.transition.binding.configuration, maxDurationMs: 60000 },
        },
      },
    });
    const result: ProjectTeamDispatchRequest = {
      dispatchId: `${label}-dispatch`,
      claim,
      git: {
        effectId: `${label}-dispatch`,
        runId: original.transition.binding.recordId,
        generation: original.transition.binding.generation,
        primaryRoot: primary,
        commonGitDirectory: path.join(primary, ".git"),
        worktreePath: worktree,
        branchRef: branch,
        baseRef: "refs/heads/main",
        baseOid: oid,
        ownershipToken: `${label}-owner`,
        policyHash: "b".repeat(64),
      },
      setupId: `${label}-setup`,
      initializeOperationId: `${label}-initialize`,
      assignmentOperationId: `${label}-assignment`,
      assignment: "Approved isolated task",
    };
    return result;
  });
  const options = {
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    launchPolicy: { memoryBytes: 67108864, runtimeSeconds: 60 },
    protectedRoots: [primary],
    assertCurrent: () => Effect.void,
  };
  const pi = yield* makeProjectTeamPiRuntime();
  const consumer = yield* makeProjectTeamWorkspace(options).pipe(
    Effect.provideService(ProjectTeamPiRuntime, pi),
  );
  const journal = yield* makeProjectTeamDispatchJournal(options);
  const first = yield* request(claims[0]!, "first");
  const firstSnapshot = yield* journal.claimEffect((yield* journal.reserve(first)).fence);
  const second = yield* request(claims[1]!, "second");
  const secondSnapshot = yield* journal.claimEffect((yield* journal.reserve(second)).fence);
  const loanAsset = path.join(scratch, "unused-bash");
  yield* fs.writeFileString(loanAsset, "No script selected; this asset is never executed");
  yield* pi.publishAssets(
    ProviderInstanceId.make("pi"),
    {
      runtimeFiles: [{ source: loanAsset, target: "/bin/bash" }],
      revalidate: Effect.void,
      borrow: (effect) => effect,
    },
    runtime,
  );
  return {
    sql,
    repository,
    fs,
    path,
    scratch,
    primary,
    source,
    request,
    first,
    second,
    firstSnapshot,
    secondSnapshot,
    consumer,
    journal,
    options,
    pi,
    secondTask,
  };
});

const nextClaim = (
  state: Effect.Success<ReturnType<typeof readCurrentState>>,
  original: typeof ProjectWorkFoundationCommitCommand.Type,
  memberId = "successor",
) => {
  const t = original.transition;
  if (t?.kind !== "claim") throw new Error("Missing original claim");
  const assignment = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
      r.kind === "task-membership" && r.taskId === t.taskId,
  )!;
  const grant = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.recordId === assignment.assignment!.authorizationGateId,
  )!;
  const commandId = CommandId.make(`successor-${memberId}`);
  const attemptId = ProjectWorkAttemptId.make(`successor-${memberId}-attempt`);
  return {
    ...original,
    commandId,
    expectedRevision: state.revision,
    transition: {
      ...t,
      expectedTaskRevision: state.tasks.find((task) => task.taskId === t.taskId)!.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      claim: { ...t.claim, commandId, attemptId },
      binding: {
        ...t.binding,
        recordId: `successor-${memberId}-run`,
        attemptId,
        authorizationGateId: grant.recordId,
        generation: 1,
        leaseGeneration: 1,
        memberId,
      },
    },
  };
};

for (const action of ["cancel", "reassign"] as const) {
  it.effect(
    `${action} holds a real descendant while the other registered worktree remains writable`,
    () =>
      withServices(
        Effect.scoped(
          Effect.gen(function* () {
            // This container maps /usr/bin/git to the current UID. Normalize only this
            // executable's lstat UID for the disposable fixture; production guard is unchanged.
            const lstat = nativeFs.lstatSync;
            const spy = vi
              .spyOn(nativeFs, "lstatSync")
              .mockImplementation((...args: Parameters<typeof lstat>) => {
                const stat = lstat(...args);
                if (args[0] === "/usr/bin/git" && stat && typeof stat.uid === "bigint")
                  return Object.assign(stat, { uid: 0n });
                return stat;
              });
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            const f = yield* fixture();
            const gateway = yield* ProjectWorkGateway;
            const firstWorkspace = yield* f.consumer.workspace(f.firstSnapshot);
            const secondWorkspace = yield* f.consumer.workspace(f.secondSnapshot);
            expect(firstWorkspace.workspace.worktree.path).not.toBe(
              secondWorkspace.workspace.worktree.path,
            );
            expect(firstWorkspace.workspace.assignment.branchRef).not.toBe(
              secondWorkspace.workspace.assignment.branchRef,
            );
            const listing = yield* git(f.primary, ["worktree", "list", "--porcelain"]);
            for (const request of [f.first, f.second]) {
              const registration = listing
                .split("\n\n")
                .find((entry) => entry.startsWith(`worktree ${request.git.worktreePath}\n`));
              expect(registration?.split("\n")).toContain(`branch ${request.git.branchRef}`);
              expect(yield* git(request.git.worktreePath, ["symbolic-ref", "HEAD"])).toBe(
                request.git.branchRef,
              );
            }
            const reopened = yield* makeProjectTeamWorkspace(f.options).pipe(
              Effect.provideService(ProjectTeamPiRuntime, f.pi),
            );
            expect(yield* reopened.workspace(f.firstSnapshot)).toEqual(firstWorkspace);
            expect(yield* reopened.workspace(f.secondSnapshot)).toEqual(secondWorkspace);
            const operationScope = yield* Scope.Scope;
            const stages = yield* makeProjectTeamDispatchJournal({
              ...f.options,
              verifyStage: (_receipt, snapshot) =>
                reopened
                  .verifyWorkspace(
                    snapshot,
                    snapshot.fence.dispatchId === f.first.dispatchId
                      ? firstWorkspace.workspace
                      : secondWorkspace.workspace,
                  )
                  .pipe(
                    Effect.provideService(Scope.Scope, operationScope),
                    Effect.mapError(
                      () =>
                        new ProjectTeamDispatchJournalError({
                          reason: "Physical workspace changed",
                        }),
                    ),
                  ),
            });
            let firstSnapshot: ProjectTeamDispatchSnapshot = yield* stages.advanceStage(
              f.firstSnapshot.fence,
              {
                receiptId: "first-workspace",
                stage: "workspace-ready",
                evidence: firstWorkspace,
              },
            );
            let secondSnapshot: ProjectTeamDispatchSnapshot = yield* stages.advanceStage(
              f.secondSnapshot.fence,
              {
                receiptId: "second-workspace",
                stage: "workspace-ready",
                evidence: secondWorkspace,
              },
            );
            // Drive the real dispatcher with actual setup/workspace consumers. Only the
            // provider session/assignment port is replaced by our IPC Node process fixture.
            type Setup = Effect.Success<ReturnType<typeof reopened.setup>>;
            type Session = { pid: number; cwd: string };
            type Receipt = ProjectTeamDispatchReceipt<Setup, Session, Session>;
            const runDispatch = Effect.fn("concurrentOwnership.runDispatch")(function* (
              initial: typeof firstSnapshot,
              physical: typeof firstWorkspace,
            ) {
              let receipt: Receipt = { stage: "workspace-ready", ...physical };
              let writer: Effect.Success<ReturnType<typeof startWriter>> | undefined;
              const error = () =>
                new ProjectTeamDispatchError({ reason: "OS fixture dispatch port denied" });
              const durable = yield* makeProjectTeamDispatchJournal({
                ...f.options,
                verifyStage: (incoming, snapshot) =>
                  Effect.gen(function* () {
                    expect(incoming.evidence).toEqual(receipt);
                    yield* reopened.verifyWorkspace(snapshot, receipt.workspace);
                    if (receipt.stage !== "workspace-ready")
                      yield* reopened.verifySetup(snapshot, receipt.workspace, receipt.setup);
                    if (
                      receipt.stage === "session-bound" ||
                      receipt.stage === "assignment-intent" ||
                      receipt.stage === "assignment-observed"
                    ) {
                      expect(receipt.session).toEqual(writer?.parent);
                      expect(nativeFs.readlinkSync(`/proc/${receipt.session.pid}/cwd`)).toBe(
                        receipt.workspace.worktree.path,
                      );
                    }
                  }).pipe(
                    Effect.provideService(Scope.Scope, operationScope),
                    Effect.mapError(
                      () =>
                        new ProjectTeamDispatchJournalError({
                          reason: "OS fixture stage verification failed",
                        }),
                    ),
                  ),
              });
              const ports: ProjectTeamDispatchPorts<
                object,
                object,
                Setup,
                Session,
                Session,
                ProjectTeamDispatchError,
                Scope.Scope
              > = {
                withExecutor: (_id, run) => run(initial),
                withRecoveryExecutor: (claim, run) =>
                  claim === initial ? run(initial, initial) : Effect.fail(error()),
                inspect: (id) => durable.inspect(id).pipe(Effect.mapError(error)),
                claimEffect: (_owner, fence) =>
                  durable.claimEffect(fence).pipe(Effect.mapError(error)),
                assertCurrent: (_owner, fence) =>
                  durable.inspect(fence.dispatchId).pipe(
                    Effect.tap((current) =>
                      Effect.sync(() => expect(current.fence).toEqual(fence)),
                    ),
                    Effect.mapError(error),
                  ),
                readReceipt: () => Effect.succeed(receipt),
                appendStage: (_owner, snapshot, next) =>
                  Effect.gen(function* () {
                    const evidence = yield* decodeStageEvidence(next);
                    receipt = next;
                    return yield* durable.advanceStage(snapshot.fence, {
                      receiptId: `${snapshot.fence.dispatchId}-${next.stage}`,
                      stage: next.stage,
                      evidence,
                    });
                  }).pipe(Effect.mapError(error)),
                withWorkspace: (_owner, snapshot, use) =>
                  reopened.withWorkspace(snapshot, use).pipe(Effect.mapError(error)),
                setup: (_owner, snapshot, workspace) =>
                  reopened.setup(snapshot, workspace).pipe(Effect.mapError(error)),
                initialize: (_owner, _snapshot, workspace) =>
                  Effect.gen(function* () {
                    writer = yield* startWriter(f.source, workspace.worktree.path);
                    return writer.parent;
                  }),
                sendAssignment: () =>
                  Effect.gen(function* () {
                    if (!writer) return yield* error();
                    const written = yield* writer.command("write", "written");
                    return { _tag: "Observed" as const, receipt: written };
                  }),
                readAssignmentObservation: () =>
                  Effect.succeed(
                    receipt.stage === "assignment-observed" ? receipt.assignment : undefined,
                  ),
                recordUncertain: () => Effect.die("Unexpected lost OS assignment acknowledgment"),
                stopAndJoin: () =>
                  Effect.gen(function* () {
                    if (writer) {
                      yield* writer.release;
                      yield* writer.join;
                    }
                  }),
              };
              const dispatcher = makeProjectTeamDispatch(ports);
              expect((yield* dispatcher.resume(initial))._tag).toBe("Observed");
              const snapshot = yield* durable.inspect(initial.fence.dispatchId);
              expect(snapshot.fence.stage).toBe("assignment-observed");
              // Restarting ordinary dispatch cannot resend an already claimed assignment.
              expect(
                (yield* makeProjectTeamDispatch(ports).dispatch(initial.fence.dispatchId))._tag,
              ).toBe("RecoveryRequired");
              if (!writer) return yield* Effect.die("Dispatcher did not initialize its OS writer");
              return { writer, snapshot };
            });
            const firstDispatch = yield* runDispatch(firstSnapshot, firstWorkspace);
            const secondDispatch = yield* runDispatch(secondSnapshot, secondWorkspace);
            firstSnapshot = firstDispatch.snapshot;
            secondSnapshot = secondDispatch.snapshot;
            const first = firstDispatch.writer;
            const second = secondDispatch.writer;
            for (const writer of [first, second]) {
              expect(nativeFs.existsSync(`/proc/${writer.parent.pid}`)).toBe(true);
              expect(nativeFs.existsSync(`/proc/${writer.descendant.pid}`)).toBe(true);
            }
            const setup = yield* reopened.setup(firstSnapshot, firstWorkspace.workspace);
            expect(setup.outcome).toBe("skipped");
            const restarted = yield* makeProjectTeamWorkspace(f.options).pipe(
              Effect.provideService(ProjectTeamPiRuntime, f.pi),
            );
            expect(yield* restarted.setup(firstSnapshot, firstWorkspace.workspace)).toEqual(setup);
            const setupJournal = yield* makeProjectManagedSetupJournal({
              ...f.options,
              validateSelection: () =>
                Effect.fail(
                  new ProjectManagedSetupError({ reason: "No new selection in recovery" }),
                ),
            });
            const input = {
              setupId: f.first.setupId,
              dispatchId: f.first.dispatchId,
              bindingId: "binding",
              generation: 0,
              threadId:
                firstSnapshot.intent.compiledClaim.transition!.kind === "claim"
                  ? firstSnapshot.intent.compiledClaim.transition.binding.threadId
                  : ThreadId.make("missing"),
              worktreePath: f.first.git.worktreePath,
              deadlineAtMs: firstSnapshot.intent.limits.deadlineAtMs,
            };
            const retained = yield* setupJournal.read(input);
            if (!retained) return yield* Effect.die("Missing setup selection");
            const { uncertain: _uncertain, ...expected } = retained;
            yield* setupJournal.markUncertain(input, {
              expected,
              selection: retained.selection,
              allocation: null,
              owner: null,
              drain: null,
              reconciliation: null,
              reason: "Retained uncertainty prohibits rerun",
            });
            expect(
              (yield* restarted.setup(firstSnapshot, firstWorkspace.workspace).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect((yield* restarted.reconcile(firstSnapshot).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* setupJournal.read(input))?.uncertain).toBe(true);
            expect(
              yield* f.fs.readFileString(f.path.join(f.first.git.worktreePath, "ownership.txt")),
            ).toBe("owned write\n");
            const control = Effect.fn("concurrentOwnership.control")(function* (
              id: string,
              value: Extract<
                ProjectTeamGuidedIntent,
                { type: "project-team.task.control" }
              >["control"],
            ) {
              const state = yield* readCurrentState(f.sql, projectId);
              return yield* gateway.write(
                {
                  type: "project-team.task.control",
                  projectId,
                  taskId,
                  commandId: CommandId.make(id),
                  expectedRevision: state.revision,
                  expectedTaskRevision: state.tasks.find((t) => t.taskId === taskId)!.revision,
                  control: value,
                },
                { kind: "human", id: "maintainer" },
                { kind: "web", id: "ownership-device" },
              );
            });
            const otherBefore = (yield* readCurrentState(f.sql, projectId)).foundationRecords!.find(
              (r) => r.recordId === "other-binding",
            );
            const otherDispatch = yield* f.journal.readRetained(f.second.dispatchId);
            const originalStages = yield* f.journal.readStageReceipts(f.first.dispatchId);
            expect(originalStages.map((receipt) => receipt.stage)).toEqual([
              "workspace-ready",
              "setup-complete",
              "session-bound",
              "assignment-intent",
              "assignment-observed",
            ]);
            const retainedWorkspaces =
              yield* f.sql`SELECT * FROM project_team_workspace_receipt ORDER BY dispatch_id`;
            yield* control(
              `control-${action}`,
              action === "reassign"
                ? {
                    action,
                    reason: "Transfer exact owner",
                    recipientMemberId: "successor",
                    expectedMemberRevision: 0,
                  }
                : { action, reason: "Stop exact owner" },
            );
            yield* first.command("stop", "holding");
            expect(nativeFs.existsSync(`/proc/${first.descendant.pid}`)).toBe(true);
            const stopped = yield* readCurrentState(f.sql, projectId);
            expect(stopped.foundationRecords!.find((r) => r.recordId === "binding")).toMatchObject({
              status: "stopping",
            });
            const held = yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`;
            expect(held).toHaveLength(2);
            const resumeAction = action === "cancel" ? "reopen" : "resume";
            expect(
              yield* control("too-early", {
                action: resumeAction,
                reason: "Try before physical join",
              }).pipe(Effect.result),
            ).toMatchObject({
              _tag: "Failure",
              failure: { message: expect.stringContaining("authoritatively drained") },
            });
            // Even an explicit new dispatch cannot bypass the stopped task's admission.
            const premature = yield* f.request(nextClaim(stopped, f.first.claim), "successor");
            expect((yield* f.journal.reserve(premature).pipe(Effect.result))._tag).toBe("Failure");
            expect(yield* f.fs.exists(premature.git.worktreePath)).toBe(false);
            expect(yield* readCurrentState(f.sql, projectId)).toEqual(stopped);
            expect(
              yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
            ).toEqual(held);
            expect(
              yield* f.sql`SELECT * FROM project_team_dispatch_receipt WHERE stage='settled'`,
            ).toEqual([]);
            expect((yield* reopened.workspace(firstSnapshot).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            yield* reopened.verifyWorkspace(secondSnapshot, secondWorkspace.workspace);
            // Each write consumes its own IPC acknowledgment.
            const before = yield* f.fs.readFileString(
              f.path.join(f.second.git.worktreePath, "ownership.txt"),
            );
            yield* second.command("write", "written");
            yield* first.release;
            yield* first.join;
            expect(nativeFs.existsSync(`/proc/${first.parent.pid}`)).toBe(false);
            expect(nativeFs.existsSync(`/proc/${first.descendant.pid}`)).toBe(false);
            expect(
              yield* control("joined-but-unsettled", {
                action: resumeAction,
                reason: "Physical exit alone is not durable settlement",
              }).pipe(Effect.result),
            ).toMatchObject({ _tag: "Failure" });
            expect((yield* f.journal.reserve(premature).pipe(Effect.result))._tag).toBe("Failure");
            const terminal = {
              receiptId: `physical-join-${action}`,
              stage: "settled" as const,
              evidence: {
                dispatchId: f.first.dispatchId,
                bindingId: "binding",
                claimGeneration: firstSnapshot.fence.claimGeneration,
              },
            };
            const settling = yield* makeProjectTeamDispatchJournal({
              ...f.options,
              verifyStage: (receipt, snapshot) =>
                Effect.gen(function* () {
                  yield* first.join;
                  expect(receipt).toEqual(terminal);
                  expect(snapshot.fence.dispatchId).toBe(f.first.dispatchId);
                }),
              verifySettlement: (receipt, snapshot) =>
                Effect.gen(function* () {
                  yield* first.join;
                  expect(nativeFs.existsSync(`/proc/${first.parent.pid}`)).toBe(false);
                  expect(nativeFs.existsSync(`/proc/${first.descendant.pid}`)).toBe(false);
                  expect(receipt.evidence).toEqual(terminal.evidence);
                  expect(snapshot.fence.dispatchId).toBe(f.first.dispatchId);
                  expect(snapshot.fence.claimGeneration).toBe(firstSnapshot.fence.claimGeneration);
                }),
            });
            yield* settling.settleAfterJoined(firstSnapshot.fence, terminal);
            const drained = yield* readCurrentState(f.sql, projectId);
            const oldBinding = drained.foundationRecords!.find((r) => r.recordId === "binding");
            expect(oldBinding).toMatchObject({
              status: "settled",
              memberId: "member",
              attemptId: "attempt",
              worktree: f.first.git.worktreePath,
              branch: f.first.git.branchRef,
            });
            expect(drained.attempts.find((a) => a.attemptId === "attempt")?.state).toBe("canceled");
            expect(drained.foundationRecords!.find((r) => r.recordId === "other-binding")).toEqual(
              otherBefore,
            );
            expect(yield* f.journal.readRetained(f.second.dispatchId)).toEqual(otherDispatch);
            expect(
              yield* f.fs.readFileString(f.path.join(f.second.git.worktreePath, "ownership.txt")),
            ).toBe(before + "owned write\n");
            expect(
              yield* f.sql`SELECT status FROM project_team_reservation WHERE status='held'`,
            ).toHaveLength(1);
            yield* control("after-physical-join", {
              action: resumeAction,
              reason: "Successor after joined settlement",
            });
            const resumed = yield* readCurrentState(f.sql, projectId);
            if (action === "reassign")
              expect(
                (yield* f.repository
                  .execute(nextClaim(resumed, f.first.claim, "member"))
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            const successorRequest = yield* f.request(
              nextClaim(resumed, f.first.claim, action === "reassign" ? "successor" : "member"),
              "successor",
            );
            const successorSnapshot = yield* f.journal.claimEffect(
              (yield* f.journal.reserve(successorRequest)).fence,
            );
            const successorWorkspace = yield* reopened.workspace(successorSnapshot);
            expect(successorWorkspace.workspace.worktree.path).toBe(
              successorRequest.git.worktreePath,
            );
            const successor = yield* startWriter(f.source, successorRequest.git.worktreePath);
            yield* successor.command("write", "written");
            expect(
              yield* f.fs.readFileString(
                f.path.join(successorRequest.git.worktreePath, "ownership.txt"),
              ),
            ).toBe("owned write\n");
            expect(
              yield* f.fs.readFileString(f.path.join(f.first.git.worktreePath, "ownership.txt")),
            ).toBe("owned write\n");
            const current = yield* readCurrentState(f.sql, projectId);
            expect((yield* f.journal.readRetained(f.first.dispatchId)).intent).toEqual(
              firstSnapshot.intent,
            );
            expect(
              yield* f.sql`SELECT * FROM project_team_workspace_receipt WHERE dispatch_id <> ${successorRequest.dispatchId} ORDER BY dispatch_id`,
            ).toEqual(retainedWorkspaces);
            expect(yield* f.fs.exists(f.path.join(f.primary, "ownership.txt"))).toBe(false);
            expect(current.foundationRecords!.find((r) => r.recordId === "binding")).toEqual(
              oldBinding,
            );
            expect(
              (yield* f.journal.readStageReceipts(f.first.dispatchId)).slice(
                0,
                originalStages.length,
              ),
            ).toEqual(originalStages);
            expect(
              (yield* settling.settleAfterJoined(firstSnapshot.fence, terminal)).duplicate,
            ).toBe(true);
            expect(yield* readCurrentState(f.sql, projectId)).toEqual(current);
          }),
        ),
      ),
    30000,
  );
}

afterAll(() => {
  expect(vi.isMockFunction(nativeFs.lstatSync)).toBe(false);
  for (const pid of capturedPids)
    expect(nativeFs.existsSync(`/proc/${pid}`), `captured PID ${pid} joined`).toBe(false);
});
