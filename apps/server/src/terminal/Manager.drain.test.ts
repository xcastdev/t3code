import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

class FakeProcess implements PtyAdapter.PtyProcess {
  readonly exited = Deferred.makeUnsafe<void>();
  readonly ownedExited = Deferred.makeUnsafe<void>();
  readonly observingOwnedExit = Deferred.makeUnsafe<void>();
  readonly awaitOwnedExit = Deferred.succeed(this.observingOwnedExit, undefined).pipe(
    Effect.andThen(Deferred.await(this.ownedExited)),
  );
  readonly signalOwned = (signal: "SIGTERM" | "SIGKILL") =>
    Effect.try({
      try: () => this.kill(signal),
      catch: (cause) => new PtyAdapter.PtyDrainError({ reason: "signal-failed", cause }),
    });
  readonly writes: string[] = [];
  readonly signals: Array<string | undefined> = [];
  signalled = Deferred.makeUnsafe<void>();
  readonly listeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  readonly forceSignalled = Deferred.makeUnsafe<void>();
  failure: Error | undefined;
  failureSignal = "SIGTERM";
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  onData() {
    return () => {};
  }
  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  kill(signal?: string) {
    this.signals.push(signal);
    if (signal === "SIGTERM") Deferred.doneUnsafe(this.signalled, Effect.void);
    if (signal === "SIGKILL") Deferred.doneUnsafe(this.forceSignalled, Effect.void);
    if (this.failure && signal === this.failureSignal) throw this.failure;
  }
  exit() {
    Deferred.doneUnsafe(this.ownedExited, Effect.void);
    this.exitShellOnly();
  }
  exitShellOnly() {
    Deferred.doneUnsafe(this.exited, Effect.void);
    for (const listener of this.listeners) listener({ exitCode: 0, signal: null });
  }
}

const fixture = Effect.fn("test.terminalDrain.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-drain-" });
  const processes: FakeProcess[] = [];
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    shellResolver: () => "/bin/sh",
    processKillGraceMs: 0,
    ptyAdapter: {
      spawn: () =>
        Effect.sync(() => {
          const process = new FakeProcess(9000 + processes.length);
          processes.push(process);
          return process;
        }),
    },
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
  });
  const input = { threadId: "preparation", terminalId: "setup", cwd: logsDir, cols: 80, rows: 24 };
  const { capture } = yield* manager.openCaptured(input);
  return { manager, processes, input, capture };
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("Terminal drain", (it) => {
  it.effect("ordinary close returns while captured drain waits for native exit", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      const process = processes[0]!;
      yield* manager.close(input);
      yield* Deferred.await(process.signalled);
      process.signalled = Deferred.makeUnsafe<void>();
      const draining = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.forkChild);
      yield* Deferred.await(process.signalled);
      expect(draining.pollUnsafe()).toBeUndefined();
      process.exit();
      yield* Fiber.join(draining);
      yield* manager.closeAndDrain({ ...input, capture });
    }),
  );

  it.effect("captured generation drains without killing a replacement or another session", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      yield* manager.restart(input);
      yield* manager.open({ ...input, terminalId: "other" });
      const original = processes[0]!;
      yield* Deferred.await(original.signalled);
      original.signalled = Deferred.makeUnsafe<void>();
      const draining = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.forkChild);
      yield* Deferred.await(original.signalled);
      expect(draining.pollUnsafe()).toBeUndefined();
      processes[1]!.exit();
      expect(draining.pollUnsafe()).toBeUndefined();
      original.exit();
      yield* Fiber.join(draining);
      expect(processes[1]!.signals).toEqual([]);
      expect(processes[2]!.signals).toEqual([]);
    }),
  );

  it.effect("signal failure stays uncertain and retained native proof permits a later retry", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      processes[0]!.failure = new Error("signal failed");
      const result = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "TerminalDrainError",
          reason: "owned-processes-uncertain",
        });
      processes[0]!.exit();
      yield* manager.closeAndDrain({ ...input, capture });
    }),
  );

  it.effect("writes only to the retained live generation and rejects a restarted terminal", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      yield* manager.writeCaptured({ ...input, capture, data: "original command" });
      expect(processes[0]!.writes).toEqual(["original command"]);
      yield* manager.restart(input);
      const rejected = yield* manager
        .writeCaptured({ ...input, capture, data: "stale command" })
        .pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure")
        expect(rejected.failure).toMatchObject({
          _tag: "TerminalDrainError",
          reason: "ownership-mismatch",
        });
      expect(processes[0]!.writes).toEqual(["original command"]);
      expect(processes[1]!.writes).toEqual([]);
    }),
  );

  it.effect("successful force signal still waits for native exit", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      const process = processes[0]!;
      const draining = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.forkChild);
      yield* Deferred.await(process.forceSignalled);
      expect(draining.pollUnsafe()).toBeUndefined();
      process.exit();
      yield* Fiber.join(draining);
    }),
  );

  it.effect("force signal failure cannot count as drain proof", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      processes[0]!.failure = new Error("force signal failed");
      processes[0]!.failureSignal = "SIGKILL";
      const result = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "TerminalDrainError",
          reason: "owned-processes-uncertain",
        });
    }),
  );

  it.effect("an already exited shell still waits for its separately owned session proof", () =>
    Effect.gen(function* () {
      const { manager, processes, input, capture } = yield* fixture();
      const process = processes[0]!;
      process.exitShellOnly();
      const draining = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.forkChild);
      yield* Deferred.await(process.observingOwnedExit);
      expect(draining.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(process.ownedExited, undefined);
      yield* Fiber.join(draining);
    }),
  );

  it.effect(
    "native shell exit alone cannot prove an adapter without owned-process support drained",
    () =>
      Effect.gen(function* () {
        const { manager, processes, input, capture } = yield* fixture();
        Object.defineProperty(processes[0]!, "awaitOwnedExit", { value: undefined });
        processes[0]!.exit();
        const result = yield* manager.closeAndDrain({ ...input, capture }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "TerminalDrainError",
            reason: "owned-processes-uncertain",
          });
      }),
  );

  it.effect("missing original proof and foreign handles cannot succeed", () =>
    Effect.gen(function* () {
      const { manager, input } = yield* fixture();
      const missing = yield* manager
        .closeAndDrain({ ...input, terminalId: "missing" })
        .pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      const foreign = yield* manager
        .closeAndDrain({
          ...input,
          capture: { threadId: input.threadId, terminalId: input.terminalId },
        })
        .pipe(Effect.result);
      expect(foreign._tag).toBe("Failure");
    }),
  );
});

if (HostProcess.Platform.defaultValue() === "linux") {
  it.live.each(["", "set -m; "])(
    "drains an actual waited native child before success (job control %s)",
    (jobControl) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const adapter = yield* PtyAdapter.PtyAdapter;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-native-drain-" });
        const childReady = yield* Deferred.make<number>();
        const script = `${jobControl}trap '' HUP; /bin/sh -c 'echo CHILD=$$; exec sleep 300' & wait`;
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir,
          shellResolver: () => "/bin/sh",
          processKillGraceMs: 0,
          ptyAdapter: { spawn: (input) => adapter.spawn({ ...input, args: ["-c", script] }) },
          subprocessInspector: () =>
            Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
        });
        let output = "";
        const stop = yield* manager.subscribe((event) => {
          if (event.type !== "output") return Effect.void;
          output = (output + event.data).slice(-1024);
          const match = /CHILD=([0-9]+)/.exec(output);
          return match
            ? Deferred.succeed(childReady, Number(match[1])).pipe(Effect.asVoid)
            : Effect.void;
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        const input = {
          threadId: "native-preparation",
          terminalId: "setup",
          cwd: logsDir,
          cols: 80,
          rows: 24,
        };
        const { snapshot, capture } = yield* manager.openCaptured(input);
        const childPid = yield* Deferred.await(childReady);
        const childStat = yield* fs.readFileString(`/proc/${childPid}/stat`);
        if (jobControl) {
          expect(Number(childStat.slice(childStat.lastIndexOf(")") + 2).split(" ")[2])).not.toBe(
            snapshot.pid,
          );
        }
        const childStart = childStat.slice(childStat.lastIndexOf(")") + 2).split(" ")[19];
        // Cleanup is restricted to the PID emitted by this spawn, with matching start identity.
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`/proc/${childPid}/stat`).pipe(
            Effect.flatMap((stat) => {
              const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
              return fields[19] === childStart && fields[0] !== "Z"
                ? Effect.sync(() => {
                    try {
                      process.kill(childPid, "SIGKILL");
                    } catch {}
                  })
                : Effect.void;
            }),
            Effect.ignore,
          ),
        );
        expect(snapshot.pid).not.toBe(childPid);
        yield* manager.closeAndDrain({ ...input, capture });
        const remaining = yield* fs.readFileString(`/proc/${childPid}/stat`).pipe(Effect.option);
        if (remaining._tag === "Some") {
          const fields = remaining.value.slice(remaining.value.lastIndexOf(")") + 2).split(" ");
          expect(["Z", "X"]).toContain(fields[0]);
        }
      }).pipe(
        Effect.provide(
          NodePtyAdapter.layer.pipe(
            Layer.provideMerge(
              Layer.merge(
                NodeServices.layer,
                ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
              ),
            ),
          ),
        ),
      ),
  );
}
