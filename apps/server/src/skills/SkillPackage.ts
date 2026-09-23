// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  ManagedSkillKey,
  ManagedSkillFrontmatter,
  ManagedSkillManifest,
  isManagedSkillFrontmatterValue,
  type ManagedSkillManifest as ManagedSkillManifestValue,
  type ManagedSkillContent,
  type ManagedSkillFrontmatterValue,
  type SkillContentHash,
} from "@t3tools/contracts";

export const SKILL_MANIFEST_FILE = "t3-skill.json";
export const SKILL_BODY_FILE = "SKILL.md";

export interface SkillPackageLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxManifestBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
}

export const DEFAULT_SKILL_PACKAGE_LIMITS: SkillPackageLimits = {
  maxFiles: 256,
  maxBytes: 8_000_000,
  maxManifestBytes: 64 * 1024,
  maxEntries: 512,
  maxDepth: 32,
};

export interface SkillPackageDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface SkillPackageInspection {
  readonly validity: "valid" | "invalid";
  readonly diagnostics: ReadonlyArray<SkillPackageDiagnostic>;
  readonly manifest?: ManagedSkillManifestValue;
  readonly content?: ManagedSkillContent;
  readonly hash?: SkillContentHash;
  readonly projectState?: "override" | "disabled";
}

export class SkillPackageError extends Schema.TaggedError<SkillPackageError>()(
  "SkillPackageError",
  {
    code: Schema.Literals([
      "unsafe_path",
      "duplicate_path",
      "file_count_exceeded",
      "byte_limit_exceeded",
      "manifest_size_exceeded",
      "traversal_limit_exceeded",
      "depth_limit_exceeded",
      "unsupported_entry",
      "symlink_not_allowed",
      "filesystem_metadata_failure",
      "filesystem_read_failure",
      "file_changed_during_inspection",
      "frontmatter_invalid",
    ]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed skill package rejected '${this.path}': ${this.code}.`;
  }
}

const decodeFrontmatter = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String, description: Schema.String }),
);
const decodeFrontmatterExtensions = Schema.decodeUnknownSync(ManagedSkillFrontmatter);
const decodeManifest = Schema.decodeUnknownSync(ManagedSkillManifest);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isManagedSkillKey = Schema.is(ManagedSkillKey);

function containsPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateRelativePath(path: Path.Path, relativePath: string): boolean {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  return (
    normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && normalized === relativePath
  );
}

interface PackageFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

interface InventoryFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly info: NodeFS.BigIntStats;
}

interface PackageInventory {
  readonly files: ReadonlyArray<InventoryFile>;
  readonly entryCount: number;
}

export interface SkillPackageTestHooks {
  readonly beforeDescriptorOpen?: (relativePath: string) => Effect.Effect<void>;
  readonly onDirectoryEntry?: (relativePath: string) => Effect.Effect<void>;
  readonly onDescriptorOpen?: (relativePath: string) => Effect.Effect<void>;
}

const metadataFailure = (filePath: string, cause: unknown) =>
  new SkillPackageError({ code: "filesystem_metadata_failure", path: filePath, cause });

const inventoryPackage = Effect.fn("SkillPackage.inventory")(function* (
  packagePath: string,
  limits: SkillPackageLimits,
  hooks?: SkillPackageTestHooks,
): Effect.fn.Return<PackageInventory, SkillPackageError, Path.Path> {
  const path = yield* Path.Path;
  const root = path.resolve(packagePath);
  const rootInfo = yield* Effect.tryPromise({
    try: () => NodeFSP.lstat(root, { bigint: true }),
    catch: (cause) => metadataFailure(root, cause),
  });
  if (rootInfo.isSymbolicLink()) {
    return yield* new SkillPackageError({ code: "symlink_not_allowed", path: root });
  }
  if (!rootInfo.isDirectory()) {
    return yield* new SkillPackageError({ code: "unsupported_entry", path: root });
  }
  const [realParent, realRoot] = yield* Effect.tryPromise({
    try: () => Promise.all([NodeFSP.realpath(path.dirname(root)), NodeFSP.realpath(root)]),
    catch: (cause) => metadataFailure(root, cause),
  });
  if (path.resolve(realRoot) !== path.resolve(realParent, path.basename(root))) {
    return yield* new SkillPackageError({ code: "symlink_not_allowed", path: root });
  }
  const queue: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly depth: number;
  }> = [{ absolutePath: root, relativePath: "", depth: 0 }];
  const files: InventoryFile[] = [];
  let entryCount = 0;
  let totalBytes = 0n;

  while (queue.length > 0) {
    const directory = queue.shift()!;
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.opendir(directory.absolutePath),
        catch: (cause) => metadataFailure(directory.absolutePath, cause),
      }),
      (handle) =>
        Effect.gen(function* () {
          while (true) {
            const entry = yield* Effect.tryPromise({
              try: () => handle.read(),
              catch: (cause) => metadataFailure(directory.absolutePath, cause),
            });
            if (entry === null) break;
            yield* hooks?.onDirectoryEntry?.(entry.name) ?? Effect.void;
            if (entryCount >= limits.maxEntries) {
              return yield* new SkillPackageError({
                code: "traversal_limit_exceeded",
                path: packagePath,
              });
            }
            entryCount += 1;
            const nativeRelative =
              directory.relativePath.length === 0
                ? entry.name
                : path.join(directory.relativePath, entry.name);
            const relativePath = nativeRelative.split(path.sep).join("/");
            const absolutePath = path.resolve(root, nativeRelative);
            const depth = directory.depth + 1;
            if (
              !containsPath(path, root, absolutePath) ||
              !validateRelativePath(path, nativeRelative)
            ) {
              return yield* new SkillPackageError({ code: "unsafe_path", path: relativePath });
            }
            if (depth > limits.maxDepth) {
              return yield* new SkillPackageError({
                code: "depth_limit_exceeded",
                path: relativePath,
              });
            }
            const info = yield* Effect.tryPromise({
              try: () => NodeFSP.lstat(absolutePath, { bigint: true }),
              catch: (cause) => metadataFailure(relativePath, cause),
            });
            if (info.isSymbolicLink()) {
              return yield* new SkillPackageError({
                code: "symlink_not_allowed",
                path: relativePath,
              });
            }
            if (info.isDirectory()) {
              queue.push({ absolutePath, relativePath: nativeRelative, depth });
              continue;
            }
            if (!info.isFile()) {
              return yield* new SkillPackageError({
                code: "unsupported_entry",
                path: relativePath,
              });
            }
            if (files.length >= limits.maxFiles) {
              return yield* new SkillPackageError({
                code: "file_count_exceeded",
                path: packagePath,
              });
            }
            if (
              relativePath === SKILL_MANIFEST_FILE &&
              info.size > BigInt(limits.maxManifestBytes)
            ) {
              return yield* new SkillPackageError({
                code: "manifest_size_exceeded",
                path: relativePath,
              });
            }
            totalBytes += info.size;
            if (totalBytes > BigInt(limits.maxBytes)) {
              return yield* new SkillPackageError({
                code: "byte_limit_exceeded",
                path: packagePath,
              });
            }
            files.push({ relativePath, absolutePath, info });
          }
        }),
      (handle) =>
        Effect.promise(async () => {
          try {
            await handle.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
          }
        }),
    );
  }
  return {
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    entryCount,
  };
});

const sameFile = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.isFile() &&
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const readInventoryFile = Effect.fn("SkillPackage.readInventoryFile")(function* (
  file: InventoryFile,
  hooks?: SkillPackageTestHooks,
): Effect.fn.Return<PackageFile, SkillPackageError> {
  if (hooks?.beforeDescriptorOpen !== undefined)
    yield* hooks.beforeDescriptorOpen(file.relativePath);
  yield* hooks?.onDescriptorOpen?.(file.relativePath) ?? Effect.void;
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.open(
          file.absolutePath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NONBLOCK ?? 0) |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        ),
      catch: (cause) =>
        new SkillPackageError({
          code: "file_changed_during_inspection",
          path: file.relativePath,
          cause,
        }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          const before = await handle.stat({ bigint: true });
          if (!sameFile(file.info, before)) throw new Error("file identity changed before read");
          const size = Number(file.info.size);
          if (!Number.isSafeInteger(size)) throw new Error("file size is not safe to allocate");
          const bytes = new Uint8Array(size);
          let offset = 0;
          while (offset < size) {
            const result = await handle.read(bytes, offset, size - offset, offset);
            if (result.bytesRead === 0) throw new Error("file truncated during read");
            offset += result.bytesRead;
          }
          const probe = new Uint8Array(1);
          if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
            throw new Error("file grew during read");
          }
          const after = await handle.stat({ bigint: true });
          const pathAfter = await NodeFSP.lstat(file.absolutePath, { bigint: true });
          if (!sameFile(file.info, after) || !sameFile(after, pathAfter)) {
            throw new Error("file identity changed during read");
          }
          return { relativePath: file.relativePath, bytes };
        },
        catch: (cause) =>
          new SkillPackageError({
            code: "file_changed_during_inspection",
            path: file.relativePath,
            cause,
          }),
      }),
    (handle) => Effect.promise(() => handle.close()),
  );
});

const readPackageFiles = Effect.fn("SkillPackage.readFiles")(function* (
  packagePath: string,
  limits: SkillPackageLimits,
  hooks?: SkillPackageTestHooks,
) {
  const inventory = yield* inventoryPackage(packagePath, limits, hooks);
  const files: PackageFile[] = [];
  for (const file of inventory.files) files.push(yield* readInventoryFile(file, hooks));
  return { files, entryCount: inventory.entryCount };
});

function hashPackageFiles(files: ReadonlyArray<PackageFile>): SkillContentHash {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.bytes.byteLength));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return hash.digest("hex") as SkillContentHash;
}

export const hashSkillPackage = Effect.fn("SkillPackage.hash")(function* (
  packagePath: string,
  limits: SkillPackageLimits = DEFAULT_SKILL_PACKAGE_LIMITS,
) {
  const { files } = yield* readPackageFiles(packagePath, limits);
  return hashPackageFiles(files.filter((file) => file.relativePath !== SKILL_MANIFEST_FILE));
});

export function parsePortableSkillDocument(contents: string): {
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
  } & ManagedSkillFrontmatter;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(contents);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");
  const parsed = parseYaml(match[1] ?? "");
  const frontmatter = decodeFrontmatter(parsed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill frontmatter must be a mapping");
  }
  const extensions = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "name" && key !== "description"),
  );
  const decodedExtensions = decodeFrontmatterExtensions(extensions);
  if (
    frontmatter.name.trim() !== frontmatter.name ||
    frontmatter.description.trim().length === 0 ||
    frontmatter.description !== frontmatter.description.trim() ||
    frontmatter.description.length > 1_024
  ) {
    throw new Error("Skill name and description must be portable non-empty strings");
  }
  return {
    frontmatter: { ...frontmatter, ...decodedExtensions },
    body: match[2] ?? "",
  };
}

export const portableSkillFrontmatterExtensions = (
  frontmatter: {
    readonly name: string;
    readonly description: string;
  } & ManagedSkillFrontmatter,
): ManagedSkillFrontmatter =>
  Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => key !== "name" && key !== "description"),
  ) as ManagedSkillFrontmatter;

export const inspectSkillPackage = Effect.fn("SkillPackage.inspect")(function* (input: {
  readonly packagePath: string;
  readonly expectedKey?: string;
  readonly expectedScope?: "global" | "project";
  readonly limits?: SkillPackageLimits;
  readonly hooks?: SkillPackageTestHooks;
}): Effect.fn.Return<
  SkillPackageInspection,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  yield* FileSystem.FileSystem;
  yield* Path.Path;
  const diagnostics: SkillPackageDiagnostic[] = [];
  if (input.expectedKey !== undefined && !isManagedSkillKey(input.expectedKey)) {
    diagnostics.push({
      code: "key_invalid",
      message: "Package directory is not a portable lowercase kebab key.",
    });
  }
  const packageResult = yield* readPackageFiles(
    input.packagePath,
    input.limits ?? DEFAULT_SKILL_PACKAGE_LIMITS,
    input.hooks,
  ).pipe(Effect.result);
  if (Result.isFailure(packageResult)) {
    const error = packageResult.failure;
    diagnostics.push({ code: error.code, message: error.message, path: error.path });
    return { validity: "invalid", diagnostics };
  }
  const files = packageResult.success.files;
  const byPath = new Map(files.map((file) => [file.relativePath, file.bytes]));
  let manifest: ManagedSkillManifestValue | undefined;
  let projectState: "override" | "disabled" | undefined;
  const rawManifestBytes = byPath.get(SKILL_MANIFEST_FILE);
  if (rawManifestBytes === undefined) {
    diagnostics.push({ code: "manifest_missing", message: "t3-skill.json is missing." });
  } else {
    try {
      const rawManifest = new TextDecoder().decode(rawManifestBytes);
      const unknownManifest = decodeJson(rawManifest);
      manifest = decodeManifest(unknownManifest);
      const rawProjectState = Predicate.isObject(unknownManifest)
        ? unknownManifest.projectState
        : undefined;
      if (rawProjectState === "override" || rawProjectState === "disabled") {
        projectState = rawProjectState;
      }
      if (manifest.ownership !== "t3") {
        diagnostics.push({ code: "ownership_invalid", message: "Package is not owned by T3." });
      }
      if (input.expectedScope !== undefined && manifest.scope !== input.expectedScope) {
        diagnostics.push({
          code: "scope_invalid",
          message: "Manifest scope does not match its root.",
        });
      }
      if (manifest.scope === "global" && rawProjectState !== undefined) {
        diagnostics.push({
          code: "project_state_invalid",
          message: "Global packages cannot have project state.",
        });
      }
      if (manifest.scope === "project" && projectState === undefined) {
        diagnostics.push({
          code: "project_state_invalid",
          message: "Project packages require project state.",
        });
      }
      if (input.expectedKey !== undefined && manifest.key !== input.expectedKey) {
        diagnostics.push({
          code: "manifest_key_mismatch",
          message: "Manifest key does not match its directory.",
        });
      }
    } catch {
      diagnostics.push({ code: "manifest_invalid", message: "t3-skill.json is malformed." });
    }
  }

  let content: ManagedSkillContent | undefined;
  const rawSkillBytes = byPath.get(SKILL_BODY_FILE);
  if (rawSkillBytes === undefined) {
    if (projectState !== "disabled") {
      diagnostics.push({ code: "skill_missing", message: "SKILL.md is missing." });
    }
  } else {
    try {
      const rawSkill = new TextDecoder().decode(rawSkillBytes);
      const parsed = parsePortableSkillDocument(rawSkill);
      const key = manifest?.key ?? input.expectedKey;
      if (key !== undefined) {
        if (parsed.frontmatter.name !== key) {
          diagnostics.push({
            code: "frontmatter_key_mismatch",
            message: "Frontmatter name does not match the portable key.",
          });
        }
        content = {
          key: key as ManagedSkillContent["key"],
          name: parsed.frontmatter.description,
          body: parsed.body,
          ...(Object.keys(portableSkillFrontmatterExtensions(parsed.frontmatter)).length === 0
            ? {}
            : { frontmatter: portableSkillFrontmatterExtensions(parsed.frontmatter) }),
        };
      }
    } catch {
      diagnostics.push({
        code: "frontmatter_invalid",
        message: "SKILL.md frontmatter is malformed.",
      });
    }
  }

  if (
    projectState === "disabled" &&
    (packageResult.success.entryCount !== 1 || files.length !== 1)
  ) {
    diagnostics.push({
      code: "tombstone_invalid",
      message: "Disabled project tombstones may contain only t3-skill.json.",
    });
  }

  let hash: SkillContentHash | undefined;
  const authoredFiles = files.filter((file) => file.relativePath !== SKILL_MANIFEST_FILE);
  const hashResult = {
    hash: hashPackageFiles(authoredFiles),
    assetPaths: authoredFiles
      .map((file) => file.relativePath)
      .filter((relativePath) => relativePath !== SKILL_BODY_FILE),
  };
  hash = hashResult.hash;
  if (content !== undefined && hashResult.assetPaths.length > 0) {
    content = { ...content, assetPaths: hashResult.assetPaths };
  }
  if (manifest !== undefined && hash !== undefined && manifest.revision.hash !== hash) {
    diagnostics.push({
      code: "hash_mismatch",
      message: "Manifest hash does not match package content.",
    });
  }

  return {
    validity: diagnostics.length === 0 ? "valid" : "invalid",
    diagnostics,
    ...(manifest === undefined ? {} : { manifest }),
    ...(content === undefined ? {} : { content }),
    ...(hash === undefined ? {} : { hash }),
    ...(projectState === undefined ? {} : { projectState }),
  };
});

function sortFrontmatterValue(value: ManagedSkillFrontmatterValue): ManagedSkillFrontmatterValue {
  if (Array.isArray(value)) return value.map(sortFrontmatterValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortFrontmatterValue(entry)]),
    );
  }
  return value;
}

function skillDocument(content: ManagedSkillContent): string {
  const extensions = decodeFrontmatterExtensions(content.frontmatter ?? {});
  if (Object.values(extensions).some((value) => !isManagedSkillFrontmatterValue(value))) {
    throw new Error("Skill frontmatter contains an unsupported value");
  }
  const frontmatter = stringifyYaml({
    name: content.key,
    description: content.name,
    ...Object.fromEntries(
      Object.entries(extensions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, sortFrontmatterValue(value)]),
    ),
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${content.body}`;
}

export const writeSkillPackageContents = Effect.fn("SkillPackage.writeContents")(function* (input: {
  readonly packagePath: string;
  readonly manifest: ManagedSkillManifestValue;
  readonly content?: ManagedSkillContent;
  readonly projectState?: "override" | "disabled";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assetPaths = input.content?.assetPaths ?? [];
  const seen = new Set<string>();
  for (const assetPath of assetPaths) {
    if (!validateRelativePath(path, assetPath)) {
      return yield* new SkillPackageError({ code: "unsafe_path", path: assetPath });
    }
    if (seen.has(assetPath)) {
      return yield* new SkillPackageError({ code: "duplicate_path", path: assetPath });
    }
    seen.add(assetPath);
  }
  yield* fs.makeDirectory(input.packagePath, { recursive: true });
  if (input.content !== undefined) {
    const document = yield* Effect.try({
      try: () => skillDocument(input.content!),
      catch: (cause) =>
        new SkillPackageError({
          code: "frontmatter_invalid",
          path: SKILL_BODY_FILE,
          cause,
        }),
    });
    yield* fs.writeFileString(path.join(input.packagePath, SKILL_BODY_FILE), document);
  }
  const manifestJson = {
    ...input.manifest,
    ...(input.projectState === undefined ? {} : { projectState: input.projectState }),
  };
  yield* fs.writeFileString(
    path.join(input.packagePath, SKILL_MANIFEST_FILE),
    `${encodeJson(manifestJson)}\n`,
  );
});
