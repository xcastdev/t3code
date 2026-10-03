import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import {
  acquirePiManagedProcess,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  PiManagedProcessError,
  type PiManagedDrain,
  type PiManagedLaunch,
  type PiManagedProcessAllocation,
  type PiManagedProcessOwner,
} from "../provider/pi/PiManagedProcess.ts";
import {
  makeProjectManagedSetup,
  ProjectManagedSetupError,
  type ProjectManagedSetupInput,
  type ProjectManagedSetupPorts,
  type ProjectManagedSetupRetained,
  type ProjectManagedSetupSelection,
} from "./ProjectManagedSetup.ts";

const launch: PiManagedLaunch = {
  workspaceRoot: "/assigned/worktree",
  workspaceAccess: "readwrite",
  protectedRoots: ["/protected"],
  runtimeFiles: [{ source: "/trusted/sh", target: "/bin/sh" }],
  argv: ["/bin/sh", "-c", "printf complete"],
  memoryBytes: 67108864,
  runtimeSeconds: 30,
};
const script: ProjectManagedSetupSelection = {
  kind: "script",
  scriptId: "install",
  scriptRevision: "sha256:frozen",
  cwd: launch.workspaceRoot,
  launch,
};
const allocation: PiManagedProcessAllocation = {
  version: 1,
  unit: "t3-pi-managed-11111111-1111-4111-8111-111111111111.service",
  nonce: "11111111-1111-4111-8111-111111111111",
  policy: { memoryBytes: launch.memoryBytes, runtimeSeconds: launch.runtimeSeconds },
  launch: {
    ...launch,
    workspace: { path: launch.workspaceRoot, dev: 1, ino: 2 },
    protectedWorkspaceEntries: [],
    runtimeFiles: [{ source: "/trusted/sh", target: "/bin/sh", dev: 1, ino: 3 }],
  },
};
const owner: PiManagedProcessOwner = {
  type: "owner",
  unit: allocation.unit,
  nonce: allocation.nonce,
  invocation: "a".repeat(32),
  cgroup: "/sys/fs/cgroup/test/" + allocation.unit,
  pid: 41,
  memoryBytes: launch.memoryBytes,
  swapBytes: 0,
  oomGroup: 1,
};
const drain: PiManagedDrain = {
  unit: owner.unit,
  invocation: owner.invocation,
  cgroup: owner.cgroup,
  ownerPid: owner.pid,
  memoryBytes: owner.memoryBytes,
  swapBytes: 0,
  oomGroup: 1,
  launcherPid: 40,
  childPid: 42,
  childExitCode: 0,
  kernel: "removed",
};
const input: ProjectManagedSetupInput = {
  setupId: "setup",
  dispatchId: "dispatch",
  bindingId: "binding",
  generation: 1,
  threadId: "thread",
  worktreePath: launch.workspaceRoot,
  deadlineAtMs: 10000,
};
const fresh = (selection: ProjectManagedSetupSelection = script): ProjectManagedSetupRetained => ({
  selection,
  allocation: null,
  activation: "unlaunched",
  owner: null,
  receipt: null,
  uncertain: false,
});

const fixture = Effect.fn("managedSetupTest.fixture")(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const stdoutClosed = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const state: {
    retained: ProjectManagedSetupRetained | null;
    selected: ProjectManagedSetupSelection;
    denied: ProjectManagedSetupPorts["validateCurrent"] extends (...args: infer A) => unknown
      ? A[2] | null
      : never;
    running: boolean;
    starts: number;
    acquisitions: number;
    preallocations: number;
    reconciliations: number;
    hold: boolean;
    holdStdout: boolean;
    stopFailure: boolean;
    receiptFailure: boolean;
    startedFailure: boolean;
    exitCode: number;
    trace: string[];
    held: Parameters<ProjectManagedSetupPorts["markUncertain"]>[1][];
  } = {
    retained: null,
    selected: script,
    denied: null,
    running: false,
    starts: 0,
    acquisitions: 0,
    preallocations: 0,
    reconciliations: 0,
    hold: false,
    holdStdout: false,
    stopFailure: false,
    receiptFailure: false,
    startedFailure: false,
    exitCode: 0,
    trace: [],
    held: [],
  };
  const ports: ProjectManagedSetupPorts = {
    read: () => Effect.sync(() => state.retained),
    resolveSelection: () =>
      Effect.sync(() => {
        state.trace.push("resolve");
        return state.selected;
      }),
    validateCurrent: (_input, selection, phase) =>
      Effect.suspend(() => {
        state.trace.push(phase);
        return state.denied === phase ||
          (selection?.kind === "script" &&
            state.selected.kind === "script" &&
            selection.scriptRevision !== state.selected.scriptRevision)
          ? Effect.fail(new ProjectManagedSetupError({ reason: "revoked or stale" }))
          : Effect.void;
      }),
    freezeSelection: (_input, selection) =>
      Effect.sync(() => {
        state.trace.push("frozen-selection");
        return (state.retained ??= fresh(selection));
      }),
    freezeAllocation: (_input, selection, value) =>
      Effect.sync(() => {
        state.trace.push("frozen-allocation");
        state.retained ??= fresh(selection);
        if (!state.retained.allocation) state.retained = { ...state.retained, allocation: value };
        return state.retained;
      }),
    claimActivation: () =>
      Effect.suspend(() => {
        state.trace.push("claim");
        if (!state.retained || state.retained.activation !== "unlaunched")
          return Effect.succeed("already-claimed" as const);
        state.retained = { ...state.retained, activation: "claimed" };
        return Effect.succeed("claimed" as const);
      }),
    persistOwner: (_input, _allocation, value) =>
      Effect.sync(() => {
        state.trace.push("owner");
        if (!state.retained) throw new Error("missing retained setup");
        state.retained = { ...state.retained, activation: "owned", owner: value };
      }),
    persistStarted: (_input, _allocation, actualOwner, childPid) =>
      Effect.suspend(() => {
        if (state.retained?.owner !== actualOwner || childPid !== 42)
          return Effect.die(new Error("start receipt differs from actual native process"));
        state.trace.push("started-receipt");
        return state.startedFailure
          ? Effect.fail(new ProjectManagedSetupError({ reason: "start receipt write failed" }))
          : Effect.void;
      }),
    persistReceipt: (_input, receipt) =>
      Effect.suspend(() => {
        state.trace.push("receipt:" + receipt.outcome);
        if (state.running) return Effect.die(new Error("receipt before physical drain"));
        if (state.receiptFailure)
          return Effect.fail(new ProjectManagedSetupError({ reason: "write failed" }));
        if (!state.retained) return Effect.die(new Error("missing retained setup"));
        state.retained = { ...state.retained, receipt };
        return Effect.void;
      }),
    markUncertain: (_input, retained) =>
      Effect.sync(() => {
        state.held.push(retained);
        state.trace.push("uncertain");
        if (state.retained) state.retained = { ...state.retained, uncertain: true };
      }),
    preallocate: () =>
      Effect.sync(() => {
        state.preallocations++;
        return allocation;
      }),
    acquire: (_launch, persistence) =>
      Effect.gen(function* () {
        state.acquisitions++;
        yield* persistence.claimActivation(persistence.allocation);
        const stop = Effect.gen(function* () {
          state.trace.push("stop");
          if (state.stopFailure)
            return yield* Effect.fail(
              new PiManagedProcessError({ phase: "quarantine", message: "unproved cleanup" }),
            );
          state.running = false;
          yield* Deferred.succeed(stopped, undefined);
          yield* Deferred.succeed(release, undefined);
          return { ...drain, childExitCode: state.exitCode };
        });
        yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie, Effect.asVoid));
        yield* persistence.beforeStart(owner);
        return {
          owner,
          start: Effect.gen(function* () {
            if (state.retained?.owner !== owner)
              return yield* Effect.die(new Error("start before retained owner"));
            state.running = true;
            state.starts++;
            state.trace.push("script-start");
            yield* Deferred.succeed(started, undefined);
            return 42;
          }),
          stop,
          send: () => Effect.void,
          endInput: Effect.void,
          stdout: Stream.fromEffect(
            Effect.gen(function* () {
              if (state.holdStdout) yield* Deferred.await(stdoutClosed);
              state.trace.push("stdout-joined");
              return Buffer.alloc(40000, "x");
            }),
          ),
          stderr: Stream.make(Buffer.from("diagnostic")),
          awaitExit: Effect.gen(function* () {
            if (state.hold) yield* Deferred.await(release);
            return yield* stop;
          }),
        };
      }),
    reconcileProcess: (recovery) =>
      Effect.suspend(() => {
        state.reconciliations++;
        if (state.stopFailure || (recovery.activation === "claimed" && !recovery.owner))
          return Effect.fail(
            new PiManagedProcessError({ phase: "quarantine", message: "unproved history" }),
          );
        state.running = false;
        return Effect.succeed({
          state: recovery.activation === "unlaunched" ? "absent" : "drained",
          unit: allocation.unit,
          invocation: recovery.owner?.invocation ?? null,
          cgroup: recovery.owner?.cgroup ?? null,
          kernel: "removed",
        });
      }),
  };
  return {
    state,
    ports,
    setup: makeProjectManagedSetup(ports),
    started,
    release,
    stdoutClosed,
    stopped,
  };
});

describe("managed setup durable lifecycle", () => {
  it.effect("freezes selection/allocation and captured ownership before one script execution", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const receipt = yield* f.setup.execute(input);
      expect(receipt.outcome).toBe("succeeded");
      expect(receipt.drain).toEqual(drain);
      expect(receipt.stdout?.bytes).toBe(32768);
      expect(receipt.stdout?.truncated).toBe(true);
      expect(f.state.starts).toBe(1);
      expect(f.state.trace.indexOf("script-start")).toBeLessThan(
        f.state.trace.indexOf("started-receipt"),
      );
      expect(f.state.trace.indexOf("started-receipt")).toBeLessThan(f.state.trace.indexOf("stop"));
      expect(f.state.trace.indexOf("frozen-allocation")).toBeLessThan(
        f.state.trace.indexOf("claim"),
      );
      expect(f.state.trace.indexOf("owner")).toBeLessThan(f.state.trace.indexOf("script-start"));
      expect(f.state.trace.indexOf("stdout-joined")).toBeLessThan(
        f.state.trace.indexOf("receipt:succeeded"),
      );
      expect(yield* f.setup.execute(input)).toEqual(receipt);
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect(
    "retains a durable no-script selection and replays it without resolving a new script",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.state.selected = { kind: "none" };
        const receipt = yield* f.setup.execute(input);
        expect(receipt.outcome).toBe("skipped");
        f.state.selected = script;
        expect(yield* f.setup.execute(input)).toEqual(receipt);
        expect(f.state.trace.filter((entry) => entry === "resolve")).toHaveLength(1);
        expect(f.state.preallocations).toBe(0);
      }),
  );

  it.effect("denies readonly or paused assignment before script selection", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.denied = "selection";
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.trace).not.toContain("resolve");
      expect(f.state.acquisitions).toBe(0);
    }),
  );

  it.effect("blocks failed exit despite proved physical drain", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.exitCode = 7;
      const receipt = yield* f.setup.execute(input);
      expect(receipt.outcome).toBe("failed");
      expect(receipt.drain?.childExitCode).toBe(7);
      expect((yield* f.setup.execute(input)).outcome).toBe("failed");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("reconciles retained owned setup without rerunning non-idempotent script", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.retained = { ...fresh(), allocation, activation: "owned", owner, uncertain: true };
      const receipt = yield* f.setup.reconcile(input);
      expect(receipt.outcome).toBe("failed");
      expect(receipt.drain).toBeNull();
      expect(receipt.reconciliation?.state).toBe("drained");
      expect(f.state.starts).toBe(0);
      expect(f.state.reconciliations).toBe(1);
    }),
  );

  it.effect("holds claimed setup with no captured owner instead of accepting absence", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.retained = { ...fresh(), allocation, activation: "claimed" };
      expect((yield* f.setup.reconcile(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.retained?.uncertain).toBe(true);
      expect(f.state.retained?.receipt).toBeNull();
      expect(f.state.starts).toBe(0);
    }),
  );
});

describe("managed setup fences and joined cleanup", () => {
  it.effect("a failed native start receipt stops setup and cannot publish success", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.startedFailure = true;
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.running).toBe(false);
      expect(f.state.retained?.receipt?.outcome).toBe("failed");
      expect(f.state.retained?.receipt?.drain).toEqual(drain);
      expect(f.state.held.at(-1)?.drain).toEqual(drain);
      expect(f.state.starts).toBe(1);
    }),
  );
  it.effect("recovery drains expired ownership without granting a new execution deadline", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.retained = { ...fresh(), allocation, activation: "owned", owner, uncertain: true };
      yield* TestClock.adjust(10001);
      const receipt = yield* f.setup.reconcile(input);
      expect(receipt.outcome).toBe("failed");
      expect(receipt.reconciliation?.state).toBe("drained");
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("the original deadline bounds script selection as well as script execution", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const selecting = yield* Deferred.make<void>();
      const setup = makeProjectManagedSetup({
        ...f.ports,
        resolveSelection: () =>
          Deferred.succeed(selecting, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const active = yield* setup.execute(input).pipe(Effect.forkScoped);
      yield* Deferred.await(selecting);
      yield* TestClock.adjust(10001);
      expect((yield* Fiber.await(active))._tag).toBe("Failure");
      expect(f.state.preallocations).toBe(0);
      expect(f.state.starts).toBe(0);
      expect(f.state.held).toHaveLength(1);
    }),
  );

  it.effect("reuses the retained allocation instead of allocating a replacement", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.retained = { ...fresh(), allocation };
      expect((yield* f.setup.execute(input)).outcome).toBe("succeeded");
      expect(f.state.preallocations).toBe(0);
      expect(f.state.retained?.allocation).toEqual(allocation);
    }),
  );

  it.effect("denies changed frozen script revision before allocation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.retained = fresh();
      f.state.selected = { ...script, scriptRevision: "sha256:changed" };
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.preallocations).toBe(0);
      expect(f.state.starts).toBe(0);
      expect(f.state.retained?.selection).toEqual(script);
    }),
  );

  it.effect("denies pause at allocation before preallocating a process", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.denied = "allocation";
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.preallocations).toBe(0);
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("retains owner and stops acquisition when start authority is revoked", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.denied = "start";
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.retained?.owner).toEqual(owner);
      expect(f.state.starts).toBe(0);
      expect(f.state.trace).toContain("stop");
      expect(f.state.retained?.uncertain).toBe(true);
    }),
  );

  it.effect("persists physical drain as canceled even after completion authority is revoked", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.denied = "completion";
      const receipt = yield* f.setup.execute(input);
      expect(receipt.outcome).toBe("canceled");
      expect(receipt.drain).toEqual(drain);
      expect(f.state.running).toBe(false);
    }),
  );

  it.effect("duplicate active execution cannot stop or quarantine the winning script", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.hold = true;
      const active = yield* f.setup.execute(input).pipe(Effect.forkScoped);
      yield* Deferred.await(f.started);
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.running).toBe(true);
      expect(f.state.retained?.uncertain).toBe(false);
      expect(f.state.reconciliations).toBe(0);
      yield* Deferred.succeed(f.release, undefined);
      expect((yield* Fiber.join(active)).outcome).toBe("succeeded");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("an activation claim loser neither starts nor marks the winner uncertain", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const setup = makeProjectManagedSetup({
        ...f.ports,
        claimActivation: () => Effect.succeed("already-claimed" as const),
      });
      expect((yield* setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.starts).toBe(0);
      expect(f.state.held).toHaveLength(0);
      expect(f.state.trace).not.toContain("stop");
    }),
  );

  it.effect("cancellation joins native stop and both output consumers before returning", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.hold = true;
      f.state.holdStdout = true;
      const active = yield* f.setup.execute(input).pipe(Effect.forkScoped);
      yield* Deferred.await(f.started);
      const cancellation = yield* Fiber.interrupt(active).pipe(Effect.forkScoped);
      yield* Deferred.await(f.stopped);
      expect(f.state.running).toBe(false);
      expect(f.state.retained?.receipt).toBeNull();
      yield* Deferred.succeed(f.stdoutClosed, undefined);
      yield* Fiber.join(cancellation);
      expect(f.state.retained?.receipt?.outcome).toBe("canceled");
      expect(f.state.retained?.receipt?.drain).toEqual(drain);
      expect(f.state.held.at(-1)?.drain).toEqual(drain);
      expect(f.state.trace.indexOf("stdout-joined")).toBeLessThan(
        f.state.trace.indexOf("receipt:canceled"),
      );
    }),
  );

  it.effect("the immutable deadline stops setup instead of refreshing its remaining time", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.hold = true;
      const active = yield* f.setup.execute(input).pipe(Effect.forkScoped);
      yield* Deferred.await(f.started);
      yield* TestClock.adjust(10001);
      expect((yield* Fiber.await(active))._tag).toBe("Failure");
      expect(f.state.running).toBe(false);
      expect(f.state.retained?.receipt?.drain).toEqual(drain);
      expect(f.state.retained?.receipt?.outcome).toBe("canceled");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("a deadline reached during the authority read prevents selection", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const setup = makeProjectManagedSetup({
        ...f.ports,
        validateCurrent: () => TestClock.adjust(10001),
      });
      expect((yield* setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.trace).not.toContain("resolve");
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("unproved native cleanup keeps the captured owner and no completion receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.stopFailure = true;
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.running).toBe(true);
      expect(f.state.retained?.owner).toEqual(owner);
      expect(f.state.retained?.receipt).toBeNull();
      expect(f.state.retained?.uncertain).toBe(true);
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("publication failure retains actual cleanup evidence and blocks replay", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.receiptFailure = true;
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.held.at(-1)?.drain).toEqual(drain);
      expect(f.state.held.at(-1)?.owner).toEqual(owner);
      expect(f.state.running).toBe(false);
      expect(f.state.retained?.receipt).toBeNull();
      expect((yield* f.setup.execute(input).pipe(Effect.exit))._tag).toBe("Failure");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("preserves publication and uncertainty-write causes if both writes fail", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.receiptFailure = true;
      const setup = makeProjectManagedSetup({
        ...f.ports,
        markUncertain: () =>
          Effect.fail(new ProjectManagedSetupError({ reason: "uncertainty write failed" })),
      });
      const result = yield* setup.execute(input).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.cause.reasons).toHaveLength(2);
      expect(f.state.retained?.owner).toEqual(owner);
      expect(f.state.running).toBe(false);
    }),
  );
});

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Explicit constructive gate only: no protected-resource or hostile boundary probes.
describe.runIf(process.env.PROJECT_MANAGED_SETUP_NATIVE_GATE === "1")(
  "native managed setup",
  () => {
    it.live(
      "runs one benign setup and joins its owned background descendant before completion",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "project-managed-setup-" });
            const workspace = path.join(scratch, "workspace");
            const protectedRoot = path.join(scratch, "protected");
            yield* fs.makeDirectory(workspace);
            yield* fs.makeDirectory(protectedRoot);
            const runtimeFiles = [
              { source: "/usr/bin/bash", target: "/bin/bash" },
              { source: "/usr/bin/sleep", target: "/bin/sleep" },
              ...[
                "/lib64/ld-linux-x86-64.so.2",
                "/usr/lib/libc.so.6",
                "/usr/lib/libreadline.so.8",
                "/usr/lib/libncursesw.so.6",
              ].map((source) => ({ source, target: source })),
            ];
            const nativeLaunch: PiManagedLaunch = {
              workspaceRoot: workspace,
              workspaceAccess: "readwrite",
              protectedRoots: [protectedRoot],
              runtimeFiles,
              argv: [
                "/bin/bash",
                "-c",
                "printf prepared > /workspace/setup-marker; /bin/sleep 30 & printf '%s' \"$!\" > /workspace/descendant; printf 'descendant-ready\\n'; read -r continuation; printf setup-complete; exit 0",
              ],
              memoryBytes: 67108864,
              runtimeSeconds: 30,
            };
            const selected: ProjectManagedSetupSelection = {
              kind: "script",
              scriptId: "benign-native",
              scriptRevision: "fixture-v1",
              cwd: workspace,
              launch: nativeLaunch,
            };
            const f = yield* fixture();
            f.state.selected = selected;
            const evidence = process.env.PROJECT_MANAGED_SETUP_EVIDENCE_DIR;
            const persistOwner: ProjectManagedSetupPorts<NodeServices.NodeServices>["persistOwner"] =
              (request, allocation, owner) =>
                Effect.gen(function* () {
                  yield* f.ports.persistOwner(request, allocation, owner);
                  if (evidence)
                    yield* fs.writeFileString(
                      path.join(evidence, owner.unit + ".owner.json"),
                      yield* encodeReceipt(owner),
                    );
                }).pipe(
                  Effect.mapError(
                    () =>
                      new PiManagedProcessError({
                        phase: "startup",
                        message: "native owner receipt write failed",
                      }),
                  ),
                );
            let nativePids: number[] = [];
            const acquire: ProjectManagedSetupPorts<NodeServices.NodeServices>["acquire"] = (
              launch,
              persistence,
            ) =>
              Effect.gen(function* () {
                const process = yield* acquirePiManagedProcess(launch, persistence);
                let ready = "";
                let released = false;
                return {
                  ...process,
                  stdout: process.stdout.pipe(
                    Stream.tap((chunk) =>
                      Effect.gen(function* () {
                        if (released) return;
                        ready += Buffer.from(chunk).toString("utf8");
                        if (!ready.includes("descendant-ready\n")) return;
                        released = true;
                        const membership = yield* fs.readFileString(
                          path.join(process.owner.cgroup, "cgroup.procs"),
                        );
                        nativePids = membership.trim().split("\n").map(Number);
                        expect(nativePids.length).toBeGreaterThanOrEqual(3);
                        expect(nativePids).toContain(process.owner.pid);
                        if (evidence)
                          yield* fs.writeFileString(
                            path.join(evidence, process.owner.unit + ".live-descendants.json"),
                            yield* encodeReceipt({ owner: process.owner, nativePids }),
                          );
                        yield* process.send(Buffer.from("continue\n"));
                      }).pipe(
                        Effect.mapError(
                          () =>
                            new PiManagedProcessError({
                              phase: "transport",
                              message: "native descendant receipt failed",
                            }),
                        ),
                      ),
                    ),
                  ),
                };
              });
            const ports: ProjectManagedSetupPorts<NodeServices.NodeServices> = {
              ...f.ports,
              preallocate: preallocatePiManagedProcess,
              acquire,
              reconcileProcess: reconcilePiManagedProcess,
              persistStarted: (_input, _allocation, owner, childPid) =>
                Effect.gen(function* () {
                  expect(owner).toEqual(f.state.retained?.owner);
                  expect(childPid).toBeGreaterThan(0);
                  if (evidence)
                    yield* fs.writeFileString(
                      path.join(evidence, owner.unit + ".started.json"),
                      yield* encodeReceipt({ owner, childPid }),
                    );
                }).pipe(
                  Effect.mapError(
                    () =>
                      new ProjectManagedSetupError({ reason: "native start receipt write failed" }),
                  ),
                ),
              persistOwner,
            };
            const setup = makeProjectManagedSetup(ports);
            const request = {
              ...input,
              worktreePath: workspace,
              deadlineAtMs: (yield* Clock.currentTimeMillis) + 30000,
            };
            const receipt = yield* setup.execute(request);
            expect(receipt.outcome).toBe("succeeded");
            expect(receipt.stdout?.text).toBe("descendant-ready\nsetup-complete");
            expect(receipt.drain?.childExitCode).toBe(0);
            expect(
              receipt.drain?.kernel === "removed" ||
                receipt.drain?.kernel.split("\n").includes("populated 0"),
            ).toBe(true);
            expect(yield* fs.readFileString(path.join(workspace, "setup-marker"))).toBe("prepared");
            expect(receipt.owner).toEqual(f.state.retained?.owner);
            if (!receipt.drain || !receipt.owner)
              return yield* Effect.die(new Error("missing physical native receipt"));
            for (const pid of [
              ...nativePids,
              receipt.owner.pid,
              receipt.drain.childPid,
              receipt.drain.launcherPid,
            ])
              if (pid !== null) expect(yield* fs.exists("/proc/" + pid)).toBe(false);
            expect(yield* fs.exists(receipt.owner.cgroup)).toBe(false);
            expect(yield* setup.execute(request)).toEqual(receipt);
            if (evidence)
              yield* fs.writeFileString(
                path.join(evidence, receipt.owner.unit + ".complete.json"),
                yield* encodeReceipt({
                  receipt,
                  repeatedReceipt: f.state.retained?.receipt,
                  scratch,
                  nativePids,
                  marker: "prepared",
                }),
              );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
