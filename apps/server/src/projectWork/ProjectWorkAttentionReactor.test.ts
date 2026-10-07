import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  type ProjectIssueIntake,
  type ExternalNotificationPayload,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import * as TestClock from "effect/testing/TestClock";

import * as ExternalNotificationDispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeAssistantWebhookAdapter from "../notifications/HomeAssistantWebhookAdapter.ts";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import * as ProjectWorkAttentionReactor from "./ProjectWorkAttentionReactor.ts";

import { deriveProjectWorkAttention } from "./ProjectWorkAttentionReactor.ts";
import {
  applyProjectWorkProjectionEvent,
  emptyProjectWorkProjectionState,
  persistProjectWorkState,
  readProjectWorkState,
  type ProjectWorkProjectionState,
} from "./ProjectWorkProjection.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const projectId = ProjectId.make("attention-project");
const at = "2026-01-01T00:00:00.000Z";
const decodeNotificationOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const closureTaskId = ProjectWorkTaskId.make("closure-task");
const closedIssue = {
  kind: "issue",
  recordId: "closure-issue",
  projectId,
  revision: 1,
  generation: 0,
  updatedAt: at,
  status: "closed",
  identity: { host: "github.com", repositoryNodeId: "R_repo", issueNodeId: "I_issue", number: 1 },
  repositoryName: "owner/repo",
  title: "External issue",
  body: "Description",
  sourceRevision: "source-1",
  observedAt: at,
  taskId: closureTaskId,
} satisfies ProjectIssueIntake;
const closureState = (): ProjectWorkProjectionState => ({
  ...emptyProjectWorkProjectionState(projectId),
  foundationRecords: [
    {
      kind: "gate",
      recordId: "approved-plan",
      projectId,
      revision: 1,
      generation: 0,
      updatedAt: at,
      status: "approved",
      taskId: closureTaskId,
      gate: "plan",
      specRevision: 0,
      planRevision: 1,
      contentHash: "approved-content",
      attribution: {
        actor: { kind: "human", id: "approver" },
        source: { kind: "web" },
        recordedAt: at,
      },
      evidenceIds: [],
    },
  ],
  tasks: [
    {
      taskId: closureTaskId,
      projectId,
      title: "Active work",
      state: "in-progress",
      activeAttemptId: ProjectWorkAttemptId.make("closure-attempt"),
      watchers: [],
      revision: 7,
      specRevision: 0,
      createdAt: at,
      updatedAt: at,
    },
  ],
  attempts: [
    {
      attemptId: ProjectWorkAttemptId.make("closure-attempt"),
      taskId: closureTaskId,
      state: "running",
      leaseToken: "active-lease",
      leasedUntil: "2026-01-02T00:00:00.000Z",
      checkpointIds: [],
      revision: 1,
    },
  ],
});
const issueEvent = (revision: number, record: ProjectIssueIntake): ProjectWorkEvent => ({
  type: "project-work.foundation.recorded",
  eventId: EventId.make(`closure-issue-event-${revision}`),
  projectId,
  revision,
  occurredAt: at,
  record,
});

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

  it("derives closure from an imported issue without changing active execution", () => {
    const before = closureState();
    const closed = applyProjectWorkProjectionEvent(before, issueEvent(10, closedIssue));
    expect(closed.attention[0]?.reason).toBe("external-issue-closed");
    expect(closed.tasks).toEqual(before.tasks);
    expect(closed.attempts).toEqual(before.attempts);
    expect(closed.criteria).toEqual(before.criteria);
    expect(closed.resultInvalidations).toEqual(before.resultInvalidations);
    expect(before.foundationRecords).toEqual(closureState().foundationRecords);
    expect(closed.foundationRecords?.filter((record) => record.kind === "gate")).toEqual(
      before.foundationRecords,
    );
    expect(applyProjectWorkProjectionEvent(closed, issueEvent(10, closedIssue))).toEqual(closed);
  });

  effectIt.effect(
    "commits one closure occurrence through projection, seen, reopen, and repeated imports",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        let state = closureState();
        yield* persistProjectWorkState(sql, state, projectId);
        const persistedBeforeClosure = yield* readProjectWorkState(sql, projectId);
        const commit = Effect.fn("closureTest.commit")(function* (event: ProjectWorkEvent) {
          const next = applyProjectWorkProjectionEvent(state, event);
          yield* sql.withTransaction(
            persistProjectWorkState(sql, next, projectId, { previousState: state }).pipe(
              Effect.andThen(
                ProjectWorkAttentionReactor.enqueueProjectWorkAttentionPublication(
                  sql,
                  projectId,
                  state,
                  next,
                  event.occurredAt,
                ),
              ),
            ),
          );
          state = next;
          return yield* readProjectWorkState(sql, projectId);
        });
        const first = yield* commit(issueEvent(10, closedIssue));
        expect(first.attention[0]?.reason).toBe("external-issue-closed");
        expect(first.tasks).toEqual(persistedBeforeClosure.tasks);
        expect(first.attempts).toEqual(persistedBeforeClosure.attempts);
        expect(first.foundationRecords?.filter((record) => record.kind === "gate")).toEqual(
          persistedBeforeClosure.foundationRecords,
        );
        yield* commit({
          type: "project-work.attention.seen",
          eventId: EventId.make("closure-seen"),
          projectId,
          revision: 11,
          occurredAt: at,
          taskId: closureTaskId,
          seenAt: at,
        });
        const edited = {
          ...closedIssue,
          revision: 2,
          title: "Edited title",
          body: "Edited body",
          sourceRevision: "source-2",
        };
        yield* commit(issueEvent(12, edited));
        const unrelated = yield* commit({
          type: "project-work.task.assigned",
          eventId: EventId.make("closure-assigned"),
          projectId,
          revision: 13,
          occurredAt: at,
          taskId: closureTaskId,
          assignee: { kind: "human", id: "someone" },
          assignedAt: at,
        });
        expect(unrelated.attention[0]?.seenAt).toBe(at);
        yield* commit(issueEvent(12, edited));
        // A fresh reactor reads durable SQL, as on startup after a repeated/304 import.
        yield* Effect.gen(function* () {
          const restarted = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
          yield* restarted.drain;
        }).pipe(Effect.provide(Layer.fresh(ProjectWorkAttentionReactor.layer)));
        const queued = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_notification_publications WHERE project_id = ${projectId}`;
        expect(Number(queued[0]?.count)).toBe(1);
        const opened = yield* commit(issueEvent(14, { ...edited, revision: 3, status: "open" }));
        expect(opened.attention[0]?.resolvedAt).toBe(at);
        const closedAgain = yield* commit(issueEvent(15, { ...edited, revision: 4 }));
        expect(closedAgain.attention[0]?.seenAt).toBeUndefined();
        expect(closedAgain.attention[0]?.revision).toBeGreaterThan(opened.attention[0]!.revision);
        yield* commit(issueEvent(16, { ...edited, revision: 5 }));
        const publications = yield* sql<{
          occurrenceId: string;
        }>`SELECT occurrence_id AS occurrenceId FROM project_work_notification_publications WHERE project_id = ${projectId}`;
        expect(publications).toHaveLength(2);
        expect(new Set(publications.map((row) => row.occurrenceId)).size).toBe(2);
        const detached = yield* commit(
          issueEvent(17, { ...edited, revision: 6, status: "detached" }),
        );
        expect(detached.attention[0]?.resolvedAt).toBe(at);
        const active = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM project_work_attention_occurrences WHERE project_id = ${projectId} AND resolved_at IS NULL`;
        expect(Number(active[0]?.count)).toBe(0);
        expect(detached.attempts[0]?.leaseToken).toBe("active-lease");
        expect(detached.attempts[0]?.state).toBe("running");
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  effectIt.effect(
    "retains one seen closure occurrence after closing and reopening the SQLite connection",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-closed-issue-attention-",
        });
        const filename = path.join(directory, "state.sqlite");
        const occurrenceId = yield* Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const previous = closureState();
          const next = applyProjectWorkProjectionEvent(previous, issueEvent(10, closedIssue));
          yield* sql.withTransaction(
            persistProjectWorkState(sql, next, projectId).pipe(
              Effect.andThen(
                ProjectWorkAttentionReactor.enqueueProjectWorkAttentionPublication(
                  sql,
                  projectId,
                  previous,
                  next,
                  at,
                ),
              ),
            ),
          );
          yield* sql`UPDATE project_work_attention SET seen_at = ${at} WHERE project_id = ${projectId}`;
          const rows = yield* sql<{
            occurrenceId: string;
          }>`SELECT occurrence_id AS occurrenceId FROM project_work_attention_occurrences WHERE project_id = ${projectId}`;
          expect(rows).toHaveLength(1);
          return rows[0]!.occurrenceId;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
          const restored = yield* readProjectWorkState(sql, projectId);
          expect(restored.attention[0]?.seenAt).toBe(at);
          const unchanged = yield* reactor.reconcile(projectId, restored);
          expect(unchanged[0]?.seenAt).toBe(at);
          yield* reactor.drain;
          const rows = yield* sql<{
            occurrenceId: string;
          }>`SELECT occurrence_id AS occurrenceId FROM project_work_notification_publications WHERE project_id = ${projectId}`;
          expect(rows).toEqual([{ occurrenceId }]);
          expect(restored.attempts[0]?.state).toBe("running");
          expect(restored.tasks[0]?.completedAt).toBeUndefined();
        }).pipe(
          Effect.provide(
            ProjectWorkAttentionReactor.layer.pipe(
              Layer.provideMerge(NodeSqliteClient.layer({ filename })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect(
    "recovery preserves seen closure, makes changed reasons unread, and republishes reclosure",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
        const initial = closureState();
        initial.tasks = [{ ...initial.tasks[0]!, state: "in-review" }];
        yield* reactor.reconcile(projectId, initial);
        yield* sql`UPDATE project_work_attention SET seen_at = ${at} WHERE project_id = ${projectId}`;
        const closed = { ...initial, foundationRecords: [closedIssue] };
        const closure = yield* reactor.reconcile(projectId, closed);
        expect(closure[0]?.reason).toBe("external-issue-closed");
        expect(closure[0]?.seenAt).toBeUndefined();
        yield* sql`UPDATE project_work_attention SET seen_at = ${at} WHERE project_id = ${projectId}`;
        const same = yield* reactor.reconcile(projectId, {
          ...closed,
          tasks: [{ ...closed.tasks[0]!, revision: 50 }],
        });
        expect(same[0]?.seenAt).toBe(at);
        yield* reactor.drain;
        const reopened = yield* reactor.reconcile(projectId, initial);
        expect(reopened[0]?.reason).toBe("needs-review");
        expect(reopened[0]?.seenAt).toBeUndefined();
        const reclosed = yield* reactor.reconcile(projectId, closed);
        expect(reclosed[0]?.revision).toBeGreaterThan(same[0]!.revision);
        expect(reclosed[0]?.seenAt).toBeUndefined();
        yield* reactor.reconcile(projectId, closed);
        const publications = yield* sql<{
          reason: string;
        }>`SELECT reason FROM project_work_notification_publications WHERE project_id = ${projectId}`;
        expect(
          publications
            .map((row) => row.reason)
            .filter((reason) => reason === "external-issue-closed"),
        ).toHaveLength(2);
        const rows = yield* sql<{
          count: number;
          seenAt: string | null;
        }>`SELECT COUNT(*) AS count, seen_at AS seenAt FROM project_work_attention WHERE project_id = ${projectId}`;
        expect(Number(rows[0]?.count)).toBe(1);
        expect(rows[0]?.seenAt).toBeNull();
      }).pipe(
        Effect.provide(
          ProjectWorkAttentionReactor.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layerMemory()),
          ),
        ),
      ),
  );

  for (const scenario of [
    "typed reopen and reclose stays unread",
    "unchanged occurrence keeps concurrent mark-seen",
    "new closure keeps concurrent mark-seen",
    "new review reason wins over stale closure",
  ] as const) {
    effectIt.effect(`fences a completed native attention read: ${scenario}`, () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const base = yield* SqlClient.SqlClient;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let armed = false;
        const sql = new Proxy(base, {
          apply(target, thisArg, args) {
            const statement: Statement.Statement<Record<string, unknown>> | Statement.Identifier =
              Reflect.apply(target, thisArg, args);
            if (!("compile" in statement)) return statement;
            const [query] = statement.compile();
            if (!query.includes("SELECT task_id AS taskId, reason, detail, seen_at"))
              return statement;
            // Delay only the completed native read, after its connection permit is released.
            return statement.pipe(
              Effect.tap(() =>
                Effect.suspend(() => {
                  if (!armed) return Effect.void;
                  armed = false;
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  );
                }),
              ),
            );
          },
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
          let state: ProjectWorkProjectionState = {
            ...closureState(),
            foundationRecords: [...closureState().foundationRecords!, closedIssue],
          };
          const commit = Effect.fn("heldReadTest.commit")(function* (event: ProjectWorkEvent) {
            const next = applyProjectWorkProjectionEvent(state, event);
            yield* sql.withTransaction(
              persistProjectWorkState(sql, next, projectId, { previousState: state }).pipe(
                Effect.andThen(
                  ProjectWorkAttentionReactor.enqueueProjectWorkAttentionPublication(
                    sql,
                    projectId,
                    state,
                    next,
                    event.occurredAt,
                  ),
                ),
              ),
            );
            state = next;
          });
          if (scenario === "typed reopen and reclose stays unread") {
            state = { ...state, foundationRecords: closureState().foundationRecords! };
            yield* persistProjectWorkState(sql, state, projectId);
            yield* commit(issueEvent(10, closedIssue));
            yield* commit({
              type: "project-work.attention.seen",
              eventId: EventId.make("held-read-seen"),
              projectId,
              revision: 11,
              occurredAt: at,
              taskId: closureTaskId,
              seenAt: at,
            });
          } else if (scenario === "new closure keeps concurrent mark-seen") {
            yield* reactor.reconcile(projectId, {
              ...state,
              foundationRecords: closureState().foundationRecords!,
              tasks: [{ ...state.tasks[0]!, state: "in-review" }],
            });
          } else {
            yield* reactor.reconcile(projectId, state);
          }
          const before = yield* readProjectWorkState(sql, projectId);
          armed = true;
          const waiting = yield* Effect.forkScoped(reactor.reconcile(projectId, state));
          yield* Deferred.await(entered);
          if (scenario === "typed reopen and reclose stays unread") {
            yield* commit(issueEvent(12, { ...closedIssue, revision: 2, status: "open" }));
            yield* commit(issueEvent(13, { ...closedIssue, revision: 3 }));
          } else if (scenario === "new review reason wins over stale closure") {
            yield* reactor.reconcile(projectId, {
              ...state,
              foundationRecords: closureState().foundationRecords!,
              tasks: [{ ...state.tasks[0]!, state: "in-review" }],
            });
          } else if (scenario === "new closure keeps concurrent mark-seen") {
            yield* reactor.reconcile(projectId, state);
          }
          if (scenario !== "typed reopen and reclose stays unread") {
            yield* sql`UPDATE project_work_attention SET seen_at = ${at}, revision = revision + 1
              WHERE project_id = ${projectId}`;
          }
          const fresh = yield* readProjectWorkState(sql, projectId);
          yield* Deferred.succeed(release, undefined);
          const returned = yield* Fiber.join(waiting);
          const resumed = yield* readProjectWorkState(sql, projectId);
          expect(resumed.attention).toEqual(fresh.attention);
          expect(returned).toEqual(
            fresh.attention.filter((entry) => entry.resolvedAt === undefined),
          );
          if (scenario === "typed reopen and reclose stays unread") {
            expect(resumed.attention[0]?.seenAt).toBeUndefined();
            expect(resumed.attention[0]!.revision).toBeGreaterThan(before.attention[0]!.revision);
          } else {
            expect(resumed.attention[0]?.seenAt).toBe(at);
          }
          const publications = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
            FROM project_work_notification_publications WHERE project_id = ${projectId}`;
          expect(Number(publications[0]?.count)).toBe(
            scenario === "unchanged occurrence keeps concurrent mark-seen" ? 1 : 2,
          );
          const occurrences = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
            FROM project_work_attention_occurrences WHERE project_id = ${projectId}
            AND resolved_at IS NULL`;
          expect(Number(occurrences[0]?.count)).toBe(1);
        }).pipe(
          Effect.provide(
            ProjectWorkAttentionReactor.layer.pipe(
              Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
    );
  }

  effectIt.effect(
    "resolves closure on task completion or cancellation without accepting an issue close",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        for (const type of ["project-work.task.completed", "project-work.task.canceled"] as const) {
          const before = applyProjectWorkProjectionEvent(
            closureState(),
            issueEvent(10, closedIssue),
          );
          const event: ProjectWorkEvent =
            type === "project-work.task.completed"
              ? {
                  type,
                  eventId: EventId.make(type),
                  projectId,
                  revision: 20,
                  occurredAt: at,
                  taskId: closureTaskId,
                  attemptId: before.attempts[0]!.attemptId,
                  satisfiedCriterionIds: [],
                  completedAt: at,
                }
              : {
                  type,
                  eventId: EventId.make(type),
                  projectId,
                  revision: 20,
                  occurredAt: at,
                  taskId: closureTaskId,
                  canceledAt: at,
                };
          const finished = applyProjectWorkProjectionEvent(before, event);
          yield* persistProjectWorkState(sql, finished, projectId);
          const restored = yield* readProjectWorkState(sql, projectId);
          expect(restored.attention[0]?.resolvedAt).toBe(at);
          expect(deriveProjectWorkAttention(restored)).toEqual([]);
        }
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  for (const invalid of [false, true]) {
    effectIt.effect(
      invalid
        ? "keeps invalid durable Work notification targets pending without sending"
        : "drains durable Work attention through the real dispatcher with task links",
      () => {
        const sent: ExternalNotificationPayload[] = [];
        const owner = EnvironmentId.make("remote server");
        const notificationLayer = ExternalNotificationDispatcher.layer.pipe(
          Layer.provide(
            Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
              send: ({ payload }) => Effect.sync(() => sent.push(payload)),
            }),
          ),
          Layer.provide(
            ServerSettings.layerTest({
              externalNotifications: {
                appScheme: "t3code",
                destinations: [
                  {
                    _tag: "home-assistant-webhook",
                    id: "home",
                    label: "Home",
                    enabled: true,
                    configured: true,
                    webhookUrl: "https://home.example.test/api/webhook/token",
                  },
                ],
              },
            }),
          ),
        );
        return TestClock.setTime(Date.parse(at)).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              yield* runMigrations();
              const sql = yield* SqlClient.SqlClient;
              const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
              // Keep the durable fixture private until this explicit drain completes.
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const before = closureState();
                  const next = applyProjectWorkProjectionEvent(before, issueEvent(10, closedIssue));
                  yield* persistProjectWorkState(sql, next, projectId);
                  yield* ProjectWorkAttentionReactor.enqueueProjectWorkAttentionPublication(
                    sql,
                    projectId,
                    before,
                    next,
                    at,
                  );
                  const queued = yield* sql<{
                    taskId: string;
                    status: string;
                  }>`SELECT task_id AS taskId,status FROM project_work_notification_publications WHERE project_id=${projectId}`;
                  expect(queued).toEqual([{ taskId: closureTaskId, status: "pending" }]);
                  if (invalid) {
                    yield* sql`UPDATE project_work_notification_publications SET task_id=${` ${closureTaskId} `} WHERE project_id=${projectId}`;
                    const altered = yield* sql<{
                      taskId: string;
                    }>`SELECT task_id AS taskId FROM project_work_notification_publications WHERE project_id=${projectId}`;
                    expect(altered[0]?.taskId).toBe(` ${closureTaskId} `);
                  }
                  const result = yield* reactor.drain;
                  expect(result.claimed).toBe(1);
                  const retained = yield* sql<{
                    status: string;
                    ownerId: string | null;
                    outcome: string;
                    deliveredAt: string | null;
                  }>`SELECT status,owner_id AS ownerId,outcome_json AS outcome,delivered_at AS deliveredAt FROM project_work_notification_publications WHERE project_id=${projectId}`;
                  expect(retained).toHaveLength(1);
                  expect(retained[0]?.ownerId).toBeNull();
                  if (invalid) {
                    expect(result.retried).toBe(1);
                    expect(result.delivered).toBe(0);
                    expect(sent).toEqual([]);
                    expect(retained[0]?.status).toBe("pending");
                    expect(retained[0]?.deliveredAt).toBeNull();
                    expect(yield* decodeNotificationOutcome(retained[0]?.outcome)).toEqual({
                      attemptedDestinationIds: [],
                      deliveredDestinationIds: [],
                      failedDestinationIds: [],
                      outcomes: [],
                    });
                  } else {
                    expect(result.delivered).toBe(1);
                    expect(retained[0]?.status).toBe("sent");
                    expect(sent).toHaveLength(1);
                    expect(sent[0]?.relativeRoute).toBe(
                      "/work/remote%20server/attention-project?taskId=closure-task",
                    );
                    expect(sent[0]?.deepLink).toBe(
                      "t3code://work/remote%20server/attention-project/tasks/closure-task",
                    );
                    expect(sent[0]?.projectWork).toMatchObject({
                      projectId,
                      taskId: closureTaskId,
                      revision: next.tasks[0]?.revision,
                    });
                  }
                }),
              );
            }).pipe(
              Effect.provide(
                ProjectWorkAttentionReactor.layer.pipe(
                  Layer.provide(notificationLayer),
                  Layer.provideMerge(
                    Layer.succeed(ServerEnvironment.ServerEnvironment, {
                      getEnvironmentId: Effect.succeed(owner),
                      getDescriptor: Effect.die("unused"),
                    }),
                  ),
                  Layer.provideMerge(NodeSqliteClient.layerMemory()),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  effectIt.effect("fences a partial publication and records destination outcomes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      yield* runForkMigrations(11);
      const sql = yield* SqlClient.SqlClient;
      const reactor = yield* ProjectWorkAttentionReactor.ProjectWorkAttentionReactor;
      // The startup worker cannot claim this uncommitted fixture row.
      yield* sql.withTransaction(
        Effect.gen(function* () {
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
        }),
      );
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
      // The startup worker cannot claim this uncommitted fixture row.
      yield* sql.withTransaction(
        Effect.gen(function* () {
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
        }),
      );
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
