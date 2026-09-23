import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedSkillKey,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderSkillAdapter } from "./ProviderSkillAdapter.ts";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as Repository from "./ManagedSkillRepository.ts";
import * as Index from "./SkillCatalogIndex.ts";
import * as Native from "./NativeSkillObservationService.ts";
import { acceptCatalogIndexChange, make } from "./SkillCatalogService.ts";
import { SkillWatchService } from "./SkillWatchService.ts";

const dependencies = Index.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Native.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-catalog-" })),
  Layer.provideMerge(NodeServices.layer),
);

const registry = Layer.effect(
  ProviderInstanceRegistry,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    return ProviderInstanceRegistry.of({
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);

const registryWithSkillAdapter = (adapter: ProviderSkillAdapter) =>
  Layer.effect(
    ProviderInstanceRegistry,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const instance = {
        instanceId: ProviderInstanceId.make("codex"),
        enabled: true,
        skillAdapter: adapter,
      } as unknown as ProviderInstance;
      return ProviderInstanceRegistry.of({
        getInstance: () => Effect.succeed(instance),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
      });
    }),
  );

describe("SkillCatalogService", () => {
  it.effect("does not prepare an adapter for an empty managed catalog", () => {
    let prepareCalls = 0;
    const adapter = {
      discoverNative: () => Effect.die(new Error("discovery must not run")),
      evaluateCompatibility: () => {
        throw new Error("compatibility must not run");
      },
      prepareSession: () =>
        Effect.sync(() => {
          prepareCalls += 1;
          throw new Error("preparation must not run");
        }),
      disposeSession: () => Effect.void,
    } as unknown as ProviderSkillAdapter;
    return Effect.gen(function* () {
      const catalog = yield* make.pipe(
        Effect.provideService(
          SkillWatchService,
          SkillWatchService.of({
            acquireProject: () => Effect.die(new Error("project watch must not run")),
            releaseProject: () => Effect.void,
            invalidateGlobal: Effect.void,
            invalidateProject: () => Effect.void,
          }),
        ),
      );
      const prepared = yield* catalog.prepareSession({
        threadId: "thread",
        providerInstanceId: ProviderInstanceId.make("codex"),
        cwd: process.cwd(),
        desiredRevision: SkillCatalogRevision.make(1),
        appliedRevision: SkillCatalogRevision.make(0),
      });
      assert.isUndefined(prepared.plan);
      assert.equal(prepareCalls, 0);
    }).pipe(
      Effect.provide(Layer.merge(registryWithSkillAdapter(adapter), dependencies)),
      Effect.scoped,
    );
  });

  it("deduplicates catalog index invalidations by scope revision", () => {
    const published = new Map<string, number>();
    const change = {
      scope: "global" as const,
      scopeId: "global",
      catalogRevision: 4,
      changedKeys: [],
    };

    assert.isTrue(acceptCatalogIndexChange(published, change));
    assert.isFalse(acceptCatalogIndexChange(published, change));
    assert.isFalse(acceptCatalogIndexChange(published, { ...change, catalogRevision: 3 }));
    assert.isTrue(acceptCatalogIndexChange(published, { ...change, catalogRevision: 5 }));
  });

  it.effect("refuses external native preview and import before touching local files", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const watches = SkillWatchService.of({
        acquireProject: index.acquireProject,
        releaseProject: index.releaseProject,
        invalidateGlobal: Effect.void,
        invalidateProject: () => Effect.void,
      });
      const catalog = yield* make.pipe(Effect.provideService(SkillWatchService, watches));
      const discovery = yield* (yield* Native.NativeSkillObservationService).discover({
        providerInstanceId: ProviderInstanceId.make("remote-opencode"),
        scopeId: "/remote",
        discovery: Effect.succeed([
          {
            nativeIdentity: "remote-skill",
            nativePath: "/a/path/on/the/external/server/SKILL.md",
            contentAccess: "external",
            key: "deploy",
            displayName: "Deploy",
            source: "opencode",
            scopeSummary: "project",
          },
        ]),
      });
      const observationId = discovery.observations[0]!.observationId;
      assert.equal(
        (yield* catalog.nativeContent({ observationId, maxBytes: 1024 }).pipe(Effect.flip)).code,
        "external_filesystem",
      );
      assert.equal(
        (yield* catalog
          .importNative({ observationId, expectedRevision: 0, key: ManagedSkillKey.make("deploy") })
          .pipe(Effect.flip)).code,
        "external_filesystem",
      );
      assert.equal((yield* catalog.list()).entries.length, 0);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
  it.effect("reports an unsafe native import without hiding the cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-import-error-" });
      const packageRoot = path.join(root, "source");
      yield* fs.makeDirectory(packageRoot);
      yield* fs.writeFileString(
        path.join(packageRoot, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy\n---\nBody",
      );
      yield* fs.symlink("source", path.join(root, "redirect"));
      const index = yield* Index.SkillCatalogIndex;
      const catalog = yield* make.pipe(
        Effect.provideService(
          SkillWatchService,
          SkillWatchService.of({
            acquireProject: index.acquireProject,
            releaseProject: index.releaseProject,
            invalidateGlobal: Effect.void,
            invalidateProject: () => Effect.void,
          }),
        ),
      );
      const discovery = yield* (yield* Native.NativeSkillObservationService).discover({
        providerInstanceId: ProviderInstanceId.make("claude"),
        scopeId: root,
        discovery: Effect.succeed([
          {
            nativeIdentity: "redirected-deploy",
            nativePath: path.join(root, "redirect", "SKILL.md"),
            contentAccess: "local",
            key: "deploy",
            displayName: "Deploy",
            source: "claude",
            scopeSummary: "user",
          },
        ]),
      });
      const error = yield* catalog
        .importNative({
          observationId: discovery.observations[0]!.observationId,
          expectedRevision: 0,
          key: ManagedSkillKey.make("deploy"),
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "unsafe_native_package");
      assert.equal((yield* catalog.list()).entries.length, 0);
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
  it.effect("persists shallow overlays, resets them, and rejects concurrent stale mutations", () =>
    Effect.gen(function* () {
      const index = yield* Index.SkillCatalogIndex;
      const watches = SkillWatchService.of({
        acquireProject: index.acquireProject,
        releaseProject: index.releaseProject,
        invalidateGlobal: Effect.void,
        invalidateProject: () => Effect.void,
      });
      const build = make.pipe(Effect.provideService(SkillWatchService, watches));
      const catalog = yield* build;
      const key = ManagedSkillKey.make("deploy");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const created = yield* catalog.createGlobal({
        expectedRevision: 0,
        content: { key, name: "Deploy", body: "Run the deployment checks." },
      });
      const input = {
        threadId: "thread",
        providerInstanceId,
        key,
        expectedRevision: created.catalogRevision,
        enabled: false,
      };
      const attempts = yield* Effect.all(
        [
          catalog.setSessionEnabled(input).pipe(Effect.result),
          catalog.setSessionEnabled(input).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter(Result.isSuccess).length, 1);
      assert.equal(attempts.filter(Result.isFailure).length, 1);
      const reconstructed = yield* build;
      const context = { threadId: "thread", providerInstanceId };
      const disabled = yield* reconstructed.list(context);
      assert.isFalse(disabled.entries.find((entry) => entry.key === key)!.effective);
      assert.equal(disabled.catalogRevision, created.catalogRevision + 1);
      yield* reconstructed.resetSession({ ...context, expectedRevision: disabled.catalogRevision });
      const afterReset = yield* build;
      assert.isTrue(
        (yield* afterReset.list(context)).entries.find((entry) => entry.key === key)!.effective,
      );
    }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );

  it.effect(
    "session resolution acquires project watches without opening the catalog and updates existing overrides",
    () =>
      Effect.gen(function* () {
        const index = yield* Index.SkillCatalogIndex;
        const config = yield* ServerConfig.ServerConfig;
        const roots: string[] = [];
        const watches = SkillWatchService.of({
          acquireProject: (root) =>
            Effect.sync(() => {
              roots.push(root);
              return {
                scope: "project" as const,
                scopeId: "project-scope",
                catalogRevision: 0,
                availability: "available" as const,
                entries: [],
              };
            }),
          releaseProject: index.releaseProject,
          invalidateGlobal: Effect.void,
          invalidateProject: () => Effect.void,
        });
        const catalog = yield* make.pipe(Effect.provideService(SkillWatchService, watches));
        const projectRoot = config.stateDir;
        const projectId = ProjectId.make("project");
        const key = ManagedSkillKey.make("deploy");
        yield* catalog.describeSession({
          threadId: "thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          projectId,
          projectRoot,
          cwd: projectRoot,
          desiredRevision: SkillCatalogRevision.make(1),
          appliedRevision: SkillCatalogRevision.make(0),
        });
        assert.deepEqual(roots, [projectRoot]);
        const first = yield* catalog.setProjectOverride({
          projectId,
          projectRoot,
          key,
          expectedRevision: 0,
          content: { name: "Deploy", body: "first" },
        });
        const second = yield* catalog.setProjectOverride({
          projectId,
          projectRoot,
          key,
          expectedRevision: first.catalogRevision,
          content: { name: "Deploy", body: "second" },
        });
        yield* catalog.setProjectDisabled({
          projectId,
          projectRoot,
          key,
          expectedRevision: second.catalogRevision,
        });
        const entries = yield* (yield* Repository.ManagedSkillRepository).listProject(projectRoot);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.projectState, "disabled");
        assert.deepEqual(roots, [projectRoot]);
      }).pipe(Effect.provide(Layer.merge(registry, dependencies)), Effect.scoped),
  );
});
