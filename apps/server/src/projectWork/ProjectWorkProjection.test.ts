import {
  EventId,
  ProjectId,
  CommandId,
  ProjectWorkCommentId,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkSearch, ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";

import {
  applyProjectWorkProjectionEvent,
  emptyProjectWorkProjectionState,
  type ProjectWorkProjectionEvent,
} from "./ProjectWorkProjection.ts";

const projectId = ProjectId.make("project-1");
const taskId = ProjectWorkTaskId.make("task-1");
const at = "2026-01-01T00:00:00.000Z";
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const event = (eventId: string, revision: number, extra: Record<string, unknown>) =>
  ({
    eventId: EventId.make(eventId),
    projectId,
    revision,
    occurredAt: at,
    ...extra,
  }) as unknown as ProjectWorkProjectionEvent;

describe("ProjectWorkProjection", () => {
  it("keeps stable activity and idempotent history while applying lifecycle records", () => {
    let state = emptyProjectWorkProjectionState(projectId);
    const task = {
      taskId,
      projectId,
      title: "Task",
      state: "draft" as const,
      watchers: [],
      revision: 0,
      specRevision: 0,
      createdAt: at,
      updatedAt: at,
    };
    const created = event("event-1", 1, { type: "project-work.task.created", task });
    state = applyProjectWorkProjectionEvent(state, created);
    state = applyProjectWorkProjectionEvent(state, created);
    expect(state.tasks).toHaveLength(1);
    expect(state.activities.map((activity) => activity.activityId)).toEqual(["event-1"]);
    expect(state.history).toHaveLength(1);

    state = applyProjectWorkProjectionEvent(
      state,
      event("knowledge-1", 2, {
        type: "project-work.knowledge.promoted",
        knowledge: {
          knowledgeId: ProjectWorkKnowledgeId.make("knowledge-1"),
          projectId,
          title: "Known",
          body: "Durable",
          sourceKind: "task",
          sourceId: String(taskId),
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        promotedAt: at,
      }),
    );
    state = applyProjectWorkProjectionEvent(
      state,
      event("decision-1", 3, {
        type: "project-work.decision.proposed",
        decision: {
          decisionId: ProjectWorkDecisionId.make("decision-1"),
          projectId,
          title: "Choose",
          body: "Option A",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        proposedAt: at,
      }),
    );
    state = applyProjectWorkProjectionEvent(
      state,
      event("decision-accept", 4, {
        type: "project-work.decision.accepted",
        decisionId: ProjectWorkDecisionId.make("decision-1"),
        acceptedAt: at,
      }),
    );
    expect(state.knowledge[0]?.body).toBe("Durable");
    expect(state.decisions[0]?.state).toBe("accepted");

    state = applyProjectWorkProjectionEvent(
      state,
      event("comment-1", 5, {
        type: "project-work.comment.added",
        comment: {
          commentId: ProjectWorkCommentId.make("comment-1"),
          projectId,
          taskId,
          body: "A note",
          createdAt: at,
          revision: 0,
        },
        addedAt: at,
      }),
    );
    expect(state.comments).toHaveLength(1);
    expect(state.activities).toHaveLength(5);
  });

  it("expires a fenced attempt without discarding captured checkpoints", () => {
    let state = emptyProjectWorkProjectionState(projectId);
    state = applyProjectWorkProjectionEvent(
      state,
      event("task", 1, {
        type: "project-work.task.created",
        task: {
          taskId,
          projectId,
          title: "Task",
          state: "draft" as const,
          watchers: [],
          revision: 0,
          specRevision: 0,
          createdAt: at,
          updatedAt: at,
        },
      }),
    );
    const attempt = {
      attemptId: "attempt-1",
      taskId,
      state: "running" as const,
      leaseToken: "token",
      leasedUntil: "2026-01-01T01:00:00.000Z",
      checkpointIds: [],
      revision: 0,
    };
    state = applyProjectWorkProjectionEvent(
      state,
      event("claim", 2, { type: "project-work.task.claimed", taskId, attempt }),
    );
    state = applyProjectWorkProjectionEvent(
      state,
      event("cp", 3, {
        type: "project-work.attempt.checkpointed",
        checkpoint: {
          checkpointId: "cp-1",
          projectId,
          taskId,
          attemptId: "attempt-1",
          capturedAt: at,
          revision: 1,
        },
      }),
    );
    state = applyProjectWorkProjectionEvent(
      state,
      event("expire", 4, {
        type: "project-work.attempt.expired",
        taskId,
        attemptId: "attempt-1",
        reason: "Lease expired",
        expiredAt: "2026-01-01T02:00:00.000Z",
      }),
    );
    expect(state.attempts[0]?.state).toBe("expired");
    expect(state.attempts[0]?.checkpointIds).toEqual(["cp-1"]);
    expect(state.tasks[0]?.failureKind).toBe("lease-expired");
  });
});

const sqlLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

sqlLayer("ProjectWorkProjection SQL", (it) => {
  it.effect("rebuilds damaged rows from the repository log without changing that log", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const projection = yield* ProjectWorkProjection;
      const query = yield* ProjectWorkQuery;
      const search = yield* ProjectWorkSearch;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("projection-create"),
        projectId,
        taskId,
        title: "SQL task",
        createdAt: at,
      });
      const eventsBefore = yield* repository.replay(String(projectId));
      const logBefore = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_id AS eventId, project_id AS projectId,
          event_type AS eventType, occurred_at AS occurredAt, command_id AS commandId,
          payload_json AS payloadJson
        FROM project_work_events WHERE project_id = ${projectId} ORDER BY sequence ASC
      `;
      const task = yield* query.getTask(String(projectId), taskId);
      expect(Option.isSome(task)).toBe(true);
      // Damage only the normalized projection. The repository event log is
      // intentionally outside this cleanup and remains the rebuild authority.
      yield* sql`DELETE FROM project_work_tasks WHERE project_id = ${projectId}`;
      expect(Option.isNone(yield* query.getTask(String(projectId), taskId))).toBe(true);
      const rebuilt = yield* projection.rebuild(String(projectId));
      expect(rebuilt).toBeUndefined();
      expect(Option.isSome(yield* query.getTask(String(projectId), taskId))).toBe(true);
      expect(yield* repository.replay(String(projectId))).toEqual(eventsBefore);
      const logAfter = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_id AS eventId, project_id AS projectId,
          event_type AS eventType, occurred_at AS occurredAt, command_id AS commandId,
          payload_json AS payloadJson
        FROM project_work_events WHERE project_id = ${projectId} ORDER BY sequence ASC
      `;
      expect(logAfter).toEqual(logBefore);
      const cursor = yield* sql<{
        lastAppliedSequence: number;
        rebuildGeneration: number;
      }>`SELECT last_applied_sequence AS lastAppliedSequence, rebuild_generation AS rebuildGeneration FROM project_work_projection_state WHERE projector = ${"project-work:" + projectId}`;
      expect(Number(cursor[0]?.lastAppliedSequence)).toBe(1);
      expect(Number(cursor[0]?.rebuildGeneration)).toBe(1);
      const checkpoints = yield* sql<{
        lastSequence: number;
        stateJson: string;
      }>`SELECT last_sequence AS lastSequence, state_json AS stateJson FROM project_work_reducer_checkpoints WHERE project_id = ${projectId}`;
      expect(Number(checkpoints[0]?.lastSequence)).toBe(1);
      expect(decodeUnknownJson(String(checkpoints[0]?.stateJson))).toMatchObject({
        projectId,
        revision: 1,
        tasks: [{ taskId }],
      });
      const nextTaskId = ProjectWorkTaskId.make("task-after-rebuild-checkpoint");
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("projection-create-after-rebuild"),
        projectId,
        taskId: nextTaskId,
        title: "Task after rebuild",
        createdAt: at,
      });
      expect(Option.isSome(yield* query.getTask(String(projectId), nextTaskId))).toBe(true);
      const incrementalSnapshot = yield* query.snapshot(String(projectId));
      const incrementalSearchRows = yield* sql<Record<string, unknown>>`
        SELECT record_kind AS recordKind, record_id AS recordId, title, body,
          provenance_json AS provenanceJson, revision
        FROM project_work_search_fts
        WHERE project_id = ${projectId}
        ORDER BY record_kind, record_id
      `;
      const incrementalSearch = yield* search.search({
        projectId,
        query: "task",
        includeActivity: true,
        limit: 100,
      });
      const incrementalCheckpoint = yield* sql<Record<string, unknown>>`
        SELECT last_sequence AS lastSequence, state_json AS stateJson
        FROM project_work_reducer_checkpoints WHERE project_id = ${projectId}
      `;
      yield* projection.rebuild(String(projectId));
      expect(yield* query.snapshot(String(projectId))).toEqual(incrementalSnapshot);
      expect(
        yield* search.search({ projectId, query: "task", includeActivity: true, limit: 100 }),
      ).toEqual(incrementalSearch);
      expect(
        yield* sql<Record<string, unknown>>`
          SELECT record_kind AS recordKind, record_id AS recordId, title, body,
            provenance_json AS provenanceJson, revision
          FROM project_work_search_fts
          WHERE project_id = ${projectId}
          ORDER BY record_kind, record_id
        `,
      ).toEqual(incrementalSearchRows);
      expect(
        yield* sql<Record<string, unknown>>`
          SELECT last_sequence AS lastSequence, state_json AS stateJson
          FROM project_work_reducer_checkpoints WHERE project_id = ${projectId}
        `,
      ).toEqual(incrementalCheckpoint);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.mergeAll(ProjectWorkProjectionLive, ProjectWorkQueryLive, ProjectWorkSearchLive),
        ),
      ),
    ),
  );

  it.effect("rejects an event whose stored aggregate metadata is inconsistent", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const projection = yield* ProjectWorkProjection;
      const sql = yield* SqlClient.SqlClient;
      const metadataProjectId = ProjectId.make("project-projection-metadata");
      const metadataTaskId = ProjectWorkTaskId.make("task-projection-metadata");
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("projection-metadata-create"),
        projectId: metadataProjectId,
        taskId: metadataTaskId,
        title: "Metadata task",
        createdAt: at,
      });
      yield* sql`
        UPDATE project_work_events SET event_type = ${"project-work.task.tampered"}
        WHERE project_id = ${metadataProjectId}
      `;
      const result = yield* Effect.result(projection.rebuild(String(metadataProjectId)));
      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkProjectionLive, ProjectWorkQueryLive),
        ),
      ),
    ),
  );
});
