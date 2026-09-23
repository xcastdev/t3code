// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  ManagedSkillId as ManagedSkillIdSchema,
  type ManagedSkillId,
  type ManagedSkillContent,
  type ManagedSkillContentDraft,
  type ManagedSkillKey,
  type ManagedSkillManifest,
  type SkillContentHash,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import {
  hashSkillPackage,
  inspectSkillPackage,
  SKILL_BODY_FILE,
  type SkillPackageInspection,
  SkillPackageError,
  writeSkillPackageContents,
} from "./SkillPackage.ts";

const HISTORY_LIMIT = 20;

export interface OwnedSkillPackage {
  readonly packagePath: string;
  readonly manifest: ManagedSkillManifest;
  readonly content: ManagedSkillContent;
  readonly projectState?: "override";
}

export interface DisabledProjectSkillPackage {
  readonly packagePath: string;
  readonly manifest: ManagedSkillManifest;
  readonly content?: undefined;
  readonly projectState: "disabled";
}

export type ProjectSkillPackage = OwnedSkillPackage | DisabledProjectSkillPackage;

export interface SkillPackageEntry extends SkillPackageInspection {
  readonly packagePath: string;
  readonly directoryName: string;
}

export class ManagedSkillRepositoryError extends Schema.TaggedError<ManagedSkillRepositoryError>()(
  "ManagedSkillRepositoryError",
  {
    code: Schema.Literals([
      "not_found",
      "revision_conflict",
      "destination_collision",
      "invalid_package",
      "mutation_failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

class ManagedSkillNodeError extends Schema.TaggedError<ManagedSkillNodeError>()(
  "ManagedSkillNodeError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type RepositoryFailure =
  | ManagedSkillRepositoryError
  | SkillPackageError
  | PlatformError.PlatformError;

interface GlobalCreateInput {
  readonly expectedRevision: number;
  readonly content: ManagedSkillContent;
}

interface GlobalImportInput extends GlobalCreateInput {
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
}

interface GlobalReplaceInput {
  readonly skillId: ManagedSkillId;
  readonly expectedHash: SkillContentHash;
  readonly content: ManagedSkillContentDraft;
  readonly operationTag?: string;
}

interface FinalRename {
  (
    from: string,
    to: string,
    rename: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ): Effect.Effect<void, ManagedSkillRepositoryError | PlatformError.PlatformError>;
}

type StageCopy = (
  source: string,
  destination: string,
  copy: (source: string, destination: string) => Effect.Effect<void, ManagedSkillRepositoryError>,
) => Effect.Effect<void, ManagedSkillRepositoryError | PlatformError.PlatformError>;

export interface ManagedSkillRepositoryOptions {
  readonly finalRename?: FinalRename;
  readonly archiveRename?: FinalRename;
  readonly removeRollback?: (
    rollback: string,
    remove: (path: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ) => Effect.Effect<void, ManagedSkillRepositoryError | PlatformError.PlatformError>;
  readonly pruneHistoryRevision?: (
    revisionPath: string,
    remove: (path: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ) => Effect.Effect<void, ManagedSkillRepositoryError | PlatformError.PlatformError>;
  readonly copyStageContents?: StageCopy;
  readonly onMutationLookup?: (
    operationTag: string,
    lookupPath: string,
    kind: "exists" | "enumerate",
  ) => Effect.Effect<void>;
  readonly onStageDirectoryCreated?: (
    operationTag: string,
    stagePath: string,
  ) => Effect.Effect<void>;
  readonly duringStagePopulation?: (operationTag: string) => Effect.Effect<void>;
  readonly onMutationLockRegistered?: (
    operationTag: string,
    canonicalRoot: string,
  ) => Effect.Effect<void>;
  readonly onMutationPermitRequest?: (
    operationTag: string,
    canonicalRoot: string,
  ) => Effect.Effect<void>;
  readonly onMutationPermitAcquired?: (
    operationTag: string,
    canonicalRoot: string,
  ) => Effect.Effect<void>;
  readonly makeMutationSemaphore?: (canonicalRoot: string) => Effect.Effect<Semaphore.Semaphore>;
}

export interface ManagedSkillRepositoryService {
  readonly subscribeInvalidations: Effect.Effect<
    PubSub.Subscription<ManagedSkillRepositoryInvalidation>,
    never,
    Scope.Scope
  >;
  readonly listGlobal: () => Effect.Effect<
    ReadonlyArray<SkillPackageEntry>,
    PlatformError.PlatformError | ManagedSkillRepositoryError
  >;
  readonly readGlobal: (
    skillId: ManagedSkillId,
  ) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly createGlobal: (
    input: GlobalCreateInput,
  ) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly importGlobal: (
    input: GlobalImportInput,
  ) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly updateGlobal: (
    input: GlobalReplaceInput,
  ) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly deleteGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
  }) => Effect.Effect<void, RepositoryFailure>;
  readonly renameGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly key: ManagedSkillKey;
    readonly operationTag?: string;
  }) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly rollbackGlobal: (input: {
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly revision: number;
    readonly operationTag?: string;
  }) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly listGlobalHistory: (
    skillId: ManagedSkillId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly revision: number; readonly packagePath: string }>,
    PlatformError.PlatformError | ManagedSkillRepositoryError
  >;
  readonly listProject: (
    projectRoot: string,
  ) => Effect.Effect<
    ReadonlyArray<SkillPackageEntry>,
    PlatformError.PlatformError | ManagedSkillRepositoryError
  >;
  readonly readProject: (
    projectRoot: string,
    skillId: ManagedSkillId,
  ) => Effect.Effect<ProjectSkillPackage, RepositoryFailure>;
  readonly setProjectOverride: (input: {
    readonly projectRoot: string;
    readonly key: ManagedSkillKey;
    readonly expectedHash?: SkillContentHash;
    readonly content: ManagedSkillContentDraft;
    readonly operationTag?: string;
  }) => Effect.Effect<OwnedSkillPackage, RepositoryFailure>;
  readonly setProjectDisabled: (input: {
    readonly projectRoot: string;
    readonly key: ManagedSkillKey;
    readonly expectedHash?: SkillContentHash;
    readonly operationTag?: string;
  }) => Effect.Effect<DisabledProjectSkillPackage, RepositoryFailure>;
  readonly deleteProjectState: (input: {
    readonly projectRoot: string;
    readonly key: ManagedSkillKey;
    readonly operationTag?: string;
    readonly expectedHash: SkillContentHash;
  }) => Effect.Effect<void, RepositoryFailure>;
  readonly renameProject: (input: {
    readonly projectRoot: string;
    readonly skillId: ManagedSkillId;
    readonly expectedHash: SkillContentHash;
    readonly key: ManagedSkillKey;
    readonly operationTag?: string;
  }) => Effect.Effect<ProjectSkillPackage, RepositoryFailure>;
}

export type ManagedSkillRepositoryInvalidation =
  | { readonly scope: "global" }
  | { readonly scope: "project"; readonly projectRoot: string };

export class ManagedSkillRepository extends Context.Service<
  ManagedSkillRepository,
  ManagedSkillRepositoryService
>()("t3/skills/ManagedSkillRepository") {}

const invalidPackage = (detail: string) =>
  new ManagedSkillRepositoryError({ code: "invalid_package", detail });

export const makeWith = (options: ManagedSkillRepositoryOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const invalidations = yield* PubSub.unbounded<ManagedSkillRepositoryInvalidation>();
    const rename = (from: string, to: string) => fs.rename(from, to);
    const finalRename: FinalRename =
      options.finalRename ?? ((from, to, operation) => operation(from, to));
    const archiveRename: FinalRename =
      options.archiveRename ?? ((from, to, operation) => operation(from, to));
    const mutationLocks = yield* Ref.make<
      ReadonlyMap<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>
    >(new Map());
    const isManagedSkillId = Schema.is(ManagedSkillIdSchema);

    const repositoryError = (detail: string, cause?: unknown) =>
      new ManagedSkillRepositoryError({
        code: "mutation_failed",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    const nodeMetadata = <A>(filePath: string, operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (cause) =>
          repositoryError(`Could not validate managed skill path '${filePath}'.`, cause),
      });

    const directChild = (root: string, component: string) => {
      const resolvedRoot = path.resolve(root);
      const candidate = path.resolve(resolvedRoot, component);
      const relative = path.relative(resolvedRoot, candidate);
      return relative !== "" &&
        !path.isAbsolute(relative) &&
        !relative.startsWith("..") &&
        !relative.includes(path.sep) &&
        path.dirname(candidate) === resolvedRoot
        ? Effect.succeed(candidate)
        : Effect.fail(invalidPackage(`'${component}' is not a contained path component.`));
    };

    const lstatOptional = (filePath: string) =>
      Effect.tryPromise({
        try: () => NodeFSP.lstat(filePath, { bigint: true }),
        catch: (cause) => new ManagedSkillNodeError({ path: filePath, cause }),
      }).pipe(
        Effect.catchTag("ManagedSkillNodeError", (error) =>
          (error.cause as NodeJS.ErrnoException).code === "ENOENT"
            ? Effect.succeed(undefined)
            : Effect.fail(
                repositoryError(`Could not inspect managed skill path '${filePath}'.`, error.cause),
              ),
        ),
      );

    const ensureDirectory = Effect.fn("ManagedSkillRepository.ensureDirectory")(function* (
      directory: string,
      create: boolean,
    ) {
      let info = yield* lstatOptional(directory);
      if (info === undefined && create) {
        yield* nodeMetadata(directory, () => NodeFSP.mkdir(directory));
        info = yield* lstatOptional(directory);
      }
      if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
        return yield* invalidPackage(`Managed skill root '${directory}' is not a real directory.`);
      }
      const real = yield* nodeMetadata(directory, () => NodeFSP.realpath(directory));
      if (path.resolve(real) !== path.resolve(directory)) {
        return yield* invalidPackage(`Managed skill root '${directory}' is redirected.`);
      }
      return path.resolve(directory);
    });

    const validateExistingRealDirectory = Effect.fn(
      "ManagedSkillRepository.validateExistingRealDirectory",
    )(function* (directory: string, label: string) {
      const resolved = path.resolve(directory);
      const info = yield* lstatOptional(resolved);
      if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
        return yield* invalidPackage(`${label} '${resolved}' is not a real directory.`);
      }
      const realPath = yield* nodeMetadata(resolved, () => NodeFSP.realpath(resolved));
      if (path.resolve(realPath) !== resolved) {
        return yield* invalidPackage(`${label} '${resolved}' is redirected.`);
      }
      return { path: resolved, realPath: path.resolve(realPath) };
    });

    const ensureGlobalRoot = Effect.fn("ManagedSkillRepository.ensureGlobalRoot")(function* (
      kind: "skills" | "skill-history",
      create = false,
    ) {
      const configured = kind === "skills" ? config.managedSkillsDir : config.skillHistoryDir;
      const expected = yield* directChild(config.stateDir, kind);
      if (path.resolve(configured) !== expected) {
        return yield* invalidPackage(`Configured ${kind} root is outside the state directory.`);
      }
      const state = yield* ensureDirectory(path.resolve(config.stateDir), false);
      return yield* ensureDirectory(yield* directChild(state, kind), create);
    });

    const existingGlobalRoot = Effect.fn("ManagedSkillRepository.existingGlobalRoot")(function* (
      kind: "skills" | "skill-history",
    ) {
      const configured = kind === "skills" ? config.managedSkillsDir : config.skillHistoryDir;
      const expected = yield* directChild(config.stateDir, kind);
      if (path.resolve(configured) !== expected) {
        return yield* invalidPackage(`Configured ${kind} root is outside the state directory.`);
      }
      const state = yield* ensureDirectory(path.resolve(config.stateDir), false);
      const rootPath = yield* directChild(state, kind);
      if ((yield* lstatOptional(rootPath)) === undefined) return undefined;
      return yield* ensureDirectory(rootPath, false);
    });

    const ensureProjectRoot = Effect.fn("ManagedSkillRepository.ensureProjectRoot")(function* (
      projectRoot: string,
      create = false,
    ) {
      const projectInfo = yield* lstatOptional(path.resolve(projectRoot));
      if (projectInfo === undefined || projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
        return yield* invalidPackage(`Project root '${projectRoot}' is not a real directory.`);
      }
      const canonicalProject = yield* nodeMetadata(projectRoot, () =>
        NodeFSP.realpath(projectRoot),
      );
      const t3code = yield* ensureDirectory(
        yield* directChild(canonicalProject, ".t3code"),
        create,
      );
      return yield* ensureDirectory(yield* directChild(t3code, "skills"), create);
    });

    const existingProjectRoot = Effect.fn("ManagedSkillRepository.existingProjectRoot")(function* (
      projectRoot: string,
    ) {
      const resolvedProject = path.resolve(projectRoot);
      const projectInfo = yield* lstatOptional(resolvedProject);
      if (projectInfo === undefined || projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
        return yield* invalidPackage(`Project root '${projectRoot}' is not a real directory.`);
      }
      const canonicalProject = yield* nodeMetadata(projectRoot, () =>
        NodeFSP.realpath(projectRoot),
      );
      const t3codePath = yield* directChild(canonicalProject, ".t3code");
      if ((yield* lstatOptional(t3codePath)) === undefined) return undefined;
      const t3code = yield* ensureDirectory(t3codePath, false);
      const skillsPath = yield* directChild(t3code, "skills");
      if ((yield* lstatOptional(skillsPath)) === undefined) return undefined;
      return yield* ensureDirectory(skillsPath, false);
    });

    const historyIdPath = Effect.fn("ManagedSkillRepository.historyIdPath")(function* (
      skillId: ManagedSkillId,
      createRoot = false,
    ) {
      if (!isManagedSkillId(skillId)) {
        return yield* invalidPackage(`Managed skill id '${skillId}' is not a safe path component.`);
      }
      const historyRoot = yield* ensureGlobalRoot("skill-history", createRoot);
      return yield* directChild(historyRoot, skillId);
    });

    const existingHistoryIdRoot = Effect.fn("ManagedSkillRepository.existingHistoryIdRoot")(
      function* (skillId: ManagedSkillId) {
        const idRoot = yield* historyIdPath(skillId, false);
        if ((yield* lstatOptional(idRoot)) === undefined) return undefined;
        return (yield* validateExistingRealDirectory(idRoot, "History skill root")).path;
      },
    );

    const ensureHistoryIdRoot = Effect.fn("ManagedSkillRepository.ensureHistoryIdRoot")(function* (
      skillId: ManagedSkillId,
    ) {
      const idRoot = yield* historyIdPath(skillId, true);
      if ((yield* lstatOptional(idRoot)) === undefined) yield* ensureDirectory(idRoot, true);
      return (yield* validateExistingRealDirectory(idRoot, "History skill root")).path;
    });

    const existingHistoryRevision = Effect.fn("ManagedSkillRepository.existingHistoryRevision")(
      function* (idRoot: string, revision: number) {
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          return yield* invalidPackage(`History revision '${revision}' is invalid.`);
        }
        const revisionRoot = yield* directChild(idRoot, String(revision));
        if ((yield* lstatOptional(revisionRoot)) === undefined) return undefined;
        return (yield* validateExistingRealDirectory(revisionRoot, "History revision")).path;
      },
    );

    const withMutationRoot = <A, E, R>(
      operationTag: string,
      canonicalRoot: string,
      mutation: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const candidate = yield* (
            options.makeMutationSemaphore?.(canonicalRoot) ?? Semaphore.make(1)
          );
          return yield* Ref.modify(mutationLocks, (locks) => {
            const existing = locks.get(canonicalRoot);
            const lock =
              existing === undefined
                ? { semaphore: candidate, users: 1 }
                : { semaphore: existing.semaphore, users: existing.users + 1 };
            const next = new Map(locks);
            next.set(canonicalRoot, lock);
            return [lock, next] as const;
          });
        }),
        (lock) =>
          (options.onMutationLockRegistered?.(operationTag, canonicalRoot) ?? Effect.void).pipe(
            Effect.andThen(
              options.onMutationPermitRequest?.(operationTag, canonicalRoot) ?? Effect.void,
            ),
            Effect.andThen(
              lock.semaphore.withPermits(1)(
                (
                  options.onMutationPermitAcquired?.(operationTag, canonicalRoot) ?? Effect.void
                ).pipe(Effect.andThen(mutation)),
              ),
            ),
          ),
        (lock) =>
          Ref.update(mutationLocks, (locks) => {
            const current = locks.get(canonicalRoot);
            if (current === undefined || current.semaphore !== lock.semaphore) return locks;
            const next = new Map(locks);
            if (current.users === 1) next.delete(canonicalRoot);
            else
              next.set(canonicalRoot, { semaphore: current.semaphore, users: current.users - 1 });
            return next;
          }),
      );

    const inspectPackage = (input: Parameters<typeof inspectSkillPackage>[0]) =>
      inspectSkillPackage(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const hashPackage = (packageRoot: string) =>
      hashSkillPackage(packageRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const writePackage = (input: Parameters<typeof writeSkillPackageContents>[0]) =>
      writeSkillPackageContents(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const packagePath = (root: string, key: string) => path.join(root, key);
    const temporaryPath = (root: string, key: string, kind: "tmp" | "rollback") =>
      path.join(root, `.${key}.${kind}-${NodeCrypto.randomUUID()}`);

    const generatedArtifact =
      /^\.[a-z0-9]+(?:-[a-z0-9]+)*\.(?:tmp|rollback)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const canonicalHistoryRevision = (name: string) => {
      if (!/^[1-9][0-9]*$/.test(name)) return undefined;
      const revision = Number(name);
      return Number.isSafeInteger(revision) && revision > 0 && String(revision) === name
        ? revision
        : undefined;
    };

    const listRoot = Effect.fn("ManagedSkillRepository.listRoot")(function* (
      root: string,
      expectedScope: "global" | "project",
      operationTag?: string,
    ) {
      if (operationTag !== undefined) {
        yield* options.onMutationLookup?.(operationTag, root, "exists") ?? Effect.void;
      }
      if (!(yield* fs.exists(root))) return [];
      if (operationTag !== undefined) {
        yield* options.onMutationLookup?.(operationTag, root, "enumerate") ?? Effect.void;
      }
      const entries = (yield* fs.readDirectory(root))
        .filter((name) => !generatedArtifact.test(name))
        .sort((left, right) => left.localeCompare(right));
      const inspected: SkillPackageEntry[] = [];
      for (const directoryName of entries) {
        const currentPath = packagePath(root, directoryName);
        const info = yield* lstatOptional(currentPath);
        if (info === undefined) continue;
        if (info.isSymbolicLink() || !info.isDirectory()) {
          inspected.push({
            packagePath: currentPath,
            directoryName,
            validity: "invalid",
            diagnostics: [
              {
                code: info.isSymbolicLink() ? "symlink_not_allowed" : "unsupported_entry",
                message: `Managed skill entry '${directoryName}' is not a real directory.`,
                path: currentPath,
              },
            ],
          });
          continue;
        }
        const inspection = yield* inspectPackage({
          packagePath: currentPath,
          expectedKey: directoryName,
          expectedScope,
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({
              validity: "invalid" as const,
              diagnostics: [
                {
                  code: "filesystem_read_failure",
                  message: `Could not inspect managed skill entry '${directoryName}'.`,
                  path: currentPath,
                },
              ],
            }),
          ),
        );
        inspected.push({ packagePath: currentPath, directoryName, ...inspection });
      }
      return inspected;
    });

    const requireOwned = Effect.fn("ManagedSkillRepository.requireOwned")(function* (
      entry: SkillPackageEntry,
    ): Effect.fn.Return<ProjectSkillPackage, ManagedSkillRepositoryError> {
      if (entry.validity !== "valid" || entry.manifest === undefined) {
        return yield* invalidPackage(`Managed skill package '${entry.packagePath}' is invalid.`);
      }
      if (entry.projectState === "disabled") {
        return {
          packagePath: entry.packagePath,
          manifest: entry.manifest,
          projectState: "disabled",
        };
      }
      if (entry.content === undefined) {
        return yield* invalidPackage(`Managed skill package '${entry.packagePath}' has no body.`);
      }
      return {
        packagePath: entry.packagePath,
        manifest: entry.manifest,
        content: entry.content,
        ...(entry.projectState === "override" ? { projectState: "override" as const } : {}),
      };
    });

    const findById = Effect.fn("ManagedSkillRepository.findById")(function* (
      root: string,
      skillId: ManagedSkillId,
      operationTag?: string,
    ) {
      const entries = yield* listRoot(
        root,
        root === path.resolve(config.managedSkillsDir) ? "global" : "project",
        operationTag,
      );
      const entry = entries.find((candidate) => candidate.manifest?.id === skillId);
      if (entry === undefined) {
        return yield* new ManagedSkillRepositoryError({
          code: "not_found",
          detail: `Managed skill '${skillId}' was not found.`,
        });
      }
      return yield* requireOwned(entry);
    });

    const stagePackage = Effect.fn("ManagedSkillRepository.stagePackage")(function* (input: {
      readonly root: string;
      readonly key: ManagedSkillKey;
      readonly id: ManagedSkillId;
      readonly scope: "global" | "project";
      readonly revision: number;
      readonly origin?: "created" | "imported";
      readonly content?: ManagedSkillContent;
      readonly projectState?: "override" | "disabled";
      readonly copyFrom?: string;
      /** The source scope is explicit for the one safe global-to-project seed path. */
      readonly copyFromScope?: "global" | "project";
      readonly copySnapshot?: {
        readonly id: ManagedSkillId;
        readonly key: ManagedSkillKey;
        readonly revision: number;
        readonly hash: SkillContentHash;
      };
      readonly seedFiles?: ReadonlyArray<{
        readonly relativePath: string;
        readonly bytes: Uint8Array;
      }>;
      readonly operationTag?: string;
    }) {
      const stage = yield* directChild(
        input.root,
        path.basename(temporaryPath(input.root, input.key, "tmp")),
      );
      const operationTag = input.operationTag ?? "mutation";
      return yield* Effect.gen(function* () {
        yield* fs.makeDirectory(stage);
        yield* options.onStageDirectoryCreated?.(operationTag, stage) ?? Effect.void;
        yield* validateExistingRealDirectory(stage, "Staged package root");
        if (input.copyFrom !== undefined && input.projectState !== "disabled") {
          const source = (yield* validateExistingRealDirectory(
            input.copyFrom,
            "Managed skill copy source",
          )).path;
          const copy = (from: string, destination: string) =>
            Effect.tryPromise({
              try: async () => {
                for (const name of await NodeFSP.readdir(from)) {
                  await NodeFSP.cp(path.join(from, name), path.join(destination, name), {
                    recursive: true,
                    dereference: false,
                    verbatimSymlinks: true,
                    force: false,
                    errorOnExist: true,
                  });
                }
              },
              catch: (cause) =>
                repositoryError(`Could not copy managed skill package '${from}'.`, cause),
            });
          yield* options.copyStageContents?.(source, stage, copy) ?? copy(source, stage);
          const copied = yield* inspectPackage({
            packagePath: stage,
            expectedScope: input.copyFromScope ?? input.scope,
          });
          const copiedPackage = yield* requireOwned({
            packagePath: stage,
            directoryName: path.basename(stage),
            ...copied,
          });
          if (
            input.copySnapshot !== undefined &&
            (copiedPackage.manifest.id !== input.copySnapshot.id ||
              copiedPackage.manifest.key !== input.copySnapshot.key ||
              copiedPackage.manifest.revision.revision !== input.copySnapshot.revision ||
              copiedPackage.manifest.revision.hash !== input.copySnapshot.hash)
          ) {
            return yield* invalidPackage(
              "History snapshot changed while it was copied for rollback.",
            );
          }
        }
        for (const file of input.seedFiles ?? []) {
          if (
            file.relativePath === SKILL_BODY_FILE ||
            file.relativePath === "t3-skill.json" ||
            path.isAbsolute(file.relativePath) ||
            file.relativePath
              .split(/[\\/]/u)
              .some((part) => part === "" || part === "." || part === "..")
          ) {
            return yield* invalidPackage(`Imported path '${file.relativePath}' is unsafe.`);
          }
          const target = path.resolve(stage, file.relativePath);
          const relative = path.relative(stage, target);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return yield* invalidPackage(
              `Imported path '${file.relativePath}' escapes its package.`,
            );
          }
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFile(target, file.bytes);
        }
        yield* options.duringStagePopulation?.(operationTag) ?? Effect.void;
        const pendingManifest: ManagedSkillManifest = {
          schemaVersion: 1,
          kind: "managed-skill",
          id: input.id,
          key: input.key,
          scope: input.scope,
          revision: { revision: input.revision, hash: "pending" as SkillContentHash },
          origin: input.origin ?? "created",
          ownership: "t3",
        };
        yield* writePackage({
          packagePath: stage,
          manifest: pendingManifest,
          ...(input.content === undefined ? {} : { content: input.content }),
          ...(input.projectState === undefined ? {} : { projectState: input.projectState }),
        });
        if (input.projectState === "disabled") {
          yield* fs.remove(path.join(stage, SKILL_BODY_FILE), { force: true });
        }
        const hash = yield* hashPackage(stage);
        const manifest: ManagedSkillManifest = {
          ...pendingManifest,
          revision: { revision: input.revision, hash },
        };
        yield* writePackage({
          packagePath: stage,
          manifest,
          ...(input.content === undefined ? {} : { content: input.content }),
          ...(input.projectState === undefined ? {} : { projectState: input.projectState }),
        });
        const inspection = yield* inspectPackage({
          packagePath: stage,
          expectedKey: input.key,
          expectedScope: input.scope,
        });
        const staged = yield* requireOwned({
          packagePath: stage,
          directoryName: input.key,
          ...inspection,
        });
        return { stage, staged };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? fs.remove(stage, { recursive: true, force: true }).pipe(Effect.orDie)
            : Effect.void,
        ),
      );
    });

    const checkExpectedHash = (
      current: ProjectSkillPackage,
      expectedHash: SkillContentHash | undefined,
    ) =>
      expectedHash === current.manifest.revision.hash
        ? Effect.void
        : Effect.fail(
            new ManagedSkillRepositoryError({
              code: "revision_conflict",
              detail: `Expected hash does not match '${current.manifest.key}'.`,
            }),
          );

    const checkExpectedProjectState = (
      key: ManagedSkillKey,
      current: ProjectSkillPackage | undefined,
      expectedHash: SkillContentHash | undefined,
    ) => {
      if (current === undefined) {
        return expectedHash === undefined
          ? Effect.void
          : Effect.fail(
              new ManagedSkillRepositoryError({
                code: "revision_conflict",
                detail: `Expected project skill '${key}' is absent.`,
              }),
            );
      }
      return checkExpectedHash(current, expectedHash);
    };

    const checkCurrentSnapshot = Effect.fn("ManagedSkillRepository.checkCurrentSnapshot")(
      function* (
        stagedFrom: ProjectSkillPackage,
        current: ProjectSkillPackage,
        expectedHash: SkillContentHash | undefined,
      ) {
        yield* checkExpectedHash(current, expectedHash);
        if (
          current.manifest.id !== stagedFrom.manifest.id ||
          current.manifest.key !== stagedFrom.manifest.key ||
          current.manifest.revision.revision !== stagedFrom.manifest.revision.revision
        ) {
          return yield* new ManagedSkillRepositoryError({
            code: "revision_conflict",
            detail: `Managed skill '${current.manifest.key}' changed while its replacement was staged.`,
          });
        }
      },
    );

    const revisionPath = Effect.fn("ManagedSkillRepository.revisionPath")(function* (
      skillId: ManagedSkillId,
      revision: number,
      createHistoryRoot = false,
    ) {
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        return yield* invalidPackage(`History revision '${revision}' is invalid.`);
      }
      const idRoot = createHistoryRoot
        ? yield* ensureHistoryIdRoot(skillId)
        : yield* existingHistoryIdRoot(skillId);
      if (idRoot === undefined)
        return yield* invalidPackage(`History for '${skillId}' does not exist.`);
      return yield* directChild(idRoot, String(revision));
    });

    const inspectOwnedHistory = Effect.fn("ManagedSkillRepository.inspectOwnedHistory")(function* (
      skillId: ManagedSkillId,
      revision: number,
      packageRoot: string,
    ) {
      const inspection = yield* inspectPackage({
        packagePath: packageRoot,
        expectedScope: "global",
      });
      if (
        inspection.validity !== "valid" ||
        inspection.manifest === undefined ||
        inspection.content === undefined ||
        inspection.manifest.id !== skillId ||
        inspection.manifest.revision.revision !== revision ||
        inspection.manifest.ownership !== "t3" ||
        inspection.manifest.scope !== "global"
      ) {
        return yield* invalidPackage(
          `History snapshot '${packageRoot}' is not owned by this skill.`,
        );
      }
      return {
        packagePath: packageRoot,
        directoryName: inspection.manifest.key,
        ...inspection,
      } as SkillPackageEntry;
    });

    const pruneHistory = Effect.fn("ManagedSkillRepository.pruneHistory")(function* (
      skillId: ManagedSkillId,
    ) {
      const root = yield* existingHistoryIdRoot(skillId);
      if (root === undefined) return;
      const candidates = (yield* fs.readDirectory(root))
        .flatMap((name) => {
          const revision = canonicalHistoryRevision(name);
          return revision === undefined ? [] : [{ name, revision }];
        })
        .sort((left, right) => left.revision - right.revision);
      const revisions: Array<{
        readonly name: string;
        readonly revision: number;
        readonly packagePath: string;
      }> = [];
      for (const candidate of candidates) {
        const candidatePath = yield* directChild(root, candidate.name);
        const inspected = yield* validateExistingRealDirectory(
          candidatePath,
          "History revision",
        ).pipe(
          Effect.flatMap(({ path: exactPath }) =>
            inspectOwnedHistory(skillId, candidate.revision, exactPath),
          ),
          Effect.result,
        );
        if (Result.isSuccess(inspected)) {
          revisions.push({ ...candidate, packagePath: inspected.success.packagePath });
        }
      }
      for (const entry of revisions.slice(0, Math.max(0, revisions.length - HISTORY_LIMIT))) {
        const exactPath = yield* directChild(root, entry.name);
        if (exactPath !== entry.packagePath) continue;
        const validated = yield* validateExistingRealDirectory(exactPath, "History revision").pipe(
          Effect.result,
        );
        if (Result.isFailure(validated)) continue;
        const owned = yield* inspectOwnedHistory(
          skillId,
          entry.revision,
          validated.success.path,
        ).pipe(Effect.result);
        if (Result.isFailure(owned)) continue;
        yield* (
          options.pruneHistoryRevision?.(exactPath, (target) =>
            fs.remove(target, { recursive: true, force: true }),
          ) ?? fs.remove(exactPath, { recursive: true, force: true })
        );
      }
    });

    const commitReplacement = Effect.fn("ManagedSkillRepository.commitReplacement")(
      function* (input: {
        readonly target: string;
        readonly stage: string;
        readonly current?: ProjectSkillPackage;
        readonly archiveGlobal?: boolean;
      }) {
        const rollback = temporaryPath(
          path.dirname(input.target),
          input.current?.manifest.key ?? path.basename(input.target),
          "rollback",
        );
        let remainder = rollback;
        return yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            if (input.current !== undefined) {
              const moved = yield* fs.rename(input.current.packagePath, rollback).pipe(Effect.exit);
              if (Exit.isFailure(moved)) return yield* Effect.failCause(moved.cause);
            }
            const committed = yield* finalRename(input.stage, input.target, rename).pipe(
              Effect.exit,
            );
            if (Exit.isFailure(committed)) {
              if (input.current !== undefined) {
                const restored = yield* fs
                  .rename(rollback, input.current.packagePath)
                  .pipe(Effect.exit);
                if (Exit.isFailure(restored)) {
                  return yield* repositoryError(
                    `Could not commit '${input.target}' or restore '${rollback}'.`,
                    {
                      commit: Cause.squash(committed.cause),
                      restore: Cause.squash(restored.cause),
                    },
                  );
                }
              }
              if (Cause.hasDies(committed.cause)) return yield* Effect.failCause(committed.cause);
              return yield* repositoryError(
                `Could not commit managed skill package '${input.target}'.`,
                Cause.squash(committed.cause),
              );
            }
            if (input.current === undefined) return;
            const cleanup = yield* (
              input.archiveGlobal
                ? Effect.gen(function* () {
                    const destination = yield* revisionPath(
                      input.current!.manifest.id,
                      input.current!.manifest.revision.revision,
                      true,
                    );
                    if ((yield* lstatOptional(destination)) !== undefined) {
                      return yield* invalidPackage(
                        `History revision '${input.current!.manifest.revision.revision}' already exists.`,
                      );
                    }
                    yield* archiveRename(rollback, destination, rename);
                    remainder = destination;
                    yield* pruneHistory(input.current!.manifest.id);
                  })
                : (options.removeRollback?.(rollback, (target) =>
                    fs.remove(target, { recursive: true, force: true }),
                  ) ?? fs.remove(rollback, { recursive: true, force: true }))
            ).pipe(Effect.exit);
            if (Exit.isFailure(cleanup)) {
              if (Cause.hasDies(cleanup.cause)) return yield* Effect.failCause(cleanup.cause);
              return yield* repositoryError(
                `Committed current package; cleanup failed for '${remainder}'.`,
                Cause.squash(cleanup.cause),
              );
            }
          }),
        );
      },
    );

    const stageCleanupOnFailure = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? fs.remove(stage, { recursive: true, force: true }).pipe(Effect.orDie)
            : Effect.void,
        ),
      );

    const listGlobal = Effect.fn("ManagedSkillRepository.listGlobal")(function* () {
      const root = yield* existingGlobalRoot("skills");
      if (root === undefined) return [];
      return yield* listRoot(root, "global");
    });
    const readGlobal = Effect.fn("ManagedSkillRepository.readGlobal")(function* (
      skillId: ManagedSkillId,
      operationTag?: string,
    ) {
      const root = yield* ensureGlobalRoot("skills", false);
      const found = yield* findById(root, skillId, operationTag);
      if (found.projectState === "disabled")
        return yield* invalidPackage("Global skills cannot be disabled tombstones.");
      return found;
    });

    const createGlobal = Effect.fn("ManagedSkillRepository.createGlobal")(function* (
      input: GlobalCreateInput,
    ) {
      const root = yield* ensureGlobalRoot("skills", true);
      return yield* withMutationRoot(
        "global-create",
        root,
        Effect.gen(function* () {
          const lockedRoot = yield* ensureGlobalRoot("skills", true);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          const target = yield* directChild(root, input.content.key);
          yield* options.onMutationLookup?.("global-create", target, "exists") ?? Effect.void;
          const targetExists = yield* fs.exists(target);
          if (input.expectedRevision !== 0 || targetExists) {
            return yield* new ManagedSkillRepositoryError({
              code: targetExists ? "destination_collision" : "revision_conflict",
              detail: `Cannot create managed skill '${input.content.key}'.`,
            });
          }
          const staged = yield* stagePackage({
            root,
            key: input.content.key,
            id: NodeCrypto.randomUUID() as ManagedSkillId,
            scope: "global",
            revision: 1,
            content: input.content,
            operationTag: "global-create",
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              yield* ensureGlobalRoot("skills", false);
              if (yield* fs.exists(target)) {
                return yield* new ManagedSkillRepositoryError({
                  code: "revision_conflict",
                  detail: `Managed skill '${input.content.key}' appeared while it was staged.`,
                });
              }
              yield* commitReplacement({ target, stage: staged.stage });
              return { ...staged.staged, packagePath: target } as OwnedSkillPackage;
            }),
          );
        }),
      );
    });

    const importGlobal = Effect.fn("ManagedSkillRepository.importGlobal")(function* (
      input: GlobalImportInput,
    ) {
      const root = yield* ensureGlobalRoot("skills", true);
      return yield* withMutationRoot(
        "global-import",
        root,
        Effect.gen(function* () {
          const lockedRoot = yield* ensureGlobalRoot("skills", true);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          const target = yield* directChild(root, input.content.key);
          if (input.expectedRevision !== 0 || (yield* fs.exists(target))) {
            return yield* new ManagedSkillRepositoryError({
              code: "destination_collision",
              detail: `Cannot import managed skill '${input.content.key}'.`,
            });
          }
          const staged = yield* stagePackage({
            root,
            key: input.content.key,
            id: NodeCrypto.randomUUID() as ManagedSkillId,
            scope: "global",
            revision: 1,
            origin: "imported",
            content: input.content,
            seedFiles: input.files,
            operationTag: "global-import",
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              if (yield* fs.exists(target)) {
                return yield* new ManagedSkillRepositoryError({
                  code: "revision_conflict",
                  detail: `Managed skill '${input.content.key}' appeared while it was staged.`,
                });
              }
              yield* commitReplacement({ target, stage: staged.stage });
              return { ...staged.staged, packagePath: target } as OwnedSkillPackage;
            }),
          );
        }),
      );
    });

    const updateGlobal = Effect.fn("ManagedSkillRepository.updateGlobal")(function* (
      input: GlobalReplaceInput,
    ) {
      const root = yield* ensureGlobalRoot("skills", false);
      const operationTag = input.operationTag ?? "global-update";
      return yield* withMutationRoot(
        operationTag,
        root,
        Effect.gen(function* () {
          const lockedRoot = yield* ensureGlobalRoot("skills", false);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          yield* ensureGlobalRoot("skill-history", true);
          const current = yield* readGlobal(input.skillId, operationTag);
          yield* checkExpectedHash(current, input.expectedHash);
          yield* ensureHistoryIdRoot(current.manifest.id);
          const archiveDestination = yield* revisionPath(
            current.manifest.id,
            current.manifest.revision.revision,
            true,
          );
          if ((yield* lstatOptional(archiveDestination)) !== undefined) {
            return yield* invalidPackage(
              `History revision '${current.manifest.revision.revision}' already exists.`,
            );
          }
          const content: ManagedSkillContent = {
            key: current.manifest.key,
            ...input.content,
            ...(input.content.frontmatter === undefined && current.content.frontmatter !== undefined
              ? { frontmatter: current.content.frontmatter }
              : {}),
          };
          const staged = yield* stagePackage({
            root,
            key: current.manifest.key,
            id: current.manifest.id,
            scope: "global",
            revision: current.manifest.revision.revision + 1,
            origin: current.manifest.origin,
            content,
            copyFrom: current.packagePath,
            operationTag,
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              yield* ensureGlobalRoot("skills", false);
              const latest = yield* readGlobal(input.skillId);
              yield* checkCurrentSnapshot(current, latest, input.expectedHash);
              const latestArchiveDestination = yield* revisionPath(
                latest.manifest.id,
                latest.manifest.revision.revision,
                true,
              );
              if (
                latestArchiveDestination !== archiveDestination ||
                (yield* lstatOptional(latestArchiveDestination)) !== undefined
              ) {
                return yield* invalidPackage(
                  "History destination changed while the package was staged.",
                );
              }
              yield* commitReplacement({
                target: latest.packagePath,
                stage: staged.stage,
                current: latest,
                archiveGlobal: true,
              });
              return { ...staged.staged, packagePath: latest.packagePath } as OwnedSkillPackage;
            }),
          );
        }),
      );
    });

    const deleteGlobal = Effect.fn("ManagedSkillRepository.deleteGlobal")(function* (input: {
      readonly skillId: ManagedSkillId;
      readonly expectedHash: SkillContentHash;
    }) {
      const root = yield* ensureGlobalRoot("skills", false);
      return yield* withMutationRoot(
        "global-delete",
        root,
        Effect.gen(function* () {
          const lockedRoot = yield* ensureGlobalRoot("skills", false);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          yield* ensureGlobalRoot("skill-history", true);
          const current = yield* readGlobal(input.skillId, "global-delete");
          yield* checkExpectedHash(current, input.expectedHash);
          yield* ensureHistoryIdRoot(current.manifest.id);
          const destination = yield* revisionPath(
            current.manifest.id,
            current.manifest.revision.revision,
            true,
          );
          if ((yield* lstatOptional(destination)) !== undefined) {
            return yield* invalidPackage(
              `History revision '${current.manifest.revision.revision}' already exists.`,
            );
          }
          yield* ensureGlobalRoot("skills", false);
          return yield* Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              const committed = yield* fs
                .rename(current.packagePath, destination)
                .pipe(Effect.exit);
              if (Exit.isFailure(committed)) return yield* Effect.failCause(committed.cause);
              const pruned = yield* pruneHistory(current.manifest.id).pipe(Effect.exit);
              if (Exit.isFailure(pruned)) {
                if (Cause.hasDies(pruned.cause)) return yield* Effect.failCause(pruned.cause);
                return yield* repositoryError(
                  `Committed delete; cleanup failed for '${destination}'.`,
                  Cause.squash(pruned.cause),
                );
              }
            }),
          );
        }),
      );
    });

    const renameGlobal = Effect.fn("ManagedSkillRepository.renameGlobal")(function* (input: {
      readonly skillId: ManagedSkillId;
      readonly expectedHash: SkillContentHash;
      readonly key: ManagedSkillKey;
      readonly operationTag?: string;
    }) {
      const root = yield* ensureGlobalRoot("skills", false);
      return yield* withMutationRoot(
        input.operationTag ?? "global-rename",
        root,
        Effect.gen(function* () {
          const operationTag = input.operationTag ?? "global-rename";
          const lockedRoot = yield* ensureGlobalRoot("skills", false);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          yield* ensureGlobalRoot("skill-history", true);
          const current = yield* readGlobal(input.skillId, operationTag);
          yield* checkExpectedHash(current, input.expectedHash);
          yield* ensureHistoryIdRoot(current.manifest.id);
          const archiveDestination = yield* revisionPath(
            current.manifest.id,
            current.manifest.revision.revision,
            true,
          );
          if ((yield* lstatOptional(archiveDestination)) !== undefined) {
            return yield* invalidPackage(
              `History revision '${current.manifest.revision.revision}' already exists.`,
            );
          }
          const target = yield* directChild(root, input.key);
          if (yield* fs.exists(target)) {
            return yield* new ManagedSkillRepositoryError({
              code: "destination_collision",
              detail: `Managed skill '${input.key}' already exists.`,
            });
          }
          const staged = yield* stagePackage({
            root,
            key: input.key,
            id: current.manifest.id,
            scope: "global",
            revision: current.manifest.revision.revision + 1,
            origin: current.manifest.origin,
            content: { ...current.content, key: input.key },
            copyFrom: current.packagePath,
            operationTag: input.operationTag ?? "global-rename",
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              yield* ensureGlobalRoot("skills", false);
              const latest = yield* readGlobal(input.skillId);
              yield* checkCurrentSnapshot(current, latest, input.expectedHash);
              const latestArchiveDestination = yield* revisionPath(
                latest.manifest.id,
                latest.manifest.revision.revision,
                true,
              );
              if (
                latestArchiveDestination !== archiveDestination ||
                (yield* lstatOptional(latestArchiveDestination)) !== undefined
              ) {
                return yield* invalidPackage(
                  "History destination changed while the package was staged.",
                );
              }
              if (yield* fs.exists(target)) {
                return yield* new ManagedSkillRepositoryError({
                  code: "destination_collision",
                  detail: `Managed skill '${input.key}' already exists.`,
                });
              }
              yield* commitReplacement({
                target,
                stage: staged.stage,
                current: latest,
                archiveGlobal: true,
              });
              return { ...staged.staged, packagePath: target } as OwnedSkillPackage;
            }),
          );
        }),
      );
    });

    const listGlobalHistory = Effect.fn("ManagedSkillRepository.listGlobalHistory")(function* (
      skillId: ManagedSkillId,
    ) {
      const root = yield* existingHistoryIdRoot(skillId);
      if (root === undefined) return [];
      const owned: Array<{ readonly revision: number; readonly packagePath: string }> = [];
      for (const name of yield* fs.readDirectory(root)) {
        const revision = canonicalHistoryRevision(name);
        if (revision === undefined) continue;
        const exactPath = yield* directChild(root, name);
        const inspection = yield* validateExistingRealDirectory(exactPath, "History revision").pipe(
          Effect.flatMap(({ path: packagePath }) =>
            inspectOwnedHistory(skillId, revision, packagePath),
          ),
          Effect.result,
        );
        const packagePath = Result.isSuccess(inspection)
          ? inspection.success.packagePath
          : undefined;
        if (packagePath !== undefined) owned.push({ revision, packagePath });
      }
      return owned.sort((left, right) => left.revision - right.revision);
    });

    const rollbackGlobal = Effect.fn("ManagedSkillRepository.rollbackGlobal")(function* (input: {
      readonly skillId: ManagedSkillId;
      readonly expectedHash: SkillContentHash;
      readonly revision: number;
      readonly operationTag?: string;
    }) {
      const root = yield* ensureGlobalRoot("skills", false);
      return yield* withMutationRoot(
        input.operationTag ?? "global-rollback",
        root,
        Effect.gen(function* () {
          const operationTag = input.operationTag ?? "global-rollback";
          const lockedRoot = yield* ensureGlobalRoot("skills", false);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Managed skill root changed while waiting for mutation permit.",
            );
          yield* ensureGlobalRoot("skill-history", true);
          yield* existingHistoryIdRoot(input.skillId);
          const current = yield* readGlobal(input.skillId, operationTag);
          yield* checkExpectedHash(current, input.expectedHash);
          const archiveDestination = yield* revisionPath(
            current.manifest.id,
            current.manifest.revision.revision,
            true,
          );
          if ((yield* lstatOptional(archiveDestination)) !== undefined) {
            return yield* invalidPackage(
              `History revision '${current.manifest.revision.revision}' already exists.`,
            );
          }
          const historyIdRoot = yield* existingHistoryIdRoot(input.skillId);
          if (historyIdRoot === undefined) {
            return yield* new ManagedSkillRepositoryError({
              code: "not_found",
              detail: `Managed skill revision '${input.revision}' was not found.`,
            });
          }
          const snapshotPath = yield* existingHistoryRevision(historyIdRoot, input.revision);
          if (snapshotPath === undefined)
            return yield* new ManagedSkillRepositoryError({
              code: "not_found",
              detail: `Managed skill revision '${input.revision}' was not found.`,
            });
          const snapshotEntry = yield* inspectOwnedHistory(
            input.skillId,
            input.revision,
            snapshotPath,
          );
          const snapshot = yield* requireOwned(snapshotEntry);
          if (snapshot.projectState === "disabled") {
            return yield* invalidPackage("Global history contains a project tombstone.");
          }
          const staged = yield* stagePackage({
            root,
            key: current.manifest.key,
            id: current.manifest.id,
            scope: "global",
            revision: current.manifest.revision.revision + 1,
            origin: current.manifest.origin,
            content: { ...snapshot.content, key: current.manifest.key },
            copyFrom: snapshotPath,
            copySnapshot: {
              id: snapshot.manifest.id,
              key: snapshot.manifest.key,
              revision: snapshot.manifest.revision.revision,
              hash: snapshot.manifest.revision.hash,
            },
            operationTag: input.operationTag ?? "global-rollback",
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              yield* ensureGlobalRoot("skills", false);
              const latest = yield* readGlobal(input.skillId);
              yield* checkCurrentSnapshot(current, latest, input.expectedHash);
              const latestArchiveDestination = yield* revisionPath(
                latest.manifest.id,
                latest.manifest.revision.revision,
                true,
              );
              if (
                latestArchiveDestination !== archiveDestination ||
                (yield* lstatOptional(latestArchiveDestination)) !== undefined
              ) {
                return yield* invalidPackage(
                  "History destination changed while the package was staged.",
                );
              }
              const latestSnapshot = yield* inspectOwnedHistory(
                input.skillId,
                input.revision,
                snapshotPath,
              );
              if (
                latestSnapshot.hash !== snapshotEntry.hash ||
                latestSnapshot.manifest?.key !== snapshotEntry.manifest?.key
              ) {
                return yield* invalidPackage("History snapshot changed while rollback was staged.");
              }
              yield* commitReplacement({
                target: latest.packagePath,
                stage: staged.stage,
                current: latest,
                archiveGlobal: true,
              });
              return { ...staged.staged, packagePath: latest.packagePath } as OwnedSkillPackage;
            }),
          );
        }),
      );
    });

    const listProject = Effect.fn("ManagedSkillRepository.listProject")(function* (
      projectRoot: string,
    ) {
      const root = yield* existingProjectRoot(projectRoot);
      if (root === undefined) return [];
      return yield* listRoot(root, "project");
    });
    const readProject = Effect.fn("ManagedSkillRepository.readProject")(function* (
      projectRoot: string,
      skillId: ManagedSkillId,
    ) {
      const root = yield* existingProjectRoot(projectRoot);
      if (root === undefined) {
        return yield* new ManagedSkillRepositoryError({
          code: "not_found",
          detail: `Managed skill '${skillId}' was not found.`,
        });
      }
      return yield* findById(root, skillId);
    });

    const currentAtKey = Effect.fn("ManagedSkillRepository.currentAtKey")(function* (
      root: string,
      key: ManagedSkillKey,
      operationTag?: string,
    ) {
      const entry = (yield* listRoot(root, "project", operationTag)).find(
        (candidate) => candidate.directoryName === key,
      );
      return entry === undefined ? undefined : yield* requireOwned(entry);
    });

    const globalAtKey = Effect.fn("ManagedSkillRepository.globalAtKey")(function* (
      key: ManagedSkillKey,
    ): Effect.fn.Return<OwnedSkillPackage | undefined, RepositoryFailure> {
      const root = yield* existingGlobalRoot("skills");
      if (root === undefined) return undefined;
      const entry = (yield* listRoot(root, "global")).find(
        (candidate) => candidate.manifest?.key === key,
      );
      if (entry === undefined) return undefined;
      const packageValue = yield* requireOwned(entry);
      return packageValue.projectState === undefined ? packageValue : undefined;
    });

    const setProjectOverride = Effect.fn("ManagedSkillRepository.setProjectOverride")(
      function* (input: {
        readonly projectRoot: string;
        readonly key: ManagedSkillKey;
        readonly expectedHash?: SkillContentHash;
        readonly content: ManagedSkillContentDraft;
        readonly operationTag?: string;
      }) {
        const root = yield* ensureProjectRoot(input.projectRoot, true);
        return yield* withMutationRoot(
          input.operationTag ?? "project-override",
          root,
          Effect.gen(function* () {
            const operationTag = input.operationTag ?? "project-override";
            const lockedRoot = yield* ensureProjectRoot(input.projectRoot, true);
            if (lockedRoot !== root)
              return yield* invalidPackage(
                "Project skill root changed while waiting for mutation permit.",
              );
            const current = yield* currentAtKey(root, input.key, operationTag);
            yield* checkExpectedProjectState(input.key, current, input.expectedHash);
            const inherited =
              current === undefined || current.projectState === "disabled"
                ? yield* globalAtKey(input.key)
                : undefined;
            const seed = current?.content === undefined ? inherited : current;
            const content: ManagedSkillContent = {
              key: input.key,
              ...input.content,
              ...(input.content.assetPaths === undefined && seed?.content.assetPaths !== undefined
                ? { assetPaths: seed.content.assetPaths }
                : {}),
              ...(input.content.frontmatter === undefined && seed?.content.frontmatter !== undefined
                ? { frontmatter: seed.content.frontmatter }
                : {}),
            };
            const staged = yield* stagePackage({
              root,
              key: input.key,
              id: current?.manifest.id ?? (NodeCrypto.randomUUID() as ManagedSkillId),
              scope: "project",
              revision: (current?.manifest.revision.revision ?? 0) + 1,
              content,
              projectState: "override",
              ...(seed === undefined ? {} : { copyFrom: seed.packagePath }),
              ...(seed === undefined ? {} : { copyFromScope: seed.manifest.scope }),
              operationTag: input.operationTag ?? "project-override",
            });
            return yield* stageCleanupOnFailure(
              staged.stage,
              Effect.gen(function* () {
                yield* ensureProjectRoot(input.projectRoot, false);
                const latest = yield* currentAtKey(root, input.key);
                if (current === undefined && latest !== undefined) {
                  return yield* new ManagedSkillRepositoryError({
                    code: "revision_conflict",
                    detail: `Project skill '${input.key}' appeared while it was staged.`,
                  });
                }
                if (current !== undefined) {
                  if (latest === undefined)
                    return yield* new ManagedSkillRepositoryError({
                      code: "revision_conflict",
                      detail: `Project skill '${input.key}' disappeared while it was staged.`,
                    });
                  yield* checkCurrentSnapshot(current, latest, input.expectedHash);
                }
                const target = yield* directChild(root, input.key);
                yield* commitReplacement({
                  target,
                  stage: staged.stage,
                  ...(latest === undefined ? {} : { current: latest }),
                });
                return { ...staged.staged, packagePath: target } as OwnedSkillPackage;
              }),
            );
          }),
        );
      },
    );

    const setProjectDisabled = Effect.fn("ManagedSkillRepository.setProjectDisabled")(
      function* (input: {
        readonly projectRoot: string;
        readonly key: ManagedSkillKey;
        readonly expectedHash?: SkillContentHash;
        readonly operationTag?: string;
      }) {
        const root = yield* ensureProjectRoot(input.projectRoot, true);
        return yield* withMutationRoot(
          input.operationTag ?? "project-disable",
          root,
          Effect.gen(function* () {
            const operationTag = input.operationTag ?? "project-disable";
            const lockedRoot = yield* ensureProjectRoot(input.projectRoot, true);
            if (lockedRoot !== root)
              return yield* invalidPackage(
                "Project skill root changed while waiting for mutation permit.",
              );
            const current = yield* currentAtKey(root, input.key, operationTag);
            yield* checkExpectedProjectState(input.key, current, input.expectedHash);
            const staged = yield* stagePackage({
              root,
              key: input.key,
              id: current?.manifest.id ?? (NodeCrypto.randomUUID() as ManagedSkillId),
              scope: "project",
              revision: (current?.manifest.revision.revision ?? 0) + 1,
              projectState: "disabled",
              operationTag: input.operationTag ?? "project-disable",
            });
            return yield* stageCleanupOnFailure(
              staged.stage,
              Effect.gen(function* () {
                yield* ensureProjectRoot(input.projectRoot, false);
                const latest = yield* currentAtKey(root, input.key);
                if (current === undefined && latest !== undefined) {
                  return yield* new ManagedSkillRepositoryError({
                    code: "revision_conflict",
                    detail: `Project skill '${input.key}' appeared while it was staged.`,
                  });
                }
                if (current !== undefined) {
                  if (latest === undefined)
                    return yield* new ManagedSkillRepositoryError({
                      code: "revision_conflict",
                      detail: `Project skill '${input.key}' disappeared while it was staged.`,
                    });
                  yield* checkCurrentSnapshot(current, latest, input.expectedHash);
                }
                const target = yield* directChild(root, input.key);
                yield* commitReplacement({
                  target,
                  stage: staged.stage,
                  ...(latest === undefined ? {} : { current: latest }),
                });
                return { ...staged.staged, packagePath: target } as DisabledProjectSkillPackage;
              }),
            );
          }),
        );
      },
    );

    const deleteProjectState = Effect.fn("ManagedSkillRepository.deleteProjectState")(
      function* (input: {
        readonly projectRoot: string;
        readonly key: ManagedSkillKey;
        readonly expectedHash: SkillContentHash;
      }) {
        const root = yield* ensureProjectRoot(input.projectRoot, false);
        return yield* withMutationRoot(
          "project-delete",
          root,
          Effect.gen(function* () {
            const lockedRoot = yield* ensureProjectRoot(input.projectRoot, false);
            if (lockedRoot !== root)
              return yield* invalidPackage(
                "Project skill root changed while waiting for mutation permit.",
              );
            const current = yield* currentAtKey(root, input.key, "project-delete");
            if (current === undefined) {
              return yield* new ManagedSkillRepositoryError({
                code: "not_found",
                detail: `Project skill '${input.key}' was not found.`,
              });
            }
            yield* checkExpectedHash(current, input.expectedHash);
            yield* ensureProjectRoot(input.projectRoot, false);
            const rollback = temporaryPath(root, current.manifest.key, "rollback");
            return yield* Effect.uninterruptibleMask(() =>
              Effect.gen(function* () {
                const committed = yield* fs.rename(current.packagePath, rollback).pipe(Effect.exit);
                if (Exit.isFailure(committed)) return yield* Effect.failCause(committed.cause);
                const removed = yield* fs.remove(rollback, { recursive: true }).pipe(Effect.exit);
                if (Exit.isFailure(removed)) {
                  if (Cause.hasDies(removed.cause)) return yield* Effect.failCause(removed.cause);
                  return yield* repositoryError(
                    `Committed project delete; cleanup failed for '${rollback}'.`,
                    Cause.squash(removed.cause),
                  );
                }
              }),
            );
          }),
        );
      },
    );

    const renameProject = Effect.fn("ManagedSkillRepository.renameProject")(function* (input: {
      readonly projectRoot: string;
      readonly skillId: ManagedSkillId;
      readonly expectedHash: SkillContentHash;
      readonly key: ManagedSkillKey;
      readonly operationTag?: string;
    }) {
      const root = yield* ensureProjectRoot(input.projectRoot, false);
      return yield* withMutationRoot(
        input.operationTag ?? "project-rename",
        root,
        Effect.gen(function* () {
          const operationTag = input.operationTag ?? "project-rename";
          const lockedRoot = yield* ensureProjectRoot(input.projectRoot, false);
          if (lockedRoot !== root)
            return yield* invalidPackage(
              "Project skill root changed while waiting for mutation permit.",
            );
          const current = yield* findById(root, input.skillId, operationTag);
          yield* checkExpectedHash(current, input.expectedHash);
          const target = yield* directChild(root, input.key);
          if (yield* fs.exists(target)) {
            return yield* new ManagedSkillRepositoryError({
              code: "destination_collision",
              detail: `Project skill '${input.key}' already exists.`,
            });
          }
          const staged = yield* stagePackage({
            root,
            key: input.key,
            id: current.manifest.id,
            scope: "project",
            revision: current.manifest.revision.revision + 1,
            ...(current.projectState === "disabled"
              ? { projectState: "disabled" as const }
              : {
                  content: { ...current.content, key: input.key },
                  projectState: "override" as const,
                  copyFrom: current.packagePath,
                }),
            operationTag: input.operationTag ?? "project-rename",
          });
          return yield* stageCleanupOnFailure(
            staged.stage,
            Effect.gen(function* () {
              yield* ensureProjectRoot(input.projectRoot, false);
              const latest = yield* findById(root, input.skillId);
              yield* checkCurrentSnapshot(current, latest, input.expectedHash);
              if (yield* fs.exists(target)) {
                return yield* new ManagedSkillRepositoryError({
                  code: "destination_collision",
                  detail: `Project skill '${input.key}' already exists.`,
                });
              }
              yield* commitReplacement({ target, stage: staged.stage, current: latest });
              return { ...staged.staged, packagePath: target };
            }),
          );
        }),
      );
    });

    const invalidateGlobal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tap(() => PubSub.publish(invalidations, { scope: "global" }).pipe(Effect.asVoid)),
      );
    const invalidateProject = <A, E, R>(projectRoot: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tap(() =>
          PubSub.publish(invalidations, { scope: "project", projectRoot }).pipe(Effect.asVoid),
        ),
      );

    return ManagedSkillRepository.of({
      subscribeInvalidations: PubSub.subscribe(invalidations),
      listGlobal,
      readGlobal,
      createGlobal: (input) => invalidateGlobal(createGlobal(input)),
      importGlobal: (input) => invalidateGlobal(importGlobal(input)),
      updateGlobal: (input) => invalidateGlobal(updateGlobal(input)),
      deleteGlobal: (input) => invalidateGlobal(deleteGlobal(input)),
      renameGlobal: (input) => invalidateGlobal(renameGlobal(input)),
      rollbackGlobal: (input) => invalidateGlobal(rollbackGlobal(input)),
      listGlobalHistory,
      listProject,
      readProject,
      setProjectOverride: (input) =>
        invalidateProject(input.projectRoot, setProjectOverride(input)),
      setProjectDisabled: (input) =>
        invalidateProject(input.projectRoot, setProjectDisabled(input)),
      deleteProjectState: (input) =>
        invalidateProject(input.projectRoot, deleteProjectState(input)),
      renameProject: (input) => invalidateProject(input.projectRoot, renameProject(input)),
    });
  });

export const make = makeWith();
export const layer = Layer.effect(ManagedSkillRepository, make);
