import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ManagedSkillKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ServerConfig from "../config.ts";
import * as Repository from "./ManagedSkillRepository.ts";
import { SkillMutationCommitAuthority } from "./SkillMutationCommitAuthority.ts";

const dependencies = Repository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-authority-" })),
  Layer.provideMerge(NodeServices.layer),
);
const denied = () =>
  new Repository.ManagedSkillRepositoryError({
    code: "mutation_failed",
    detail: "Permission revoked.",
  });

describe("SkillMutationCommitAuthority", () => {
  it.effect("commits authored and disabled project packages through synchronous authority", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.ManagedSkillRepository;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-project-authority-" });
      const created = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "original" },
      });
      const updated = yield* repository.updateGlobal({
        skillId: created.manifest.id,
        expectedHash: created.manifest.revision.hash,
        content: { name: "Deploy", body: "updated" },
      });
      assert.equal(updated.content.body, "updated");
      const disabled = yield* repository.setProjectDisabled({
        projectRoot: root,
        key: created.manifest.key,
      });
      assert.equal(disabled.projectState, "disabled");
      const override = yield* repository.setProjectOverride({
        projectRoot: root,
        key: created.manifest.key,
        expectedHash: disabled.manifest.revision.hash,
        content: { name: "Deploy", body: "project" },
      });
      assert.equal(override.content.body, "project");
      yield* repository.deleteProjectState({
        projectRoot: root,
        key: created.manifest.key,
        expectedHash: override.manifest.revision.hash,
      });
      yield* repository.deleteGlobal({
        skillId: created.manifest.id,
        expectedHash: updated.manifest.revision.hash,
      });
      assert.equal((yield* repository.listGlobal()).length, 0);
    }).pipe(
      Effect.provideService(SkillMutationCommitAuthority, {
        commit: (action) =>
          Effect.try({
            try: action,
            catch: (cause) =>
              new Repository.ManagedSkillRepositoryError({
                code: "mutation_failed",
                detail: "Commit failed.",
                cause,
              }),
          }),
      }),
      Effect.provide(dependencies),
      Effect.scoped,
    ),
  );

  it.effect.each(["delete", "update"] as const)(
    "refuses history ancestor redirected during final %s authority",
    (operation) =>
      Effect.gen(function* () {
        const repository = yield* Repository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const created = yield* repository.createGlobal({
          expectedRevision: 0,
          content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "original" },
        });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-history-outside-" });
        const historyRoot = `${config.stateDir}/skill-history/${created.manifest.id}`;
        const mutation =
          operation === "delete"
            ? repository.deleteGlobal({
                skillId: created.manifest.id,
                expectedHash: created.manifest.revision.hash,
              })
            : repository
                .updateGlobal({
                  skillId: created.manifest.id,
                  expectedHash: created.manifest.revision.hash,
                  content: { name: "Deploy", body: "updated" },
                })
                .pipe(Effect.asVoid);
        const result = yield* mutation.pipe(
          Effect.provideService(SkillMutationCommitAuthority, {
            commit: (action) =>
              fs.rename(historyRoot, `${historyRoot}.saved`).pipe(
                Effect.andThen(fs.symlink(outside, historyRoot)),
                Effect.andThen(Effect.try({ try: action, catch: () => denied() })),
                Effect.mapError(() => denied()),
              ),
          }),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        assert.equal((yield* repository.readGlobal(created.manifest.id)).content.body, "original");
        assert.deepEqual(yield* fs.readDirectory(outside), []);
      }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("returns empty history on a fresh create without creating history directories", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.ManagedSkillRepository;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const created = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "original" },
      });
      assert.deepEqual(yield* repository.listGlobalHistory(created.manifest.id), []);
      assert.isFalse(yield* fs.exists(`${config.stateDir}/skill-history`));
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("rejects authority revoked after staging and preserves current bytes", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.ManagedSkillRepository;
      const created = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "original" },
      });
      const result = yield* repository
        .updateGlobal({
          skillId: created.manifest.id,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Deploy", body: "changed" },
        })
        .pipe(
          Effect.provideService(SkillMutationCommitAuthority, {
            commit: () => Effect.fail(denied()),
          }),
          Effect.result,
        );
      assert.isTrue(Result.isFailure(result));
      assert.equal((yield* repository.readGlobal(created.manifest.id)).content.body, "original");
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      assert.deepEqual(yield* fs.readDirectory(`${config.stateDir}/skills`), ["deploy"]);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );

  it.effect("refuses bytes edited during final grant lookup", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.ManagedSkillRepository;
      const fs = yield* FileSystem.FileSystem;
      const created = yield* repository.createGlobal({
        expectedRevision: 0,
        content: { key: ManagedSkillKey.make("deploy"), name: "Deploy", body: "original" },
      });
      const result = yield* repository
        .updateGlobal({
          skillId: created.manifest.id,
          expectedHash: created.manifest.revision.hash,
          content: { name: "Deploy", body: "changed" },
        })
        .pipe(
          Effect.provideService(SkillMutationCommitAuthority, {
            commit: (action) =>
              fs.writeFileString(`${created.packagePath}/SKILL.md`, "user edit").pipe(
                Effect.andThen(Effect.try({ try: action, catch: () => denied() })),
                Effect.mapError(() => denied()),
              ),
          }),
          Effect.result,
        );
      assert.isTrue(Result.isFailure(result));
      assert.equal(yield* fs.readFileString(`${created.packagePath}/SKILL.md`), "user edit");
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );
});
