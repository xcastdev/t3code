import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Statement from "effect/unstable/sql/Statement";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProjectMemorySource,
  ProjectMemoryObservation,
  ProjectMemoryExtraction,
  ProjectWorkFoundationCommitCommand,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../ProjectWorkRepository.ts";
import { ProjectWorkProjectionLive } from "../ProjectWorkProjection.ts";
import { hydrateProjectMemoryHits } from "./ProjectMemoryHitHydration.ts";
import { selectProjectMemoryHits } from "./ProjectMemoryHitPolicy.ts";

const at = "2026-10-01T00:00:00.000Z";
const attribution = {
  actor: { kind: "system", id: "fixture" },
  source: { kind: "system", id: "fixture" },
  recordedAt: at,
} as const;
const decodeSourceFixture = Schema.decodeSync(ProjectMemorySource);
const decodeObservationFixture = Schema.decodeSync(ProjectMemoryObservation);
const decodeCommitFixture = Schema.decodeEffect(ProjectWorkFoundationCommitCommand);
const decodeExtractionFixture = Schema.decodeEffect(ProjectMemoryExtraction);
const source = (projectId = "target", recordId = "source", changes: Record<string, unknown> = {}) =>
  decodeSourceFixture({
    kind: "memory-source",
    projectId,
    recordId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "current",
    sourceKind: "finding",
    sourceId: `${recordId}-artifact`,
    sourceRevision: 1,
    content: "Durable sourced finding",
    contentHash: "hash",
    attribution,
    sharedWithProjectIds: [],
    ...changes,
  });
const observation = (s = source(), recordId = "hit", changes: Record<string, unknown> = {}) =>
  decodeObservationFixture({
    kind: "memory-observation",
    projectId: s.projectId,
    recordId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "current",
    sourceId: s.recordId,
    sourceRevision: s.sourceRevision,
    sourceGeneration: s.generation,
    extractionId: `${s.recordId}-extraction`,
    observationKey: recordId,
    body: "Current SQL observation",
    provenance: attribution,
    ...changes,
  });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const commit = Effect.fn("fixture.commit")(function* (records: ReadonlyArray<ProjectTeamRecord>) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  const projectId = records[0]?.projectId ?? "target";
  for (let offset = 0; offset < records.length; offset += 64) {
    const state = yield* readCurrentState(sql, projectId);
    yield* repo.execute(
      yield* decodeCommitFixture({
        type: "project-work.foundation.commit",
        commandId: `commit-${projectId}-${state.revision}`,
        projectId,
        expectedRevision: state.revision,
        attribution,
        records: records.slice(offset, offset + 64),
        committedAt: at,
      }),
    );
  }
});
const addProject = Effect.fn("fixture.addProject")(function* (projectId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},${projectId},${`/fixture/${projectId}`},'[]',${at},${at})`;
});
const addMemory = Effect.fn("fixture.addMemory")(function* (
  s = source(),
  obs: ReadonlyArray<ProjectMemoryObservation> = [observation(s)],
) {
  const extraction = yield* decodeExtractionFixture({
    kind: "memory-extraction",
    projectId: s.projectId,
    recordId: `${s.recordId}-extraction`,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "extracted",
    engine: "mem0",
    engineVersion: "2.2.1",
    sourceId: s.recordId,
    sourceRevision: s.sourceRevision,
    sourceGeneration: s.generation,
    extractionModel: "fixture/extraction",
    embeddingModel: "fixture/embedding",
    embeddingDimensions: 2048,
    expectedObservationIds: obs.map((o) => o.recordId),
    completedObservationIds: [],
    extractionHash: "extraction-hash",
  });
  yield* commit([s, extraction, ...obs]);
});
const services = Layer.merge(ProjectWorkRepositoryLive, ProjectWorkProjectionLive);
const testLayer = services.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* addProject("target");
  return yield* SqlClient.SqlClient;
});
const hydrate = (sql: SqlClient.SqlClient, hitIds: ReadonlyArray<string> = ["hit"]) =>
  hydrateProjectMemoryHits(sql, { projectId: "target", hitIds });
const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | ProjectWorkRepository>,
) => effect.pipe(Effect.provide(Layer.fresh(testLayer)));

it.effect(
  "hydrates real foundation records, preserves order/counts, and never changes decisions or SQL rows",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const obs = [observation(s), observation(s, "second")];
        yield* addMemory(s, obs);
        const before = yield* sql`SELECT * FROM project_work_events ORDER BY sequence`;
        const changes = yield* sql`SELECT total_changes() AS changes`;
        const result = yield* hydrate(sql, ["second", "missing", "hit", "second"]);
        expect(result).toMatchObject({
          status: "accepted",
          selected: [obs[1], obs[0]],
          rejectionCounts: { duplicateHit: 1, unknownObservation: 1 },
        });
        expect(yield* sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(before);
        expect(yield* sql`SELECT total_changes() AS changes`).toEqual(changes);
        expect(Object.keys(result).sort()).toEqual(["rejectionCounts", "selected", "status"]);
      }),
    ),
);

it.effect(
  "foreign observations require current explicit shares, including archived owners, and revocation suppresses delayed hits",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("owner");
        const s = source("owner");
        yield* addMemory(s);
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unauthorizedProject: 1 },
        });
        yield* commit([{ ...s, revision: 1, sharedWithProjectIds: [source().projectId] }]);
        yield* sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,changed_at) VALUES ('owner','archived','/fixture/owner',${at})`;
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [observation(s)],
        });
        yield* commit([{ ...s, revision: 2, sharedWithProjectIds: [] }]);
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unauthorizedProject: 1 },
        });
      }),
    ),
);

it.effect(
  "loads correction descendants outside hit IDs; a retracted correction never revives the original",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const old = observation(s);
        const correction = observation(s, "correction", { supersedes: "hit" });
        yield* addMemory(s, [old, correction]);
        expect(
          selectProjectMemoryHits({
            projectId: "target",
            authorityComplete: true,
            sources: [s],
            observations: [old],
            hitIds: ["hit"],
          }),
        ).toMatchObject({ selected: [old] });
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unavailableObservation: 1 },
        });
        yield* commit([{ ...correction, revision: 1, status: "retracted", tombstonedAt: at }]);
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unavailableObservation: 1 },
        });
      }),
    ),
);

for (const [kind, status] of [
  ["source", "conflicted"],
  ["source", "retracted"],
  ["observation", "conflicted"],
  ["observation", "retracted"],
  ["source", "tombstone"],
  ["observation", "tombstone"],
] as const) {
  it.effect(`suppresses ${kind} ${status} from current durable records`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const o = observation(s);
        yield* addMemory(s);
        const updated = {
          ...(kind === "source" ? s : o),
          revision: 1,
          ...(status === "tombstone"
            ? { tombstonedAt: at }
            : { status, ...(status === "retracted" ? { tombstonedAt: at } : {}) }),
        };
        yield* commit([updated]);
        expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [] });
      }),
    ),
  );
}

for (const [column, value] of [
  ["record_id", "wrong-id"],
  ["project_id", "owner"],
  ["status", "retracted"],
  ["revision", 4],
  ["generation", 2],
  ["source_id", "wrong-source"],
  ["unique_key", "wrong-key"],
  ["updated_at", "2026-09-01T00:00:00.000Z"],
] as const) {
  it.effect(`rejects physical observation ${column} disagreement`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("owner");
        yield* addMemory();
        yield* sql`UPDATE project_team_memory_observation SET ${sql(column)} = ${value} WHERE record_id = 'hit'`;
        expect(yield* hydrate(sql, [column === "record_id" ? "wrong-id" : "hit"])).toMatchObject({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
  );
}

for (const [label, payload] of [
  ["invalid JSON", "{"],
  ["unknown fields", encodeJson({ ...observation(), foreignEngineAuthority: true })],
  ["wrong kind", encodeJson(source())],
  ["missing correction", encodeJson(observation(source(), "hit", { supersedes: "missing" }))],
  ["cycle", encodeJson(observation(source(), "hit", { supersedes: "hit" }))],
] as const) {
  it.effect(`denies ${label} without returning any source authority`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* sql`UPDATE project_team_memory_observation SET payload_json = ${payload} WHERE record_id = 'hit'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
  );
}

for (const changes of [{ sourceRevision: 0 }, { sourceGeneration: 1 }]) {
  it.effect(`rejects stale source tuple ${encodeJson(changes)}`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* commit([
          {
            ...source(),
            revision: 1,
            generation: 1,
            sourceRevision: "sourceRevision" in changes ? 2 : 1,
          },
        ]);
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { staleSource: 1 },
        });
      }),
    ),
  );
}

for (const state of ["missing", "deleted", "archived", "tombstoned"] as const) {
  it.effect(`refuses ${state} current target projection/lifecycle`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        if (state === "missing")
          yield* sql`DELETE FROM projection_projects WHERE project_id = 'target'`;
        else if (state === "deleted")
          yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = 'target'`;
        else
          yield* sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,changed_at) VALUES ('target',${state},'/fixture/target',${at})`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "current-access-gone",
          selected: [],
        });
      }),
    ),
  );
}

it.effect(
  "schema rejects engine payloads, completeness markers, oversized hit arrays and malformed IDs before SQL",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        let getterReads = 0;
        const hiddenMarker = Object.defineProperty(
          { projectId: "target", hitIds: ["hit"] },
          "authorityComplete",
          { value: true },
        );
        const hiddenPayload = Object.defineProperty(
          { projectId: "target", hitIds: ["hit"] },
          "observations",
          {
            get: () => {
              getterReads++;
              return [observation()];
            },
          },
        );
        const getterInput = Object.defineProperty({ projectId: "target" }, "hitIds", {
          get: () => {
            getterReads++;
            return ["hit"];
          },
        });
        const getterHit = Object.defineProperty(["hit"], "0", {
          get: () => {
            getterReads++;
            return "hit";
          },
        });
        for (const input of [
          hiddenMarker,
          hiddenPayload,
          getterInput,
          { projectId: "target", hitIds: getterHit },
          { projectId: "target", hitIds: ["hit"], authorityComplete: true },
          { projectId: "target", hitIds: ["hit"], observations: [observation()] },
          { projectId: "target", hitIds: Array.from({ length: 129 }, () => "hit") },
          { projectId: "target", hitIds: [" "] },
          { projectId: "target", hitIds: [{ recordId: "hit", projectId: "owner" }] },
        ])
          expect(yield* hydrateProjectMemoryHits(sql, input)).toEqual({
            status: "denied",
            reason: "invalid-input",
            selected: [],
          });
        expect(getterReads).toBe(0);
      }),
    ),
);

for (const [column, value] of [
  ["source_id", "wrong-artifact"],
  ["unique_key", "unexpected"],
  ["revision", 9],
  ["generation", 3],
  ["status", "superseded"],
] as const) {
  it.effect(`rejects physical source ${column} disagreement`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* sql`UPDATE project_team_memory_source SET ${sql(column)} = ${value} WHERE record_id = 'source'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
  );
}

for (const state of ["missing", "deleted", "tombstoned"] as const) {
  it.effect(`refuses ${state} source owner despite retained explicit share`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("owner");
        yield* addMemory(source("owner", "source", { sharedWithProjectIds: ["target"] }));
        if (state === "missing")
          yield* sql`DELETE FROM projection_projects WHERE project_id = 'owner'`;
        else if (state === "deleted")
          yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = 'owner'`;
        else
          yield* sql`INSERT INTO project_lifecycle (project_id,state,workspace_root,changed_at) VALUES ('owner','tombstoned','/fixture/owner',${at})`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "current-access-gone",
          selected: [],
        });
      }),
    ),
  );
}

it.effect(
  "loads source correction descendants outside hits and rejects cross-project correction edges",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("owner");
        const s = source();
        yield* addMemory(s);
        yield* commit([source("target", "new-source", { supersedes: s.recordId })]);
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unavailableSource: 1 },
        });
        yield* addMemory(source("owner", "foreign-source"), [
          observation(source("owner", "foreign-source"), "foreign-hit"),
        ]);
        yield* sql`UPDATE project_team_memory_source SET payload_json = ${encodeJson(source("target", "new-source", { supersedes: "foreign-source" }))} WHERE record_id = 'new-source'`;
        expect(yield* hydrate(sql, ["hit", "foreign-hit"])).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
);

it.effect("rejects cross-table duplicate IDs and malformed retained non-hit tombstones", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* addMemory();
      yield* commit([source("target", "other-source")]);
      yield* sql`UPDATE project_team_memory_source SET record_id = 'hit', payload_json = ${encodeJson(source("target", "hit"))}, source_id = 'hit-artifact' WHERE record_id = 'other-source'`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
      yield* sql`DELETE FROM project_team_memory_source WHERE record_id = 'hit'`;
      yield* commit([source("target", "retained", { status: "retracted", tombstonedAt: at })]);
      yield* sql`UPDATE project_team_memory_source SET payload_json = '{' WHERE record_id = 'retained'`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
    }),
  ),
);

for (const kind of ["source", "observation"] as const) {
  it.effect(`accepts exactly 256 ${kind} records and denies the 257-row sentinel`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        if (kind === "source") {
          yield* addMemory(s);
          yield* commit(Array.from({ length: 255 }, (_, i) => source("target", `s-${i}`)));
        } else
          yield* addMemory(
            s,
            Array.from({ length: 256 }, (_, i) => observation(s, i === 0 ? "hit" : `o-${i}`)),
          );
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [observation(s)],
        });
        const extra = kind === "source" ? source("target", "sentinel") : observation(s, "sentinel");
        const table =
          kind === "source" ? "project_team_memory_source" : "project_team_memory_observation";
        const key =
          extra.kind === "memory-observation"
            ? encodeJson([
                extra.sourceId,
                extra.sourceRevision,
                extra.sourceGeneration,
                extra.observationKey,
              ])
            : null;
        yield* sql`INSERT INTO ${sql(table)} (record_id,project_id,status,revision,generation,updated_at,source_id,unique_key,payload_json) VALUES (${extra.recordId},${extra.projectId},${extra.status},${extra.revision},${extra.generation},${extra.updatedAt},${extra.sourceId},${key},${encodeJson(extra)})`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "incomplete-authority",
          selected: [],
        });
      }),
    ),
  );
}

it.effect(
  "enforces 1 MiB encoded bytes per payload before JSON decoding, including non-ASCII bytes",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        yield* addMemory(s);
        const encoded = encodeJson(s);
        const exact = encoded + " ".repeat(1_048_576 - Buffer.byteLength(encoded));
        yield* sql`UPDATE project_team_memory_source SET payload_json = ${exact} WHERE record_id = 'source'`;
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [observation(s)],
        });
        yield* sql`UPDATE project_team_memory_source SET payload_json = ${exact + " "} WHERE record_id = 'source'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "incomplete-authority",
          selected: [],
        });
        yield* sql`UPDATE project_team_memory_source SET payload_json = ${"é".repeat(524_289)} WHERE record_id = 'source'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "incomplete-authority",
          selected: [],
        });
      }),
    ),
);

it.effect("checks total retained encoded bytes before fetching any authority payload", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* addMemory();
      const more = Array.from({ length: 15 }, (_, i) => source("target", `s-${i}`));
      yield* commit(more);
      const observationBytes = Buffer.byteLength(encodeJson(observation()));
      for (const [i, s] of [source(), ...more].entries()) {
        const encoded = encodeJson(s);
        const desired = 1_048_576 - (i === 15 ? observationBytes : 0);
        yield* sql`UPDATE project_team_memory_source SET payload_json = ${encoded + " ".repeat(desired - Buffer.byteLength(encoded))} WHERE record_id = ${s.recordId}`;
      }
      expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [observation()] });
      yield* sql`UPDATE project_team_memory_source SET payload_json = payload_json || ' ' WHERE record_id = 's-14'`;
      expect(yield* hydrate(sql)).toEqual({
        status: "denied",
        reason: "incomplete-authority",
        selected: [],
      });
    }),
  ),
);

it.effect("accepts 128 distinct hit owners plus target without importing unrelated projects", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      const hits: Array<string> = [];
      for (let i = 0; i < 128; i++) {
        const owner = `owner-${i}`;
        const s = source(owner, `source-${i}`, { sharedWithProjectIds: ["target"] });
        const o = observation(s, `hit-${i}`);
        yield* addProject(owner);
        yield* addMemory(s, [o]);
        hits.push(o.recordId);
      }
      yield* addProject("unrelated");
      yield* addMemory(source("unrelated", "unrelated-source"), [
        observation(source("unrelated", "unrelated-source"), "unrelated-hit"),
      ]);
      yield* sql`UPDATE project_team_memory_source SET payload_json = '{' WHERE project_id = 'unrelated'`;
      const result = yield* hydrate(sql, hits);
      expect(result.status).toBe("accepted");
      expect(result.selected.length).toBe(128);
    }),
  ),
);

it.effect(
  "joins an existing transaction on the supplied client and preserves caller rollback",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("owner");
        const s = source("owner");
        yield* addMemory(s);
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* commit([{ ...s, revision: 1, sharedWithProjectIds: [source().projectId] }]);
              expect(yield* hydrate(sql)).toMatchObject({
                status: "accepted",
                selected: [observation(s)],
              });
              return yield* Effect.fail("caller-rollback");
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* hydrate(sql)).toMatchObject({
          status: "accepted",
          selected: [],
          rejectionCounts: { unauthorizedProject: 1 },
        });
      }),
    ),
);

it.effect(
  "does not mistake another client's transaction for the supplied client's transaction",
  () =>
    withDatabase(
      Effect.gen(function* () {
        const first = yield* setup;
        yield* addMemory();
        yield* first.withTransaction(
          Effect.gen(function* () {
            const second = yield* setup;
            yield* addMemory(source("target", "source", { content: "Second database" }));
            expect(yield* hydrate(second)).toMatchObject({
              status: "accepted",
              selected: [observation()],
            });
          }).pipe(Effect.provide(Layer.fresh(testLayer))),
        );
      }),
    ),
);

const fileServices = (filename: string, readonly = false) =>
  services.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename, readonly })));

it.effect(
  "rehydrates durable foundation rows after actual file-backed close/reopen on a read-only client",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filename = `${directory}/memory.sqlite`;
        yield* Effect.gen(function* () {
          yield* setup;
          yield* addMemory();
        }).pipe(Effect.provide(Layer.fresh(fileServices(filename))));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* hydrate(sql)).toMatchObject({
            status: "accepted",
            selected: [observation()],
          });
          expect(yield* sql`SELECT total_changes() AS changes`).toEqual([{ changes: 0 }]);
        }).pipe(Effect.provide(Layer.fresh(fileServices(filename, true))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const change of ["share-revocation", "target-deletion"] as const) {
  it.effect(
    `keeps one real read snapshot across mid-read ${change} and denies it on the next read`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const filename = `${directory}/snapshot.sqlite`;
          yield* Effect.gen(function* () {
            const sql = yield* setup;
            yield* sql`PRAGMA journal_mode=WAL`;
            yield* addProject("owner");
            yield* addMemory(source("owner", "source", { sharedWithProjectIds: ["target"] }));
            const metadataRead = yield* Deferred.make<void>();
            const releaseRead = yield* Deferred.make<void>();
            const reserved = yield* sql.reserve;
            const connection: Connection = {
              ...reserved,
              execute(query, params, rowTransform) {
                return reserved
                  .execute(query, params, rowTransform)
                  .pipe(
                    Effect.tap(() =>
                      query.includes("length(CAST(payload_json AS BLOB)) AS bytes") &&
                      query.includes("project_team_memory_source")
                        ? Deferred.succeed(metadataRead, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseRead)),
                          )
                        : Effect.void,
                    ),
                  );
              },
            };
            const reader = yield* SqlClient.make({
              acquirer: Effect.succeed(connection),
              transactionAcquirer: Effect.succeed(connection),
              compiler: Statement.makeCompilerSqlite(),
              spanAttributes: [],
            }).pipe(Effect.provide(Reactivity.layer));
            const pending = yield* hydrate(reader).pipe(Effect.forkScoped);
            yield* Deferred.await(metadataRead);
            yield* Effect.gen(function* () {
              const writer = yield* SqlClient.SqlClient;
              if (change === "share-revocation")
                yield* commit([{ ...source("owner"), revision: 1, sharedWithProjectIds: [] }]);
              else
                yield* writer`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = 'target'`;
            }).pipe(Effect.provide(Layer.fresh(fileServices(filename))));
            yield* Deferred.succeed(releaseRead, undefined);
            expect(yield* Fiber.join(pending)).toMatchObject({
              status: "accepted",
              selected: [observation(source("owner"))],
            });
            expect(yield* hydrate(reader)).toMatchObject(
              change === "share-revocation"
                ? { status: "accepted", selected: [], rejectionCounts: { unauthorizedProject: 1 } }
                : { status: "denied", reason: "current-access-gone", selected: [] },
            );
          }).pipe(Effect.provide(Layer.fresh(fileServices(filename))));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}
