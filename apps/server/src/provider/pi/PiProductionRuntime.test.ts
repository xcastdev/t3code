import {
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
  SkillContentHash,
  ProjectWorkFoundationCommitCommand,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { hashSkillPackage, writeSkillPackageContents } from "../../skills/SkillPackage.ts";
import { preparePiSkillResources } from "./PiSkillResources.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, vi, afterEach } from "vite-plus/test";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { layer as authorizationLayer } from "../../projectWork/ProjectTeamAuthorization.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "../../projectWork/ProjectWorkQuery.ts";
import { ProjectWorkSearchLive } from "../../projectWork/ProjectWorkSearch.ts";
import { ProjectWorkNarrativeLive } from "../../projectWork/ProjectWorkNarrative.ts";
import { ProjectWorkBriefingLive } from "../../projectWork/ProjectWorkBriefing.ts";
import { ProjectWorkGatewayLive } from "../../projectWork/ProjectWorkGateway.ts";
import { ProjectWorkProjectionLive } from "../../projectWork/ProjectWorkProjection.ts";
import {
  providerInstanceId,
  projectId,
  threadId,
  seed,
  restoreHistoricalBinding,
  at,
} from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProjectWorkPolicyError } from "../../projectWork/ProjectWorkPolicy.ts";
import { makeProjectTeamDispatchJournal } from "../../projectWork/ProjectTeamDispatchJournal.ts";
import { PiModelCatalogue, makePiModelCatalogue } from "./PiModelCatalogue.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import * as Runtime from "./PiManagedRuntimeLive.ts";
import * as RuntimeAssets from "./PiRuntimeAssets.ts";
import {
  makePiProductionRuntime,
  type PiProductionRuntimeOptions,
  type PiProductionRuntimeAssets,
  type PiProductionRuntimeHooks,
} from "./PiProductionRuntime.ts";

import type { PiManagedRuntimeInstance } from "./PiManagedRuntime.ts";
import { makeProjectTeamPiRuntime } from "../../projectWork/ProjectTeamPiRuntime.ts";

const NodeFS = process.getBuiltinModule("fs");
const nativeFS = NodeFS.promises;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSkillKey = Schema.decodeUnknownEffect(ManagedSkillKey);
const decodeSkillId = Schema.decodeUnknownEffect(ManagedSkillId);
const decodeSkillHash = Schema.decodeUnknownEffect(SkillContentHash);
const encodeSkillManifest = Schema.encodeEffect(Schema.fromJsonString(ManagedSkillManifest));
const distribution = process.env.PI_PRODUCTION_RUNTIME_DISTRIBUTION;
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped();
      const services = Layer.mergeAll(
        authorizationLayer,
        ProjectWorkRepositoryLive,
        ProjectWorkQueryLive,
        ProjectWorkProjectionLive,
        ProjectWorkSearchLive,
        ProjectWorkNarrativeLive,
        ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
      );
      const live = ProjectWorkGatewayLive.pipe(
        Layer.provideMerge(services),
        Layer.provide(Layer.mock(EnvironmentAuth)({})),
        Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true })),
        Layer.provideMerge(makeSqlitePersistenceLive(scratch + "/factory.sqlite")),
      );
      return yield* effect.pipe(Effect.provide(live));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const agentDirectory = root + "/agent";
  const protectedRoot = root + "/protected";
  yield* fs.makeDirectory(agentDirectory);
  yield* fs.makeDirectory(protectedRoot);
  let reads = 0;
  let refreshes = 0;
  let revalidationCalls = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("fixture"));
  const catalogue = PiModelCatalogue.of({
    readFresh: Effect.sync(() => {
      reads++;
      return undefined;
    }),
    refresh: Effect.sync(() => {
      refreshes++;
      throw Error("Explicit catalogue refresh required");
    }),
  });
  const options: PiProductionRuntimeOptions = {
    environmentId: "factory-fixture",
    agentDirectory,
    distributionDirectory: distribution ?? root + "/missing-dist",
    nativeStateRoot: root + "/native",
    stagingRoot: root + "/cache",
    protectedRoots: [protectedRoot],
    memoryBytes: 33554432,
    cleanupDeadlineMs: 1000,
    maxInputTokens: 10000,
    maxOutputTokens: 512,
  };
  const captured: Array<Parameters<typeof Runtime.makePiManagedRuntimeLive>[0]> = [];
  const handles: Array<Awaited<ReturnType<typeof nativeFS.open>>> = [];
  // Test teardown owns these descriptors, including intentionally renamed retained stages.
  // It restores permissions only after assertions and all factory finalizers have run.
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const handle of handles) {
        try {
          await handle.chmod(0o700);
        } finally {
          await handle.close();
        }
      }
    }),
  );
  const original = Runtime.makePiManagedRuntimeLive;
  vi.spyOn(Runtime, "makePiManagedRuntimeLive").mockImplementation((value) => {
    captured.push(value);
    const actualRevalidation = value.revalidateRuntime;
    const recorded = actualRevalidation
      ? {
          ...value,
          revalidateRuntime: Effect.sync(() => {
            revalidationCalls++;
          }).pipe(Effect.andThen(actualRevalidation)),
        }
      : value;
    return original(recorded).pipe(
      Effect.tap(() =>
        Effect.promise(async () => {
          const source = value.runtimeFiles[0]?.source;
          if (source)
            handles.push(
              await nativeFS.open(
                source.slice(0, source.lastIndexOf("/")),
                NodeFS.constants.O_RDONLY |
                  NodeFS.constants.O_DIRECTORY |
                  NodeFS.constants.O_NOFOLLOW,
              ),
            );
        }),
      ),
    );
  });
  return {
    fs,
    root,
    options,
    catalogue,
    fetch,
    captured,
    get revalidationCalls() {
      return revalidationCalls;
    },
    get reads() {
      return reads;
    },
    get refreshes() {
      return refreshes;
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});
const construct = (f: Effect.Success<typeof fixture>, hooks?: PiProductionRuntimeHooks) =>
  makePiProductionRuntime(f.options, hooks).pipe(
    Effect.provideService(PiModelCatalogue, f.catalogue),
    Effect.provideService(FetchHttpClient.Fetch, f.fetch),
  );
const instance = { instanceId: providerInstanceId, enabled: true, configuration: {} };
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure");
      return result;
    }),
  );

describe("private Pi production factory", () => {
  it.effect(
    "construction has no staging, native state, catalogue refresh or worker acquisition",
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* construct(f);
          expect(yield* f.fs.exists(f.options.stagingRoot)).toBe(false);
          expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(false);
          expect(f.reads).toBe(0);
          expect(f.refreshes).toBe(0);
          expect(f.fetch).not.toHaveBeenCalled();
          expect(f.captured).toHaveLength(0);
        }),
      ),
  );
  it.effect(
    "disabled instances use the actual runtime with an empty closure and deny preparation before any file or catalogue access",
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const service = yield* construct(f);
          const managed = yield* service
            .forInstance({
              ...instance,
              enabled: false,
              configuration: { agentDirectory: f.root + "/missing-agent" },
            })
            .pipe(Effect.provideService(HostProcessPlatform, "win32"));
          const result = yield* failure(
            managed.prepareOperation({ kind: "initialize", threadId }, () => Effect.void),
          );
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: "denied" });
          expect(f.captured[0]?.runtimeFiles).toEqual([]);
          expect(f.reads).toBe(0);
          expect(f.refreshes).toBe(0);
          expect(f.fetch).not.toHaveBeenCalled();
          expect(yield* f.fs.exists(f.options.stagingRoot)).toBe(false);
          expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(false);
        }),
      ),
  );
  it.effect(
    "the transport uses captured parent fetch once, preserves the owned signal and refuses ambient credentials",
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const service = yield* construct(f);
          yield* service.forInstance({ ...instance, enabled: false });
          const signal = yield* Effect.abortSignal;
          const response = yield* Effect.promise(() =>
            f.captured[0]!.transport("https://fixture.invalid/transport", {
              method: "POST",
              redirect: "error",
              headers: { authorization: "Bearer fixture-token" },
              body: "fixture",
              signal,
            }),
          );
          expect(yield* Effect.promise(() => response.text())).toBe("fixture");
          expect(f.fetch).toHaveBeenCalledExactlyOnceWith("https://fixture.invalid/transport", {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            headers: { authorization: "Bearer fixture-token" },
            body: "fixture",
            signal,
          });
          expect(f.reads).toBe(0);
          expect(f.refreshes).toBe(0);
        }),
      ),
  );
  it.effect("unsafe native or cache overlap is rejected before state creation", () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const service = yield* makePiProductionRuntime({
          ...f.options,
          nativeStateRoot: f.options.protectedRoots[0]!,
        }).pipe(Effect.provideService(PiModelCatalogue, f.catalogue));
        yield* failure(service.forInstance(instance));
        expect(yield* f.fs.exists(f.options.stagingRoot)).toBe(false);
        expect(f.captured).toHaveLength(0);
      }),
    ),
  );
  it.effect("a symlinked cache cannot create a stage in another directory", () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const other = f.root + "/other";
        yield* f.fs.makeDirectory(other);
        yield* f.fs.symlink(other, f.options.stagingRoot);
        const service = yield* construct(f);
        yield* failure(service.forInstance(instance));
        expect(yield* f.fs.readDirectory(other)).toEqual([]);
        expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(false);
        expect(f.captured).toHaveLength(0);
      }),
    ),
  );
});

for (const alias of [
  "protected-native",
  "protected-cache",
  "agent",
  "selected-agent",
  "distribution",
])
  it.effect(`declared ${alias} alias is rejected before any state mutation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const target = f.root + "/alias-target";
        const link = f.root + "/alias";
        yield* f.fs.makeDirectory(target);
        yield* f.fs.symlink(target, link);
        const options = {
          ...f.options,
          ...(alias.startsWith("protected") ? { protectedRoots: [link] } : {}),
          ...(alias === "agent" ? { agentDirectory: link } : {}),
          ...(alias === "distribution" ? { distributionDirectory: link } : {}),
          ...(alias === "protected-native" || alias === "agent"
            ? { nativeStateRoot: target + "/native" }
            : {}),
          ...(alias === "protected-cache" || alias === "selected-agent"
            ? { stagingRoot: target + "/cache" }
            : {}),
        };
        const service = yield* makePiProductionRuntime(options).pipe(
          Effect.provideService(PiModelCatalogue, f.catalogue),
          Effect.provideService(FetchHttpClient.Fetch, f.fetch),
        );
        const result = yield* Effect.result(
          service.forInstance({
            ...instance,
            configuration: alias === "selected-agent" ? { agentDirectory: link } : {},
          }),
        );
        expect(yield* f.fs.exists(options.nativeStateRoot)).toBe(false);
        expect(yield* f.fs.exists(options.stagingRoot)).toBe(false);
        expect(yield* f.fs.readDirectory(target)).toEqual([]);
        expect(result._tag).toBe("Failure");
        expect(f.captured).toHaveLength(0);
        expect(f.fetch).not.toHaveBeenCalled();
      }),
    ),
  );

// This opt-in group consumes real built npm assets and the actual factory/Runtime/SQL.
// It stages and inspects only; it does not activate the SDK or contact a model provider.
const product = distribution ? it.effect : it.effect.skip;
const decodeSdkVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const enabledFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const service = yield* construct(f);
  return Object.assign(f, { service });
});
const stageFrom = (f: Effect.Success<typeof fixture>) => {
  const files = f.captured[0]?.runtimeFiles;
  expect(files?.length).toBeGreaterThan(1);
  const source = files![0]!.source;
  return source.slice(0, source.lastIndexOf("/"));
};
product("publishes immutable limits from captured options and the owned SDK metadata", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      Reflect.set(f.options, "maxInputTokens", 16384);
      const published: PiProductionRuntimeAssets[] = [];
      const service = yield* construct(f, {
        publishAssets: (_id, assets) =>
          Effect.sync(() => published.push(assets)).pipe(Effect.asVoid),
      });
      Reflect.set(f.options, "maxInputTokens", 90000);
      Reflect.set(f.options, "maxOutputTokens", 4096);
      yield* service.forInstance(instance);
      const assets = published[0]!;
      const metadata = assets.runtimeFiles.find(
        (file) => file.target === "/runtime/dist/pi-sdk/package.json",
      );
      expect(metadata).toBeDefined();
      const sdk = yield* decodeSdkVersion(yield* f.fs.readFileString(metadata!.source));
      expect(assets.runtimeFacts).toEqual({
        runtimeVersion: sdk.version,
        maxInputTokens: 16384,
        maxOutputTokens: 512,
      });
      expect(f.captured[0]!.maxInputTokens).toBe(16384);
      expect(f.captured[0]!.maxOutputTokens).toBe(512);
      expect(assets.instanceConfiguration).toEqual({ enabled: true, configuration: {} });
      expect(Object.isFrozen(assets.runtimeFacts)).toBe(true);
      expect(Reflect.set(assets.runtimeFacts!, "maxInputTokens", 1)).toBe(false);
      yield* assets.borrow(assets.revalidate);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("publishes the original instance configuration during a held owned asset publication", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const mutable = { ...instance, configuration: { agentDirectory: f.options.agentDirectory } };
      let published: PiProductionRuntimeAssets | undefined;
      const service = yield* construct(f, {
        publishAssets: (_id, assets) =>
          Effect.gen(function* () {
            published = assets;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
      });
      const starting = yield* service.forInstance(mutable).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      mutable.configuration.agentDirectory = f.root + "/foreign";
      mutable.enabled = false;
      expect(published!.instanceConfiguration).toEqual({
        enabled: true,
        configuration: { agentDirectory: f.options.agentDirectory },
      });
      expect(Object.isFrozen(published!.instanceConfiguration)).toBe(true);
      expect(Object.isFrozen(published!.instanceConfiguration!.configuration)).toBe(true);
      yield* published!.borrow(published!.revalidate);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(starting);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("published runtime and assets belong to the exact returned instance scope", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const published: Array<{
        readonly runtime: PiManagedRuntimeInstance;
        readonly assets: PiProductionRuntimeAssets;
      }> = [];
      const service = yield* construct(f, {
        publishAssets: (id, assets, runtime) =>
          Effect.sync(() => {
            expect(id).toBe(providerInstanceId);
            published.push({ runtime, assets });
          }),
      });
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
      const first = yield* service
        .forInstance(instance)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const second = yield* service
        .forInstance(instance)
        .pipe(Effect.provideService(Scope.Scope, secondScope));
      expect(published).toHaveLength(2);
      expect(published[0]!.runtime).toBe(first);
      expect(published[1]!.runtime).toBe(second);
      expect(first).not.toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(second)).toBe(true);
      expect(published[0]!.assets.runtimeFiles[0]!.source).not.toBe(
        published[1]!.assets.runtimeFiles[0]!.source,
      );
      yield* published[0]!.assets.borrow(Effect.void);
      yield* published[1]!.assets.borrow(Effect.void);
      yield* Scope.close(firstScope, Exit.void);
      yield* failure(published[0]!.assets.revalidate);
      yield* failure(first.prepareOperation({ kind: "initialize", threadId }, () => Effect.void));
      expect(yield* f.fs.exists(published[0]!.assets.runtimeFiles[0]!.source)).toBe(false);
      yield* published[1]!.assets.revalidate;
      expect(yield* f.fs.exists(published[1]!.assets.runtimeFiles[0]!.source)).toBe(true);
      yield* Scope.close(secondScope, Exit.void);
      expect(yield* f.fs.exists(published[1]!.assets.runtimeFiles[0]!.source)).toBe(false);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product(
  "Root borrows only the current driver instance and old scope closure preserves its replacement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const registry = yield* makeProjectTeamPiRuntime();
        let calls = 0;
        yield* failure(registry.withInstance(providerInstanceId, () => Effect.sync(() => calls++)));
        const service = yield* construct(f, registry);
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        const first = yield* service
          .forInstance(instance)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let oldStage = "";
        const borrowed = yield* registry
          .withInstance(providerInstanceId, (owned) =>
            Effect.gen(function* () {
              calls++;
              expect(owned.runtime).toBe(first);
              oldStage = owned.assets.runtimeFiles[0]!.source;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              expect(yield* f.fs.exists(oldStage)).toBe(true);
              yield* failure(owned.assertCurrent);
            }),
          )
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(entered);
        const second = yield* service
          .forInstance(instance)
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        yield* Scope.close(firstScope, Exit.void);
        // An active loan keeps old assets even though no new use can select its runtime.
        expect(yield* f.fs.exists(oldStage)).toBe(true);
        yield* registry.withInstance(providerInstanceId, (owned) =>
          Effect.gen(function* () {
            calls++;
            expect(owned.runtime).toBe(second);
            expect(owned.assets.runtimeFiles[0]!.source).not.toBe(oldStage);
            yield* owned.assertCurrent;
          }),
        );
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.join(borrowed))).toBe(true);
        yield* registry.withInstance(providerInstanceId, (owned) =>
          Effect.gen(function* () {
            expect(owned.runtime).toBe(second);
            yield* owned.assertCurrent;
          }),
        );
        yield* Scope.close(secondScope, Exit.void);
        yield* failure(registry.withInstance(providerInstanceId, () => Effect.sync(() => calls++)));
        expect(calls).toBe(2);
        expect(f.fetch).not.toHaveBeenCalled();
      }),
    ),
);
product("an outstanding setup loan retains actual assets after instance scope closes", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const published: PiProductionRuntimeAssets[] = [];
      const service = yield* construct(f, {
        publishAssets: (_, assets) =>
          Effect.sync(() => {
            published.push(assets);
          }),
      });
      const instanceScope = yield* Scope.make();
      yield* service.forInstance(instance).pipe(Effect.provideService(Scope.Scope, instanceScope));
      expect(published).toHaveLength(1);
      const assets = published[0]!;
      const stage = stageFrom(f);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const loan = yield* assets
        .borrow(
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            expect(yield* f.fs.exists(assets.runtimeFiles[0]!.source)).toBe(true);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Scope.close(instanceScope, Exit.void);
      expect(yield* f.fs.exists(stage)).toBe(true);
      yield* failure(assets.revalidate);
      yield* failure(assets.borrow(Effect.sync(() => calls++)));
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(loan);
      // Closed scopes retain uncertain stages; a late loan completion cannot delete them.
      expect(yield* f.fs.exists(stage)).toBe(true);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("a joined setup loan releases its stage and exposes immutable assets", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const published: PiProductionRuntimeAssets[] = [];
      const service = yield* construct(f, {
        publishAssets: (id, assets) => {
          expect(id).toBe(providerInstanceId);
          return Effect.sync(() => {
            published.push(assets);
          });
        },
      });
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.forInstance(instance);
          expect(published).toHaveLength(1);
          const assets = published[0]!;
          stage = stageFrom(f);
          expect(Object.isFrozen(assets)).toBe(true);
          expect(Object.isFrozen(assets.runtimeFiles)).toBe(true);
          expect(assets.runtimeFiles.every(Object.isFrozen)).toBe(true);
          yield* assets.borrow(Effect.void);
          expect(yield* f.fs.exists(stage)).toBe(true);
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(false);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("malformed retained setup history retains actual assets after the last loan joins", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const assignment = yield* seed("investigator", "reserved", { issueCredential: false });
      const sql = yield* SqlClient.SqlClient;
      const published: PiProductionRuntimeAssets[] = [];
      const service = yield* construct(f, {
        publishAssets: (_, assets) =>
          Effect.sync(() => {
            published.push(assets);
          }),
      });
      const instanceScope = yield* Scope.make();
      yield* service.forInstance(instance).pipe(Effect.provideService(Scope.Scope, instanceScope));
      const assets = published[0]!;
      const staged = stageFrom(f);
      yield* assets.borrow(Effect.void);
      const deadline = Date.parse(at) + 1000;
      // Corrupt imported history is legal storage, not an admitted setup or a drain proof.
      yield* sql`INSERT INTO project_team_model_budget VALUES
        (${f.options.environmentId},${assignment.binding.projectId},${assignment.binding.taskId},1000,${deadline})`;
      yield* sql`INSERT INTO project_team_dispatch ${sql.insert({
        dispatch_id: "retained-setup",
        environment_id: f.options.environmentId,
        project_id: assignment.binding.projectId,
        binding_id: assignment.binding.recordId,
        generation: assignment.binding.generation,
        task_id: assignment.binding.taskId,
        attempt_id: assignment.binding.attemptId,
        worktree: assignment.binding.worktree,
        branch: assignment.binding.branch,
        root_task_id: assignment.binding.taskId,
        root_maximum_tokens: 1000,
        root_deadline_at_ms: deadline,
        attempt_maximum_tokens: 1000,
        attempt_deadline_at_ms: deadline,
        delegation_depth: 0,
        maximum_delegation_depth: 2,
        repair_allowance: 2,
        stage: "reserved",
        revision: 0,
        claim_generation: 0,
        intent_json: "{}",
        created_at: at,
        updated_at: at,
      })}`;
      yield* sql`INSERT INTO project_team_setup_process
        (setup_id,dispatch_id,selection_json,status,activation,input_json)
        VALUES ('retained-setup','retained-setup',${encode({
          kind: "script",
          launch: { runtimeFiles: [assets.runtimeFiles[0]!] },
        })},'selected','unlaunched',NULL)`;
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      expect(yield* sql`SELECT unit FROM project_team_pi_process`).toEqual([]);
      yield* Scope.close(instanceScope, Exit.void);
      expect(yield* f.fs.exists(staged)).toBe(true);
      expect(yield* f.fs.exists(assets.runtimeFiles[0]!.source)).toBe(true);
      yield* failure(assets.revalidate);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("scope closure during loan revalidation prevents setup from starting", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = RuntimeAssets.preparePiRuntimeAssets;
      vi.spyOn(RuntimeAssets, "preparePiRuntimeAssets").mockImplementation((input) =>
        original(input).pipe(
          Effect.map((assets) => ({
            ...assets,
            revalidate: assets.revalidate.pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(undefined),
            ),
          })),
        ),
      );
      const published: PiProductionRuntimeAssets[] = [];
      const service = yield* construct(f, {
        publishAssets: (_, assets) =>
          Effect.sync(() => {
            published.push(assets);
          }),
      });
      const instanceScope = yield* Scope.make();
      yield* service.forInstance(instance).pipe(Effect.provideService(Scope.Scope, instanceScope));
      expect(published).toHaveLength(1);
      const assets = published[0]!;
      const stage = stageFrom(f);
      let starts = 0;
      const loan = yield* assets
        .borrow(
          Effect.sync(() => {
            starts++;
          }),
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Scope.close(instanceScope, Exit.void);
      expect(yield* f.fs.exists(stage)).toBe(true);
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isFailure(yield* Fiber.join(loan))).toBe(true);
      expect(starts).toBe(0);
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
const processRow = Effect.fn("factoryTest.processRow")(function* (
  files: Parameters<typeof Runtime.makePiManagedRuntimeLive>[0]["runtimeFiles"],
  status: string,
  extra: { owner?: string; drain?: string; badIdentity?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const identities = yield* Effect.forEach(files, (file) =>
    Effect.promise(async () => {
      const stat = await nativeFS.lstat(file.source);
      return { ...file, dev: stat.dev, ino: extra.badIdentity ? stat.ino + 1 : stat.ino };
    }),
  );
  yield* sql`INSERT INTO project_team_pi_operation(operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    VALUES('factory-operation','factory-fixture','project','binding',0,'provider','thread','worker',0,'initialize','hash','binding','task',100,10000,'prepared','{}')`;
  yield* sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status,owner_json,drain_json)
    VALUES('factory-unit','factory-operation',${encode({ unit: "factory-unit", nonce: "factory-nonce", policy: { memoryBytes: 33554432 }, launch: { runtimeFiles: identities } })},${status},${extra.owner ?? null},${extra.drain ?? null})`;
});
product(
  "actual product staging uses literal cage state, preserves native state and never reads or refreshes the catalogue on acquisition",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            const options = f.captured[0]!;
            const argv = options.workerArgv(
              { workerId: "worker", generation: 1 },
              { operationId: "operation", operationKind: "initialize" },
              "/host/native/sessions",
            );
            expect(argv.at(-1)).toContain('"sessionDirectory":"/state/sessions"');
            expect(argv.at(-1)).not.toContain("/host/native/sessions");
            expect(f.reads).toBe(0);
            expect(f.refreshes).toBe(0);
            expect(f.fetch).not.toHaveBeenCalled();
            expect(yield* f.fs.exists(stage)).toBe(true);
            expect(yield* f.fs.exists(f.options.stagingRoot + "/pi-selected-skills")).toBe(false);
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(false);
        expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(true);
      }),
    ),
);
product("allocates separate private skill stages only when the runtime requests them", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      yield* f.service.forInstance(instance);
      const allocate = f.captured[0]!.allocateSkillStage!;
      const first = yield* allocate;
      const second = yield* allocate;
      expect(first.stagingRoot).toBe(f.options.stagingRoot + "/pi-selected-skills");
      expect(second.stagingRoot).toBe(first.stagingRoot);
      expect(second.stagingDirectory).not.toBe(first.stagingDirectory);
      for (const root of [first.stagingRoot, first.stagingDirectory, second.stagingDirectory]) {
        const stat = yield* Effect.promise(() => nativeFS.lstat(root));
        expect(stat.mode & 0o7777).toBe(0o700);
        expect(stat.uid).toBe(process.getuid!());
      }
      expect(f.fetch).not.toHaveBeenCalled();
      yield* first.remove();
      yield* second.remove();
      expect(yield* f.fs.exists(first.stagingDirectory)).toBe(false);
      expect(yield* f.fs.exists(second.stagingDirectory)).toBe(false);
    }),
  ),
);
for (const fault of ["alias", "public-mode"] as const)
  product(`rejects ${fault} skill cache without changing the target`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        yield* f.service.forInstance(instance);
        const root = f.options.stagingRoot + "/pi-selected-skills";
        if (fault === "alias") yield* f.fs.symlink(f.options.protectedRoots[0]!, root);
        else yield* f.fs.makeDirectory(root, { mode: 0o755 });
        const target = fault === "alias" ? f.options.protectedRoots[0]! : root;
        const before = yield* Effect.promise(() => nativeFS.lstat(target));
        yield* failure(f.captured[0]!.allocateSkillStage!);
        const after = yield* Effect.promise(() => nativeFS.lstat(target));
        expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
        expect(yield* f.fs.readDirectory(target)).toEqual([]);
        expect(f.fetch).not.toHaveBeenCalled();
      }),
    ),
  );
for (const status of ["drained", "quarantine"] as const)
  product(`keeps skill mounts separate from ${status} runtime asset cleanup`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        const source = f.root + "/separate-skill";
        yield* f.fs.writeFileString(source, "Selected skill resource");
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            yield* processRow(
              [
                ...f.captured[0]!.runtimeFiles,
                { source, target: "/runtime/skills/review/SKILL.md" },
              ],
              status,
            );
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(status !== "drained");
        expect(yield* f.fs.readFileString(source)).toBe("Selected skill resource");
      }),
    ),
  );
for (const status of ["allocated", "claimed", "captured", "quarantine"])
  product(`retains actual staged assets when durable ownership is ${status}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            yield* processRow(f.captured[0]!.runtimeFiles, status);
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(true);
      }),
    ),
  );
product("drained unactivated allocations release their exact stage", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          yield* processRow(f.captured[0]!.runtimeFiles, "drained");
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(false);
    }),
  ),
);
const productElectron =
  distribution && process.env.PI_FACTORY_ELECTRON_PROOF === "1" ? it.effect : it.effect.skip;
productElectron("drained runtime closures exceeding 128 files release their exact stage", () =>
  scoped(
    Effect.gen(function* () {
      expect(process.versions.electron).toBe("44.1.0");
      const f = yield* fixture;
      const source = distribution!;
      const expanded = f.root + "/expanded-distribution";
      yield* Effect.promise(() => nativeFS.cp(source, expanded, { recursive: true }));
      const modules = (yield* f.fs.readDirectory(expanded)).filter((name) => name.endsWith(".mjs"));
      for (let index = modules.length; index < 96; index++)
        yield* f.fs.writeFileString(expanded + `/fixture-runtime-${index}.mjs`, "export {};\n");
      const service = yield* construct({
        ...f,
        options: { ...f.options, distributionDirectory: expanded },
      });
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.forInstance(instance);
          expect(f.captured[0]!.runtimeFiles.length).toBeGreaterThan(128);
          stage = stageFrom(f);
          const files = f.captured[0]!.runtimeFiles;
          const totalBytes = (yield* Effect.forEach(files, (file) =>
            Effect.promise(async () => (await nativeFS.stat(file.source)).size),
          )).reduce((sum, size) => sum + size, 0);
          expect(totalBytes).toBeGreaterThan(256 * 1024 * 1024);
          const source = f.options.protectedRoots[0]! + "/selected";
          const selectedCache = f.root + "/selected-cache";
          const selectedStage = selectedCache + "/stage";
          yield* f.fs.makeDirectory(selectedStage, { recursive: true });
          yield* Effect.promise(async () => {
            await nativeFS.chmod(selectedCache, 0o700);
            await nativeFS.chmod(selectedStage, 0o700);
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              for (const directory of [selectedStage, selectedStage + "/selected"]) {
                try {
                  await nativeFS.chmod(directory, 0o700);
                } catch (cause) {
                  if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT")
                    throw cause;
                }
              }
            }),
          );
          const key = yield* decodeSkillKey("selected");
          const manifest = {
            schemaVersion: 1 as const,
            kind: "managed-skill" as const,
            id: yield* decodeSkillId("electron-selected"),
            key,
            scope: "global" as const,
            revision: {
              revision: 1,
              hash: yield* decodeSkillHash("a".repeat(64)),
            },
            origin: "created" as const,
            ownership: "t3" as const,
          };
          yield* writeSkillPackageContents({
            packagePath: source,
            manifest,
            content: { key, name: "Electron selected fixture", body: "Bounded selected skill." },
          });
          const expectedHash = yield* hashSkillPackage(source);
          yield* f.fs.writeFileString(
            source + "/t3-skill.json",
            yield* encodeSkillManifest({
              ...manifest,
              revision: { revision: 1, hash: expectedHash },
            }),
          );
          const selected = yield* preparePiSkillResources({
            selection: [{ key, packagePath: source, expectedHash }],
            stagingRoot: selectedCache,
            stagingDirectory: selectedStage,
            existingRuntimeFiles: files,
            protectedRoots: f.options.protectedRoots,
            writableRoots: [],
          });
          expect(selected.runtimeFiles.length).toBe(2);
          yield* selected.revalidate;
          yield* processRow(files, "drained");
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(false);
    }),
  ),
);
product("normalized source aliases cannot hide allocated staged file identities", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const sql = yield* SqlClient.SqlClient;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          const alias = f.root + "/source-alias";
          yield* f.fs.symlink(stage, alias);
          yield* processRow(f.captured[0]!.runtimeFiles, "allocated");
          const files = yield* Effect.forEach(f.captured[0]!.runtimeFiles, (file) =>
            Effect.promise(async () => {
              const identity = await nativeFS.lstat(file.source);
              const source = alias + "/" + file.source.slice(stage.length + 1);
              expect(process.getBuiltinModule("path").resolve(source)).toBe(source);
              expect(await nativeFS.realpath(source)).toBe(file.source);
              return { ...file, source, dev: identity.dev, ino: identity.ino };
            }),
          );
          yield* sql`UPDATE project_team_pi_process SET allocation_json = ${encode({
            unit: "factory-unit",
            nonce: "factory-nonce",
            policy: { memoryBytes: 33554432 },
            launch: { runtimeFiles: files },
          })} WHERE unit='factory-unit'`;
        }),
      );
      expect(yield* sql`SELECT status FROM project_team_pi_process`).toEqual([
        { status: "allocated" },
      ]);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(yield* f.fs.exists(stage)).toBe(true);
    }),
  ),
);
product("a drained allocation with a different source inode cannot authorize deletion", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          yield* processRow(f.captured[0]!.runtimeFiles, "drained", { badIdentity: true });
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(true);
    }),
  ),
);
product("SQL failure retains staged assets", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE project_team_pi_process`;
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(true);
    }),
  ),
);
product("replaced cache names and foreign files survive scope closure", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          yield* Effect.promise(() => nativeFS.rename(stage, stage + "-owned"));
          yield* f.fs.makeDirectory(stage);
          yield* f.fs.writeFileString(stage + "/foreign", "keep");
        }),
      );
      expect(yield* f.fs.readFileString(stage + "/foreign")).toBe("keep");
      expect(yield* f.fs.exists(stage + "-owned")).toBe(true);
    }),
  ),
);

product(
  "inspection uses readFresh without refreshing and a missing catalogue never falls back",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const managed = yield* f.service.forInstance(instance);
            yield* failure(managed.inspect);
            expect(f.reads).toBe(1);
            expect(f.refreshes).toBe(0);
            expect(f.fetch).not.toHaveBeenCalled();
          }),
        );
      }),
    ),
);
const ownerReceipt = {
  unit: "factory-unit",
  nonce: "factory-nonce",
  invocation: "invocation",
  cgroup: "/fixture/cgroup",
  pid: 100,
  memoryBytes: 33554432,
  swapBytes: 0,
  oomGroup: 1,
};
const drainReceipt = {
  unit: "factory-unit",
  invocation: "invocation",
  cgroup: "/fixture/cgroup",
  ownerPid: 100,
  launcherPid: 101,
  childPid: 102,
  childExitCode: 0,
  memoryBytes: 33554432,
  swapBytes: 0,
  oomGroup: 1,
  kernel: "populated 0\nfrozen 0",
};
for (const fault of ["none", "missing", "different-owner", "populated"])
  product(`captured ownership release requires a verified durable drain (${fault})`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            yield* processRow(f.captured[0]!.runtimeFiles, "drained", {
              owner: encode(ownerReceipt),
              ...(fault === "missing"
                ? {}
                : {
                    drain: encode({
                      ...drainReceipt,
                      ...(fault === "different-owner" ? { ownerPid: 999 } : {}),
                      ...(fault === "populated" ? { kernel: "populated 1\nfrozen 0" } : {}),
                    }),
                  }),
            });
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(fault !== "none");
      }),
    ),
  );
product("a malformed allocation retains assets even without a trustworthy source path", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          yield* processRow(f.captured[0]!.runtimeFiles, "drained");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE project_team_pi_process SET allocation_json = '{}'`;
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(true);
    }),
  ),
);
for (const fault of [
  "missing-array",
  "empty-allocated",
  "empty-drained",
  "missing-source",
  "invalid-source",
  "invalid-identity",
  "noncanonical-source",
  "empty-unit",
  "empty-nonce",
  "different-unit",
  "duplicate-source",
  "duplicate-target",
])
  product(`uncertain ${fault} closure retains the actual stage before source filtering`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            yield* processRow(
              f.captured[0]!.runtimeFiles,
              fault === "empty-drained" ? "drained" : "allocated",
            );
            const sql = yield* SqlClient.SqlClient;
            if (fault === "missing-source") {
              // A malformed closure after a complete page must still veto deletion.
              yield* sql`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<17)
                INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status)
                SELECT 'unrelated-' || n, operation_id,
                  json_set(allocation_json, '$.unit', 'unrelated-' || n,
                    '$.launch.runtimeFiles', json('[{"source":"/unrelated/0000","target":"/unrelated/target","dev":1,"ino":1}]')),
                  'allocated' FROM project_team_pi_process, ids WHERE unit='factory-unit'`;
              yield* sql`UPDATE project_team_pi_process SET rowid=100 WHERE unit='factory-unit'`;
            }
            let files =
              fault === "empty-allocated" || fault === "empty-drained" || fault === "missing-array"
                ? []
                : [
                    {
                      ...(fault === "missing-source"
                        ? {}
                        : { source: fault === "invalid-source" ? "relative" : "/unrelated/0000" }),
                      target: "/unrelated/target",
                      dev: 1,
                      ino: fault === "invalid-identity" ? 0 : 1,
                    },
                  ];
            if (fault === "noncanonical-source") {
              const file = f.captured[0]!.runtimeFiles[0]!;
              const identity = yield* Effect.promise(() => nativeFS.lstat(file.source));
              yield* f.fs.makeDirectory(f.root + "/unrelated");
              const source = f.root + "/unrelated/../" + file.source.slice(f.root.length + 1);
              expect(yield* Effect.promise(() => nativeFS.realpath(source))).toBe(file.source);
              files = [{ ...file, source, dev: identity.dev, ino: identity.ino }];
            }
            if (fault === "duplicate-source")
              files.push({ ...files[0]!, target: "/unrelated/other-target" });
            if (fault === "duplicate-target")
              files.push({ ...files[0]!, source: "/unrelated/other-source" });
            yield* sql`UPDATE project_team_pi_process SET allocation_json = ${encode({
              unit:
                fault === "empty-unit" ? "" : fault === "different-unit" ? "other" : "factory-unit",
              nonce: fault === "empty-nonce" ? "" : "factory-nonce",
              policy: { memoryBytes: 33554432 },
              launch: fault === "missing-array" ? {} : { runtimeFiles: files },
            })} WHERE unit='factory-unit'`;
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(true);
        expect(f.fetch).not.toHaveBeenCalled();
      }),
    ),
  );
product("a valid unrelated allocated closure does not prevent exact stage cleanup", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const source = f.root + "/unrelated";
      yield* f.fs.writeFileString(source, "unrelated ownership");
      let stage = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.service.forInstance(instance);
          stage = stageFrom(f);
          yield* processRow([{ source, target: "/unrelated/target" }], "allocated");
          const sql = yield* SqlClient.SqlClient;
          // Valid unrelated history must not consume the 1,024 matched-stage row budget.
          yield* sql`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<1025)
            INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status)
            SELECT 'unrelated-' || n, operation_id,
              json_set(allocation_json, '$.unit', 'unrelated-' || n), 'allocated'
            FROM project_team_pi_process, ids WHERE unit='factory-unit'`;
        }),
      );
      expect(yield* f.fs.exists(stage)).toBe(false);
      expect(yield* f.fs.readFileString(source)).toBe("unrelated ownership");
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);
product("scope closure prevents a retained instance from preparing new work", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const managed = yield* Effect.scoped(f.service.forInstance(instance));
      const result = yield* failure(
        managed.prepareOperation({ kind: "initialize", threadId }, () => Effect.void),
      );
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "denied",
          detail: "Pi production runtime scope closed",
        });
      expect(f.fetch).not.toHaveBeenCalled();
    }),
  ),
);

for (const fault of ["duplicate", "changed-target"])
  product(`closure identity rejects ${fault} allocation files`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        let stage = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.service.forInstance(instance);
            stage = stageFrom(f);
            const files = f.captured[0]!.runtimeFiles.map((file, index, all) =>
              index === 1
                ? fault === "duplicate"
                  ? all[0]!
                  : { ...file, target: "/runtime/wrong-target" }
                : file,
            );
            yield* processRow(files, "drained");
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(true);
      }),
    ),
  );
it.effect("foreign SQL transactions cannot construct the factory", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(failure(construct(f)));
      expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(false);
      expect(yield* f.fs.exists(f.options.stagingRoot)).toBe(false);
    }),
  ),
);
product(
  "foreign SQL transactions cannot stage an instance or lend uncommitted ownership receipts",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* enabledFixture;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(failure(f.service.forInstance(instance)));
        expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(false);
        expect(yield* f.fs.exists(f.options.stagingRoot)).toBe(false);
      }),
    ),
);

product(
  "the approved Runtime consumes factory asset revalidation before durable allocation",
  () => {
    const exercise = (tampered: boolean) =>
      scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(at)) + 100);
          const repository = yield* ProjectWorkRepository;
          let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
          yield* seed("investigator", "reserved", {
            nativeSessionId: null,
            roleTools: [],
            toolIds: [],
            issueCredential: false,
          }).pipe(
            Effect.provideService(ProjectWorkRepository, {
              ...repository,
              execute: (command: ProjectWorkCommand) => {
                if (
                  command.type === "project-work.foundation.commit" &&
                  command.transition?.kind === "claim"
                ) {
                  pending = command;
                  return Effect.fail(
                    new ProjectWorkPolicyError(
                      "invalid-state",
                      "Capture the original dispatch claim",
                    ),
                  );
                }
                return repository.execute(command);
              },
            }),
            Effect.result,
          );
          if (pending?.transition?.kind !== "claim")
            return yield* Effect.die("Missing original factory claim");
          const assignment = {
            role: (yield* readCurrentState(
              yield* SqlClient.SqlClient,
              projectId,
            )).foundationRecords!.find((record) => record.kind === "role-revision")!,
          };
          if (assignment.role.kind !== "role-revision")
            return yield* Effect.die("Missing factory role");
          const f = yield* fixture;
          const primary = f.root + "/primary";
          const assigned = f.root + "/assigned";
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const git = (args: ReadonlyArray<string>) =>
            Effect.scoped(
              Effect.gen(function* () {
                const child = yield* spawner.spawn(ChildProcess.make("/usr/bin/git", args));
                const [stdout, stderr, code] = yield* Effect.all(
                  [
                    collectUint8StreamText({ stream: child.stdout, maxBytes: 8192 }),
                    collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
                    child.exitCode,
                  ],
                  { concurrency: "unbounded" },
                );
                expect(Number(code)).toBe(0);
                expect(stdout.truncated || stderr.truncated).toBe(false);
              }),
            );
          yield* git(["init", "-q", primary]);
          yield* git([
            "-C",
            primary,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
          ]);
          yield* git(["-C", primary, "worktree", "add", "-qb", "task", assigned]);
          const model = "inclusionai/ling-3.1-flash:free";
          const role = {
            ...assignment.role,
            instructions: "Inspect the approved assignment",
            model,
          };
          yield* restoreHistoricalBinding(role);
          const crypto = yield* Crypto.Crypto;
          const instructionsHash = Buffer.from(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(role.instructions)),
          ).toString("hex");
          const binding = {
            ...pending.transition.binding,
            model,
            worktree: assigned,
            branch: "refs/heads/task",
            configuration: {
              ...pending.transition.binding.configuration,
              instructionsHash,
              runtimeVersion: "0.99.1",
              maxDurationMs: 300000,
              maxTokens: 20000,
            },
          };
          const sql = yield* SqlClient.SqlClient;
          const decodeFoundation = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
          yield* repository.execute(
            yield* decodeFoundation({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "factory-limits",
              expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
              attribution: pending.attribution,
              committedAt: at,
              records: [
                {
                  kind: "limits",
                  projectId,
                  recordId: "factory-limits",
                  revision: 0,
                  generation: 0,
                  updatedAt: at,
                  status: "configured",
                  environmentModelCalls: 4,
                  projectWritableWorkers: 2,
                  modelCalls: 2,
                  delegationDepth: 2,
                  repairAllowance: 2,
                  model,
                  tokenLimit: 20000,
                  durationLimitMs: 300000,
                },
              ],
            }),
          );
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 4,
          });
          const oidChild = yield* spawner.spawn(
            ChildProcess.make("/usr/bin/git", ["-C", primary, "rev-parse", "HEAD"]),
          );
          const oid = yield* collectUint8StreamText({ stream: oidChild.stdout, maxBytes: 128 });
          expect(Number(yield* oidChild.exitCode)).toBe(0);
          const originalDispatch = yield* journal.claimEffect(
            (yield* journal.reserve({
              dispatchId: "factory-original",
              claim: {
                ...pending,
                expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
                transition: { ...pending.transition, binding },
              },
              git: {
                effectId: "factory-original",
                runId: binding.recordId,
                generation: binding.generation,
                primaryRoot: primary,
                commonGitDirectory: primary + "/.git",
                worktreePath: assigned,
                branchRef: "refs/heads/task",
                baseRef: "HEAD",
                baseOid: oid.text.trim(),
                ownershipToken: "factory-owner",
                policyHash: "b".repeat(64),
              },
              setupId: "factory-setup",
              initializeOperationId: "factory-initialize",
              assignmentOperationId: "factory-assignment",
              assignment: "Inspect the approved factory assignment",
            })).fence,
          );
          const source = "https://api.commandcode.ai/provider/v1/models";
          yield* sql`INSERT INTO project_team_pi_catalogue(source, fetched_at, payload_json)
    VALUES(${source}, ${at}, ${encode({
      source,
      fetchedAt: at,
      selectedEntry: {
        id: model,
        owned_by: "command-code",
        context_length: 20000,
        supported_endpoints: ["/chat/completions"],
      },
    })})`;
          const catalogue = yield* makePiModelCatalogue.pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, f.fetch),
          );
          const service = yield* makePiProductionRuntime({
            ...f.options,
            environmentId: "environment",
          }).pipe(
            Effect.provideService(PiModelCatalogue, catalogue),
            Effect.provideService(FetchHttpClient.Fetch, f.fetch),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const managed = yield* service.forInstance(instance);
              expect(f.revalidationCalls).toBe(0);
              if (tampered) {
                const file = f.captured[0]!.runtimeFiles.find(
                  (entry) => entry.target === "/runtime/dist/pi-worker.mjs",
                )!;
                const original = yield* Effect.promise(() => nativeFS.stat(file.source));
                // Change the captured inode's bytes, then restore its read-only mode. Path-only
                // preallocation would admit this file; the actual Assets identity read rejects it.
                yield* Effect.promise(async () => {
                  await nativeFS.chmod(file.source, (original.mode & 0o777) | 0o200);
                  await nativeFS.appendFile(file.source, "\n// changed after asset capture\n");
                  await nativeFS.chmod(file.source, original.mode & 0o777);
                });
              }
              const request = {
                kind: "initialize" as const,
                operationId: originalDispatch.intent.request.initializeOperationId,
                threadId,
                cwd: assigned,
                modelSelection: { instanceId: providerInstanceId, model },
              };
              const preparation = managed.prepareOperation(request, () => Effect.void);
              // The factory must preserve caller values before any asynchronous preparation.
              request.cwd = primary;
              request.modelSelection.model = "mutated-after-call";
              if (!tampered) {
                const prepared = yield* preparation;
                expect(f.revalidationCalls).toBe(1);
                const before =
                  yield* sql`SELECT unit, allocation_json, status FROM project_team_pi_process`;
                expect(before).toHaveLength(1);
                expect(before[0]?.status).toBe("allocated");
                yield* managed.stopAll;
                const drained =
                  yield* sql`SELECT unit, allocation_json, status FROM project_team_pi_process`;
                expect(drained[0]?.status).toBe("drained");
                expect(yield* sql`SELECT operation_id FROM project_team_pi_operation`).toHaveLength(
                  1,
                );
                expect(prepared.operation.operationKind).toBe("initialize");
                expect(f.fetch).not.toHaveBeenCalled();
                return;
              }
              const failed = yield* failure(preparation);
              if (failed._tag === "Failure")
                expect(failed.failure).toMatchObject({
                  code: "unavailable",
                  detail: "Pi production runtime unavailable",
                });
              expect(f.revalidationCalls).toBe(1);
              expect(
                yield* sql`SELECT unit, allocation_json, status FROM project_team_pi_process`,
              ).toEqual([]);
              expect(yield* sql`SELECT operation_id FROM project_team_pi_operation`).toHaveLength(
                0,
              );
              expect(f.fetch).not.toHaveBeenCalled();
            }),
          );
        }),
      );
    return exercise(false).pipe(
      Effect.andThen(Effect.sync(() => vi.restoreAllMocks())),
      Effect.andThen(exercise(true)),
    );
  },
);
