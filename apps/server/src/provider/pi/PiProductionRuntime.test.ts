import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, vi, afterEach } from "vite-plus/test";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { layer as authorizationLayer } from "../../projectWork/ProjectTeamAuthorization.ts";
import { ProjectWorkRepositoryLive } from "../../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkQueryLive } from "../../projectWork/ProjectWorkQuery.ts";
import { ProjectWorkSearchLive } from "../../projectWork/ProjectWorkSearch.ts";
import { ProjectWorkNarrativeLive } from "../../projectWork/ProjectWorkNarrative.ts";
import { ProjectWorkBriefingLive } from "../../projectWork/ProjectWorkBriefing.ts";
import { ProjectWorkGatewayLive } from "../../projectWork/ProjectWorkGateway.ts";
import { ProjectWorkProjectionLive } from "../../projectWork/ProjectWorkProjection.ts";
import {
  providerInstanceId,
  threadId,
} from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { PiModelCatalogue } from "./PiModelCatalogue.ts";
import * as Runtime from "./PiManagedRuntimeLive.ts";
import { makePiProductionRuntime, type PiProductionRuntimeOptions } from "./PiProductionRuntime.ts";

const NodeFS = process.getBuiltinModule("fs");
const nativeFS = NodeFS.promises;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
    return original(value).pipe(
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
const construct = (f: Effect.Success<typeof fixture>) =>
  makePiProductionRuntime(f.options).pipe(
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
        expect(f.captured).toHaveLength(0);
      }),
    ),
  );
});

// This opt-in group consumes real built npm assets and the actual factory/Runtime/SQL.
// It stages and inspects only; it does not activate the SDK or contact a model provider.
const product = distribution ? it.effect : it.effect.skip;
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
          }),
        );
        expect(yield* f.fs.exists(stage)).toBe(false);
        expect(yield* f.fs.exists(f.options.nativeStateRoot)).toBe(true);
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
