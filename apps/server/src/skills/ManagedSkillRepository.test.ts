import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type {
  ManagedSkillContent,
  ManagedSkillId,
  ManagedSkillKey,
  SkillContentHash,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import { hashSkillPackage } from "./SkillPackage.ts";

const TestLayer = ManagedSkillRepository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-skills-" })),
  Layer.provideMerge(NodeServices.layer),
);

const key = (value: string) => value as ManagedSkillKey;
const hash = (value: string) => value as SkillContentHash;
const content = (value: string, body: string): ManagedSkillContent => ({
  key: key(value),
  name: `Skill ${value}`,
  body,
});

describe("ManagedSkillRepository", () => {
  it.layer(TestLayer)("global packages", (it) => {
    it.effect("supports CRUD, immutable ids, conflicts, collisions, and reconstruction", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("deploy", "one"),
        });
        const originalId = created.manifest.id;
        const conflict = yield* repository
          .updateGlobal({
            skillId: originalId,
            expectedHash: hash("wrong"),
            content: { name: "Deploy", body: "two" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(conflict));
        if (Result.isFailure(conflict))
          assert.deepInclude(conflict.failure, { code: "revision_conflict" });

        const updated = yield* repository.updateGlobal({
          skillId: originalId,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Deploy", body: "two" },
        });
        assert.equal(updated.manifest.id, originalId);
        assert.equal(updated.manifest.revision.revision, 2);
        assert.equal(updated.content.body, "two");

        yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("review", "review"),
        });
        const collision = yield* repository
          .renameGlobal({
            skillId: originalId,
            expectedHash: updated.manifest.revision.hash,
            key: key("review"),
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(collision));
        if (Result.isFailure(collision))
          assert.deepInclude(collision.failure, { code: "destination_collision" });

        const renamed = yield* repository.renameGlobal({
          skillId: originalId,
          expectedHash: updated.manifest.revision.hash,
          key: key("release"),
        });
        assert.equal(renamed.manifest.id, originalId);
        assert.equal(renamed.manifest.key, "release");
        assert.equal(renamed.content.key, "release");

        const reconstructed = yield* ManagedSkillRepository.make;
        assert.deepEqual(
          (yield* reconstructed.listGlobal()).map((entry) => String(entry.manifest?.key)),
          ["release", "review"],
        );

        yield* repository.deleteGlobal({
          skillId: originalId,
          expectedHash: renamed.manifest.revision.hash,
        });
        assert.equal(
          (yield* repository.listGlobal()).some((entry) => entry.manifest?.id === originalId),
          false,
        );
        assert.include(
          (yield* repository.listGlobalHistory(originalId)).map((entry) => entry.revision),
          3,
        );
      }),
    );

    it.effect("bounds history and rolls an old snapshot forward as a new revision", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        let current = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("history", "body-0"),
        });
        const firstHash = current.manifest.revision.hash;
        for (let index = 1; index <= 22; index += 1) {
          current = yield* repository.updateGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            content: { name: "History", body: `body-${index}` },
          });
        }
        const history = yield* repository.listGlobalHistory(current.manifest.id);
        assert.equal(history.length, 20);
        assert.equal(history[0]?.revision, 3);

        const rolledBack = yield* repository.rollbackGlobal({
          skillId: current.manifest.id,
          expectedHash: current.manifest.revision.hash,
          revision: 3,
        });
        assert.equal(rolledBack.manifest.revision.revision, 24);
        assert.equal(rolledBack.content.body, "body-2");
        assert.notEqual(rolledBack.manifest.revision.hash, firstHash);
      }),
    );

    it.effect("rolls a pre-rename snapshot forward under the current key", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const alpha = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("alpha", "one"),
        });
        const beta = yield* repository.renameGlobal({
          skillId: alpha.manifest.id,
          expectedHash: alpha.manifest.revision.hash,
          key: key("beta"),
        });
        const third = yield* repository.updateGlobal({
          skillId: beta.manifest.id,
          expectedHash: beta.manifest.revision.hash,
          content: { name: "Beta", body: "three" },
        });
        const restored = yield* repository.rollbackGlobal({
          skillId: third.manifest.id,
          expectedHash: third.manifest.revision.hash,
          revision: 1,
        });
        assert.equal(restored.manifest.key, "beta");
        assert.equal(restored.content.key, "beta");
        assert.equal(restored.content.body, "one");
        assert.equal(restored.manifest.revision.revision, 4);
        assert.equal(restored.manifest.id, alpha.manifest.id);
        assert.equal(
          (yield* repository.listGlobal()).some((entry) => entry.directoryName === "alpha"),
          false,
        );
      }),
    );

    it.effect(
      "round trips imported frontmatter and assets through edit, rename, and rollback",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const projectRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-managed-skill-project-",
          });
          const codexExtension = "interface:\n  display_name: Portable\n";
          const imported = yield* repository.importGlobal({
            expectedRevision: 0,
            content: {
              ...content("portable", "original"),
              frontmatter: {
                license: "MIT",
                "disable-model-invocation": true,
                "allowed-tools": ["Bash"],
              },
            },
            files: [
              { relativePath: "references/release.txt", bytes: new TextEncoder().encode("v1") },
              {
                relativePath: "providers/codex/openai.yaml",
                bytes: new TextEncoder().encode(codexExtension),
              },
            ],
          });
          const sourceHash = NodeCrypto.createHash("sha256").update(codexExtension).digest("hex");
          const edited = yield* repository.updateGlobal({
            skillId: imported.manifest.id,
            expectedHash: imported.manifest.revision.hash,
            content: { name: "Portable edited", body: "edited" },
          });
          assert.deepEqual(edited.content.frontmatter, imported.content.frontmatter);
          assert.deepEqual(edited.content.assetPaths, [
            "providers/codex/openai.yaml",
            "references/release.txt",
          ]);
          assert.equal(
            yield* fs.readFileString(path.join(edited.packagePath, "providers/codex/openai.yaml")),
            codexExtension,
          );
          assert.equal(
            yield* fs.readFileString(path.join(edited.packagePath, "references/release.txt")),
            "v1",
          );
          const renamed = yield* repository.renameGlobal({
            skillId: edited.manifest.id,
            expectedHash: edited.manifest.revision.hash,
            key: key("release-portable"),
          });
          assert.deepEqual(renamed.content.frontmatter, imported.content.frontmatter);
          assert.equal(
            yield* fs.readFileString(path.join(renamed.packagePath, "providers/codex/openai.yaml")),
            codexExtension,
          );
          const rolledBack = yield* repository.rollbackGlobal({
            skillId: renamed.manifest.id,
            expectedHash: renamed.manifest.revision.hash,
            revision: 1,
          });
          assert.equal(rolledBack.content.body, "original");
          assert.deepEqual(rolledBack.content.frontmatter, imported.content.frontmatter);
          assert.deepEqual(rolledBack.content.assetPaths, [
            "providers/codex/openai.yaml",
            "references/release.txt",
          ]);
          assert.equal(
            yield* fs.readFileString(
              path.join(rolledBack.packagePath, "providers/codex/openai.yaml"),
            ),
            codexExtension,
          );
          assert.equal(
            yield* fs.readFileString(path.join(rolledBack.packagePath, "references/release.txt")),
            "v1",
          );
          assert.equal(
            NodeCrypto.createHash("sha256")
              .update(
                yield* fs.readFileString(
                  path.join(rolledBack.packagePath, "providers/codex/openai.yaml"),
                ),
              )
              .digest("hex"),
            sourceHash,
          );
          const projectOverride = yield* repository.setProjectOverride({
            projectRoot,
            key: key("release-portable"),
            content: { name: "Project portable", body: "project" },
          });
          assert.equal(
            yield* fs.readFileString(
              path.join(projectOverride.packagePath, "providers/codex/openai.yaml"),
            ),
            codexExtension,
          );
        }),
    );

    it.effect(
      "rejects a copied rollback snapshot that differs from the selected history entry",
      () =>
        Effect.gen(function* () {
          const base = yield* ManagedSkillRepository.ManagedSkillRepository;
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const created = yield* base.createGlobal({
            expectedRevision: 0,
            content: content("copy-mismatch", "one"),
          });
          const current = yield* base.updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Copy mismatch", body: "two" },
          });
          const snapshot = path.join(config.skillHistoryDir, current.manifest.id, "1");
          const manifestPath = path.join(snapshot, "t3-skill.json");
          const unexpectedAsset = path.join(snapshot, "unexpected.txt");
          const currentManifestPath = path.join(current.packagePath, "t3-skill.json");
          const currentSkillPath = path.join(current.packagePath, "SKILL.md");
          const originalManifest = yield* fs.readFileString(manifestPath);
          const originalSkill = yield* fs.readFileString(path.join(snapshot, "SKILL.md"));
          const currentManifest = yield* fs.readFileString(currentManifestPath);
          const currentSkill = yield* fs.readFileString(currentSkillPath);
          const historyBefore = yield* fs.readDirectory(path.dirname(snapshot));
          const outside = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-copy-mismatch-outside-",
          });
          const outsideSentinel = path.join(outside, "sentinel.txt");
          yield* fs.writeFileString(outsideSentinel, "outside unchanged");
          let rewrites = 0;
          const repository = yield* ManagedSkillRepository.makeWith({
            copyStageContents: (source, destination, copy) =>
              Effect.acquireUseRelease(
                Effect.gen(function* () {
                  yield* fs.writeFileString(unexpectedAsset, "copied only");
                  const changedHash = yield* hashSkillPackage(snapshot).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                    Effect.orDie,
                  );
                  // @effect-diagnostics-next-line preferSchemaOverJson:off
                  const manifest = JSON.parse(originalManifest) as {
                    revision: { revision: number; hash: string };
                  };
                  manifest.revision.hash = changedHash;
                  // @effect-diagnostics-next-line preferSchemaOverJson:off
                  yield* fs.writeFileString(manifestPath, `${JSON.stringify(manifest)}\n`);
                }),
                () => copy(source, destination),
                () =>
                  fs
                    .writeFileString(manifestPath, originalManifest)
                    .pipe(
                      Effect.andThen(fs.remove(unexpectedAsset, { force: true })),
                      Effect.orDie,
                    ),
              ),
            duringStagePopulation: () =>
              Effect.sync(() => {
                rewrites += 1;
              }),
          });

          const result = yield* repository
            .rollbackGlobal({
              skillId: current.manifest.id,
              expectedHash: current.manifest.revision.hash,
              revision: 1,
            })
            .pipe(Effect.result);

          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.deepInclude(result.failure, { code: "invalid_package" });
            if (result.failure._tag === "ManagedSkillRepositoryError") {
              assert.include(result.failure.detail, "snapshot changed");
            }
          }
          assert.equal(rewrites, 0);
          assert.equal((yield* base.readGlobal(current.manifest.id)).content.body, "two");
          assert.equal(yield* fs.readFileString(currentManifestPath), currentManifest);
          assert.equal(yield* fs.readFileString(currentSkillPath), currentSkill);
          assert.equal(yield* fs.readFileString(manifestPath), originalManifest);
          assert.equal(yield* fs.readFileString(path.join(snapshot, "SKILL.md")), originalSkill);
          assert.deepEqual(yield* fs.readDirectory(path.dirname(snapshot)), historyBefore);
          assert.equal(yield* fs.readFileString(outsideSentinel), "outside unchanged");
          assert.deepEqual(
            (yield* fs.readDirectory(config.managedSkillsDir)).filter((name) =>
              name.startsWith(".copy-mismatch."),
            ),
            [],
          );
        }),
    );

    it.effect("ignores noncanonical history aliases when listing and pruning", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let current = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("canonical-history", "zero"),
        });
        for (let revision = 2; revision <= 21; revision += 1) {
          current = yield* repository.updateGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            content: { name: "Canonical history", body: String(revision) },
          });
        }
        const historyRoot = path.join(config.skillHistoryDir, current.manifest.id);
        const aliases = [["020", "directory alias"] as const, ["+20", "signed alias"] as const];
        for (const [name, bytes] of aliases) {
          yield* fs.makeDirectory(path.join(historyRoot, name));
          yield* fs.writeFileString(path.join(historyRoot, name, "sentinel.txt"), bytes);
        }
        const aliasFiles = [
          ["0020", "file alias"] as const,
          ["20 ", "whitespace alias"] as const,
          ["external", "external entry"] as const,
        ];
        for (const [name, bytes] of aliasFiles) {
          yield* fs.writeFileString(path.join(historyRoot, name), bytes);
        }
        const external = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-canonical-history-external-",
        });
        const externalSentinel = path.join(external, "sentinel.txt");
        const aliasLink = path.join(historyRoot, "020-link");
        yield* fs.writeFileString(externalSentinel, "linked external entry");
        yield* fs.symlink(external, aliasLink);

        current = yield* repository.updateGlobal({
          skillId: current.manifest.id,
          expectedHash: current.manifest.revision.hash,
          content: { name: "Canonical history", body: "twenty-two" },
        });

        assert.deepEqual(
          (yield* repository.listGlobalHistory(current.manifest.id)).map((entry) => entry.revision),
          Array.from({ length: 20 }, (_, index) => index + 2),
        );
        for (const [name, bytes] of aliases) {
          assert.equal(
            yield* fs.readFileString(path.join(historyRoot, name, "sentinel.txt")),
            bytes,
          );
        }
        for (const [name, bytes] of aliasFiles) {
          assert.equal(yield* fs.readFileString(path.join(historyRoot, name)), bytes);
        }
        assert.equal(yield* fs.readLink(aliasLink), external);
        assert.equal(yield* fs.readFileString(externalSentinel), "linked external entry");
        assert.deepEqual(
          (yield* fs.readDirectory(config.managedSkillsDir)).filter(
            (name) => name.includes(".tmp-") || name.includes(".rollback-"),
          ),
          [],
        );
      }),
    );

    it.effect("rejects traversal ids before touching history paths", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const unsafe = "../../victim" as ManagedSkillId;
        const listed = yield* repository.listGlobalHistory(unsafe).pipe(Effect.result);
        assert.isTrue(Result.isFailure(listed));
        if (Result.isFailure(listed))
          assert.deepInclude(listed.failure, { code: "invalid_package" });
      }),
    );

    it.effect("does not list or prune numeric history that fails ownership validation", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        let current = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("owned-history", "zero"),
        });
        current = yield* repository.updateGlobal({
          skillId: current.manifest.id,
          expectedHash: current.manifest.revision.hash,
          content: { name: "History", body: "one" },
        });
        const historyRoot = path.join(config.skillHistoryDir, current.manifest.id);
        const foreign = path.join(historyRoot, "999");
        yield* fs.copy(path.join(historyRoot, "1"), foreign);
        yield* fs.writeFileString(
          path.join(foreign, "t3-skill.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify({
            schemaVersion: 1,
            kind: "managed-skill",
            id: "different-id",
            key: "owned-history",
            scope: "global",
            revision: { revision: 999, hash: current.manifest.revision.hash },
            origin: "created",
            ownership: "t3",
          })}\n`,
        );
        for (let revision = 2; revision <= 22; revision += 1) {
          current = yield* repository.updateGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            content: { name: "History", body: String(revision) },
          });
        }
        assert.isTrue(yield* fs.exists(foreign));
        assert.notInclude(
          (yield* repository.listGlobalHistory(current.manifest.id)).map((entry) => entry.revision),
          999,
        );
        const rollback = yield* repository
          .rollbackGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            revision: 999,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rollback));
        if (Result.isFailure(rollback))
          assert.deepInclude(rollback.failure, { code: "invalid_package" });
      }),
    );

    it.effect("does not follow a symlinked numeric history revision", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("linked-history", "one"),
        });
        const current = yield* repository.updateGlobal({
          skillId: created.manifest.id,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Linked history", body: "two" },
        });
        const revision = path.join(config.skillHistoryDir, current.manifest.id, "1");
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-linked-revision-" });
        yield* fs.copy(revision, outside);
        const outsideBody = yield* fs.readFileString(path.join(outside, "SKILL.md"));
        yield* fs.remove(revision, { recursive: true });
        yield* fs.symlink(outside, revision);

        assert.notInclude(
          (yield* repository.listGlobalHistory(current.manifest.id)).map((entry) => entry.revision),
          1,
        );
        const rollback = yield* repository
          .rollbackGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            revision: 1,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rollback));
        if (Result.isFailure(rollback))
          assert.deepInclude(rollback.failure, { code: "invalid_package" });
        assert.equal(yield* fs.readFileString(path.join(outside, "SKILL.md")), outsideBody);
        assert.equal((yield* repository.readGlobal(current.manifest.id)).content.body, "two");
      }),
    );

    it.effect("rejects a child symlink raced in at the native copy boundary", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("copy-race", "one"),
        });
        const current = yield* base.updateGlobal({
          skillId: created.manifest.id,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Copy race", body: "two" },
        });
        const snapshot = path.join(config.skillHistoryDir, current.manifest.id, "1");
        const skill = path.join(snapshot, "SKILL.md");
        const backup = path.join(snapshot, ".seam-backup");
        const original = yield* fs.readFileString(skill);
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copy-race-outside-" });
        const outsideSkill = path.join(outside, "SKILL.md");
        yield* fs.writeFileString(outsideSkill, "outside sentinel");
        let boundary = 0;
        let restored = 0;
        let populated = 0;
        const repository = yield* ManagedSkillRepository.makeWith({
          copyStageContents: (source, destination, copy) =>
            Effect.acquireUseRelease(
              fs.rename(skill, backup).pipe(
                Effect.andThen(fs.symlink(outsideSkill, skill)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    boundary += 1;
                  }),
                ),
              ),
              () => copy(source, destination),
              () =>
                fs.remove(skill).pipe(
                  Effect.andThen(fs.rename(backup, skill)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      restored += 1;
                    }),
                  ),
                  Effect.orDie,
                ),
            ),
          duringStagePopulation: () =>
            Effect.sync(() => {
              populated += 1;
            }),
        });
        const result = yield* repository
          .rollbackGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            revision: 1,
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.deepInclude(result.failure, { code: "invalid_package" });
        assert.equal(boundary, 1);
        assert.equal(restored, 1);
        assert.equal(populated, 0);
        assert.equal(yield* fs.readFileString(outsideSkill), "outside sentinel");
        assert.equal(yield* fs.readFileString(skill), original);
        assert.isFalse(yield* fs.exists(backup));
      }),
    );

    it.effect("serializes rename before update from lookup through commit", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("race", "one"),
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const requested = yield* Deferred.make<void>();
        let writerBAcquisitions = 0;
        let writerBStages = 0;
        const repository = yield* ManagedSkillRepository.makeWith({
          duringStagePopulation: (tag) =>
            tag === "A"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          onMutationPermitRequest: (tag) =>
            tag === "B" ? Deferred.succeed(requested, undefined) : Effect.void,
          onMutationPermitAcquired: (tag) =>
            tag === "B"
              ? Effect.sync(() => {
                  writerBAcquisitions += 1;
                })
              : Effect.void,
          onStageDirectoryCreated: (tag) =>
            tag === "B"
              ? Effect.sync(() => {
                  writerBStages += 1;
                })
              : Effect.void,
        });
        const writerA = yield* repository
          .renameGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            key: key("race-renamed"),
            operationTag: "A",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const writerB = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Race", body: "B" },
            operationTag: "B",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        assert.equal(writerBAcquisitions, 0);
        assert.equal(writerBStages, 0);
        yield* Deferred.succeed(release, undefined);
        const first = yield* Fiber.await(writerA);
        const second = yield* Fiber.await(writerB);
        assert.isTrue(first._tag === "Success");
        assert.isTrue(second._tag === "Failure");
        if (second._tag === "Failure") {
          assert.deepInclude(Cause.squash(second.cause), { code: "revision_conflict" });
        }
        assert.equal(writerBAcquisitions, 1);
        assert.equal(writerBStages, 0);
        const current = yield* base.readGlobal(created.manifest.id);
        assert.equal(current.manifest.key, "race-renamed");
        assert.equal(current.content.body, "one");
        assert.deepEqual(
          (yield* base.listGlobalHistory(created.manifest.id)).map((entry) => entry.revision),
          [1],
        );
        assert.deepEqual(
          (yield* fs.readDirectory(config.managedSkillsDir)).filter(
            (name) => name.includes(".tmp-") || name.includes(".rollback-"),
          ),
          [],
        );
      }),
    );
  });

  it.layer(TestLayer)("project state", (it) => {
    it.effect("conflicts on stale expected hashes when project state is absent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-absent-project-" });
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;

        const override = yield* repository
          .setProjectOverride({
            projectRoot,
            key: key("missing-override"),
            expectedHash: hash("stale"),
            content: { name: "Missing", body: "no" },
          })
          .pipe(Effect.result);
        const disabled = yield* repository
          .setProjectDisabled({
            projectRoot,
            key: key("missing-disabled"),
            expectedHash: hash("stale"),
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(override));
        if (Result.isFailure(override))
          assert.deepInclude(override.failure, { code: "revision_conflict" });
        assert.isTrue(Result.isFailure(disabled));
        if (Result.isFailure(disabled))
          assert.deepInclude(disabled.failure, { code: "revision_conflict" });
        const skillsRoot = path.join(projectRoot, ".t3code", "skills");
        assert.deepEqual(yield* fs.readDirectory(skillsRoot), []);
      }),
    );

    it.effect("treats a project without managed metadata as an empty catalog", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-project-" });
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        assert.deepEqual(yield* repository.listProject(projectRoot), []);
        assert.isFalse(yield* fs.exists(`${projectRoot}/.t3code`));
      }),
    );

    it.effect("supports override, hash conflict, disabled tombstone, deletion, and rename", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-skills-" });
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const global = yield* repository.importGlobal({
          expectedRevision: 0,
          content: {
            ...content("deploy", "global"),
            frontmatter: { license: "MIT", "allowed-tools": ["Read"] },
          },
          files: [
            { relativePath: "references/deploy.txt", bytes: new TextEncoder().encode("global") },
          ],
        });
        const override = yield* repository.setProjectOverride({
          projectRoot,
          key: key("deploy"),
          content: { name: "Project deploy", body: "project" },
        });
        assert.notEqual(override.manifest.id, global.manifest.id);
        assert.equal(override.manifest.scope, "project");
        assert.deepEqual(override.content.frontmatter, global.content.frontmatter);
        assert.deepEqual(override.content.assetPaths, ["references/deploy.txt"]);
        assert.equal(
          yield* fs.readFileString(path.join(override.packagePath, "references/deploy.txt")),
          "global",
        );
        yield* repository.updateGlobal({
          skillId: global.manifest.id,
          expectedHash: global.manifest.revision.hash,
          content: { name: "Global changed", body: "changed" },
        });
        yield* repository.deleteGlobal({
          skillId: global.manifest.id,
          expectedHash: (yield* repository.readGlobal(global.manifest.id)).manifest.revision.hash,
        });
        const isolatedOverride = yield* repository.readProject(projectRoot, override.manifest.id);
        assert.equal(isolatedOverride.content?.body, "project");
        assert.deepEqual(isolatedOverride.content?.frontmatter, global.content.frontmatter);
        const conflict = yield* repository
          .setProjectOverride({
            projectRoot,
            key: key("deploy"),
            expectedHash: hash("wrong"),
            content: { name: "Project deploy", body: "changed" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(conflict));

        const renamed = yield* repository.renameProject({
          projectRoot,
          skillId: override.manifest.id,
          expectedHash: override.manifest.revision.hash,
          key: key("release"),
        });
        assert.equal(renamed.manifest.id, override.manifest.id);
        assert.equal(renamed.manifest.key, "release");

        const disabled = yield* repository.setProjectDisabled({
          projectRoot,
          key: key("deploy"),
        });
        assert.equal(disabled.projectState, "disabled");
        assert.equal(disabled.content, undefined);
        yield* repository.deleteProjectState({
          projectRoot,
          key: key("deploy"),
          expectedHash: disabled.manifest.revision.hash,
        });
        assert.equal(
          (yield* repository.listProject(projectRoot)).some(
            (entry) => entry.manifest?.key === "deploy",
          ),
          false,
        );
        assert.equal(yield* fs.exists(path.join(projectRoot, ".t3")), false);
        assert.equal(yield* fs.exists(path.join(projectRoot, ".codex")), false);
        assert.equal(yield* fs.exists(path.join(projectRoot, ".claude")), false);
      }),
    );

    it.effect("serializes competing project writers with one deterministic winner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-race-" });
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.setProjectOverride({
          projectRoot,
          key: key("race"),
          content: { name: "Race", body: "one" },
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const requested = yield* Deferred.make<void>();
        const repository = yield* ManagedSkillRepository.makeWith({
          duringStagePopulation: (tag) =>
            tag === "A"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          onMutationPermitRequest: (tag) =>
            tag === "B" ? Deferred.succeed(requested, undefined) : Effect.void,
        });
        const writerA = yield* repository
          .setProjectOverride({
            projectRoot,
            key: key("race"),
            expectedHash: created.manifest.revision.hash,
            content: { name: "Race", body: "A" },
            operationTag: "A",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const writerB = yield* repository
          .setProjectOverride({
            projectRoot,
            key: key("race"),
            expectedHash: created.manifest.revision.hash,
            content: { name: "Race", body: "B" },
            operationTag: "B",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.await(writerA))._tag, "Success");
        assert.equal((yield* Fiber.await(writerB))._tag, "Failure");
        assert.equal(
          (yield* base.readProject(projectRoot, created.manifest.id)).content?.body,
          "A",
        );
      }),
    );
  });

  it.layer(TestLayer)("atomic replacement", (it) => {
    it.effect("revalidates a queued global root before lookup or stage creation", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const external = yield* Semaphore.make(1);
        yield* external.take(1);
        const requested = yield* Deferred.make<void>();
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-queued-root-" });
        let acquired = 0;
        let lookups = 0;
        let stages = 0;
        const repository = yield* ManagedSkillRepository.makeWith({
          makeMutationSemaphore: () => Effect.succeed(external),
          onMutationPermitRequest: () => Deferred.succeed(requested, undefined),
          onMutationPermitAcquired: () =>
            Effect.sync(() => {
              acquired += 1;
            }),
          onMutationLookup: () =>
            Effect.sync(() => {
              lookups += 1;
            }),
          onStageDirectoryCreated: () =>
            Effect.sync(() => {
              stages += 1;
            }),
        });
        const waiting = yield* repository
          .createGlobal({
            expectedRevision: 0,
            content: content("queued-root", "no"),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* fs.remove(config.managedSkillsDir, { recursive: true });
        yield* fs.symlink(outside, config.managedSkillsDir);
        yield* external.release(1);
        const result = yield* Fiber.await(waiting);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.deepInclude(Cause.squash(result.cause), { code: "invalid_package" });
        }
        assert.equal(acquired, 1);
        assert.equal(lookups, 0);
        assert.equal(stages, 0);
        assert.deepEqual(yield* fs.readDirectory(outside), []);
        yield* fs.remove(config.managedSkillsDir);
        yield* fs.makeDirectory(config.managedSkillsDir);
      }),
    );

    it.effect("cancels lock waiting without acquiring or staging and releases registration", () =>
      Effect.gen(function* () {
        const external = yield* Semaphore.make(1);
        yield* external.take(1);
        const registered = yield* Deferred.make<void>();
        const requested = yield* Deferred.make<void>();
        let acquired = false;
        let staged = false;
        let semaphoreCount = 0;
        const repository = yield* ManagedSkillRepository.makeWith({
          makeMutationSemaphore: () => {
            semaphoreCount += 1;
            return semaphoreCount === 1 ? Effect.succeed(external) : Semaphore.make(1);
          },
          onMutationLockRegistered: () => Deferred.succeed(registered, undefined),
          onMutationPermitRequest: () => Deferred.succeed(requested, undefined),
          onMutationPermitAcquired: () =>
            Effect.sync(() => {
              acquired = true;
            }),
          duringStagePopulation: () =>
            Effect.sync(() => {
              staged = true;
            }),
        });
        const waiting = yield* repository
          .createGlobal({ expectedRevision: 0, content: content("waiting", "one") })
          .pipe(Effect.forkChild);
        yield* Deferred.await(registered);
        yield* Deferred.await(requested);
        waiting.interruptUnsafe();
        const interrupted = yield* Fiber.await(waiting);
        assert.isTrue(interrupted._tag === "Failure" && Cause.hasInterrupts(interrupted.cause));
        assert.isFalse(acquired);
        assert.isFalse(staged);
        yield* external.release(1);
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("waiting", "two"),
        });
        assert.equal(created.content.body, "two");
        assert.equal(semaphoreCount, 2);
      }),
    );

    it.effect("cleans an interrupted stage and leaves the root reusable", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("cancel-stage", "one"),
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let first = true;
        const repository = yield* ManagedSkillRepository.makeWith({
          duringStagePopulation: () =>
            first
              ? Effect.sync(() => {
                  first = false;
                }).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void,
        });
        const mutation = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Cancel", body: "two" },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        mutation.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        const interrupted = yield* Fiber.await(mutation);
        assert.isTrue(interrupted._tag === "Failure" && Cause.hasInterrupts(interrupted.cause));
        assert.equal((yield* base.readGlobal(created.manifest.id)).content.body, "one");
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(
          (yield* (yield* FileSystem.FileSystem).readDirectory(config.managedSkillsDir)).filter(
            (name) => name.startsWith(".cancel-stage."),
          ),
          [],
        );
        const updated = yield* repository.updateGlobal({
          skillId: created.manifest.id,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Cancel", body: "three" },
        });
        assert.equal(updated.content.body, "three");
      }),
    );

    it.effect("defers interruption during the masked final rename until commit settles", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("masked", "one"),
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const repository = yield* ManagedSkillRepository.makeWith({
          finalRename: (from, to, rename) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(rename(from, to)),
            ),
        });
        const mutation = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Masked", body: "two" },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        mutation.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        const interrupted = yield* Fiber.await(mutation);
        assert.isTrue(interrupted._tag === "Failure" && Cause.hasInterrupts(interrupted.cause));
        const current = yield* base.readGlobal(created.manifest.id);
        assert.equal(current.content.body, "two");
        assert.equal(current.manifest.revision.revision, 2);
      }),
    );

    it.effect("cleans a defective stage and propagates the original defect", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("stage-defect", "one"),
        });
        const defect = new Error("stage defect sentinel");
        const repository = yield* ManagedSkillRepository.makeWith({
          duringStagePopulation: () => Effect.die(defect),
        });
        const result = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Defect", body: "two" },
          })
          .pipe(Effect.exit);
        assert.isTrue(result._tag === "Failure" && Cause.hasDies(result.cause));
        if (result._tag === "Failure") assert.equal(Cause.squash(result.cause), defect);
        assert.equal((yield* base.readGlobal(created.manifest.id)).content.body, "one");
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(
          (yield* (yield* FileSystem.FileSystem).readDirectory(config.managedSkillsDir)).filter(
            (name) => name.startsWith(".stage-defect."),
          ),
          [],
        );
      }),
    );

    it.effect("restores the prior package and rethrows a final-rename defect", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("rename-defect", "one"),
        });
        const defect = new Error("rename defect sentinel");
        const repository = yield* ManagedSkillRepository.makeWith({
          finalRename: () => Effect.die(defect),
        });
        const result = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Defect", body: "two" },
          })
          .pipe(Effect.exit);
        assert.isTrue(result._tag === "Failure" && Cause.hasDies(result.cause));
        if (result._tag === "Failure") assert.equal(Cause.squash(result.cause), defect);
        assert.equal((yield* base.readGlobal(created.manifest.id)).content.body, "one");
      }),
    );

    it.effect("preserves the committed package when global archive cleanup fails", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("cleanup-fail", "one"),
        });
        const repository = yield* ManagedSkillRepository.makeWith({
          archiveRename: () =>
            Effect.fail(
              new ManagedSkillRepository.ManagedSkillRepositoryError({
                code: "mutation_failed",
                detail: "archive failure sentinel",
              }),
            ),
        });
        const result = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Cleanup", body: "two" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.deepInclude(result.failure, { code: "mutation_failed" });
          if (result.failure._tag === "ManagedSkillRepositoryError") {
            assert.include(result.failure.detail, "Committed current package; cleanup failed");
          }
        }
        const current = yield* base.readGlobal(created.manifest.id);
        assert.equal(current.content.body, "two");
        assert.equal(current.manifest.revision.revision, 2);
        const retry = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Cleanup", body: "retry" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(retry));
        if (Result.isFailure(retry))
          assert.deepInclude(retry.failure, { code: "revision_conflict" });
      }),
    );

    it.effect("reports the numeric archive remainder when pruning fails after commit", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let current = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("prune-fail", "zero"),
        });
        for (let revision = 2; revision <= 21; revision += 1) {
          current = yield* base.updateGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            content: { name: "Prune", body: String(revision) },
          });
        }
        const archived = path.join(config.skillHistoryDir, current.manifest.id, "21");
        const repository = yield* ManagedSkillRepository.makeWith({
          pruneHistoryRevision: (revisionPath) =>
            fs.remove(path.join(revisionPath, "SKILL.md")).pipe(
              Effect.andThen(
                Effect.fail(
                  new ManagedSkillRepository.ManagedSkillRepositoryError({
                    code: "mutation_failed",
                    detail: "prune failure sentinel",
                  }),
                ),
              ),
            ),
        });
        const result = yield* repository
          .updateGlobal({
            skillId: current.manifest.id,
            expectedHash: current.manifest.revision.hash,
            content: { name: "Prune", body: "committed" },
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result) && result.failure._tag === "ManagedSkillRepositoryError") {
          assert.equal(result.failure.code, "mutation_failed");
          assert.include(result.failure.detail, archived);
          assert.notInclude(result.failure.detail, ".rollback-");
        }
        assert.equal((yield* base.readGlobal(current.manifest.id)).content.body, "committed");
        assert.isTrue(yield* fs.exists(archived));
      }),
    );

    it.effect("keeps committed project state after partial rollback cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-cleanup-" });
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.setProjectOverride({
          projectRoot,
          key: key("partial"),
          content: { name: "Partial", body: "one" },
        });
        const repository = yield* ManagedSkillRepository.makeWith({
          removeRollback: (rollback) =>
            fs.remove(`${rollback}/SKILL.md`).pipe(
              Effect.andThen(
                Effect.fail(
                  new ManagedSkillRepository.ManagedSkillRepositoryError({
                    code: "mutation_failed",
                    detail: "partial cleanup sentinel",
                  }),
                ),
              ),
            ),
        });
        const result = yield* repository
          .setProjectOverride({
            projectRoot,
            key: key("partial"),
            expectedHash: created.manifest.revision.hash,
            content: { name: "Partial", body: "two" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        assert.equal(
          (yield* base.readProject(projectRoot, created.manifest.id)).content?.body,
          "two",
        );
        const root = `${projectRoot}/.t3code/skills`;
        assert.equal(
          (yield* fs.readDirectory(root)).filter((name) => name.startsWith(".partial.rollback-"))
            .length,
          1,
        );
      }),
    );

    it.effect("rejects symlinked managed and history roots without outside writes", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-outside-" });
        yield* fs.remove(config.managedSkillsDir, { recursive: true });
        yield* fs.symlink(outside, config.managedSkillsDir);
        const createResult = yield* repository
          .createGlobal({ expectedRevision: 0, content: content("escape", "no") })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(createResult));
        assert.deepEqual(yield* fs.readDirectory(outside), []);

        yield* fs.remove(config.managedSkillsDir);
        yield* fs.makeDirectory(config.managedSkillsDir);
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("history-root", "one"),
        });
        yield* fs.remove(config.skillHistoryDir, { recursive: true });
        yield* fs.symlink(outside, config.skillHistoryDir);
        const updateResult = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "History", body: "two" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(updateResult));
        assert.equal((yield* repository.readGlobal(created.manifest.id)).content.body, "one");
        assert.deepEqual(yield* fs.readDirectory(outside), []);
      }),
    );

    it.effect("lists manual dot packages but hides exact repository artifacts", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${config.managedSkillsDir}/.manual`);
        yield* fs.makeDirectory(
          `${config.managedSkillsDir}/.deploy.tmp-123e4567-e89b-12d3-a456-426614174000`,
        );
        const names = (yield* repository.listGlobal()).map((entry) => entry.directoryName);
        assert.include(names, ".manual");
        assert.notInclude(names, ".deploy.tmp-123e4567-e89b-12d3-a456-426614174000");
      }),
    );

    it.effect("keeps malformed filesystem peers as package-local diagnostics", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const valid = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("valid-peer", "body"),
        });
        yield* fs.symlink("missing-target", `${config.managedSkillsDir}/dangling`);
        yield* fs.writeFileString(`${config.managedSkillsDir}/special-peer`, "not a directory");
        const entries = yield* repository.listGlobal();
        assert.equal(
          entries.find((entry) => entry.manifest?.id === valid.manifest.id)?.validity,
          "valid",
        );
        assert.equal(
          entries.find((entry) => entry.directoryName === "dangling")?.validity,
          "invalid",
        );
        assert.equal(
          entries.find((entry) => entry.directoryName === "special-peer")?.validity,
          "invalid",
        );
      }),
    );

    it.effect("rejects symlinked project metadata roots without outside writes", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-root-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-outside-" });
        yield* fs.symlink(outside, `${project}/.t3code`);
        const result = yield* repository
          .setProjectOverride({
            projectRoot: project,
            key: key("escape"),
            content: { name: "Escape", body: "no" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* fs.readDirectory(outside), []);
      }),
    );
    it.effect("keeps current content when staged validation fails", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("safe", "original"),
        });
        yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Unsafe", body: "corrupt", assetPaths: ["../escape"] },
          })
          .pipe(Effect.result);
        assert.equal((yield* repository.readGlobal(created.manifest.id)).content.body, "original");
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(
          (yield* (yield* FileSystem.FileSystem).readDirectory(config.managedSkillsDir)).filter(
            (name) => name.startsWith(".safe."),
          ),
          [],
        );
      }),
    );

    it.effect("restores prior content when the final rename fails", () =>
      Effect.gen(function* () {
        const base = yield* ManagedSkillRepository.ManagedSkillRepository;
        const created = yield* base.createGlobal({
          expectedRevision: 0,
          content: content("recover", "original"),
        });
        let failed = false;
        const repository = yield* ManagedSkillRepository.makeWith({
          finalRename: (from, to, rename) =>
            !failed && to.endsWith("recover")
              ? Effect.gen(function* () {
                  failed = true;
                  return yield* new ManagedSkillRepository.ManagedSkillRepositoryError({
                    code: "mutation_failed",
                    detail: "injected rename failure",
                  });
                })
              : rename(from, to),
        });
        const result = yield* repository
          .updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Recover", body: "replacement" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        assert.equal((yield* base.readGlobal(created.manifest.id)).content.body, "original");

        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const ownedArtifacts = (yield* (yield* FileSystem.FileSystem).readDirectory(
          config.managedSkillsDir,
        )).filter((name) => name.startsWith(".recover."));
        assert.deepEqual(ownedArtifacts, []);
        assert.equal(
          path.resolve(config.managedSkillsDir, "recover").startsWith(config.stateDir),
          true,
        );
      }),
    );
  });
});
