import { ManagedSkillKey, SkillContentHash } from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SKILL_PACKAGE_LIMITS,
  hashSkillPackage,
  inspectSkillPackage,
  parsePortableSkillDocument,
  SKILL_BODY_FILE,
  SKILL_MANIFEST_FILE,
} from "../../skills/SkillPackage.ts";
import type { PiManagedLaunch } from "./PiManagedProcess.ts";
import { PiManagedRuntimeError } from "./PiManagedRuntime.ts";
import type { PiWorkerBootstrap } from "./PiWorkerProtocol.ts";

// Effect FileSystem does not expose nofollow or descriptor-relative operations.
// Linux descriptors keep every bounded read/write anchored to its admitted inode.
const nodeFS = process.getBuiltinModule("fs");
const nativeFS = nodeFS.promises;
const stat = (entry: string) => nativeFS.lstat(entry, { bigint: true });
type Stat = Awaited<ReturnType<typeof stat>>;
type Handle = Awaited<ReturnType<typeof nativeFS.open>>;
const directoryFlags =
  nodeFS.constants.O_RDONLY | nodeFS.constants.O_NOFOLLOW | nodeFS.constants.O_DIRECTORY;
const readFlags =
  nodeFS.constants.O_RDONLY | nodeFS.constants.O_NOFOLLOW | nodeFS.constants.O_NONBLOCK;
const limits = DEFAULT_SKILL_PACKAGE_LIMITS;
const maxRuntimeFiles = 128;
const maxRuntimeBytes = 256 * 1024 * 1024;
const absolute = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]*$/));
const inputSchema = Schema.Struct({
  selection: Schema.Array(
    Schema.Struct({ key: ManagedSkillKey, packagePath: absolute, expectedHash: SkillContentHash }),
  ).check(Schema.isMaxLength(32)),
  stagingRoot: absolute,
  stagingDirectory: absolute,
  existingRuntimeFiles: Schema.Array(Schema.Struct({ source: absolute, target: absolute })).check(
    Schema.isMaxLength(maxRuntimeFiles),
  ),
  protectedRoots: Schema.Array(absolute).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  writableRoots: Schema.Array(absolute).check(Schema.isMaxLength(64)),
});
const decodeInput = Schema.decodeEffect(inputSchema);
const encodeIdentities = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([ManagedSkillKey, SkillContentHash]))),
);
export interface PiSkillResourceOptions {
  readonly selection: ReadonlyArray<{
    readonly key: ManagedSkillKey;
    readonly packagePath: string;
    readonly expectedHash: SkillContentHash;
  }>;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  readonly existingRuntimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly protectedRoots: ReadonlyArray<string>;
  readonly writableRoots: ReadonlyArray<string>;
}
export interface PreparedPiSkillResources {
  /** Additional explicit mounts only; the parent keeps its existing runtime closure. */
  readonly runtimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly resources: NonNullable<PiWorkerBootstrap["resources"]>;
  readonly identityHash: string;
  readonly revalidate: Effect.Effect<void, PiManagedRuntimeError>;
}
const rejected = (detail: string) => new PiManagedRuntimeError({ code: "denied", detail });
const isRuntimeError = Schema.is(PiManagedRuntimeError);
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isRuntimeError(cause)
        ? cause
        : rejected("Selected skill filesystem identity or bounded receipt changed."),
  }).pipe(Effect.uninterruptible);
const fdPath = (handle: Handle) => `/proc/self/fd/${handle.fd}`;
const sameIdentity = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino;
const sameStat = (a: Stat, b: Stat) =>
  sameIdentity(a, b) &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const overlap = (a: string, b: string) =>
  a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

async function closeDirectories(handles: ReadonlyArray<Handle>) {
  const closed = await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
  if (closed.some((entry) => entry.status === "rejected"))
    throw rejected("Selected skill descriptor drain is uncertain.");
}
async function withDirectory<A>(
  directory: string,
  use: (handle: Handle, ancestors: ReadonlyArray<{ path: string; stat: Stat }>) => Promise<A>,
  allowModeChange = false,
) {
  const handles: Array<{ path: string; handle: Handle; stat: Stat }> = [];
  try {
    let handle = await nativeFS.open("/", directoryFlags);
    handles.push({ path: "/", handle, stat: await handle.stat({ bigint: true }) });
    let current = "";
    const parts = directory.split("/").filter(Boolean);
    if (parts.length > 256) throw rejected("Selected skill ancestor count exceeds its bound.");
    for (const part of parts) {
      current += "/" + part;
      const entry = fdPath(handle) + "/" + part;
      const before = await stat(entry);
      if (!before.isDirectory()) throw rejected("Selected skill paths cannot traverse symlinks.");
      const child = await nativeFS.open(entry, directoryFlags);
      handles.push({ path: current, handle: child, stat: before });
      if (
        !sameIdentity(before, await child.stat({ bigint: true })) ||
        (await nativeFS.realpath(fdPath(child))) !== current
      )
        throw rejected("Selected skill directory identity changed.");
      handle = child;
    }
    const result = await use(handle, handles);
    for (const receipt of handles) {
      const actual = await receipt.handle.stat({ bigint: true });
      if (
        !sameIdentity(receipt.stat, actual) ||
        (!(allowModeChange && receipt.handle === handle) && receipt.stat.mode !== actual.mode) ||
        (await nativeFS.realpath(fdPath(receipt.handle))) !== receipt.path ||
        !sameIdentity(actual, await stat(receipt.path))
      )
        throw rejected("Selected skill ancestor receipt changed.");
    }
    return result;
  } finally {
    await closeDirectories(handles.map((entry) => entry.handle));
  }
}
async function entries(handle: Handle, remaining: number) {
  const directory = await nativeFS.opendir(fdPath(handle));
  try {
    const names: string[] = [];
    for (;;) {
      const next = await directory.read();
      if (next === null) return names.sort((a, b) => a.localeCompare(b));
      if (names.length >= remaining)
        throw rejected("Selected skill traversal exceeds the package entry bound.");
      if (!/^[^/\\\0\r\n]+$/.test(next.name) || next.name === "." || next.name === "..")
        throw rejected("Selected skill asset path is not portable.");
      names.push(next.name);
    }
  } finally {
    await directory.close();
  }
}
async function readFile(entry: string, expected: Stat, limit: number) {
  if (
    !expected.isFile() ||
    expected.nlink !== 1n ||
    expected.size < 0n ||
    expected.size > BigInt(limit)
  )
    throw rejected("Selected skill file must be a bounded regular single-link file.");
  const handle = await nativeFS.open(entry, readFlags);
  try {
    if (!sameStat(expected, await handle.stat({ bigint: true })))
      throw rejected("Selected skill file receipt changed before reading.");
    const bytes = Buffer.alloc(Number(expected.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (
      offset !== Number(expected.size) ||
      !sameStat(expected, await handle.stat({ bigint: true })) ||
      !sameStat(expected, await stat(entry))
    )
      throw rejected("Selected skill file bytes or receipt changed during reading.");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
interface Tree {
  readonly files: ReadonlyArray<{ relative: string; stat: Stat; bytes: Buffer }>;
  readonly directories: ReadonlyArray<{ relative: string; stat: Stat }>;
}
async function readTree(root: string): Promise<Tree> {
  return withDirectory(root, async (handle) => {
    const files: Array<Tree["files"][number]> = [];
    const directories: Array<Tree["directories"][number]> = [];
    let entryCount = 0;
    let totalBytes = 0n;
    const walk = async (directory: Handle, relative: string, depth: number) => {
      const before = await directory.stat({ bigint: true });
      directories.push({ relative, stat: before });
      const names = await entries(directory, limits.maxEntries - entryCount);
      entryCount += names.length;
      for (const name of names) {
        if (depth >= limits.maxDepth)
          throw rejected("Selected skill traversal or depth exceeds package bounds.");
        const entry = fdPath(directory) + "/" + name;
        const childRelative = relative === "" ? name : relative + "/" + name;
        const info = await stat(entry);
        if (info.isDirectory()) {
          const child = await nativeFS.open(entry, directoryFlags);
          try {
            if (!sameStat(info, await child.stat({ bigint: true })))
              throw rejected("Selected skill directory receipt changed.");
            await walk(child, childRelative, depth + 1);
            if (!sameStat(info, await stat(entry)))
              throw rejected("Selected skill directory receipt changed during traversal.");
          } finally {
            await child.close();
          }
        } else {
          if (files.length >= limits.maxFiles)
            throw rejected("Selected skill exceeds the package file bound.");
          totalBytes += info.size;
          if (totalBytes > BigInt(limits.maxBytes))
            throw rejected("Selected skill exceeds the package byte bound.");
          const bytes = await readFile(
            entry,
            info,
            childRelative === SKILL_MANIFEST_FILE ? limits.maxManifestBytes : limits.maxBytes,
          );
          files.push({ relative: childRelative, stat: info, bytes });
        }
      }
      if (!sameStat(before, await directory.stat({ bigint: true })))
        throw rejected("Selected skill directory receipt changed during inspection.");
    };
    await walk(handle, "", 0);
    return {
      files: files.sort((a, b) => a.relative.localeCompare(b.relative)),
      directories: directories.sort((a, b) => a.relative.localeCompare(b.relative)),
    };
  });
}
function sameTree(expected: Tree, actual: Tree) {
  if (
    expected.files.length !== actual.files.length ||
    expected.directories.length !== actual.directories.length ||
    expected.directories.some((entry, i) => {
      const other = actual.directories[i]!;
      return entry.relative !== other.relative || !sameStat(entry.stat, other.stat);
    }) ||
    expected.files.some((entry, i) => {
      const other = actual.files[i]!;
      return (
        entry.relative !== other.relative ||
        !sameStat(entry.stat, other.stat) ||
        !entry.bytes.equals(other.bytes)
      );
    })
  )
    throw rejected("Selected skill contents, entries or immutable receipts changed.");
}
async function directoryAncestors(directory: string) {
  return withDirectory(directory, (_handle, ancestors) =>
    Promise.resolve(ancestors.map(({ path, stat }) => ({ path, stat }))),
  );
}
function physicalOverlap(a: ReadonlyArray<{ stat: Stat }>, b: ReadonlyArray<{ stat: Stat }>) {
  return (
    a.some((entry) => sameIdentity(entry.stat, b[b.length - 1]!.stat)) ||
    b.some((entry) => sameIdentity(entry.stat, a[a.length - 1]!.stat))
  );
}
async function directoryReceipt(directory: string) {
  return withDirectory(directory, (handle) => handle.stat({ bigint: true }));
}
async function exactDirectory(directory: string, expected: Stat, names: ReadonlyArray<string>) {
  return withDirectory(directory, async (handle) => {
    const actual = await handle.stat({ bigint: true });
    if (!sameStat(expected, actual))
      throw rejected("Selected skill staging directory receipt changed.");
    const actualNames = await entries(handle, names.length);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (actualNames.length !== sorted.length || actualNames.some((name, i) => name !== sorted[i]))
      throw rejected("Selected skill staging closure changed.");
  });
}
async function copyTree(root: string, key: string, tree: Tree, path: Path.Path) {
  await withDirectory(root, async (stage) => {
    await nativeFS.mkdir(fdPath(stage) + "/" + key, { mode: 0o700 });
    for (const directory of tree.directories) {
      if (directory.relative === "") continue;
      const destination = path.join(root, key, directory.relative);
      await withDirectory(path.dirname(destination), (parent) =>
        nativeFS.mkdir(fdPath(parent) + "/" + path.basename(destination), { mode: 0o700 }),
      );
    }
    for (const file of tree.files) {
      const destination = path.join(root, key, file.relative);
      await withDirectory(path.dirname(destination), async (parent) => {
        const entry = fdPath(parent) + "/" + path.basename(destination);
        const copied = await nativeFS.open(
          entry,
          nodeFS.constants.O_WRONLY |
            nodeFS.constants.O_CREAT |
            nodeFS.constants.O_EXCL |
            nodeFS.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await copied.writeFile(file.bytes);
          await copied.chmod(0o400);
          const info = await copied.stat({ bigint: true });
          if (!info.isFile() || info.nlink !== 1n || !sameStat(info, await stat(entry)))
            throw rejected("Selected skill copied file identity changed.");
        } finally {
          await copied.close();
        }
      });
    }
  });
  // Seal children before their parents. No executable bit is granted to script assets.
  for (const directory of [...tree.directories].sort(
    (a, b) => b.relative.length - a.relative.length,
  ))
    await withDirectory(
      path.join(root, key, directory.relative),
      (handle) => handle.chmod(0o500),
      true,
    );
}
async function runtimeFile(source: string, path: Path.Path) {
  return withDirectory(path.dirname(source), async (directory) => {
    const entry = fdPath(directory) + "/" + path.basename(source);
    const info = await stat(entry);
    const bytes = await readFile(entry, info, maxRuntimeBytes);
    return { source, stat: info, bytes };
  });
}

/** Selection is supplied only after current authority, trusted repository and owned materialization checks. */
export const preparePiSkillResources = Effect.fn("preparePiSkillResources")(function* (
  options: PiSkillResourceOptions,
): Effect.fn.Return<
  PreparedPiSkillResources,
  PiManagedRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  // Empty selection is inert, including no ambient catalogue or filesystem discovery.
  if (options.selection.length === 0)
    return {
      runtimeFiles: [],
      resources: { skills: [] },
      identityHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      revalidate: Effect.void,
    };
  if ((yield* HostProcessPlatform) !== "linux")
    return yield* new PiManagedRuntimeError({
      code: "unavailable",
      detail: "Selected skill staging requires the proven Linux descriptor boundary.",
    });
  yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userId = yield* HostProcessUserId;
  if (userId === undefined) return yield* rejected("Selected skill staging requires a host owner.");
  const value = yield* decodeInput(options, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => rejected("Selected skill inputs, keys or limits are invalid.")),
  );
  const canonical = (directory: string) =>
    directory !== "/" && path.resolve(directory) === directory;
  if (
    !canonical(value.stagingRoot) ||
    !canonical(value.stagingDirectory) ||
    path.dirname(value.stagingDirectory) !== value.stagingRoot ||
    value.selection.some((entry) => !canonical(entry.packagePath)) ||
    value.existingRuntimeFiles.some((entry) => !canonical(entry.source) || !canonical(entry.target))
  )
    return yield* rejected(
      "Selected skill staging paths must be canonical and beneath the fixed cache root.",
    );
  const keys = new Set(value.selection.map((entry) => entry.key));
  if (keys.size !== value.selection.length)
    return yield* rejected("Selected skill keys are duplicated.");
  const protectedRoots = yield* native(() =>
    Promise.all(value.protectedRoots.map((root) => nativeFS.realpath(root))),
  );
  const writableRoots = yield* native(() =>
    Promise.all(value.writableRoots.map((root) => nativeFS.realpath(root))),
  );
  const roots = [...protectedRoots, ...writableRoots];
  const rootReceipts = yield* native(() => Promise.all(roots.map(directoryReceipt)));
  if (
    roots.some(
      (root) => overlap(root, value.stagingRoot) || overlap(root, value.stagingDirectory),
    ) ||
    value.selection.some(
      (entry, i) =>
        overlap(entry.packagePath, value.stagingRoot) ||
        writableRoots.some((root) => overlap(root, entry.packagePath)) ||
        value.selection.some(
          (other, j) => i !== j && overlap(entry.packagePath, other.packagePath),
        ),
    ) ||
    value.existingRuntimeFiles.some(
      (entry) =>
        roots.some((root) => overlap(root, entry.source)) ||
        value.selection.some((selected) => overlap(selected.packagePath, entry.source)),
    )
  )
    return yield* rejected(
      "Selected skill source or cache overlaps protected, writable or selected mounts.",
    );
  const admittedAncestors = yield* native(() =>
    Promise.all([
      directoryAncestors(value.stagingRoot),
      ...roots.map(directoryAncestors),
      ...value.selection.map((entry) => directoryAncestors(entry.packagePath)),
      ...value.existingRuntimeFiles.map((entry) => directoryAncestors(path.dirname(entry.source))),
    ]),
  );
  const cacheAncestors = admittedAncestors[0]!;
  const rootAncestors = admittedAncestors.slice(1, roots.length + 1);
  const selectedAncestors = admittedAncestors.slice(
    roots.length + 1,
    roots.length + 1 + value.selection.length,
  );
  const runtimeAncestors = admittedAncestors.slice(roots.length + 1 + value.selection.length);
  if (
    [...rootAncestors, ...selectedAncestors].some((entry) =>
      physicalOverlap(cacheAncestors, entry),
    ) ||
    selectedAncestors.some(
      (entry, i) =>
        rootAncestors.slice(protectedRoots.length).some((root) => physicalOverlap(entry, root)) ||
        selectedAncestors.some((other, j) => i !== j && physicalOverlap(entry, other)),
    ) ||
    runtimeAncestors.some((entry) =>
      [...rootAncestors, ...selectedAncestors].some((root) =>
        entry.some((ancestor) => sameIdentity(ancestor.stat, root[root.length - 1]!.stat)),
      ),
    )
  )
    return yield* rejected(
      "Selected skill physical directories alias protected, writable or source roots.",
    );
  const cacheReceipt = yield* native(() => directoryReceipt(value.stagingRoot));
  const initialStage = yield* native(() =>
    withDirectory(value.stagingDirectory, async (handle) => {
      const info = await handle.stat({ bigint: true });
      if ((await entries(handle, 0)).length !== 0)
        throw rejected("Selected skill staging directory is not empty.");
      return info;
    }),
  );
  if (cacheReceipt.dev !== initialStage.dev)
    return yield* rejected("Selected skill stage must remain on the fixed cache filesystem.");
  for (const receipt of [cacheReceipt, initialStage])
    if (receipt.uid !== BigInt(userId) || (receipt.mode & 0o777n) !== 0o700n)
      return yield* rejected(
        "Selected skill staging requires an owner-only new empty directory and fixed cache.",
      );
  const existingStats = yield* native(() =>
    Promise.all(
      value.existingRuntimeFiles.map((entry) =>
        withDirectory(path.dirname(entry.source), (directory) =>
          stat(fdPath(directory) + "/" + path.basename(entry.source)),
        ),
      ),
    ),
  );
  let totalBytes = existingStats.reduce((sum, entry) => sum + entry.size, 0n);
  if (totalBytes > BigInt(maxRuntimeBytes))
    return yield* rejected("Selected skills and existing runtime exceed the combined byte bound.");
  const existing: Array<Awaited<ReturnType<typeof runtimeFile>>> = [];
  for (const [i, entry] of value.existingRuntimeFiles.entries()) {
    const receipt = yield* native(() => runtimeFile(entry.source, path));
    if (!sameStat(existingStats[i]!, receipt.stat))
      return yield* rejected("Selected skill existing runtime receipt changed during capture.");
    existing.push(receipt);
  }
  const targets = value.existingRuntimeFiles.map((entry) => entry.target);
  if (targets.some((target, i) => targets.some((other, j) => i !== j && overlap(target, other))))
    return yield* rejected("Selected skill runtime targets overlap or are duplicated.");
  const captured: Array<{ key: ManagedSkillKey; source: string; original: Tree; staged: Tree }> =
    [];
  const runtimeFiles: Array<PiManagedLaunch["runtimeFiles"][number]> = [];
  const skills: Array<NonNullable<PiWorkerBootstrap["resources"]>["skills"][number]> = [];
  const identities: Array<readonly [ManagedSkillKey, SkillContentHash]> = [];
  for (const selected of [...value.selection].sort((a, b) => a.key.localeCompare(b.key))) {
    const original = yield* native(() => readTree(selected.packagePath));
    if (original.files.length + targets.length > maxRuntimeFiles)
      return yield* rejected(
        "Selected skills and existing runtime exceed the combined file bound.",
      );
    totalBytes += original.files.reduce((sum, entry) => sum + entry.stat.size, 0n);
    if (totalBytes > BigInt(maxRuntimeBytes))
      return yield* rejected(
        "Selected skills and existing runtime exceed the combined byte bound.",
      );
    for (const file of original.files) {
      const target = `/runtime/skills/${selected.key}/${file.relative}`;
      if (targets.some((existing) => overlap(existing, target)))
        return yield* rejected("Selected skill runtime target overlaps the existing closure.");
      targets.push(target);
    }
    yield* native(() => copyTree(value.stagingDirectory, selected.key, original, path));
    const stage = path.join(value.stagingDirectory, selected.key);
    const staged = yield* native(() => readTree(stage));
    if (original.files.some((file, i) => !file.bytes.equals(staged.files[i]!.bytes)))
      return yield* rejected("Selected skill copy differs from its authorized source.");
    const inspected = yield* inspectSkillPackage({
      packagePath: stage,
      expectedKey: selected.key,
    }).pipe(Effect.mapError(() => rejected("Selected skill staged package inspection failed.")));
    if (
      inspected.validity !== "valid" ||
      inspected.content === undefined ||
      inspected.manifest === undefined
    )
      return yield* rejected(
        "Selected skill metadata or portable SKILL.md is invalid: " +
          inspected.diagnostics.map((entry) => entry.code).join(", "),
      );
    const contentHash = yield* hashSkillPackage(stage).pipe(
      Effect.mapError(() => rejected("Selected skill package hash inspection failed.")),
    );
    if (
      contentHash !== selected.expectedHash ||
      inspected.hash !== selected.expectedHash ||
      inspected.manifest.revision.hash !== selected.expectedHash
    )
      return yield* rejected(
        "Selected skill content hash does not match the authorized selection.",
      );
    const body = staged.files.find((file) => file.relative === SKILL_BODY_FILE);
    if (body === undefined) return yield* rejected("Selected skill SKILL.md is missing.");
    const document = yield* Effect.try({
      try: () =>
        parsePortableSkillDocument(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)),
      catch: () => rejected("Selected skill portable frontmatter is invalid."),
    });
    if (document.frontmatter.name !== selected.key)
      return yield* rejected("Selected skill portable key does not match its document.");
    yield* native(async () => {
      sameTree(original, await readTree(selected.packagePath));
      sameTree(staged, await readTree(stage));
    });
    for (const file of staged.files)
      runtimeFiles.push(
        Object.freeze({
          source: path.join(stage, file.relative),
          target: `/runtime/skills/${selected.key}/${file.relative}`,
        }),
      );
    skills.push(
      Object.freeze({
        key: selected.key,
        path: `/runtime/skills/${selected.key}/SKILL.md`,
        description: document.frontmatter.description,
      }),
    );
    captured.push({ key: selected.key, source: selected.packagePath, original, staged });
    identities.push([selected.key, contentHash]);
  }
  // The cache remains owner-writable for later operation directories; this stage is sealed.
  yield* native(() => withDirectory(value.stagingDirectory, (handle) => handle.chmod(0o500), true));
  const sealedStage = yield* native(() => directoryReceipt(value.stagingDirectory));
  const revalidate = native(async () => {
    for (const ancestors of admittedAncestors) {
      const current = await directoryAncestors(ancestors[ancestors.length - 1]!.path);
      if (
        ancestors.length !== current.length ||
        ancestors.some(
          (ancestor, i) =>
            ancestor.path !== current[i]!.path ||
            !sameIdentity(ancestor.stat, current[i]!.stat) ||
            ancestor.stat.mode !== current[i]!.stat.mode,
        )
      )
        throw rejected("Selected skill admitted ancestor identity or mode changed.");
    }
    const cache = await directoryReceipt(value.stagingRoot);
    if (
      !sameIdentity(cacheReceipt, cache) ||
      cacheReceipt.uid !== cache.uid ||
      cacheReceipt.mode !== cache.mode
    )
      throw rejected("Selected skill fixed cache identity or permissions changed.");
    await exactDirectory(value.stagingDirectory, sealedStage, [...keys]);
    const currentRoots = await Promise.all(
      [...value.protectedRoots, ...value.writableRoots].map((root) => nativeFS.realpath(root)),
    );
    if (currentRoots.some((root, i) => root !== roots[i]))
      throw rejected("Selected skill protected or writable root alias changed.");
    for (const [i, root] of roots.entries()) {
      const receipt = await directoryReceipt(root);
      if (!sameIdentity(rootReceipts[i]!, receipt) || rootReceipts[i]!.mode !== receipt.mode)
        throw rejected("Selected skill protected or writable root receipt changed.");
    }
    for (const entry of existing) {
      const actual = await runtimeFile(entry.source, path);
      if (!sameStat(entry.stat, actual.stat) || !entry.bytes.equals(actual.bytes))
        throw rejected("Selected skill existing runtime closure receipt changed.");
    }
    for (const entry of captured) {
      sameTree(entry.original, await readTree(entry.source));
      sameTree(entry.staged, await readTree(path.join(value.stagingDirectory, entry.key)));
    }
  });
  yield* revalidate;
  const identityHash = process
    .getBuiltinModule("crypto")
    .createHash("sha256")
    .update(encodeIdentities(identities))
    .digest("hex");
  return {
    runtimeFiles: Object.freeze(runtimeFiles),
    resources: Object.freeze({ skills: Object.freeze(skills) }),
    identityHash,
    revalidate,
  };
});
