import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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

// Electron's fixed ELF closure can include more than 128 physical files.
export const MAX_PI_RUNTIME_FILES = 256;
export const MAX_PI_RUNTIME_FILE_BYTES = 256 * 1024 * 1024;
export const piRuntimeClosureByteLimit = (electron: boolean) =>
  electron ? 2 * MAX_PI_RUNTIME_FILE_BYTES : MAX_PI_RUNTIME_FILE_BYTES;

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const GitObject = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
const ReviewTargetSource = Schema.Struct({
  source: Schema.String,
  target: Schema.Literal("/review-target"),
  targetHash: Digest,
  manifestHash: Digest,
  testedCommit: GitObject,
  testedTree: GitObject,
  dev: Schema.Int,
  ino: Schema.Int,
});
const LaunchSchema = Schema.Struct({
  reviewTarget: Schema.optional(ReviewTargetSource),
  workspaceRoot: Schema.String,
  workspaceAccess: Schema.optional(Schema.Literals(["readonly", "readwrite"])),
  nativeStateRoot: Schema.optional(Schema.String),
  protectedWorkspaceEntries: Schema.optional(Schema.Array(Schema.String)),
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
      value.runtimeFiles.length > MAX_PI_RUNTIME_FILES ||
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
    if (value.reviewTarget) {
      const target = value.reviewTarget;
      if (
        !path.isAbsolute(target.source) ||
        path.resolve(target.source) !== target.source ||
        (yield* fs.realPath(target.source)) !== target.source ||
        overlaps(target.source, root) ||
        protectedRoots.some((entry) => overlaps(entry, target.source))
      )
        return yield* fail(
          "validation",
          "Review target must be an independent canonical worktree.",
        );
      const stat = yield* fs.stat(target.source);
      if (
        stat.type !== "Directory" ||
        Option.isNone(stat.ino) ||
        stat.dev !== target.dev ||
        stat.ino.value !== target.ino
      )
        return yield* fail("validation", "Review target directory identity changed.");
    }
    const nativeState =
      value.nativeStateRoot === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const statePath = value.nativeStateRoot!;
            if (
              !path.isAbsolute(statePath) ||
              path.resolve(statePath) !== statePath ||
              (yield* fs.realPath(statePath)) !== statePath ||
              overlaps(statePath, root) ||
              protectedRoots.some((entry) => overlaps(statePath, entry))
            )
              return yield* fail(
                "validation",
                "Native state must be canonical and separately owned.",
              );
            const stat = yield* fs.stat(statePath);
            if (stat.type !== "Directory" || Option.isNone(stat.ino))
              return yield* fail("validation", "Native state requires a directory inode.");
            return { path: statePath, dev: stat.dev, ino: stat.ino.value };
          });
    if (value.reviewTarget && nativeState && overlaps(value.reviewTarget.source, nativeState.path))
      return yield* fail("validation", "Review target overlaps native state.");
    const protectedWorkspaceEntries: Array<{
      source: string;
      target: string;
      dev: number;
      ino: number;
      directory: boolean;
    }> = [];
    if ((value.protectedWorkspaceEntries?.length ?? 0) > 16)
      return yield* fail("validation", "Protected workspace entries exceed their bound.");
    for (const entry of value.protectedWorkspaceEntries ?? []) {
      if (
        !/^[^/\\\0\r\n]+(?:\/[^/\\\0\r\n]+)*$/.test(entry) ||
        entry.split("/").some((component) => component === "." || component === "..")
      )
        return yield* fail(
          "validation",
          "Protected workspace entry must use exact relative components.",
        );
      const source = path.join(root, entry);
      const target = `/workspace/${entry}`;
      // Every component must resolve exactly; an intermediate symlink is also rejected.
      for (let index = 1; index <= entry.split("/").length; index++) {
        const prefix = path.join(root, ...entry.split("/").slice(0, index));
        if ((yield* fs.realPath(prefix)) !== prefix)
          return yield* fail("validation", "Protected workspace entry cannot traverse a symlink.");
      }
      if (protectedWorkspaceEntries.some((existing) => overlaps(target, existing.target)))
        return yield* fail("validation", "Protected workspace entries overlap.");
      const stat = yield* fs.stat(source);
      if (!["File", "Directory"].includes(stat.type) || Option.isNone(stat.ino))
        return yield* fail(
          "validation",
          "Protected workspace entry requires a file or directory inode.",
        );
      protectedWorkspaceEntries.push({
        source,
        target,
        dev: stat.dev,
        ino: stat.ino.value,
        directory: stat.type === "Directory",
      });
    }
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
      if (
        protectedRoots.some((entry) => overlaps(source, entry)) ||
        overlaps(source, root) ||
        (value.reviewTarget !== undefined && overlaps(source, value.reviewTarget.source)) ||
        (nativeState && overlaps(source, nativeState.path))
      )
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
      workspaceAccess: value.workspaceAccess ?? "readwrite",
      nativeState,
      protectedWorkspaceEntries,
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
const PinnedLaunchSchema = Schema.Struct({
  ...LaunchSchema.fields,
  workspace: Schema.Struct({ path: Schema.String, dev: Schema.Int, ino: Schema.Int }),
  nativeState: Schema.optional(
    Schema.Struct({ path: Schema.String, dev: Schema.Int, ino: Schema.Int }),
  ),
  protectedWorkspaceEntries: Schema.Array(
    Schema.Struct({ ...FileIdentitySchema.fields, directory: Schema.Boolean }),
  ),
  runtimeFiles: Schema.Array(FileIdentitySchema),
});
const BootstrapSchema = Schema.Struct({
  ...PinnedLaunchSchema.fields,
  unit: Schema.String,
  nonce: Schema.String,
});
const AllocationSchema = Schema.Struct({
  version: Schema.Literal(1),
  unit: Schema.String,
  nonce: Schema.String,
  policy: Schema.Struct({ memoryBytes: Schema.Int, runtimeSeconds: Schema.Int }),
  launch: PinnedLaunchSchema,
});
export const PiManagedProcessAllocationSchema = AllocationSchema;
export type PiManagedProcessAllocation = typeof AllocationSchema.Type;
export interface PiManagedProcessPersistence {
  readonly allocation: PiManagedProcessAllocation;
  /** Original operation deadline, never a fresh duration from activation. */
  readonly deadlineAtMs?: number;
  readonly afterDrain?: (drain: PiManagedDrain) => Effect.Effect<void, PiManagedProcessError>;
  // Root must atomically consume the persisted descriptor once; this leaf has no durable database.
  readonly claimActivation: (
    allocation: PiManagedProcessAllocation,
  ) => Effect.Effect<void, PiManagedProcessError>;
  readonly beforeStart: (
    owner: PiManagedProcessOwner,
  ) => Effect.Effect<void, PiManagedProcessError>;
}
const decodeAllocation = Schema.decodeEffect(AllocationSchema);
const encodePinnedLaunchValue = Schema.encodeEffect(Schema.fromJsonString(PinnedLaunchSchema));
const encodePinnedLaunch = (input: typeof PinnedLaunchSchema.Type) =>
  encodePinnedLaunchValue(input).pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "validation",
          message: "Pinned launch could not be encoded.",
        }),
    ),
  );
export const preallocatePiManagedProcess = Effect.fn("preallocatePiManagedProcess")(function* (
  input: PiManagedLaunch,
) {
  const launch = yield* validatePiManagedLaunch(input);
  const crypto = yield* Crypto.Crypto;
  const nonce = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "startup",
          message: "Managed launch identity allocation failed.",
        }),
    ),
  );
  return {
    version: 1 as const,
    unit: `t3-pi-managed-${nonce}.service`,
    nonce,
    policy: { memoryBytes: launch.memoryBytes, runtimeSeconds: launch.runtimeSeconds },
    launch,
  };
});
const validateAllocation = Effect.fn("PiManagedProcess.validateAllocation")(function* (
  input: PiManagedProcessAllocation,
) {
  const value = yield* decodeAllocation(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "validation",
          message: "Invalid preallocated process descriptor.",
        }),
    ),
  );
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nonce) ||
    value.unit !== `t3-pi-managed-${value.nonce}.service` ||
    value.policy.memoryBytes !== value.launch.memoryBytes ||
    value.policy.runtimeSeconds !== value.launch.runtimeSeconds
  )
    return yield* fail("validation", "Preallocated process identity or policy is inconsistent.");
  return value;
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
  LoadState: Schema.String,
  Description: Schema.String,
  InvocationID: Schema.String,
  ControlGroup: Schema.String,
  ActiveState: Schema.String,
  KillMode: Schema.String,
  Restart: Schema.String,
  RuntimeMaxUSec: Schema.String,
  TimeoutStopUSec: Schema.String,
  UnsetEnvironment: Schema.String,
  Environment: Schema.String,
});

const decodeShow = Schema.decodeUnknownEffect(ShowSchema);

// The user manager also supplies service environment. Remove native loader hooks before
// Python starts; isolated interpreter startup then excludes workspace/user Python hooks.
const unsetEnvironment = [
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_PROFILE",
  "LD_PROFILE_OUTPUT",
  "LD_ORIGIN_PATH",
  "LD_HWCAP_MASK",
  "LD_SHOW_AUXV",
  "LD_TRACE_LOADED_OBJECTS",
  "LD_BIND_NOT",
  "LD_BIND_NOW",
  "LD_DYNAMIC_WEAK",
  "LD_PREFER_MAP_32BIT_EXEC",
  "LD_VERBOSE",
  "LD_WARN",
  "GLIBC_TUNABLES",
  "GCONV_PATH",
  "LOCPATH",
  "MALLOC_TRACE",
];
const unsetPolicy = [...unsetEnvironment].sort().join(" ");

// systemctl renders minute/hour boundaries as compound durations, not seconds.
const durationUsec = (text: string) => {
  const factors: Record<string, number> = {
    h: 3600000000,
    min: 60000000,
    s: 1000000,
    ms: 1000,
    us: 1,
  };
  let value = 0;
  let previous = Infinity;
  for (const token of text.split(" ")) {
    const match = /^(\d+)(h|min|s|ms|us)$/.exec(token);
    if (!match) return undefined;
    const factor = factors[match[2]!];
    if (factor === undefined || factor >= previous) return undefined;
    previous = factor;
    value += Number(match[1]) * factor;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
};

const makeManagedControl = Effect.fn("PiManagedProcess.makeControl")(function* () {
  if ((yield* HostProcessPlatform) !== "linux")
    return yield* fail("unavailable", "Managed Pi execution requires Linux.");
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
  return { control, managerEnv };
});
const readManagedUnit = Effect.fn("PiManagedProcess.readUnit")(function* (unit: string) {
  const { control } = yield* makeManagedControl();
  const result = yield* control("/usr/bin/systemctl", [
    "--user",
    "show",
    unit,
    "--property=LoadState,Description,InvocationID,ControlGroup,ActiveState,KillMode,Restart,RuntimeMaxUSec,TimeoutStopUSec,UnsetEnvironment,Environment",
  ]);
  if (result.code !== 0)
    return yield* fail("quarantine", "Managed service receipt is unavailable.");
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
          phase: "quarantine",
          message: "Managed service receipt is malformed.",
        }),
    ),
  );
});
// Recovery accepts a deadline-shortened runtime, but never a longer allocation.
const matchesPolicy = (policy: typeof ShowSchema.Type, allocation: PiManagedProcessAllocation) => {
  const runtime = durationUsec(policy.RuntimeMaxUSec);
  return (
    runtime !== undefined &&
    policy.Description === `T3 Pi managed ${allocation.nonce}` &&
    policy.KillMode === "control-group" &&
    policy.Restart === "no" &&
    runtime > 0 &&
    runtime <= allocation.policy.runtimeSeconds * 1000000 &&
    durationUsec(policy.TimeoutStopUSec) === 2000000 &&
    policy.UnsetEnvironment.split(" ").filter(Boolean).sort().join(" ") === unsetPolicy &&
    policy.Environment.split(" ").includes("LC_ALL=C") &&
    policy.Environment.split(" ").includes("LANG=C")
  );
};
const absentUnit = (policy: typeof ShowSchema.Type) =>
  policy.LoadState === "not-found" &&
  policy.ActiveState === "inactive" &&
  !policy.InvocationID &&
  !policy.ControlGroup;
export interface PiManagedProcessRecovery {
  readonly allocation: PiManagedProcessAllocation;
  // Only root's durable SQL state may supply this value.
  readonly activation: "unlaunched" | "claimed" | "owned";
  readonly owner?: PiManagedProcessOwner;
}
const RecoverySchema = Schema.Struct({
  allocation: AllocationSchema,
  activation: Schema.Literals(["unlaunched", "claimed", "owned"]),
  owner: Schema.optional(OwnerSchema),
});
const RecoveryOptionsSchema = Schema.Struct({ stop: Schema.Boolean });
const decodeRecovery = Schema.decodeEffect(RecoverySchema);
const decodeRecoveryOptions = Schema.decodeEffect(RecoveryOptionsSchema);
const decodeOwner = Schema.decodeEffect(OwnerSchema);
export interface PiManagedProcessReconciliation {
  readonly state: "absent" | "owned" | "drained";
  readonly unit: string;
  readonly invocation: string | null;
  readonly cgroup: string | null;
  readonly kernel: string;
}
export const reconcilePiManagedProcess = Effect.fn("reconcilePiManagedProcess")(
  function* (request: PiManagedProcessRecovery, options: { readonly stop: boolean }) {
    const input = yield* decodeRecovery(request, {
      onExcessProperty: "error",
    });
    const action = yield* decodeRecoveryOptions(options, {
      onExcessProperty: "error",
    });
    const allocation = yield* validateAllocation(input.allocation);
    const fs = yield* FileSystem.FileSystem;
    const { control } = yield* makeManagedControl();
    const owner =
      input.owner === undefined
        ? undefined
        : yield* decodeOwner(input.owner, { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              () =>
                new PiManagedProcessError({
                  phase: "quarantine",
                  message: "Persisted owner receipt is malformed.",
                }),
            ),
          );
    if (
      owner &&
      (owner.unit !== allocation.unit ||
        owner.nonce !== allocation.nonce ||
        !/^[a-f0-9]{32}$/.test(owner.invocation) ||
        owner.pid < 1 ||
        !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
        !owner.cgroup.endsWith(`/${allocation.unit}`) ||
        owner.cgroup.split("/").some((part) => part === "." || part === "..") ||
        owner.memoryBytes !== allocation.policy.memoryBytes ||
        owner.swapBytes !== 0 ||
        owner.oomGroup !== 1)
    )
      return yield* fail("quarantine", "Persisted ownership does not match its allocation.");
    const before = yield* readManagedUnit(allocation.unit);
    if (absentUnit(before)) {
      if (input.activation === "unlaunched" && !owner)
        return {
          state: "absent" as const,
          unit: allocation.unit,
          invocation: null,
          cgroup: null,
          kernel: "not-created",
        };
      if (input.activation !== "owned" || !owner)
        return yield* fail(
          "quarantine",
          "Claimed activation has no captured owner; absence cannot prove its history.",
        );
      if (yield* fs.exists(`${owner.cgroup}/cgroup.events`))
        return yield* fail("quarantine", "Absent service retains an unverified cgroup.");
      return {
        state: "drained" as const,
        unit: allocation.unit,
        invocation: owner.invocation,
        cgroup: owner.cgroup,
        kernel: "removed",
      };
    }
    if (
      input.activation !== "owned" ||
      !owner ||
      !matchesPolicy(before, allocation) ||
      before.InvocationID !== owner.invocation ||
      `/sys/fs/cgroup${before.ControlGroup}` !== owner.cgroup
    )
      return yield* fail(
        "quarantine",
        "Current service identity differs from captured ownership; no termination was attempted.",
      );
    const resources = yield* Effect.all([
      fs.readFileString(`${owner.cgroup}/memory.max`),
      fs.readFileString(`${owner.cgroup}/memory.swap.max`),
      fs.readFileString(`${owner.cgroup}/memory.oom.group`),
    ]);
    if (
      resources[0].trim() !== String(allocation.policy.memoryBytes) ||
      resources[1].trim() !== "0" ||
      resources[2].trim() !== "1"
    )
      return yield* fail("quarantine", "Current cgroup policy differs from captured ownership.");
    if (!action.stop)
      return {
        state: "owned" as const,
        unit: allocation.unit,
        invocation: owner.invocation,
        cgroup: owner.cgroup,
        kernel: "owned",
      };
    yield* control("/usr/bin/systemctl", ["--user", "stop", allocation.unit]);
    const after = yield* readManagedUnit(allocation.unit);
    if (
      !absentUnit(after) &&
      (!matchesPolicy(after, allocation) ||
        (after.InvocationID && after.InvocationID !== owner.invocation) ||
        !["inactive", "failed"].includes(after.ActiveState) ||
        after.ControlGroup)
    )
      return yield* fail("quarantine", "Owned service drain could not be confirmed.");
    const kernel = (yield* fs.exists(`${owner.cgroup}/cgroup.events`))
      ? yield* fs.readFileString(`${owner.cgroup}/cgroup.events`)
      : "removed";
    if (kernel !== "removed" && !kernel.split("\n").includes("populated 0"))
      return yield* fail("quarantine", "Owned descendants remain after stop.");
    return {
      state: "drained" as const,
      unit: allocation.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      kernel,
    };
  },
  Effect.mapError((cause) =>
    isPiManagedProcessError(cause)
      ? cause
      : new PiManagedProcessError({
          phase: "quarantine",
          message: "Ownership reconciliation is unproved; quarantine the run/workspace.",
        }),
  ),
);

// The caller's Scope owns the unique service from spawn through confirmed kernel drain.
// Acquiring does not start untrusted code. start acknowledges verified ownership once.
export const acquirePiManagedProcess = Effect.fn("acquirePiManagedProcess")(function* (
  input: PiManagedLaunch,
  persistence?: PiManagedProcessPersistence,
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { control, managerEnv } = yield* makeManagedControl();
  // Fixed no-op exercises the actual launch options, independent of release labels.
  // Private scratch is the only writable host bind; the inherited root is read-only.
  const capability = yield* Effect.scoped(
    Effect.gen(function* () {
      // The parent removes scratch even if the control child is interrupted or times out.
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bwrap-probe-" });
      return yield* control("/usr/bin/python3", [
        "-c",
        `import os, subprocess, sys
root = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
writable = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    sys.exit(subprocess.call(["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--ro-bind-fd", str(root), "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind-fd", str(writable), "/tmp/probe", "--ro-bind-fd", str(writable), "/tmp/probe-readonly", "--setenv", "HOME", "/tmp/probe", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--remount-ro", "/", "--chdir", "/tmp/probe", "--", "/usr/bin/true"], pass_fds=(root, writable), env={}))
finally:
    os.close(writable)
    os.close(root)
`,
        scratch,
      ]);
    }),
  ).pipe(
    Effect.mapError(
      () =>
        new PiManagedProcessError({
          phase: "unavailable",
          message: "Managed bubblewrap capabilities are unavailable or unconfirmed.",
        }),
    ),
  );
  if (capability.code !== 0)
    return yield* fail(
      "unavailable",
      "Managed bubblewrap capabilities are unavailable or unconfirmed.",
    );
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
  const allocation = persistence
    ? yield* validateAllocation(persistence.allocation)
    : yield* preallocatePiManagedProcess(input);
  if ((yield* encodePinnedLaunch(allocation.launch)) !== (yield* encodePinnedLaunch(launch)))
    return yield* fail("validation", "Preallocated filesystem identity or launch policy changed.");
  const { nonce, unit } = allocation;
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
  const readUnit = () =>
    readManagedUnit(unit).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  if (persistence) yield* persistence.claimActivation(allocation);
  const runtimeSeconds =
    persistence?.deadlineAtMs === undefined
      ? launch.runtimeSeconds
      : Math.min(
          launch.runtimeSeconds,
          Math.floor((persistence.deadlineAtMs - (yield* Clock.currentTimeMillis)) / 1000),
        );
  if (!Number.isSafeInteger(runtimeSeconds) || runtimeSeconds < 1)
    return yield* fail("startup", "Original operation deadline cannot accommodate activation.");
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
              "Restart=no",
              "-p",
              `RuntimeMaxSec=${runtimeSeconds}s`,
              "-p",
              "TimeoutStopSec=2s",
              "-p",
              `UnsetEnvironment=${unsetEnvironment.join(" ")}`,
              "-p",
              "Environment=LC_ALL=C LANG=C",
              "/usr/bin/python3",
              "-I",
              "-S",
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
      let stopping = false;
      let transportError: PiManagedProcessError | undefined;
      let childExitCode: number | null = null;
      let childPid: number | null = null;
      let closeInput = Effect.void;
      let awaitReaders = Effect.void;
      const stop = yield* Effect.cached(
        Effect.gen(function* () {
          stopping = true;
          // Canceled consumers cannot release a reader already blocked on a bounded offer.
          // Keep receipt validation active while discarding its previously queued output.
          if (childExitCode === null) {
            yield* Queue.clear(stdout).pipe(Effect.ignore);
            yield* Queue.clear(stderr).pipe(Effect.ignore);
          }
          const capturedOwner = owner;
          if (!capturedOwner) {
            // The launcher is ours; an existing unit with the same nonce is not.
            // Closing this launcher's input permits a late helper to take its EOF path.
            yield* Queue.end(incoming);
            yield* closeInput.pipe(Effect.timeout("3 seconds"));
            yield* child.exitCode.pipe(Effect.timeout("3 seconds"));
            yield* awaitReaders.pipe(Effect.timeout("3 seconds"));
            state = "stopped";
            yield* Queue.end(stdout);
            yield* Queue.end(stderr);
            return yield* fail(
              "quarantine",
              "Launcher input and process drained without a captured service invocation; unit ownership remains unproved.",
            );
          }
          const before = yield* readUnit();
          if (
            (before.Description !== description && !absentUnit(before)) ||
            (before.InvocationID && before.InvocationID !== capturedOwner.invocation) ||
            (before.ControlGroup && `/sys/fs/cgroup${before.ControlGroup}` !== capturedOwner.cgroup)
          )
            return yield* fail(
              "quarantine",
              "Owned service identity changed; termination is unproved.",
            );
          const group = capturedOwner.cgroup;
          if (group && (!group.startsWith("/sys/fs/cgroup/") || !group.endsWith(`/${unit}`)))
            return yield* fail(
              "quarantine",
              "Owned cgroup identity changed; termination is unproved.",
            );
          if (before.Description === description && before.ActiveState !== "inactive")
            yield* control("/usr/bin/systemctl", ["--user", "stop", unit]);
          yield* Queue.end(incoming);
          yield* child.exitCode.pipe(Effect.timeout("3 seconds"));
          yield* awaitReaders.pipe(Effect.timeout("3 seconds"));
          state = "stopped";
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
          const drain = {
            unit,
            invocation: capturedOwner.invocation,
            cgroup: group,
            ownerPid: capturedOwner.pid,
            memoryBytes: launch.memoryBytes,
            swapBytes: 0,
            oomGroup: capturedOwner.oomGroup,
            launcherPid: Number(child.pid),
            childPid,
            childExitCode,
            kernel,
          };
          if (persistence?.afterDrain) yield* persistence.afterDrain(drain);
          return drain;
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
        transportError ??= error;
        yield* Deferred.fail(ownerReady, error);
        yield* Deferred.fail(started, error);
        yield* Deferred.fail(exited, error);
        yield* Queue.fail(stdout, error);
        yield* Queue.fail(stderr, error);
      });
      const inputWriter = yield* Stream.fromQueue(incoming).pipe(
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
      closeInput = Fiber.join(inputWriter);
      const stderrReader = yield* child.stderr.pipe(
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
            if (childExitCode !== null)
              return yield* fail("transport", "Worker output followed the exit receipt.");
            const bytes = Buffer.from(event.data, "base64");
            if (bytes.length > 8192 || bytes.toString("base64") !== event.data)
              return yield* fail("transport", "Worker output exceeded the byte framing bound.");
            if (!stopping) yield* Queue.offer(event.type === "stdout" ? stdout : stderr, bytes);
            break;
          }
          case "exited":
            if (state !== "running" || childExitCode !== null)
              return yield* fail("transport", "Unexpected process exit receipt.");
            childExitCode = event.code;
            break;
          case "failed":
            return yield* fail("startup", event.message);
        }
      });
      const stdoutReader = yield* child.stdout.pipe(
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
            if (pending.byteLength !== 0)
              return yield* fail("transport", "Invalid owned process frame at end of stream.");
            if (!stopping && childExitCode === null)
              return yield* fail("transport", "Owned process closed without an exit receipt.");
            if (childExitCode !== null) yield* Deferred.succeed(exited, childExitCode);
            yield* Queue.end(stdout);
            yield* Queue.end(stderr);
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
      awaitReaders = Effect.all([Fiber.await(stdoutReader), Fiber.await(stderrReader)], {
        concurrency: "unbounded",
      }).pipe(Effect.asVoid);
      // A receipt is provisional until both readers have finished validating their bytes.
      // Deferreds and queues may already be complete when a later transport error arrives.
      const terminalCheck = awaitReaders.pipe(
        Effect.andThen(
          Effect.suspend(() => (transportError ? Effect.fail(transportError) : Effect.void)),
        ),
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
          Effect.catch((error) => stop.pipe(Effect.andThen(Effect.fail(error)))),
          // Close the launcher while its scoped transport fibers can still deliver EOF.
          Effect.onInterrupt(() => stop.pipe(Effect.orDie, Effect.asVoid)),
        ),
      );
      const policy = yield* restore(readUnit());
      if (
        policy.Description !== description ||
        policy.InvocationID !== verified.invocation ||
        `/sys/fs/cgroup${policy.ControlGroup}` !== verified.cgroup ||
        policy.KillMode !== "control-group" ||
        policy.Restart !== "no" ||
        durationUsec(policy.RuntimeMaxUSec) !== runtimeSeconds * 1000000 ||
        durationUsec(policy.TimeoutStopUSec) !== 2000000 ||
        policy.UnsetEnvironment.split(" ").filter(Boolean).sort().join(" ") !== unsetPolicy ||
        !policy.Environment.split(" ").includes("LC_ALL=C") ||
        !policy.Environment.split(" ").includes("LANG=C")
      )
        return yield* fail(
          "startup",
          "The owned service policy does not match the proven Linux boundary.",
        );
      if (persistence) yield* restore(persistence.beforeStart(verified));
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
        if (stopping || state === "stopped")
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
            if (
              stopping ||
              state !== "running" ||
              childExitCode !== null ||
              bytes.byteLength > 8192
            )
              return yield* fail(
                "transport",
                "Managed input requires a running owned process and a bounded chunk.",
              );
            yield* sendControl({ type: "input", data: Buffer.from(bytes).toString("base64") });
          }),
        endInput: Effect.suspend(() =>
          !stopping && state === "running" && childExitCode === null
            ? sendControl({ type: "end" })
            : fail("transport", "Managed input cannot close before start or after exit."),
        ),
        stdout: Stream.fromQueue(stdout).pipe(
          Stream.concat(Stream.fromEffect(terminalCheck).pipe(Stream.drain)),
        ),
        stderr: Stream.fromQueue(stderr).pipe(
          Stream.concat(Stream.fromEffect(terminalCheck).pipe(Stream.drain)),
        ),
        awaitExit: Effect.gen(function* () {
          const receipt = yield* Deferred.await(exited).pipe(Effect.exit);
          const drain = yield* stop;
          yield* terminalCheck;
          if (receipt._tag === "Failure") return yield* Effect.failCause(receipt.cause);
          return drain;
        }),
      };
    }),
  );
});
