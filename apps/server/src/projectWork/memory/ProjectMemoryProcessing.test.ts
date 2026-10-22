import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MemoryExtractionResult,
  type MemoryProcessingConfiguration,
  type ProjectMemorySource,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as Backend from "./MemoryBackend.ts";
import * as Configuration from "./ProjectMemoryConfiguration.ts";
import * as ModelRoutes from "./ProjectMemoryModelRoutes.ts";
import * as Authority from "./ProjectMemoryService.ts";
import { ProjectMemoryError, sourceTuple, memoryHash } from "./ProjectMemoryRepository.ts";
import * as Processing from "./ProjectMemoryProcessing.ts";

const source: ProjectMemorySource = {
  kind: "memory-source",
  recordId: "record",
  owner: { kind: "project", projectId: ProjectId.make("project") },
  ownerRevision: 0,
  revision: 0,
  generation: 0,
  updatedAt: "2026-10-21T00:00:00Z",
  status: "current",
  sourceKind: "finding",
  sourceId: "source",
  sourceRevision: 0,
  content: "The build uses vp.",
  contentHash: memoryHash("The build uses vp."),
  contentRevision: 0,
  conversationSpans: [],
  attribution: {
    actor: { kind: "human" },
    source: { kind: "web" },
    recordedAt: "2026-10-21T00:00:00Z",
  },
};
const tuple = sourceTuple(
  { environmentId: EnvironmentId.make("env"), owner: source.owner, ownerRevision: 0 },
  source,
);
const input = {
  tuple,
  cwd: "/tmp",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "native" },
};
const facts: MemoryExtractionResult = {
  facts: [{ key: "build", body: "Use vp for builds.", quote: "build uses vp" }],
};
const denied = () => Effect.fail(new ProjectMemoryError({ reason: "forbidden" }));
const fixture = (
  options: {
    readonly extract?: () => Effect.Effect<MemoryExtractionResult>;
    readonly live?: () => boolean;
    readonly backend?: Backend.MemoryBackend["Service"]["execute"];
    readonly configuration?: () => {
      revision: number;
      configuration: MemoryProcessingConfiguration;
    };
    readonly externalExtract?: ModelRoutes.ProjectMemoryModelRoutes["Service"]["extract"];
    readonly embed?: ModelRoutes.ProjectMemoryModelRoutes["Service"]["embed"];
  } = {},
) => {
  const authority = Layer.effect(
    Authority.ProjectMemoryService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Authority.ProjectMemoryService.of({
        captureRetained: denied,
        capture: denied,
        correct: denied,
        retract: denied,
        listCurrentPage: denied,
        recallTextPage: denied,
        listCurrent: denied,
        recallText: denied,
        hydrateCurrentHits: denied,
        grant: denied,
        revoke: denied,
        listGrants: denied,
        deleteOwner: denied,
        readSource: () => Effect.succeed(options.live?.() === false ? undefined : source),
        applyCurrent: (tuple, apply) =>
          options.live?.() === false
            ? Effect.fail(new ProjectMemoryError({ reason: "stale" }))
            : apply(source),
        enqueueCleanup: (tuple, key) =>
          Effect.gen(function* () {
            yield* sql`INSERT OR REPLACE INTO t3_workflow_v2_memory_cleanup VALUES(${key},'env','project','project',0,'source',0,0,${source.contentHash},'pending',${JSON.stringify(tuple)})`;
          }).pipe(Effect.mapError(() => new ProjectMemoryError({ reason: "unavailable" }))),
      });
    }),
  ).pipe(Layer.provide(Sqlite.layerMemory));
  const unused = () => Effect.die("unused generation");
  return Processing.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Configuration.ProjectMemoryConfiguration, {
        read: () =>
          Effect.succeed(
            options.configuration?.() ?? {
              revision: 0,
              configuration: {
                destination: {
                  enabled: true,
                  embeddingEnabled: true,
                  backend: "mem0",
                  embeddingRoute: {
                    environmentId: tuple.environmentId,
                    owner: tuple.owner,
                    enabled: true,
                    endpoint: "https://example.test/embeddings",
                    model: "chosen",
                    secretName: "memory-key",
                    dimensions: 2,
                  },
                },
              },
            },
          ),
        set: () => Effect.die("unused"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ModelRoutes.ProjectMemoryModelRoutes, {
        extract: options.externalExtract ?? (() => Effect.die("external route disabled")),
        embed: options.embed ?? (() => Effect.die("external route disabled")),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(authority),
    Layer.provideMerge(
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateBranchName: unused,
          generateThreadTitle: unused,
          generateReviewGuide: unused,
          extractMemoryFacts: options.extract ?? (() => Effect.succeed(facts)),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(Backend.MemoryBackend, {
        execute: options.backend ?? (() => Effect.die("backend must stay disabled")),
      }),
    ),
  );
};
it.effect(
  "retains exact native extraction receipts and replays without inference or external requests",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const program = Effect.gen(function* () {
        const service = yield* Processing.ProjectMemoryProcessing;
        const sql = yield* SqlClient.SqlClient;
        const key = yield* service.enqueueExtraction(input);
        yield* service.run(key);
        yield* service.run(key);
        assert.equal(calls, 1);
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
            .length,
          1,
        );
        assert.equal(yield* service.enqueueExtraction(input), key);
      });
      yield* program.pipe(
        Effect.provide(
          fixture({
            extract: () => {
              calls++;
              return Effect.succeed(facts);
            },
          }),
        ),
      );
    }),
);
it.effect("rejects nonverbatim facts before persisting observations", () =>
  Effect.gen(function* () {
    const service = yield* Processing.ProjectMemoryProcessing;
    const sql = yield* SqlClient.SqlClient;
    const key = yield* service.enqueueExtraction(input);
    const outcome = yield* service.run(key).pipe(Effect.result);
    assert.equal(outcome._tag, "Failure");
    assert.equal(
      (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`).length,
      0,
    );
  }).pipe(
    Effect.provide(
      fixture({
        extract: () =>
          Effect.succeed({ facts: [{ key: "bad", body: "Invented", quote: "not in source" }] }),
      }),
    ),
  ),
);
it.effect("discards a model response after source retraction", () =>
  Effect.gen(function* () {
    let live = true;
    yield* Effect.gen(function* () {
      const service = yield* Processing.ProjectMemoryProcessing;
      const sql = yield* SqlClient.SqlClient;
      const key = yield* service.enqueueExtraction(input);
      yield* service.run(key);
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
          .length,
        0,
      );
      assert.equal(
        (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_processing`)[0]
          ?.status,
        "stale",
      );
    }).pipe(
      Effect.provide(
        fixture({
          live: () => live,
          extract: () =>
            Effect.sync(() => {
              live = false;
              return facts;
            }),
        }),
      ),
    );
  }),
);

const destination: Backend.MemoryCompanionDestination = {
  owner: source.owner,
  environmentId: "env",
  enabled: true,
  embeddingEnabled: true,
  command: "/companion",
  args: [],
  cwd: "/tmp",
};
it.effect(
  "retains uncertain index and owner-deletion cleanup across restart and replays the same receipt",
  () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      let indexCalls = 0;
      const requested: string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* Processing.ProjectMemoryProcessing;
        const sql = yield* SqlClient.SqlClient;
        const key = yield* service.enqueueExtraction(input);
        yield* service.run(key);
        yield* service.index(key, destination).pipe(Effect.ignore);
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_processing`)[0]
            ?.status,
          "uncertain",
        );
        yield* sql`INSERT INTO t3_workflow_v2_memory_cleanup VALUES('deleted-owner','env','project','project',0,'source',0,0,${source.contentHash},'pending',${JSON.stringify(tuple)})`;
        yield* service.cleanup();
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_cleanup`)[0]
            ?.status,
          "uncertain",
        );
        // Rebuilding the service loses all process-local state while retaining the same SQL database.
        const restarted = yield* Processing.ProjectMemoryProcessing.pipe(
          Effect.provide(Layer.fresh(Processing.layer)),
        );
        yield* restarted.cleanup();
        yield* restarted.run(key);
        assert.equal(cleanupCalls, 2);
        assert.equal(indexCalls, 1);
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
            .length,
          0,
        );
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_cleanup`)[0]
            ?.status,
          "completed",
        );
        assert.deepStrictEqual(requested, [key, key, key]);
      }).pipe(
        Effect.provide(
          fixture({
            backend: (request) => {
              requested.push(request.operationKey);
              if (request.operation === "index") {
                indexCalls++;
                return Effect.fail(new Backend.MemoryBackendError({ reason: "unavailable" }));
              }
              cleanupCalls++;
              return cleanupCalls === 1
                ? Effect.fail(new Backend.MemoryBackendError({ reason: "unavailable" }))
                : Effect.void;
            },
          }),
        ),
      );
    }),
);
it.effect("rejects malformed duplicate extraction keys", () =>
  Effect.gen(function* () {
    const service = yield* Processing.ProjectMemoryProcessing;
    const sql = yield* SqlClient.SqlClient;
    const key = yield* service.enqueueExtraction(input);
    const result = yield* service.run(key).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(
      (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`).length,
      0,
    );
  }).pipe(
    Effect.provide(
      fixture({ extract: () => Effect.succeed({ facts: [...facts.facts, ...facts.facts] }) }),
    ),
  ),
);
it.effect(
  "persists prepared vectors before an uncertain backend write and never re-embeds on restart",
  () =>
    Effect.gen(function* () {
      let embeddings = 0;
      let writes = 0;
      const payloads: unknown[] = [];
      yield* Effect.gen(function* () {
        const service = yield* Processing.ProjectMemoryProcessing;
        const key = yield* service.enqueueExtraction(input);
        yield* service.run(key);
        const configured: Backend.MemoryCompanionDestination = {
          ...destination,
          backend: "mem0",
          embeddingRoute: {
            environmentId: tuple.environmentId,
            owner: tuple.owner,
            enabled: true,
            endpoint: "https://example.test/embeddings",
            model: "chosen",
            secretName: "memory-key",
            dimensions: 2,
          },
        };
        yield* service.index(key, configured).pipe(Effect.ignore);
        const restarted = yield* Processing.ProjectMemoryProcessing.pipe(
          Effect.provide(Layer.fresh(Processing.layer)),
        );
        yield* restarted.reconcile();
        assert.equal(embeddings, 1);
        assert.equal(writes, 2);
        assert.deepStrictEqual(payloads[0], payloads[1]);
      }).pipe(
        Effect.provide(
          fixture({
            embed: () => {
              embeddings++;
              return Effect.succeed([[1, 2]]);
            },
            backend: (request) => {
              writes++;
              payloads.push(request.payload);
              return writes === 1
                ? Effect.fail(new Backend.MemoryBackendError({ reason: "unavailable" }))
                : Effect.void;
            },
          }),
        ),
      );
    }),
);
it.effect("simultaneous service instances publish only the first durable extraction receipt", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const first = yield* Processing.ProjectMemoryProcessing;
      const sql = yield* SqlClient.SqlClient;
      const second = yield* Processing.ProjectMemoryProcessing.pipe(
        Effect.provide(Layer.fresh(Processing.layer)),
      );
      const key = yield* first.enqueueExtraction(input);
      const firstRun = yield* first.run(key).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* second.run(key);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(firstRun);
      const observations = yield* sql<{
        observation_key: string;
      }>`SELECT observation_key FROM t3_workflow_v2_memory_observations WHERE status='current'`;
      assert.deepStrictEqual(observations, [{ observation_key: "winner" }]);
    }).pipe(
      Effect.provide(
        fixture({
          extract: () => {
            calls++;
            if (calls === 1)
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ facts: [{ ...facts.facts[0]!, key: "late" }] }),
              );
            return Effect.succeed({ facts: [{ ...facts.facts[0]!, key: "winner" }] });
          },
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
it.effect("simultaneous vector preparations cannot replace the retained backend operation", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let embeds = 0;
    let writes = 0;
    yield* Effect.gen(function* () {
      const first = yield* Processing.ProjectMemoryProcessing;
      const second = yield* Processing.ProjectMemoryProcessing.pipe(
        Effect.provide(Layer.fresh(Processing.layer)),
      );
      const key = yield* first.enqueueExtraction(input);
      yield* first.run(key);
      const configured: Backend.MemoryCompanionDestination = {
        ...destination,
        backend: "mem0",
        embeddingRoute: {
          environmentId: tuple.environmentId,
          owner: tuple.owner,
          enabled: true,
          endpoint: "https://example.test/embeddings",
          model: "chosen",
          secretName: "memory-key",
          dimensions: 2,
        },
      };
      const firstRun = yield* first.index(key, configured).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* second.index(key, configured);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(firstRun))._tag, "Failure");
      assert.equal(writes, 1);
    }).pipe(
      Effect.provide(
        fixture({
          embed: () => {
            embeds++;
            return embeds === 1
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as([[1, 2]]),
                )
              : Effect.succeed([[3, 4]]);
          },
          backend: () => {
            writes++;
            return Effect.void;
          },
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
it.effect("replays schema-valid control and quote escaping beyond 128KB of encoded JSON", () =>
  Effect.gen(function* () {
    let calls = 0;
    const escaped: MemoryExtractionResult = {
      facts: [0, 1, 2].map((index) => ({
        key: `escaped-${index}`,
        body: "\u0000".repeat(7998) + '"\\',
        quote: "build uses vp",
      })),
    };
    yield* Effect.gen(function* () {
      const service = yield* Processing.ProjectMemoryProcessing;
      const sql = yield* SqlClient.SqlClient;
      const key = yield* service.enqueueExtraction(input);
      yield* service.run(key);
      yield* service.run(key);
      const row = (yield* sql<{
        bytes: number;
        status: string;
      }>`SELECT length(CAST(result_json AS BLOB)) AS bytes,status FROM t3_workflow_v2_memory_processing WHERE operation_key=${key}`)[0];
      assert.isAbove(row!.bytes, 128000);
      assert.equal(row!.status, "completed");
      assert.equal(calls, 1);
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
          .length,
        3,
      );
    }).pipe(
      Effect.provide(
        fixture({
          extract: () => {
            calls++;
            return Effect.succeed(escaped);
          },
        }),
      ),
    );
  }),
);
it.effect("rejects oversized retained job inputs before inserting a durable job", () =>
  Effect.gen(function* () {
    const service = yield* Processing.ProjectMemoryProcessing;
    const sql = yield* SqlClient.SqlClient;
    const result = yield* service
      .enqueueExtraction({ ...input, cwd: "x".repeat(65536) })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_memory_processing`).length, 0);
  }).pipe(Effect.provide(fixture())),
);
it.effect("empty native facts settle without embedding or backend writes", () =>
  Effect.gen(function* () {
    const service = yield* Processing.ProjectMemoryProcessing;
    const sql = yield* SqlClient.SqlClient;
    const key = yield* service.enqueueExtraction(input);
    yield* service.run(key);
    const configured: Backend.MemoryCompanionDestination = {
      ...destination,
      backend: "mem0",
      embeddingRoute: {
        environmentId: tuple.environmentId,
        owner: tuple.owner,
        enabled: true,
        endpoint: "https://example.test/embeddings",
        model: "chosen",
        secretName: "memory-key",
        dimensions: 2,
      },
    };
    yield* service.index(key, configured);
    assert.equal(
      (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_processing`)[0]
        ?.status,
      "indexed",
    );
    assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_memory_observations`).length, 0);
  }).pipe(Effect.provide(fixture({ extract: () => Effect.succeed({ facts: [] }) }))),
);
it.effect("disabling an owner route prevents queued external extraction requests", () =>
  Effect.gen(function* () {
    const route = {
      environmentId: tuple.environmentId,
      owner: tuple.owner,
      enabled: true as const,
      provider: "liquid" as const,
      endpoint: "https://example.test/chat",
      model: "chosen",
      secretName: "memory-key",
    };
    let current: { revision: number; configuration: MemoryProcessingConfiguration } = {
      revision: 1,
      configuration: { extractionRoute: route },
    };
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* Processing.ProjectMemoryProcessing;
      const sql = yield* SqlClient.SqlClient;
      const key = yield* service.enqueueExtraction({
        ...input,
        extractionRoute: route,
        configurationRevision: 1,
      });
      current = { revision: 2, configuration: {} };
      const result = yield* service.run(key).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* service.reconcile();
      assert.equal(calls, 0);
      assert.equal(
        (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_processing`)[0]
          ?.status,
        "superseded",
      );
    }).pipe(
      Effect.provide(
        fixture({
          configuration: () => current,
          externalExtract: () => {
            calls++;
            return Effect.succeed(facts);
          },
        }),
      ),
    );
  }),
);
it.effect(
  "disabled indexing cannot replay a new write but retained destination cleanup still runs",
  () =>
    Effect.gen(function* () {
      const route = {
        environmentId: tuple.environmentId,
        owner: tuple.owner,
        enabled: true as const,
        endpoint: "https://example.test/embeddings",
        model: "chosen",
        secretName: "memory-key",
        dimensions: 2,
      };
      let current: { revision: number; configuration: MemoryProcessingConfiguration } = {
        revision: 1,
        configuration: {
          destination: {
            enabled: true,
            embeddingEnabled: true,
            backend: "mem0",
            embeddingRoute: route,
          },
        },
      };
      let writes = 0;
      let cleanups = 0;
      yield* Effect.gen(function* () {
        const service = yield* Processing.ProjectMemoryProcessing;
        const sql = yield* SqlClient.SqlClient;
        const key = yield* service.enqueueExtraction({ ...input, configurationRevision: 1 });
        yield* service.run(key);
        yield* service
          .index(key, { ...destination, backend: "mem0", embeddingRoute: route })
          .pipe(Effect.ignore);
        current = { revision: 2, configuration: {} };
        yield* service.reconcile();
        yield* service.cleanup();
        assert.equal(writes, 1);
        assert.equal(cleanups, 1);
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_memory_cleanup WHERE status='completed'`).length,
          1,
        );
      }).pipe(
        Effect.provide(
          fixture({
            configuration: () => current,
            embed: () => Effect.succeed([[1, 2]]),
            backend: (request) => {
              if (request.operation === "cleanup") {
                cleanups++;
                return Effect.void;
              }
              writes++;
              return Effect.fail(new Backend.MemoryBackendError({ reason: "unavailable" }));
            },
          }),
        ),
      );
    }),
);
