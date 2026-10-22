import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runWorkflowFeatureMigrations } from "../persistence/WorkflowFeatureMigrations.ts";
import {
  buildProjectWorkBriefing,
  makeProjectWorkBriefingFromQuery,
} from "./ProjectWorkBriefing.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";

const projectId = ProjectId.make("bounded-query-project");
const taskId = ProjectWorkTaskId.make("selected-task");
const at = "2026-01-01T00:00:00.000Z";
const testLayer = (transformResultNames?: (key: string) => string) =>
  Layer.mergeAll(ProjectWorkQueryLive, ProjectWorkRepositoryLive).pipe(
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(
      NodeSqliteClient.layer({
        filename: ":memory:",
        ...(transformResultNames === undefined ? {} : { transformResultNames }),
      }),
    ),
  );
const seed = Effect.fn("ProjectWorkQueryTest.seed")(function* () {
  yield* runMigrations();
  yield* runWorkflowFeatureMigrations();
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Work",
      workspaceRoot: "/tmp/bounded-query",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const repository = yield* ProjectWorkRepository;
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("task-created"),
    title: "Selected task",
    createdAt: at,
  });
});

it.effect("hydrates only the latest 100 task comments at the SQL boundary", () => {
  let commentBodiesRead = 0;
  const layer = testLayer((key) => {
    if (key === "body") commentBodiesRead++;
    return key;
  });
  return Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<120)
      INSERT INTO t3_workflow_v2_work_comments(comment_id,project_id,task_id,body,created_at,revision)
      SELECT printf('comment-%03d',n),${projectId},${taskId},'Retained comment',${at},n FROM rows`;
    commentBodiesRead = 0;
    const query = yield* ProjectWorkQuery;
    const context = Option.getOrThrow(yield* query.getTaskContext(projectId, taskId));
    assert.equal(context.children.comments.length, 100);
    assert.equal(context.children.comments[0]?.commentId, "comment-120");
    assert.equal(context.children.comments.at(-1)?.commentId, "comment-021");
    assert.equal(commentBodiesRead, 100);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["none", "criteria", "blockers"] as const)(
  "briefing reports selected task constraints truthfully when child budget overflow is %s",
  (overflow) =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO t3_workflow_v2_work_criteria(criterion_id,project_id,task_id,description,required,status,satisfied_by_evidence_ids_json,revision,updated_at)
    VALUES('selected-criterion',${projectId},${taskId},'Pending selected constraint',1,'unsatisfied','[]',1,${at})`;
      yield* sql`INSERT INTO t3_workflow_v2_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
    VALUES('selected-blocker',${projectId},${taskId},'Old unresolved blocker','human','[]',1,1)`;
      if (overflow === "criteria") {
        yield* sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<1000)
      INSERT INTO t3_workflow_v2_work_criteria(criterion_id,project_id,task_id,description,required,status,satisfied_by_evidence_ids_json,revision,updated_at)
      SELECT 'unrelated-'||n,${projectId},'unrelated-task','Unrelated criterion',1,'satisfied','[]',n+1,'2026-02-01T00:00:00.000Z' FROM rows`;
      }
      if (overflow === "blockers") {
        yield* sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<1000)
      INSERT INTO t3_workflow_v2_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,resolved_at,revision)
      SELECT 'unrelated-'||n,${projectId},'unrelated-task','Resolved unrelated blocker','human','[]',0,${at},n+1 FROM rows`;
      }
      const query = yield* ProjectWorkQuery;
      const snapshot = yield* query.briefingSnapshot(projectId, 12);
      const briefing = buildProjectWorkBriefing(snapshot, {
        projectId,
        kind: "standard",
        generatedAt: at,
      });
      const fromQuery = yield* makeProjectWorkBriefingFromQuery(query).generate({
        projectId,
        kind: "standard",
        generatedAt: at,
      });
      assert.deepStrictEqual(fromQuery, briefing);
      if (overflow !== "none") {
        assert.include(briefing.omittedReasons, "constraints-bound");
        assert.include(briefing.text, "constraints incomplete");
        assert.notInclude(briefing.text, "required criterion");
      } else {
        assert.include(briefing.text, "1 required criterion pending");
        assert.include(briefing.text, "blocked by Old unresolved blocker");
        assert.notInclude(briefing.omittedReasons, "constraints-bound");
      }
    }).pipe(Effect.provide(testLayer())),
);

it.effect("derives task policy from complete constraints while bounding displayed children", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO t3_workflow_v2_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,revision)
    VALUES('old-blocker',${projectId},${taskId},'Retained unresolved blocker','human','[]',1,1)`;
    yield* sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<100)
    INSERT INTO t3_workflow_v2_work_blockers(blocker_id,project_id,task_id,reason,resolver,reference_ids_json,attention,resolved_at,revision)
    SELECT 'resolved-'||n,${projectId},${taskId},'Resolved blocker','human','[]',0,${at},n+1 FROM rows`;
    yield* sql`UPDATE t3_workflow_v2_work_tasks SET state='specified', blocker_id='old-blocker',
    specification_json=json_object('objective','Work','scopeIn','Work','scopeOut','Other','criterionIds',json('[]'),'revision',1,'protected',json('false'))
    WHERE project_id=${projectId} AND task_id=${taskId}`;
    const query = yield* ProjectWorkQuery;
    const context = Option.getOrThrow(yield* query.getTaskContext(projectId, taskId));
    assert.equal(context.children.blockers.length, 100);
    assert.isFalse(
      context.children.blockers.some((blocker) => blocker.blockerId === "old-blocker"),
    );
    assert.isFalse(context.policy.readiness.ready);
    assert.include(context.policy.readiness.reasons, "active-blocker");
  }).pipe(Effect.provide(testLayer())),
);

it.effect("foundation pages apply task and kind before the SQL page boundary", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    for (const [recordId, selected] of [
      ["a-member", true],
      ["b-foreign", false],
      ["c-member", true],
    ] as const) {
      const record = {
        recordId,
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        kind: "task-membership",
        status: "active",
        taskId: selected ? taskId : "other-task",
        executionKind: "human",
        deliverableKind: "research",
      };
      yield* sql`INSERT INTO t3_workflow_v2_team_records(record_id,project_id,kind,task_id,revision,payload_json) VALUES (${recordId},${projectId},${record.kind},${record.taskId},0,${JSON.stringify(record)})`;
    }
    const mission = {
      recordId: "a-mission",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      kind: "mission",
      status: "draft",
      title: "Other record",
      objective: "Other scope",
      requiredTaskIds: [],
    };
    yield* sql`INSERT INTO t3_workflow_v2_team_records(record_id,project_id,kind,task_id,revision,payload_json) VALUES (${mission.recordId},${projectId},${mission.kind},null,0,${JSON.stringify(mission)})`;
    const query = yield* ProjectWorkQuery;
    const pages = yield* Effect.forEach([0, 1], (offset) =>
      query.listFoundationRecords({ projectId, taskId, kind: "task-membership", limit: 1, offset }),
    );
    assert.deepStrictEqual(
      pages.flat().map((record) => record.recordId),
      ["a-member", "c-member"],
    );
    assert.deepStrictEqual(
      yield* query.listFoundationRecords({
        projectId,
        taskId,
        kind: "task-membership",
        limit: 1,
        offset: 2,
      }),
      [],
    );
  }).pipe(Effect.provide(testLayer())),
);
