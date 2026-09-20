import { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ExternalNotificationDispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import * as ProjectWorkAttentionReactor from "./ProjectWorkAttentionReactor.ts";

import { deriveProjectWorkAttention } from "./ProjectWorkAttentionReactor.ts";
import type { ProjectWorkProjectionState } from "./ProjectWorkProjection.ts";

const projectId = ProjectId.make("attention-project");
const at = "2026-01-01T00:00:00.000Z";

describe("ProjectWorkAttentionReactor", () => {
  it("derives durable attention from task policy independently of notification delivery", () => {
    const state = {
      projectId,
      revision: 3,
      tasks: [
        {
          taskId: ProjectWorkTaskId.make("blocked-task"),
          projectId,
          title: "Blocked",
          state: "blocked" as const,
          watchers: [],
          revision: 3,
          specRevision: 0,
          blockerId: "blocker-1" as never,
          createdAt: at,
          updatedAt: at,
        },
      ],
      attempts: [],
      criteria: [],
      evidence: [],
      relationships: [],
      blockers: [],
      attention: [],
      checkpoints: [],
      activities: [],
      knowledge: [],
      decisions: [],
      comments: [],
    } satisfies ProjectWorkProjectionState;
    expect(deriveProjectWorkAttention(state)).toEqual([
      {
        taskId: ProjectWorkTaskId.make("blocked-task"),
        reason: "blocked",
        detail: "blocker-1",
        revision: 3,
      },
    ]);
  });

  effectIt.effect("persists, resolves, and reopens one seen row per task", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* runForkMigrations(9);
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      const sql = yield* SqlClient.SqlClient;
      const blockedState = {
        projectId,
        revision: 3,
        tasks: [
          {
            taskId: ProjectWorkTaskId.make("sql-blocked-task"),
            projectId,
            title: "Blocked",
            state: "blocked" as const,
            watchers: [],
            revision: 3,
            specRevision: 0,
            blockerId: "blocker-1" as never,
            createdAt: at,
            updatedAt: at,
          },
        ],
        attempts: [],
        criteria: [],
        evidence: [],
        relationships: [],
        blockers: [],
        attention: [],
        checkpoints: [],
        activities: [],
        knowledge: [],
        decisions: [],
        comments: [],
      } satisfies ProjectWorkProjectionState;
      yield* reactor.reconcile(String(projectId), blockedState);
      yield* reactor.reconcile(String(projectId), blockedState);

      const queued = yield* sql<{
        readonly occurrences: number;
        readonly publications: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM project_work_attention_occurrences WHERE project_id = ${projectId}) AS occurrences,
          (SELECT COUNT(*) FROM project_work_notification_publications WHERE project_id = ${projectId}) AS publications
      `;
      expect(Number(queued[0]?.occurrences)).toBe(1);
      expect(Number(queued[0]?.publications)).toBe(1);

      const readyState = {
        ...blockedState,
        revision: 4,
        tasks: [{ ...blockedState.tasks[0]!, state: "ready" as const, revision: 4 }],
        attention: [
          {
            taskId: blockedState.tasks[0]!.taskId,
            reason: "blocked" as const,
            detail: "blocker-1",
            revision: 3,
          },
        ],
      } satisfies ProjectWorkProjectionState;
      yield* reactor.reconcile(String(projectId), readyState);

      const reopenedState = {
        ...blockedState,
        revision: 5,
        tasks: [{ ...blockedState.tasks[0]!, revision: 5 }],
        attention: [
          {
            taskId: blockedState.tasks[0]!.taskId,
            reason: "blocked" as const,
            detail: "blocker-1",
            resolvedAt: "2026-01-01T00:02:00.000Z",
            revision: 4,
          },
        ],
      } satisfies ProjectWorkProjectionState;
      yield* reactor.reconcile(String(projectId), reopenedState);

      const rows = yield* sql<{
        count: number;
        seenAt: string | null;
        resolvedAt: string | null;
      }>`SELECT COUNT(*) AS count, seen_at AS seenAt, resolved_at AS resolvedAt FROM project_work_attention WHERE project_id = ${projectId} AND task_id = ${blockedState.tasks[0]!.taskId}`;
      expect(Number(rows[0]?.count)).toBe(1);
      expect(rows[0]?.seenAt).toBeNull();
      expect(rows[0]?.resolvedAt).toBeNull();
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
      ),
    ),
  );

  effectIt.effect("fences a partial publication and records destination outcomes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
           payload_json, status, available_at, created_at)
        VALUES ('publication-1', 'occurrence-1', 'project-1', 'task-1', 'blocked', 'blocked', 1,
          '{}', 'pending', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
      `;
      const result = yield* reactor.drain;
      expect(result.claimed).toBe(1);
      const rows = yield* sql<{
        readonly status: string;
        readonly ownerId: string | null;
        readonly failedIds: string;
      }>`
        SELECT status, owner_id AS ownerId, failed_destination_ids_json AS failedIds
        FROM project_work_notification_publications WHERE publication_id = 'publication-1'
      `;
      expect(rows[0]?.status).toBe("partial");
      expect(rows[0]?.ownerId).toBeNull();
      expect(rows[0]?.failedIds).toBe('["home"]');
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(
          Layer.provide(
            Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
              dispatch: () =>
                Effect.succeed({
                  attemptedDestinationIds: ["home"],
                  deliveredDestinationIds: [],
                  failedDestinationIds: ["home"],
                  outcomes: [{ destinationId: "home", status: "failed", reason: "transport" }],
                }),
              dispatchDetailed: () =>
                Effect.succeed({
                  attemptedDestinationIds: ["home"],
                  deliveredDestinationIds: [],
                  failedDestinationIds: ["home"],
                  outcomes: [{ destinationId: "home", status: "failed", reason: "transport" }],
                }),
              hasEnabledDestinations: Effect.succeed(true),
              test: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
  );

  effectIt.effect("keeps a publication pending when no destination is attempted", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
           payload_json, status, available_at, created_at)
        VALUES ('publication-zero', 'occurrence-zero', 'project-zero', 'task-zero', 'stale', 'ready', 1,
          '{}', 'pending', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
      `;
      const result = yield* reactor.drain;
      expect(result.claimed).toBe(1);
      expect(result.retried).toBe(1);
      const rows = yield* sql<{
        readonly status: string;
        readonly failedIds: string;
      }>`
        SELECT status, failed_destination_ids_json AS failedIds
        FROM project_work_notification_publications WHERE publication_id = 'publication-zero'
      `;
      expect(rows[0]?.status).toBe("pending");
      expect(rows[0]?.failedIds).toBe("[]");
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(
          Layer.provide(
            Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
              dispatch: () =>
                Effect.succeed({
                  attemptedDestinationIds: [],
                  deliveredDestinationIds: [],
                  failedDestinationIds: [],
                  outcomes: [],
                }),
              dispatchDetailed: () =>
                Effect.succeed({
                  attemptedDestinationIds: [],
                  deliveredDestinationIds: [],
                  failedDestinationIds: [],
                  outcomes: [],
                }),
              hasEnabledDestinations: Effect.succeed(false),
              test: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
  );

  effectIt.effect("processes a claimed batch concurrently, bounded at sixteen publications", () => {
    let entered!: Deferred.Deferred<void>;
    let release!: Deferred.Deferred<void>;
    let active!: Ref.Ref<number>;
    let maximum!: Ref.Ref<number>;
    const layer = Effect.gen(function* () {
      entered = yield* Deferred.make<void>();
      release = yield* Deferred.make<void>();
      active = yield* Ref.make(0);
      maximum = yield* Ref.make(0);
      return ProjectWorkAttentionReactor.layer.pipe(
        Layer.provide(
          Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
            dispatch: () => Effect.die("unused"),
            dispatchDetailed: () =>
              Effect.gen(function* () {
                const current = yield* Ref.updateAndGet(active, (value) => value + 1);
                yield* Ref.update(maximum, (value) => Math.max(value, current));
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                yield* Ref.update(active, (value) => value - 1);
                return {
                  attemptedDestinationIds: ["home"],
                  deliveredDestinationIds: ["home"],
                  failedDestinationIds: [],
                  outcomes: [{ destinationId: "home", status: "delivered" as const }],
                };
              }),
            hasEnabledDestinations: Effect.succeed(true),
            test: () => Effect.die("unused"),
          }),
        ),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
      );
    });
    return Effect.gen(function* () {
      const reactorLayer = yield* layer;
      yield* Effect.gen(function* () {
        yield* runMigrations({ toForkMigrationInclusive: 10 });
        yield* runForkMigrations(11);
        const sql = yield* SqlClient.SqlClient;
        const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
        for (let index = 0; index < 16; index += 1) {
          yield* sql`
          INSERT INTO project_work_notification_publications
            (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
             payload_json, status, available_at, created_at)
          VALUES (${`publication-${index}`}, ${`occurrence-${index}`}, 'project-batch',
            ${`task-${index}`}, 'blocked', 'blocked', ${index}, '{}', 'pending',
            '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
        `;
        }
        const draining = yield* Effect.forkScoped(reactor.drain);
        yield* Deferred.await(entered);
        for (let index = 0; index < 16; index += 1) yield* Effect.yieldNow;
        expect(yield* Ref.get(maximum)).toBe(16);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(draining);
      }).pipe(Effect.provide(reactorLayer));
    }).pipe(Effect.scoped);
  });

  effectIt.effect("reclaims an expired publication using the Effect clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2040-01-01T00:00:00.005Z"));
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
           payload_json, status, available_at, owner_id, claim_token, claimed_until, created_at)
        VALUES ('publication-expired', 'occurrence-expired', 'project-expiry', 'task-expiry',
          'blocked', 'blocked', 1, '{}', 'sending', '1970-01-01T00:00:00.000Z',
          'old-owner', 'old-token', '2040-01-01T00:00:00.001Z', '1970-01-01T00:00:00.000Z')
      `;

      const result = yield* reactor.drain;
      expect(result.claimed).toBe(1);
      expect(result.delivered).toBe(1);
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(
          Layer.provide(
            Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
              dispatch: () =>
                Effect.succeed({
                  attemptedDestinationIds: ["home"],
                  deliveredDestinationIds: ["home"],
                  failedDestinationIds: [],
                  outcomes: [{ destinationId: "home", status: "delivered" as const }],
                }),
              dispatchDetailed: () =>
                Effect.succeed({
                  attemptedDestinationIds: ["home"],
                  deliveredDestinationIds: ["home"],
                  failedDestinationIds: [],
                  outcomes: [{ destinationId: "home", status: "delivered" as const }],
                }),
              hasEnabledDestinations: Effect.succeed(true),
              test: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provide(TestClock.layer()),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
  );

  effectIt.effect("interrupts dispatch when a competing owner steals the lease", () => {
    let entered!: Deferred.Deferred<void>;
    let release!: Deferred.Deferred<void>;
    let interrupted!: Ref.Ref<boolean>;
    return Effect.gen(function* () {
      entered = yield* Deferred.make<void>();
      release = yield* Deferred.make<void>();
      interrupted = yield* Ref.make(false);
      yield* TestClock.setTime(Date.parse("2040-01-01T00:00:00.005Z"));
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
           payload_json, status, available_at, created_at)
        VALUES ('publication-theft', 'occurrence-theft', 'project-theft', 'task-theft',
          'blocked', 'blocked', 1, '{}', 'pending', '1970-01-01T00:00:00.000Z',
          '1970-01-01T00:00:00.000Z')
      `;
      const draining = yield* Effect.forkScoped(reactor.drain);
      yield* Deferred.await(entered);
      const leaseRows = yield* sql<{
        readonly claimedUntil: string | null;
      }>`
        SELECT claimed_until AS claimedUntil
        FROM project_work_notification_publications
        WHERE publication_id = 'publication-theft'
      `;
      expect(leaseRows[0]?.claimedUntil).toBe("2040-01-01T00:00:30.005Z");
      yield* sql`
        UPDATE project_work_notification_publications
        SET owner_id = 'thief', claim_token = 'thief-token'
        WHERE publication_id = 'publication-theft'
      `;
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(draining);

      expect(yield* Ref.get(interrupted)).toBe(true);
      expect(result.retried).toBe(1);
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(
          Layer.provide(
            Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
              dispatch: () => Effect.die("unused"),
              dispatchDetailed: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return {
                    attemptedDestinationIds: ["home"],
                    deliveredDestinationIds: ["home"],
                    failedDestinationIds: [],
                    outcomes: [{ destinationId: "home", status: "delivered" as const }],
                  };
                }).pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
              hasEnabledDestinations: Effect.succeed(true),
              test: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provide(TestClock.layer()),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    );
  });

  effectIt.effect("interrupts dispatch when lease renewal fails with SQL error", () => {
    let entered!: Deferred.Deferred<void>;
    let release!: Deferred.Deferred<void>;
    let interrupted!: Ref.Ref<boolean>;
    return Effect.gen(function* () {
      entered = yield* Deferred.make<void>();
      release = yield* Deferred.make<void>();
      interrupted = yield* Ref.make(false);
      yield* TestClock.setTime(Date.parse("2040-01-01T00:00:00.005Z"));
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, task_state, revision,
           payload_json, status, available_at, created_at)
        VALUES ('publication-sql-error', 'occurrence-sql-error', 'project-sql-error',
          'task-sql-error', 'blocked', 'blocked', 1, '{}', 'pending',
          '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
      `;
      const draining = yield* Effect.forkScoped(reactor.drain);
      yield* Deferred.await(entered);
      yield* sql`DROP TABLE project_work_notification_publications`;
      yield* TestClock.adjust(Duration.seconds(10));
      const result = yield* Fiber.join(draining);
      const wasInterrupted = yield* Ref.get(interrupted);
      yield* Deferred.succeed(release, undefined);

      expect(wasInterrupted).toBe(true);
      expect(result.retried).toBe(1);
    }).pipe(
      Effect.provide(
        ProjectWorkAttentionReactor.layer.pipe(
          Layer.provide(
            Layer.succeed(ExternalNotificationDispatcher.ExternalNotificationDispatcher, {
              dispatch: () => Effect.die("unused"),
              dispatchDetailed: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return {
                    attemptedDestinationIds: ["home"],
                    deliveredDestinationIds: ["home"],
                    failedDestinationIds: [],
                    outcomes: [{ destinationId: "home", status: "delivered" as const }],
                  };
                }).pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
              hasEnabledDestinations: Effect.succeed(true),
              test: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.provide(TestClock.layer()),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    );
  });
});
