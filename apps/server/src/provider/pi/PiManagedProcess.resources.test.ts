import { expect, it } from "@effect/vitest";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import type * as Cause from "effect/Cause";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  acquirePiManagedProcess,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  PiManagedProcessError,
  type PiManagedDrain,
} from "./PiManagedProcess.ts";

/** Every command is intercepted. This proves consuming control flow, not Linux behavior. */
const fixture = Effect.fn("fixture")(function* (
  runtimeSeconds = 30,
  probe: "success" | "nonzero" | "timeout" | "cancel" = "success",
) {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped();
  const protectedRoot = yield* fs.makeTempDirectoryScoped();
  const source = yield* fs.realPath("/usr/bin/true");
  const launch = {
    workspaceRoot,
    protectedRoots: [protectedRoot],
    runtimeFiles: [{ source, target: "/bin/true" }],
    argv: ["/bin/true"],
    memoryBytes: 33554432,
    runtimeSeconds,
  };
  const allocation = yield* preallocatePiManagedProcess(launch);
  const frames = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const owner = {
    type: "owner" as const,
    unit: allocation.unit,
    nonce: allocation.nonce,
    invocation: "a".repeat(32),
    cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
    pid: 101,
    memoryBytes: launch.memoryBytes,
    swapBytes: 0,
    oomGroup: 1,
  };
  const fixtureScope = yield* Effect.scope;
  const probeEntered = yield* Deferred.make<void>();
  let probeScratch: string | undefined;
  let scratchAtActivation = false;
  let stopped = false;
  let args: readonly string[] = [];
  let captures = 0;
  let recoveryRuntime: string | undefined;
  const handle = (
    stdout: Stream.Stream<Uint8Array>,
    exitCode = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  ) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(100),
      exitCode,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout,
      stderr: Stream.empty,
      all: stdout,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const text = (value: string) => handle(Stream.make(Buffer.from(value)));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected controlled command");
      if (command.command === "/usr/bin/python3" && command.args[0] === "-c") {
        // Simulate Python's old child-owned directory without launching any native command.
        probeScratch =
          command.args[2] ?? (yield* fs.makeTempDirectory({ prefix: "t3-bwrap-probe-" }));
        const scratch = probeScratch;
        yield* Scope.addFinalizer(
          fixtureScope,
          fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.orDie),
        );
        yield* fs.writeFileString(`${scratch}/probe-marker`, "controlled probe");
        if (command.args[2] === undefined && (probe === "success" || probe === "nonzero"))
          yield* fs.remove(scratch, { recursive: true });
        yield* Deferred.succeed(probeEntered, undefined);
        return handle(
          Stream.empty,
          probe === "timeout" || probe === "cancel"
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(probe === "nonzero" ? 1 : 0)),
        );
      }
      if (command.command === "/usr/bin/systemd-run") {
        scratchAtActivation = probeScratch !== undefined && (yield* fs.exists(probeScratch));
        args = command.args;
        yield* Queue.offer(frames, Buffer.from(canonicalProjectWorkPayload(owner) + "\n"));
        return handle(Stream.fromQueue(frames), Deferred.await(exited));
      }
      if (command.command !== "/usr/bin/systemctl")
        return yield* Effect.die("Unexpected native activation");
      if (command.args.includes("stop")) {
        stopped = true;
        yield* Queue.end(frames);
        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        return text("");
      }
      const runtime = args.find((arg) => arg.startsWith("RuntimeMaxSec="))?.slice(14);
      const unset = args.find((arg) => arg.startsWith("UnsetEnvironment="))?.slice(17);
      return text(
        Object.entries({
          LoadState: "loaded",
          Description: `T3 Pi managed ${allocation.nonce}`,
          InvocationID: owner.invocation,
          ControlGroup: stopped ? "" : owner.cgroup.slice("/sys/fs/cgroup".length),
          ActiveState: stopped ? "inactive" : "active",
          KillMode: "control-group",
          Restart: "no",
          RuntimeMaxUSec: recoveryRuntime ?? runtime,
          TimeoutStopUSec: "2s",
          UnsetEnvironment: unset,
          Environment: "LC_ALL=C LANG=C",
        })
          .map(([key, value]) => `${key}=${value}`)
          .join("\n") + "\n",
      );
    }),
  );
  const controlledFs = {
    ...fs,
    readFileString: (path: string, encoding?: string) => {
      if (!path.startsWith(owner.cgroup + "/")) return fs.readFileString(path, encoding);
      const value = path.endsWith("/memory.max")
        ? "33554432"
        : path.endsWith("/memory.swap.max")
          ? "0"
          : path.endsWith("/memory.oom.group")
            ? "1"
            : path.endsWith("/cgroup.events")
              ? "populated 0"
              : undefined;
      return value === undefined
        ? Effect.die("Unexpected controlled kernel read")
        : Effect.succeed(value);
    },
    exists: (path: string) =>
      path.startsWith("/sys/fs/cgroup/") ? Effect.succeed(false) : fs.exists(path),
  };
  return {
    launch,
    allocation,
    spawner,
    controlledFs,
    owner,
    readArgs: () => args,
    probeEntered,
    probeScratch: () => probeScratch,
    scratchAtActivation: () => scratchAtActivation,
    recoveryRuntime: (value: string) => {
      recoveryRuntime = value;
    },
    capture: () =>
      Effect.sync(() => {
        captures++;
      }),
    captures: () => captures,
  };
});

it.effect(
  "task resources shorten the kernel duration to the original deadline and publish only captured drain",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const deadline = (yield* Clock.currentTimeMillis) + 5500;
        let claimed = false;
        let drain: PiManagedDrain | undefined;
        const child = yield* acquirePiManagedProcess(f.launch, {
          allocation: f.allocation,
          deadlineAtMs: deadline,
          claimActivation: () =>
            Effect.sync(() => {
              claimed = true;
            }),
          beforeStart: () => f.capture(),
          afterDrain: (receipt) =>
            Effect.sync(() => {
              drain = receipt;
            }),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
          Effect.provideService(FileSystem.FileSystem, f.controlledFs),
        );
        expect(claimed).toBe(true);
        expect(f.readArgs()).toContain("MemoryMax=33554432");
        expect(f.readArgs()).toContain("MemorySwapMax=0");
        expect(f.readArgs()).toContain("RuntimeMaxSec=5s");
        expect(f.captures()).toBe(1);
        expect(drain).toBeUndefined();
        const recover = () =>
          reconcilePiManagedProcess(
            { allocation: f.allocation, activation: "owned", owner: f.owner },
            { stop: false },
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
            Effect.provideService(FileSystem.FileSystem, f.controlledFs),
          );
        expect((yield* recover()).state).toBe("owned");
        f.recoveryRuntime("31s");
        expect((yield* recover().pipe(Effect.result))._tag).toBe("Failure");
        f.recoveryRuntime("5s");
        const stopped = yield* child.stop;
        expect(drain).toEqual(stopped);
        expect(stopped).toMatchObject({
          unit: f.owner.unit,
          invocation: f.owner.invocation,
          cgroup: f.owner.cgroup,
          ownerPid: f.owner.pid,
          kernel: "removed",
        });
        yield* child.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const test of [
  { remainingMs: 5500, activationMs: 4501, runtimeSeconds: 30, kernelSeconds: 0 },
  { remainingMs: 5500, activationMs: 4500, runtimeSeconds: 30, kernelSeconds: 1 },
  { remainingMs: 120000, activationMs: 5500, runtimeSeconds: 120, kernelSeconds: 114 },
])
  it.effect(
    `task resources retain the original ${test.remainingMs}ms deadline after ${test.activationMs}ms activation overhead`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(test.runtimeSeconds);
          const startedAtMs = yield* Clock.currentTimeMillis;
          const deadlineAtMs = startedAtMs + test.remainingMs;
          let claims = 0;
          let drain: PiManagedDrain | undefined;
          const result = yield* acquirePiManagedProcess(f.launch, {
            allocation: f.allocation,
            deadlineAtMs,
            claimActivation: (allocation) =>
              Effect.gen(function* () {
                expect(allocation).toEqual(f.allocation);
                claims++;
                yield* TestClock.adjust(test.activationMs);
              }),
            beforeStart: () => f.capture(),
            afterDrain: (receipt) =>
              Effect.sync(() => {
                drain = receipt;
              }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
            Effect.provideService(FileSystem.FileSystem, f.controlledFs),
            Effect.result,
          );
          expect(claims).toBe(1);
          expect(yield* Clock.currentTimeMillis).toBe(startedAtMs + test.activationMs);
          expect(drain).toBeUndefined();
          if (test.kernelSeconds === 0) {
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                phase: "startup",
                message: "Original operation deadline cannot accommodate activation.",
              },
            });
            expect(deadlineAtMs - (yield* Clock.currentTimeMillis)).toBe(999);
            expect(f.readArgs()).toEqual([]);
            expect(f.captures()).toBe(0);
          } else {
            expect(result._tag).toBe("Success");
            expect(f.readArgs()).toContain(`RuntimeMaxSec=${test.kernelSeconds}s`);
            expect(f.captures()).toBe(1);
            expect(test.activationMs + test.kernelSeconds * 1000).toBeLessThanOrEqual(
              test.remainingMs,
            );
            expect(test.activationMs + (test.kernelSeconds + 1) * 1000).toBeGreaterThan(
              test.remainingMs,
            );
            if (result._tag !== "Success") return;
            const stopped = yield* result.success.stop;
            expect(drain).toEqual(stopped);
            expect(stopped).toMatchObject({ ownerPid: f.owner.pid, kernel: "removed" });
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect(
  "task resources deny an expired original deadline before any controlled native launch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* acquirePiManagedProcess(f.launch, {
          allocation: f.allocation,
          deadlineAtMs: yield* Clock.currentTimeMillis,
          claimActivation: () => Effect.void,
          beforeStart: () => f.capture(),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(f.readArgs()).toEqual([]);
        expect(f.captures()).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "task resources retain failure when the actual captured drain callback cannot commit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        let attempted: PiManagedDrain | undefined;
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* acquirePiManagedProcess(f.launch, {
              allocation: f.allocation,
              claimActivation: () => Effect.void,
              beforeStart: () => f.capture(),
              afterDrain: (drain) => {
                attempted = drain;
                return Effect.fail(
                  new PiManagedProcessError({
                    phase: "quarantine",
                    message: "Controlled durable drain failure",
                  }),
                );
              },
            });
            return yield* child.stop;
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
          Effect.provideService(FileSystem.FileSystem, f.controlledFs),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(attempted).toMatchObject({
          unit: f.owner.unit,
          invocation: f.owner.invocation,
          cgroup: f.owner.cgroup,
          kernel: "removed",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const mode of ["success", "nonzero", "timeout", "cancel"] as const)
  it.effect(`parent removes capability scratch on ${mode} before activation or return`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(30, mode);
        let claims = 0;
        const acquisition = acquirePiManagedProcess(f.launch, {
          allocation: f.allocation,
          claimActivation: () =>
            Effect.sync(() => {
              claims++;
            }),
          beforeStart: () => f.capture(),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
          Effect.provideService(FileSystem.FileSystem, f.controlledFs),
        );
        const pending = yield* acquisition.pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(f.probeEntered);
        const scratch = f.probeScratch();
        expect(scratch).toBeDefined();
        if (!scratch) return;
        if (mode === "timeout") yield* TestClock.adjust("3 seconds");
        if (mode === "cancel") yield* Fiber.interrupt(pending);
        else {
          const result = yield* Fiber.join(pending);
          if (mode === "success") {
            expect(result._tag).toBe("Success");
            if (result._tag === "Success") yield* result.success.stop;
          } else
            expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "unavailable" } });
        }
        expect(yield* f.controlledFs.exists(scratch)).toBe(false);
        expect(f.scratchAtActivation()).toBe(false);
        expect(claims).toBe(mode === "success" ? 1 : 0);
        expect(f.captures()).toBe(mode === "success" ? 1 : 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
