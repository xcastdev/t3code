import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeSqlite from "node:sqlite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkComment,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import * as ContentGuard from "../ProjectWorkContentGuard.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../ProjectWorkRepository.ts";
import {
  PROJECT_TEAM_TABLES,
  PROJECT_WORK_CHECKPOINT_VERSION,
} from "../ProjectTeamsPersistence.ts";
import type { MemoryBackend } from "./MemoryBackend.ts";
import { makeProjectMemoryIndexReactor } from "./ProjectMemoryIndexReactor.ts";
import {
  makeProjectMemoryOutcome,
  readProjectMemoryCompletedDeletionInTransaction,
} from "./ProjectMemoryOutcome.ts";
import {
  makeProjectMemoryService,
  ProjectMemoryServiceError,
  type ProjectMemoryModelPorts,
} from "./ProjectMemoryService.ts";

const at = "2026-10-03T00:00:00.000Z";
const environmentId = "outcome-environment";
const attribution = {
  actor: { kind: "system", id: "outcome-fixture" },
  source: { kind: "system", id: "outcome-fixture" },
  recordedAt: at,
} as const;
const decodeComment = Schema.decodeUnknownEffect(ProjectWorkComment);
const services = Layer.mergeAll(ProjectWorkRepositoryLive, Authorization.layer).pipe(
  Layer.provideMerge(ContentGuard.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const database = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(services));

/** Actual migrated SQLite/repository/reactor; model and backend are prepared fakes.
 * These cases establish durable reflection semantics, never native runtime proof.
 */
const setup = Effect.fn("ProjectMemoryOutcome.test.setup")(function* (
  noFacts = false,
  liquid = false,
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const contentGuard = yield* ContentGuard.ProjectWorkContentGuard;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  const projectId = ProjectId.make("outcome-project");
  const taskId = ProjectWorkTaskId.make("outcome-task");
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Outcome','/fixture/outcome','[]',${at},${at})`;
  yield* repository.execute({
    type: "project-work.task.create",
    commandId: CommandId.make("outcome-task-create"),
    projectId,
    taskId,
    title: "Retained outcome",
    createdAt: at,
  });
  const comment = yield* decodeComment({
    commentId: "outcome-comment",
    projectId,
    taskId,
    body: "Exact source provenance persists through response loss.",
    revision: 0,
    createdAt: at,
    attribution,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    commandId: CommandId.make("outcome-comment-add"),
    projectId,
    comment,
    attribution,
    addedAt: at,
  });
  let extractCalls = 0;
  let embedCalls = 0;
  let indexCalls = 0;
  let deleteCalls = 0;
  const models: ProjectMemoryModelPorts = {
    extract: () =>
      Effect.sync(() => {
        extractCalls++;
        return noFacts
          ? []
          : [
              { key: "provenance", body: "Source provenance persists.", quote: "provenance" },
              { key: "retry", body: "Response loss preserves provenance.", quote: "response loss" },
            ];
      }),
    embed: ({ bodies }) =>
      Effect.sync(() => {
        embedCalls++;
        return bodies.map(() => Array.from({ length: 2048 }, () => 0.125));
      }),
  };
  const indexed = new Set<string>();
  const backend: MemoryBackend = {
    health: () =>
      Effect.succeed({
        engine: "mem0",
        engineVersion: "2.2.1",
        qdrantVersion: "1.19.1",
        embeddingDimensions: 2048,
      }),
    index: (_, manifest) =>
      Effect.sync(() => {
        indexCalls++;
        const ids = manifest.observations.map((entry) => entry.observationId);
        for (const id of ids) indexed.add(id);
        return { writtenObservationIds: ids };
      }),
    reconcile: (_, manifest) => {
      const missingObservationIds = manifest.observations
        .map((entry) => entry.observationId)
        .filter((id) => !indexed.has(id));
      return Effect.succeed({
        complete: missingObservationIds.length === 0,
        missingObservationIds,
        invalidObservationIds: [],
        unexpectedBackendIds: [],
      });
    },
    search: () => Effect.succeed({ candidates: [] }),
    deleteSource: () =>
      Effect.sync(() => {
        deleteCalls++;
        indexed.clear();
        return { cleanupComplete: true as const };
      }),
    deleteProject: () => Effect.succeed({ cleanupComplete: true }),
  };
  const dependencies = { sql, repository, contentGuard, authorization, environmentId };
  const service = makeProjectMemoryService({
    ...dependencies,
    models,
    ...(liquid ? { selectedExtractionModel: "liquid/lfm-2.5-2.6b:free" as const } : {}),
  });
  const source = yield* service.captureRetained(projectId, {
    kind: "comment",
    retainedId: comment.commentId,
  });
  const state = yield* readCurrentState(sql, projectId);
  const effect = state.foundationRecords!.find(
    (record) => record.kind === "effect" && record.effectKind === "memory-index",
  )!;
  const outcomes = makeProjectMemoryOutcome(dependencies);
  const pending = makeProjectMemoryIndexReactor({ ...dependencies, service, backend });
  const reactor = makeProjectMemoryIndexReactor({ ...dependencies, service, backend, outcomes });
  const counts = () => ({ extractCalls, embedCalls, indexCalls, deleteCalls });
  const snapshot = Effect.gen(function* () {
    return {
      state: yield* readCurrentState(sql, projectId),
      events: yield* sql`SELECT * FROM project_work_events ORDER BY sequence`,
      receipts: yield* sql`SELECT * FROM project_work_command_receipts ORDER BY command_id`,
      jobs: yield* sql`SELECT * FROM project_team_memory_job ORDER BY effect_id`,
      outcomes: yield* sql`SELECT * FROM project_team_memory_outcome ORDER BY effect_id`,
    };
  });
  return {
    ...dependencies,
    service,
    source,
    projectId,
    effectId: effect.recordId,
    outcomes,
    pending,
    reactor,
    counts,
    snapshot,
  };
});

for (const noFacts of [false, true])
  it.effect(
    `reflects ${noFacts ? "no-facts" : "the exact full manifest"} through the complete reactor`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup(noFacts);
          expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe("reflected");
          const work = yield* f.service.readWork(f.projectId, f.effectId);
          expect(work.effect.status).toBe("succeeded");
          expect(work.extraction?.status).toBe(noFacts ? "no-facts" : "indexed");
          expect(work.extraction?.completedObservationIds).toEqual(
            work.extraction?.expectedObservationIds,
          );
          const before = yield* f.snapshot;
          const calls = f.counts();
          expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe("reflected");
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts()).toEqual(calls);
        }),
      ),
  );

it.effect(
  "final verification observes the same transaction after write receipts and rolls back for exact retry",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        const before = yield* f.snapshot;
        let checked = false;
        const final = Effect.gen(function* () {
          expect(Option.isSome(yield* Effect.serviceOption(f.sql.transactionService))).toBe(true);
          expect((yield* f.service.readWork(f.projectId, f.effectId)).effect.status).toBe(
            "succeeded",
          );
          checked = true;
          return yield* new ProjectMemoryServiceError({ reason: "held final verification failed" });
        }).pipe(
          Effect.mapError(
            () => new ProjectMemoryServiceError({ reason: "held final verification failed" }),
          ),
        );
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(pending.receipt, final).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(checked).toBe(true);
        expect(yield* f.snapshot).toEqual(before);
        yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void);
        expect((yield* f.service.readWork(f.projectId, f.effectId)).effect.status).toBe(
          "succeeded",
        );
      }),
    ),
);

for (const table of [
  "project_team_effect",
  "project_team_memory_extraction",
  "project_team_memory_outcome",
  "project_work_events",
  "project_work_command_receipts",
] as const)
  it.effect(`detects an ignored ${table} write and rolls back before retry`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        const before = yield* f.snapshot;
        const operation =
          table === "project_team_effect" || table === "project_team_memory_extraction"
            ? "UPDATE"
            : "INSERT";
        yield* f.sql`CREATE TRIGGER outcome_ignore BEFORE ${f.sql.literal(operation)} ON ${f.sql(table)} BEGIN SELECT RAISE(IGNORE); END`;
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
        yield* f.sql`DROP TRIGGER outcome_ignore`;
        expect((yield* f.reactor.reflect(f.effectId)).status).toBe("reflected");
        expect(f.counts()).toEqual({
          extractCalls: 1,
          embedCalls: 1,
          indexCalls: 1,
          deleteCalls: 0,
        });
      }),
    ),
  );

for (const mutation of [
  "foreign-effect",
  "claim",
  "unsafe-counter",
  "source",
  "revision",
  "generation",
  "kind",
  "subset",
  "duplicate",
  "excess",
] as const)
  it.effect(`rejects a ${mutation} caller outcome without changing durable state`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        const before = yield* f.snapshot;
        const forged = {
          ...pending.receipt,
          ...(mutation === "foreign-effect" ? { effectId: "other-effect" } : {}),
          ...(mutation === "claim" ? { claimGeneration: pending.receipt.claimGeneration + 1 } : {}),
          ...(mutation === "unsafe-counter"
            ? { claimGeneration: Number.MAX_SAFE_INTEGER + 1 }
            : {}),
          ...(mutation === "source" ? { sourceId: "other-source" } : {}),
          ...(mutation === "revision"
            ? { sourceRevision: pending.receipt.sourceRevision + 1 }
            : {}),
          ...(mutation === "generation"
            ? { sourceGeneration: pending.receipt.sourceGeneration + 1 }
            : {}),
          ...(mutation === "kind"
            ? { kind: "delete-source-complete" as const, observationIds: [] }
            : {}),
          ...(mutation === "subset"
            ? { observationIds: pending.receipt.observationIds.slice(0, 1) }
            : {}),
          ...(mutation === "duplicate"
            ? {
                observationIds: [
                  pending.receipt.observationIds[0]!,
                  pending.receipt.observationIds[0]!,
                ],
              }
            : {}),
          ...(mutation === "excess" ? { projectId: "caller-authority" } : {}),
        };
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(forged, Effect.void).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
  );

for (const mutation of [
  "missing-manifest",
  "manifest-source",
  "manifest-hash",
  "physical-provenance",
  "physical-status",
  "physical-project",
  "retained-source",
] as const)
  it.effect(`rejects ${mutation} evidence after backend settlement`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        if (mutation === "missing-manifest") yield* f.sql`DELETE FROM project_team_memory_manifest`;
        if (mutation === "manifest-source" || mutation === "manifest-hash") {
          yield* f.sql`DROP TRIGGER project_team_memory_manifest_immutable`;
          if (mutation === "manifest-source")
            yield* f.sql`UPDATE project_team_memory_manifest SET project_id='foreign'`;
          else
            yield* f.sql`UPDATE project_team_memory_manifest SET manifest_json=json_set(manifest_json,'$.observations[0].payloadHash',${"0".repeat(64)})`;
        }
        if (mutation === "physical-provenance")
          yield* f.sql`UPDATE project_team_memory_observation SET payload_json=json_set(payload_json,'$.provenance.actor.id','forged')`;
        if (mutation === "physical-status")
          yield* f.sql`UPDATE project_team_memory_observation SET status='retracted'`;
        if (mutation === "physical-project")
          yield* f.sql`UPDATE project_team_memory_source SET project_id='foreign'`;
        if (mutation === "retained-source")
          yield* f.sql`UPDATE project_work_reducer_checkpoints
        SET state_json=json_set(state_json,'$.comments[0].body','Changed retained source') WHERE project_id=${f.projectId}`;
        const before = yield* f.snapshot;
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
  );

it.effect(
  "competing reflections and response-loss retries return the original durable success",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        yield* Effect.all(
          [
            f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void),
            f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void),
          ],
          { concurrency: 2 },
        );
        const before = yield* f.snapshot;
        const recreated = makeProjectMemoryOutcome(f);
        yield* recreated.commitVerifiedOutcome(pending.receipt, Effect.void);
        expect(yield* f.snapshot).toEqual(before);
        expect(before.outcomes).toHaveLength(1);
        expect(f.counts()).toEqual({
          extractCalls: 1,
          embedCalls: 1,
          indexCalls: 1,
          deleteCalls: 0,
        });
      }),
    ),
);

it.effect(
  "reflects a durably uncertain original claim only from its settled complete receipt",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        const work = yield* f.service.readWork(f.projectId, f.effectId);
        const state = yield* readCurrentState(f.sql, f.projectId);
        yield* f.repository.execute({
          type: "project-work.foundation.commit",
          commandId: CommandId.make("fixture-uncertain"),
          projectId: f.projectId,
          expectedRevision: state.revision,
          records: [{ ...work.effect, status: "uncertain", revision: work.effect.revision + 1 }],
          attribution,
          committedAt: at,
        });
        expect((yield* f.service.readWork(f.projectId, f.effectId)).effect.status).toBe(
          "uncertain",
        );
        yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void);
        expect((yield* f.service.readWork(f.projectId, f.effectId)).effect.status).toBe(
          "succeeded",
        );
        expect(f.counts()).toEqual({
          extractCalls: 1,
          embedCalls: 1,
          indexCalls: 1,
          deleteCalls: 0,
        });
      }),
    ),
);

for (const alreadyReflected of [false, true])
  it.effect(
    `rejects ${alreadyReflected ? "original success retry" : "settled index"} after source retraction`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* (alreadyReflected ? f.reactor : f.pending).consume(f.projectId, f.effectId);
          const job = yield* f.reactor.load(f.effectId);
          if (job?.receipt === undefined) return yield* Effect.die("fixture receipt missing");
          yield* f.service.retract(f.projectId, f.source.recordId);
          const before = yield* f.snapshot;
          expect(
            (yield* f.outcomes.commitVerifiedOutcome(job.receipt, Effect.void).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");
          expect(yield* f.snapshot).toEqual(before);
        }),
      ),
  );

for (const corruption of [
  "command-receipt",
  "event",
  "oversized-event",
  "current-effect",
  "physical-reflection",
] as const)
  it.effect(`an original success retry rejects a tampered ${corruption}`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.reactor.consume(f.projectId, f.effectId);
        const job = yield* f.reactor.load(f.effectId);
        if (job?.receipt === undefined) return yield* Effect.die("fixture receipt missing");
        if (corruption === "command-receipt")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE actor_id='project-memory-indexer'`;
        if (corruption === "event")
          yield* f.sql`DELETE FROM project_work_events WHERE command_id LIKE 'memory-reflection:%'`;
        if (corruption === "oversized-event")
          yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.outcome',${"x".repeat(262144)}) WHERE command_id LIKE 'memory-reflection:%'`;
        if (corruption === "current-effect")
          yield* f.sql`UPDATE project_team_effect SET payload_json=json_set(payload_json,'$.outcome','tampered') WHERE record_id=${f.effectId}`;
        if (corruption === "physical-reflection") {
          yield* f.sql`DROP TRIGGER project_team_memory_outcome_immutable`;
          yield* f.sql`UPDATE project_team_memory_outcome SET reflection_json=json_set(reflection_json,'$.projectRevision',1)`;
        }
        const before = yield* f.snapshot;
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(job.receipt, Effect.void).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
  );

for (const purge of [false, true])
  it.effect(
    `cleanup remains observable pending after reflection failure ${purge ? "after permanent purge" : "with suppressed source"}`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup();
          yield* f.reactor.consume(f.projectId, f.effectId);
          yield* f.service.retract(f.projectId, f.source.recordId);
          const state = yield* readCurrentState(f.sql, f.projectId);
          const cleanup = state.foundationRecords!.find(
            (record) => record.kind === "effect" && record.effectKind === "memory-delete",
          )!;
          if (purge) {
            for (const table of PROJECT_TEAM_TABLES)
              yield* f.sql`DELETE FROM ${f.sql(table)} WHERE project_id=${f.projectId}`;
            yield* f.sql`DELETE FROM project_work_events WHERE project_id=${f.projectId}`;
            yield* f.sql`DELETE FROM project_work_command_receipts WHERE project_id=${f.projectId}`;
            yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${f.projectId}`;
            yield* f.sql`DELETE FROM projection_projects WHERE project_id=${f.projectId}`;
          }
          yield* f.sql`CREATE TRIGGER cleanup_reflection_fail BEFORE INSERT ON project_team_memory_outcome BEGIN SELECT RAISE(ABORT,'cleanup-reflection-failure'); END`;
          expect(
            (yield* f.reactor.consume(f.projectId, cleanup.recordId).pipe(Effect.exit))._tag,
          ).toBe("Failure");
          const pending = yield* f.reactor.load(cleanup.recordId);
          expect(pending?.status).toBe("settled");
          expect(pending?.receipt?.kind).toBe("delete-source-complete");
          expect(
            yield* f.sql`SELECT * FROM project_team_memory_outcome WHERE effect_id=${cleanup.recordId}`,
          ).toHaveLength(0);
          yield* f.sql`DROP TRIGGER cleanup_reflection_fail`;
          const beforeSource =
            yield* f.sql`SELECT * FROM project_team_memory_source WHERE record_id=${f.source.recordId}`;
          expect((yield* f.reactor.consume(f.projectId, cleanup.recordId)).status).toBe(
            "reflected",
          );
          expect(
            yield* f.sql`SELECT * FROM project_team_memory_source WHERE record_id=${f.source.recordId}`,
          ).toEqual(beforeSource);
          if (purge) {
            expect(
              yield* f.sql`SELECT * FROM projection_projects WHERE project_id=${f.projectId}`,
            ).toHaveLength(0);
            expect(
              yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${f.projectId}`,
            ).toHaveLength(0);
          }
          const before = yield* f.snapshot;
          expect((yield* f.reactor.consume(f.projectId, cleanup.recordId)).status).toBe(
            "reflected",
          );
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts()).toEqual({
            extractCalls: 1,
            embedCalls: 1,
            indexCalls: 1,
            deleteCalls: 1,
          });
        }),
      ),
  );

for (const noFacts of [false, true])
  it.effect(`rejects ${noFacts ? "no-facts" : "index"} project revision overflow atomically`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup(noFacts);
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("fixture not settled");
        const state = yield* readCurrentState(f.sql, f.projectId);
        const revision = Number.MAX_SAFE_INTEGER - (noFacts ? 0 : 1);
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${canonicalProjectWorkPayload({ ...state, checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION, revision })}`;
        expect((yield* readCurrentState(f.sql, f.projectId)).revision).toBe(revision);
        const before = yield* f.snapshot;
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
  );

const purgeMemoryDomain = Effect.fn("outcome.test.purge")(function* (
  f: Effect.Success<ReturnType<typeof setup>>,
  retainedTable?: string,
) {
  yield* f.sql.withTransaction(
    Effect.gen(function* () {
      for (const table of [
        ...PROJECT_TEAM_TABLES,
        "project_work_events",
        "project_work_command_receipts",
        "project_work_reducer_checkpoints",
        "projection_projects",
      ])
        if (table !== retainedTable)
          yield* f.sql`DELETE FROM ${f.sql(table)} WHERE project_id=${f.projectId}`;
    }),
  );
});

const prepareCleanup = Effect.fn("outcome.test.cleanup")(function* (
  f: Effect.Success<ReturnType<typeof setup>>,
) {
  yield* f.reactor.consume(f.projectId, f.effectId);
  yield* f.service.retract(f.projectId, f.source.recordId);
  const state = yield* readCurrentState(f.sql, f.projectId);
  const effect = state.foundationRecords!.find(
    (record) => record.kind === "effect" && record.effectKind === "memory-delete",
  )!;
  return effect.recordId;
});

it.effect(
  "reads completed deletion proof without writes and rejects a missing original receipt",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const id = yield* prepareCleanup(f);
        expect((yield* f.reactor.consume(f.projectId, id)).status).toBe("reflected");
        const before = yield* f.snapshot;
        const calls = f.counts();
        const proof = yield* f.sql.withTransaction(
          readProjectMemoryCompletedDeletionInTransaction(f.sql, environmentId, id),
        );
        expect(proof.receipt).toMatchObject({
          kind: "delete-source-complete",
          sourceId: f.source.recordId,
        });
        expect(yield* f.snapshot).toEqual(before);
        expect(f.counts()).toEqual(calls);
        expect(
          (yield* readProjectMemoryCompletedDeletionInTransaction(f.sql, environmentId, id).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=(
      SELECT json_extract(reflection_json,'$.commandId') FROM project_team_memory_outcome WHERE effect_id=${id})`;
        const missing = yield* f.snapshot;
        expect(
          (yield* f.sql
            .withTransaction(
              readProjectMemoryCompletedDeletionInTransaction(f.sql, environmentId, id),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(missing);
        expect(f.counts()).toEqual(calls);
      }),
    ),
);

it.effect(
  "review regression: original successful domain cleanup stays recoverable after purge",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const id = yield* prepareCleanup(f);
        expect((yield* f.reactor.consume(f.projectId, id)).status).toBe("reflected");
        const original =
          yield* f.sql`SELECT * FROM project_team_memory_outcome WHERE effect_id=${id}`;
        yield* purgeMemoryDomain(f);
        const before = yield* f.snapshot;
        const recreated = makeProjectMemoryIndexReactor({
          ...f,
          backend: {
            health: () => Effect.die("unexpected backend health"),
            index: () => Effect.die("unexpected backend index"),
            reconcile: () => Effect.die("unexpected backend reconcile"),
            search: () => Effect.die("unexpected backend search"),
            deleteSource: () => Effect.die("unexpected backend delete"),
            deleteProject: () => Effect.die("unexpected backend project delete"),
          },
          outcomes: makeProjectMemoryOutcome(f),
        });
        for (let retry = 0; retry < 2; retry++)
          expect((yield* recreated.consume(f.projectId, id)).status).toBe("reflected");
        expect(yield* f.snapshot).toEqual(before);
        expect(
          yield* f.sql`SELECT * FROM project_team_memory_outcome WHERE effect_id=${id}`,
        ).toEqual(original);
      }),
    ),
);

it.effect(
  "review regression: final validation rejects an event with the wrong completion record",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection") return yield* Effect.die("unsettled fixture");
        const before = yield* f.snapshot;
        yield* f.sql`CREATE TRIGGER change_reflection_record AFTER INSERT ON project_work_events
    WHEN NEW.command_id LIKE 'memory-reflection:%' AND json_extract(NEW.payload_json,'$.record.kind')='memory-extraction'
    BEGIN
      UPDATE project_work_events SET payload_json=json_set(NEW.payload_json,'$.record',json((
        SELECT json_set(e.payload_json,'$.status','succeeded','$.revision',e.revision+1,
          '$.updatedAt',json_extract(NEW.payload_json,'$.occurredAt'),
          '$.outcome',(SELECT receipt_json FROM project_team_memory_job WHERE effect_id=e.record_id))
        FROM project_team_effect e WHERE e.project_id=NEW.project_id
          AND json_extract(e.payload_json,'$.effectKind')='memory-index'
          AND json_extract(e.payload_json,'$.targetId')=json_extract(NEW.payload_json,'$.record.sourceId')))) WHERE sequence=NEW.sequence;
    END`;
        const result = yield* f.outcomes
          .commitVerifiedOutcome(pending.receipt, Effect.void)
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
);

for (const projectState of ["current", "soft-deleted", "absent"] as const)
  for (const corruption of ["missing", "tampered"] as const)
    it.effect(
      `cleanup replay rejects ${corruption} original command receipt with ${projectState} project`,
      () =>
        database(
          Effect.gen(function* () {
            const f = yield* setup();
            const id = yield* prepareCleanup(f);
            yield* f.reactor.consume(f.projectId, id);
            const job = yield* f.reactor.load(id);
            if (job?.receipt === undefined) return yield* Effect.die("missing cleanup receipt");
            if (projectState === "soft-deleted")
              yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${f.projectId}`;
            if (projectState === "absent")
              yield* f.sql`DELETE FROM projection_projects WHERE project_id=${f.projectId}`;
            if (corruption === "missing")
              yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=(
        SELECT json_extract(reflection_json,'$.commandId') FROM project_team_memory_outcome WHERE effect_id=${id})`;
            else
              yield* f.sql`UPDATE project_work_command_receipts SET payload_fingerprint='tampered' WHERE command_id=(
        SELECT json_extract(reflection_json,'$.commandId') FROM project_team_memory_outcome WHERE effect_id=${id})`;
            const before = yield* f.snapshot;
            expect(
              (yield* makeProjectMemoryOutcome(f)
                .commitVerifiedOutcome(job.receipt, Effect.void)
                .pipe(Effect.exit))._tag,
            ).toBe("Failure");
            expect(yield* f.snapshot).toEqual(before);
            expect(f.counts().deleteCalls).toBe(1);
          }),
        ),
    );

for (const retainedTable of [
  "project_team_effect",
  "project_team_memory_source",
  "project_team_memory_observation",
  "project_work_events",
  "project_work_command_receipts",
  "project_work_reducer_checkpoints",
  "projection_projects",
])
  it.effect(`cleanup replay rejects partial purge retaining ${retainedTable}`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const id = yield* prepareCleanup(f);
        yield* f.reactor.consume(f.projectId, id);
        const job = yield* f.reactor.load(id);
        if (job?.receipt === undefined) return yield* Effect.die("missing cleanup receipt");
        yield* purgeMemoryDomain(f, retainedTable);
        const before = yield* f.snapshot;
        expect(
          (yield* makeProjectMemoryOutcome(f)
            .commitVerifiedOutcome(job.receipt, Effect.void)
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
        expect(f.counts().deleteCalls).toBe(1);
      }),
    ),
  );

for (const foreign of [false, true])
  it.effect(
    `cleanup replay rejects revived ${foreign ? "foreign" : "original"} physical source after purge`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup();
          const id = yield* prepareCleanup(f);
          yield* f.reactor.consume(f.projectId, id);
          const job = yield* f.reactor.load(id);
          if (job?.receipt === undefined) return yield* Effect.die("missing cleanup receipt");
          yield* purgeMemoryDomain(f);
          const source = {
            ...f.source,
            projectId: foreign ? ProjectId.make("foreign-project") : f.projectId,
          };
          yield* f.sql`INSERT INTO project_team_memory_source(record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES(${source.recordId},${source.projectId},${source.status},${source.revision},${source.generation},${source.updatedAt},${canonicalProjectWorkPayload(source)})`;
          const before = yield* f.snapshot;
          expect(
            (yield* makeProjectMemoryOutcome(f)
              .commitVerifiedOutcome(job.receipt, Effect.void)
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts().deleteCalls).toBe(1);
        }),
      ),
  );

for (const noFacts of [false, true]) {
  it.effect(
    `${noFacts ? "no-facts" : "index"} original success has no cleanup fallback after purge`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup(noFacts);
          yield* f.reactor.consume(f.projectId, f.effectId);
          const job = yield* f.reactor.load(f.effectId);
          if (job?.receipt === undefined) return yield* Effect.die("missing index receipt");
          yield* purgeMemoryDomain(f);
          const before = yield* f.snapshot;
          expect(
            (yield* makeProjectMemoryOutcome(f)
              .commitVerifiedOutcome(job.receipt, Effect.void)
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts().deleteCalls).toBe(0);
        }),
      ),
  );
  it.effect(
    `${noFacts ? "no-facts" : "index"} rejects exact extraction substituted for its effect event and retries atomically`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup(noFacts);
          const pending = yield* f.pending.consume(f.projectId, f.effectId);
          if (pending.status !== "pending-reflection")
            return yield* Effect.die("unsettled fixture");
          const before = yield* f.snapshot;
          yield* f.sql`CREATE TRIGGER substitute_reflection_effect AFTER INSERT ON project_work_events
      WHEN NEW.command_id LIKE 'memory-reflection:%' AND json_extract(NEW.payload_json,'$.record.kind')='effect'
      BEGIN UPDATE project_work_events SET payload_json=json_set(NEW.payload_json,'$.record',json((
        SELECT json_set(x.payload_json,'$.status',${f.sql.literal(noFacts ? "'no-facts'" : "'indexed'")},'$.revision',x.revision+${f.sql.literal(noFacts ? "0" : "1")},
          '$.updatedAt',CASE WHEN ${f.sql.literal(noFacts ? "1" : "0")}=1 THEN json_extract(x.payload_json,'$.updatedAt') ELSE json_extract(NEW.payload_json,'$.occurredAt') END,
          '$.completedObservationIds',json(CASE WHEN ${f.sql.literal(noFacts ? "1" : "0")}=1 THEN '[]' ELSE json_extract(x.payload_json,'$.expectedObservationIds') END))
        FROM project_team_memory_extraction x WHERE x.project_id=NEW.project_id))) WHERE sequence=NEW.sequence; END`;
          expect(
            (yield* f.outcomes
              .commitVerifiedOutcome(pending.receipt, Effect.void)
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
          expect(yield* f.snapshot).toEqual(before);
          yield* f.sql`DROP TRIGGER substitute_reflection_effect`;
          expect((yield* f.reactor.reflect(f.effectId)).status).toBe("reflected");
          expect(f.counts()).toEqual({
            extractCalls: 1,
            embedCalls: noFacts ? 0 : 1,
            indexCalls: noFacts ? 0 : 1,
            deleteCalls: 0,
          });
        }),
      ),
  );
}

for (const corruption of ["physical-type", "physical-time", "payload-time"] as const)
  it.effect(`rejects ${corruption} reflection event metadata atomically`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection") return yield* Effect.die("unsettled fixture");
        const before = yield* f.snapshot;
        if (corruption === "physical-type")
          yield* f.sql`CREATE TRIGGER corrupt_reflection_metadata AFTER INSERT ON project_work_events
      WHEN NEW.command_id LIKE 'memory-reflection:%' BEGIN UPDATE project_work_events SET event_type='project-work.task.created' WHERE sequence=NEW.sequence; END`;
        if (corruption === "physical-time")
          yield* f.sql`CREATE TRIGGER corrupt_reflection_metadata AFTER INSERT ON project_work_events
      WHEN NEW.command_id LIKE 'memory-reflection:%' BEGIN UPDATE project_work_events SET occurred_at='2026-10-03T00:00:00.000Z' WHERE sequence=NEW.sequence; END`;
        if (corruption === "payload-time")
          yield* f.sql`CREATE TRIGGER corrupt_reflection_metadata AFTER INSERT ON project_work_events
      WHEN NEW.command_id LIKE 'memory-reflection:%' BEGIN UPDATE project_work_events SET payload_json=json_set(payload_json,'$.occurredAt','2026-10-03T00:00:00.000Z') WHERE sequence=NEW.sequence; END`;
        expect(
          (yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
      }),
    ),
  );

for (const noFacts of [false, true])
  it.effect(
    `${noFacts ? "no-facts" : "index"} reflection authoritative events rebuild the exact completed records and retry`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup(noFacts);
          expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe("reflected");
          const completed = yield* readCurrentState(f.sql, f.projectId);
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${f.projectId}`;
          const rebuilt = yield* readCurrentState(f.sql, f.projectId);
          expect(rebuilt.revision).toBe(completed.revision);
          expect(rebuilt.foundationRecords).toEqual(completed.foundationRecords);
          const before = yield* f.snapshot;
          expect((yield* f.reactor.consume(f.projectId, f.effectId)).status).toBe("reflected");
          expect(yield* f.snapshot).toEqual(before);
        }),
      ),
  );

for (const projectState of ["soft-deleted", "absent"] as const)
  it.effect(
    `cleanup replay verifies intact original domain receipts with ${projectState} project`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup();
          const id = yield* prepareCleanup(f);
          yield* f.reactor.consume(f.projectId, id);
          if (projectState === "soft-deleted")
            yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${f.projectId}`;
          else yield* f.sql`DELETE FROM projection_projects WHERE project_id=${f.projectId}`;
          const before = yield* f.snapshot;
          expect((yield* f.reactor.consume(f.projectId, id)).status).toBe("reflected");
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts().deleteCalls).toBe(1);
        }),
      ),
  );

for (const corruption of [
  "journal-missing",
  "journal-receipt",
  "outcome-receipt",
  "reflection-events",
] as const)
  it.effect(`completed cleanup after purge rejects ${corruption} retained proof`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup();
        const id = yield* prepareCleanup(f);
        yield* f.reactor.consume(f.projectId, id);
        const job = yield* f.reactor.load(id);
        if (job?.receipt === undefined) return yield* Effect.die("missing cleanup receipt");
        yield* purgeMemoryDomain(f);
        if (corruption === "journal-missing")
          yield* f.sql`DELETE FROM project_team_memory_job WHERE effect_id=${id}`;
        if (corruption === "journal-receipt") {
          yield* f.sql`DROP TRIGGER project_team_memory_job_transition`;
          yield* f.sql`UPDATE project_team_memory_job SET receipt_json=json_set(receipt_json,'$.sourceGeneration',99) WHERE effect_id=${id}`;
        }
        if (corruption === "outcome-receipt" || corruption === "reflection-events") {
          yield* f.sql`DROP TRIGGER project_team_memory_outcome_immutable`;
          if (corruption === "outcome-receipt")
            yield* f.sql`UPDATE project_team_memory_outcome SET receipt_json=json_set(receipt_json,'$.sourceGeneration',99) WHERE effect_id=${id}`;
          else
            yield* f.sql`UPDATE project_team_memory_outcome SET reflection_json=json_set(reflection_json,'$.eventIds',json('[]')) WHERE effect_id=${id}`;
        }
        const before = yield* f.snapshot;
        expect(
          (yield* makeProjectMemoryOutcome(f)
            .commitVerifiedOutcome(job.receipt, Effect.void)
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* f.snapshot).toEqual(before);
        expect(f.counts().deleteCalls).toBe(1);
      }),
    ),
  );

for (const noFacts of [false, true])
  it.effect(
    `Liquid ${noFacts ? "no-facts" : "index"} reflection retains completed model and immutable capture on replay`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* setup(noFacts, true);
          const original =
            yield* f.sql`SELECT input_json FROM project_team_memory_job WHERE effect_id=${f.effectId}`;
          expect(
            yield* f.sql`SELECT json_extract(input_json,'$.extraction.extractionModel') AS model FROM project_team_memory_job WHERE effect_id=${f.effectId}`,
          ).toEqual([{ model: "inclusionai/ling-3.1-flash:free" }]);
          const pending = yield* f.pending.consume(f.projectId, f.effectId);
          if (pending.status !== "pending-reflection")
            return yield* Effect.die("Unsettled Liquid fixture");
          const result = yield* f.outcomes
            .commitVerifiedOutcome(pending.receipt, Effect.void)
            .pipe(Effect.result);
          expect(result).toMatchObject({ _tag: "Success" });
          const work = yield* f.service.readWork(f.projectId, f.effectId);
          expect(work.extraction).toMatchObject({
            extractionModel: "liquid/lfm-2.5-2.6b:free",
            status: noFacts ? "no-facts" : "indexed",
          });
          expect(work.effect.status).toBe("succeeded");
          const before = yield* f.snapshot;
          const calls = f.counts();
          yield* makeProjectMemoryOutcome(f).commitVerifiedOutcome(pending.receipt, Effect.void);
          expect(yield* f.snapshot).toEqual(before);
          expect(f.counts()).toEqual(calls);
          expect(
            yield* f.sql`SELECT input_json FROM project_team_memory_job WHERE effect_id=${f.effectId}`,
          ).toEqual(original);
        }),
      ),
  );

for (const noFacts of [false, true])
  for (const model of ["liquid/lfm-2.5-2.6b", "arbitrary/model:free", "inclusionai/ling-3.1-flash"])
    it.effect(
      `Liquid ${noFacts ? "no-facts" : "index"} reflection rejects substituted model ${model}`,
      () =>
        database(
          Effect.gen(function* () {
            const f = yield* setup(noFacts, true);
            const pending = yield* f.pending.consume(f.projectId, f.effectId);
            if (pending.status !== "pending-reflection")
              return yield* Effect.die("Unsettled Liquid fixture");
            const work = yield* f.service.readWork(f.projectId, f.effectId);
            if (work.extraction === undefined)
              return yield* Effect.die("Missing Liquid extraction");
            // Corrupt both read surfaces so the model comparison, rather than a
            // physical/projection mismatch, must reject the unsupported identity.
            yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,
        '$.foundationRecords[' || (SELECT key FROM json_each(state_json,'$.foundationRecords')
          WHERE json_extract(value,'$.recordId')=${work.extraction.recordId}) || '].extractionModel',${model})
        WHERE project_id=${f.projectId}`;
            yield* f.sql`UPDATE project_team_memory_extraction SET payload_json=json_set(payload_json,'$.extractionModel',${model})
        WHERE record_id=${work.extraction.recordId}`;
            const before = yield* f.snapshot;
            const result = yield* f.outcomes
              .commitVerifiedOutcome(pending.receipt, Effect.void)
              .pipe(Effect.result);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                reason: "Memory reflection extraction tuple or completed manifest changed",
              },
            });
            expect(yield* f.snapshot).toEqual(before);
          }),
        ),
    );

for (const noFacts of [false, true])
  for (const liquid of [false, true])
    for (const reflected of [false, true])
      it.effect(
        `${noFacts ? "no-facts" : "indexed"} rejects supported-route substitution ${liquid ? "Liquid to CommandCode" : "CommandCode to Liquid"} ${reflected ? "on replay" : "before first reflection"}`,
        () =>
          database(
            Effect.gen(function* () {
              const f = yield* setup(noFacts, liquid);
              const pending = yield* f.pending.consume(f.projectId, f.effectId);
              if (pending.status !== "pending-reflection")
                return yield* Effect.die("Unsettled substitution fixture");
              if (reflected) yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void);
              const work = yield* f.service.readWork(f.projectId, f.effectId);
              if (work.extraction === undefined)
                return yield* Effect.die("Missing performed extraction");
              const original = yield* f.snapshot;
              const calls = f.counts();
              const substitute = liquid
                ? "inclusionai/ling-3.1-flash:free"
                : "liquid/lfm-2.5-2.6b:free";
              yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,
                '$.foundationRecords[' || (SELECT key FROM json_each(state_json,'$.foundationRecords')
                  WHERE json_extract(value,'$.recordId')=${work.extraction.recordId}) || '].extractionModel',${substitute})
                WHERE project_id=${f.projectId}`;
              yield* f.sql`UPDATE project_team_memory_extraction
                SET payload_json=json_set(payload_json,'$.extractionModel',${substitute})
                WHERE record_id=${work.extraction.recordId}`;
              const before = yield* f.snapshot;
              expect(before.jobs).toEqual(original.jobs);
              expect(before.events).toEqual(original.events);
              const result = yield* f.outcomes
                .commitVerifiedOutcome(pending.receipt, Effect.void)
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
              expect(yield* f.snapshot).toEqual(before);
              expect(f.counts()).toEqual(calls);
            }),
          ),
      );

it.effect("completion lookup uses exact indexes with 32768 historical 4 KiB events", () =>
  database(
    Effect.gen(function* () {
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const lookups: Array<{
        database: NodeSqlite.DatabaseSync;
        statement: NodeSqlite.StatementSync;
        query: string;
      }> = [];
      const spy = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
            this: NodeSqlite.DatabaseSync,
            query: string,
          ) {
            const statement = prepare.call(this, query);
            if (
              (query.includes("e.event_id AS eventId") && query.includes("e.occurred_at AS at")) ||
              (query.includes("FROM project_work_command_receipts") &&
                /created_at\s*=/u.test(query))
            )
              lookups.push({ database: this, statement, query });
            return statement;
          }),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      );
      const f = yield* setup(true, true);
      const pending = yield* f.pending.consume(f.projectId, f.effectId);
      if (pending.status !== "pending-reflection")
        return yield* Effect.die("Unsettled lookup fixture");
      // The archive precedes the checkpoint cursor. This isolates completion lookup
      // work from the separate cost of rebuilding the reducer from historical events.
      yield* f.sql`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<32768)
    INSERT INTO project_work_events(sequence,event_id,project_id,event_type,occurred_at,command_id,payload_json)
    SELECT -n,'lookup-history-' || n,${f.projectId},'project-work.foundation.recorded',${at},
      'lookup-history-command-' || n,json_object('record',json_object('recordId','archive-' || n,'revision',1,
        'body',replace(hex(zeroblob(2048)),'0','x'))) FROM history`;
      expect(
        yield* f.sql`SELECT COUNT(*) AS count FROM project_work_events WHERE sequence<0`,
      ).toEqual([{ count: 32768 }]);
      const calls = f.counts();
      yield* f.outcomes.commitVerifiedOutcome(pending.receipt, Effect.void);
      yield* makeProjectMemoryOutcome(f).commitVerifiedOutcome(pending.receipt, Effect.void);
      expect(f.counts()).toEqual(calls);
      expect(lookups.length).toBeGreaterThan(0);
      const eventLookups = lookups.filter((lookup) =>
        lookup.query.includes("FROM project_work_events e"),
      );
      const receiptLookups = lookups.filter((lookup) =>
        lookup.query.includes("FROM project_work_command_receipts"),
      );
      expect(eventLookups.length).toBeGreaterThan(0);
      for (const lookup of eventLookups) {
        const plan = prepare
          .call(lookup.database, "EXPLAIN QUERY PLAN " + lookup.statement.expandedSQL)
          .all();
        const searches = plan
          .map((row) => String(row.detail))
          .filter((detail) => detail.startsWith("SEARCH e ") || detail.startsWith("SCAN e "));
        expect(searches).toHaveLength(1);
        expect(searches[0]).toContain("SEARCH e ");
        expect(searches[0]).toContain("event_id=?");
      }
      expect(receiptLookups.length).toBeGreaterThan(0);
      for (const lookup of receiptLookups) {
        const plan = prepare
          .call(lookup.database, "EXPLAIN QUERY PLAN " + lookup.statement.expandedSQL)
          .all();
        expect(
          plan.some((row) => String(row.detail).includes("(project_id=? AND created_at=?)")),
        ).toBe(true);
        const program = prepare
          .call(lookup.database, "EXPLAIN " + lookup.statement.expandedSQL)
          .all();
        expect(program.some((row) => row.opcode === "Integer" && row.p1 === 257)).toBe(true);
      }
      expect(spy).toHaveBeenCalled();
    }),
  ).pipe(Effect.scoped),
);

it.effect(
  "completion lookup denies an overflowing receipt timestamp without a history fallback",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* setup(true, true);
        const pending = yield* f.pending.consume(f.projectId, f.effectId);
        if (pending.status !== "pending-reflection")
          return yield* Effect.die("Unsettled collision fixture");
        const work = yield* f.service.readWork(f.projectId, f.effectId);
        if (work.extraction === undefined) return yield* Effect.die("Missing completed extraction");
        yield* f.sql`WITH RECURSIVE candidates(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM candidates WHERE n<257)
      INSERT INTO project_work_command_receipts(project_id,command_id,payload_fingerprint,
        actor_kind,actor_id,source_kind,source_id,event_ids_json,created_at,result_json)
      SELECT ${f.projectId},'receipt-collision-' || n,'unrelated','system','unrelated','system','unrelated',
        '[]',${work.extraction.updatedAt},'{}' FROM candidates`;
        const before = yield* f.snapshot;
        const calls = f.counts();
        const result = yield* f.outcomes
          .commitVerifiedOutcome(pending.receipt, Effect.void)
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "Memory extraction completion receipt candidates exceed bound" },
        });
        expect(yield* f.snapshot).toEqual(before);
        expect(f.counts()).toEqual(calls);
      }),
    ).pipe(Effect.scoped),
);
