import {
  CommandId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkEventBus } from "./ProjectWorkEventBus.ts";
import type { ProjectWorkLeaseReactorShape } from "./ProjectWorkLeaseReactor.ts";
import { ProjectWorkLeaseReactor } from "./ProjectWorkLeaseReactor.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { runProjectWorkLeaseWorker } from "./ProjectWorkRuntime.ts";
import { coreLayer, leaseLayer } from "./ProjectWorkRuntime.ts";

it.effect("starts the lease drain immediately and interrupts it with its scope", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reactor = {
      expire: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as([])),
    } as unknown as ProjectWorkLeaseReactorShape;

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runProjectWorkLeaseWorker(reactor, "1 second"));
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 1);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(yield* Ref.get(calls), 2);
      }),
    );

    yield* TestClock.adjust(Duration.seconds(5));
    assert.equal(yield* Ref.get(calls), 2);
  }),
);

it.effect(
  "drains durable lease backlogs atomically, survives candidate failure, and restarts immediately",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProjectWorkRepository;
      const reactor = yield* ProjectWorkLeaseReactor;
      const query = yield* ProjectWorkQuery;
      const bus = yield* ProjectWorkEventBus;
      const sql = yield* SqlClient.SqlClient;
      const nowMs = Date.parse("2040-01-01T00:00:00.000Z");
      const pastDeadline = "2039-12-31T23:59:59.000Z";
      const futureDeadline = "2040-01-01T01:00:00.000Z";
      yield* TestClock.setTime(nowMs);

      const seedClaim = (name: string, leasedUntil: string) =>
        Effect.gen(function* () {
          const projectId = ProjectId.make(`worker-project-${name}`);
          const taskId = ProjectWorkTaskId.make(`worker-task-${name}`);
          const criterionId = ProjectWorkCriterionId.make(`worker-criterion-${name}`);
          const attemptId = ProjectWorkAttemptId.make(`worker-attempt-${name}`);
          yield* repository.execute({
            type: "project-work.task.create",
            commandId: CommandId.make(`worker-create-${name}`),
            projectId,
            taskId,
            title: `Worker task ${name}`,
            createdAt: "2039-12-31T23:00:00.000Z",
          });
          yield* repository.execute({
            type: "project-work.criterion.upsert",
            commandId: CommandId.make(`worker-criterion-${name}`),
            projectId,
            taskId,
            criterion: {
              criterionId,
              taskId,
              description: "Ready",
              required: true,
              status: "satisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: "2039-12-31T23:00:00.000Z",
            },
            updatedAt: "2039-12-31T23:00:00.000Z",
          });
          yield* repository.execute({
            type: "project-work.task.specify",
            commandId: CommandId.make(`worker-specify-${name}`),
            projectId,
            taskId,
            specification: {
              objective: "Exercise the lease worker",
              scopeIn: "Lease expiry",
              scopeOut: "Everything else",
              criterionIds: [criterionId],
              revision: 1,
              protected: false,
            },
            updatedAt: "2039-12-31T23:00:00.000Z",
          });
          yield* repository.execute({
            type: "project-work.task.ready",
            commandId: CommandId.make(`worker-ready-${name}`),
            projectId,
            taskId,
            updatedAt: "2039-12-31T23:00:00.000Z",
          });
          yield* reactor.claim({
            projectId: String(projectId),
            taskId,
            attemptId,
            leaseToken: `worker-token-${name}`,
            leasedUntil,
            claimedAt: "2039-12-31T23:00:00.000Z",
          });
          return { projectId, taskId, attemptId };
        });

      const past = yield* Effect.forEach(
        Array.from({ length: 102 }, (_, index) => String(index)),
        (name) => seedClaim(name, pastDeadline),
        { concurrency: 1 },
      );
      const failed = past[37]!;
      const restartCandidate = yield* seedClaim("restart", futureDeadline);
      const raceCandidate = yield* seedClaim("race", futureDeadline);

      yield* sql.unsafe(`
        CREATE TRIGGER reject_one_attempt_expiry
        BEFORE INSERT ON project_work_events
        WHEN NEW.event_type = 'project-work.attempt.expired'
          AND json_extract(NEW.payload_json, '$.attemptId') = '${String(failed.attemptId)}'
        BEGIN SELECT RAISE(ABORT, 'attempt-scoped expiry failure'); END
      `);

      const committed = yield* Ref.make<Array<string>>([]);
      const subscriptionScope = yield* Scope.make();
      const stream = yield* bus.subscribe;
      yield* Stream.runForEach(stream, ({ event }) =>
        event.type === "project-work.attempt.expired"
          ? Ref.update(committed, (ids) => [...ids, String(event.attemptId)])
          : Effect.void,
      ).pipe(Effect.forkIn(subscriptionScope));
      yield* Effect.yieldNow;

      const completions = yield* Queue.unbounded<ReadonlyArray<unknown>>();
      const workerScope = yield* Scope.make();
      yield* runProjectWorkLeaseWorker(reactor, Duration.seconds(1), (events) =>
        Queue.offer(completions, events).pipe(Effect.asVoid),
      ).pipe(Effect.forkIn(workerScope));

      const firstSweep = yield* Queue.take(completions);
      expect(firstSweep).toHaveLength(101);
      expect(yield* Ref.get(committed)).toHaveLength(101);
      expect((yield* reactor.get(failed.attemptId))?.state).toBe("leased");
      const failedRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM project_work_events
        WHERE event_type = 'project-work.attempt.expired'
          AND json_extract(payload_json, '$.attemptId') = ${failed.attemptId}
      `;
      const failedReceipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM project_work_command_receipts
        WHERE project_id = ${failed.projectId}
          AND command_id = ${`server:project-work:expire:${failed.attemptId}:${pastDeadline}`}
      `;
      expect(Number(failedRows[0]?.count)).toBe(0);
      expect(Number(failedReceipts[0]?.count)).toBe(0);
      expect(
        (yield* query.snapshot(String(failed.projectId))).tasks.find(
          (task) => task.taskId === failed.taskId,
        )?.state,
      ).toBe("in-progress");

      yield* sql`DROP TRIGGER reject_one_attempt_expiry`;
      yield* TestClock.adjust(Duration.seconds(1));
      const secondSweep = yield* Queue.take(completions);
      expect(secondSweep).toHaveLength(1);
      expect((yield* reactor.get(failed.attemptId))?.state).toBe("expired");

      const renewal = reactor.renew({
        projectId: String(raceCandidate.projectId),
        taskId: raceCandidate.taskId,
        attemptId: raceCandidate.attemptId,
        leaseToken: "worker-token-race",
        leasedUntil: "2040-01-01T02:00:00.000Z",
        renewedAt: "2040-01-01T00:59:59.000Z",
      });
      const expiry = reactor.expire({
        now: "2040-01-01T01:00:01.000Z",
        projectId: String(raceCandidate.projectId),
      });
      const [renewResult, expireResult] = yield* Effect.all(
        [Effect.result(renewal), Effect.result(expiry)],
        { concurrency: "unbounded" },
      );
      const raced = yield* reactor.get(raceCandidate.attemptId);
      expect(["running", "expired"]).toContain(raced?.state);
      if (raced?.state === "running") {
        expect(renewResult._tag).toBe("Success");
        assert(expireResult._tag === "Success");
        expect(expireResult.success).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ attemptId: raceCandidate.attemptId })]),
        );
      }

      yield* Scope.close(workerScope, Exit.void);
      yield* TestClock.setTime(Date.parse("2040-01-01T01:00:01.000Z"));
      yield* TestClock.adjust(Duration.seconds(5));
      expect((yield* reactor.get(restartCandidate.attemptId))?.state).toBe("leased");

      const restartDone = yield* Deferred.make<ReadonlyArray<unknown>>();
      const restartScope = yield* Scope.make();
      yield* runProjectWorkLeaseWorker(reactor, Duration.hours(1), (events) =>
        Deferred.succeed(restartDone, events).pipe(Effect.asVoid),
      ).pipe(Effect.forkIn(restartScope));
      expect(yield* Deferred.await(restartDone)).toHaveLength(1);
      expect((yield* reactor.get(restartCandidate.attemptId))?.state).toBe("expired");
      yield* Scope.close(restartScope, Exit.void);
      yield* Scope.close(subscriptionScope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(coreLayer, leaseLayer, ProjectWorkQueryLive).pipe(
          Layer.provideMerge(Layer.fresh(NodeSqliteClient.layerMemory())),
        ),
      ),
    ),
  { timeout: 30_000 },
);
