import {
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkAttemptId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  ProjectWorkCommentId,
  ProjectWorkRelationshipId,
  CommandId,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkSearch, ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";

const projectId = ProjectId.make("project-repository");
const taskId = ProjectWorkTaskId.make("task-repository-append");
const at = "2026-01-01T00:00:00.000Z";

const layer = it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())));

layer("ProjectWorkRepository", (it) => {
  it.effect(
    "persists server-owned criterion revisions through checkpoints, FTS, and rebuilds",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ProjectWorkRepository;
        const query = yield* ProjectWorkQuery;
        const projection = yield* ProjectWorkProjection;
        const search = yield* ProjectWorkSearch;
        const sql = yield* SqlClient.SqlClient;
        const criterionProjectId = ProjectId.make("criterion-revision-repository");
        const criterionTaskId = ProjectWorkTaskId.make("criterion-revision-task");
        const criterionId = ProjectWorkCriterionId.make("criterion-revision-record");

        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("criterion-revision-create"),
          projectId: criterionProjectId,
          taskId: criterionTaskId,
          title: "Criterion revision task",
          createdAt: at,
        });
        for (const [index, suppliedRevision, description] of [
          [0, 4, "Initial representative criterion"],
          [1, 1, "Lower caller revision searchable"],
          [2, 99, "Higher caller revision searchable"],
        ] as const)
          yield* repository.execute({
            type: "project-work.criterion.upsert",
            commandId: CommandId.make(`criterion-revision-upsert-${index}`),
            projectId: criterionProjectId,
            taskId: criterionTaskId,
            criterion: {
              criterionId,
              taskId: criterionTaskId,
              description,
              required: index !== 2,
              status: index === 1 ? "satisfied" : "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: suppliedRevision,
              updatedAt: "1999-01-01T00:00:00.000Z",
            },
            updatedAt: `2026-01-01T00:00:0${index + 1}.000Z`,
          });

        const before = yield* query.snapshot(String(criterionProjectId));
        expect(before.criteria).toEqual([
          expect.objectContaining({
            criterionId,
            description: "Higher caller revision searchable",
            required: false,
            status: "unsatisfied",
            revision: 6,
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        ]);
        const checkpoint = yield* sql<{ readonly stateJson: string }>`
          SELECT state_json AS stateJson FROM project_work_reducer_checkpoints
          WHERE project_id = ${criterionProjectId}
        `;
        const checkpointState = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              criteria: Schema.Array(
                Schema.Struct({ revision: Schema.Number, description: Schema.String }),
              ),
            }),
          ),
        )(checkpoint[0]!.stateJson);
        expect(checkpointState.criteria).toEqual([
          expect.objectContaining({
            revision: 6,
            description: "Higher caller revision searchable",
          }),
        ]);
        const found = yield* search.search({
          projectId: String(criterionProjectId),
          query: "Higher caller revision searchable",
          recordKinds: ["criterion"],
        });
        expect(found.items).toEqual([
          expect.objectContaining({ recordId: criterionId, revision: 6 }),
        ]);

        yield* projection.rebuild(String(criterionProjectId));
        expect(yield* query.snapshot(String(criterionProjectId))).toEqual(before);
        expect(
          yield* search.search({
            projectId: String(criterionProjectId),
            query: "Higher caller revision searchable",
            recordKinds: ["criterion"],
          }),
        ).toEqual(found);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProjectWorkRepositoryLive,
            ProjectWorkQueryLive,
            ProjectWorkProjectionLive,
            ProjectWorkSearchLive,
          ),
        ),
      ),
  );

  it.effect("appends events and only exposes committed normalized rows", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("repo-create"),
        projectId,
        taskId,
        title: "Durable task",
        createdAt: at,
      });
      const row = yield* query.getTask(String(projectId), taskId);
      expect(Option.isSome(row)).toBe(true);
      const events = yield* repository.replay(String(projectId));
      expect(events.map((event) => event.type)).toEqual(["project-work.task.created"]);
      const duplicate = yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("repo-create"),
        projectId,
        taskId,
        title: "Durable task",
        createdAt: at,
      });
      expect(duplicate.events.map((event) => event.type)).toEqual(["project-work.task.created"]);
      const raw = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id = ${projectId}`;
      expect(Number(raw[0]?.count)).toBe(1);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("deduplicates a renewed MCP source before any approval hook runs", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const attributed = {
        type: "project-work.task.create" as const,
        commandId: CommandId.make("repo-renewed-mcp"),
        projectId,
        taskId: ProjectWorkTaskId.make("repo-renewed-task"),
        title: "Renewed MCP task",
        createdAt: at,
        attribution: {
          actor: { kind: "agent" as const, id: "agent:mcp:codex:thread-1" },
          source: {
            kind: "mcp" as const,
            id: "mcp:codex:thread-1",
            uri: "mcp://provider/codex/thread-1?session=first",
          },
          recordedAt: at,
        },
      };
      const first = yield* repository.execute(attributed);
      let authorizationCalls = 0;
      const duplicate = yield* repository.executeAuthorized(
        {
          ...attributed,
          attribution: {
            ...attributed.attribution,
            source: {
              ...attributed.attribution.source,
              uri: "mcp://provider/codex/thread-1?session=renewed",
            },
          },
        },
        () => {
          authorizationCalls += 1;
          return Effect.succeed(attributed);
        },
      );
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId),
      );
      expect(authorizationCalls).toBe(0);
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("removes unlinked relationships from fresh query and rebuild", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const relationProjectId = ProjectId.make("project-repository-relationship");
      const fromTaskId = ProjectWorkTaskId.make("relationship-from");
      const toTaskId = ProjectWorkTaskId.make("relationship-to");
      for (const [commandId, taskId, title] of [
        ["relationship-create-from", fromTaskId, "From"],
        ["relationship-create-to", toTaskId, "To"],
      ] as const)
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make(commandId),
          projectId: relationProjectId,
          taskId,
          title,
          createdAt: at,
        });
      const relationshipId = ProjectWorkRelationshipId.make("relationship-1");
      yield* repository.execute({
        type: "project-work.relationship.link",
        commandId: CommandId.make("relationship-link"),
        projectId: relationProjectId,
        relationship: {
          relationshipId,
          projectId: relationProjectId,
          fromTaskId,
          toTaskId,
          kind: "relates-to",
          revision: 0,
          createdAt: at,
        },
        linkedAt: at,
      });
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(1);
      yield* repository.execute({
        type: "project-work.relationship.unlink",
        commandId: CommandId.make("relationship-unlink"),
        projectId: relationProjectId,
        relationshipId,
        unlinkedAt: at,
      });
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(0);
      yield* projection.rebuild(String(relationProjectId));
      expect(
        yield* query.listRelationships({
          projectId: String(relationProjectId),
        }),
      ).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );

  it.effect("rolls back the event append when projection persistence fails", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const sql = yield* SqlClient.SqlClient;
      const failedProjectId = ProjectId.make("project-repository-rollback");
      const failedTaskId = ProjectWorkTaskId.make("task-repository-rollback");
      yield* sql`
        CREATE TRIGGER project_work_test_reject BEFORE INSERT ON project_work_tasks
        WHEN NEW.title = 'Abort'
        BEGIN SELECT RAISE(ABORT, 'projection failure'); END
      `;
      const result = yield* Effect.result(
        repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("rollback-create"),
          projectId: failedProjectId,
          taskId: failedTaskId,
          title: "Abort",
          createdAt: at,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(Option.isNone(yield* query.getTask(String(failedProjectId), failedTaskId))).toBe(true);
      expect(yield* repository.replay(String(failedProjectId))).toHaveLength(0);
      yield* sql`DROP TRIGGER project_work_test_reject`;
    }).pipe(Effect.provide(Layer.merge(ProjectWorkRepositoryLive, ProjectWorkQueryLive))),
  );

  it.effect("fences worker lifecycle writes and rebuilds from the authoritative log", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const projectId = ProjectId.make("project-repository-life");
      const taskId = ProjectWorkTaskId.make("task-repository-life");
      const worker: ProjectWorkAttribution = {
        actor: { kind: "agent", id: "agent-1" },
        source: { kind: "provider", id: "provider-1" },
        recordedAt: at,
      };
      const human = {
        actor: { kind: "human", id: "human-1" },
        source: { kind: "web", id: "web-1" },
        recordedAt: at,
      } satisfies ProjectWorkAttribution;
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("life-create"),
        projectId,
        taskId,
        title: "Lifecycle",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("life-criterion"),
        projectId,
        taskId,
        criterion: {
          criterionId: ProjectWorkCriterionId.make("life-criterion"),
          taskId,
          description: "Done",
          required: true,
          status: "satisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
        updatedAt: at,
      });
      yield* repository.execute({
        type: "project-work.task.specify",
        commandId: CommandId.make("life-specify"),
        projectId,
        taskId,
        specification: {
          objective: "Ship",
          scopeIn: "Feature",
          scopeOut: "Other",
          criterionIds: [ProjectWorkCriterionId.make("life-criterion")],
          revision: 1,
          protected: false,
        },
        updatedAt: at,
      });
      yield* repository.execute({
        type: "project-work.task.ready",
        commandId: CommandId.make("life-ready"),
        projectId,
        taskId,
        updatedAt: at,
      });
      const attemptId = ProjectWorkAttemptId.make("life-attempt-z");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim"),
        projectId,
        taskId,
        attemptId,
        leaseToken: "token-1",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail"),
        projectId,
        taskId,
        attemptId,
        leaseToken: "token-1",
        failureKind: "recoverable",
        reason: "Transient",
        failedAt: at,
        attribution: worker,
      });
      const resolved = yield* repository.execute({
        type: "project-work.task.resolve-failure",
        commandId: CommandId.make("life-resolve"),
        projectId,
        taskId,
        reason: "Retry",
        evidenceIds: [],
        resolvedAt: at,
        attribution: human,
      });
      expect(resolved.state.tasks[0]?.failureKind).toBeUndefined();
      const stale = yield* Effect.result(
        repository.execute({
          type: "project-work.task.fail",
          commandId: CommandId.make("life-stale"),
          projectId,
          taskId,
          attemptId,
          leaseToken: "token-1",
          failureKind: "recoverable",
          reason: "Stale",
          failedAt: "2026-01-01T00:30:00.000Z",
          attribution: worker,
        }),
      );
      expect(stale._tag).toBe("Failure");
      const attempts = yield* query.listAttempts({ projectId });
      const failedAttempt = attempts.find((attempt) => attempt.attemptId === attemptId);
      expect(failedAttempt?.state).toBe("failed");
      expect(failedAttempt?.failureReason).toBe("Transient");
      expect(failedAttempt?.failureResolutionReason).toBe("Retry");
      expect(failedAttempt?.failureResolutionAttribution?.actor.kind).toBe("human");
      const secondAttemptId = ProjectWorkAttemptId.make("life-attempt-a");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim-second"),
        projectId,
        taskId,
        attemptId: secondAttemptId,
        leaseToken: "token-2",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail-second"),
        projectId,
        taskId,
        attemptId: secondAttemptId,
        leaseToken: "token-2",
        failureKind: "recoverable",
        reason: "Transient again",
        failedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.resolve-failure",
        commandId: CommandId.make("life-resolve-second"),
        projectId,
        taskId,
        reason: "Retry again",
        evidenceIds: [],
        resolvedAt: at,
        attribution: human,
      });
      const thirdAttemptId = ProjectWorkAttemptId.make("life-attempt-0");
      yield* repository.execute({
        type: "project-work.task.claim",
        commandId: CommandId.make("life-claim-third"),
        projectId,
        taskId,
        attemptId: thirdAttemptId,
        leaseToken: "token-3",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
        attribution: worker,
      });
      yield* repository.execute({
        type: "project-work.task.fail",
        commandId: CommandId.make("life-fail-third"),
        projectId,
        taskId,
        attemptId: thirdAttemptId,
        leaseToken: "token-3",
        failureKind: "recoverable",
        reason: "Latest transient failure",
        failedAt: at,
        attribution: worker,
      });
      const canonicalAttemptIds = () =>
        query
          .listAttempts({ projectId, taskId, canonical: true, trusted: true })
          .pipe(Effect.map((entries) => entries.map((entry) => entry.attemptId)));
      expect(yield* canonicalAttemptIds()).toEqual([attemptId, secondAttemptId, thirdAttemptId]);
      expect(
        (yield* query.listAttempts({ projectId, taskId })).map((entry) => entry.attemptId),
      ).toEqual([thirdAttemptId, secondAttemptId, attemptId]);
      const context = yield* query.getTaskContext(String(projectId), taskId);
      expect(Option.getOrThrow(context).policy.actions.reclaim.available).toBe(true);
      yield* query.getActiveAttempt(String(projectId), taskId);
      const rebuilt = yield* projection.rebuild(String(projectId));
      expect(rebuilt).toBeUndefined();
      expect(yield* canonicalAttemptIds()).toEqual([attemptId, secondAttemptId, thirdAttemptId]);
      const rebuiltContext = yield* query.getTaskContext(String(projectId), taskId);
      expect(Option.getOrThrow(rebuiltContext).policy.actions.reclaim.available).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );

  it.effect("persists deferred knowledge, decisions, comments, and attention", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const sql = yield* SqlClient.SqlClient;
      const deferredProjectId = ProjectId.make("project-repository-deferred");
      const deferredTaskId = ProjectWorkTaskId.make("task-repository-deferred");
      const attribution: ProjectWorkAttribution = {
        actor: { kind: "human", id: "human-deferred" },
        source: { kind: "web", id: "web-deferred" },
        recordedAt: at,
      };
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("deferred-create"),
        projectId: deferredProjectId,
        taskId: deferredTaskId,
        title: "Deferred records",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.knowledge.promote",
        commandId: CommandId.make("deferred-knowledge"),
        projectId: deferredProjectId,
        knowledge: {
          knowledgeId: ProjectWorkKnowledgeId.make("deferred-knowledge"),
          projectId: deferredProjectId,
          title: "Known fact",
          body: "Keep this after source removal.",
          sourceKind: "task",
          sourceId: deferredTaskId,
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        promotedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.propose",
        commandId: CommandId.make("deferred-decision-propose"),
        projectId: deferredProjectId,
        decision: {
          decisionId: ProjectWorkDecisionId.make("deferred-decision"),
          projectId: deferredProjectId,
          title: "Choose",
          body: "Original proposal body",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        proposedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.accept",
        commandId: CommandId.make("deferred-decision-accept"),
        projectId: deferredProjectId,
        decisionId: ProjectWorkDecisionId.make("deferred-decision"),
        acceptedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.decision.supersede",
        commandId: CommandId.make("deferred-decision-supersede"),
        projectId: deferredProjectId,
        decisionId: ProjectWorkDecisionId.make("deferred-decision"),
        replacement: {
          decisionId: ProjectWorkDecisionId.make("deferred-replacement"),
          projectId: deferredProjectId,
          title: "Choose again",
          body: "Replacement proposal",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
        supersededAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.comment.add",
        commandId: CommandId.make("deferred-comment"),
        projectId: deferredProjectId,
        comment: {
          commentId: ProjectWorkCommentId.make("deferred-comment"),
          projectId: deferredProjectId,
          taskId: deferredTaskId,
          body: "A durable comment",
          createdAt: at,
          revision: 0,
        },
        addedAt: at,
        attribution,
      });
      yield* repository.execute({
        type: "project-work.attention.seen",
        commandId: CommandId.make("deferred-attention"),
        projectId: deferredProjectId,
        taskId: deferredTaskId,
        seenAt: at,
        attribution,
      });
      expect(yield* query.listKnowledge({ projectId: String(deferredProjectId) })).toHaveLength(1);
      const decisions = yield* query.listDecisions({
        projectId: String(deferredProjectId),
      });
      expect(decisions.map((decision) => [decision.title, decision.state, decision.body])).toEqual([
        ["Choose", "superseded", "Original proposal body"],
        ["Choose again", "proposed", "Replacement proposal"],
      ]);
      expect(yield* query.listComments({ projectId: String(deferredProjectId) })).toHaveLength(1);
      expect(yield* query.listAttention({ projectId: String(deferredProjectId) })).toHaveLength(1);
      const eventsBeforeRebuild = yield* repository.replay(String(deferredProjectId));
      const knowledgeBeforeRebuild = yield* query.listKnowledge({
        projectId: String(deferredProjectId),
      });
      const attentionBeforeRebuild = yield* query.listAttention({
        projectId: String(deferredProjectId),
      });
      expect(eventsBeforeRebuild.map((event) => event.type)).toEqual([
        "project-work.task.created",
        "project-work.knowledge.promoted",
        "project-work.decision.proposed",
        "project-work.decision.accepted",
        "project-work.decision.superseded",
        "project-work.comment.added",
        "project-work.attention.seen",
      ]);
      // Simulate projection damage without touching the authoritative event log.
      yield* sql`DELETE FROM project_work_knowledge WHERE project_id = ${deferredProjectId}`;
      yield* sql`DELETE FROM project_work_decisions WHERE project_id = ${deferredProjectId}`;
      yield* sql`DELETE FROM project_work_attention WHERE project_id = ${deferredProjectId}`;
      yield* projection.rebuild(String(deferredProjectId));
      expect(yield* query.listKnowledge({ projectId: String(deferredProjectId) })).toEqual(
        knowledgeBeforeRebuild,
      );
      expect(yield* query.listDecisions({ projectId: String(deferredProjectId) })).toEqual(
        decisions,
      );
      expect(yield* query.listAttention({ projectId: String(deferredProjectId) })).toEqual(
        attentionBeforeRebuild,
      );
      expect(yield* repository.replay(String(deferredProjectId))).toEqual(eventsBeforeRebuild);
      expect(yield* query.listComments({ projectId: String(deferredProjectId) })).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectWorkRepositoryLive,
          Layer.merge(ProjectWorkQueryLive, ProjectWorkProjectionLive),
        ),
      ),
    ),
  );
});
