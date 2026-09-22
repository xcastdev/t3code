import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillContent, ManagedSkillKey } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import * as SkillCatalogIndex from "./SkillCatalogIndex.ts";

const content = (key: string, body: string): ManagedSkillContent => ({
  key: key as ManagedSkillKey,
  name: `Skill ${key}`,
  body,
});

const TestLayer = ManagedSkillRepository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-catalog-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("SkillCatalogIndex", () => {
  it.layer(TestLayer)("reconstructs compact global and project snapshots from disk", (it) => {
    it.effect("indexes authored state without package bodies or native paths", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-project-" });
        yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("deploy", "secret"),
        });
        yield* repository.setProjectDisabled({ projectRoot, key: "deploy" as ManagedSkillKey });

        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make.pipe(Effect.provideService(Scope.Scope, scope));
        const project = yield* index.acquireProject(projectRoot);
        const global = yield* index.getGlobal;

        assert.deepEqual(
          global.entries.map((entry) => entry.key),
          ["deploy"],
        );
        assert.deepEqual(
          project.entries.map((entry) => [entry.key, entry.state]),
          [["deploy", "disabled"]],
        );
        assert.notProperty(global.entries[0]!, "body");
        assert.notProperty(project.entries[0]!, "body");
        assert.notEqual(project.scopeId, projectRoot);
        assert.notInclude(
          [...global.entries, ...project.entries].flatMap((entry) =>
            entry.diagnostics.map((diagnostic) => diagnostic.message),
          ),
          projectRoot,
        );
        assert.isAbove(global.catalogRevision, 0);

        yield* index.releaseProject(projectRoot);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect(
      "notifies changed keys for edits, validity transitions, state changes, and deletes",
      () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const fs = yield* FileSystem.FileSystem;
          const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-project-" });
          const index = yield* SkillCatalogIndex.make;
          yield* index.acquireProject(projectRoot);
          const subscription = yield* index.subscribe;

          const created = yield* repository.createGlobal({
            expectedRevision: 0,
            content: content("notify", "one"),
          });
          const added = yield* index.refreshGlobal;
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);

          yield* repository.updateGlobal({
            skillId: created.manifest.id,
            expectedHash: created.manifest.revision.hash,
            content: { name: "Deploy two", body: "two" },
          });
          const edited = yield* index.refreshGlobal;
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);
          assert.isAbove(edited.catalogRevision, added.catalogRevision);

          const unchanged = yield* index.refreshGlobal;
          assert.equal(unchanged.catalogRevision, edited.catalogRevision);
          assert.deepEqual(yield* PubSub.takeUpTo(subscription, 10), []);

          const globalRoot = (yield* ServerConfig.ServerConfig).managedSkillsDir;
          const validManifest = yield* fs.readFileString(`${globalRoot}/notify/t3-skill.json`);
          yield* fs.writeFileString(`${globalRoot}/notify/t3-skill.json`, "{ broken");
          const malformed = yield* index.refreshGlobal;
          assert.equal(
            malformed.entries.find((entry) => entry.key === "notify")?.validity,
            "invalid",
          );
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);

          yield* fs.writeFileString(`${globalRoot}/notify/t3-skill.json`, validManifest);
          const validSkill = yield* fs.readFileString(`${globalRoot}/notify/SKILL.md`);
          yield* fs.writeFileString(
            `${globalRoot}/notify/SKILL.md`,
            validSkill.replace(
              "description: Deploy two",
              "description: Deploy two\nallowed-tools: 42",
            ),
          );
          const invalidKnownExtension = yield* index.refreshGlobal;
          assert.equal(
            invalidKnownExtension.entries.find((entry) => entry.key === "notify")?.validity,
            "invalid",
          );
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);

          yield* fs.writeFileString(`${globalRoot}/notify/SKILL.md`, validSkill);
          const repaired = yield* index.refreshGlobal;
          assert.equal(repaired.entries.find((entry) => entry.key === "notify")?.validity, "valid");
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);

          yield* fs.remove(`${globalRoot}/notify`, { recursive: true });
          const cleared = yield* index.refreshGlobal;
          assert.notInclude(
            cleared.entries.map((entry) => entry.key),
            "notify",
          );
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["notify"]);

          const override = yield* repository.setProjectOverride({
            projectRoot,
            key: "deploy" as ManagedSkillKey,
            content: { name: "Project deploy", body: "project" },
          });
          yield* index.refreshProject(projectRoot);
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["deploy"]);
          yield* repository.setProjectDisabled({
            projectRoot,
            key: "deploy" as ManagedSkillKey,
            expectedHash: override.manifest.revision.hash,
          });
          const disabled = yield* index.refreshProject(projectRoot);
          assert.equal(disabled.entries[0]?.state, "disabled");
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["deploy"]);
        }),
    );

    it.effect(
      "retains the last good snapshot when a scan fails and distinguishes a later empty scan",
      () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          yield* repository.createGlobal({
            expectedRevision: 0,
            content: content("retained", "one"),
          });
          const fail = yield* Ref.make(false);
          const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
            ...repository,
            listGlobal: () =>
              Effect.flatMap(Ref.get(fail), (shouldFail) =>
                shouldFail
                  ? Effect.fail(
                      new ManagedSkillRepository.ManagedSkillRepositoryError({
                        code: "mutation_failed",
                        detail: "private native path must not escape",
                      }),
                    )
                  : repository.listGlobal(),
              ),
          });
          const index = yield* SkillCatalogIndex.make.pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          );
          const subscription = yield* index.subscribe;
          yield* Ref.set(fail, true);
          const unavailable = yield* index.refreshGlobal;
          assert.equal(unavailable.availability, "unavailable");
          assert.include(
            unavailable.entries.map((entry) => entry.key),
            "retained",
          );
          assert.notInclude(unavailable.error?.message ?? "", "private native path");
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, []);

          yield* repository.deleteGlobal({
            skillId: (yield* repository.listGlobal()).find(
              (entry) => entry.manifest?.key === "retained",
            )!.manifest!.id,
            expectedHash: (yield* repository.listGlobal()).find(
              (entry) => entry.manifest?.key === "retained",
            )!.manifest!.revision.hash,
          });
          yield* Ref.set(fail, false);
          const empty = yield* index.refreshGlobal;
          assert.equal(empty.availability, "available");
          assert.notInclude(
            empty.entries.map((entry) => entry.key),
            "retained",
          );
          assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["retained"]);
        }),
    );

    it.effect("delivers the same compact invalidation to concurrent subscribers", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const index = yield* SkillCatalogIndex.make;
        const first = yield* index.subscribe;
        const second = yield* index.subscribe;

        yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("multi-subscriber", "body stays on disk"),
        });
        yield* index.refreshGlobal;
        const firstChange = yield* PubSub.take(first);
        const secondChange = yield* PubSub.take(second);

        assert.deepEqual(firstChange, secondChange);
        assert.deepEqual(firstChange.changedKeys, ["multi-subscriber"]);
        assert.notProperty(firstChange, "body");
      }),
    );

    it.effect("rolls back a new project when its first scan is interrupted", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-project-" });
        yield* repository.setProjectOverride({
          projectRoot,
          key: "retry" as ManagedSkillKey,
          content: { name: "Retry", body: "fresh" },
        });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let block = true;
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            Effect.gen(function* () {
              if (block) {
                yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
                yield* Deferred.await(gate);
              }
              return yield* repository.listProject(root);
            }),
        });
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        const fiber = yield* index.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        block = false;

        const retry = yield* index.acquireProject(projectRoot);
        assert.deepEqual(
          retry.entries.map((entry) => entry.key),
          ["retry"],
        );
        yield* index.releaseProject(projectRoot);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
      }),
    );

    it.effect("hands a new-record lease to rollback before an interrupted return", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-new-return-" });
        const index = yield* SkillCatalogIndex.make;
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let lease: SkillCatalogIndex.ProjectLease | undefined;
        let acquisitionFiber: Fiber.Fiber<unknown, unknown> | undefined;
        const acquisition = yield* SkillCatalogIndex.acquireProjectOwned(
          index,
          projectRoot,
          (claimed) => void (lease = claimed),
          Effect.withFiber((fiber) => {
            acquisitionFiber = fiber;
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)));
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        acquisitionFiber!.interruptUnsafe();
        yield* Deferred.succeed(gate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(acquisition)));
        yield* lease!.release;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));

        yield* index.acquireProject(projectRoot);
        yield* index.releaseProject(projectRoot);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
      }),
    );

    it.effect("keeps an existing-project semaphore waiter interruptible", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const rootA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-wait-a-" });
        const rootB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-wait-b-" });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            root === rootA
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(repository.listProject(root)),
                )
              : repository.listProject(root),
        });
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        yield* index.acquireProject(rootB);
        const blockedA = yield* index.acquireProject(rootA).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiterB = yield* index.acquireProject(rootB).pipe(Effect.forkChild);
        yield* Fiber.interrupt(waiterB);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(blockedA);
        yield* index.releaseProject(rootA);
        yield* index.releaseProject(rootB);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(rootB))));
      }),
    );

    it.effect("hands an existing-record lease to rollback before an interrupted return", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-existing-" });
        const index = yield* SkillCatalogIndex.make;
        yield* index.acquireProject(projectRoot);
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let lease: SkillCatalogIndex.ProjectLease | undefined;
        let acquisitionFiber: Fiber.Fiber<unknown, unknown> | undefined;
        const acquisition = yield* SkillCatalogIndex.acquireProjectOwned(
          index,
          projectRoot,
          (claimed) => void (lease = claimed),
          Effect.withFiber((fiber) => {
            acquisitionFiber = fiber;
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)));
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        acquisitionFiber!.interruptUnsafe();
        yield* Deferred.succeed(gate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(acquisition)));
        yield* lease!.release;
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(index.getProject(projectRoot))));
        yield* index.releaseProject(projectRoot);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
      }),
    );

    it.effect("keeps ownership cells per execution when one public acquire effect is reused", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-reused-" });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(repository.listProject(root)),
            ),
        });
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        const acquire = index.acquireProject(projectRoot);
        const accepted = yield* acquire.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupted = yield* acquire.pipe(Effect.forkChild);
        yield* Fiber.interrupt(interrupted);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(accepted);
        yield* index.releaseProject(projectRoot);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
      }),
    );
  });
});
