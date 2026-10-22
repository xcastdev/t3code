import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkKnowledgeId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkSearch, ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";
import { ProjectWorkStream, ProjectWorkStreamLive } from "./ProjectWorkStream.ts";
import { buildProjectWorkBriefing } from "./ProjectWorkBriefing.ts";
import { buildProjectWorkJsonExport } from "./ProjectWorkExport.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("work-project");
const otherProjectId = ProjectId.make("other-project");
const taskId = ProjectWorkTaskId.make("task-1");
const human = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const, id: "client" },
  recordedAt: at,
};
const create = {
  type: "project-work.task.create" as const,
  projectId,
  taskId,
  commandId: CommandId.make("create-1"),
  title: "Durable search task",
  createdAt: at,
  attribution: human,
};
const base = ProjectStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkQueryLive,
  ProjectWorkProjectionLive,
  ProjectWorkSearchLive,
  ProjectWorkStreamLive,
).pipe(Layer.provideMerge(base));
const seed = Effect.fn("ProjectWorkRepositoryTest.seed")(function* (id = projectId) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make(`create-${id}`),
    aggregateKind: "project",
    aggregateId: id,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: id,
      title: "Work",
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
});

it.effect(
  "commits receipts, events, reducer checkpoint and projection; retries preserve the original result",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const repo = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* repo.execute(create);
      assert.equal(first.revision, 1);
      const retry = yield* repo.execute(create);
      assert.equal(retry.duplicate, true);
      assert.deepStrictEqual(retry.writeResult, first.writeResult);
      const changed = yield* Effect.result(repo.execute({ ...create, title: "Changed" }));
      assert.equal(changed._tag, "Failure");
      const stale = yield* Effect.result(
        repo.execute({
          ...create,
          taskId: ProjectWorkTaskId.make("task-2"),
          commandId: CommandId.make("stale"),
          expectedRevision: 0,
        }),
      );
      assert.equal(stale._tag, "Failure");
      assert.equal((yield* query.listTasks({ projectId })).length, 1);
      assert.equal((yield* repo.replay(projectId)).length, 1);
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_work_command_receipts`)[0]?.count,
        1,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'project_work_%' OR name LIKE 'project_team_%'`,
        [],
      );
      yield* sql`UPDATE t3_workflow_v2_work_reducer_checkpoints SET state_json='broken' WHERE project_id=${projectId}`;
      const recovery = yield* repo.execute({
        ...create,
        taskId: ProjectWorkTaskId.make("task-2"),
        commandId: CommandId.make("create-2"),
      });
      assert.equal(recovery.state.tasks.length, 2);
      const projection = yield* ProjectWorkProjection;
      yield* projection.rebuild(projectId);
      assert.equal((yield* query.listTasks({ projectId })).length, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect("isolates projects, bounds pages/search/replay and denies deleted projects", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seed(otherProjectId);
    const repo = yield* ProjectWorkRepository;
    const query = yield* ProjectWorkQuery;
    const search = yield* ProjectWorkSearch;
    const stream = yield* ProjectWorkStream;
    yield* repo.execute(create);
    yield* repo.execute({
      ...create,
      commandId: CommandId.make("create-2"),
      taskId: ProjectWorkTaskId.make("task-2"),
      title: "Second durable task",
    });
    assert.equal((yield* query.listTasks({ projectId, limit: 1 })).length, 1);
    assert.equal((yield* query.listTasks({ projectId, limit: 1, offset: 1 }))[0]?.taskId, "task-2");
    assert.equal(Option.isNone(yield* query.getTask(otherProjectId, taskId)), true);
    assert.equal((yield* search.search({ projectId, query: "durable", limit: 1 })).hasMore, true);
    assert.equal((yield* search.search({ projectId: otherProjectId, query: "durable" })).total, 0);
    assert.equal(
      (yield* stream.readReplay({ projectId, afterCursor: 999 })).resync,
      "cursor-ahead",
    );
    assert.equal((yield* stream.readReplay({ projectId: otherProjectId })).deltas.length, 0);
    const other = yield* repo.execute({
      ...create,
      projectId: otherProjectId,
      taskId: ProjectWorkTaskId.make("other-task"),
    });
    assert.equal(other.revision, 1);
    assert.notEqual(other.events[0]?.eventId, (yield* repo.replay(projectId))[0]?.eventId);
    assert.equal((yield* query.listTasks({ projectId: otherProjectId })).length, 1);
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 2,
      eventId: EventId.make("delete-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.deleted",
      payload: { projectId, deletedAt: at },
    });
    assert.equal(
      (yield* Effect.result(repo.execute({ ...create, commandId: CommandId.make("deleted") })))
        ._tag,
      "Failure",
    );
    assert.equal((yield* Effect.result(query.listTasks({ projectId })))._tag, "Failure");
    assert.equal(
      (yield* Effect.result(search.search({ projectId, query: "durable" })))._tag,
      "Failure",
    );
    assert.equal((yield* Effect.result(stream.readReplay({ projectId })))._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("rolls back an interrupted authorization transaction and retries without a receipt", () =>
  Effect.gen(function* () {
    yield* seed();
    const repo = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    const entered = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    const fiber = yield* repo
      .executeAuthorized(create, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(hold);
          return create;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert.equal((yield* repo.replay(projectId)).length, 0);
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_work_command_receipts`)[0]?.count,
      0,
    );
    assert.equal((yield* Effect.result(sql.withTransaction(repo.execute(create))))._tag, "Failure");
    assert.equal((yield* repo.replay(projectId)).length, 0);
    assert.equal((yield* repo.execute(create)).revision, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("retains knowledge in search, briefing and bounded redacted export", () =>
  Effect.gen(function* () {
    yield* seed();
    const repo = yield* ProjectWorkRepository;
    yield* repo.execute(create);
    yield* repo.execute({
      type: "project-work.knowledge.promote",
      projectId,
      commandId: CommandId.make("knowledge"),
      promotedAt: at,
      attribution: human,
      knowledge: {
        knowledgeId: ProjectWorkKnowledgeId.make("knowledge"),
        projectId,
        title: "Retained knowledge",
        body: "Search architecture constraint",
        sourceKind: "manual",
        sourceId: "maintainer",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
    });
    const query = yield* ProjectWorkQuery;
    const search = yield* ProjectWorkSearch;
    assert.equal(
      (yield* search.search({ projectId, query: "architecture" })).items[0]?.recordKind,
      "knowledge",
    );
    const snapshot = yield* query.briefingSnapshot(projectId, 10);
    const briefing = buildProjectWorkBriefing(snapshot, {
      projectId,
      kind: "standard",
      generatedAt: at,
    });
    assert.equal(JSON.stringify(briefing).includes("Retained knowledge"), true);
    const exported = yield* query.exportSnapshot(projectId, true);
    const json = buildProjectWorkJsonExport(exported.snapshot, {
      environmentId: "environment-1",
      exportedAt: at,
      ...(exported.history === undefined ? {} : { history: exported.history }),
    });
    assert.equal(json.knowledge.length, 1);
    assert.equal(json.history?.length, 2);
  }).pipe(Effect.provide(layer)),
);
