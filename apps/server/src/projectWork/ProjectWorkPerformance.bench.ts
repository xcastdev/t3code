// @ts-expect-error -- benchmark-only runtime dependency supplied by vp test bench
import { afterAll, beforeAll, bench, describe } from "vitest";
import { CommandId, ProjectId, ProjectWorkCommentId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkBriefing, ProjectWorkBriefingLive } from "./ProjectWorkBriefing.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkSearch, ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-performance-representative");
const taskCount = 2_000;
const knowledgeCount = 8_000;
const eventCount = taskCount + knowledgeCount;
const benchmarkAttribution = {
  actor: { kind: "system" as const, id: "performance-benchmark" },
  source: { kind: "system" as const, id: "performance-benchmark" },
  recordedAt: at,
};

const projectServices = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkProjectionLive,
  ProjectWorkQueryLive,
  ProjectWorkSearchLive,
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const services = ProjectWorkBriefingLive.pipe(Layer.provideMerge(projectServices));
const runtime = ManagedRuntime.make(services);
let writeSequence = 0;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const runSearch = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const search = yield* ProjectWorkSearch;
      yield* search.search({ projectId, query: "lease fence", limit: 100 });
    }),
  );

const runDetailedBriefing = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const briefing = yield* ProjectWorkBriefing;
      yield* briefing.generate({ projectId, kind: "detailed", generatedAt: at });
    }),
  );

const runOrdinaryWrite = () => {
  const sequence = writeSequence++;
  return runtime.runPromise(
    Effect.gen(function* () {
      const repository = yield* ProjectWorkRepository;
      yield* repository.execute({
        type: "project-work.comment.add",
        commandId: CommandId.make(`scale-write-command-${sequence}`),
        projectId,
        comment: {
          commentId: ProjectWorkCommentId.make(`scale-write-comment-${sequence}`),
          projectId,
          taskId: ProjectWorkTaskId.make(`scale-task-${sequence % taskCount}`),
          body: `Representative non-create mutation ${sequence}`,
          createdAt: at,
          revision: 0,
        },
        addedAt: at,
        attribution: benchmarkAttribution,
      });
    }),
  );
};

const recordWarmP95 = async (
  label: string,
  targetMs: number,
  operation: () => void | Promise<void>,
) => {
  const warmups = 5;
  const samples = 50;
  for (let index = 0; index < warmups; index += 1) await operation();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const median = durations[Math.ceil(durations.length * 0.5) - 1] ?? Number.POSITIVE_INFINITY;
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  const max = durations.at(-1) ?? Number.POSITIVE_INFINITY;
  await runtime.runPromise(
    Effect.logInfo("project-work benchmark sample", {
      operation: label,
      medianMs: Number(median.toFixed(2)),
      warmP95Ms: Number(p95.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
      warmups,
      samples,
      targetMs,
      taskCount,
      knowledgeCount,
      initialEventCount: eventCount,
    }),
  );
  if (p95 > targetMs)
    throw new Error(`${label} warm p95 ${p95.toFixed(2)}ms exceeded ${targetMs}ms`);
};

const seedRepresentativeProject = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* ProjectWorkProjection;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let index = 0; index < taskCount; index += 1) {
            const taskId = `scale-task-${index}`;
            const revision = index + 1;
            const payload = encodeUnknownJson({
              eventId: `scale-task-event-${index}`,
              projectId,
              revision,
              occurredAt: at,
              type: "project-work.task.created",
              task: {
                taskId,
                projectId,
                title: `Scale task ${index} lease fence`,
                summary: "Representative durable project work task.",
                state: "draft",
                watchers: [],
                revision: 0,
                specRevision: 0,
                createdAt: at,
                updatedAt: at,
              },
            });
            yield* sql`INSERT INTO project_work_events
              (event_id, project_id, event_type, occurred_at, command_id, payload_json)
              VALUES (${`scale-task-event-${index}`}, ${projectId},
                ${"project-work.task.created"}, ${at}, ${`scale-task-command-${index}`}, ${payload})`;
          }
          for (let index = 0; index < knowledgeCount; index += 1) {
            const revision = taskCount + index + 1;
            const knowledgeId = `scale-knowledge-${index}`;
            const sourceId = `scale-task-${index % taskCount}`;
            const attribution = {
              actor: { kind: "system", id: "performance-fixture" },
              source: { kind: "system", id: "performance-fixture" },
              recordedAt: at,
            };
            const payload = encodeUnknownJson({
              eventId: `scale-knowledge-event-${index}`,
              projectId,
              revision,
              occurredAt: at,
              type: "project-work.knowledge.promoted",
              promotedAt: at,
              attribution,
              knowledge: {
                knowledgeId,
                projectId,
                title: `Scale knowledge ${index}`,
                body: "lease fence and durable project work search fixture",
                sourceKind: "task",
                sourceId,
                revision,
                createdAt: at,
                updatedAt: at,
                attribution,
              },
            });
            yield* sql`INSERT INTO project_work_events
              (event_id, project_id, event_type, occurred_at, command_id, payload_json)
              VALUES (${`scale-knowledge-event-${index}`}, ${projectId},
                ${"project-work.knowledge.promoted"}, ${at},
                ${`scale-knowledge-command-${index}`}, ${payload})`;
          }
        }),
      );
      yield* projection.rebuild(projectId);
      const counts = yield* Effect.all({
        events: sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id = ${projectId}`,
        tasks: sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_tasks WHERE project_id = ${projectId}`,
        knowledge: sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_knowledge WHERE project_id = ${projectId}`,
        search: sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_search_fts WHERE project_id = ${projectId}`,
        checkpoints: sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_reducer_checkpoints WHERE project_id = ${projectId}`,
      });
      const actual = {
        events: Number(counts.events[0]?.count ?? -1),
        tasks: Number(counts.tasks[0]?.count ?? -1),
        knowledge: Number(counts.knowledge[0]?.count ?? -1),
        search: Number(counts.search[0]?.count ?? -1),
        checkpoints: Number(counts.checkpoints[0]?.count ?? -1),
      };
      // Each event also produces one searchable activity row.
      const expected = {
        events: eventCount,
        tasks: taskCount,
        knowledge: knowledgeCount,
        search: eventCount * 2,
        checkpoints: 1,
      };
      if (
        actual.events !== expected.events ||
        actual.tasks !== expected.tasks ||
        actual.knowledge !== expected.knowledge ||
        actual.search !== expected.search ||
        actual.checkpoints !== expected.checkpoints
      )
        throw new Error(
          `Representative fixture count mismatch: events ${actual.events}/${expected.events}, tasks ${actual.tasks}/${expected.tasks}, knowledge ${actual.knowledge}/${expected.knowledge}, search ${actual.search}/${expected.search}, checkpoints ${actual.checkpoints}/${expected.checkpoints}`,
        );
      yield* Effect.logInfo("project-work benchmark fixture counts", actual);
    }),
  );

beforeAll(async () => {
  await runtime.runPromise(runMigrations());
  await seedRepresentativeProject();
  await recordWarmP95("search", 100, runSearch);
  await recordWarmP95("detailed briefing including snapshot load", 50, runDetailedBriefing);
  await recordWarmP95("ordinary non-create repository mutation", 100, runOrdinaryWrite);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("ProjectWork representative production repository scale", () => {
  const options = { warmupIterations: 5, warmupTime: 0, iterations: 50, time: 0 };
  bench("search p95 target <=100ms", runSearch, options);
  bench(
    "detailed briefing including snapshot load p95 target <=50ms",
    runDetailedBriefing,
    options,
  );
  bench("ordinary non-create repository mutation p95 target <=100ms", runOrdinaryWrite, options);
});
