import {
  HostProcessExecutablePath,
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
import type { PiManagedLaunch } from "./PiManagedProcess.ts";
import { isPiWorkerNodeVersionSupported } from "./PiWorkerEntrypoint.ts";
import { PiWorkerIdentity, PiWorkerOperation } from "./PiWorkerProtocol.ts";

// Native descriptor operations below need nofollow flags and pinned directory handles,
// which Effect FileSystem cannot expose. This fixed builtin is also available in SEA.
const NodeFS = process.getBuiltinModule("fs");
const NodeFSP = NodeFS.promises;
const nativeStat = (source: string) => NodeFSP.lstat(source, { bigint: true });
type BigIntStats = Awaited<ReturnType<typeof nativeStat>>;
type FileHandle = Awaited<ReturnType<typeof NodeFSP.open>>;
const maxBytes = 256 * 1024 * 1024;
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
const Descriptor = Schema.fromJsonString(
  Schema.Struct({
    identity: PiWorkerIdentity,
    operation: PiWorkerOperation,
    sessionDirectory: Schema.Literal("/state/sessions"),
    trustedSdkPackageDirectory: Schema.Literal("/runtime/dist/pi-sdk"),
  }),
);
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
      "Pi runtime assets require Linux, compatible actual Node and a working ELF dependency inspection.",
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
  return Object.freeze(
    executable
      ? ["/runtime/t3", "__pi-worker", descriptor]
      : ["/runtime/node", "--max-old-space-size=512", "/runtime/dist/pi-worker.mjs", descriptor],
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
      !isPiWorkerNodeVersionSupported(process.versions.node)
    )
      return yield* unavailable();
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
      if (files.length >= 128 || files.some((file) => overlap(file.target, target)))
        return yield* invalid();
      const stat = yield* native(() => inspectFile(source, path));
      totalBytes += stat.size;
      if (totalBytes > BigInt(maxBytes)) return yield* invalid();
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
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/ldd", [executableSource], {
            env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" },
            extendEnv: false,
            stdin: "ignore",
          }),
        );
        return yield* Effect.all(
          {
            stdout: collectUint8StreamText({ stream: child.stdout, maxBytes: 65536 }),
            stderr: collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }),
            code: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable)),
    );
    if (
      output.code !== 0 ||
      output.stdout.truncated ||
      output.stdout.invalidUtf8 ||
      output.stderr.truncated ||
      output.stderr.invalidUtf8 ||
      output.stderr.text.trim() !== ""
    )
      return yield* unavailable();
    const targets = new Set<string>();
    for (const raw of output.stdout.text.split("\n")) {
      const line = raw.trim();
      if (!line || /^linux-vdso\.so\.\d+ \(0x[0-9a-f]+\)$/.test(line)) continue;
      const match = /^(?:(\S+) => )?(\/[^\s()]+) \(0x[0-9a-f]+\)$/.exec(line);
      if (!match || !match[2]) return yield* unavailable();
      if (targets.has(match[2])) return yield* invalid();
      targets.add(match[2]);
      if (match[1]?.startsWith("/") && match[1] !== match[2]) {
        if (targets.has(match[1])) return yield* invalid();
        targets.add(match[1]);
      }
    }
    if (targets.size === 0) return yield* unavailable();
    for (const target of [...targets].sort()) {
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
      ) => workerArgv(executable, identity, operation, nativeStateDirectory),
      revalidate,
    });
  },
  Effect.mapError((cause) => (isAssetsError(cause) ? cause : invalid())),
);
