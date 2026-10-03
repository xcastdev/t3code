import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  type ProjectScript,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import {
  at,
  attribution,
  projectId,
  seed,
  scoped,
} from "../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "../projectWork/ProjectTeamDispatchJournal.ts";
import { ProjectWorkRepository, readCurrentState } from "../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "../projectWork/ProjectWorkPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ProjectManagedSetupError,
  type ProjectManagedSetupReceipt,
} from "./ProjectManagedSetup.ts";
import { makeProjectManagedSetupJournal } from "./ProjectManagedSetupJournal.ts";
import { makeProjectManagedSetupRuntime } from "./ProjectManagedSetupRuntime.ts";
import { RepositoryIdentityResolver } from "./RepositoryIdentityResolver.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const script: ProjectScript = {
  id: "setup-script",
  name: "Prepare",
  icon: "configure",
  command: "printf prepared",
  runOnWorktreeCreate: true,
  async: true,
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const queryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
);

// SQL and current-service controls use real disposable files and a controlled host-control
// response. Synthetic ownership below is never evidence of a Linux service or kernel drain.
const fixture = Effect.fn("setupRuntimeTest.fixture")(function* (native = false) {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* native
    ? fs.makeTempDirectory({ prefix: "setup-runtime-native-" })
    : fs.makeTempDirectoryScoped({ prefix: "setup-runtime-" });
  const primary = path.join(scratch, "primary");
  const worktree = path.join(scratch, "worktree");
  const protectedRoot = path.join(scratch, "protected");
  for (const root of [primary, worktree, protectedRoot]) yield* fs.makeDirectory(root);
  yield* fs.writeFileString(path.join(worktree, ".git"), "fixture-owned-private-metadata");
  const originalIdentity = yield* fs.stat(worktree);
  const originalPrimary = yield* fs.stat(primary);
  const originalGit = yield* fs.stat(path.join(worktree, ".git"));
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  const seeded = yield* seed("implementer", "reserved", {
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
  expect(seeded._tag).toBe("Failure");
  if (!pending || pending.transition?.kind !== "claim") return yield* Effect.die("Missing claim");
  const now = native ? yield* Clock.currentTimeMillis : Date.parse(at) + 1;
  if (!native) yield* TestClock.setTime(now);
  const committedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "configure-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: committedAt,
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
  yield* sql`UPDATE projection_projects SET workspace_root=${primary},scripts_json=${encode([script])} WHERE project_id=${projectId}`;
  const claim = yield* decodeCommit({
    ...pending,
    committedAt,
    expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
    transition: {
      ...pending.transition,
      binding: {
        ...pending.transition.binding,
        branch: "refs/heads/assigned",
        worktree,
        configuration: { ...pending.transition.binding.configuration, maxDurationMs: 60000 },
      },
      claim: { ...pending.transition.claim, claimedAt: committedAt },
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
      baseOid: "a".repeat(40),
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
  const transition = snapshot.intent.compiledClaim.transition;
  if (transition?.kind !== "claim") return yield* Effect.die("Missing binding");
  yield* sql`UPDATE project_team_dispatch SET stage='workspace-ready',revision=2`;
  const input = {
    setupId: "setup",
    dispatchId: "dispatch",
    bindingId: "binding",
    generation: 0,
    threadId: transition.binding.threadId,
    worktreePath: worktree,
    deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
  };
  const settings = yield* ServerSettings.ServerSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const counts = { native: 0, controls: 0, workspace: 0, assets: 0 };
  const capturedPids: number[] = [];
  const capturedHosts: Array<{
    pid: number;
    command: string;
    stat: string;
    status: string;
    cgroup: string;
  }> = [];
  const readProc = (pid: number, field: string) =>
    fs.readFileString(`/proc/${pid}/${field}`).pipe(Effect.catch(() => Effect.succeed("absent")));
  const controlledSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = {
    ...spawner,
    spawn: (command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      if (command.command === "/usr/bin/systemd-run") counts.native++;
      if (native)
        return spawner.spawn(command).pipe(
          Effect.tap(
            Effect.fn("setupRuntimeTest.captureHostSpawn")(function* (child) {
              const pid = Number(child.pid);
              capturedPids.push(pid);
              const observed = {
                pid,
                command: command.command,
                stat: yield* readProc(pid, "stat"),
                status: yield* readProc(pid, "status"),
                cgroup: yield* readProc(pid, "cgroup"),
              };
              capturedHosts.push(observed);
              const evidence = process.env.PROJECT_MANAGED_SETUP_RUNTIME_EVIDENCE_DIR;
              if (evidence)
                yield* fs.writeFileString(
                  path.join(evidence, `host-spawn-${pid}.json`),
                  encode(observed),
                );
            }),
          ),
        );
      counts.controls++;
      if (command.command === "/usr/bin/bwrap")
        return spawner.spawn(
          ChildProcess.make("/usr/bin/printf", ["controlled-unavailable\n"], { extendEnv: false }),
        );
      if (command.command === "/usr/bin/systemctl")
        return spawner.spawn(
          ChildProcess.make(
            "/usr/bin/printf",
            [
              "LoadState=not-found\nDescription=\nInvocationID=\nControlGroup=\nActiveState=inactive\nKillMode=\nRestart=\nRuntimeMaxUSec=\nTimeoutStopUSec=\nUnsetEnvironment=\nEnvironment=\n",
            ],
            { extendEnv: false },
          ),
        );
      return Effect.die("Default fixture refuses native service allocation");
    },
  };
  const revalidateRuntimeAssets: Effect.Effect<void, ProjectManagedSetupError> = Effect.sync(() => {
    counts.assets++;
  });
  const options = {
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    launchPolicy: { memoryBytes: 67108864, runtimeSeconds: 60 },
    runtimeFiles: [
      { source: "/usr/bin/bash", target: "/bin/bash" },
      { source: "/usr/bin/sleep", target: "/bin/sleep" },
      ...[
        "/lib64/ld-linux-x86-64.so.2",
        "/usr/lib/libc.so.6",
        "/usr/lib/libreadline.so.8",
        "/usr/lib/libncursesw.so.6",
      ].map((source) => ({ source, target: source })),
    ],
    protectedRoots: [protectedRoot],
    protectedWorkspaceEntries: [".git"],
    revalidateRuntimeAssets,
    // Controlled registration callback proves factory ordering and physical identity checks;
    // full actual managed-Git registration and branch policy remain the parent's V8 gate.
    assertWorkspace: Effect.fn("setupRuntimeTest.assertWorkspace")(
      function* (actualInput, actualSnapshot) {
        counts.workspace++;
        const identity = yield* fs.stat(worktree);
        const currentPrimary = yield* fs.stat(primary);
        const git = yield* fs.stat(path.join(worktree, ".git"));
        if (
          actualInput.worktreePath !== worktree ||
          actualSnapshot.intent.request.git.primaryRoot !== primary ||
          identity.dev !== originalIdentity.dev ||
          identity.ino._tag !== "Some" ||
          originalIdentity.ino._tag !== "Some" ||
          identity.ino.value !== originalIdentity.ino.value ||
          currentPrimary.dev !== originalPrimary.dev ||
          canonicalProjectWorkPayload(currentPrimary.ino) !==
            canonicalProjectWorkPayload(originalPrimary.ino) ||
          git.dev !== originalGit.dev ||
          canonicalProjectWorkPayload(git.ino) !== canonicalProjectWorkPayload(originalGit.ino)
        )
          return yield* new ProjectManagedSetupError({
            reason: "Registered workspace identity changed",
          });
      },
      Effect.mapError(
        () => new ProjectManagedSetupError({ reason: "Registered workspace identity changed" }),
      ),
    ),
  } satisfies Parameters<typeof makeProjectManagedSetupRuntime>[0];
  for (const file of options.runtimeFiles) file.source = yield* fs.realPath(file.source);
  const make = () =>
    makeProjectManagedSetupRuntime(options).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, controlledSpawner),
    );
  const setup = yield* make();
  const journal = yield* makeProjectManagedSetupJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    validateSelection: () => Effect.void,
  });
  const freeze = Effect.gen(function* () {
    const result = yield* setup.execute(input).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    const retained = yield* journal.read(input);
    if (!retained?.allocation || retained.selection.kind !== "script")
      return yield* Effect.die(encode({ result, retained }));
    return retained;
  });
  return {
    sql,
    fs,
    path,
    scratch,
    primary,
    worktree,
    protectedRoot,
    settings,
    query,
    setup,
    journal,
    input,
    options,
    counts,
    capturedPids,
    capturedHosts,
    readProc,
    make,
    freeze,
  };
});
const withServices = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  settings = ServerSettings.layerTest(),
) => scoped(body.pipe(Effect.provide(Layer.merge(queryLayer, settings))));

it.effect("skips once and replays through current project/settings/workspace checks", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
        });
        const receipt = yield* f.setup.execute(f.input);
        expect(receipt.outcome).toBe("skipped");
        expect(yield* f.setup.execute(f.input)).toEqual(receipt);
        expect(f.counts.native).toBe(0);
        expect(f.counts.controls).toBe(0);
        expect(f.counts.workspace).toBeGreaterThan(1);
        expect(f.counts.assets).toBe(f.counts.workspace);
      }),
    ),
  ),
);

it.effect("freezes full shared selection, exact Bash argv, original policy and Git entries", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const retained = yield* f.freeze;
        expect(retained.selection.kind).toBe("script");
        if (retained.selection.kind !== "script") return;
        expect(retained.selection.launch.argv).toEqual(["/bin/bash", "-c", script.command]);
        expect(retained.selection.launch.nativeStateRoot).toBeUndefined();
        expect(retained.selection.launch.protectedWorkspaceEntries).toEqual([".git"]);
        expect(retained.selection.launch.workspaceRoot).toBe(f.worktree);
        expect(retained.allocation?.policy).toEqual({ memoryBytes: 67108864, runtimeSeconds: 60 });
        expect(retained.selection.scriptRevision).toMatch(/^[a-f0-9]{64}$/);
        expect(f.counts.native).toBe(0);
      }),
    ),
  ),
);

for (const patch of [
  { command: "printf changed" },
  { name: "Changed name" },
  { async: false },
  { runOnWorktreeCreate: false },
  { previewUrl: "https://example.invalid/preview" },
])
  it.effect(`denies stale selection after ${Object.keys(patch)[0]} changes`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.freeze;
          yield* f.settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: { defaultProjectScripts: [{ ...script, ...patch }] },
            },
          });
          const before = f.counts.controls;
          const result = yield* f.setup.execute(f.input).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(f.counts.controls).toBe(before);
          expect(f.counts.native).toBe(0);
        }),
      ),
    ),
  );

for (const mode of [
  "deleted",
  "root-changed",
  "recreated-primary",
  "recreated-worktree",
  "git-replaced",
] as const)
  it.effect(`denies ${mode} before host allocation`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          if (mode === "deleted") yield* f.sql`UPDATE projection_projects SET deleted_at=${at}`;
          if (mode === "root-changed")
            yield* f.sql`UPDATE projection_projects SET workspace_root='/replacement'`;
          if (mode === "recreated-primary") {
            yield* f.fs.rename(f.primary, f.primary + "-retained");
            yield* f.fs.makeDirectory(f.primary);
          }
          if (mode === "recreated-worktree") {
            yield* f.fs.rename(f.worktree, f.worktree + "-retained");
            yield* f.fs.makeDirectory(f.worktree);
            yield* f.fs.writeFileString(f.path.join(f.worktree, ".git"), "replacement");
          }
          if (mode === "git-replaced") {
            yield* f.fs.rename(
              f.path.join(f.worktree, ".git"),
              f.path.join(f.worktree, ".git-retained"),
            );
            yield* f.fs.writeFileString(f.path.join(f.worktree, ".git"), "replacement");
          }
          expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
          expect(f.counts.native).toBe(0);
          expect(f.counts.controls).toBe(0);
        }),
      ),
    ),
  );

it.effect("captures service objects and options before later caller substitutions", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.options.launchPolicy.runtimeSeconds = 3600;
        f.options.runtimeFiles[0]!.target = "/runtime/replacement";
        f.options.protectedWorkspaceEntries[0] = "untrusted";
        f.options.assertWorkspace = () =>
          Effect.fail(new ProjectManagedSetupError({ reason: "replacement callback" }));
        const query = {
          ...f.query,
          getProjectShellById: () => Effect.die("replacement query used"),
        };
        const settings = { ...f.settings, getSettings: Effect.die("replacement settings used") };
        const retained = yield* f.freeze.pipe(
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(ServerSettings.ServerSettingsService, settings),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
        expect(retained.allocation?.policy.runtimeSeconds).toBe(60);
        expect(retained.allocation?.launch.argv[0]).toBe("/bin/bash");
        expect(
          retained.selection.kind === "script" &&
            retained.selection.launch.protectedWorkspaceEntries,
        ).toEqual([".git"]);
        expect(f.counts.native).toBe(0);
      }),
    ),
  ),
);

it.effect("asset revalidation denies stale retained selection before acquisition", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.freeze;
        f.options.revalidateRuntimeAssets = Effect.fail(
          new ProjectManagedSetupError({ reason: "borrowed stage changed" }),
        );
        const setup = yield* f.make();
        const before = f.counts.controls;
        expect((yield* setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.counts.controls).toBe(before);
        expect(f.counts.native).toBe(0);
        expect(yield* f.fs.exists(f.protectedRoot)).toBe(true);
      }),
    ),
  ),
);

it.effect(
  "a lost claim response never repeats a script or treats unit absence as known history",
  () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const retained = yield* f.freeze;
          if (!retained.allocation) return;
          yield* f.journal
            .claimActivation(f.input, retained.selection, retained.allocation)
            .pipe(Effect.andThen(Effect.fail("response lost")), Effect.result);
          const before = f.counts.controls;
          expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
          expect(f.counts.controls).toBe(before);
          expect((yield* f.setup.reconcile(f.input).pipe(Effect.result))._tag).toBe("Failure");
          const current = yield* f.journal.read(f.input);
          expect(current?.uncertain).toBe(true);
          expect(current?.activation).toBe("claimed");
          expect(current?.allocation).toEqual(retained.allocation);
          expect(f.counts.native).toBe(0);
        }),
      ),
    ),
);

it.effect("reconciles an original unlaunched allocation without running a script", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const retained = yield* f.freeze;
        const receipt = yield* f.setup.reconcile(f.input);
        expect(receipt.outcome).toBe("failed");
        expect(receipt.reconciliation?.state).toBe("absent");
        expect(receipt.allocation).toEqual(retained.allocation);
        expect(yield* f.setup.execute(f.input)).toEqual(receipt);
        expect(f.counts.native).toBe(0);
      }),
    ),
  ),
);

it.effect("legacy records retain uncertainty and never gain fresh launch permission", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.freeze;
        yield* f.sql`DELETE FROM project_team_setup_process WHERE setup_id=${f.input.setupId}`;
        yield* f.sql`INSERT INTO project_team_setup_process
      (setup_id,dispatch_id,unit,selection_json,allocation_json,status,input_json,activation)
      VALUES (${f.input.setupId},${f.input.dispatchId},${original.allocation?.unit},${encode(original.selection)},${encode(original.allocation)},'uncertain',NULL,'claimed')`;
        expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.setup.reconcile(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.counts.native).toBe(0);
        const rows = yield* f.sql`SELECT status,allocation_json FROM project_team_setup_process`;
        expect(rows[0]?.status).toBe("uncertain");
        expect(rows[0]?.allocation_json).not.toBeNull();
      }),
    ),
  ),
);

for (const [memoryBytes, runtimeSeconds] of [
  [16777215, 60],
  [2147483649, 60],
  [67108864, 0],
  [67108864, 3601],
])
  it.effect(`rejects resource policy ${memoryBytes}/${runtimeSeconds}`, () =>
    withServices(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.options.launchPolicy = { memoryBytes: memoryBytes!, runtimeSeconds: runtimeSeconds! };
          expect((yield* f.make().pipe(Effect.result))._tag).toBe("Failure");
          expect(f.counts.controls).toBe(0);
          expect(f.counts.native).toBe(0);
        }),
      ),
    ),
  );

it.effect("a completed skip becomes stale when a setup script is selected", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
        });
        expect((yield* f.setup.execute(f.input)).outcome).toBe("skipped");
        yield* f.settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [script] } },
        });
        expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.counts.controls).toBe(0);
        expect(f.counts.native).toBe(0);
      }),
    ),
  ),
);

it.effect("folded environment defaults replace legacy aggregate scripts", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const selected = { ...script, id: "environment-setup", command: "printf environment" };
        yield* f.settings.updateSettings({
          defaultProjectScripts: [selected],
        });
        const frozen = yield* f.freeze;
        expect(frozen.selection.kind === "script" && frozen.selection.scriptId).toBe(selected.id);
        expect(frozen.selection.kind === "script" && frozen.selection.launch.argv).toEqual([
          "/bin/bash",
          "-c",
          selected.command,
        ]);
        yield* f.settings.updateSettings({ defaultProjectScripts: [] });
        const before = f.counts.controls;
        expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.counts.controls).toBe(before);
        expect(f.counts.native).toBe(0);
      }),
    ),
    ServerSettings.layerTest({ projectSettingsFolded: true }),
  ),
);

it.effect("a lost owner response keeps its captured identity and reconciles without relaunch", () =>
  withServices(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.freeze;
        if (!original.allocation) return;
        const allocation = original.allocation;
        const owner = {
          type: "owner" as const,
          unit: allocation.unit,
          nonce: allocation.nonce,
          invocation: "a".repeat(32),
          cgroup: "/sys/fs/cgroup/controlled-fixture/" + allocation.unit,
          pid: 12345,
          memoryBytes: allocation.policy.memoryBytes,
          swapBytes: 0,
          oomGroup: 1,
        };
        yield* f.journal.claimActivation(f.input, original.selection, allocation);
        yield* f.journal
          .persistOwner(f.input, allocation, owner)
          .pipe(Effect.andThen(Effect.fail("owner response lost")), Effect.result);
        const before = f.counts.controls;
        expect((yield* f.setup.execute(f.input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.counts.controls).toBe(before);
        expect((yield* f.journal.read(f.input))?.owner).toEqual(owner);
        const receipt = yield* f.setup.reconcile(f.input);
        expect(receipt.owner).toEqual(owner);
        expect(receipt.allocation).toEqual(allocation);
        expect(receipt.outcome).toBe("failed");
        expect(receipt.reconciliation?.state).toBe("drained");
        expect(f.counts.native).toBe(0);
      }),
    ),
  ),
);

// Root approved only this constructive command, copied from the existing benign setup gate.
// This exercises native setup composition; the registered-Git callback remains controlled.
describe.runIf(process.env.PROJECT_MANAGED_SETUP_RUNTIME_NATIVE_GATE === "1")(
  "native setup runtime",
  () => {
    it.live(
      "persists real ownership, joins output and descendants, then replays without launch",
      () =>
        withServices(
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(true);
              const evidenceDirectory = process.env.PROJECT_MANAGED_SETUP_RUNTIME_EVIDENCE_DIR;
              if (evidenceDirectory)
                yield* f.fs.writeFileString(
                  f.path.join(evidenceDirectory, "fixture-prepared.json"),
                  encode({
                    scratch: f.scratch,
                    input: f.input,
                    options: {
                      launchPolicy: f.options.launchPolicy,
                      runtimeFiles: f.options.runtimeFiles,
                      protectedRoots: f.options.protectedRoots,
                      protectedWorkspaceEntries: f.options.protectedWorkspaceEntries,
                    },
                  }),
                );
              const command =
                "printf prepared > /workspace/setup-marker; /bin/sleep 30 & printf '%s' \"$!\" > /workspace/descendant; printf setup-complete; exit 0";
              yield* f.settings.updateSettings({
                projectSettingsOverrides: {
                  [projectId]: { defaultProjectScripts: [{ ...script, command }] },
                },
              });
              const receipt: ProjectManagedSetupReceipt = yield* f.setup.execute(f.input);
              const retained = yield* f.journal.read(f.input);
              const rows = yield* f.sql<{
                started_pid: number;
              }>`SELECT * FROM project_team_setup_process`;
              const namespaceDescendant = Number(
                yield* f.fs.readFileString(f.path.join(f.worktree, "descendant")),
              );
              const hostPids = [
                ...f.capturedHosts.map((observed) => ({
                  label:
                    observed.command === "/usr/bin/systemd-run"
                      ? "launcher-at-spawn"
                      : "host-control-at-spawn",
                  pid: observed.pid,
                })),
                ...(receipt.owner ? [{ label: "captured-owner", pid: receipt.owner.pid }] : []),
                ...(receipt.drain
                  ? [
                      { label: "captured-launcher", pid: receipt.drain.launcherPid },
                      ...(receipt.drain.childPid === null
                        ? []
                        : [{ label: "captured-child", pid: receipt.drain.childPid }]),
                    ]
                  : []),
              ];
              const hostObservations = yield* Effect.forEach(
                hostPids,
                Effect.fn("setupRuntimeTest.observeDrain")(function* ({ label, pid }) {
                  return {
                    label,
                    pid,
                    present: yield* f.fs.exists(`/proc/${pid}`),
                    stat: yield* f.readProc(pid, "stat"),
                    status: yield* f.readProc(pid, "status"),
                    cgroup: yield* f.readProc(pid, "cgroup"),
                  };
                }),
              );
              if (evidenceDirectory)
                yield* f.fs.writeFileString(
                  f.path.join(evidenceDirectory, "joined-receipt.json"),
                  encode({
                    receipt,
                    retained,
                    rows,
                    hostObservations,
                    capturedHosts: f.capturedHosts,
                    namespaceDescendant: {
                      pid: namespaceDescendant,
                      namespace: "bubblewrap PID namespace; never inspected as a host PID",
                    },
                    scratch: f.scratch,
                    cgroupPresent: receipt.owner ? yield* f.fs.exists(receipt.owner.cgroup) : null,
                  }),
                );
              expect(receipt.outcome).toBe("succeeded");
              expect(receipt.stdout?.text).toBe("setup-complete");
              expect(receipt.stderr?.text).toBe("");
              expect(receipt.drain?.childExitCode).toBe(0);
              expect(
                receipt.drain?.kernel === "removed" ||
                  receipt.drain?.kernel.split("\n").includes("populated 0"),
              ).toBe(true);
              expect(yield* f.fs.readFileString(f.path.join(f.worktree, "setup-marker"))).toBe(
                "prepared",
              );
              expect(namespaceDescendant).toBeGreaterThan(0);
              expect(retained?.owner).toEqual(receipt.owner);
              expect(retained?.receipt).toEqual(receipt);
              expect(rows[0]?.started_pid).toBe(receipt.drain?.childPid);
              if (!receipt.owner || !receipt.drain)
                return yield* Effect.die("Missing physical ownership");
              for (const observed of hostObservations)
                expect(observed.present, `${observed.label} host PID ${observed.pid}`).toBe(false);
              expect(yield* f.fs.exists(receipt.owner.cgroup)).toBe(false);
              const launches = f.counts.native;
              expect(yield* f.setup.execute(f.input)).toEqual(receipt);
              expect(f.counts.native).toBe(launches);
              const evidence = process.env.PROJECT_MANAGED_SETUP_RUNTIME_EVIDENCE_DIR;
              if (evidence)
                yield* f.fs.writeFileString(
                  f.path.join(evidence, `${receipt.owner.unit}.json`),
                  encode({
                    receipt,
                    retained,
                    startedPid: rows[0]?.started_pid,
                    capturedPids: f.capturedPids,
                    namespaceDescendant,
                    counts: f.counts,
                    scratch: f.scratch,
                    marker: "prepared",
                    scope: "native concrete setup; controlled Git registration; full V8 open",
                  }),
                );
              yield* f.fs.remove(f.scratch, { recursive: true });
            }),
          ),
        ),
    );
  },
);
