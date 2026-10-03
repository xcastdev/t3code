import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { ManagedSkillContent, ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import * as SkillMaterializationService from "./SkillMaterializationService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";
import { makeClaudeSkillAdapter, makeCodexSkillAdapter } from "./ProviderSkillAdapters.ts";

const isMaterializationError = Schema.is(SkillMaterializationService.SkillMaterializationError);
const encodeFixtureMarker = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const content: ManagedSkillContent = {
  key: "deploy" as ManagedSkillKey,
  name: "Deploy",
  body: "Run the deployment.",
};

const ConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-skill-materialization-",
});
const TestLayer = SkillMaterializationService.layer.pipe(
  Layer.provideMerge(ManagedSkillRepository.layer),
  Layer.provideMerge(ConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("SkillMaterializationService", () => {
  it.layer(TestLayer)("owns generated session packages", (it) => {
    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "admits only fixed owned output and joins its descriptor lifetime",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const created = yield* repository.createGlobal({
            expectedRevision: 0,
            content: { ...content, key: "admit" as ManagedSkillKey },
          });
          const input = {
            sessionId: "owned-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 2,
            packages: [{ key: created.manifest.key, sourcePath: created.packagePath }],
          };
          const materialized = yield* service.materialize(input);
          const result = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            { ...input, skillKeys: [created.manifest.key] },
            (owned) =>
              Effect.gen(function* () {
                assert.equal(owned.root, materialized.root);
                assert.equal(
                  owned.skillPaths.get(created.manifest.key),
                  path.join(owned.root, "admit"),
                );
                yield* owned.revalidate;
                return yield* fs.readFileString(path.join(owned.root, "admit", "SKILL.md"));
              }),
          );
          assert.include(result, "Run the deployment.");
          assert.equal(
            yield* hashSkillPackage(created.packagePath),
            created.manifest.revision.hash,
          );
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "refuses a replaced owned generation and preserves both trees",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const input = {
            sessionId: "replaced-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 2,
            skillKeys: [],
          };
          const materialized = yield* service.materialize({ ...input, packages: [] });
          const original = materialized.root + "-original";
          const failure = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            input,
            (owned) =>
              Effect.gen(function* () {
                yield* fs.rename(owned.root, original);
                yield* fs.copy(original, owned.root);
                yield* fs.writeFileString(path.join(owned.root, "foreign.txt"), "Keep replacement");
                yield* owned.revalidate;
              }),
          ).pipe(Effect.flip);
          if (isMaterializationError(failure)) assert.equal(failure.code, "ownership_mismatch");
          else assert.fail("Expected an owned generation refusal");
          assert.isTrue(yield* fs.exists(original));
          assert.equal(
            yield* fs.readFileString(path.join(materialized.root, "foreign.txt")),
            "Keep replacement",
          );
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "refuses changed markers and missing selected directories without cleanup",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const input = {
            sessionId: "marker-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 3,
            skillKeys: [],
          };
          const materialized = yield* service.materialize({ ...input, packages: [] });
          const missing = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            { ...input, skillKeys: ["missing" as ManagedSkillKey] },
            () => Effect.void,
          ).pipe(Effect.flip);
          assert.equal(missing.code, "ownership_mismatch");
          const marker = path.join(materialized.root, ".t3-owned.json");
          yield* fs.writeFileString(marker, "{}");
          const changed = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            input,
            () => Effect.void,
          ).pipe(Effect.flip);
          assert.equal(changed.code, "ownership_mismatch");
          assert.equal(yield* fs.readFileString(marker), "{}");
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "refuses marker redirection and closes admission after callback failure",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const input = {
            sessionId: "redirect-marker-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 4,
            skillKeys: [],
          };
          const materialized = yield* service.materialize({ ...input, packages: [] });
          const marker = path.join(materialized.root, ".t3-owned.json");
          const retained = path.join(materialized.root, "original-marker");
          const contents = yield* fs.readFileString(marker);
          yield* fs.rename(marker, retained);
          yield* fs.symlink(retained, marker);
          const redirected = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            input,
            () => Effect.void,
          ).pipe(Effect.flip);
          assert.equal(redirected.code, "ownership_mismatch");
          assert.equal(yield* fs.readFileString(retained), contents);
          yield* fs.remove(marker);
          yield* fs.rename(retained, marker);
          let closed = Effect.void as Effect.Effect<
            void,
            SkillMaterializationService.SkillMaterializationError
          >;
          const failure = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            input,
            (owned) => {
              closed = owned.revalidate;
              return Effect.fail("copy failed");
            },
          ).pipe(Effect.flip);
          assert.equal(failure, "copy failed");
          assert.equal((yield* closed.pipe(Effect.flip)).code, "ownership_mismatch");
          assert.equal(yield* fs.readFileString(marker), contents);
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "does not admit a custom service or create missing runtime directories",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const input = {
            sessionId: "absent-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 5,
            skillKeys: [],
          };
          let called = false;
          for (const candidate of [
            service,
            SkillMaterializationService.SkillMaterializationService.of({ ...service }),
          ]) {
            const failure = yield* SkillMaterializationService.withOwnedSkillMaterialization(
              candidate,
              input,
              () => {
                called = true;
                return Effect.void;
              },
            ).pipe(Effect.flip);
            assert.equal(failure.code, "ownership_mismatch");
          }
          assert.isFalse(called);
          assert.isFalse(yield* fs.exists(path.join(config.skillRuntimeDir, input.sessionId)));
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
      "closes every held descriptor when the callback throws synchronously",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const input = {
            sessionId: "throw-admission",
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 6,
            skillKeys: [],
          };
          const materialized = yield* service.materialize({ ...input, packages: [] });
          const native = process.getBuiltinModule("fs").promises;
          const syncExports = process.getBuiltinModule("module").syncBuiltinESMExports;
          const captured: Array<Awaited<ReturnType<typeof native.open>>> = [];
          let escaped = Effect.void as Effect.Effect<
            void,
            SkillMaterializationService.SkillMaterializationError
          >;
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const original = native.open;
              native.open = async (...args) => {
                const handle = await original(...args);
                captured.push(handle);
                return handle;
              };
              syncExports();
              return original;
            }),
            () =>
              Effect.gen(function* () {
                const exit = yield* SkillMaterializationService.withOwnedSkillMaterialization(
                  service,
                  input,
                  (owned): Effect.Effect<void> => {
                    escaped = owned.revalidate;
                    throw new Error("Throw before returning an Effect");
                  },
                ).pipe(Effect.exit);
                assert.isTrue(Exit.isFailure(exit));
                assert.equal(
                  captured.length,
                  materialized.root.split("/").filter(Boolean).length + 2,
                );
                for (const handle of captured) {
                  const stat = yield* Effect.tryPromise(() => handle.stat()).pipe(Effect.exit);
                  assert.isTrue(Exit.isFailure(stat));
                }
                assert.equal((yield* escaped.pipe(Effect.flip)).code, "ownership_mismatch");
              }),
            (original) =>
              Effect.promise(async () => {
                native.open = original;
                syncExports();
                await Promise.allSettled(captured.map((handle) => handle.close()));
              }),
          );
        }),
    );

    for (const platform of ["darwin", "win32"] as const)
      it.effect(`refuses ${platform} admission while preserving ordinary materialization`, () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.make.pipe(
            Effect.provideService(HostProcessPlatform, platform),
          );
          const fs = yield* FileSystem.FileSystem;
          const input = {
            sessionId: `portable-${platform}`,
            providerInstanceId: "pi-owned" as ProviderInstanceId,
            desiredRevision: 7,
            skillKeys: [],
          };
          const config = yield* ServerConfig.ServerConfig;
          const path = yield* Path.Path;
          let called = false;
          const failure = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            service,
            input,
            () => {
              called = true;
              return Effect.void;
            },
          ).pipe(Effect.flip);
          assert.equal(failure.code, "unsafe_identity");
          assert.isFalse(called);
          assert.isFalse(yield* fs.exists(path.join(config.skillRuntimeDir, input.sessionId)));
          const clone = SkillMaterializationService.SkillMaterializationService.of({ ...service });
          const clonedFailure = yield* SkillMaterializationService.withOwnedSkillMaterialization(
            clone,
            input,
            () => Effect.void,
          ).pipe(Effect.flip);
          assert.equal(clonedFailure.code, "ownership_mismatch");
          const ordinary = yield* service.materialize({ ...input, packages: [] });
          assert.isTrue(yield* fs.exists(ordinary.root));
          yield* service.dispose(input);
          assert.isFalse(yield* fs.exists(ordinary.root));
        }),
      );

    it.effect(
      "fresh adapters discover owned revisions while preserving unrelated runtime files",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          for (const provider of ["codex", "claude"]) {
            const providerInstanceId = provider as ProviderInstanceId;
            const sessionId = `recovered-${provider}`;
            const ownedRoots: string[] = [];
            for (const desiredRevision of [1, 3]) {
              const owned = yield* service.materialize({
                sessionId,
                providerInstanceId,
                desiredRevision,
                packages: [],
              });
              ownedRoots.push(owned.root);
            }
            const other = yield* service.materialize({
              sessionId,
              providerInstanceId: "other-provider" as ProviderInstanceId,
              desiredRevision: 1,
              packages: [],
            });
            const foreign = path.join(config.skillRuntimeDir, sessionId, "2", provider);
            yield* fs.makeDirectory(foreign, { recursive: true });
            yield* fs.writeFileString(path.join(foreign, ".t3-owned.json"), "{}");
            const alias = path.join(config.skillRuntimeDir, sessionId, "01", provider);
            yield* fs.makeDirectory(path.dirname(alias), { recursive: true });
            yield* fs.copy(ownedRoots[0]!, alias);
            const external = yield* fs.makeTempDirectoryScoped({
              prefix: "skill-runtime-foreign-",
            });
            yield* fs.writeFileString(
              path.join(external, ".t3-owned.json"),
              encodeFixtureMarker({
                schemaVersion: 1,
                sessionId,
                providerInstanceId,
                desiredRevision: 4,
              }),
            );
            const linked = path.join(config.skillRuntimeDir, sessionId, "4", provider);
            yield* fs.makeDirectory(path.dirname(linked), { recursive: true });
            yield* fs.symlink(external, linked);

            const restarted = yield* SkillMaterializationService.make;
            const options = {
              providerInstanceId,
              discoverCandidates: () => Effect.succeed([]),
              materialization: restarted,
              fileSystem: fs,
              path,
            };
            const adapter =
              provider === "codex"
                ? makeCodexSkillAdapter(options)
                : makeClaudeSkillAdapter(options);
            yield* adapter.disposeSession({ sessionId, providerInstanceId, cwd: "/repo" });
            yield* adapter.disposeSession({ sessionId, providerInstanceId, cwd: "/repo" });

            for (const root of ownedRoots) assert.isFalse(yield* fs.exists(root));
            for (const root of [other.root, foreign, alias, linked, external]) {
              assert.isTrue(yield* fs.exists(root));
            }
          }
        }),
    );

    it.effect("materializes validated copies under the configured runtime root", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const service = yield* SkillMaterializationService.SkillMaterializationService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const cleanupContent = {
          ...content,
          key: "cleanup" as ManagedSkillKey,
          name: "Cleanup",
        };
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: cleanupContent,
        });
        const sourceHashBefore = yield* hashSkillPackage(created.packagePath);

        const result = yield* service.materialize({
          sessionId: "session-one",
          providerInstanceId: "codex" as ProviderInstanceId,
          desiredRevision: 4,
          packages: [{ key: cleanupContent.key, sourcePath: created.packagePath }],
        });

        assert.equal(path.relative(config.skillRuntimeDir, result.root).startsWith(".."), false);
        assert.isTrue(
          yield* fs.exists(path.join(result.skillPaths.get(cleanupContent.key)!, "SKILL.md")),
        );
        const marker = yield* fs.readFileString(path.join(result.root, ".t3-owned.json"));
        assert.include(marker, '"sessionId":"session-one"');
        assert.include(marker, '"providerInstanceId":"codex"');
        assert.include(marker, '"desiredRevision":4');
        assert.equal(yield* hashSkillPackage(created.packagePath), sourceHashBefore);

        const replacement = yield* service.materialize({
          sessionId: "session-one",
          providerInstanceId: "codex" as ProviderInstanceId,
          desiredRevision: 4,
          packages: [],
        });
        assert.equal(replacement.root, result.root);
        assert.isFalse(yield* fs.exists(path.join(replacement.root, "cleanup")));
        yield* service.dispose({
          sessionId: "session-one",
          providerInstanceId: "codex" as ProviderInstanceId,
          desiredRevision: 4,
        });
        assert.isFalse(yield* fs.exists(result.root));
      }),
    );

    it.effect("rejects traversal identifiers and invalid source packages", () =>
      Effect.gen(function* () {
        const service = yield* SkillMaterializationService.SkillMaterializationService;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const invalidSource = yield* fs.makeTempDirectoryScoped({ prefix: "invalid-skill-" });
        yield* fs.writeFileString(`${invalidSource}/SKILL.md`, "invalid");

        const traversal = yield* service
          .materialize({
            sessionId: "../escape",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 1,
            packages: [],
          })
          .pipe(Effect.flip);
        assert.equal(traversal.code, "unsafe_identity");

        const invalid = yield* service
          .materialize({
            sessionId: "session-two",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 1,
            packages: [{ key: content.key, sourcePath: invalidSource }],
          })
          .pipe(Effect.flip);
        assert.equal(invalid.code, "invalid_source");
        assert.isFalse(
          (yield* fs.readDirectory(config.skillRuntimeDir)).some((entry) =>
            entry.startsWith(".pending-"),
          ),
        );
      }),
    );

    it.effect(
      "rejects redirected session and revision parents before writing outside runtime",
      () =>
        Effect.gen(function* () {
          const service = yield* SkillMaterializationService.SkillMaterializationService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;

          const redirectedSessionOutside = yield* fs.makeTempDirectoryScoped({
            prefix: "skill-runtime-redirected-session-",
          });
          yield* fs.writeFileString(path.join(redirectedSessionOutside, "keep.txt"), "session");
          const redirectedSession = path.join(config.skillRuntimeDir, "redirected-session");
          yield* fs.symlink(redirectedSessionOutside, redirectedSession);
          const sessionFailure = yield* service
            .materialize({
              sessionId: "redirected-session",
              providerInstanceId: "codex" as ProviderInstanceId,
              desiredRevision: 1,
              packages: [],
            })
            .pipe(Effect.flip);
          assert.equal(sessionFailure.code, "ownership_mismatch");
          assert.deepEqual(yield* fs.readDirectory(redirectedSessionOutside), ["keep.txt"]);
          assert.equal(
            yield* fs.readFileString(path.join(redirectedSessionOutside, "keep.txt")),
            "session",
          );

          const redirectedRevisionOutside = yield* fs.makeTempDirectoryScoped({
            prefix: "skill-runtime-redirected-revision-",
          });
          yield* fs.writeFileString(path.join(redirectedRevisionOutside, "keep.txt"), "revision");
          const revisionSession = path.join(config.skillRuntimeDir, "redirected-revision");
          const redirectedRevision = path.join(revisionSession, "2");
          yield* fs.makeDirectory(revisionSession);
          yield* fs.symlink(redirectedRevisionOutside, redirectedRevision);
          const revisionFailure = yield* service
            .materialize({
              sessionId: "redirected-revision",
              providerInstanceId: "codex" as ProviderInstanceId,
              desiredRevision: 2,
              packages: [],
            })
            .pipe(Effect.flip);
          assert.equal(revisionFailure.code, "ownership_mismatch");
          assert.deepEqual(yield* fs.readDirectory(redirectedRevisionOutside), ["keep.txt"]);
          assert.equal(
            yield* fs.readFileString(path.join(redirectedRevisionOutside, "keep.txt")),
            "revision",
          );
        }),
    );

    it.effect("rejects symlinked and unowned provider roots without replacing them", () =>
      Effect.gen(function* () {
        const service = yield* SkillMaterializationService.SkillMaterializationService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;

        const linkedOutside = yield* fs.makeTempDirectoryScoped({
          prefix: "skill-runtime-linked-provider-",
        });
        yield* fs.writeFileString(path.join(linkedOutside, "keep.txt"), "linked");
        yield* fs.writeFileString(
          path.join(linkedOutside, ".t3-owned.json"),
          encodeFixtureMarker({
            schemaVersion: 1,
            sessionId: "linked-provider",
            providerInstanceId: "codex",
            desiredRevision: 5,
          }),
        );
        const linkedRoot = path.join(config.skillRuntimeDir, "linked-provider", "5", "codex");
        yield* fs.makeDirectory(path.dirname(linkedRoot), { recursive: true });
        yield* fs.symlink(linkedOutside, linkedRoot);
        const linkedFailure = yield* service
          .materialize({
            sessionId: "linked-provider",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 5,
            packages: [],
          })
          .pipe(Effect.flip);
        assert.equal(linkedFailure.code, "ownership_mismatch");
        assert.isTrue(yield* fs.exists(linkedRoot));
        assert.deepEqual(yield* fs.readDirectory(linkedOutside), [".t3-owned.json", "keep.txt"]);
        assert.equal(yield* fs.readFileString(path.join(linkedOutside, "keep.txt")), "linked");

        const unownedRoot = path.join(config.skillRuntimeDir, "unowned-provider", "6", "codex");
        yield* fs.makeDirectory(unownedRoot, { recursive: true });
        yield* fs.writeFileString(path.join(unownedRoot, "keep.txt"), "unowned");
        const unownedFailure = yield* service
          .materialize({
            sessionId: "unowned-provider",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 6,
            packages: [],
          })
          .pipe(Effect.flip);
        assert.equal(unownedFailure.code, "ownership_mismatch");
        assert.isTrue(yield* fs.exists(unownedRoot));
        assert.equal(yield* fs.readFileString(path.join(unownedRoot, "keep.txt")), "unowned");
      }),
    );

    it.effect("preserves a foreign stage replacement during marker creation", () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        let stagePath: string | undefined;
        let savedOriginalPath: string | undefined;
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...baseFs,
          writeFileString: (candidate, data, options) =>
            Effect.gen(function* () {
              if (!swapped && candidate.endsWith("/.t3-owned.json")) {
                swapped = true;
                stagePath = path.dirname(candidate);
                savedOriginalPath = `${stagePath}.original`;
                yield* baseFs.rename(stagePath, savedOriginalPath);
                yield* baseFs.makeDirectory(stagePath);
                yield* baseFs.writeFileString(path.join(stagePath, "foreign.txt"), "foreign");
              }
              return yield* baseFs.writeFileString(candidate, data, options);
            }),
        });
        const service = yield* SkillMaterializationService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
        );

        const failure = yield* service
          .materialize({
            sessionId: "stage-swap-marker",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 1,
            packages: [],
          })
          .pipe(Effect.flip);

        assert.equal(failure.code, "ownership_mismatch");
        assert.isTrue(swapped);
        assert.isDefined(stagePath);
        assert.isDefined(savedOriginalPath);
        assert.equal(yield* baseFs.readFileString(path.join(stagePath!, "foreign.txt")), "foreign");
        assert.isTrue(yield* baseFs.exists(stagePath!));
        assert.isTrue(yield* baseFs.exists(savedOriginalPath!));
        assert.isFalse(
          yield* baseFs.exists(
            path.join(config.skillRuntimeDir, "stage-swap-marker", "1", "codex"),
          ),
        );
      }),
    );

    it.effect("preserves a foreign stage replacement before publish", () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        let stagePath: string | undefined;
        let savedOriginalPath: string | undefined;
        let markerWritten = false;
        let stageRealPathCalls = 0;
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...baseFs,
          writeFileString: (candidate, data, options) =>
            Effect.gen(function* () {
              if (candidate.endsWith("/.t3-owned.json")) {
                stagePath = path.dirname(candidate);
                markerWritten = true;
              }
              return yield* baseFs.writeFileString(candidate, data, options);
            }),
          realPath: (candidate) =>
            Effect.gen(function* () {
              const resolved = yield* baseFs.realPath(candidate);
              if (markerWritten && candidate === stagePath) {
                stageRealPathCalls += 1;
                if (stageRealPathCalls === 2) {
                  swapped = true;
                  savedOriginalPath = `${stagePath}.original`;
                  yield* baseFs.rename(stagePath!, savedOriginalPath);
                  yield* baseFs.makeDirectory(stagePath!);
                  yield* baseFs.writeFileString(path.join(stagePath!, "foreign.txt"), "foreign");
                }
              }
              return resolved;
            }),
        });
        const service = yield* SkillMaterializationService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
        );

        const failure = yield* service
          .materialize({
            sessionId: "stage-swap-publish",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 1,
            packages: [],
          })
          .pipe(Effect.flip);

        assert.equal(failure.code, "ownership_mismatch");
        assert.isTrue(swapped);
        assert.isDefined(stagePath);
        assert.isDefined(savedOriginalPath);
        assert.equal(yield* baseFs.readFileString(path.join(stagePath!, "foreign.txt")), "foreign");
        assert.isTrue(yield* baseFs.exists(stagePath!));
        assert.isTrue(yield* baseFs.exists(savedOriginalPath!));
        assert.isFalse(
          yield* baseFs.exists(
            path.join(config.skillRuntimeDir, "stage-swap-publish", "1", "codex"),
          ),
        );
      }),
    );

    it.effect("cleans only roots carrying the matching ownership marker", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const service = yield* SkillMaterializationService.SkillMaterializationService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const created = yield* repository.createGlobal({ expectedRevision: 0, content });
        const result = yield* service.materialize({
          sessionId: "session-three",
          providerInstanceId: "claude" as ProviderInstanceId,
          desiredRevision: 2,
          packages: [{ key: content.key, sourcePath: created.packagePath }],
        });
        yield* service.dispose({
          sessionId: "session-three",
          providerInstanceId: "claude" as ProviderInstanceId,
          desiredRevision: 2,
        });
        assert.isFalse(yield* fs.exists(result.root));

        const foreign = path.join(config.skillRuntimeDir, "foreign", "1", "codex");
        yield* fs.makeDirectory(foreign, { recursive: true });
        yield* fs.writeFileString(path.join(foreign, "keep.txt"), "mine");
        const refused = yield* service
          .dispose({
            sessionId: "foreign",
            providerInstanceId: "codex" as ProviderInstanceId,
            desiredRevision: 1,
          })
          .pipe(Effect.flip);
        assert.equal(refused.code, "ownership_mismatch");
        assert.isTrue(yield* fs.exists(path.join(foreign, "keep.txt")));
      }),
    );
  });
});

const cancellationFixture = Effect.fn("SkillMaterializationService.test.cancellationFixture")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configured = yield* ServerConfig.ServerConfig;
    const runtimeDir = yield* fs.makeTempDirectoryScoped({ prefix: "skill-cancellation-runtime-" });
    const config = { ...configured, skillRuntimeDir: runtimeDir };
    const source = yield* fs.makeTempDirectoryScoped({ prefix: "skill-cancellation-source-" });
    yield* fs.writeFileString(
      path.join(source, "SKILL.md"),
      "---\nname: review\ndescription: Cancellation fixture\n---\nRetain canonical content.",
    );
    const hash = yield* hashSkillPackage(source);
    const manifest = yield* encodeFixtureJson({
      schemaVersion: 1,
      kind: "managed-skill",
      id: "cancel-review",
      key: "review",
      scope: "global",
      revision: { revision: 1, hash },
      origin: "created",
      ownership: "t3",
    });
    yield* fs.writeFileString(path.join(source, "t3-skill.json"), manifest);
    const input = {
      sessionId: path.basename(source),
      providerInstanceId: "pi-cancel" as ProviderInstanceId,
      desiredRevision: 2,
      packages: [{ key: "review" as ManagedSkillKey, sourcePath: source }],
    };
    const root = path.join(config.skillRuntimeDir, input.sessionId, "2", "pi-cancel");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const hold = (candidate: string) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(candidate),
      );
    return { fs, path, config, source, hash, input, root, entered, release, hold };
  },
);

describe("SkillMaterializationService cancellation ownership", () => {
  it.layer(TestLayer)("drains interrupted acquisitions", (it) => {
    for (const phase of ["acquire", "copy", "rename"] as const) {
      for (const interrupt of [true, false]) {
        it.effect(
          `${interrupt ? "cleans" : "retains"} its owned directory after ${phase} ${interrupt ? "interruption" : "completion"}`,
          () =>
            Effect.gen(function* () {
              const fixture = yield* cancellationFixture();
              let held = false;
              const hooked = FileSystem.FileSystem.of({
                ...fixture.fs,
                realPath: (candidate) =>
                  fixture.fs.realPath(candidate).pipe(
                    Effect.flatMap((result) => {
                      if (
                        phase !== "acquire" ||
                        held ||
                        !fixture.path.basename(candidate).startsWith(".pending-")
                      )
                        return Effect.succeed(result);
                      held = true;
                      return fixture.hold(result);
                    }),
                  ),
                copy: (from, to, options) =>
                  fixture.fs
                    .copy(from, to, options)
                    .pipe(
                      Effect.andThen(
                        phase === "copy" ? fixture.hold(to).pipe(Effect.asVoid) : Effect.void,
                      ),
                    ),
                rename: (from, to) =>
                  fixture.fs
                    .rename(from, to)
                    .pipe(
                      Effect.andThen(
                        phase === "rename" ? fixture.hold(to).pipe(Effect.asVoid) : Effect.void,
                      ),
                    ),
              });
              const service = yield* SkillMaterializationService.make.pipe(
                Effect.provideService(FileSystem.FileSystem, hooked),
                Effect.provideService(ServerConfig.ServerConfig, fixture.config),
              );
              const fiber = yield* service.materialize(fixture.input).pipe(Effect.forkChild);
              yield* Deferred.await(fixture.entered);
              if (interrupt) yield* Fiber.interrupt(fiber);
              else yield* Deferred.succeed(fixture.release, undefined);
              const exit = yield* Fiber.await(fiber);
              assert.equal(Exit.isFailure(exit), interrupt);
              assert.deepEqual(
                (yield* fixture.fs.readDirectory(fixture.config.skillRuntimeDir)).filter((entry) =>
                  entry.startsWith(".pending-"),
                ),
                [],
              );
              assert.equal(yield* fixture.fs.exists(fixture.root), !interrupt);
              assert.equal(yield* hashSkillPackage(fixture.source), fixture.hash);
              if (!interrupt) yield* service.dispose(fixture.input);
            }),
        );
      }
    }

    for (const phase of ["acquire", "copy", "rename"] as const) {
      it.effect(`preserves a foreign inode replacement after ${phase} interruption`, () =>
        Effect.gen(function* () {
          const fixture = yield* cancellationFixture();
          let ownedPath = "";
          const hooked = FileSystem.FileSystem.of({
            ...fixture.fs,
            realPath: (candidate) =>
              fixture.fs.realPath(candidate).pipe(
                Effect.flatMap((result) => {
                  if (
                    phase !== "acquire" ||
                    ownedPath !== "" ||
                    !fixture.path.basename(candidate).startsWith(".pending-")
                  )
                    return Effect.succeed(result);
                  ownedPath = candidate;
                  return fixture.hold(result);
                }),
              ),
            copy: (from, to, options) =>
              fixture.fs.copy(from, to, options).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (phase !== "copy") return Effect.void;
                    ownedPath = fixture.path.dirname(to);
                    return fixture.hold(to).pipe(Effect.asVoid);
                  }),
                ),
              ),
            rename: (from, to) =>
              fixture.fs.rename(from, to).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (phase !== "rename") return Effect.void;
                    ownedPath = to;
                    return fixture.hold(to).pipe(Effect.asVoid);
                  }),
                ),
              ),
          });
          const service = yield* SkillMaterializationService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, hooked),
            Effect.provideService(ServerConfig.ServerConfig, fixture.config),
          );
          const fiber = yield* service.materialize(fixture.input).pipe(Effect.forkChild);
          yield* Deferred.await(fixture.entered);
          const retained = yield* fixture.fs.makeTempDirectoryScoped({
            prefix: "skill-retained-inode-",
          });
          yield* fixture.fs.rename(ownedPath, fixture.path.join(retained, "original"));
          yield* fixture.fs.copy(fixture.path.join(retained, "original"), ownedPath);
          yield* fixture.fs.writeFileString(
            fixture.path.join(ownedPath, "foreign.txt"),
            "Retain the replacement inode.",
          );
          yield* Fiber.interrupt(fiber);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
          assert.equal(
            yield* fixture.fs.readFileString(fixture.path.join(ownedPath, "foreign.txt")),
            "Retain the replacement inode.",
          );
          assert.equal(yield* hashSkillPackage(fixture.source), fixture.hash);
          yield* fixture.fs.remove(ownedPath, { recursive: true });
        }),
      );
    }

    it.effect(
      "preserves a published directory whose ownership marker changed before cancellation",
      () =>
        Effect.gen(function* () {
          const fixture = yield* cancellationFixture();
          const hooked = FileSystem.FileSystem.of({
            ...fixture.fs,
            rename: (from, to) =>
              fixture.fs.rename(from, to).pipe(Effect.andThen(fixture.hold(to)), Effect.asVoid),
          });
          const service = yield* SkillMaterializationService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, hooked),
            Effect.provideService(ServerConfig.ServerConfig, fixture.config),
          );
          const fiber = yield* service.materialize(fixture.input).pipe(Effect.forkChild);
          yield* Deferred.await(fixture.entered);
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.root, ".t3-owned.json"),
            "{}",
          );
          yield* Fiber.interrupt(fiber);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
          assert.equal(
            yield* fixture.fs.readFileString(fixture.path.join(fixture.root, ".t3-owned.json")),
            "{}",
          );
          assert.isTrue(
            yield* fixture.fs.exists(fixture.path.join(fixture.root, "review", "SKILL.md")),
          );
        }),
    );

    for (const phase of ["copy", "rename"] as const) {
      it.effect(
        `cleans its owned directory when ${phase} fails after the filesystem operation`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* cancellationFixture();
            const failReceipt = fixture.fs
              .readFileString(fixture.path.join(fixture.source, "missing-receipt"))
              .pipe(Effect.asVoid);
            const hooked = FileSystem.FileSystem.of({
              ...fixture.fs,
              copy: (from, to, options) =>
                fixture.fs
                  .copy(from, to, options)
                  .pipe(Effect.andThen(phase === "copy" ? failReceipt : Effect.void)),
              rename: (from, to) =>
                fixture.fs
                  .rename(from, to)
                  .pipe(Effect.andThen(phase === "rename" ? failReceipt : Effect.void)),
            });
            const service = yield* SkillMaterializationService.make.pipe(
              Effect.provideService(FileSystem.FileSystem, hooked),
              Effect.provideService(ServerConfig.ServerConfig, fixture.config),
            );
            assert.equal(
              (yield* service.materialize(fixture.input).pipe(Effect.result))._tag,
              "Failure",
            );
            assert.deepEqual(
              (yield* fixture.fs.readDirectory(fixture.config.skillRuntimeDir)).filter((entry) =>
                entry.startsWith(".pending-"),
              ),
              [],
            );
            assert.isFalse(yield* fixture.fs.exists(fixture.root));
            assert.equal(yield* hashSkillPackage(fixture.source), fixture.hash);
          }),
      );
    }
  });
});
