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
  type ProjectWorkCommand,
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
    "revalidates live authority before duplicate receipts without consuming approval twice",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ProjectWorkRepository;
        const command = {
          type: "project-work.task.create" as const,
          projectId: ProjectId.make("live-authority-project"),
          taskId: ProjectWorkTaskId.make("live-authority-task"),
          commandId: CommandId.make("live-authority-duplicate"),
          title: "Live authority",
          createdAt: at,
        };
        let consumed = 0;
        let live = true;
        const execute = () =>
          repository.executeAuthorized(
            command,
            () => {
              consumed++;
              return Effect.succeed(command);
            },
            () => (live ? Effect.void : Effect.fail("credential-revoked")),
          );
        yield* execute();
        yield* execute();
        expect(consumed).toBe(1);
        live = false;
        expect((yield* execute().pipe(Effect.result))._tag).toBe("Failure");
        expect(consumed).toBe(1);
      }).pipe(Effect.provide(ProjectWorkRepositoryLive)),
  );

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

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import { seed as seedTeam, decodeRecord } from "./ProjectTeamAuthorization.testFixtures.ts";
import * as EventBus from "./ProjectWorkEventBus.ts";

const bindingServices = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkProjectionLive,
  TeamAuthorization.layer,
).pipe(Layer.provideMerge(EventBus.ProjectWorkEventBusLive));

const insertBindingSession = Effect.fn("repositoryTest.insertBindingSession")(function* (
  id: string,
  subject = "agent:mcp:pi:authorization-thread",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO auth_sessions (session_id,subject,scopes,method,issued_at,expires_at)
    VALUES (${id},${subject},'[]','bearer-access-token',${at},'2030-01-01T00:00:00.000Z')`;
});

for (const failure of ["projection-failure", "interruption"] as const)
  it.effect(`withdraws legacy credentials atomically with binding after ${failure} rollback`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const bus = yield* EventBus.ProjectWorkEventBus;
      let publications = 0;
      let beforeDispatch = 0;
      let dispatch: ProjectWorkCommand | undefined;
      const inserted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let intercepted = false;
      const transactionSql = new Proxy(sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!Array.isArray(args[0]) || !("raw" in args[0])) return statement;
          if (
            failure === "interruption" &&
            !intercepted &&
            statement.compile()[0].includes("INSERT INTO") &&
            statement.compile()[0].includes("project_team_run_binding")
          ) {
            intercepted = true;
            return statement.pipe(
              Effect.tap(() =>
                Deferred.succeed(inserted, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            );
          }
          return statement;
        },
      });
      const repository = yield* ProjectWorkRepository.pipe(
        Effect.provide(Layer.fresh(ProjectWorkRepositoryLive)),
        Effect.provideService(SqlClient.SqlClient, transactionSql),
        Effect.provideService(
          EventBus.ProjectWorkEventBus,
          EventBus.ProjectWorkEventBus.of({
            ...bus,
            publish: (events) => {
              publications += events.length;
              return bus.publish(events);
            },
          }),
        ),
      );
      const observed = ProjectWorkRepository.of({
        ...repository,
        execute: (command) => {
          if (command.commandId === "dispatch") {
            dispatch = command;
            beforeDispatch = publications;
          }
          return repository.execute(command);
        },
      });
      for (const [id, subject] of [
        ["legacy-a", "agent:mcp:pi:authorization-thread"],
        ["legacy-b", "agent:mcp:pi:authorization-thread"],
        ["other-provider", "agent:mcp:codex:authorization-thread"],
        ["other-thread", "agent:mcp:pi:other-thread"],
        ["ordinary", "agent:ordinary"],
        ["managed", "agent:project-team:reserved"],
      ])
        yield* insertBindingSession(id!, subject!);
      if (failure === "projection-failure")
        yield* sql`CREATE TRIGGER reject_binding BEFORE INSERT ON project_team_run_binding
          BEGIN SELECT RAISE(ABORT,'binding projection failure'); END`;
      const setup = seedTeam("implementer", "running", { issueCredential: false }).pipe(
        Effect.provideService(ProjectWorkRepository, observed),
      );
      if (failure === "projection-failure")
        expect((yield* setup.pipe(Effect.result))._tag).toBe("Failure");
      else {
        const pending = yield* setup.pipe(Effect.forkScoped);
        yield* Deferred.await(inserted);
        yield* Fiber.interrupt(pending);
        expect((yield* Fiber.await(pending))._tag).toBe("Failure");
        expect(yield* Deferred.isDone(release)).toBe(false);
      }
      expect(publications).toBe(beforeDispatch);
      expect(yield* sql`SELECT * FROM auth_sessions WHERE revoked_at IS NOT NULL`).toHaveLength(0);
      for (const name of [
        "project_team_run_binding",
        "project_team_effect",
        "project_work_attempts",
      ])
        expect(yield* sql`SELECT * FROM ${sql(name)}`).toHaveLength(0);
      for (const name of ["project_work_events", "project_work_command_receipts"])
        expect(yield* sql`SELECT * FROM ${sql(name)} WHERE command_id='dispatch'`).toHaveLength(0);
      expect(dispatch).toBeDefined();
      if (failure === "projection-failure") yield* sql`DROP TRIGGER reject_binding`;
      const committed = yield* repository.execute(dispatch!);
      expect(publications).toBe(beforeDispatch + committed.events.length);
      expect((yield* repository.execute(dispatch!)).duplicate).toBe(true);
      expect(publications).toBe(beforeDispatch + committed.events.length);
      const revoked = yield* sql<{ id: string }>`SELECT session_id AS id FROM auth_sessions
        WHERE revoked_at IS NOT NULL ORDER BY session_id`;
      expect(revoked.map((row) => row.id)).toEqual(["legacy-a", "legacy-b"]);
      expect(yield* sql`SELECT * FROM project_team_run_binding`).toHaveLength(1);
      expect(
        yield* sql`SELECT * FROM project_work_command_receipts WHERE command_id='dispatch'`,
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        bindingServices.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

it.effect(
  "preserves binding withdrawal through retirement, replacement and file-backed restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-binding-withdrawal-" });
      const database = () =>
        bindingServices.pipe(
          Layer.provideMerge(
            Layer.fresh(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          yield* insertBindingSession("created");
          const f = yield* seedTeam("implementer", "running", { issueCredential: false });
          expect(
            (yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id='created'`)[0]
              ?.revokedAt,
          ).not.toBeNull();
          yield* insertBindingSession("invalid", "agent:mcp:pi:forged-thread");
          expect(
            (yield* f
              .change(decodeRecord({ ...f.binding, revision: 1, threadId: "forged-thread" }))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* insertBindingSession("retired");
          yield* f.change(decodeRecord({ ...f.binding, revision: 1, status: "settled" }));
          yield* insertBindingSession("replacement", "agent:mcp:codex:replacement-thread");
          yield* f.change(
            decodeRecord({
              ...f.binding,
              recordId: "replacement-binding",
              providerInstanceId: "codex",
              threadId: "replacement-thread",
            }),
          );
          yield* insertBindingSession("rebuild-only", "agent:mcp:codex:replacement-thread");
          const projection = yield* ProjectWorkProjection;
          yield* projection.rebuild("authorization-project");
          expect(
            (yield* f.sql`SELECT revoked_at AS revokedAt FROM auth_sessions WHERE session_id='rebuild-only'`)[0]
              ?.revokedAt,
          ).toBeNull();
        }).pipe(Effect.provide(database())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            id: string;
            revokedAt: string | null;
          }>`SELECT session_id AS id,revoked_at AS revokedAt FROM auth_sessions ORDER BY session_id`;
          expect(rows.map((row) => [row.id, row.revokedAt !== null])).toEqual([
            ["created", true],
            ["invalid", false],
            ["rebuild-only", false],
            ["replacement", true],
            ["retired", true],
          ]);
          expect(
            yield* sql`SELECT * FROM project_team_run_binding WHERE status='running'`,
          ).toHaveLength(1);
        }).pipe(Effect.provide(database())),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
