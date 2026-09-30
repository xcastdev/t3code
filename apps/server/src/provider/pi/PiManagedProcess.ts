import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const LaunchSchema = Schema.Struct({
  workspaceRoot: Schema.String,
  protectedRoots: Schema.Array(Schema.String),
  runtimeFiles: Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String })),
  argv: Schema.Array(Schema.String),
  memoryBytes: Schema.Int,
  runtimeSeconds: Schema.Int,
});
export type PiManagedLaunch = typeof LaunchSchema.Type;
const decodeLaunch = Schema.decodeEffect(LaunchSchema);
const encodeArguments = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export class PiManagedProcessError extends Schema.TaggedError<PiManagedProcessError>()(
  "PiManagedProcessError",
  {
    phase: Schema.Literals(["unavailable", "validation", "startup", "transport", "quarantine"]),
    message: Schema.String,
  },
) {}
const isPiManagedProcessError = Schema.is(PiManagedProcessError);
const fail = (phase: PiManagedProcessError["phase"], message: string) =>
  Effect.fail(new PiManagedProcessError({ phase, message }));

// Callers supply a frozen server-owned closure and the protected roots for this environment.
// This leaf verifies launch containment; scheduler/worktree registration and role authority remain upstream.
export const validatePiManagedLaunch = Effect.fn("validatePiManagedLaunch")(
  function* (input: PiManagedLaunch) {
    if ((yield* HostProcessPlatform) !== "linux")
      return yield* fail("unavailable", "Managed Pi execution requires the proven Linux boundary.");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const value = yield* decodeLaunch(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () =>
          new PiManagedProcessError({
            phase: "validation",
            message:
              "Invalid managed launch fields; environment and FD passthrough are unavailable.",
          }),
      ),
    );
    if (
      value.memoryBytes < 16777216 ||
      value.memoryBytes > 2147483648 ||
      value.runtimeSeconds < 1 ||
      value.runtimeSeconds > 3600
    )
      return yield* fail(
        "validation",
        "Managed launch requires explicit bounded memory/time bounds.",
      );
    if (
      value.runtimeFiles.length > 128 ||
      value.argv.length > 256 ||
      value.protectedRoots.length > 64
    )
      return yield* fail("validation", "Managed runtime closure exceeds its bounds.");
    if (value.protectedRoots.length === 0)
      return yield* fail("validation", "Managed launch requires protected roots.");
    const overlaps = (a: string, b: string) =>
      a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    if (
      !path.isAbsolute(value.workspaceRoot) ||
      path.resolve(value.workspaceRoot) !== value.workspaceRoot
    )
      return yield* fail("validation", "Assigned cwd must be canonical and absolute.");
    const root = yield* fs.realPath(value.workspaceRoot);
    if (root !== value.workspaceRoot || root === "/")
      return yield* fail(
        "validation",
        "Assigned cwd must be canonical and cannot be the host root.",
      );
    const protectedRoots = yield* Effect.forEach(value.protectedRoots, (root) => fs.realPath(root));
    if (protectedRoots.some((entry) => overlaps(root, entry)))
      return yield* fail("validation", "Assigned cwd overlaps protected data.");
    const rootStat = yield* fs.stat(root);
    if (rootStat.type !== "Directory" || Option.isNone(rootStat.ino))
      return yield* fail("validation", "Assigned cwd requires a directory inode.");
    const runtimeFiles: Array<{ source: string; target: string; dev: number; ino: number }> = [];
    for (const file of value.runtimeFiles) {
      if (
        !/^\/(?:runtime|bin|lib|lib64|usr\/lib|usr\/lib64)\/[^\0\r\n]+$/.test(file.target) ||
        path.resolve(file.target) !== file.target
      )
        return yield* fail("validation", "Runtime mount target is outside the explicit closure.");
      if (runtimeFiles.some((entry) => overlaps(file.target, entry.target)))
        return yield* fail("validation", "Runtime mount targets overlap.");
      const source = yield* fs.realPath(file.source);
      if (protectedRoots.some((entry) => overlaps(source, entry)) || overlaps(source, root))
        return yield* fail("validation", "Runtime closure overlaps protected or writable data.");
      const stat = yield* fs.stat(source);
      if (stat.type !== "File" || Option.isNone(stat.ino))
        return yield* fail(
          "validation",
          "Runtime closure requires each source to be a regular file with an inode.",
        );
      runtimeFiles.push({ source, target: file.target, dev: stat.dev, ino: stat.ino.value });
    }
    if (
      !value.argv[0] ||
      !runtimeFiles.some((file) => file.target === value.argv[0]) ||
      value.argv.some((arg) => arg.includes("\0")) ||
      Buffer.byteLength(yield* encodeArguments(value.argv)) > 16384
    )
      return yield* fail(
        "validation",
        "Managed executable must belong to the bounded runtime closure.",
      );
    return {
      ...value,
      workspace: { path: root, dev: rootStat.dev, ino: rootStat.ino.value },
      protectedRoots,
      runtimeFiles,
    };
  },
  Effect.mapError((cause) =>
    isPiManagedProcessError(cause)
      ? cause
      : new PiManagedProcessError({
          phase: "validation",
          message: "Unable to verify managed filesystem identity.",
        }),
  ),
);

const FileIdentitySchema = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
  dev: Schema.Int,
  ino: Schema.Int,
});
const BootstrapSchema = Schema.Struct({
  ...LaunchSchema.fields,
  workspace: Schema.Struct({ path: Schema.String, dev: Schema.Int, ino: Schema.Int }),
  runtimeFiles: Schema.Array(FileIdentitySchema),
  unit: Schema.String,
  nonce: Schema.String,
});
const ControlSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["start", "end"]) }),
  Schema.Struct({ type: Schema.Literal("input"), data: Schema.String }),
]);
const OwnerSchema = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Schema.String,
  invocation: Schema.String,
  cgroup: Schema.String,
  pid: Schema.Int,
  memoryBytes: Schema.Int,
  swapBytes: Schema.Int,
  oomGroup: Schema.Int,
  nonce: Schema.String,
});
const FrameSchema = Schema.Union([
  OwnerSchema,
  Schema.Struct({ type: Schema.Literal("started"), pid: Schema.Int }),
  Schema.Struct({ type: Schema.Literals(["stdout", "stderr"]), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("exited"), code: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
]);
const encodeBootstrap = Schema.encodeEffect(Schema.fromJsonString(BootstrapSchema));
const encodeControl = Schema.encodeEffect(Schema.fromJsonString(ControlSchema));
const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(FrameSchema));
export type PiManagedProcessOwner = typeof OwnerSchema.Type;

export interface PiManagedDrain {
  readonly unit: string;
  readonly invocation: string;
  readonly cgroup: string;
  readonly ownerPid: number | null;
  readonly memoryBytes: number;
  readonly swapBytes: number;
  readonly oomGroup: number;
  readonly launcherPid: number;
  readonly childPid: number | null;
  readonly childExitCode: number | null;
  readonly kernel: string;
}
export interface PiManagedProcess {
  readonly owner: PiManagedProcessOwner;
  readonly start: Effect.Effect<number, PiManagedProcessError>;
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, PiManagedProcessError>;
  readonly endInput: Effect.Effect<void, PiManagedProcessError>;
  readonly stdout: Stream.Stream<Uint8Array, PiManagedProcessError>;
  readonly stderr: Stream.Stream<Uint8Array, PiManagedProcessError>;
  readonly awaitExit: Effect.Effect<PiManagedDrain, PiManagedProcessError>;
  readonly stop: Effect.Effect<PiManagedDrain, PiManagedProcessError>;
}

const ShowSchema = Schema.Struct({
  Description: Schema.String,
  InvocationID: Schema.String,
  ControlGroup: Schema.String,
  ActiveState: Schema.String,
  KillMode: Schema.String,
  RuntimeMaxUSec: Schema.String,
  TimeoutStopUSec: Schema.String,
});

const decodeShow = Schema.decodeUnknownEffect(ShowSchema);

// The caller's Scope owns the unique service from spawn through confirmed kernel drain.
// Acquiring does not start untrusted code. start acknowledges verified ownership once.
export const acquirePiManagedProcess = Effect.fn("acquirePiManagedProcess")(function* (
  input: PiManagedLaunch,
): Effect.fn.Return<
  PiManagedProcess,
  PiManagedProcessError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> {
  const launch = yield* validatePiManagedLaunch(input);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const uid = yield* HostProcessUserId;
  if (uid === undefined)
    return yield* fail("unavailable", "Linux user-manager identity is unavailable.");
  const managerEnv = {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
    LANG: "C.UTF-8",
  };
  const control = Effect.fn("PiManagedProcess.control")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, { env: managerEnv, extendEnv: false, shell: false }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 8192 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (stdout.truncated || stderr.truncated || stdout.invalidUtf8)
          return yield* fail("startup", "Managed host control exceeded its bounded receipt.");
        return { stdout: stdout.text, code: Number(code) };
      }),
    ).pipe(
      Effect.timeout("3 seconds"),
      Effect.mapError(
        () =>
          new PiManagedProcessError({
            phase: "startup",
            message: "Managed Linux control unavailable or unconfirmed.",
          }),
      ),
    );
  });
  const version = yield* control("/usr/bin/bwrap", ["--version"]);
  if (version.code !== 0 || version.stdout.trim() !== "bubblewrap 0.12.0")
    return yield* fail("unavailable", "Managed execution requires the proven bubblewrap 0.12.0.");
  const helper = yield* path
    .fromFileUrl(new URL("./pi-managed-process-owner.py", import.meta.url))
    .pipe(
      Effect.mapError(
        () =>
          new PiManagedProcessError({
            phase: "unavailable",
            message: "Managed helper layout is unavailable.",
          }),
      ),
    );
  const helperStat = yield* fs.stat(helper).pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "unavailable",
          message: "The owned Linux helper is absent from this runtime layout.",
        }),
    ),
  );
  if (helperStat.type !== "File")
    return yield* fail("unavailable", "The owned Linux helper must be a trusted regular file.");
  const nonce = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "startup",
          message: "Managed launch identity allocation failed.",
        }),
    ),
  );
  const unit = `t3-pi-managed-${nonce}.service`;
  const description = `T3 Pi managed ${nonce}`;
  const specText = yield* encodeBootstrap({
    ...launch,
    argv: [...launch.argv],
    unit,
    nonce,
  }).pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "validation",
          message: "Invalid managed bootstrap specification.",
        }),
    ),
  );
  const spec = Buffer.from(specText).toString("base64");
  if (spec.length > 65536)
    return yield* fail("validation", "Managed launch specification exceeds the bootstrap bound.");
  const readUnit = Effect.fn("PiManagedProcess.readUnit")(function* () {
    const result = yield* control("/usr/bin/systemctl", [
      "--user",
      "show",
      unit,
      "--property=Description,InvocationID,ControlGroup,ActiveState,KillMode,RuntimeMaxUSec,TimeoutStopUSec",
    ]);
    if (result.code !== 0) return yield* fail("startup", "Managed service receipt is unavailable.");
    return yield* decodeShow(
      Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => {
            const equals = line.indexOf("=");
            return [line.slice(0, equals), line.slice(equals + 1)];
          }),
      ),
    ).pipe(
      Effect.mapError(
        () =>
          new PiManagedProcessError({
            phase: "startup",
            message: "Managed service receipt is malformed.",
          }),
      ),
    );
  });
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "/usr/bin/systemd-run",
            [
              "--user",
              "--wait",
              "--pipe",
              "--quiet",
              `--unit=${unit}`,
              `--description=${description}`,
              "-p",
              `MemoryMax=${launch.memoryBytes}`,
              "-p",
              "MemorySwapMax=0",
              "-p",
              "OOMPolicy=kill",
              "-p",
              "KillMode=control-group",
              "-p",
              `RuntimeMaxSec=${launch.runtimeSeconds}s`,
              "-p",
              "TimeoutStopSec=2s",
              "/usr/bin/python3",
              helper,
              spec,
            ],
            { cwd: launch.workspace.path, env: managerEnv, extendEnv: false, shell: false },
          ),
        )
        .pipe(
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Managed owned service could not launch.",
              }),
          ),
        );
      const ownerReady = yield* Deferred.make<PiManagedProcessOwner, PiManagedProcessError>();
      const started = yield* Deferred.make<number, PiManagedProcessError>();
      const exited = yield* Deferred.make<number, PiManagedProcessError>();
      const incoming = yield* Queue.bounded<Uint8Array, Cause.Done>(32);
      const stdout = yield* Queue.bounded<Uint8Array, PiManagedProcessError | Cause.Done>(32);
      const stderr = yield* Queue.bounded<Uint8Array, PiManagedProcessError | Cause.Done>(32);
      let owner: PiManagedProcessOwner | undefined;
      let state: "owned" | "starting" | "running" | "stopped" = "owned";
      let childExitCode: number | null = null;
      let childPid: number | null = null;
      const stop = yield* Effect.cached(
        Effect.gen(function* () {
          state = "stopped";
          const before = yield* readUnit();
          if (
            (before.Description !== description && before.ActiveState !== "inactive") ||
            (owner && before.InvocationID && before.InvocationID !== owner.invocation)
          )
            return yield* fail(
              "quarantine",
              "Owned service identity changed; termination is unproved.",
            );
          const group =
            owner?.cgroup ?? (before.ControlGroup ? `/sys/fs/cgroup${before.ControlGroup}` : "");
          if (group && (!group.startsWith("/sys/fs/cgroup/") || !group.endsWith(`/${unit}`)))
            return yield* fail(
              "quarantine",
              "Owned cgroup identity changed; termination is unproved.",
            );
          if (before.Description === description && before.ActiveState !== "inactive")
            yield* control("/usr/bin/systemctl", ["--user", "stop", unit]);
          yield* Queue.end(incoming);
          yield* child.exitCode.pipe(Effect.timeout("3 seconds"));
          const after = yield* readUnit();
          if (!["inactive", "failed"].includes(after.ActiveState) || after.ControlGroup)
            return yield* fail("quarantine", "Owned service remains active after stop.");
          const eventsPath = group ? path.join(group, "cgroup.events") : "";
          const kernel =
            eventsPath && (yield* fs.exists(eventsPath))
              ? yield* fs.readFileString(eventsPath)
              : "removed";
          if (kernel !== "removed" && !kernel.split("\n").includes("populated 0"))
            return yield* fail(
              "quarantine",
              "Owned descendants may remain; workspace must be quarantined.",
            );
          yield* Queue.end(stdout);
          yield* Queue.end(stderr);
          const stoppedError = new PiManagedProcessError({
            phase: "startup",
            message: "Owned process stopped before its requested lifecycle receipt.",
          });
          yield* Deferred.fail(started, stoppedError);
          yield* Deferred.fail(exited, stoppedError);
          return {
            unit,
            invocation: owner?.invocation ?? before.InvocationID,
            cgroup: group,
            ownerPid: owner?.pid ?? null,
            memoryBytes: launch.memoryBytes,
            swapBytes: 0,
            oomGroup: owner?.oomGroup ?? 0,
            launcherPid: Number(child.pid),
            childPid,
            childExitCode,
            kernel,
          };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new PiManagedProcessError({
                phase: "quarantine",
                message: isPiManagedProcessError(cause)
                  ? `${cause.message} Quarantine the run/workspace.`
                  : "Owned process drain could not be proved; quarantine the run/workspace.",
              }),
          ),
          Effect.uninterruptible,
        ),
      );
      yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie, Effect.asVoid));
      const transportFailure = Effect.fn("PiManagedProcess.transportFailure")(function* (
        error: PiManagedProcessError,
      ) {
        yield* Deferred.fail(ownerReady, error);
        yield* Deferred.fail(started, error);
        yield* Deferred.fail(exited, error);
        yield* Queue.fail(stdout, error);
        yield* Queue.fail(stderr, error);
      });
      yield* Stream.fromQueue(incoming).pipe(
        Stream.run(child.stdin),
        Effect.catch(() =>
          transportFailure(
            new PiManagedProcessError({
              phase: "transport",
              message: "Managed control pipe closed unexpectedly.",
            }),
          ),
        ),
        Effect.interruptible,
        Effect.forkScoped,
      );
      yield* child.stderr.pipe(
        Stream.runForEach(() =>
          fail("startup", "The owned Linux launcher reported a startup failure."),
        ),
        Effect.catch(() =>
          transportFailure(
            new PiManagedProcessError({
              phase: "startup",
              message: "The owned Linux launcher failed before a verified launch.",
            }),
          ),
        ),
        Effect.interruptible,
        Effect.forkScoped,
      );
      let pending = Buffer.alloc(0);
      const frame = Effect.fn("PiManagedProcess.frame")(function* (line: Buffer) {
        const event = yield* decodeFrame(line.toString("utf8"), { onExcessProperty: "error" }).pipe(
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "transport",
                message: "Invalid owned process frame.",
              }),
          ),
        );
        switch (event.type) {
          case "owner":
            if (
              owner ||
              event.nonce !== nonce ||
              event.unit !== unit ||
              !/^[a-f0-9]{32}$/.test(event.invocation) ||
              event.pid < 1 ||
              !event.cgroup.startsWith("/sys/fs/cgroup/") ||
              !event.cgroup.endsWith(`/${unit}`) ||
              event.memoryBytes !== launch.memoryBytes ||
              event.swapBytes !== 0 ||
              event.oomGroup !== 1
            )
              return yield* fail(
                "startup",
                "Owned process receipt does not match the allocated boundary.",
              );
            owner = event;
            yield* Deferred.succeed(ownerReady, event);
            break;
          case "started":
            if (!owner || state !== "starting" || event.pid < 1)
              return yield* fail("transport", "Unexpected process start receipt.");
            state = "running";
            childPid = event.pid;
            yield* Deferred.succeed(started, event.pid);
            break;
          case "stdout":
          case "stderr": {
            if (state !== "running")
              return yield* fail("transport", "Worker output preceded the start receipt.");
            const bytes = Buffer.from(event.data, "base64");
            if (bytes.length > 8192 || bytes.toString("base64") !== event.data)
              return yield* fail("transport", "Worker output exceeded the byte framing bound.");
            yield* Queue.offer(event.type === "stdout" ? stdout : stderr, bytes);
            break;
          }
          case "exited":
            if (state !== "running" || childExitCode !== null)
              return yield* fail("transport", "Unexpected process exit receipt.");
            childExitCode = event.code;
            yield* Deferred.succeed(exited, event.code);
            yield* Queue.end(stdout);
            yield* Queue.end(stderr);
            break;
          case "failed":
            return yield* fail("startup", event.message);
        }
      });
      yield* child.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            let offset = 0;
            while (offset < chunk.byteLength) {
              const newline = chunk.indexOf(10, offset);
              const end = newline < 0 ? chunk.byteLength : newline;
              if (pending.byteLength + end - offset > 65536)
                return yield* fail("transport", "Owned process frame exceeds its byte bound.");
              pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
              if (newline < 0) break;
              yield* frame(pending);
              pending = Buffer.alloc(0);
              offset = end + 1;
            }
          }),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            if (state !== "stopped" && childExitCode === null)
              return yield* fail("transport", "Owned process closed without an exit receipt.");
          }),
        ),
        Effect.catch((cause) =>
          transportFailure(
            isPiManagedProcessError(cause)
              ? cause
              : new PiManagedProcessError({
                  phase: "transport",
                  message: "Owned process stream failed.",
                }),
          ),
        ),
        Effect.interruptible,
        Effect.forkScoped,
      );
      const verified = yield* restore(
        Deferred.await(ownerReady).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Owned Linux startup did not provide its verified receipt.",
              }),
          ),
        ),
      );
      const policy = yield* restore(readUnit());
      if (
        policy.Description !== description ||
        policy.InvocationID !== verified.invocation ||
        `/sys/fs/cgroup${policy.ControlGroup}` !== verified.cgroup ||
        policy.KillMode !== "control-group" ||
        policy.RuntimeMaxUSec !== `${launch.runtimeSeconds}s` ||
        policy.TimeoutStopUSec !== "2s"
      )
        return yield* fail(
          "startup",
          "The owned service policy does not match the proven Linux boundary.",
        );
      const sendControl = (value: typeof ControlSchema.Type) =>
        encodeControl(value).pipe(
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "transport",
                message: "Invalid owned process control.",
              }),
          ),
          Effect.flatMap((text) => Queue.offer(incoming, Buffer.from(text + "\n"))),
          Effect.asVoid,
        );
      const start = Effect.gen(function* () {
        if (state === "stopped")
          return yield* fail("startup", "Stopped owned processes cannot start.");
        if (state === "owned") {
          state = "starting";
          yield* sendControl({ type: "start" });
        }
        return yield* Deferred.await(started).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(
            () =>
              new PiManagedProcessError({
                phase: "startup",
                message: "Managed execution failed before its start receipt.",
              }),
          ),
        );
      });
      return {
        owner: verified,
        start,
        stop,
        send: (bytes: Uint8Array) =>
          Effect.gen(function* () {
            if (state !== "running" || childExitCode !== null || bytes.byteLength > 8192)
              return yield* fail(
                "transport",
                "Managed input requires a running owned process and a bounded chunk.",
              );
            yield* sendControl({ type: "input", data: Buffer.from(bytes).toString("base64") });
          }),
        endInput: Effect.suspend(() =>
          state === "running" && childExitCode === null
            ? sendControl({ type: "end" })
            : fail("transport", "Managed input cannot close before start or after exit."),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        awaitExit: Deferred.await(exited).pipe(Effect.andThen(stop)),
      };
    }),
  );
});
