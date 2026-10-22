// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { NodeServices } from "@effect/platform-node";

import {
  makeSkillDeploymentTransactions,
  decodeMarker,
  encodeMarker,
  type DeploymentJournal,
  deploymentPackageIdentitySync,
} from "./SkillDeploymentTransactions.ts";
import { makeSkillDeploymentService } from "./SkillDeploymentService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";
import { SkillMutationCommitAuthority } from "./SkillMutationCommitAuthority.ts";
import { ManagedSkillRepositoryError } from "./ManagedSkillRepository.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const encodeFixtureManifest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeOwnedFixture = Effect.fn("SkillDeploymentService.test.makeOwnedFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-deployment-rollback-" });
  const source = path.join(root, "source", "review");
  const targetRoot = path.join(root, "provider-skills");
  yield* fs.makeDirectory(source, { recursive: true });
  const writeSource = Effect.fn("SkillDeploymentService.test.writeSource")(function* (
    revision: number,
  ) {
    const manifest = {
      schemaVersion: 1,
      kind: "managed-skill",
      id: "id-review",
      key: "review",
      scope: "global",
      origin: "created",
      ownership: "t3",
      revision: { revision, hash: "pending" },
    };
    yield* fs.writeFileString(path.join(source, "t3-skill.json"), encodeFixtureManifest(manifest));
    yield* fs.writeFileString(
      path.join(source, "SKILL.md"),
      `---\nname: review\ndescription: Review changes\n---\nRevision ${revision}.`,
    );
    const hash = yield* hashSkillPackage(source);
    yield* fs.writeFileString(
      path.join(source, "t3-skill.json"),
      encodeFixtureManifest({ ...manifest, revision: { revision, hash } }),
    );
  });
  yield* writeSource(1);
  const service = yield* makeSkillDeploymentService;
  const input = {
    providerInstanceId: ProviderInstanceId.make("codex"),
    targetRoot,
    key: ManagedSkillKey.make("review"),
    sourcePath: source,
  };
  yield* service.install(input);
  const target = path.join(targetRoot, input.key);
  const marker = path.join(targetRoot, ".t3-managed-review.json");
  const originalHash = yield* hashSkillPackage(target);
  const originalMarker = yield* fs.readFileString(marker);
  yield* writeSource(2);
  return { fs, path, service, input, target, marker, originalHash, originalMarker };
});

const makeInterruptedFixture = Effect.fn("SkillDeploymentService.test.makeInterruptedFixture")(
  function* (operation: "install" | "uninstall", boundary: number, committed = false) {
    const fixture = yield* makeOwnedFixture();
    const { fs, path, input, target, marker, originalMarker } = fixture;
    const transactions = yield* makeSkillDeploymentTransactions;
    const transaction = yield* transactions.allocate(input.targetRoot, input.key);
    const sourceHash = yield* hashSkillPackage(input.sourcePath);
    const nextMarker = encodeMarker({
      ...decodeMarker(originalMarker),
      installedHash: sourceHash,
      installedManifestHash: NodeCrypto.createHash("sha256")
        .update(yield* fs.readFile(path.join(input.sourcePath, "t3-skill.json")))
        .digest("hex"),
    });
    let journal: DeploymentJournal = {
      schemaVersion: 1,
      providerInstanceId: input.providerInstanceId,
      key: input.key,
      targetRoot: input.targetRoot,
      operation,
      phase: "prepared",
      previousTarget: true,
      previousMarker: originalMarker,
      ...(operation === "install" ? { nextMarker } : {}),
    };
    if (operation === "install") {
      yield* fs.copy(input.sourcePath, transaction.stage);
      journal = {
        ...journal,
        nextPackageIdentity: deploymentPackageIdentitySync(transaction.stage),
      };
      yield* fs.writeFileString(transaction.markerStage, nextMarker);
    }
    yield* transactions.write(transaction.directory, journal);
    if (boundary >= 1) yield* fs.rename(target, transaction.backup);
    if (boundary >= 2) yield* fs.rename(marker, transaction.markerBackup);
    if (operation === "install" && boundary >= 3) yield* fs.rename(transaction.stage, target);
    if (operation === "install" && boundary >= 4) yield* fs.rename(transaction.markerStage, marker);
    if (committed)
      yield* transactions.write(transaction.directory, { ...journal, phase: "committed" });
    return { ...fixture, transaction, sourceHash };
  },
);

const makeOrphanFixture = Effect.fn("SkillDeploymentService.test.makeOrphanFixture")(function* () {
  const fixture = yield* makeOwnedFixture();
  yield* fixture.fs.remove(fixture.input.sourcePath, { recursive: true });
  yield* fixture.fs.copy(fixture.target, fixture.input.sourcePath);
  yield* fixture.fs.remove(fixture.target, { recursive: true });
  return fixture;
});

describe("SkillDeploymentService", () => {
  it.effect.each(["unchanged", "edited"] as const)(
    "retains an orphan target recreated with %s bytes before the authority callback",
    (variant) =>
      Effect.gen(function* () {
        const { fs, path, input, target, marker, originalMarker } = yield* makeOrphanFixture();
        let pending: string | undefined;
        let actionCompleted = false;
        const service = yield* makeSkillDeploymentService.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            copy: (from, to, options) => {
              if (path.basename(to) === "pending") pending = to;
              return fs.copy(from, to, options);
            },
          }),
        );
        const authority = {
          commit: (action: () => void) =>
            fs.copy(input.sourcePath, target).pipe(
              Effect.andThen(
                variant === "edited"
                  ? fs.writeFileString(path.join(target, "SKILL.md"), "EXTERNAL RECREATED EDIT")
                  : Effect.void,
              ),
              Effect.orDie,
              Effect.andThen(
                Effect.try({
                  try: () => {
                    action();
                    actionCompleted = true;
                  },
                  catch: (cause) =>
                    new ManagedSkillRepositoryError({
                      code: "mutation_failed",
                      detail: "Conflicting external target.",
                      cause,
                    }),
                }),
              ),
            ),
        };
        yield* service
          .install(input)
          .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip);
        expect(actionCompleted).toBe(false);
        expect(yield* fs.exists(target)).toBe(true);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
        expect(pending).toBeDefined();
        expect(yield* fs.exists(pending!)).toBe(true);
        if (variant === "edited")
          expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe(
            "EXTERNAL RECREATED EDIT",
          );
        const restarted = yield* makeSkillDeploymentService;
        yield* restarted.status(input).pipe(Effect.flip);
        expect(yield* fs.exists(target)).toBe(true);
        expect(yield* fs.exists(pending!)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["unchanged", "edited"] as const)(
    "retains a %s external orphan target during prepared restart before publication",
    (variant) =>
      Effect.gen(function* () {
        const { fs, path, input, target, marker, originalMarker } = yield* makeOrphanFixture();
        const transactions = yield* makeSkillDeploymentTransactions;
        const transaction = yield* transactions.allocate(input.targetRoot, input.key);
        yield* fs.copy(input.sourcePath, transaction.stage);
        yield* fs.writeFileString(transaction.markerStage, originalMarker);
        const identity = NodeFS.lstatSync(transaction.stage, { bigint: true });
        yield* transactions.write(transaction.directory, {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetRoot: input.targetRoot,
          operation: "install",
          phase: "prepared",
          previousTarget: false,
          previousMarker: originalMarker,
          nextMarker: originalMarker,
          nextPackageIdentity: { device: String(identity.dev), inode: String(identity.ino) },
        });
        yield* fs.copy(input.sourcePath, target);
        if (variant === "edited")
          yield* fs.writeFileString(path.join(target, "SKILL.md"), "EXTERNAL RECREATED EDIT");
        const restarted = yield* makeSkillDeploymentService;
        yield* restarted.status(input).pipe(Effect.flip);
        expect(yield* fs.exists(target)).toBe(true);
        expect(yield* fs.exists(transaction.stage)).toBe(true);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains a byte-identical external replacement after genuine orphan publication", () =>
    Effect.gen(function* () {
      const { fs, path, input, target, originalMarker } = yield* makeOrphanFixture();
      const transactions = yield* makeSkillDeploymentTransactions;
      const transaction = yield* transactions.allocate(input.targetRoot, input.key);
      yield* fs.copy(input.sourcePath, transaction.stage);
      yield* fs.writeFileString(transaction.markerStage, originalMarker);
      const identity = NodeFS.lstatSync(transaction.stage, { bigint: true });
      yield* transactions.write(transaction.directory, {
        schemaVersion: 1,
        providerInstanceId: input.providerInstanceId,
        key: input.key,
        targetRoot: input.targetRoot,
        operation: "install",
        phase: "prepared",
        previousTarget: false,
        previousMarker: originalMarker,
        nextMarker: originalMarker,
        nextPackageIdentity: { device: String(identity.dev), inode: String(identity.ino) },
      });
      yield* fs.rename(transaction.stage, target);
      const externallyRetained = path.join(
        path.dirname(input.targetRoot),
        "externally-retained-original",
      );
      yield* fs.rename(target, externallyRetained);
      yield* fs.copy(input.sourcePath, target);
      const restarted = yield* makeSkillDeploymentService;
      yield* restarted.status(input).pipe(Effect.flip);
      expect(yield* fs.exists(target)).toBe(true);
      expect(yield* fs.exists(externallyRetained)).toBe(true);
      expect(yield* fs.exists(transaction.directory)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains a live same-byte package when a legacy prepared journal cannot prove its identity",
    () =>
      Effect.gen(function* () {
        const { fs, input, target, originalMarker } = yield* makeOrphanFixture();
        const transactions = yield* makeSkillDeploymentTransactions;
        const transaction = yield* transactions.allocate(input.targetRoot, input.key);
        yield* fs.copy(input.sourcePath, transaction.stage);
        yield* fs.writeFileString(transaction.markerStage, originalMarker);
        yield* transactions.write(transaction.directory, {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetRoot: input.targetRoot,
          operation: "install",
          phase: "prepared",
          previousTarget: false,
          previousMarker: originalMarker,
          nextMarker: originalMarker,
        });
        yield* fs.rename(transaction.stage, target);
        const restarted = yield* makeSkillDeploymentService;
        yield* restarted.status(input).pipe(Effect.flip);
        expect(yield* fs.exists(target)).toBe(true);
        expect(yield* fs.exists(transaction.journal)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("installs unchanged source into its orphan marker on success", () =>
    Effect.gen(function* () {
      const { fs, service, input, target, marker, originalMarker, originalHash } =
        yield* makeOrphanFixture();
      expect(yield* fs.exists(target)).toBe(false);
      yield* service.install({ ...input, expectedHash: originalHash });
      expect(yield* hashSkillPackage(target)).toBe(originalHash);
      expect(yield* fs.readFileString(marker)).toBe(originalMarker);
      expect((yield* service.status(input)).state).toBe("owned");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "restores physical absence for an unchanged orphan reinstall when authority fails after publication",
    () =>
      Effect.gen(function* () {
        const { fs, service, input, target, marker, originalMarker, originalHash } =
          yield* makeOrphanFixture();
        let called = false;
        const authority = {
          commit: (action: () => void) =>
            Effect.sync(() => {
              action();
              called = true;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ManagedSkillRepositoryError({
                    code: "mutation_failed",
                    detail: "Transaction commit failed.",
                  }),
                ),
              ),
            ),
        };
        expect(
          (yield* service
            .install({ ...input, expectedHash: originalHash })
            .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip))
            .code,
        ).toBe("deployment_failed");
        expect(called).toBe(true);
        expect(yield* fs.exists(target)).toBe(false);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
        const restarted = yield* makeSkillDeploymentService;
        expect((yield* restarted.status(input)).state).toBe("drifted");
        expect(yield* fs.exists(target)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([0, 1, 2, 3])(
    "restores an orphan marker's absent package after restart at same-hash install boundary %s",
    (boundary) =>
      Effect.gen(function* () {
        const { fs, input, target, marker, originalMarker } = yield* makeOrphanFixture();
        const transactions = yield* makeSkillDeploymentTransactions;
        const transaction = yield* transactions.allocate(input.targetRoot, input.key);
        yield* fs.copy(input.sourcePath, transaction.stage);
        yield* fs.writeFileString(transaction.markerStage, originalMarker);
        yield* transactions.write(transaction.directory, {
          schemaVersion: 1,
          providerInstanceId: input.providerInstanceId,
          key: input.key,
          targetRoot: input.targetRoot,
          operation: "install",
          phase: "prepared",
          previousTarget: false,
          previousMarker: originalMarker,
          nextMarker: originalMarker,
          nextPackageIdentity: deploymentPackageIdentitySync(transaction.stage),
        });
        if (boundary >= 1) yield* fs.rename(marker, transaction.markerBackup);
        if (boundary >= 2) yield* fs.rename(transaction.stage, target);
        if (boundary >= 3) yield* fs.rename(transaction.markerStage, marker);
        const restarted = yield* makeSkillDeploymentService;
        expect((yield* restarted.status(input)).state).toBe("drifted");
        expect(yield* fs.exists(target)).toBe(false);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
        expect(yield* fs.exists(transaction.directory)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains user edits made during an orphan reinstall that later fails authority", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target, marker, originalMarker } =
        yield* makeOrphanFixture();
      const authority = {
        commit: (action: () => void) =>
          Effect.sync(action).pipe(
            Effect.andThen(
              fs.writeFileString(path.join(target, "SKILL.md"), "USER EDIT IN ORPHAN REINSTALL"),
            ),
            Effect.orDie,
            Effect.andThen(
              Effect.fail(
                new ManagedSkillRepositoryError({
                  code: "mutation_failed",
                  detail: "Transaction commit failed.",
                }),
              ),
            ),
          ),
      };
      yield* service
        .install(input)
        .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe(
        "USER EDIT IN ORPHAN REINSTALL",
      );
      expect(yield* fs.readFileString(marker)).toBe(originalMarker);
      const restarted = yield* makeSkillDeploymentService;
      yield* restarted.status(input).pipe(Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe(
        "USER EDIT IN ORPHAN REINSTALL",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([0, 1, 2, 3, 4])(
    "recovers an interrupted update at durable boundary %s after restart",
    (boundary) =>
      Effect.gen(function* () {
        const {
          fs,
          service: _oldService,
          input,
          target,
          marker,
          originalHash,
          originalMarker,
          transaction,
        } = yield* makeInterruptedFixture("install", boundary);
        const restarted = yield* makeSkillDeploymentService;
        expect(yield* restarted.listOwned(input)).toMatchObject([
          { key: input.key, state: "owned" },
        ]);
        expect(yield* hashSkillPackage(target)).toBe(originalHash);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
        expect(yield* fs.exists(transaction.directory)).toBe(false);
        yield* restarted.install(input);
        expect((yield* restarted.status(input)).state).toBe("owned");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([1, 2])(
    "recovers an interrupted uninstall at durable boundary %s without discoverable transaction packages",
    (boundary) =>
      Effect.gen(function* () {
        const { fs, path, input, target, originalHash, transaction } =
          yield* makeInterruptedFixture("uninstall", boundary);
        expect(
          path.relative(input.targetRoot, transaction.directory).startsWith(".." + path.sep),
        ).toBe(true);
        expect(
          (yield* fs.readDirectory(input.targetRoot)).filter((name) => !name.startsWith(".")),
        ).toEqual([]);
        const restarted = yield* makeSkillDeploymentService;
        expect((yield* restarted.status(input)).state).toBe("owned");
        expect(yield* hashSkillPackage(target)).toBe(originalHash);
        expect(yield* fs.exists(transaction.directory)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["install", "uninstall"] as const)(
    "finishes committed %s cleanup after restart",
    (operation) =>
      Effect.gen(function* () {
        const { fs, input, target, sourceHash, transaction } = yield* makeInterruptedFixture(
          operation,
          operation === "install" ? 4 : 2,
          true,
        );
        const restarted = yield* makeSkillDeploymentService;
        expect((yield* restarted.status(input)).state).toBe(
          operation === "install" ? "owned" : "absent",
        );
        if (operation === "install") expect(yield* hashSkillPackage(target)).toBe(sourceHash);
        expect(yield* fs.exists(transaction.directory)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("partial cleanup outside native roots does not block inventory or reinstall", () =>
    Effect.gen(function* () {
      const { fs, path, input, target, transaction, originalHash } = yield* makeInterruptedFixture(
        "install",
        3,
      );
      const remove = NodeFS.rmSync;
      using _remove = vi.spyOn(NodeFS, "rmSync").mockImplementation((file, options) => {
        if (file === transaction.directory) {
          remove(path.join(transaction.stage, "SKILL.md"));
          throw new Error("Interrupted recursive cleanup");
        }
        remove(file, options);
      });
      const faulted = yield* makeSkillDeploymentService;
      expect((yield* faulted.status(input)).state).toBe("owned");
      expect(yield* hashSkillPackage(target)).toBe(originalHash);
      expect(yield* fs.exists(transaction.directory)).toBe(true);
      const restarted = yield* makeSkillDeploymentService;
      expect((yield* restarted.status(input)).state).toBe("owned");
      yield* restarted.install(input);
      expect((yield* restarted.status(input)).state).toBe("owned");
      expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
        ".t3-managed-review.json",
        "review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains a save made to the live package at recovery's rename boundary", () =>
    Effect.gen(function* () {
      const { fs, path, input, target, transaction } = yield* makeInterruptedFixture("install", 3);
      const rename = NodeFS.renameSync;
      let injected = false;
      using _rename = vi.spyOn(NodeFS, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (from === target && to === transaction.stage) {
          injected = true;
          NodeFS.writeFileSync(
            path.join(transaction.stage, "SKILL.md"),
            "USER EDIT MADE DURING RECOVERY",
          );
        }
      });
      const restarted = yield* makeSkillDeploymentService;
      yield* restarted.status(input).pipe(Effect.flip);
      expect(injected).toBe(true);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe(
        "USER EDIT MADE DURING RECOVERY",
      );
      expect(yield* fs.exists(transaction.directory)).toBe(true);
      expect(yield* fs.exists(transaction.backup)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains a staged save made after rollback but before recursive cleanup", () =>
    Effect.gen(function* () {
      const { fs, path, input, target, transaction, originalHash } = yield* makeInterruptedFixture(
        "install",
        3,
      );
      const rename = NodeFS.renameSync;
      let injected = false;
      using _rename = vi.spyOn(NodeFS, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to === transaction.journal) {
          injected = true;
          NodeFS.writeFileSync(
            path.join(transaction.stage, "SKILL.md"),
            "USER EDIT BEFORE CLEANUP",
          );
        }
      });
      const restarted = yield* makeSkillDeploymentService;
      yield* restarted.status(input).pipe(Effect.flip);
      expect(injected).toBe(true);
      expect(yield* hashSkillPackage(target)).toBe(originalHash);
      expect(yield* fs.readFileString(path.join(transaction.stage, "SKILL.md"))).toBe(
        "USER EDIT BEFORE CLEANUP",
      );
      expect((yield* restarted.status(input)).state).toBe("owned");
      expect(yield* fs.readFileString(path.join(transaction.stage, "SKILL.md"))).toBe(
        "USER EDIT BEFORE CLEANUP",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves edited recovery backups and an unowned replacement", () =>
    Effect.gen(function* () {
      const { fs, path, input, target, transaction } = yield* makeInterruptedFixture(
        "uninstall",
        2,
      );
      yield* fs.writeFileString(path.join(transaction.backup, "SKILL.md"), "edited backup");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(path.join(target, "SKILL.md"), "user replacement");
      const restarted = yield* makeSkillDeploymentService;
      yield* restarted.status(input).pipe(Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe("user replacement");
      expect(yield* fs.readFileString(path.join(transaction.backup, "SKILL.md"))).toBe(
        "edited backup",
      );
      expect(yield* fs.exists(transaction.journal)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "restores both live paths if authority fails after running the uninstall callback",
    () =>
      Effect.gen(function* () {
        const { fs, service, input, target, marker, originalHash, originalMarker } =
          yield* makeOwnedFixture();
        const authority = {
          commit: (action: () => void) =>
            Effect.sync(action).pipe(
              Effect.andThen(
                Effect.fail(
                  new ManagedSkillRepositoryError({
                    code: "mutation_failed",
                    detail: "Transaction commit failed.",
                  }),
                ),
              ),
            ),
        };
        expect(
          (yield* service
            .uninstall(input)
            .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip))
            .code,
        ).toBe("deployment_failed");
        expect((yield* service.status(input)).state).toBe("owned");
        expect(yield* hashSkillPackage(target)).toBe(originalHash);
        expect(yield* fs.readFileString(marker)).toBe(originalMarker);
        expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
          ".t3-managed-review.json",
          "review",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains a user replacement made before post-callback uninstall failure", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target } = yield* makeOwnedFixture();
      const authority = {
        commit: (action: () => void) =>
          Effect.sync(action).pipe(
            Effect.andThen(fs.makeDirectory(target)),
            Effect.andThen(fs.writeFileString(path.join(target, "SKILL.md"), "user replacement")),
            Effect.orDie,
            Effect.andThen(
              Effect.fail(
                new ManagedSkillRepositoryError({
                  code: "mutation_failed",
                  detail: "Transaction commit failed.",
                }),
              ),
            ),
          ),
      };
      yield* service
        .uninstall(input)
        .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe("user replacement");
      yield* service.status(input).pipe(Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe("user replacement");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not publish or remove when final mutation authority is revoked", () =>
    Effect.gen(function* () {
      const { fs, service, input, target, marker, originalHash, originalMarker } =
        yield* makeOwnedFixture();
      let attempted = 0;
      const authority = {
        commit: (_action: () => void) =>
          Effect.sync(() => {
            attempted++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ManagedSkillRepositoryError({
                  code: "mutation_failed",
                  detail: "Permission revoked.",
                }),
              ),
            ),
          ),
      };
      expect(
        (yield* service
          .install(input)
          .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip)).code,
      ).toBe("deployment_failed");
      expect(
        (yield* service
          .uninstall(input)
          .pipe(Effect.provideService(SkillMutationCommitAuthority, authority), Effect.flip)).code,
      ).toBe("deployment_failed");
      expect(attempted).toBe(2);
      expect(yield* hashSkillPackage(target)).toBe(originalHash);
      expect(yield* fs.readFileString(marker)).toBe(originalMarker);
      expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
        ".t3-managed-review.json",
        "review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rechecks installed bytes at the guarded swap and commits authorized updates", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target } = yield* makeOwnedFixture();
      const commit = (action: () => void) =>
        Effect.try({
          try: action,
          catch: (cause) =>
            new ManagedSkillRepositoryError({
              code: "mutation_failed",
              detail: "Guarded swap failed.",
              cause,
            }),
        });
      yield* service
        .install(input)
        .pipe(Effect.provideService(SkillMutationCommitAuthority, { commit }));
      expect((yield* service.status(input)).state).toBe("owned");
      const lateEdit = {
        commit: (action: () => void) =>
          fs
            .writeFileString(path.join(target, "SKILL.md"), "edited at commit")
            .pipe(Effect.orDie, Effect.andThen(commit(action))),
      };
      yield* service
        .install(input)
        .pipe(Effect.provideService(SkillMutationCommitAuthority, lateEdit), Effect.flip);
      expect(yield* fs.readFileString(path.join(target, "SKILL.md"))).toBe("edited at commit");
      expect((yield* service.status(input)).state).toBe("drifted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("pins the selected source hash until copying begins", () =>
    Effect.gen(function* () {
      const { service, input, originalHash } = yield* makeOwnedFixture();
      expect(
        (yield* service.install({ ...input, expectedHash: originalHash }).pipe(Effect.flip)).code,
      ).toBe("invalid_source");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects edited manifest identity even when content hashes still match", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target } = yield* makeOwnedFixture();
      const manifest = yield* fs.readFileString(path.join(target, "t3-skill.json"));
      yield* fs.writeFileString(
        path.join(target, "t3-skill.json"),
        manifest.replace("id-review", "id-foreign"),
      );
      expect((yield* service.status(input)).state).toBe("drifted");
      expect((yield* service.install(input).pipe(Effect.flip)).code).toBe("installed_drift");
      expect((yield* service.uninstall(input).pipe(Effect.flip)).code).toBe("installed_drift");
      expect(yield* fs.readFileString(path.join(target, "t3-skill.json"))).toContain("id-foreign");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects another instance and recovers an owned marker after its package disappears",
    () =>
      Effect.gen(function* () {
        const { fs, service, input, target, marker } = yield* makeOwnedFixture();
        const foreign = { ...input, providerInstanceId: ProviderInstanceId.make("other-codex") };
        expect((yield* service.install(foreign).pipe(Effect.flip)).code).toBe("ownership_mismatch");
        yield* fs.remove(target, { recursive: true });
        expect((yield* service.install(foreign).pipe(Effect.flip)).code).toBe("ownership_mismatch");
        yield* service.install(input);
        expect((yield* service.status(input)).state).toBe("owned");
        yield* fs.remove(target, { recursive: true });
        yield* service.uninstall(input);
        expect(yield* fs.exists(marker)).toBe(false);
        yield* service.install(input);
        yield* service.uninstall(input);
        expect((yield* service.status(input)).state).toBe("absent");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes competing instance writes to the same destination", () =>
    Effect.gen(function* () {
      const { service, input } = yield* makeOwnedFixture();
      yield* service.uninstall(input);
      const results = yield* Effect.all(
        [
          service.install(input).pipe(Effect.result),
          service
            .install({ ...input, providerInstanceId: ProviderInstanceId.make("other-codex") })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds and removes an owned install after its managed source is deleted", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target } = yield* makeOwnedFixture();
      yield* fs.remove(path.dirname(input.sourcePath), { recursive: true });
      const installed = yield* service.listOwned({
        providerInstanceId: input.providerInstanceId,
        targetRoot: input.targetRoot,
      });
      expect(installed).toMatchObject([{ key: input.key, state: "owned" }]);
      yield* service.uninstall({ ...input, sourcePath: "" });
      expect(yield* fs.exists(target)).toBe(false);
      expect(
        yield* service.listOwned({
          providerInstanceId: input.providerInstanceId,
          targetRoot: input.targetRoot,
        }),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect.each([
    "copy",
    "staged-validation",
    "marker-stage",
    "target-backup",
    "marker-backup",
    "target-publish",
    "marker-publish",
  ] as const)("preserves the owned package and marker after %s failure", (stage) =>
    Effect.gen(function* () {
      const fixture = yield* makeOwnedFixture();
      const { fs, path, input, target, marker, service } = fixture;
      let injected = 0;
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: stage,
      });
      const faulted = yield* makeSkillDeploymentService.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          copy: (from, to, ...args) =>
            fs.copy(from, to, ...args).pipe(
              Effect.flatMap(() => {
                if (stage === "copy") {
                  injected += 1;
                  return Effect.fail(failure);
                }
                if (stage === "staged-validation") {
                  injected += 1;
                  return fs.writeFileString(path.join(to, "SKILL.md"), "changed during copy");
                }
                return Effect.void;
              }),
            ),
          writeFileString: (file, content, ...args) => {
            if (stage === "marker-stage" && path.basename(file) === "next-marker.json") {
              injected += 1;
              return Effect.fail(failure);
            }
            return fs.writeFileString(file, content, ...args);
          },
          rename: (from, to) => {
            const matches =
              stage === "target-backup"
                ? from === target
                : stage === "marker-backup"
                  ? from === marker
                  : stage === "target-publish"
                    ? path.basename(from) === "pending"
                    : stage === "marker-publish"
                      ? path.basename(from) === "next-marker.json"
                      : false;
            if (matches) {
              injected += 1;
              return Effect.fail(failure);
            }
            return fs.rename(from, to);
          },
        }),
      );
      const error = yield* faulted.install(input).pipe(Effect.flip);
      expect(error.code).toBe(
        stage === "staged-validation" ? "invalid_source" : "deployment_failed",
      );
      expect(injected).toBe(1);
      expect(yield* hashSkillPackage(target)).toBe(fixture.originalHash);
      expect(yield* fs.readFileString(marker)).toBe(fixture.originalMarker);
      expect((yield* service.status(input)).state).toBe("owned");
      expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
        ".t3-managed-review.json",
        "review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the target when uninstall cannot rename its ownership marker", () =>
    Effect.gen(function* () {
      const fixture = yield* makeOwnedFixture();
      const { fs, input, target, marker, service } = fixture;
      let injected = 0;
      const faulted = yield* makeSkillDeploymentService.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) => {
            if (from === marker) {
              injected += 1;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              );
            }
            return fs.rename(from, to);
          },
        }),
      );
      const error = yield* faulted.uninstall(input).pipe(Effect.flip);
      expect(error.code).toBe("deployment_failed");
      expect(injected).toBe(1);
      expect(yield* hashSkillPackage(target)).toBe(fixture.originalHash);
      expect(yield* fs.readFileString(marker)).toBe(fixture.originalMarker);
      expect((yield* service.status(input)).state).toBe("owned");
      expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
        ".t3-managed-review.json",
        "review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses collisions and protects drifted owned deployments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-deployment-" });
      const source = path.join(root, "source", "review");
      const targetRoot = path.join(root, "provider-skills");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "t3-skill.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "managed-skill",
          id: "id-review",
          key: "review",
          scope: "global",
          origin: "created",
          ownership: "t3",
          revision: { revision: 1, hash: "pending" },
        }),
      );
      yield* fs.writeFileString(
        path.join(source, "SKILL.md"),
        "---\nname: review\ndescription: Review changes\n---\nReview.",
      );
      const sourceHash = yield* hashSkillPackage(source);
      yield* fs.writeFileString(
        path.join(source, "t3-skill.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "managed-skill",
          id: "id-review",
          key: "review",
          scope: "global",
          origin: "created",
          ownership: "t3",
          revision: { revision: 1, hash: sourceHash },
        }),
      );
      const service = yield* makeSkillDeploymentService;
      const input = {
        providerInstanceId: ProviderInstanceId.make("codex"),
        targetRoot,
        key: ManagedSkillKey.make("review"),
        sourcePath: source,
      };
      expect((yield* service.install(input)).state).toBe("owned");
      expect((yield* service.status(input)).state).toBe("owned");
      yield* fs.writeFileString(path.join(targetRoot, "review", "SKILL.md"), "changed");
      expect((yield* service.status(input)).state).toBe("drifted");
      const updateFailure = yield* service.install(input).pipe(Effect.flip);
      expect(updateFailure.code).toBe("installed_drift");
      const uninstallFailure = yield* service.uninstall(input).pipe(Effect.flip);
      expect(uninstallFailure.code).toBe("installed_drift");

      const collisionRoot = path.join(root, "collision");
      yield* fs.makeDirectory(path.join(collisionRoot, "review"), { recursive: true });
      const collision = yield* service
        .install({ ...input, targetRoot: collisionRoot })
        .pipe(Effect.flip);
      expect(collision.code).toBe("destination_collision");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
