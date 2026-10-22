// @effect-diagnostics-next-line nodeBuiltinImport:off -- Revalidate captured /proc identity and signal without an async gap.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty stays external to the CLI bundle because it dlopens a native
// addon. Inside a Node single-executable, `import()` cannot load files from
// disk (only built-ins resolve), while `require` always reads the real
// filesystem, so both the module and its spawn-helper resolve through it.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "server/terminal/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * node-pty defers creation to avoid blocking on named pipes:
 * https://github.com/microsoft/node-pty/pull/885 Its public API has no
 * readiness event. The private ready_datapipe handler sets pid before our
 * listener runs.
 */
const waitForWindowsPid = (
  process: import("node-pty").IPty,
  trackedProcess: NodePtyProcess,
  shell: string,
) =>
  Effect.callback<void, PtyAdapter.PtySpawnError>((resume) => {
    const hasPid = () => Number.isInteger(process.pid) && process.pid > 0;
    const failure = (cause: unknown) =>
      Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell, cause }));

    if (hasPid()) {
      resume(Effect.void);
      return;
    }

    if (!("_socket" in process) || !(process._socket instanceof NodeNet.Socket)) {
      resume(failure(new Error("Windows PTY readiness socket is unavailable.")));
      return;
    }

    const socket = process._socket;
    const onReady = () => {
      cleanup();
      resume(
        hasPid()
          ? Effect.void
          : failure(new Error("Windows PTY became ready without a valid PID.")),
      );
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(failure(cause));
    };
    const onClose = () => onError(new Error("Windows PTY closed before its PID was available."));
    let stopExit = () => {};
    const cleanup = () => {
      socket.off("ready_datapipe", onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      stopExit();
    };
    socket.once("ready_datapipe", onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    stopExit = trackedProcess.onExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    return Effect.sync(cleanup);
  });

/**
 * Cancels Windows startup without waiting for the first output, unlike public kill().
 * The private agent can cancel the pending connection before a child exists.
 */
const killStartingWindowsPty = (process: import("node-pty").IPty) =>
  Effect.try(() => {
    if (
      "_agent" in process &&
      typeof process._agent === "object" &&
      process._agent !== null &&
      "kill" in process._agent &&
      typeof process._agent.kill === "function"
    ) {
      process._agent.kill();
    } else {
      process.kill();
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to cancel Windows terminal startup", {
        terminalPid: process.pid,
        cause: error,
      }),
    ),
  );

const isPtyDrainError = Schema.is(PtyAdapter.PtyDrainError);

interface LinuxProcessFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): ReadonlyArray<string>;
}

interface LinuxProcessIdentity {
  pid: number;
  group: number;
  session: number;
  start: string;
  state: string;
}

const readLinuxIdentity = (
  pid: number,
  fileSystem: LinuxProcessFileSystem = NodeFS,
): LinuxProcessIdentity | undefined => {
  let stat: string;
  try {
    stat = fileSystem.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ESRCH")
    )
      return undefined;
    throw cause;
  }
  // comm is parenthesized and may itself contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const start = fields[19];
  const state = fields[0];
  if (!Number.isSafeInteger(group) || !Number.isSafeInteger(session) || !start || !state) {
    throw new PtyAdapter.PtyDrainError({ reason: "inspection-failed" });
  }
  return { pid, group, session, start, state };
};

const captureLinuxSession = Effect.fn("NodePtyAdapter.captureLinuxSession")(
  function* (pid: number) {
    const initial = yield* Effect.try(() => readLinuxIdentity(pid));
    if (!initial) return undefined;
    // forkpty's child establishes its session before exec; the parent may return first.
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = yield* Effect.try(() => readLinuxIdentity(pid));
      if (!current || current.start !== initial.start) return undefined;
      if (current.session === pid && current.group === pid) return current;
      yield* Effect.sleep("10 millis");
    }
    return undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

export const makeLinuxSessionDrain = (
  leader: LinuxProcessIdentity,
  fileSystem: LinuxProcessFileSystem = NodeFS,
) => {
  let drained = false;
  const assertLeader = () => {
    const current = readLinuxIdentity(leader.pid, fileSystem);
    if (current && (current.start !== leader.start || current.session !== leader.session)) {
      throw new PtyAdapter.PtyDrainError({ reason: "ownership-changed" });
    }
  };
  const snapshot = () => {
    if (drained) return { members: [], complete: true };
    assertLeader();
    const members: LinuxProcessIdentity[] = [];
    let complete = true;
    for (const entry of fileSystem.readdirSync("/proc")) {
      if (!/^[1-9][0-9]*$/.test(entry)) continue;
      const member = readLinuxIdentity(Number(entry), fileSystem);
      if (!member) complete = false;
      else if (member.session === leader.session) members.push(member);
    }
    assertLeader();
    return { members, complete };
  };
  const failure = (cause: unknown) =>
    isPtyDrainError(cause)
      ? cause
      : new PtyAdapter.PtyDrainError({ reason: "inspection-failed", cause });
  const signalOwned = Effect.fn("NodePtyAdapter.signalOwned")(function* (
    signal: "SIGTERM" | "SIGKILL",
  ) {
    yield* Effect.try({
      try: () => {
        const { members } = snapshot();
        // Keep the captured leader until its foreground/background job groups are signalled.
        const groups = [...new Set(members.map((member) => member.group))].sort((a, b) =>
          a === leader.group ? 1 : b === leader.group ? -1 : a - b,
        );
        for (const group of groups) {
          if (!Number.isSafeInteger(group) || group <= 1) {
            throw new PtyAdapter.PtyDrainError({ reason: "ownership-changed" });
          }
          const owned = members.some((member) => {
            if (member.group !== group) return false;
            const current = readLinuxIdentity(member.pid, fileSystem);
            if (!current) return false;
            if (
              current.start !== member.start ||
              current.session !== leader.session ||
              current.group !== group
            ) {
              throw new PtyAdapter.PtyDrainError({ reason: "ownership-changed" });
            }
            return current.state !== "Z" && current.state !== "X";
          });
          if (!owned) continue;
          assertLeader();
          try {
            process.kill(-group, signal);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") continue;
            throw new PtyAdapter.PtyDrainError({ reason: "signal-failed", cause });
          }
        }
      },
      catch: failure,
    });
  });
  const awaitOwnedExit = Effect.gen(function* () {
    if (drained) return;
    let previousEmpty: string | undefined;
    while (true) {
      const census = yield* Effect.try({ try: snapshot, catch: failure });
      const hasLiveMember = census.members.some(
        (member) => member.state !== "Z" && member.state !== "X",
      );
      if (census.complete && !hasLiveMember) {
        // A parent may fork after readdir and exit before stat. Keep zombie identities:
        // only matching complete censuses prove no unseen child replaced that parent.
        const identities = census.members
          .map((member) => `${member.pid}:${member.start}`)
          .sort()
          .join(",");
        if (identities === previousEmpty) {
          drained = true;
          return;
        }
        previousEmpty = identities;
      } else previousEmpty = undefined;
      yield* Effect.sleep("10 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new PtyAdapter.PtyDrainError({ reason: "deadline" })),
    }),
  );
  return { signalOwned, awaitOwnedExit };
};

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly exitSubscription: import("node-pty").IDisposable;
  signalOwned?: NonNullable<PtyAdapter.PtyProcess["signalOwned"]>;
  awaitOwnedExit?: NonNullable<PtyAdapter.PtyProcess["awaitOwnedExit"]>;

  constructor(process: import("node-pty").IPty, platform: NodeJS.Platform) {
    this.process = process;
    this.platform = platform;
    this.exitSubscription = process.onExit((event) => {
      if (this.exitEvent) return;
      this.exitEvent = { exitCode: event.exitCode, signal: event.signal ?? null };
      this.exitSubscription.dispose();
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty terminates the Windows process tree without a POSIX signal.
    this.process.kill(this.platform === "win32" ? undefined : signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  disposeExitSubscription(): void {
    this.exitSubscription.dispose();
    this.exitListeners.clear();
  }
}

const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () => {
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          });
          return { nativeProcess, process: new NodePtyProcess(nativeProcess, platform) };
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      if (platform === "win32") {
        yield* waitForWindowsPid(ptyProcess.nativeProcess, ptyProcess.process, input.shell).pipe(
          Effect.onError(() =>
            Effect.sync(() => ptyProcess.process.disposeExitSubscription()).pipe(
              Effect.andThen(killStartingWindowsPty(ptyProcess.nativeProcess)),
            ),
          ),
        );
      }
      if (platform === "linux") {
        const ownership = yield* captureLinuxSession(ptyProcess.process.pid);
        if (ownership) {
          const drain = makeLinuxSessionDrain(ownership);
          ptyProcess.process.signalOwned = drain.signalOwned;
          ptyProcess.process.awaitOwnedExit = drain.awaitOwnedExit;
        }
      }
      return ptyProcess.process;
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
