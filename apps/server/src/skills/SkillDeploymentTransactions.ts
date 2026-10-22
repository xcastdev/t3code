// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { hashSkillPackageSync } from "./SkillPackage.ts";

export const DeploymentMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providerInstanceId: Schema.String,
  key: Schema.String,
  targetPath: Schema.String,
  installedHash: Schema.String,
  installedManifestHash: Schema.String,
});
export const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(DeploymentMarker));
export const encodeMarker = Schema.encodeSync(Schema.fromJsonString(DeploymentMarker));
const Journal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providerInstanceId: Schema.String,
  key: Schema.String,
  targetRoot: Schema.String,
  operation: Schema.Literals(["install", "uninstall"]),
  phase: Schema.Literals(["prepared", "committed", "cleanup"]),
  previousTarget: Schema.Boolean,
  previousMarker: Schema.optionalKey(Schema.String),
  nextMarker: Schema.optionalKey(Schema.String),
  nextPackageIdentity: Schema.optionalKey(
    Schema.Struct({ device: Schema.String, inode: Schema.String }),
  ),
});
export type DeploymentJournal = typeof Journal.Type;
const decodeJournal = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
const encodeJournal = Schema.encodeSync(Schema.fromJsonString(Journal));

class SkillDeploymentTransactionError extends Schema.TaggedError<SkillDeploymentTransactionError>()(
  "SkillDeploymentTransactionError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isSkillDeploymentTransactionError = Schema.is(SkillDeploymentTransactionError);
const failure = (detail: string, cause?: unknown) =>
  new SkillDeploymentTransactionError({ detail, ...(cause === undefined ? {} : { cause }) });
const parseJournal = (bytes: string) =>
  Effect.try({
    try: () => decodeJournal(bytes),
    catch: (cause) => failure("Deployment recovery journal is invalid.", cause),
  });

export const deploymentPackageIdentitySync = (directory: string) => {
  const info = NodeFS.lstatSync(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw failure(`Deployment package identity is invalid at ${directory}.`);
  return { device: String(info.dev), inode: String(info.ino) };
};
export const matchesDeploymentPackageIdentitySync = (
  directory: string,
  expected: { readonly device: string; readonly inode: string } | undefined,
) => {
  if (expected === undefined) return false;
  const actual = deploymentPackageIdentitySync(directory);
  return actual.device === expected.device && actual.inode === expected.inode;
};

export const makeSkillDeploymentTransactions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Provider scanners recurse below their skills roots; transaction packages must stay outside.
  const rootFor = (targetRoot: string) =>
    path.join(
      path.dirname(targetRoot),
      ".t3-skill-transactions",
      NodeCrypto.createHash("sha256").update(path.resolve(targetRoot)).digest("hex"),
    );
  const pathsFor = (directory: string) => ({
    directory,
    stage: path.join(directory, "pending"),
    markerStage: path.join(directory, "next-marker.json"),
    backup: path.join(directory, "previous"),
    markerBackup: path.join(directory, "previous-marker.json"),
    journal: path.join(directory, "transaction.json"),
  });
  const allocate = Effect.fn("SkillDeploymentTransactions.allocate")(function* (
    targetRoot: string,
    key: ManagedSkillKey,
  ) {
    const root = rootFor(targetRoot);
    yield* fs.makeDirectory(root, { recursive: true });
    return pathsFor(yield* fs.makeTempDirectory({ directory: root, prefix: `${key}-` }));
  });
  const write = Effect.fn("SkillDeploymentTransactions.write")(function* (
    directory: string,
    journal: DeploymentJournal,
  ) {
    const location = pathsFor(directory).journal;
    yield* fs.writeFileString(`${location}.next`, encodeJournal(journal));
    yield* fs.rename(`${location}.next`, location);
  });
  const recover = Effect.fn("SkillDeploymentTransactions.recover")(function* (
    directory: string,
    expected: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly targetRoot: string;
      readonly key: ManagedSkillKey;
    },
  ) {
    const paths = pathsFor(directory);
    const journalBytes = yield* fs.readFileString(paths.journal);
    const journal = yield* parseJournal(journalBytes);
    yield* Effect.try({
      try: () => {
        const exists = (file: string) =>
          NodeFS.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
        const manifestHash = (file: string) =>
          NodeCrypto.createHash("sha256")
            .update(NodeFS.readFileSync(path.join(file, "t3-skill.json")))
            .digest("hex");
        const matches = (file: string, bytes: string | undefined) => {
          if (bytes === undefined) return false;
          const owned = decodeMarker(bytes);
          return (
            hashSkillPackageSync(file) === owned.installedHash &&
            manifestHash(file) === owned.installedManifestHash
          );
        };
        const target = path.join(expected.targetRoot, expected.key);
        const marker = path.join(expected.targetRoot, `.t3-managed-${expected.key}.json`);
        if (
          NodeFS.readFileSync(paths.journal, "utf8") !== journalBytes ||
          journal.providerInstanceId !== expected.providerInstanceId ||
          journal.key !== expected.key ||
          journal.targetRoot !== expected.targetRoot
        )
          throw failure(`Deployment transaction ownership changed at ${directory}.`);
        for (const bytes of [journal.previousMarker, journal.nextMarker]) {
          if (bytes === undefined) continue;
          const owned = decodeMarker(bytes);
          if (
            owned.providerInstanceId !== expected.providerInstanceId ||
            owned.key !== expected.key ||
            owned.targetPath !== target
          )
            throw failure(`Deployment transaction marker differs at ${directory}.`);
        }
        const assertArtifacts = () => {
          const allowed = new Set([
            "pending",
            "previous",
            "next-marker.json",
            "previous-marker.json",
            "transaction.json",
            "transaction.json.next",
          ]);
          if (NodeFS.readdirSync(directory).some((name) => !allowed.has(name)))
            throw failure(`Unexpected deployment transaction files retained at ${directory}.`);
          for (const [file, bytes] of [
            [paths.markerStage, journal.nextMarker],
            [paths.markerBackup, journal.previousMarker],
          ] as const) {
            if (
              exists(file) &&
              (bytes === undefined || NodeFS.readFileSync(file, "utf8") !== bytes)
            )
              throw failure(`Edited deployment marker retained at ${file}.`);
          }
          for (const [file, bytes] of [
            [paths.stage, journal.nextMarker],
            [paths.backup, journal.previousMarker],
          ] as const) {
            if (
              exists(file) &&
              (!matches(file, bytes) ||
                (file === paths.stage &&
                  !matchesDeploymentPackageIdentitySync(file, journal.nextPackageIdentity)))
            )
              throw failure(`Edited deployment files retained at ${file}.`);
          }
        };
        const movePackage = (from: string, to: string, bytes: string | undefined) => {
          if (!matches(from, bytes)) throw failure(`Changed package retained at ${from}.`);
          const source = NodeFS.lstatSync(from, { bigint: true });
          if (exists(to)) throw failure(`Recovery destination is occupied at ${to}.`);
          NodeFS.renameSync(from, to);
          try {
            const moved = NodeFS.lstatSync(to, { bigint: true });
            if (moved.dev !== source.dev || moved.ino !== source.ino || !matches(to, bytes))
              throw failure(`Changed moved package retained at ${to}.`);
          } catch (cause) {
            if (!exists(from)) NodeFS.renameSync(to, from);
            throw cause;
          }
        };
        assertArtifacts();
        if (journal.phase === "prepared") {
          const targetPresent = exists(target);
          const liveMarker = exists(marker) ? NodeFS.readFileSync(marker, "utf8") : undefined;
          const untouched =
            !exists(paths.backup) &&
            !exists(paths.markerBackup) &&
            liveMarker === journal.previousMarker &&
            targetPresent === journal.previousTarget;
          if (!untouched) {
            const oldTarget =
              journal.previousTarget && targetPresent && matches(target, journal.previousMarker);
            if (targetPresent && !oldTarget && !matches(target, journal.nextMarker))
              throw failure(`Edited installed skill retained at ${target}.`);
            if (
              liveMarker !== undefined &&
              liveMarker !== journal.previousMarker &&
              liveMarker !== journal.nextMarker
            )
              throw failure(`Changed installed ownership retained at ${marker}.`);
            if (journal.previousTarget && !oldTarget && !exists(paths.backup))
              throw failure(`Previous deployment is missing at ${directory}.`);
            if (
              journal.previousMarker !== undefined &&
              liveMarker !== journal.previousMarker &&
              !exists(paths.markerBackup)
            )
              throw failure(`Previous deployment marker is missing at ${directory}.`);
            if (targetPresent && !oldTarget) {
              if (exists(paths.stage))
                throw failure(
                  `Unpublished staged package and conflicting live target retained at ${directory}.`,
                );
              if (!matchesDeploymentPackageIdentitySync(target, journal.nextPackageIdentity))
                throw failure(`Unproven live package retained at ${target}.`);
              movePackage(target, paths.stage, journal.nextMarker);
            }
            if (journal.previousTarget && !oldTarget)
              movePackage(paths.backup, target, journal.previousMarker);
            if (liveMarker !== undefined && liveMarker !== journal.previousMarker) {
              if (NodeFS.readFileSync(marker, "utf8") !== liveMarker)
                throw failure(`Changed ownership retained at ${marker}.`);
              if (exists(paths.markerStage)) NodeFS.rmSync(paths.markerStage);
              NodeFS.renameSync(marker, paths.markerStage);
            }
            if (journal.previousMarker !== undefined && liveMarker !== journal.previousMarker) {
              if (
                exists(marker) ||
                NodeFS.readFileSync(paths.markerBackup, "utf8") !== journal.previousMarker
              )
                throw failure(`Changed ownership retained at ${marker}.`);
              NodeFS.renameSync(paths.markerBackup, marker);
            }
          }
        }
        // Keep the final moved-byte proof and bounded cleanup in one synchronous boundary.
        // No provider-root package is deleted, and a failed/partial cleanup stays isolated.
        assertArtifacts();
        NodeFS.writeFileSync(
          `${paths.journal}.next`,
          encodeJournal({ ...journal, phase: "cleanup" }),
        );
        NodeFS.renameSync(`${paths.journal}.next`, paths.journal);
        assertArtifacts();
        try {
          NodeFS.rmSync(directory, { recursive: true });
        } catch {}
      },
      catch: (cause) =>
        isSkillDeploymentTransactionError(cause)
          ? cause
          : failure(`Could not safely recover deployment at ${directory}.`, cause),
    });
  });
  const recoverKey = Effect.fn("SkillDeploymentTransactions.recoverKey")(function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly targetRoot: string;
    readonly key: ManagedSkillKey;
  }) {
    const root = rootFor(input.targetRoot);
    if (!(yield* fs.exists(root))) return;
    const names = yield* fs.readDirectory(root);
    for (const name of names) {
      if (!name.startsWith(`${input.key}-`)) continue;
      const directory = path.join(root, name);
      if (!(yield* fs.exists(pathsFor(directory).journal))) continue;
      const journal = yield* fs
        .readFileString(pathsFor(directory).journal)
        .pipe(Effect.flatMap(parseJournal));
      if (
        journal.key !== input.key ||
        journal.providerInstanceId !== input.providerInstanceId ||
        journal.targetRoot !== input.targetRoot
      )
        continue;
      yield* journal.phase === "prepared"
        ? recover(directory, input)
        : recover(directory, input).pipe(Effect.ignore);
    }
  });
  const pendingKeys = Effect.fn("SkillDeploymentTransactions.pendingKeys")(function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly targetRoot: string;
  }) {
    const root = rootFor(input.targetRoot);
    if (!(yield* fs.exists(root))) return [];
    const keys = new Set<ManagedSkillKey>();
    for (const name of yield* fs.readDirectory(root)) {
      const location = pathsFor(path.join(root, name)).journal;
      if (!(yield* fs.exists(location))) continue;
      const journal = yield* fs.readFileString(location).pipe(Effect.flatMap(parseJournal));
      if (
        journal.providerInstanceId === input.providerInstanceId &&
        journal.targetRoot === input.targetRoot &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(journal.key)
      )
        keys.add(journal.key as ManagedSkillKey);
    }
    return [...keys];
  });
  return { allocate, write, recover, recoverKey, pendingKeys };
});
