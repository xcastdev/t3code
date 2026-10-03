import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedSkillContent,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as Repository from "../../skills/ManagedSkillRepository.ts";
import { hashSkillPackage } from "../../skills/SkillPackage.ts";
import {
  PiManagedSkillSelectionError,
  resolvePiManagedSkillSelection,
} from "./PiManagedSkillSelection.ts";

const TestLayer = Repository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-skill-selection-" })),
  Layer.provideMerge(NodeServices.layer),
);
const key = Schema.decodeUnknownSync(ManagedSkillKey);
const id = Schema.decodeUnknownSync(ManagedSkillId);
const decodeOwned = Schema.decodeUnknownEffect(
  Schema.Struct({
    packagePath: Schema.String,
    manifest: ManagedSkillManifest,
    content: ManagedSkillContent,
  }),
);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ManagedSkillManifest));
const fixture = Effect.fn("PiManagedSkillSelection.fixture")(function* () {
  const repository = yield* Repository.ManagedSkillRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-skill-primary-" });
  const skill = yield* repository.importGlobal({
    expectedRevision: 0,
    content: { key: key("selected"), name: "Selected skill", body: "Read assets/notes.txt" },
    files: [{ relativePath: "assets/notes.txt", bytes: new TextEncoder().encode("inert asset") }],
  });
  const input = {
    projectRoot,
    selectedSkillIds: [skill.manifest.id],
    roleSkillIds: [skill.manifest.id],
  };
  return { repository, fs, path, projectRoot, skill, input };
});
const denied = (
  effect: Effect.Effect<
    ReadonlyArray<unknown>,
    PiManagedSkillSelectionError,
    Repository.ManagedSkillRepository
  >,
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "PiManagedSkillSelectionError");
        assert.equal(result.failure.code, "denied");
      }
    }),
  );
const withRepository = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  repository: Repository.ManagedSkillRepositoryService,
) => effect.pipe(Effect.provideService(Repository.ManagedSkillRepository, repository));

describe("resolvePiManagedSkillSelection", () => {
  it.effect(
    "selects stable IDs, complete package hashes and immutable key order without changing bytes",
    () =>
      Effect.gen(function* () {
        const { repository, fs, path, skill, input } = yield* fixture();
        const earlier = yield* repository.createGlobal({
          expectedRevision: 0,
          content: { key: key("alpha"), name: "Alpha", body: "a" },
        });
        const files = ["SKILL.md", "t3-skill.json", "assets/notes.txt"];
        const before = yield* Effect.forEach(files, (file) =>
          fs.readFile(path.join(skill.packagePath, file)),
        );
        assert.notEqual(String(skill.manifest.id), String(skill.manifest.key));
        const selected = yield* resolvePiManagedSkillSelection({
          ...input,
          selectedSkillIds: [skill.manifest.id, earlier.manifest.id],
          roleSkillIds: [skill.manifest.id, earlier.manifest.id, "uninstalled-role-skill"],
        });
        assert.deepEqual(
          selected.map((item) => item.key),
          ["alpha", "selected"],
        );
        assert.deepEqual(selected[1], {
          skillId: skill.manifest.id,
          key: skill.manifest.key,
          packagePath: skill.packagePath,
          expectedHash: yield* hashSkillPackage(skill.packagePath),
        });
        assert.isTrue(Object.isFrozen(selected));
        assert.isTrue(selected.every(Object.isFrozen));
        assert.deepEqual(
          yield* Effect.forEach(files, (file) => fs.readFile(path.join(skill.packagePath, file))),
          before,
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("empty selection accesses no repository method even with unusable root and role", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.ManagedSkillRepository;
      const unavailable = () => Effect.die("empty selection touched repository");
      const result = yield* withRepository(
        resolvePiManagedSkillSelection({
          projectRoot: "",
          selectedSkillIds: [],
          roleSkillIds: ["../bad"],
        }),
        {
          ...repository,
          listGlobal: unavailable,
          listProject: unavailable,
          readGlobal: unavailable,
          readProject: unavailable,
        },
      );
      assert.deepEqual(result, []);
      assert.isTrue(Object.isFrozen(result));
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const invalid of ["../selected", "con", "", "a".repeat(129)]) {
    it.effect(`rejects invalid selected ID ${invalid.slice(0, 20)}`, () =>
      Effect.gen(function* () {
        const { input } = yield* fixture();
        yield* denied(
          resolvePiManagedSkillSelection({
            ...input,
            selectedSkillIds: [invalid],
            roleSkillIds: [invalid],
          }),
        );
      }).pipe(Effect.provide(TestLayer)),
    );
  }
  it.effect(
    "rejects duplicate, oversized, missing, native-name and out-of-role selections before owned reads",
    () =>
      Effect.gen(function* () {
        const { repository, skill, input } = yield* fixture();
        let reads = 0;
        const tracked = {
          ...repository,
          readGlobal: (skillId: ManagedSkillId) =>
            Effect.sync(() => reads++).pipe(Effect.andThen(repository.readGlobal(skillId))),
        };
        for (const selected of [
          [skill.manifest.id, skill.manifest.id],
          Array.from({ length: 33 }, (_, index) => `id-${index}`),
          ["missing-id"],
          [skill.manifest.key],
        ]) {
          yield* withRepository(
            denied(
              resolvePiManagedSkillSelection({
                ...input,
                selectedSkillIds: selected,
                roleSkillIds: selected,
              }),
            ),
            tracked,
          );
        }
        yield* withRepository(
          denied(resolvePiManagedSkillSelection({ ...input, roleSkillIds: [] })),
          tracked,
        );
        assert.equal(reads, 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a project override wins by its own ID and denies the shadowed global ID", () =>
    Effect.gen(function* () {
      const { repository, projectRoot, skill, input } = yield* fixture();
      const override = yield* repository.setProjectOverride({
        projectRoot,
        key: skill.manifest.key,
        content: { name: "Project selected", body: "project" },
      });
      yield* denied(resolvePiManagedSkillSelection(input));
      const result = yield* resolvePiManagedSkillSelection({
        ...input,
        selectedSkillIds: [override.manifest.id],
        roleSkillIds: [override.manifest.id],
      });
      assert.equal(result[0]?.packagePath, override.packagePath);
      assert.equal(result[0]?.expectedHash, override.manifest.revision.hash);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("project tombstones block global inheritance and cannot themselves be selected", () =>
    Effect.gen(function* () {
      const { repository, projectRoot, skill, input } = yield* fixture();
      const disabled = yield* repository.setProjectDisabled({
        projectRoot,
        key: skill.manifest.key,
      });
      yield* denied(resolvePiManagedSkillSelection(input));
      yield* denied(
        resolvePiManagedSkillSelection({
          ...input,
          selectedSkillIds: [disabled.manifest.id],
          roleSkillIds: [disabled.manifest.id],
        }),
      );
      yield* repository.deleteProjectState({
        projectRoot,
        key: skill.manifest.key,
        expectedHash: disabled.manifest.revision.hash,
      });
      assert.equal((yield* resolvePiManagedSkillSelection(input))[0]?.skillId, skill.manifest.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("invalid project overrides block global fallback", () =>
    Effect.gen(function* () {
      const { repository, fs, path, projectRoot, skill, input } = yield* fixture();
      const override = yield* repository.setProjectOverride({
        projectRoot,
        key: skill.manifest.key,
        content: { name: "Override", body: "project" },
      });
      yield* fs.writeFileString(path.join(override.packagePath, "SKILL.md"), "malformed");
      yield* denied(resolvePiManagedSkillSelection(input));
      yield* denied(
        resolvePiManagedSkillSelection({
          ...input,
          selectedSkillIds: [override.manifest.id],
          roleSkillIds: [override.manifest.id],
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects duplicate stable IDs across different real package keys", () =>
    Effect.gen(function* () {
      const { repository, fs, path, skill, input } = yield* fixture();
      const second = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: key("other"), name: "Other", body: "b" },
      });
      yield* fs.writeFileString(
        path.join(second.packagePath, "t3-skill.json"),
        encodeManifest({ ...second.manifest, id: skill.manifest.id }),
      );
      yield* denied(resolvePiManagedSkillSelection(input));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects duplicate catalogue keys and selected invalid packages", () =>
    Effect.gen(function* () {
      const { repository, fs, path, skill, input } = yield* fixture();
      yield* withRepository(denied(resolvePiManagedSkillSelection(input)), {
        ...repository,
        listGlobal: () =>
          repository
            .listGlobal()
            .pipe(
              Effect.map((entries) =>
                entries.flatMap((entry) =>
                  entry.manifest === undefined
                    ? [entry]
                    : [
                        entry,
                        { ...entry, manifest: { ...entry.manifest, id: id("duplicate-key-id") } },
                      ],
                ),
              ),
            ),
      });
      yield* fs.writeFileString(
        path.join(skill.packagePath, "assets/notes.txt"),
        "changed without manifest hash",
      );
      yield* denied(resolvePiManagedSkillSelection(input));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a stable ID follows a completed rename and content change on a fresh selection", () =>
    Effect.gen(function* () {
      const { repository, skill, input } = yield* fixture();
      const renamed = yield* repository.renameGlobal({
        skillId: skill.manifest.id,
        key: key("renamed"),
        expectedHash: skill.manifest.revision.hash,
      });
      const updated = yield* repository.updateGlobal({
        skillId: skill.manifest.id,
        expectedHash: renamed.manifest.revision.hash,
        content: { name: "Changed", body: "new" },
      });
      assert.deepEqual((yield* resolvePiManagedSkillSelection(input))[0], {
        skillId: skill.manifest.id,
        key: key("renamed"),
        packagePath: updated.packagePath,
        expectedHash: updated.manifest.revision.hash,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("binds inert auxiliary bytes even when the selected document is unchanged", () =>
    Effect.gen(function* () {
      const { repository, fs, path, skill, input } = yield* fixture();
      const document = yield* fs.readFileString(path.join(skill.packagePath, "SKILL.md"));
      const changedRead = {
        ...repository,
        readGlobal: (skillId: ManagedSkillId) =>
          Effect.gen(function* () {
            const value = yield* repository.readGlobal(skillId);
            yield* fs.writeFileString(
              path.join(skill.packagePath, "assets/notes.txt"),
              "different inert bytes",
            );
            const hash = yield* hashSkillPackage(skill.packagePath).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            yield* fs.writeFileString(
              path.join(skill.packagePath, "t3-skill.json"),
              encodeManifest({ ...skill.manifest, revision: { ...skill.manifest.revision, hash } }),
            );
            return value;
          }),
      };
      yield* withRepository(denied(resolvePiManagedSkillSelection(input)), changedRead);
      assert.equal(yield* fs.readFileString(path.join(skill.packagePath, "SKILL.md")), document);
      const current = yield* resolvePiManagedSkillSelection(input);
      assert.notEqual(current[0]?.expectedHash, skill.manifest.revision.hash);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves typed scan unavailability and denies an owned-read failure", () =>
    Effect.gen(function* () {
      const { repository, input } = yield* fixture();
      const failure = new Repository.ManagedSkillRepositoryError({
        code: "invalid_package",
        detail: "fixture scan failure",
      });
      const result = yield* withRepository(resolvePiManagedSkillSelection(input), {
        ...repository,
        listProject: () => Effect.fail(failure),
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "unavailable");
      yield* withRepository(denied(resolvePiManagedSkillSelection(input)), {
        ...repository,
        readGlobal: () => Effect.fail(failure),
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const mutation of ["rename", "content", "override", "disable", "unrelated"] as const) {
    it.effect(`${mutation} during the asynchronous owned-read receipt is revalidated`, () =>
      Effect.gen(function* () {
        const { repository, projectRoot, skill, input } = yield* fixture();
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = {
          ...repository,
          readGlobal: (skillId: ManagedSkillId) =>
            Effect.gen(function* () {
              const owned = yield* repository.readGlobal(skillId);
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
              return owned;
            }),
        };
        const running = yield* withRepository(resolvePiManagedSkillSelection(input), delayed).pipe(
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(read);
        if (mutation === "rename")
          yield* repository.renameGlobal({
            skillId: skill.manifest.id,
            expectedHash: skill.manifest.revision.hash,
            key: key("renamed"),
          });
        if (mutation === "content")
          yield* repository.updateGlobal({
            skillId: skill.manifest.id,
            expectedHash: skill.manifest.revision.hash,
            content: { name: "Changed", body: "new" },
          });
        if (mutation === "override")
          yield* repository.setProjectOverride({
            projectRoot,
            key: skill.manifest.key,
            content: { name: "Override", body: "new" },
          });
        if (mutation === "disable")
          yield* repository.setProjectDisabled({ projectRoot, key: skill.manifest.key });
        if (mutation === "unrelated")
          yield* repository.createGlobal({
            expectedRevision: 0,
            content: { key: key("unrelated"), name: "Unrelated", body: "new" },
          });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(running);
        if (mutation === "unrelated") {
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result))
            assert.equal(result.success[0]?.expectedHash, skill.manifest.revision.hash);
        } else {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.code, "denied");
        }
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  for (const forged of ["id", "key", "path", "hash", "scope", "ownership", "content"] as const) {
    it.effect(`rejects replaced repository ${forged} output`, () =>
      Effect.gen(function* () {
        const { repository, skill, input } = yield* fixture();
        const replacement = {
          ...skill,
          ...(forged === "path" ? { packagePath: skill.packagePath + "-foreign" } : {}),
          manifest: {
            ...skill.manifest,
            ...(forged === "id" ? { id: id("forged-id") } : {}),
            ...(forged === "key" ? { key: key("forged-key") } : {}),
            ...(forged === "hash"
              ? {
                  revision: {
                    ...skill.manifest.revision,
                    hash: skill.manifest.revision.hash + "f",
                  },
                }
              : {}),
            ...(forged === "scope" ? { scope: "project" as const } : {}),
            ...(forged === "ownership" ? { ownership: "external" } : {}),
          },
          content: forged === "content" ? { ...skill.content, body: "forged body" } : skill.content,
        };
        const decoded = yield* decodeOwned(replacement);
        const control = yield* withRepository(resolvePiManagedSkillSelection(input), {
          ...repository,
          readGlobal: () => Effect.succeed(skill),
        });
        assert.equal(control[0]?.expectedHash, skill.manifest.revision.hash);
        yield* withRepository(denied(resolvePiManagedSkillSelection(input)), {
          ...repository,
          readGlobal: () => Effect.succeed(decoded),
        });
      }).pipe(Effect.provide(TestLayer)),
    );
  }
});
