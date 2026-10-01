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
  ProjectTeamMission,
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
const decodeMissionFixture = Schema.decodeEffect(ProjectTeamMission);
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
  extractionId = `${s.recordId}-extraction`,
) {
  const extraction = yield* decodeExtractionFixture({
    kind: "memory-extraction",
    projectId: s.projectId,
    recordId: extractionId,
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
        yield* sql`DELETE FROM ${sql(table)} WHERE record_id = 'sentinel'`;
        if (kind === "source") yield* commit([extra]);
        else {
          const newSource = source("target", "sentinel-source");
          yield* addMemory(newSource, [observation(newSource, "sentinel")]);
        }
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

for (const kind of ["source", "observation"] as const) {
  it.effect(`canonical membership denies a misplaced non-hit ${kind} correction`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addProject("unrelated");
        const s = source();
        if (kind === "observation")
          yield* addMemory(s, [
            observation(s),
            observation(s, "correction", { supersedes: "hit" }),
          ]);
        else {
          yield* addMemory(s);
          yield* commit([source("target", "correction", { supersedes: "source" })]);
        }
        const table =
          kind === "source" ? "project_team_memory_source" : "project_team_memory_observation";
        expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [] });
        const events = yield* sql`SELECT * FROM project_work_events ORDER BY sequence`;
        const authority = yield* readCurrentState(sql, "target");
        yield* sql`UPDATE ${sql(table)} SET project_id = 'unrelated' WHERE record_id = 'correction'`;
        expect((yield* readCurrentState(sql, "target")).foundationRecords).toEqual(
          authority.foundationRecords,
        );
        expect(yield* sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(events);
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
        yield* sql`UPDATE ${sql(table)} SET project_id = 'target' WHERE record_id = 'correction'`;
        expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [] });
        yield* sql`DELETE FROM ${sql(table)} WHERE record_id = 'correction'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
  );
}

for (const field of ["supersedes", "body", "sharedWithProjectIds"] as const) {
  it.effect(`denies altered non-hit ${field} despite consistent physical metadata`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const correction = observation(s, "correction", { supersedes: "hit" });
        yield* addMemory(s, [observation(s), correction]);
        const table =
          field === "sharedWithProjectIds"
            ? "project_team_memory_source"
            : "project_team_memory_observation";
        const record = field === "sharedWithProjectIds" ? s : correction;
        const altered =
          field === "supersedes"
            ? { ...correction, supersedes: undefined }
            : field === "body"
              ? { ...correction, body: "Unlogged correction" }
              : { ...s, sharedWithProjectIds: ["unrelated"] };
        yield* sql`UPDATE ${sql(table)} SET payload_json = ${encodeJson(altered)} WHERE record_id = ${record.recordId}`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
        // Canonical comparison accepts reordered JSON keys and insignificant whitespace.
        const reordered = Object.fromEntries(Object.entries(record).toReversed());
        yield* sql`UPDATE ${sql(table)} SET payload_json = ${encodeJson(reordered) + "  "} WHERE record_id = ${record.recordId}`;
        expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [] });
      }),
    ),
  );
}

it.effect("denies an unlogged extra memory row and a missing canonical source", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* addMemory();
      const extra = source("target", "unlogged");
      yield* sql`INSERT INTO project_team_memory_source (record_id,project_id,status,revision,generation,updated_at,source_id,payload_json)
      VALUES (${extra.recordId},${extra.projectId},${extra.status},${extra.revision},${extra.generation},${extra.updatedAt},${extra.sourceId},${encodeJson(extra)})`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
      yield* sql`DELETE FROM project_team_memory_source WHERE record_id = 'unlogged'`;
      expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [observation()] });
      yield* sql`DELETE FROM project_team_memory_source WHERE record_id = 'source'`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
    }),
  ),
);

for (const [label, field, value] of [
  ["event ID", "eventId", "wrong-event"],
  ["outer owner", "projectId", "unrelated"],
  ["event type", "type", "project-work.task.created"],
  ["occurred-at", "occurredAt", "2026-09-01T00:00:00.000Z"],
  ["record owner", "record.projectId", "unrelated"],
  ["record ID", "record.recordId", "wrong-record"],
] as const) {
  it.effect(`denies canonical event ${label} mismatch`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* sql`UPDATE project_work_events SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
        WHERE project_id = 'target' AND event_type = 'project-work.foundation.recorded'
        AND json_extract(payload_json, '$.record.recordId') = 'source'`;
        expect(yield* hydrate(sql)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
      }),
    ),
  );
}

it.effect("denies malformed or excessive-field canonical event JSON", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* addMemory();
      const rows = yield* decodeEventRows(
        yield* sql`SELECT event_id AS eventId, payload_json AS payload FROM project_work_events WHERE project_id = 'target' ORDER BY sequence LIMIT 1`,
      );
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      yield* sql`UPDATE project_work_events SET payload_json = json_set(payload_json, '$.authorityComplete', 1) WHERE event_id = ${row.eventId}`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
      yield* sql`UPDATE project_work_events SET payload_json = '{' WHERE event_id = ${row.eventId}`;
      expect(yield* hydrate(sql)).toEqual({ status: "denied", reason: "corruption", selected: [] });
    }),
  ),
);

const traceReader = Effect.fn("fixture.traceReader")(function* (sql: SqlClient.SqlClient) {
  const reserved = yield* sql.reserve;
  const reads: Array<{ query: string; params: ReadonlyArray<unknown> }> = [];
  const connection: Connection = {
    ...reserved,
    execute(query, params, rowTransform) {
      reads.push({ query, params });
      return reserved.execute(query, params, rowTransform);
    },
  };
  const reader = yield* SqlClient.make({
    acquirer: Effect.succeed(connection),
    transactionAcquirer: Effect.succeed(connection),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  return { reader, reads };
});
const decodePlans = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ detail: Schema.String })),
);
const decodeEventRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ eventId: Schema.String, payload: Schema.String })),
);

it.effect("bounds individual canonical event bytes before fetching JSON, including non-ASCII", () =>
  withDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        const rows = yield* decodeEventRows(
          yield* sql`SELECT event_id AS eventId, payload_json AS payload FROM project_work_events ORDER BY sequence LIMIT 1`,
        );
        const row = rows[0];
        expect(row).toBeDefined();
        if (row === undefined) return;
        const { reader, reads } = yield* traceReader(sql);
        const exact = row.payload + " ".repeat(1_048_576 - Buffer.byteLength(row.payload));
        yield* reader`UPDATE project_work_events SET payload_json = ${exact} WHERE event_id = ${row.eventId}`;
        expect(yield* hydrate(reader)).toMatchObject({
          status: "accepted",
          selected: [observation()],
        });
        for (const oversized of [exact + " ", "é".repeat(524_289)]) {
          yield* reader`UPDATE project_work_events SET payload_json = ${oversized} WHERE event_id = ${row.eventId}`;
          reads.length = 0;
          expect(yield* hydrate(reader)).toEqual({
            status: "denied",
            reason: "incomplete-authority",
            selected: [],
          });
          expect(reads.some(({ query }) => query.includes("AS payload"))).toBe(false);
          expect(reads.some(({ query }) => query.includes("project_team_memory_source"))).toBe(
            false,
          );
        }
      }),
    ),
  ),
);

it.effect("bounds aggregate canonical event bytes before fetching JSON", () =>
  withDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* commit(Array.from({ length: 15 }, (_, i) => source("target", `event-source-${i}`)));
        const rows = yield* decodeEventRows(
          yield* sql`SELECT event_id AS eventId, payload_json AS payload FROM project_work_events ORDER BY sequence`,
        );
        const rest = rows
          .slice(16)
          .reduce((total, row) => total + Buffer.byteLength(row.payload), 0);
        for (const [index, row] of rows.slice(0, 16).entries()) {
          const desired = 1_048_576 - (index === 15 ? rest : 0);
          yield* sql`UPDATE project_work_events SET payload_json = ${row.payload + " ".repeat(desired - Buffer.byteLength(row.payload))} WHERE event_id = ${row.eventId}`;
        }
        const { reader, reads } = yield* traceReader(sql);
        expect(yield* hydrate(reader)).toMatchObject({
          status: "accepted",
          selected: [observation()],
        });
        const last = rows[15];
        expect(last).toBeDefined();
        if (last === undefined) return;
        yield* reader`UPDATE project_work_events SET payload_json = payload_json || ' ' WHERE event_id = ${last.eventId}`;
        reads.length = 0;
        expect(yield* hydrate(reader)).toEqual({
          status: "denied",
          reason: "incomplete-authority",
          selected: [],
        });
        expect(reads.some(({ query }) => query.includes("AS payload"))).toBe(false);
      }),
    ),
  ),
);

it.effect(
  "accepts 4096 complete foundation events and denies the 4097 sentinel including non-memory history",
  () =>
    withDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* setup;
          yield* addMemory();
          yield* commit([
            yield* decodeMissionFixture({
              kind: "mission",
              projectId: "target",
              recordId: "mission",
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              title: "History control",
              objective: "Bound all foundation kinds",
              requiredTaskIds: [],
            }),
          ]);
          // Replicate a real, typed non-memory event without thousands of redundant
          // repository commands or fabricated memory rows.
          yield* sql`WITH RECURSIVE n(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM n WHERE x < 4092)
      INSERT INTO project_work_events (event_id,project_id,event_type,occurred_at,command_id,payload_json)
      SELECT 'history-' || n.x, e.project_id,e.event_type,e.occurred_at,'history-command-' || n.x,
        json_set(e.payload_json, '$.eventId', 'history-' || n.x, '$.revision', n.x + 100)
      FROM n JOIN project_work_events e ON json_extract(e.payload_json, '$.record.kind') = 'mission'`;
          const { reader, reads } = yield* traceReader(sql);
          expect(yield* hydrate(reader)).toMatchObject({
            status: "accepted",
            selected: [observation()],
          });
          yield* reader`INSERT INTO project_work_events (event_id,project_id,event_type,occurred_at,command_id,payload_json)
      SELECT 'history-sentinel',project_id,event_type,occurred_at,'sentinel-command',json_set(payload_json, '$.eventId', 'history-sentinel')
      FROM project_work_events WHERE event_id = 'history-1'`;
          reads.length = 0;
          expect(yield* hydrate(reader)).toEqual({
            status: "denied",
            reason: "incomplete-authority",
            selected: [],
          });
          expect(reads.some(({ query }) => query.includes("AS payload"))).toBe(false);
          expect(reads.filter(({ query }) => query.includes("project_work_events"))).toHaveLength(
            1,
          );
        }),
      ),
    ),
);

it.effect("loads only indexed owner history; unrelated corrupt events are excluded", () =>
  withDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* setup;
        yield* addMemory();
        yield* addProject("unrelated");
        yield* addMemory(source("unrelated", "foreign-source"), [
          observation(source("unrelated", "foreign-source"), "foreign-hit"),
        ]);
        yield* sql`UPDATE project_work_events SET payload_json = '{' WHERE project_id = 'unrelated'`;
        const { reader, reads } = yield* traceReader(sql);
        expect(yield* hydrate(reader)).toMatchObject({
          status: "accepted",
          selected: [observation()],
        });
        const historyReads = reads.filter(({ query }) => query.includes("project_work_events"));
        expect(historyReads).toHaveLength(2);
        for (const read of historyReads) {
          expect(read.params).toContain("target");
          expect(read.params).not.toContain("unrelated");
          expect(read.query).toContain("event_type = 'project-work.foundation.recorded'");
          const plans = yield* decodePlans(
            yield* reader.unsafe("EXPLAIN QUERY PLAN " + read.query, read.params),
          );
          expect(
            plans.some(({ detail }) =>
              detail.includes(
                "SEARCH project_work_events USING INDEX idx_project_work_events_project_type_sequence (project_id=? AND event_type=?)",
              ),
            ),
          ).toBe(true);
          expect(plans.some(({ detail }) => detail.startsWith("SCAN project_work_events"))).toBe(
            false,
          );
        }
      }),
    ),
  ),
);

for (const [label, character] of [
  ["plain", "x"],
  ["quote", '"'],
  ["backslash", "\\"],
] as const) {
  it.effect(`hydrates legal maximum-width ${label} observation keys after typed persistence`, () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const o = observation(s, "hit", { observationKey: character.repeat(4_000) });
        yield* addMemory(s, [o]);
        expect(
          selectProjectMemoryHits({
            projectId: "target",
            hitIds: ["hit"],
            sources: [s],
            observations: [o],
            authorityComplete: true,
          }),
        ).toMatchObject({ status: "accepted", selected: [o] });
        expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [o] });
      }),
    ),
  );
}

it.effect("hydrates legal maximum-width control characters and maximum source versions", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* setup;
      const s = source("target", "\u0001".repeat(256), {
        sourceId: "a" + "\u0000".repeat(3_998) + "a",
        sourceRevision: Number.MAX_SAFE_INTEGER,
        generation: Number.MAX_SAFE_INTEGER,
      });
      const o = observation(s, "hit", {
        observationKey: "\u0000".repeat(4_000),
        extractionId: "max-extraction",
      });
      yield* addMemory(s, [o], "max-extraction");
      expect(
        selectProjectMemoryHits({
          projectId: "target",
          hitIds: ["hit"],
          sources: [s],
          observations: [o],
          authorityComplete: true,
        }),
      ).toMatchObject({ status: "accepted", selected: [o] });
      expect(
        yield* sql`SELECT length(unique_key) AS characters FROM project_team_memory_observation WHERE record_id = 'hit'`,
      ).toEqual([{ characters: 25_577 }]);
      expect(
        yield* sql`SELECT length(CAST(payload_json AS BLOB)) < 1048576 AS bounded FROM project_team_memory_source UNION ALL SELECT length(CAST(payload_json AS BLOB)) < 1048576 AS bounded FROM project_team_memory_observation`,
      ).toEqual([{ bounded: 1 }, { bounded: 1 }]);
      expect(yield* hydrate(sql)).toMatchObject({ status: "accepted", selected: [o] });
    }),
  ),
);

it.effect("refuses tampered or oversized unique tuples after accepting escaped keys", () =>
  withDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* setup;
        const s = source();
        const o = observation(s, "hit", { observationKey: '"'.repeat(4_000) });
        yield* addMemory(s, [o]);
        const actualKey = encodeJson([
          o.sourceId,
          o.sourceRevision,
          o.sourceGeneration,
          o.observationKey,
        ]);
        const tamperedKey = encodeJson([
          o.sourceId,
          o.sourceRevision,
          o.sourceGeneration,
          "wrong-key",
        ]);
        const { reader, reads } = yield* traceReader(sql);
        expect(yield* hydrate(reader)).toMatchObject({ status: "accepted", selected: [o] });
        yield* reader`UPDATE project_team_memory_observation SET unique_key = ${tamperedKey} WHERE record_id = 'hit'`;
        expect(yield* hydrate(reader)).toEqual({
          status: "denied",
          reason: "corruption",
          selected: [],
        });
        // The conservative maximum does not authorize arbitrary metadata at the bound.
        for (const size of [48_041, 48_042]) {
          yield* reader`UPDATE project_team_memory_observation SET unique_key = ${"x".repeat(size)} WHERE record_id = 'hit'`;
          reads.length = 0;
          expect(yield* hydrate(reader)).toEqual({
            status: "denied",
            reason: "corruption",
            selected: [],
          });
          if (size === 48_042)
            expect(
              reads.some(
                ({ query }) =>
                  query.includes("project_team_memory_observation") && query.includes("AS payload"),
              ),
            ).toBe(false);
        }
        yield* reader`UPDATE project_team_memory_observation SET unique_key = ${actualKey} WHERE record_id = 'hit'`;
        expect(yield* hydrate(reader)).toMatchObject({ status: "accepted", selected: [o] });
      }),
    ),
  ),
);
