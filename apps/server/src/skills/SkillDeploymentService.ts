// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { ManagedSkillKey, ProviderInstanceId, SkillContentHash } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { inspectSkillPackage } from "./SkillPackage.ts";

const portableKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DeploymentMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providerInstanceId: Schema.String,
  key: Schema.String,
  targetPath: Schema.String,
  installedHash: Schema.String,
});
type DeploymentMarker = typeof DeploymentMarker.Type;
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(DeploymentMarker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(DeploymentMarker));

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
          ? Effect.void
          : Effect.fail(
              failure("installed_drift", "Installed files changed after T3 deployed them."),
            ),
      ),
    );

  const status = (
    input: SkillDeploymentInput,
  ): Effect.Effect<SkillDeploymentStatus, SkillDeploymentError> => {
    const { target, marker } = pathsFor(input);
    return Effect.gen(function* () {
      if (!(yield* fs.exists(target)) && !(yield* fs.exists(marker))) {
        return { state: "absent" } as const;
      }
      const owned = yield* readMarker(marker);
      yield* assertMarker(input, owned, target);
      const current = yield* inspect(target, input.key);
      return current.validity === "valid" && current.hash === owned.installedHash
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

  const install = (input: SkillDeploymentInput) =>
    Effect.gen(function* () {
      if (!portableKey.test(input.key)) {
        return yield* failure("invalid_source", "The skill key is not portable.");
      }
      const source = yield* inspect(input.sourcePath, input.key);
      if (source.validity !== "valid" || source.hash === undefined) {
        return yield* failure("invalid_source", "The source skill package is invalid.");
      }
      const sourceHash = source.hash;
      const { target, marker } = pathsFor(input);
      const targetExists = yield* fs.exists(target);
      const markerExists = yield* fs.exists(marker);
      if (targetExists || markerExists) {
        if (!targetExists || !markerExists) {
          return yield* failure(
            "destination_collision",
            "The provider target is occupied without complete T3 ownership proof.",
          );
        }
        const owned = yield* readMarker(marker);
        yield* assertMarker(input, owned, target);
        yield* assertUndrifted(input, owned, target);
      }
      yield* fs.makeDirectory(input.targetRoot, { recursive: true });
      const transactionId = NodeCrypto.randomUUID();
      const stage = `${target}.pending-${transactionId}`;
      const markerStage = `${marker}.pending-${transactionId}`;
      const backup = `${target}.previous-${transactionId}`;
      const markerBackup = `${marker}.previous-${transactionId}`;
      let targetBackedUp = false;
      let markerBackedUp = false;
      let targetPublished = false;
      let markerPublished = false;
      const outcome = yield* Effect.gen(function* () {
        yield* fs.copy(input.sourcePath, stage);
        const staged = yield* inspect(stage, input.key);
        if (staged.validity !== "valid" || staged.hash !== sourceHash) {
          return yield* failure("invalid_source", "The source changed during deployment.");
        }
        const ownership: DeploymentMarker = {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetPath: target,
          installedHash: sourceHash,
        };
        yield* fs.writeFileString(markerStage, encodeMarker(ownership));
        if (targetExists) {
          yield* fs.rename(target, backup);
          targetBackedUp = true;
          yield* fs.rename(marker, markerBackup);
          markerBackedUp = true;
        }
        yield* fs.rename(stage, target);
        targetPublished = true;
        yield* fs.rename(markerStage, marker);
        markerPublished = true;
        if (targetExists) {
          yield* fs.remove(backup, { recursive: true }).pipe(Effect.ignore);
          yield* fs.remove(markerBackup).pipe(Effect.ignore);
        }
        return { state: "owned", installedHash: sourceHash } as const;
      }).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        yield* fs.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore);
        yield* fs.remove(markerStage, { force: true }).pipe(Effect.ignore);
        if (targetPublished) {
          yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
        }
        if (markerPublished) {
          yield* fs.remove(marker, { force: true }).pipe(Effect.ignore);
        }
        if (targetBackedUp && (yield* fs.exists(backup))) {
          yield* fs.rename(backup, target).pipe(Effect.ignore);
        }
        if (markerBackedUp && (yield* fs.exists(markerBackup))) {
          yield* fs.rename(markerBackup, marker).pipe(Effect.ignore);
        }
        return yield* Effect.failCause(outcome.cause);
      }
      return outcome.value;
    }).pipe(
      Effect.mapError((cause) =>
        isSkillDeploymentError(cause)
          ? cause
          : failure("deployment_failed", "Persistent skill deployment failed.", cause),
      ),
    );

  const uninstall = (input: SkillDeploymentInput) => {
    const { target, marker } = pathsFor(input);
    return Effect.gen(function* () {
      const owned = yield* readMarker(marker);
      yield* assertMarker(input, owned, target);
      yield* assertUndrifted(input, owned, target);
      const transactionId = NodeCrypto.randomUUID();
      const removedTarget = `${target}.removed-${transactionId}`;
      const removedMarker = `${marker}.removed-${transactionId}`;
      yield* fs.rename(target, removedTarget);
      const markerExit = yield* fs.rename(marker, removedMarker).pipe(Effect.exit);
      if (Exit.isFailure(markerExit)) {
        yield* fs.rename(removedTarget, target).pipe(Effect.ignore);
        return yield* Effect.failCause(markerExit.cause);
      }
      yield* fs.remove(removedTarget, { recursive: true }).pipe(Effect.ignore);
      yield* fs.remove(removedMarker).pipe(Effect.ignore);
    }).pipe(
      Effect.mapError((cause) =>
        isSkillDeploymentError(cause)
          ? cause
          : failure("deployment_failed", "Persistent skill uninstall failed.", cause),
      ),
    );
  };

  return { install, uninstall, status };
});
