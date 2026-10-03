import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { DEFAULT_SKILL_PACKAGE_LIMITS, SKILL_MANIFEST_FILE } from "../../skills/SkillPackage.ts";
import type { PiManagedLaunch } from "./PiManagedProcess.ts";
import { PiManagedRuntimeError } from "./PiManagedRuntime.ts";

const nodeFS = process.getBuiltinModule("fs");
const fs = nodeFS.promises;
const path = process.getBuiltinModule("path").posix;
const directoryFlags =
  nodeFS.constants.O_RDONLY | nodeFS.constants.O_DIRECTORY | nodeFS.constants.O_NOFOLLOW;
const fileFlags =
  nodeFS.constants.O_RDONLY | nodeFS.constants.O_NOFOLLOW | nodeFS.constants.O_NONBLOCK;
type Handle = Awaited<ReturnType<typeof fs.open>>;
// BigIntStats is selected explicitly rather than relying on FileHandle.stat's overload order.
const info = (handle: Handle) => handle.stat({ bigint: true });
type Identity = Awaited<ReturnType<typeof info>>;
const limits = DEFAULT_SKILL_PACKAGE_LIMITS;
const maxSelected = 32;
const maxFiles = 128;
const maxAncestors = 256;
// Every selected package may contain empty directories; the file count alone cannot bound FDs.
const maxTreeDirectories = 1 + maxSelected * (1 + limits.maxEntries);
const absolute = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^\/[^\0\r\n]*$/),
  Schema.makeFilter((value) => value !== "/" && path.resolve(value) === value),
);
const decodeRoot = Schema.decodeUnknownEffect(absolute);
const fileClosure = Schema.Array(Schema.Struct({ source: absolute, target: absolute })).check(
  Schema.isMaxLength(maxFiles),
);
const decodeFiles = Schema.decodeUnknownSync(fileClosure);
const rejected = (detail: string) => new PiManagedRuntimeError({ code: "denied", detail });
const uncertain = (detail: string) => new PiManagedRuntimeError({ code: "uncertain", detail });
const isRuntimeError = Schema.is(PiManagedRuntimeError);
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isRuntimeError(cause)
        ? cause
        : uncertain("Owned skill stage filesystem operation is uncertain; retain its paths."),
  }).pipe(Effect.uninterruptible);
const fdPath = (handle: Handle) => `/proc/self/fd/${handle.fd}`;
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sameOwner = (a: Identity, b: Identity) =>
  sameIdentity(a, b) && a.uid === b.uid && a.gid === b.gid;
const sameStat = (a: Identity, b: Identity) =>
  sameOwner(a, b) &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const safeNumber = (value: bigint) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw rejected("Owned skill inode receipt cannot be represented exactly.");
  return Number(value);
};

export interface PiSkillStageFileReceipt {
  readonly source: string;
  readonly target: string;
  readonly dev: number;
  readonly ino: number;
}

export interface PiSkillStageLifetime {
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  /** Capture once after the approved helper revalidates; any failed operation retains and closes. */
  readonly captureSealedTree: (
    files: PiManagedLaunch["runtimeFiles"],
  ) => Effect.Effect<ReadonlyArray<PiSkillStageFileReceipt>, PiManagedRuntimeError>;
  /** Root calls this only after its own terminal/drain decision. No caller receipt grants authority here. */
  readonly remove: () => Effect.Effect<void, PiManagedRuntimeError>;
  readonly retain: () => Effect.Effect<void, PiManagedRuntimeError>;
}

interface DirectoryReceipt {
  readonly path: string;
  readonly handle: Handle;
  readonly stat: Identity;
}
interface TreeDirectory extends DirectoryReceipt {
  readonly parent: Handle;
  readonly name: string;
  readonly names: ReadonlyArray<string>;
}
interface TreeFile {
  readonly parent: Handle;
  readonly name: string;
  readonly handle: Handle;
  readonly stat: Identity;
  readonly receipt: PiSkillStageFileReceipt;
}

async function names(handle: Handle, maximum: number) {
  const directory = await fs.opendir(fdPath(handle));
  try {
    const result: string[] = [];
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return result.sort();
      if (
        result.length >= maximum ||
        !/^[^/\\\0\r\n]+$/.test(entry.name) ||
        entry.name === "." ||
        entry.name === ".."
      )
        throw rejected(
          "Owned skill stage enumeration exceeds its entry bound or contains an invalid name.",
        );
      result.push(entry.name);
    }
  } finally {
    await directory.close();
  }
}

async function acquire(root: string, uid: number) {
  const handles: Handle[] = [];
  const ancestors: DirectoryReceipt[] = [];
  let closeFailure: PiManagedRuntimeError | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const results = await Promise.allSettled(
        handles.toReversed().map((handle) => handle.close()),
      );
      if (results.some((result) => result.status === "rejected")) {
        closeFailure = uncertain(
          "Owned skill descriptor close is uncertain; retain stage and partial deletion evidence.",
        );
        throw closeFailure;
      }
    })();
    return closing;
  };
  const open = async (entry: string, flags: number) => {
    const handle = await fs.open(entry, flags);
    handles.push(handle);
    return handle;
  };
  const checkAncestors = async () => {
    for (const receipt of ancestors) {
      const actual = await info(receipt.handle);
      if (
        !sameOwner(receipt.stat, actual) ||
        receipt.stat.mode !== actual.mode ||
        !sameOwner(actual, await fs.lstat(receipt.path, { bigint: true })) ||
        (await fs.realpath(fdPath(receipt.handle))) !== receipt.path
      )
        throw rejected("Owned skill cache ancestor identity, mode or canonical path changed.");
    }
  };
  try {
    let handle = await open("/", directoryFlags);
    ancestors.push({ path: "/", handle, stat: await info(handle) });
    let current = "";
    const parts = root.split("/").filter(Boolean);
    if (parts.length > maxAncestors)
      throw rejected("Owned skill cache ancestor count exceeds its bound.");
    for (const component of parts) {
      current += "/" + component;
      const entry = fdPath(handle) + "/" + component;
      const before = await fs.lstat(entry, { bigint: true });
      if (!before.isDirectory())
        throw rejected("Owned skill cache ancestors must be physical directories.");
      handle = await open(entry, directoryFlags);
      const actual = await info(handle);
      if (!sameStat(before, actual) || (await fs.realpath(fdPath(handle))) !== current)
        throw rejected("Owned skill cache admission identity changed.");
      ancestors.push({ path: current, handle, stat: actual });
    }
    const rootHandle = handle;
    const rootStat = await info(rootHandle);
    if (rootStat.uid !== BigInt(uid) || (rootStat.mode & 0o7777n) !== 0o700n)
      throw rejected("Owned skill cache must already be a current-user 0700 directory.");
    await checkAncestors();
    const created = await fs.mkdtemp(fdPath(rootHandle) + "/pi-skills-");
    const name = path.basename(created);
    const directory = root + "/" + name;
    const before = await fs.lstat(created, { bigint: true });
    const stage = await open(fdPath(rootHandle) + "/" + name, directoryFlags);
    const initial = await info(stage);
    if (
      !sameStat(before, initial) ||
      initial.uid !== BigInt(uid) ||
      initial.dev !== rootStat.dev ||
      (initial.mode & 0o7777n) !== 0o700n ||
      (await fs.realpath(fdPath(stage))) !== directory ||
      (await names(stage, 0)).length !== 0
    )
      throw rejected("Owned empty skill stage creation receipt changed.");
    await checkAncestors();
    let state: "empty" | "sealed" | "retained" | "removed" = "empty";
    let sealed: Identity | undefined;
    const directories: TreeDirectory[] = [];
    const files: TreeFile[] = [];
    let receipts: ReadonlyArray<PiSkillStageFileReceipt> = [];
    const semaphore = Semaphore.makeUnsafe(1);
    const checkStage = async (mode: bigint) => {
      await checkAncestors();
      const actual = await info(stage);
      if (
        !sameOwner(initial, actual) ||
        !actual.isDirectory() ||
        (actual.mode & 0o7777n) !== mode ||
        !sameStat(actual, await fs.lstat(fdPath(rootHandle) + "/" + name, { bigint: true })) ||
        (await fs.realpath(fdPath(stage))) !== directory ||
        (await fs.realpath(directory)) !== directory
      )
        throw rejected("Owned skill stage identity, mode or canonical path changed.");
      return actual;
    };
    const retain = async () => {
      if (state === "removed") throw rejected("Owned skill stage was already removed.");
      state = "retained";
      await close();
    };
    const operation = <A>(run: () => Promise<A>) =>
      semaphore
        .withPermit(
          native(async () => {
            try {
              return await run();
            } catch (cause) {
              if (state !== "removed") state = "retained";
              await close();
              throw cause;
            }
          }),
        )
        .pipe(
          Effect.onInterrupt(() =>
            semaphore
              .withPermit(
                native(async () => {
                  if (state !== "removed") await retain();
                }),
              )
              .pipe(Effect.orDie),
          ),
        );
    const checkTree = async () => {
      if (!sealed || !sameStat(sealed, await checkStage(0o500n)))
        throw rejected("Owned skill sealed stage receipt changed.");
      for (const entry of directories) {
        const actual = await info(entry.handle);
        if (
          !sameStat(entry.stat, actual) ||
          !sameStat(
            actual,
            await fs.lstat(fdPath(entry.parent) + "/" + entry.name, { bigint: true }),
          ) ||
          (await fs.realpath(fdPath(entry.handle))) !== entry.path
        )
          throw rejected("Owned skill captured directory receipt changed.");
        const actualNames = await names(entry.handle, entry.names.length);
        if (
          actualNames.length !== entry.names.length ||
          actualNames.some((name, i) => name !== entry.names[i])
        )
          throw rejected("Owned skill captured directory contains changed or foreign entries.");
      }
      for (const entry of files) {
        if (
          !sameStat(entry.stat, await info(entry.handle)) ||
          !sameStat(
            entry.stat,
            await fs.lstat(fdPath(entry.parent) + "/" + entry.name, { bigint: true }),
          ) ||
          (await fs.realpath(fdPath(entry.handle))) !== entry.receipt.source
        )
          throw rejected("Owned skill captured file receipt changed.");
      }
      await checkStage(0o500n);
    };
    const lifetime: PiSkillStageLifetime = {
      stagingRoot: root,
      stagingDirectory: directory,
      captureSealedTree: (supplied) => {
        let captured: typeof fileClosure.Type;
        try {
          captured = decodeFiles(supplied, { onExcessProperty: "error" }).map((entry) =>
            Object.freeze({ ...entry }),
          );
        } catch {
          return operation(async () => {
            throw rejected("Owned skill launch file closure is invalid or exceeds its bound.");
          });
        }
        return operation(async () => {
          if (state !== "empty")
            throw rejected("Owned skill stage capture is allowed only once before release.");
          if (captured.length === 0)
            throw rejected("Owned sealed skill tree requires a nonempty selected file closure.");
          const expected = new Map<string, (typeof captured)[number]>();
          const targets = new Set<string>();
          const expectedPackages = new Set<string>();
          for (const entry of captured) {
            const relative = entry.source.slice(directory.length + 1);
            if (
              !entry.source.startsWith(directory + "/") ||
              relative.split("/").length < 2 ||
              entry.target !== "/runtime/skills/" + relative ||
              expected.has(relative) ||
              targets.has(entry.target)
            )
              throw rejected(
                "Owned skill launch file closure escapes, duplicates or mismatches its exact stage.",
              );
            expected.set(relative, entry);
            targets.add(entry.target);
            expectedPackages.add(relative.split("/")[0]!);
          }
          sealed = await checkStage(0o500n);
          const packageNames = await names(stage, maxSelected);
          if (
            packageNames.length !== expectedPackages.size ||
            packageNames.some((key) => !expectedPackages.has(key))
          )
            throw rejected("Owned sealed skill tree differs from the exact selected package set.");
          directories.push({
            path: directory,
            handle: stage,
            stat: sealed,
            parent: rootHandle,
            name,
            names: packageNames,
          });
          for (const key of packageNames) {
            let entries = 0;
            let packageBytes = 0n;
            const walk = async (
              parent: Handle,
              childName: string,
              relative: string,
              depth: number,
            ): Promise<void> => {
              if (depth > limits.maxDepth || directories.length >= maxTreeDirectories)
                throw rejected(
                  "Owned skill directory depth or descriptor count exceeds package bounds.",
                );
              const entry = fdPath(parent) + "/" + childName;
              const before = await fs.lstat(entry, { bigint: true });
              if (
                !before.isDirectory() ||
                before.uid !== BigInt(uid) ||
                before.dev !== initial.dev ||
                (before.mode & 0o7777n) !== 0o500n
              )
                throw rejected(
                  "Owned skill tree requires sealed current-user physical directories.",
                );
              const handle = await open(entry, directoryFlags);
              if (
                !sameStat(before, await info(handle)) ||
                (await fs.realpath(fdPath(handle))) !== directory + "/" + relative
              )
                throw rejected("Owned skill captured directory identity changed.");
              const children = await names(handle, limits.maxEntries - entries);
              entries += children.length;
              directories.push({
                path: directory + "/" + relative,
                handle,
                stat: before,
                parent,
                name: childName,
                names: children,
              });
              for (const child of children) {
                if (depth >= limits.maxDepth)
                  throw rejected("Owned skill tree exceeds the package depth bound.");
                const childEntry = fdPath(handle) + "/" + child;
                const childRelative = relative + "/" + child;
                const childStat = await fs.lstat(childEntry, { bigint: true });
                if (childStat.isDirectory()) {
                  await walk(handle, child, childRelative, depth + 1);
                  continue;
                }
                const selected = expected.get(childRelative);
                packageBytes += childStat.size;
                if (
                  !selected ||
                  !childStat.isFile() ||
                  childStat.uid !== BigInt(uid) ||
                  childStat.dev !== initial.dev ||
                  childStat.nlink !== 1n ||
                  (childStat.mode & 0o7777n) !== 0o400n ||
                  childStat.size < 0n ||
                  packageBytes > BigInt(limits.maxBytes) ||
                  (childRelative === key + "/" + SKILL_MANIFEST_FILE &&
                    childStat.size > BigInt(limits.maxManifestBytes)) ||
                  files.length >= maxFiles
                )
                  throw rejected(
                    "Owned skill tree contains foreign, unsealed, unsupported or oversized files.",
                  );
                const file = await open(childEntry, fileFlags);
                if (
                  !sameStat(childStat, await info(file)) ||
                  (await fs.realpath(fdPath(file))) !== selected.source
                )
                  throw rejected("Owned skill captured file identity changed.");
                files.push({
                  parent: handle,
                  name: child,
                  handle: file,
                  stat: childStat,
                  receipt: Object.freeze({
                    ...selected,
                    dev: safeNumber(childStat.dev),
                    ino: safeNumber(childStat.ino),
                  }),
                });
              }
            };
            await walk(stage, key, key, 0);
          }
          if (
            files.length !== expected.size ||
            files.some((file) => !expected.has(file.receipt.source.slice(directory.length + 1)))
          )
            throw rejected(
              "Owned skill captured tree differs from the exact selected launch file closure.",
            );
          await checkTree();
          receipts = Object.freeze(
            files.map((file) => file.receipt).sort((a, b) => a.source.localeCompare(b.source)),
          );
          state = "sealed";
          return receipts;
        });
      },
      retain: () => operation(retain),
      remove: () =>
        operation(async () => {
          if (state === "removed") {
            if (closeFailure) throw closeFailure;
            return;
          }
          if (state === "retained")
            throw rejected("Owned skill stage was retained; removal is unavailable.");
          if (state === "empty") {
            if (!sameStat(initial, await checkStage(0o700n)))
              throw rejected("Owned empty skill stage creation receipt changed.");
            await names(stage, 0);
            if (!sameStat(initial, await checkStage(0o700n)))
              throw rejected("Owned empty skill stage changed before release rmdir.");
            await fs.rmdir(fdPath(rootHandle) + "/" + name);
          } else {
            await checkTree();
            // Root has joined drainage before this point. Node has no conditional inode unlink;
            // trusted host mutations must stay serialized through this release as well.
            for (const entry of directories) {
              await checkStage(0o500n);
              if (
                !sameStat(entry.stat, await info(entry.handle)) ||
                !sameStat(
                  entry.stat,
                  await fs.lstat(fdPath(entry.parent) + "/" + entry.name, { bigint: true }),
                )
              )
                throw rejected("Owned skill directory changed before release chmod.");
              if (entry.handle !== stage) await entry.handle.chmod(0o700);
            }
            // The stage remains sealed until every descendant handle has been checked and opened.
            await checkStage(0o500n);
            await stage.chmod(0o700);
            for (const entry of files) {
              await checkStage(0o700n);
              if (
                !sameStat(entry.stat, await info(entry.handle)) ||
                !sameStat(
                  entry.stat,
                  await fs.lstat(fdPath(entry.parent) + "/" + entry.name, { bigint: true }),
                )
              )
                throw rejected(
                  "Owned skill file changed before release unlink; retain partial evidence.",
                );
              await fs.unlink(fdPath(entry.parent) + "/" + entry.name);
            }
            for (const entry of directories.toReversed()) {
              await checkStage(0o700n);
              const actual = await info(entry.handle);
              if (
                !sameOwner(entry.stat, actual) ||
                (actual.mode & 0o7777n) !== 0o700n ||
                !sameStat(
                  actual,
                  await fs.lstat(fdPath(entry.parent) + "/" + entry.name, { bigint: true }),
                ) ||
                (await fs.realpath(fdPath(entry.handle))) !== entry.path
              )
                throw rejected(
                  "Owned skill directory changed before release rmdir; retain partial evidence.",
                );
              await names(entry.handle, 0);
              await fs.rmdir(fdPath(entry.parent) + "/" + entry.name);
            }
          }
          state = "removed";
          await close();
        }),
    };
    return {
      lifetime: Object.freeze(lifetime),
      fallback: semaphore.withPermit(
        native(async () => {
          if (state === "empty" || state === "sealed") await retain();
          else await close();
        }),
      ),
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** Root owns cache policy and removal authority. Scope closure only retains and joins descriptor closes. */
export const makePiSkillStageLifetime = Effect.fn("makePiSkillStageLifetime")(function* (
  cacheRoot: string,
) {
  if ((yield* HostProcessPlatform) !== "linux")
    return yield* new PiManagedRuntimeError({
      code: "unavailable",
      detail: "Owned skill stage lifetime requires the proven Linux descriptor boundary.",
    });
  const uid = yield* HostProcessUserId;
  if (uid === undefined) return yield* rejected("Owned skill stage requires a host user identity.");
  const root = yield* decodeRoot(cacheRoot).pipe(
    Effect.mapError(() => rejected("Owned skill cache path must be canonical and bounded.")),
  );
  const owned = yield* Effect.acquireRelease(
    native(() => acquire(root, uid)),
    (value) => value.fallback.pipe(Effect.orDie),
  );
  return owned.lifetime;
});
