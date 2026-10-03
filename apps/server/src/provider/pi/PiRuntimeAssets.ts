import {
  HostProcessExecutablePath,
  HostProcessArchitecture,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  MAX_PI_RUNTIME_FILES,
  MAX_PI_RUNTIME_FILE_BYTES,
  piRuntimeClosureByteLimit,
  type PiManagedLaunch,
} from "./PiManagedProcess.ts";
import { isPiWorkerNodeVersionSupported } from "./PiWorkerEntrypoint.ts";
import { PiWorkerIdentity, PiWorkerOperation } from "./PiWorkerProtocol.ts";

// Native descriptor operations below need nofollow flags and pinned directory handles,
// which Effect FileSystem cannot expose. This fixed builtin is also available in SEA.
const NodeFS = process.getBuiltinModule("fs");
const NodeFSP = NodeFS.promises;
const nativeStat = (source: string) => NodeFSP.lstat(source, { bigint: true });
type BigIntStats = Awaited<ReturnType<typeof nativeStat>>;
type FileHandle = Awaited<ReturnType<typeof NodeFSP.open>>;
const maxBytes = MAX_PI_RUNTIME_FILE_BYTES;
const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
const readFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
const Absolute = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]*$/));
const Input = Schema.Struct({
  distributionDirectory: Absolute,
  stagingDirectory: Absolute,
  protectedRoots: Schema.Array(Absolute).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
const Metadata = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.Literal("@earendil-works/pi-coding-agent"),
    version: Schema.Literal("0.99.1"),
  }),
);
const GnuHost = Schema.Struct({
  header: Schema.Struct({
    glibcVersionRuntime: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
  }),
});
// This is the eager-load closure of the pinned release, not arbitrary package discovery.
const sidecarPackages = (
  [
    {
      name: "@ff-labs/fff-node",
      version: "0.9.4",
      main: "dist/src/index.js",
      files: [
        "dist/src/binary.js",
        "dist/src/fff-api.js",
        "dist/src/ffi.js",
        "dist/src/finder.js",
        "dist/src/index.js",
        "dist/src/platform.js",
      ],
    },
    { name: "ffi-rs", version: "1.3.2", main: "index.js", files: ["index.js"] },
    {
      name: "@yuuang/ffi-rs-linux-x64-gnu",
      version: "1.3.2",
      main: "ffi-rs.linux-x64-gnu.node",
      files: ["ffi-rs.linux-x64-gnu.node"],
    },
  ] as const
).map((sidecar) => ({
  ...sidecar,
  decodeMetadata: Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        name: Schema.Literal(sidecar.name),
        version: Schema.Literal(sidecar.version),
        main: Schema.Literal(sidecar.main),
      }),
    ),
  ),
}));
const FffModule = Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("module") }));
const GnuBinding = Schema.fromJsonString(
  Schema.Struct({
    os: Schema.Array(Schema.Literal("linux")).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
    cpu: Schema.Array(Schema.Literal("x64")).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
    libc: Schema.Array(Schema.Literal("glibc")).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  }),
);
const Descriptor = Schema.fromJsonString(
  Schema.Struct({
    identity: PiWorkerIdentity,
    operation: PiWorkerOperation,
    sessionDirectory: Schema.Literal("/state/sessions"),
    trustedSdkPackageDirectory: Schema.Literal("/runtime/dist/pi-sdk"),
  }),
);
const isGnuHost = Schema.is(GnuHost);
const decodeFffModule = Schema.decodeEffect(FffModule);
const decodeGnuBinding = Schema.decodeEffect(GnuBinding);
const decodeInput = Schema.decodeEffect(Input);
const decodeMetadata = Schema.decodeEffect(Metadata);
const encodeDescriptor = Schema.encodeSync(Descriptor, { onExcessProperty: "error" });

export class PiRuntimeAssetsError extends Schema.TaggedError<PiRuntimeAssetsError>()(
  "PiRuntimeAssetsError",
  {
    phase: Schema.Literals(["unavailable", "validation"]),
    message: Schema.String,
  },
) {}
const isAssetsError = Schema.is(PiRuntimeAssetsError);
const invalid = () =>
  new PiRuntimeAssetsError({
    phase: "validation",
    message: "Pi runtime asset identity, metadata or bounded closure could not be verified.",
  });
const unavailable = () =>
  new PiRuntimeAssetsError({
    phase: "unavailable",
    message:
      "Pi runtime assets require Linux x64 GNU, compatible actual Node, Bash, bubblewrap and a working ELF dependency inspection.",
  });
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (isAssetsError(cause) ? cause : invalid()),
  }).pipe(Effect.uninterruptible);
const overlap = (a: string, b: string) =>
  a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

async function closeDirectories(handles: ReadonlyArray<FileHandle>) {
  const closed = await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
  if (closed.some((result) => result.status === "rejected")) throw invalid();
}

// Effect FileSystem lacks numeric nofollow/nonblocking opens and descriptor-relative
// writes. Native handles pin each directory component and own every bounded copy;
// interruption joins their closes rather than abandoning an in-flight acquisition.
async function withDirectory<A>(
  directory: string,
  use: (handle: FileHandle) => Promise<A>,
): Promise<A> {
  const handles: FileHandle[] = [];
  try {
    let handle = await NodeFSP.open("/", directoryFlags);
    handles.push(handle);
    let expected = "";
    for (const part of directory.split("/").filter(Boolean)) {
      expected += "/" + part;
      const entry = fdPath(handle) + "/" + part;
      const before = await NodeFSP.lstat(entry, { bigint: true });
      if (!before.isDirectory()) throw invalid();
      const child = await NodeFSP.open(entry, directoryFlags);
      handles.push(child);
      if (
        !sameIdentity(before, await child.stat({ bigint: true })) ||
        (await NodeFSP.realpath(fdPath(child))) !== expected
      )
        throw invalid();
      handle = child;
    }
    if (
      (await NodeFSP.realpath(directory)) !== directory ||
      (await NodeFSP.realpath(fdPath(handle))) !== directory
    )
      throw invalid();
    const result = await use(handle);
    if (
      (await NodeFSP.realpath(fdPath(handle))) !== directory ||
      !sameIdentity(
        await handle.stat({ bigint: true }),
        await NodeFSP.lstat(directory, { bigint: true }),
      )
    )
      throw invalid();
    return result;
  } finally {
    await closeDirectories(handles);
  }
}

async function readEntries(handle: FileHandle, limit: number) {
  const directory = await NodeFSP.opendir(fdPath(handle));
  try {
    const names: string[] = [];
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return names;
      if (names.length === limit) throw invalid();
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
}

async function inspectFile(source: string, path: Path.Path) {
  return withDirectory(path.dirname(source), async (directory) => {
    const stat = await nativeStat(fdPath(directory) + "/" + path.basename(source));
    if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(maxBytes) || stat.ino < 1n)
      throw invalid();
    return stat;
  });
}

async function readFile(source: string, expected: BigIntStats, path: Path.Path, limit = maxBytes) {
  return withDirectory(path.dirname(source), async (directory) => {
    const entry = fdPath(directory) + "/" + path.basename(source);
    const before = await NodeFSP.lstat(entry, { bigint: true });
    if (!before.isFile() || !sameFile(before, expected) || before.size > BigInt(limit))
      throw invalid();
    const file = await NodeFSP.open(entry, readFlags);
    try {
      if (
        !sameFile(before, await file.stat({ bigint: true })) ||
        (await NodeFSP.realpath(fdPath(file))) !== source
      )
        throw invalid();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (
        length !== Number(before.size) ||
        !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await NodeFSP.lstat(entry, { bigint: true })) ||
        (await NodeFSP.realpath(fdPath(file))) !== source
      )
        throw invalid();
      return bytes.subarray(0, length);
    } finally {
      await file.close();
    }
  });
}

async function validateElf(source: string, expected: BigIntStats, path: Path.Path) {
  return withDirectory(path.dirname(source), async (directory) => {
    const entry = fdPath(directory) + "/" + path.basename(source);
    if (!sameFile(expected, await NodeFSP.lstat(entry, { bigint: true }))) throw invalid();
    const file = await NodeFSP.open(entry, readFlags);
    try {
      if (
        !sameFile(expected, await file.stat({ bigint: true })) ||
        (await NodeFSP.realpath(fdPath(file))) !== source
      )
        throw invalid();
      const header = Buffer.alloc(4);
      const read = await file.read(header, 0, 4, 0);
      if (
        read.bytesRead !== 4 ||
        header[0] !== 0x7f ||
        header[1] !== 0x45 ||
        header[2] !== 0x4c ||
        header[3] !== 0x46 ||
        !sameFile(expected, await file.stat({ bigint: true })) ||
        !sameFile(expected, await NodeFSP.lstat(entry, { bigint: true }))
      )
        throw unavailable();
    } finally {
      await file.close();
    }
  });
}

async function inspectStage(
  directory: string,
  expected?: BigIntStats,
  names: ReadonlyArray<string> = [],
) {
  return withDirectory(directory, async (handle) => {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || (expected && !sameIdentity(stat, expected))) throw invalid();
    const actual = (await readEntries(handle, names.length)).sort();
    if (actual.length !== names.length || actual.some((name, i) => name !== [...names].sort()[i]))
      throw invalid();
    return stat;
  });
}

function workerArgv(
  executable: boolean,
  electron: boolean,
  identity: PiWorkerIdentity,
  operation: PiWorkerOperation,
  nativeStateDirectory: string,
) {
  if (nativeStateDirectory !== "/state/sessions") throw invalid();
  const descriptor = encodeDescriptor({
    identity,
    operation,
    sessionDirectory: "/state/sessions",
    trustedSdkPackageDirectory: "/runtime/dist/pi-sdk",
  });
  if (Buffer.byteLength(descriptor) > 16384) throw invalid();
  if (executable) return Object.freeze(["/runtime/t3", "__pi-worker", descriptor]);
  const argv = [
    "/runtime/node",
    "--max-old-space-size=512",
    "/runtime/dist/pi-worker.mjs",
    descriptor,
  ];
  // The cage clears all environment. Set only Electron's fixed Node mode after
  // that boundary, keeping the descriptor positional rather than shell source.
  return Object.freeze(
    electron
      ? [
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          'export ELECTRON_RUN_AS_NODE=1; exec "$@"',
          "t3-pi-electron",
          ...argv,
        ]
      : argv,
  );
}

/** Private inputs come only from trusted product paths and a fresh parent-owned cache. */
export const preparePiRuntimeAssets = Effect.fn("preparePiRuntimeAssets")(
  function* (input: {
    distributionDirectory: string;
    stagingDirectory: string;
    protectedRoots: ReadonlyArray<string>;
  }) {
    if (
      (yield* HostProcessPlatform) !== "linux" ||
      (yield* HostProcessArchitecture) !== "x64" ||
      !isPiWorkerNodeVersionSupported(process.versions.node)
    )
      return yield* unavailable();
    const gnuHost = yield* Effect.try({
      try: () => isGnuHost(process.report?.getReport()),
      catch: unavailable,
    });
    if (!gnuHost) return yield* unavailable();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const userId = yield* HostProcessUserId;
    const value = yield* decodeInput(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalid),
    );
    for (const directory of [value.distributionDirectory, value.stagingDirectory]) {
      if (
        directory === "/" ||
        path.resolve(directory) !== directory ||
        (yield* fs.realPath(directory)) !== directory
      )
        return yield* invalid();
    }
    const protectedRoots = yield* Effect.forEach(value.protectedRoots, (root) => fs.realPath(root));
    if (
      overlap(value.distributionDirectory, value.stagingDirectory) ||
      protectedRoots.some((root) => overlap(root, value.stagingDirectory))
    )
      return yield* invalid();
    const stage = yield* native(() => inspectStage(value.stagingDirectory));
    if (userId === undefined || stage.uid !== BigInt(userId) || (stage.mode & 0o022n) !== 0n)
      return yield* invalid();
    const executable = yield* HostProcessIsExecutable;
    const electron = !executable && process.versions.electron !== undefined;
    const closureMaxBytes = piRuntimeClosureByteLimit(electron);
    const names = executable
      ? []
      : yield* native(() =>
          withDirectory(value.distributionDirectory, async (handle) =>
            (await readEntries(handle, 512)).filter((name) => name.endsWith(".mjs")).sort(),
          ),
        );
    if (
      (!executable && !names.includes("pi-worker.mjs")) ||
      names.length > 96 ||
      names.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.mjs$/.test(name))
    )
      return yield* invalid();
    const files: Array<{ source: string; target: string; stat: BigIntStats }> = [];
    let totalBytes = 0n;
    const add = Effect.fn("PiRuntimeAssets.add")(function* (source: string, target: string) {
      if (
        files.length >= MAX_PI_RUNTIME_FILES ||
        files.some((file) => overlap(file.target, target))
      )
        return yield* invalid();
      const stat = yield* native(() => inspectFile(source, path));
      totalBytes += stat.size;
      if (totalBytes > BigInt(closureMaxBytes)) return yield* invalid();
      files.push({ source, target, stat });
      return stat;
    });
    for (const name of names)
      yield* add(path.join(value.distributionDirectory, name), "/runtime/dist/" + name);
    const metadataSource = path.join(value.distributionDirectory, "pi-sdk/package.json");
    const metadataStat = yield* add(metadataSource, "/runtime/dist/pi-sdk/package.json");
    const metadata = yield* native(() => readFile(metadataSource, metadataStat, path, 65536));
    yield* decodeMetadata(metadata.toString("utf8")).pipe(Effect.mapError(invalid));
    const executableSource = yield* fs.realPath(yield* HostProcessExecutablePath);
    const executableStat = yield* add(
      executableSource,
      executable ? "/runtime/t3" : "/runtime/node",
    );
    if ((executableStat.mode & 0o111n) === 0n) return yield* unavailable();
    yield* native(() => validateElf(executableSource, executableStat, path));
    const elfSources = [executableSource];
    let electronFfmpegSource: string | undefined;
    if (electron) {
      // Node mode still needs these exact sibling assets from the host runtime.
      // No other sibling dependency is admitted by ldd discovery.
      const directory = path.dirname(executableSource);
      electronFfmpegSource = path.join(directory, "libffmpeg.so");
      const ffmpegStat = yield* add(electronFfmpegSource, "/runtime/libffmpeg.so");
      yield* native(() => validateElf(electronFfmpegSource!, ffmpegStat, path));
      elfSources.push(electronFfmpegSource);
      for (const name of ["icudtl.dat", "snapshot_blob.bin", "v8_context_snapshot.bin"])
        yield* add(path.join(directory, name), "/runtime/" + name);
    }
    if (executable) {
      // SEA release archives stage a physical node_modules tree beside the actual
      // executable. Never search parents, activate imports or use ambient packages.
      const sidecarRoot = path.join(path.dirname(executableSource), "node_modules");
      yield* native(() => withDirectory(sidecarRoot, async () => undefined));
      for (const sidecar of sidecarPackages) {
        const directory = path.join(sidecarRoot, sidecar.name);
        const targetDirectory = "/runtime/node_modules/" + sidecar.name;
        const source = path.join(directory, "package.json");
        const stat = yield* add(source, targetDirectory + "/package.json");
        const bytes = yield* native(() => readFile(source, stat, path, 65536));
        yield* sidecar.decodeMetadata(bytes.toString("utf8")).pipe(Effect.mapError(invalid));
        if (sidecar.name === "@ff-labs/fff-node")
          yield* decodeFffModule(bytes.toString("utf8")).pipe(Effect.mapError(invalid));
        if (sidecar.name === "@yuuang/ffi-rs-linux-x64-gnu")
          yield* decodeGnuBinding(bytes.toString("utf8")).pipe(Effect.mapError(invalid));
        for (const relative of sidecar.files) {
          const source = path.join(directory, relative);
          const stat = yield* add(source, targetDirectory + "/" + relative);
          if (relative.endsWith(".node")) {
            yield* native(() => validateElf(source, stat, path));
            elfSources.push(source);
          }
        }
      }
    }
    // Pinned SDK getShellConfig prefers this cage target on Unix; no ambient shell selection.
    for (const [installed, target] of [
      ["/bin/bash", "/bin/bash"],
      ["/usr/bin/bwrap", "/runtime/t3-bwrap"],
    ] as const) {
      const source = yield* fs.realPath(installed).pipe(Effect.mapError(unavailable));
      const stat = yield* add(source, target);
      if ((stat.mode & 0o111n) === 0n) return yield* unavailable();
      yield* native(() => validateElf(source, stat, path));
      elfSources.push(source);
    }
    const targets = new Set<string>();
    // All fixed ELF inspections share one deadline; each child owns its pipe and exit drains.
    yield* Effect.scoped(
      Effect.gen(function* () {
        for (const source of elfSources) {
          const child = yield* spawner.spawn(
            ChildProcess.make("/usr/bin/ldd", [source], {
              env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" },
              extendEnv: false,
              stdin: "ignore",
              // A dependency inspector can ignore SIGTERM; scope cleanup must still stop it.
              forceKillAfter: "100 millis",
            }),
          );
          const output = yield* Effect.all(
            {
              stdout: collectUint8StreamText({ stream: child.stdout, maxBytes: 65536 }),
              stderr: collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }),
              code: child.exitCode,
            },
            { concurrency: "unbounded" },
          );
          // ldd emits this exact diagnostic for valid non-executable shared objects.
          const warning = `ldd: warning: you do not have execution permission for \`${source}'`;
          if (
            output.code !== 0 ||
            output.stdout.truncated ||
            output.stdout.invalidUtf8 ||
            output.stderr.truncated ||
            output.stderr.invalidUtf8 ||
            (output.stderr.text.trim() !== "" && output.stderr.text.trim() !== warning)
          )
            return yield* unavailable();
          const discovered = new Set<string>();
          for (const raw of output.stdout.text.split("\n")) {
            const line = raw.trim();
            if (!line || line === warning || /^linux-vdso\.so\.\d+ \(0x[0-9a-f]+\)$/.test(line))
              continue;
            const match = /^(?:(\S+) => )?(\/[^\s()]+) \(0x[0-9a-f]+\)$/.exec(line);
            if (!match || !match[2]) return yield* unavailable();
            if (discovered.has(match[2])) return yield* invalid();
            discovered.add(match[2]);
            if (match[1]?.startsWith("/") && match[1] !== match[2]) {
              if (discovered.has(match[1])) return yield* invalid();
              discovered.add(match[1]);
            }
          }
          if (discovered.size === 0) return yield* unavailable();
          for (const target of discovered) targets.add(target);
        }
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError((cause) => (isAssetsError(cause) ? cause : unavailable())),
      ),
    );
    for (const target of [...targets].sort()) {
      if (target === electronFfmpegSource) continue;
      if (!/^\/(?:lib|lib64|usr\/lib|usr\/lib64)\//.test(target) || path.resolve(target) !== target)
        return yield* invalid();
      const library = yield* fs.realPath(target);
      const stat = yield* add(library, target);
      yield* native(() => validateElf(library, stat, path));
    }
    // Recheck every source after discovery; no staged write precedes full validation.
    for (const file of files) {
      const current = yield* native(() => inspectFile(file.source, path));
      if (!sameFile(file.stat, current)) return yield* invalid();
    }
    const copied: Array<{
      source: string;
      target: string;
      name: string;
      stat: BigIntStats;
      digest: string;
    }> = [];
    for (const file of files) {
      const bytes = yield* native(() => readFile(file.source, file.stat, path));
      const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
      const name = String(copied.length).padStart(4, "0");
      const source = path.join(value.stagingDirectory, name);
      const stat = yield* native(() =>
        withDirectory(value.stagingDirectory, async (directory) => {
          await inspectStage(
            value.stagingDirectory,
            stage,
            copied.map((entry) => entry.name),
          );
          if (!sameIdentity(await directory.stat({ bigint: true }), stage)) throw invalid();
          const entry = fdPath(directory) + "/" + name;
          const destination = await NodeFSP.open(
            entry,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await destination.writeFile(bytes);
            await destination.chmod(Number(file.stat.mode & 0o555n) | 0o400);
            await destination.sync();
            const stat = await destination.stat({ bigint: true });
            if (
              !stat.isFile() ||
              stat.nlink !== 1n ||
              stat.size !== BigInt(bytes.length) ||
              !sameFile(stat, await NodeFSP.lstat(entry, { bigint: true })) ||
              (await NodeFSP.realpath(fdPath(destination))) !== source
            )
              throw invalid();
            await inspectStage(value.stagingDirectory, stage, [
              ...copied.map((entry) => entry.name),
              name,
            ]);
            return stat;
          } finally {
            await destination.close();
          }
        }),
      );
      if (!sameFile(file.stat, yield* native(() => inspectFile(file.source, path))))
        return yield* invalid();
      copied.push({ source, target: file.target, name, stat, digest });
    }
    const frozenStage = yield* native(() =>
      withDirectory(value.stagingDirectory, async (handle) => {
        await inspectStage(
          value.stagingDirectory,
          stage,
          copied.map((file) => file.name),
        );
        if (!sameIdentity(await handle.stat({ bigint: true }), stage)) throw invalid();
        await handle.chmod(0o555);
        return handle.stat({ bigint: true });
      }),
    );
    const revalidate = Effect.gen(function* () {
      const current = yield* native(() =>
        inspectStage(
          value.stagingDirectory,
          frozenStage,
          copied.map((file) => file.name),
        ),
      );
      if (!sameFile(current, frozenStage)) return yield* invalid();
      for (const file of copied) {
        const bytes = yield* native(() => readFile(file.source, file.stat, path));
        const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
        if (digest !== file.digest) return yield* invalid();
      }
      for (const file of copied) {
        if (!sameFile(file.stat, yield* native(() => inspectFile(file.source, path))))
          return yield* invalid();
      }
      const after = yield* native(() =>
        inspectStage(
          value.stagingDirectory,
          frozenStage,
          copied.map((file) => file.name),
        ),
      );
      if (!sameFile(after, frozenStage)) return yield* invalid();
    }).pipe(Effect.mapError((cause) => (isAssetsError(cause) ? cause : invalid())));
    yield* revalidate;
    const runtimeFiles: PiManagedLaunch["runtimeFiles"] = Object.freeze(
      copied.map(({ source, target }) => Object.freeze({ source, target })),
    );
    return Object.freeze({
      runtimeFiles,
      workerArgv: (
        identity: PiWorkerIdentity,
        operation: PiWorkerOperation,
        nativeStateDirectory: string,
      ) => workerArgv(executable, electron, identity, operation, nativeStateDirectory),
      revalidate,
    });
  },
  Effect.mapError((cause) => (isAssetsError(cause) ? cause : invalid())),
);
