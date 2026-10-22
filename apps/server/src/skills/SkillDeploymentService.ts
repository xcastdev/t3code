// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { ManagedSkillKey, ProviderInstanceId, SkillContentHash } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { inspectSkillPackage, hashSkillPackageSync } from "./SkillPackage.ts";
import {
  DeploymentMarker,
  decodeMarker,
  encodeMarker,
  makeSkillDeploymentTransactions,
  type DeploymentJournal,
  deploymentPackageIdentitySync,
  matchesDeploymentPackageIdentitySync,
} from "./SkillDeploymentTransactions.ts";
import { SkillMutationCommitAuthority } from "./SkillMutationCommitAuthority.ts";

const portableKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type DeploymentMarker = typeof DeploymentMarker.Type;

export class SkillDeploymentError extends Schema.TaggedError<SkillDeploymentError>()(
  "SkillDeploymentError",
  {
    code: Schema.Literals([
      "invalid_source",
      "destination_collision",
      "ownership_mismatch",
      "installed_drift",
      "deployment_failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isSkillDeploymentError = Schema.is(SkillDeploymentError);

const failure = (code: SkillDeploymentError["code"], detail: string, cause?: unknown) =>
  new SkillDeploymentError({ code, detail, ...(cause === undefined ? {} : { cause }) });

export interface SkillDeploymentInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly targetRoot: string;
  readonly key: ManagedSkillKey;
  readonly sourcePath: string;
  readonly expectedHash?: SkillContentHash;
}

export type SkillDeploymentStatus =
  | { readonly state: "absent" }
  | { readonly state: "owned"; readonly installedHash: SkillContentHash }
  | { readonly state: "drifted"; readonly installedHash: SkillContentHash };

/**
 * Persistent deployment is deliberately separate from session materialization.
 * It touches only an explicitly selected provider target and only updates or
 * removes packages whose sibling marker and installed bytes still match.
 */
export const makeSkillDeploymentService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutations = yield* KeyedLock.make<string>();
  const transactions = yield* makeSkillDeploymentTransactions;
  const manifestHash = (packagePath: string) =>
    fs
      .readFile(path.join(packagePath, "t3-skill.json"))
      .pipe(Effect.map((bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex")));
  const assertKey = (key: ManagedSkillKey) =>
    portableKey.test(key)
      ? Effect.void
      : Effect.fail(failure("invalid_source", "The skill key is not portable."));

  const pathsFor = (input: Pick<SkillDeploymentInput, "targetRoot" | "key">) => ({
    target: path.join(input.targetRoot, input.key),
    marker: path.join(input.targetRoot, `.t3-managed-${input.key}.json`),
  });
  const inspect = (packagePath: string, key: ManagedSkillKey) =>
    inspectSkillPackage({ packagePath, expectedKey: key }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const readMarker = (markerPath: string) =>
    fs.readFileString(markerPath).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeMarker(value),
          catch: (cause) => failure("ownership_mismatch", "Deployment marker is invalid.", cause),
        }),
      ),
      Effect.mapError((cause) =>
        isSkillDeploymentError(cause)
          ? cause
          : failure("ownership_mismatch", "Deployment marker is missing.", cause),
      ),
    );
  const assertMarker = (input: SkillDeploymentInput, marker: DeploymentMarker, target: string) =>
    marker.schemaVersion === 1 &&
    marker.providerInstanceId === input.providerInstanceId &&
    marker.key === input.key &&
    marker.targetPath === target
      ? Effect.void
      : Effect.fail(failure("ownership_mismatch", "Deployment ownership does not match."));
  const assertUndrifted = (input: SkillDeploymentInput, marker: DeploymentMarker, target: string) =>
    inspect(target, input.key).pipe(
      Effect.flatMap((current) =>
        current.validity === "valid" && current.hash === marker.installedHash
          ? manifestHash(target).pipe(
              Effect.flatMap((hash) =>
                hash === marker.installedManifestHash
                  ? Effect.void
                  : Effect.fail(
                      failure(
                        "installed_drift",
                        "Installed manifest changed after T3 deployed it.",
                      ),
                    ),
              ),
            )
          : Effect.fail(
              failure("installed_drift", "Installed files changed after T3 deployed them."),
            ),
      ),
    );

  const assertCurrentSync = (
    input: SkillDeploymentInput,
    target: string,
    marker: string,
    markerBytes: string | undefined,
    targetExists: boolean,
  ) => {
    const exists = (file: string) =>
      NodeFS.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
    if (exists(target) !== targetExists || exists(marker) !== (markerBytes !== undefined))
      throw failure("destination_collision", "The provider target changed before commit.");
    if (markerBytes === undefined) return;
    if (NodeFS.readFileSync(marker, "utf8") !== markerBytes)
      throw failure("ownership_mismatch", "Deployment ownership changed before commit.");
    const owned = decodeMarker(markerBytes);
    if (
      owned.providerInstanceId !== input.providerInstanceId ||
      owned.key !== input.key ||
      owned.targetPath !== target
    )
      throw failure("ownership_mismatch", "Deployment ownership does not match.");
    if (
      targetExists &&
      (hashSkillPackageSync(target) !== owned.installedHash ||
        NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(path.join(target, "t3-skill.json")))
          .digest("hex") !== owned.installedManifestHash)
    )
      throw failure("installed_drift", "Installed files changed before commit.");
  };

  const status = (
    input: SkillDeploymentInput,
  ): Effect.Effect<SkillDeploymentStatus, SkillDeploymentError> => {
    const { target, marker } = pathsFor(input);
    return Effect.gen(function* () {
      yield* assertKey(input.key);
      if (!(yield* fs.exists(target)) && !(yield* fs.exists(marker))) {
        return { state: "absent" } as const;
      }
      const owned = yield* readMarker(marker);
      yield* assertMarker(input, owned, target);
      const current = yield* inspect(target, input.key);
      return current.validity === "valid" &&
        current.hash === owned.installedHash &&
        (yield* manifestHash(target)) === owned.installedManifestHash
        ? ({ state: "owned", installedHash: owned.installedHash as SkillContentHash } as const)
        : ({ state: "drifted", installedHash: owned.installedHash as SkillContentHash } as const);
    }).pipe(
      Effect.mapError((cause) =>
        isSkillDeploymentError(cause)
          ? cause
          : failure("deployment_failed", "Could not inspect the persistent deployment.", cause),
      ),
    );
  };

  const install = Effect.fn("SkillDeploymentService.installTransaction")(
    function* (input: SkillDeploymentInput) {
      if (!portableKey.test(input.key)) {
        return yield* failure("invalid_source", "The skill key is not portable.");
      }
      const source = yield* inspect(input.sourcePath, input.key);
      if (source.validity !== "valid" || source.hash === undefined) {
        return yield* failure("invalid_source", "The source skill package is invalid.");
      }
      const sourceHash = source.hash;
      if (input.expectedHash !== undefined && sourceHash !== input.expectedHash)
        return yield* failure(
          "invalid_source",
          "The source skill revision changed before deployment.",
        );
      const sourceManifestHash = yield* manifestHash(input.sourcePath);
      const { target, marker } = pathsFor(input);
      const targetExists = yield* fs.exists(target);
      const markerExists = yield* fs.exists(marker);
      if (targetExists || markerExists) {
        if (!markerExists) {
          return yield* failure(
            "destination_collision",
            "The provider target is occupied without complete T3 ownership proof.",
          );
        }
        const owned = yield* readMarker(marker);
        yield* assertMarker(input, owned, target);
        if (targetExists) yield* assertUndrifted(input, owned, target);
      }
      const markerBytes = markerExists ? yield* fs.readFileString(marker) : undefined;
      yield* fs.makeDirectory(input.targetRoot, { recursive: true });
      const transaction = yield* transactions.allocate(input.targetRoot, input.key);
      const { stage, markerStage, backup, markerBackup } = transaction;
      let journal: DeploymentJournal | undefined;
      const outcome = yield* Effect.gen(function* () {
        yield* fs.copy(input.sourcePath, stage);
        const staged = yield* inspect(stage, input.key);
        if (
          staged.validity !== "valid" ||
          staged.hash !== sourceHash ||
          (yield* manifestHash(stage)) !== sourceManifestHash
        ) {
          return yield* failure("invalid_source", "The source changed during deployment.");
        }
        const ownership: DeploymentMarker = {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetPath: target,
          installedHash: sourceHash,
          installedManifestHash: sourceManifestHash,
        };
        const stagedIdentity = yield* Effect.try({
          try: () => deploymentPackageIdentitySync(stage),
          catch: (cause) =>
            failure(
              "invalid_source",
              "The staged package changed before ownership was recorded.",
              cause,
            ),
        });
        yield* fs.writeFileString(markerStage, encodeMarker(ownership));
        journal = {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetRoot: input.targetRoot,
          operation: "install",
          phase: "prepared",
          previousTarget: targetExists,
          ...(markerBytes === undefined ? {} : { previousMarker: markerBytes }),
          nextMarker: encodeMarker(ownership),
          nextPackageIdentity: stagedIdentity,
        };
        yield* transactions.write(transaction.directory, journal);
        const authority = yield* Effect.serviceOption(SkillMutationCommitAuthority);
        if (Option.isSome(authority)) {
          yield* authority.value.commit(() => {
            assertCurrentSync(input, target, marker, markerBytes, targetExists);
            if (
              !matchesDeploymentPackageIdentitySync(stage, stagedIdentity) ||
              hashSkillPackageSync(stage) !== sourceHash ||
              NodeCrypto.createHash("sha256")
                .update(NodeFS.readFileSync(path.join(stage, "t3-skill.json")))
                .digest("hex") !== sourceManifestHash
            )
              throw failure("invalid_source", "The staged skill changed before commit.");
            if (targetExists) {
              NodeFS.renameSync(target, backup);
            }
            if (markerExists) {
              NodeFS.renameSync(marker, markerBackup);
            }
            NodeFS.renameSync(stage, target);
            NodeFS.renameSync(markerStage, marker);
          });
        } else {
          if (targetExists) {
            yield* fs.rename(target, backup);
          }
          if (markerExists) {
            yield* fs.rename(marker, markerBackup);
          }
          yield* fs.rename(stage, target);
          yield* fs.rename(markerStage, marker);
        }
        yield* transactions.write(transaction.directory, { ...journal, phase: "committed" });
        yield* transactions.recover(transaction.directory, input).pipe(Effect.ignore);
        return { state: "owned", installedHash: sourceHash } as const;
      }).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        if (journal !== undefined) {
          yield* transactions.recover(transaction.directory, input);
        } else {
          yield* fs.remove(transaction.directory, { recursive: true, force: true });
        }
        return yield* Effect.failCause(outcome.cause);
      }
      return outcome.value;
    },
    Effect.mapError((cause) =>
      isSkillDeploymentError(cause)
        ? cause
        : failure("deployment_failed", "Persistent skill deployment failed.", cause),
    ),
  );

  const uninstall = (input: SkillDeploymentInput) => {
    const { target, marker } = pathsFor(input);
    return Effect.gen(function* () {
      yield* assertKey(input.key);
      const owned = yield* readMarker(marker);
      yield* assertMarker(input, owned, target);
      const targetExists = yield* fs.exists(target);
      if (targetExists) yield* assertUndrifted(input, owned, target);
      const markerBytes = yield* fs.readFileString(marker);
      const transaction = yield* transactions.allocate(input.targetRoot, input.key);
      const { backup: removedTarget, markerBackup: removedMarker } = transaction;
      const journal: DeploymentJournal = {
        schemaVersion: 1,
        providerInstanceId: input.providerInstanceId,
        key: input.key,
        targetRoot: input.targetRoot,
        operation: "uninstall",
        phase: "prepared",
        previousTarget: targetExists,
        previousMarker: markerBytes,
      };
      yield* transactions.write(transaction.directory, journal);
      const outcome = yield* Effect.gen(function* () {
        const authority = yield* Effect.serviceOption(SkillMutationCommitAuthority);
        if (Option.isSome(authority)) {
          yield* authority.value.commit(() => {
            assertCurrentSync(input, target, marker, markerBytes, targetExists);
            if (targetExists) NodeFS.renameSync(target, removedTarget);
            NodeFS.renameSync(marker, removedMarker);
          });
        } else {
          if (targetExists) yield* fs.rename(target, removedTarget);
          yield* fs.rename(marker, removedMarker);
        }
        yield* transactions.write(transaction.directory, { ...journal, phase: "committed" });
      }).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        yield* transactions.recover(transaction.directory, input);
        return yield* Effect.failCause(outcome.cause);
      }
      yield* transactions.recover(transaction.directory, input).pipe(Effect.ignore);
    }).pipe(
      Effect.mapError((cause) =>
        isSkillDeploymentError(cause)
          ? cause
          : failure("deployment_failed", "Persistent skill uninstall failed.", cause),
      ),
    );
  };

  const listOwned = Effect.fn("SkillDeploymentService.listOwned")(
    function* (input: Pick<SkillDeploymentInput, "providerInstanceId" | "targetRoot">) {
      for (const key of yield* transactions.pendingKeys(input))
        yield* mutations.withLock(
          path.resolve(input.targetRoot, key),
          transactions.recoverKey({ ...input, key }),
        );
      if (!(yield* fs.exists(input.targetRoot))) return [];
      const names = yield* fs.readDirectory(input.targetRoot);
      return yield* Effect.forEach(
        names.flatMap((name) => {
          const match = /^\.t3-managed-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(name);
          return match ? [match[1]! as ManagedSkillKey] : [];
        }),
        (key) =>
          mutations
            .withLock(
              path.resolve(input.targetRoot, key),
              status({ ...input, key, sourcePath: "" }),
            )
            .pipe(
              Effect.map((value) => ({ key, ...value })),
              Effect.catch((error) =>
                Effect.succeed({ key, state: "blocked" as const, detail: error.detail }),
              ),
            ),
      );
    },
    Effect.mapError((cause) =>
      failure("deployment_failed", "Could not list installed skills.", cause),
    ),
  );

  return {
    install: Effect.fn("SkillDeploymentService.install")((input: SkillDeploymentInput) =>
      mutations
        .withLock(
          path.resolve(input.targetRoot, input.key),
          Effect.uninterruptible(
            transactions.recoverKey(input).pipe(Effect.andThen(install(input))),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSkillDeploymentError(cause)
              ? cause
              : failure("deployment_failed", "Could not recover the persistent deployment.", cause),
          ),
        ),
    ),
    uninstall: Effect.fn("SkillDeploymentService.uninstall")((input: SkillDeploymentInput) =>
      mutations
        .withLock(
          path.resolve(input.targetRoot, input.key),
          Effect.uninterruptible(
            transactions.recoverKey(input).pipe(Effect.andThen(uninstall(input))),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSkillDeploymentError(cause)
              ? cause
              : failure("deployment_failed", "Could not recover the persistent deployment.", cause),
          ),
        ),
    ),
    status: Effect.fn("SkillDeploymentService.status")((input: SkillDeploymentInput) =>
      mutations.withLock(
        path.resolve(input.targetRoot, input.key),
        transactions.recoverKey(input).pipe(
          Effect.andThen(status(input)),
          Effect.mapError((cause) =>
            isSkillDeploymentError(cause)
              ? cause
              : failure("deployment_failed", "Could not recover the persistent deployment.", cause),
          ),
        ),
      ),
    ),
    listOwned,
  };
});

export class SkillDeploymentService extends Context.Service<
  SkillDeploymentService,
  Effect.Success<typeof makeSkillDeploymentService>
>()("t3/skills/SkillDeploymentService") {}
export const layer = Layer.effect(SkillDeploymentService, makeSkillDeploymentService);
