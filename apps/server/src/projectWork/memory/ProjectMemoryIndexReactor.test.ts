import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readCurrentState } from "../ProjectWorkRepository.ts";
import { makeMem0Backend } from "./Mem0Backend.ts";
import {
  MemoryBackendError,
  MemoryIndexManifest,
  type MemoryBackendTransport,
} from "./MemoryBackend.ts";
import { makeProjectMemoryIndexReactor } from "./ProjectMemoryIndexReactor.ts";
import { makeProjectMemoryService, ProjectMemoryServiceError } from "./ProjectMemoryService.ts";

import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { CommandId, ProjectId, ProjectWorkTaskId, ProjectWorkComment } from "@t3tools/contracts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "../ProjectWorkRepository.ts";
import * as ContentGuard from "../ProjectWorkContentGuard.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import type { ProjectMemoryModelPorts } from "./ProjectMemoryService.ts";

const memoryTestAt = "2026-10-03T00:00:00.000Z";
const attribution = {
  actor: { kind: "system", id: "retained-fixture" },
  source: { kind: "system", id: "retained-fixture" },
  recordedAt: memoryTestAt,
} as const;
const commentFixture = Schema.decodeUnknownSync(ProjectWorkComment);
const services = Layer.mergeAll(ProjectWorkRepositoryLive, Authorization.layer).pipe(
  Layer.provideMerge(ContentGuard.layer),
);
const withMemoryDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>, filename?: string) =>
  effect.pipe(
    Effect.provide(
      services.pipe(
        Layer.provideMerge(
          filename === undefined
            ? NodeSqliteClient.layerMemory()
            : NodeSqliteClient.layer({ filename }),
        ),
      ),
    ),
  );
const memorySetup = Effect.fn("memoryTest.setup")(function* (models?: ProjectMemoryModelPorts) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  for (const projectId of ["memory-project", "shared-project"])
    yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},${projectId},${`/fixture/${projectId}`},'[]',${memoryTestAt},${memoryTestAt})`;
  const projectId = ProjectId.make("memory-project");
  const taskId = ProjectWorkTaskId.make("memory-task");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("memory-task-create"),
    title: "Retained investigation",
    createdAt: memoryTestAt,
  });
  const comment = commentFixture({
    commentId: "memory-comment",
    projectId,
    taskId,
    body: "The parser preserves the source revision and exact provenance.",
    revision: 0,
    createdAt: memoryTestAt,
    attribution,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    projectId,
    commandId: CommandId.make("memory-comment-add"),
    comment,
    attribution,
    addedAt: memoryTestAt,
  });
  const service = makeProjectMemoryService({
    sql,
    repository,
    contentGuard,
    authorization,
    environmentId: "fixture-environment",
    ...(models === undefined ? {} : { models }),
  });
  return { sql, repository, contentGuard, authorization, service, projectId, taskId, comment };
});
const memoryModels = (
  facts: unknown = [
    { key: "parser", body: "The parser retains source provenance.", quote: "exact provenance" },
  ],
): ProjectMemoryModelPorts => ({
  extract: () => Effect.succeed(facts),
  embed: (input) =>
    Effect.succeed(input.bodies.map(() => Array.from({ length: 2048 }, () => 0.125))),
});

const Request = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestId: Schema.String,
  operation: Schema.String,
  input: Schema.Unknown,
});
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Request));
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCleanup = Schema.decodeUnknownEffect(
  Schema.Struct({
    environmentId: Schema.String,
    projectId: Schema.String,
    sourceRecordId: Schema.String,
    sourceRevision: Schema.Number,
    sourceGeneration: Schema.Number,
  }),
);
const decodeManifest = Schema.decodeUnknownEffect(MemoryIndexManifest);

/** Explicitly simulated companion transport through the actual Mem0 adapter.
 * It establishes consumer/restart semantics, not native Mem0 or model correctness.
 */
const simulatedCompanion = () => {
  const indexed = new Set<string>();
  const requests: Array<typeof Request.Type> = [];
  const deleted = new Set<string>();
  let failAfterFirstPoint = false;
  let failDelete = false;
  let partialAck = false;
  let malformedComplete = false;
  const transport: MemoryBackendTransport = Effect.fn("memoryTest.simulatedCompanion")(
    function* (bytes) {
      const request = yield* decodeRequest(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(
          () => new MemoryBackendError({ code: "invalid-request", message: "fixture envelope" }),
        ),
      );
      requests.push(request);
      let result: unknown;
      if (request.operation === "delete-source") {
        const input = yield* decodeCleanup(request.input).pipe(
          Effect.mapError(
            () => new MemoryBackendError({ code: "invalid-request", message: "fixture cleanup" }),
          ),
        );
        deleted.add(input.sourceRecordId);
        if (failDelete)
          return yield* new MemoryBackendError({
            code: "unavailable",
            message: "simulated lost delete response",
          });
        result = { cleanupComplete: true };
      } else {
        const input = yield* decodeManifest(request.input).pipe(
          Effect.mapError(
            () => new MemoryBackendError({ code: "invalid-request", message: "fixture manifest" }),
          ),
        );
        if (deleted.has(input.sourceRecordId))
          return yield* new MemoryBackendError({ code: "fenced", message: "simulated tombstone" });
        if (request.operation === "index") {
          for (const observation of input.observations) {
            indexed.add(observation.observationId);
            if (failAfterFirstPoint) {
              failAfterFirstPoint = false;
              return yield* new MemoryBackendError({
                code: "unavailable",
                message: "simulated crash after one native point",
              });
            }
          }
          result = {
            writtenObservationIds: input.observations
              .map((entry) => entry.observationId)
              .slice(0, partialAck ? 1 : undefined),
          };
        } else {
          const missing = input.observations
            .filter((entry) => !indexed.has(entry.observationId))
            .map((entry) => entry.observationId);
          result = {
            complete: malformedComplete || missing.length === 0,
            missingObservationIds: missing,
            invalidObservationIds: [],
            unexpectedBackendIds: [],
          };
        }
      }
      return new TextEncoder().encode(
        encodeResponse({
          protocolVersion: 1,
          requestId: request.requestId,
          operation: request.operation,
          result,
        }),
      );
    },
  );
  return {
    backend: makeMem0Backend(transport),
    requests,
    indexed,
    deleted,
    crashAfterPoint: () => {
      failAfterFirstPoint = true;
    },
    loseDeleteResponse: () => {
      failDelete = true;
    },
    restoreDelete: () => {
      failDelete = false;
    },
    ackSubset: () => {
      partialAck = true;
    },
    falseComplete: () => {
      malformedComplete = true;
    },
  };
};
const twoFacts = [
  { key: "revision", body: "Source revisions survive restart.", quote: "source revision" },
  { key: "provenance", body: "Exact source provenance is retained.", quote: "exact provenance" },
];
const start = Effect.fn("memoryTest.start")(function* (facts: unknown = twoFacts) {
  let extractionCalls = 0;
  let embeddingCalls = 0;
  const models = memoryModels(facts);
  const fixture = yield* memorySetup({
    extract: (input) => {
      extractionCalls++;
      return models.extract(input);
    },
    embed: (input) => {
      embeddingCalls++;
      return models.embed(input);
    },
  });
  const source = yield* fixture.service.captureRetained(fixture.projectId, {
    kind: "comment",
    retainedId: "memory-comment",
  });
  const work = yield* fixture.service.readWork(
    fixture.projectId,
    (yield* readCurrentState(fixture.sql, fixture.projectId)).foundationRecords!.find(
      (record) => record.kind === "effect",
    )!.recordId,
  );
  const companion = simulatedCompanion();
  const reactor = makeProjectMemoryIndexReactor({
    ...fixture,
    backend: companion.backend,
    environmentId: "fixture-environment",
  });
  return {
    ...fixture,
    source,
    effectId: work.effect.effectId,
    companion,
    reactor,
    models,
    counters: () => ({ extractionCalls, embeddingCalls }),
  };
});

it.effect(
  "indexes the complete frozen observation set, records native proof, and replays without model/write calls",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const f = yield* start();
        const result = yield* f.reactor.consume(f.projectId, f.effectId);
        expect(result.status).toBe("pending-reflection");
        const job = yield* f.reactor.load(f.effectId);
        expect(job?.receipt?.observationIds).toHaveLength(2);
        expect(job?.status).toBe("settled");
        expect(f.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
        const before = f.companion.requests.length;
        expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe(
          "pending-reflection",
        );
        expect(f.companion.requests).toHaveLength(before);
        expect(f.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
        expect((yield* f.service.readWork(f.projectId, f.effectId)).effect.status).toBe("claimed");
      }),
    ),
);

it.effect(
  "recovers a partial native crash with the original vector/UUID manifest and requires a drained prior owner",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const f = yield* start();
        f.companion.crashAfterPoint();
        expect((yield* f.reactor.consume(f.projectId, f.effectId).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        const old = yield* f.reactor.load(f.effectId);
        expect(old?.status).toBe("uncertain");
        expect(f.companion.indexed.size).toBe(1);
        expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe("owned-elsewhere");
        const freshService = makeProjectMemoryService({
          ...f,
          environmentId: "fixture-environment",
        });
        const freshReactor = makeProjectMemoryIndexReactor({
          ...f,
          service: freshService,
          backend: f.companion.backend,
          environmentId: "fixture-environment",
        });
        expect(
          (yield* freshReactor
            .consume(f.projectId, f.effectId, {
              generation: 1,
              confirmDrained: Effect.fail(
                new ProjectMemoryServiceError({ reason: "owner still alive" }),
              ),
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* freshReactor.consume(f.projectId, f.effectId, {
            generation: 1,
            confirmDrained: Effect.void,
          })).status,
        ).toBe("pending-reflection");
        expect(f.companion.indexed.size).toBe(2);
        expect(f.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
        const manifests = f.companion.requests
          .filter((request) => request.operation === "index")
          .map((request) => request.input);
        expect(manifests[1]).toEqual(manifests[0]);
        expect((yield* freshReactor.load(f.effectId))?.claimGeneration).toBe(2);
      }),
    ),
);

it.effect("never acknowledges a subset even when all point writes happened", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const f = yield* start();
      f.companion.ackSubset();
      expect((yield* f.reactor.consume(f.projectId, f.effectId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect((yield* f.reactor.load(f.effectId))?.receipt).toBeUndefined();
      expect((yield* f.service.readWork(f.projectId, f.effectId)).extraction?.status).toBe(
        "extracted",
      );
    }),
  ),
);

it.effect("does not trust a complete flag when the backend reports missing points", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const f = yield* start();
      f.companion.falseComplete();
      yield* f.reactor.consume(f.projectId, f.effectId);
      expect(f.companion.requests.filter((request) => request.operation === "index")).toHaveLength(
        1,
      );
      expect(f.companion.indexed.size).toBe(2);
    }),
  ),
);

it.effect("empty extraction is a durable no-facts outcome with zero embedding/native writes", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const f = yield* start([]);
      yield* f.reactor.consume(f.projectId, f.effectId);
      expect((yield* f.reactor.load(f.effectId))?.receipt?.kind).toBe("no-facts");
      expect(f.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 0 });
      expect(f.companion.requests).toEqual([]);
    }),
  ),
);

it.effect(
  "cleanup survives source/event/checkpoint purge and a lost delete response without active authority",
  () =>
    withMemoryDatabase(
      Effect.gen(function* () {
        const f = yield* start();
        yield* f.reactor.consume(f.projectId, f.effectId);
        yield* f.service.retract(f.projectId, f.source.recordId);
        const cleanup = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
          (record) => record.kind === "effect" && record.effectKind === "memory-delete",
        )!;
        yield* f.sql`DELETE FROM project_team_memory_source WHERE project_id=${f.projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${f.projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${f.projectId}`;
        yield* f.sql`UPDATE projection_projects SET deleted_at='2026-10-03T01:00:00.000Z' WHERE project_id=${f.projectId}`;
        f.companion.loseDeleteResponse();
        expect(
          (yield* f.reactor.consume(f.projectId, cleanup.recordId).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect((yield* f.reactor.load(cleanup.recordId))?.status).toBe("uncertain");
        f.companion.restoreDelete();
        const recreated = makeProjectMemoryIndexReactor({
          ...f,
          backend: f.companion.backend,
          environmentId: "fixture-environment",
        });
        expect(
          (yield* recreated.consume(f.projectId, cleanup.recordId, {
            generation: 1,
            confirmDrained: Effect.void,
          })).status,
        ).toBe("pending-reflection");
        expect((yield* recreated.load(cleanup.recordId))?.receipt?.kind).toBe(
          "delete-source-complete",
        );
        expect(f.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
        expect(f.companion.deleted.has(f.source.recordId)).toBe(true);
      }),
    ),
);

it.effect("late extraction cannot persist observations after logical retraction", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const base = memoryModels();
      const f = yield* memorySetup({
        extract: (input) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(base.extract(input)),
          ),
        embed: base.embed,
      });
      const source = yield* f.service.captureRetained(f.projectId, {
        kind: "comment",
        retainedId: "memory-comment",
      });
      const effect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
        (record) => record.kind === "effect",
      )!;
      const companion = simulatedCompanion();
      const reactor = makeProjectMemoryIndexReactor({
        ...f,
        backend: companion.backend,
        environmentId: "fixture-environment",
      });
      const running = yield* reactor
        .consume(f.projectId, effect.recordId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      yield* f.service.retract(f.projectId, source.recordId);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(running))._tag).toBe("Failure");
      expect(yield* f.sql`SELECT * FROM project_team_memory_observation`).toHaveLength(0);
      expect(companion.requests).toEqual([]);
    }),
  ),
);

it.effect("unknown extraction never receives a blind request after restart", () =>
  withMemoryDatabase(
    Effect.gen(function* () {
      let calls = 0;
      const f = yield* memorySetup({
        extract: () => {
          calls++;
          return Effect.fail(
            new ProjectMemoryServiceError({ reason: "simulated uncertain request" }),
          );
        },
        embed: memoryModels().embed,
      });
      yield* f.service.captureRetained(f.projectId, {
        kind: "comment",
        retainedId: "memory-comment",
      });
      const effect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
        (record) => record.kind === "effect",
      )!;
      const companion = simulatedCompanion();
      const reactor = makeProjectMemoryIndexReactor({
        ...f,
        backend: companion.backend,
        environmentId: "fixture-environment",
      });
      expect((yield* reactor.consume(f.projectId, effect.recordId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* reactor
          .consume(f.projectId, effect.recordId, { generation: 1, confirmDrained: Effect.void })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(calls).toBe(1);
      expect(companion.requests).toEqual([]);
    }),
  ),
);

it.effect(
  "closes and reopens actual SQLite to recover frozen vectors, then cleanup after purge",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-memory-restart-" });
      const filename = path.join(directory, "state.sqlite");
      const original = yield* withMemoryDatabase(
        Effect.gen(function* () {
          const f = yield* start();
          f.companion.crashAfterPoint();
          expect((yield* f.reactor.consume(f.projectId, f.effectId).pipe(Effect.exit))._tag).toBe(
            "Failure",
          );
          const rows = yield* f.sql<{
            payload: string;
          }>`SELECT manifest_json AS payload FROM project_team_memory_manifest`;
          expect(rows).toHaveLength(1);
          return {
            projectId: f.projectId,
            sourceId: f.source.recordId,
            effectId: f.effectId,
            companion: f.companion,
            models: f.models,
            counters: f.counters,
            manifest: rows[0]!.payload,
          };
        }),
        filename,
      );
      const cleanupId = yield* withMemoryDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* ProjectWorkRepository;
          const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
          const authorization = yield* Authorization.ProjectTeamAuthorization;
          const service = makeProjectMemoryService({
            sql,
            repository,
            contentGuard,
            authorization,
            models: original.models,
            environmentId: "fixture-environment",
          });
          const reactor = makeProjectMemoryIndexReactor({
            sql,
            repository,
            service,
            backend: original.companion.backend,
            environmentId: "fixture-environment",
          });
          expect((yield* reactor.load(original.effectId))?.status).toBe("uncertain");
          expect(
            (yield* reactor.consume(original.projectId, original.effectId, {
              generation: 1,
              confirmDrained: Effect.void,
            })).status,
          ).toBe("pending-reflection");
          const rows = yield* sql<{
            payload: string;
          }>`SELECT manifest_json AS payload FROM project_team_memory_manifest`;
          expect(rows[0]!.payload).toBe(original.manifest);
          expect(original.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
          yield* service.retract(original.projectId, original.sourceId);
          const cleanup = (yield* readCurrentState(
            sql,
            original.projectId,
          )).foundationRecords!.find(
            (record) => record.kind === "effect" && record.effectKind === "memory-delete",
          )!;
          yield* sql`DELETE FROM project_team_memory_source WHERE project_id=${original.projectId}`;
          yield* sql`DELETE FROM project_work_events WHERE project_id=${original.projectId}`;
          yield* sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${original.projectId}`;
          yield* sql`DELETE FROM projection_projects WHERE project_id=${original.projectId}`;
          original.companion.loseDeleteResponse();
          expect(
            (yield* reactor.consume(original.projectId, cleanup.recordId).pipe(Effect.exit))._tag,
          ).toBe("Failure");
          return cleanup.recordId;
        }),
        filename,
      );
      original.companion.restoreDelete();
      yield* withMemoryDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* ProjectWorkRepository;
          const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
          const authorization = yield* Authorization.ProjectTeamAuthorization;
          const service = makeProjectMemoryService({
            sql,
            repository,
            contentGuard,
            authorization,
            environmentId: "fixture-environment",
          });
          const reactor = makeProjectMemoryIndexReactor({
            sql,
            repository,
            service,
            backend: original.companion.backend,
            environmentId: "fixture-environment",
          });
          expect(
            (yield* reactor.consume(original.projectId, cleanupId, {
              generation: 1,
              confirmDrained: Effect.void,
            })).status,
          ).toBe("pending-reflection");
          expect((yield* reactor.load(cleanupId))?.receipt?.kind).toBe("delete-source-complete");
          expect(yield* sql`SELECT * FROM projection_projects`).toHaveLength(1);
          expect(original.companion.deleted.has(original.sourceId)).toBe(true);
          expect(original.counters()).toEqual({ extractionCalls: 1, embeddingCalls: 1 });
        }),
        filename,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reopens actual SQLite after a lost embedding response without launching a blind replay",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-memory-embedding-restart-",
      });
      const filename = path.join(directory, "state.sqlite");
      let calls = 0;
      const base = memoryModels(twoFacts);
      const models: ProjectMemoryModelPorts = {
        extract: base.extract,
        embed: () => {
          calls++;
          return Effect.fail(
            new ProjectMemoryServiceError({ reason: "simulated lost embedding response" }),
          );
        },
      };
      const companion = simulatedCompanion();
      const original = yield* withMemoryDatabase(
        Effect.gen(function* () {
          const f = yield* memorySetup(models);
          yield* f.service.captureRetained(f.projectId, {
            kind: "comment",
            retainedId: "memory-comment",
          });
          const effect = (yield* readCurrentState(f.sql, f.projectId)).foundationRecords!.find(
            (record) => record.kind === "effect",
          )!;
          const reactor = makeProjectMemoryIndexReactor({
            ...f,
            backend: companion.backend,
            environmentId: "fixture-environment",
          });
          expect(
            (yield* reactor.consume(f.projectId, effect.recordId).pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect((yield* reactor.load(effect.recordId))?.status).toBe("uncertain");
          expect((yield* f.service.readWork(f.projectId, effect.recordId)).extraction?.status).toBe(
            "extracted",
          );
          expect(yield* f.sql`SELECT * FROM project_team_memory_manifest`).toHaveLength(0);
          return { projectId: f.projectId, effectId: effect.recordId };
        }),
        filename,
      );
      yield* withMemoryDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* ProjectWorkRepository;
          const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
          const authorization = yield* Authorization.ProjectTeamAuthorization;
          const service = makeProjectMemoryService({
            sql,
            repository,
            contentGuard,
            authorization,
            models,
            environmentId: "fixture-environment",
          });
          const reactor = makeProjectMemoryIndexReactor({
            sql,
            repository,
            service,
            backend: companion.backend,
            environmentId: "fixture-environment",
          });
          expect(
            (yield* service.readWork(original.projectId, original.effectId)).observations,
          ).toHaveLength(2);
          expect(yield* sql`SELECT * FROM project_team_memory_manifest`).toHaveLength(0);
          expect(
            (yield* reactor
              .consume(original.projectId, original.effectId, {
                generation: 1,
                confirmDrained: Effect.void,
              })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(calls).toBe(1);
          expect(companion.requests).toEqual([]);
        }),
        filename,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
