// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { NonNegativeInt, type ManagedSkillKey, type ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { inspectSkillPackage } from "./SkillPackage.ts";

const OWNERSHIP_MARKER = ".t3-owned.json";
const safeIdentity = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const portableKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const OwnershipMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  providerInstanceId: Schema.String,
  desiredRevision: NonNegativeInt,
});
type OwnershipMarker = typeof OwnershipMarker.Type;
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(OwnershipMarker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(OwnershipMarker));

export class SkillMaterializationError extends Schema.TaggedError<SkillMaterializationError>()(
  "SkillMaterializationError",
  {
    code: Schema.Literals([
      "unsafe_identity",
      "invalid_source",
      "materialization_failed",
      "ownership_mismatch",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isSkillMaterializationError = Schema.is(SkillMaterializationError);

export interface SkillMaterializationInput {
  readonly sessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly desiredRevision: number;
  readonly packages: ReadonlyArray<{
    readonly key: ManagedSkillKey;
    readonly sourcePath: string;
  }>;
}

export interface SkillMaterializationResult {
  readonly root: string;
  readonly skillPaths: ReadonlyMap<ManagedSkillKey, string>;
}

export interface SkillMaterializationServiceShape {
  readonly materialize: (
    input: SkillMaterializationInput,
  ) => Effect.Effect<SkillMaterializationResult, SkillMaterializationError>;
  readonly dispose: (
    input: Omit<SkillMaterializationInput, "packages">,
  ) => Effect.Effect<void, SkillMaterializationError>;
  readonly disposeSession: (
    input: Pick<SkillMaterializationInput, "sessionId" | "providerInstanceId">,
  ) => Effect.Effect<void, SkillMaterializationError>;
}

export class SkillMaterializationService extends Context.Service<
  SkillMaterializationService,
  SkillMaterializationServiceShape
>()("t3/skills/SkillMaterializationService") {}

const failure = (code: SkillMaterializationError["code"], detail: string, cause?: unknown) =>
  new SkillMaterializationError({ code, detail, ...(cause === undefined ? {} : { cause }) });

type RuntimeIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};
type RuntimeDirectory = {
  readonly path: string;
  readonly identity: RuntimeIdentity;
};

const identityOf = (info: { readonly dev: bigint; readonly ino: bigint }): RuntimeIdentity => ({
  dev: info.dev,
  ino: info.ino,
});

const sameIdentity = (left: RuntimeIdentity, right: RuntimeIdentity) =>
  left.dev === right.dev && left.ino === right.ino;

const assertSafeInput = (input: Omit<SkillMaterializationInput, "packages">) => {
  if (
    !safeIdentity.test(input.sessionId) ||
    !safeIdentity.test(input.providerInstanceId) ||
    !Number.isSafeInteger(input.desiredRevision) ||
    input.desiredRevision < 0
  ) {
    return Effect.fail(failure("unsafe_identity", "Runtime identity is not a safe path segment."));
  }
  return Effect.void;
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const lstat = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.lstat(target, { bigint: true });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw cause;
        }
      },
      catch: (cause) =>
        failure("materialization_failed", `Could not inspect runtime path '${target}'.`, cause),
    });

  const realPath = (target: string) =>
    fs
      .realPath(target)
      .pipe(
        Effect.mapError((cause) =>
          failure("materialization_failed", `Could not resolve runtime path '${target}'.`, cause),
        ),
      );

  const contains = (root: string, candidate: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const inspectDirectory = Effect.fn("SkillMaterializationService.inspectDirectory")(function* (
    runtimeRoot: string,
    target: string,
    label: string,
  ) {
    const resolvedTarget = path.resolve(target);
    const info = yield* lstat(resolvedTarget);
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
      return yield* failure(
        "ownership_mismatch",
        `${label} '${resolvedTarget}' is not a real runtime directory.`,
      );
    }
    const resolvedRealPath = path.resolve(yield* realPath(resolvedTarget));
    if (resolvedRealPath !== resolvedTarget || !contains(runtimeRoot, resolvedRealPath)) {
      return yield* failure(
        "ownership_mismatch",
        `${label} '${resolvedTarget}' is redirected outside the runtime root.`,
      );
    }
    // Canonicalization is an untrusted filesystem operation. Re-stat after it
    // so a pathname replacement during realpath cannot be adopted as the
    // directory we just inspected.
    const current = yield* lstat(resolvedTarget);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(identityOf(info), identityOf(current))
    ) {
      return yield* failure(
        "ownership_mismatch",
        `${label} '${resolvedTarget}' changed while it was inspected.`,
      );
    }
    return { path: resolvedTarget, identity: identityOf(current) } satisfies RuntimeDirectory;
  });

  const resolveRuntimeRoot = Effect.fn("SkillMaterializationService.resolveRuntimeRoot")(
    function* () {
      const configured = path.resolve(config.skillRuntimeDir);
      return yield* inspectDirectory(configured, configured, "Configured runtime root");
    },
  );

  const assertDirectoryIdentity = Effect.fn("SkillMaterializationService.assertDirectoryIdentity")(
    function* (runtimeRoot: string, directory: RuntimeDirectory, label: string) {
      const current = yield* inspectDirectory(runtimeRoot, directory.path, label);
      if (!sameIdentity(current.identity, directory.identity)) {
        return yield* failure(
          "ownership_mismatch",
          `${label} '${directory.path}' changed during materialization.`,
        );
      }
      return current;
    },
  );

  const ensureDirectoryComponent = Effect.fn(
    "SkillMaterializationService.ensureDirectoryComponent",
  )(function* (runtimeRoot: string, parent: string, component: string, create: boolean) {
    const resolvedParent = yield* inspectDirectory(runtimeRoot, parent, "Runtime parent");
    const target = path.join(resolvedParent.path, component);
    let info = yield* lstat(target);
    if (info === undefined && create) {
      const created = yield* fs.makeDirectory(target, { recursive: false }).pipe(Effect.exit);
      if (Exit.isFailure(created)) {
        info = yield* lstat(target);
        if (info === undefined) {
          return yield* failure(
            "materialization_failed",
            `Could not create runtime directory '${target}'.`,
            created.cause,
          );
        }
      } else {
        info = yield* lstat(target);
      }
    }
    if (info === undefined) return undefined;
    return yield* inspectDirectory(runtimeRoot, target, "Runtime directory");
  });

  const readMarker = (root: string, runtimeRoot: string) =>
    Effect.gen(function* () {
      const markerPath = path.join(root, OWNERSHIP_MARKER);
      const info = yield* lstat(markerPath);
      if (info === undefined || info.isSymbolicLink() || !info.isFile()) {
        return yield* failure("ownership_mismatch", "Runtime ownership marker is missing.");
      }
      const resolvedMarker = path.resolve(yield* realPath(markerPath));
      if (resolvedMarker !== path.resolve(markerPath) || !contains(runtimeRoot, resolvedMarker)) {
        return yield* failure(
          "ownership_mismatch",
          "Runtime ownership marker is redirected outside the runtime root.",
        );
      }
      const contents = yield* fs
        .readFileString(markerPath)
        .pipe(
          Effect.mapError((cause) =>
            failure("ownership_mismatch", "Runtime ownership marker is unreadable.", cause),
          ),
        );
      return yield* Effect.try({
        try: () => decodeMarker(contents),
        catch: (cause) =>
          failure("ownership_mismatch", "Runtime ownership marker is invalid.", cause),
      });
    });

  const expectedMarker = (input: Omit<SkillMaterializationInput, "packages">): OwnershipMarker => ({
    schemaVersion: 1,
    sessionId: input.sessionId,
    providerInstanceId: input.providerInstanceId,
    desiredRevision: input.desiredRevision,
  });

  const assertOwned = (runtimeRoot: string, root: string, expected: OwnershipMarker) =>
    Effect.gen(function* () {
      const initial = yield* inspectDirectory(runtimeRoot, root, "Provider runtime root");
      const actual = yield* readMarker(root, runtimeRoot);
      const current = yield* inspectDirectory(runtimeRoot, root, "Provider runtime root");
      if (!sameIdentity(initial.identity, current.identity)) {
        return yield* failure(
          "ownership_mismatch",
          "Provider runtime root changed while its ownership marker was read.",
        );
      }
      if (
        actual.sessionId !== expected.sessionId ||
        actual.providerInstanceId !== expected.providerInstanceId ||
        actual.desiredRevision !== expected.desiredRevision
      ) {
        return yield* failure("ownership_mismatch", "Runtime ownership marker does not match.");
      }
      return current;
    });

  const removeOwned = (runtimeRoot: RuntimeDirectory, root: string, expected: OwnershipMarker) =>
    Effect.gen(function* () {
      yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
      const owned = yield* assertOwned(runtimeRoot.path, root, expected);
      const current = yield* inspectDirectory(runtimeRoot.path, root, "Provider runtime root");
      if (!sameIdentity(owned.identity, current.identity)) {
        return yield* failure(
          "ownership_mismatch",
          "Provider runtime root changed before cleanup.",
        );
      }
      yield* fs.remove(root, { recursive: true });
    });

  const cleanupStage = (runtimeRoot: RuntimeDirectory, stage: RuntimeDirectory | undefined) =>
    Effect.gen(function* () {
      if (stage === undefined) return;
      const runtimeRootStillPinned = yield* assertDirectoryIdentity(
        runtimeRoot.path,
        runtimeRoot,
        "Configured runtime root",
      ).pipe(Effect.option);
      if (runtimeRootStillPinned._tag === "None") return;
      // Cleanup is allowed to remove only the inode that was created for this
      // materialization. If the pathname now names a replacement, leave it
      // untouched and let its owner decide what to do with it.
      yield* assertDirectoryIdentity(runtimeRoot.path, stage, "Pending runtime destination");
      yield* fs.remove(stage.path, { recursive: true, force: true });
    }).pipe(Effect.ignore);

  const inspect = (input: Parameters<typeof inspectSkillPackage>[0]) =>
    inspectSkillPackage(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const materialize: SkillMaterializationServiceShape["materialize"] = (input) =>
    Effect.gen(function* () {
      yield* assertSafeInput(input);
      if (input.packages.some((item) => !portableKey.test(item.key))) {
        return yield* failure("unsafe_identity", "A skill key is not portable.");
      }
      if (new Set(input.packages.map((item) => item.key)).size !== input.packages.length) {
        return yield* failure("invalid_source", "Materialization contains duplicate skill keys.");
      }

      const runtimeRoot = yield* resolveRuntimeRoot();
      const sessionRoot = yield* ensureDirectoryComponent(
        runtimeRoot.path,
        runtimeRoot.path,
        input.sessionId,
        true,
      );
      const revisionRoot = yield* ensureDirectoryComponent(
        runtimeRoot.path,
        sessionRoot!.path,
        String(input.desiredRevision),
        true,
      );
      const root = path.join(revisionRoot!.path, input.providerInstanceId);
      const stage = path.join(runtimeRoot.path, `.pending-${NodeCrypto.randomUUID()}`);
      const marker = expectedMarker(input);
      let stageDirectory: RuntimeDirectory | undefined;

      const outcome = yield* Effect.gen(function* () {
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        yield* assertDirectoryIdentity(runtimeRoot.path, sessionRoot!, "Runtime session directory");
        yield* assertDirectoryIdentity(
          runtimeRoot.path,
          revisionRoot!,
          "Runtime revision directory",
        );
        const existingStage = yield* lstat(stage);
        if (existingStage !== undefined) {
          return yield* failure(
            "ownership_mismatch",
            `Pending runtime destination '${stage}' already exists.`,
          );
        }
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        const stageCreation = yield* fs
          .makeDirectory(stage, { recursive: false })
          .pipe(Effect.exit);
        if (Exit.isFailure(stageCreation)) {
          const racedStage = yield* lstat(stage);
          if (racedStage !== undefined) {
            return yield* failure(
              "ownership_mismatch",
              `Pending runtime destination '${stage}' already exists.`,
            );
          }
          return yield* failure(
            "materialization_failed",
            `Could not create pending runtime destination '${stage}'.`,
            stageCreation.cause,
          );
        }
        const createdStageInfo = yield* lstat(stage);
        if (createdStageInfo === undefined) {
          return yield* failure(
            "materialization_failed",
            `Pending runtime destination '${stage}' disappeared after creation.`,
          );
        }
        const inspectedStage = yield* inspectDirectory(
          runtimeRoot.path,
          stage,
          "Pending runtime destination",
        );
        if (!sameIdentity(identityOf(createdStageInfo), inspectedStage.identity)) {
          return yield* failure(
            "ownership_mismatch",
            `Pending runtime destination '${stage}' changed during creation.`,
          );
        }
        const pinnedStage = inspectedStage;
        stageDirectory = pinnedStage;
        const assertStage = () =>
          assertDirectoryIdentity(runtimeRoot.path, pinnedStage, "Pending runtime destination");
        const skillPaths = new Map<ManagedSkillKey, string>();
        for (const item of input.packages) {
          yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
          yield* assertDirectoryIdentity(
            runtimeRoot.path,
            sessionRoot!,
            "Runtime session directory",
          );
          yield* assertDirectoryIdentity(
            runtimeRoot.path,
            revisionRoot!,
            "Runtime revision directory",
          );
          yield* assertStage();
          const source = yield* inspect({
            packagePath: item.sourcePath,
            expectedKey: item.key,
          });
          yield* assertStage();
          if (source.validity !== "valid") {
            return yield* failure("invalid_source", "A source skill package is invalid.");
          }
          const target = path.join(stage, item.key);
          yield* assertStage();
          yield* fs.copy(item.sourcePath, target);
          yield* assertStage();
          const copied = yield* inspect({ packagePath: target, expectedKey: item.key });
          yield* assertStage();
          if (copied.validity !== "valid" || copied.hash !== source.hash) {
            return yield* failure(
              "invalid_source",
              "A source skill package changed during materialization.",
            );
          }
          skillPaths.set(item.key, path.join(root, item.key));
        }
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        yield* assertStage();
        yield* fs.writeFileString(path.join(stage, OWNERSHIP_MARKER), encodeMarker(marker));
        yield* assertStage();
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        yield* assertDirectoryIdentity(runtimeRoot.path, sessionRoot!, "Runtime session directory");
        yield* assertDirectoryIdentity(
          runtimeRoot.path,
          revisionRoot!,
          "Runtime revision directory",
        );
        const currentRoot = yield* lstat(root);
        if (currentRoot !== undefined) {
          yield* assertStage();
          yield* removeOwned(runtimeRoot, root, marker);
          yield* assertStage();
        }
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        yield* assertDirectoryIdentity(runtimeRoot.path, sessionRoot!, "Runtime session directory");
        yield* assertDirectoryIdentity(
          runtimeRoot.path,
          revisionRoot!,
          "Runtime revision directory",
        );
        const destination = yield* lstat(root);
        if (destination !== undefined) {
          yield* assertStage();
          yield* removeOwned(runtimeRoot, root, marker);
          yield* assertStage();
        }
        yield* assertDirectoryIdentity(runtimeRoot.path, runtimeRoot, "Configured runtime root");
        yield* assertDirectoryIdentity(runtimeRoot.path, sessionRoot!, "Runtime session directory");
        yield* assertDirectoryIdentity(
          runtimeRoot.path,
          revisionRoot!,
          "Runtime revision directory",
        );
        yield* assertStage();
        yield* fs.rename(stage, root);
        yield* assertDirectoryIdentity(
          runtimeRoot.path,
          { path: root, identity: pinnedStage.identity },
          "Published provider runtime root",
        );
        stageDirectory = undefined;
        return { root, skillPaths } satisfies SkillMaterializationResult;
      }).pipe(
        Effect.mapError((cause) =>
          isSkillMaterializationError(cause)
            ? cause
            : failure("materialization_failed", "Could not materialize managed skills.", cause),
        ),
        Effect.exit,
      );
      if (Exit.isFailure(outcome)) {
        yield* cleanupStage(runtimeRoot, stageDirectory);
        return yield* Effect.failCause(outcome.cause);
      }
      return outcome.value;
    });

  const dispose: SkillMaterializationServiceShape["dispose"] = (input) =>
    Effect.gen(function* () {
      yield* assertSafeInput(input);
      const runtimeRoot = yield* resolveRuntimeRoot();
      const sessionRoot = yield* ensureDirectoryComponent(
        runtimeRoot.path,
        runtimeRoot.path,
        input.sessionId,
        false,
      );
      if (sessionRoot === undefined) return;
      const revisionRoot = yield* ensureDirectoryComponent(
        runtimeRoot.path,
        sessionRoot.path,
        String(input.desiredRevision),
        false,
      );
      if (revisionRoot === undefined) return;
      const root = path.join(revisionRoot.path, input.providerInstanceId);
      yield* removeOwned(runtimeRoot, root, expectedMarker(input));
    }).pipe(
      Effect.mapError((cause) =>
        isSkillMaterializationError(cause)
          ? cause
          : failure("materialization_failed", "Could not remove the runtime package.", cause),
      ),
    );

  const disposeSession: SkillMaterializationServiceShape["disposeSession"] = Effect.fn(
    "SkillMaterializationService.disposeSession",
  )(
    function* (input) {
      yield* assertSafeInput({ ...input, desiredRevision: 0 });
      const runtimeRoot = yield* resolveRuntimeRoot();
      const sessionRoot = yield* ensureDirectoryComponent(
        runtimeRoot.path,
        runtimeRoot.path,
        input.sessionId,
        false,
      );
      if (sessionRoot === undefined) return;
      yield* assertDirectoryIdentity(runtimeRoot.path, sessionRoot, "Runtime session directory");
      for (const revision of yield* fs.readDirectory(sessionRoot.path)) {
        const desiredRevision = Number(revision);
        if (
          !Number.isSafeInteger(desiredRevision) ||
          desiredRevision < 0 ||
          String(desiredRevision) !== revision
        )
          continue;
        const revisionRoot = yield* ensureDirectoryComponent(
          runtimeRoot.path,
          sessionRoot.path,
          revision,
          false,
        );
        if (revisionRoot === undefined) continue;
        const root = path.join(revisionRoot.path, input.providerInstanceId);
        if ((yield* lstat(root)) === undefined) continue;
        const candidate = { ...input, desiredRevision };
        yield* dispose(candidate).pipe(
          Effect.catchIf(
            (error) => error.code === "ownership_mismatch",
            () => Effect.void,
          ),
        );
      }
    },
    Effect.mapError((cause) =>
      isSkillMaterializationError(cause)
        ? cause
        : failure(
            "materialization_failed",
            "Could not discover runtime packages for cleanup.",
            cause,
          ),
    ),
  );

  return SkillMaterializationService.of({ materialize, dispose, disposeSession });
});

export const layer = Layer.effect(SkillMaterializationService, make);
