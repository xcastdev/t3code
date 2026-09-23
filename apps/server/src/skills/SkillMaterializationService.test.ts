import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillContent, ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import * as SkillMaterializationService from "./SkillMaterializationService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";
import { makeClaudeSkillAdapter, makeCodexSkillAdapter } from "./ProviderSkillAdapters.ts";

const encodeFixtureMarker = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
