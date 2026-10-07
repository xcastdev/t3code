import { ProjectTeamDeliveryAcceptanceError } from "./ProjectTeamDeliveryAcceptance.ts";
import {
  CommandId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  ProjectTeamEffect,
  EventId,
  ProjectWorkEvidence,
  ProjectWorkEvidenceId,
  type PullRequestActionInput,
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
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import type { ProjectWorkLeaseReactorShape } from "./ProjectWorkLeaseReactor.ts";
import { ProjectWorkLeaseReactor } from "./ProjectWorkLeaseReactor.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import {
  runProjectWorkLeaseWorker,
  runProjectWorkPublicationRecovery,
  runProjectWorkPublicationLinkRecovery,
  runProjectWorkManagedMergeRecovery,
  runProjectTeamDeliveryAcceptanceRecovery,
} from "./ProjectWorkRuntime.ts";
import { coreLayer, leaseLayer } from "./ProjectWorkRuntime.ts";

const decodePublicationEffect = Schema.decodeUnknownSync(ProjectTeamEffect);

it.effect("publication links stay inactive while disabled and catch up when enabled", () =>
  Effect.gen(function* () {
    const checked = yield* Queue.unbounded<boolean>();
    const called = yield* Queue.unbounded<number>();
    const enabledChanges = yield* Queue.unbounded<void>();
    let enabled = false;
    let count = 0;
    const isEnabled = Effect.suspend(() => Queue.offer(checked, enabled).pipe(Effect.as(enabled)));
    const service = {
      link: () => Effect.die("unexpected publication receipt"),
      recoverAll: () =>
        Effect.gen(function* () {
          count += 1;
          yield* Queue.offer(called, count);
          return { observed: 0, attempted: 0, skipped: 0, failed: 0 };
        }),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          runProjectWorkPublicationLinkRecovery(
            service,
            Effect.void,
            isEnabled,
            Stream.fromQueue(enabledChanges),
          ),
        );
        const first = yield* Effect.raceFirst(
          Queue.take(checked).pipe(Effect.as("checked")),
          Queue.take(called).pipe(Effect.as("called")),
        );
        expect(first).toBe("checked");
        expect(count).toBe(0);
        enabled = true;
        yield* Queue.offer(enabledChanges, undefined);
        expect(yield* Queue.take(checked)).toBe(true);
        expect(yield* Queue.take(called)).toBe(1);
        enabled = false;
        yield* Queue.offer(enabledChanges, undefined);
        expect(yield* Queue.take(checked)).toBe(false);
      }),
    );
    expect(count).toBe(1);
  }).pipe(Effect.provide(ProjectWorkEventBusLive)),
);

it.effect(
  "publication links retain confirmed receipts queued before startup readiness and stop with their scope",
  () =>
    Effect.gen(function* () {
      const bus = yield* ProjectWorkEventBus;
      const subscribed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const called = yield* Queue.unbounded<number>();
      let count = 0;
      let scans = 0;
      const linkedIds: string[] = [];
      const service = {
        recoverAll: () =>
          Effect.gen(function* () {
            scans += 1;
            count += 1;
            yield* Queue.offer(called, count);
            return { observed: 0, attempted: 0, skipped: 0, failed: 0 };
          }),
        link: (operationId: string) =>
          Effect.gen(function* () {
            linkedIds.push(operationId);
            count += 1;
            yield* Queue.offer(called, count);
            return { status: "attempted" as const };
          }),
      };
      const at = "2026-10-05T00:00:00.000Z";
      const projectId = ProjectId.make("publication-link-worker-project");
      const effect = decodePublicationEffect({
        kind: "effect",
        recordId: "publication-link",
        effectId: "publication-link",
        projectId,
        revision: 1,
        generation: 0,
        updatedAt: at,
        effectKind: "publication",
        status: "succeeded",
        targetId: "github.com/owner/repo",
        payload: { recordIds: [], expectedRevision: 0 },
        claimGeneration: 1,
        availableAt: at,
      });
      const receipts = [
        { ...effect, status: "claimed" as const },
        { ...effect, status: "uncertain" as const },
        { ...effect, effectKind: "dispatch" as const },
        effect,
      ].map((record, index) => ({
        cursor: index + 1,
        event: {
          eventId: EventId.make(`link-receipt-${index}`),
          projectId,
          revision: index + 1,
          type: "project-work.foundation.recorded" as const,
          record,
          occurredAt: at,
        },
      }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runProjectWorkPublicationLinkRecovery(service, Deferred.await(ready)).pipe(
              Effect.provideService(ProjectWorkEventBus, {
                ...bus,
                subscribe: bus.subscribe.pipe(
                  Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                ),
              }),
            ),
          );
          yield* Deferred.await(subscribed);
          yield* bus.publish(receipts);
          expect(count).toBe(0);
          yield* Deferred.succeed(ready, undefined);
          expect(yield* Queue.take(called)).toBe(1);
          expect(yield* Queue.take(called)).toBe(2);
          expect(scans).toBe(1);
          expect(linkedIds).toEqual([effect.effectId]);
        }),
      );
      yield* bus.publish(receipts);
      expect(count).toBe(2);
    }).pipe(Effect.provide(ProjectWorkEventBusLive)),
);

it.effect(
  "publication worker dispatches pending receipts and reconciles claims without a reflection feedback loop",
  () =>
    Effect.gen(function* () {
      const bus = yield* ProjectWorkEventBus;
      const called = yield* Queue.unbounded<number>();
      let count = 0;
      const dispatched = yield* Queue.unbounded<number>();
      let dispatches = 0;
      const service = {
        dispatchPending: () =>
          Effect.gen(function* () {
            dispatches += 1;
            yield* Queue.offer(dispatched, dispatches);
            return { processed: 0, confirmed: 0, uncertain: 0, denied: 0 };
          }),
        recoverAll: () =>
          Effect.gen(function* () {
            count += 1;
            yield* Queue.offer(called, count);
            return { recovered: 0, confirmed: 0, uncertain: 0, failed: 0 };
          }),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runProjectWorkPublicationRecovery(service, Effect.void));
          expect(yield* Queue.take(called)).toBe(1);
          expect(yield* Queue.take(dispatched)).toBe(1);
          const at = "2026-10-05T00:00:00.000Z";
          const projectId = ProjectId.make("publication-worker-project");
          const effect = decodePublicationEffect({
            kind: "effect",
            recordId: "publication",
            effectId: "publication",
            projectId,
            revision: 1,
            generation: 0,
            updatedAt: at,
            effectKind: "publication",
            status: "uncertain",
            targetId: "github.com/owner/repo",
            payload: { recordIds: [], expectedRevision: 0 },
            claimGeneration: 1,
            availableAt: at,
          });
          yield* bus.publish([
            {
              cursor: 1,
              event: {
                eventId: EventId.make("uncertain"),
                projectId,
                revision: 1,
                type: "project-work.foundation.recorded",
                record: effect,
                occurredAt: at,
              },
            },
            {
              cursor: 2,
              event: {
                eventId: EventId.make("claimed"),
                projectId,
                revision: 2,
                type: "project-work.foundation.recorded",
                record: { ...effect, status: "claimed" },
                occurredAt: at,
              },
            },
          ]);
          expect(yield* Queue.take(called)).toBe(2);
          yield* bus.publish([
            {
              cursor: 3,
              event: {
                eventId: EventId.make("pending"),
                projectId,
                revision: 3,
                type: "project-work.foundation.recorded",
                record: { ...effect, status: "pending" },
                occurredAt: at,
              },
            },
          ]);
          expect(yield* Queue.take(dispatched)).toBe(2);
        }),
      );
      expect(count).toBe(2);
      expect(dispatches).toBe(2);
    }).pipe(Effect.provide(ProjectWorkEventBusLive)),
);

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

import * as Authorization from "./ProjectTeamAuthorization.ts";
import { ProjectWorkStream as WorkStream } from "./ProjectWorkStream.ts";
import { withCore } from "./ProjectWorkRuntime.ts";
import { seed as seedTeam, decodeRecord } from "./ProjectTeamAuthorization.testFixtures.ts";
const authorizedRuntimeTestLayer = withCore(
  coreLayer.pipe(Layer.provideMerge(Authorization.layer)),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
it.effect("provides one authorized core to repository, bus, stream and the real lease worker", () =>
  Effect.gen(function* () {
    const f = yield* seedTeam("coordinator");
    const bus = yield* ProjectWorkEventBus;
    const repository = yield* ProjectWorkRepository;
    const reactor = yield* ProjectWorkLeaseReactor;
    const service = yield* WorkStream;
    expect(reactor).toBeDefined();
    expect(repository).toBe(f.repo);
    const marker = yield* Deferred.make<void>();
    const received = yield* Deferred.make<void>();
    const stream = yield* service.stream(
      { projectId: f.principal.managed.projectId, requestCompletionMarker: true },
      f.principal,
    );
    yield* stream.pipe(
      Stream.runForEach((item) =>
        item.kind === "synchronized"
          ? Deferred.succeed(marker, undefined)
          : item.kind === "delta" && item.delta.recordId === "member" && item.delta.revision > 8
            ? Deferred.succeed(received, undefined)
            : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(marker);
    yield* f.change(decodeRecord({ ...f.member, revision: 1, name: "Live shared publication" }));
    yield* Deferred.await(received);
    expect(bus).toBeDefined();
  }).pipe(Effect.provide(Layer.fresh(authorizedRuntimeTestLayer))),
);

const decodeMergeWakeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence);
it.effect(
  "managed merge recovery retains pre-readiness decisions, wakes only on committed permission and drains with its scope",
  () =>
    Effect.gen(function* () {
      const bus = yield* ProjectWorkEventBus;
      const subscribed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const called = yield* Queue.unbounded<string>();
      let scans = 0;
      const input: PullRequestActionInput = {
        projectId: ProjectId.make("merge-recovery-project"),
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        action: "merge",
      };
      const service = {
        pending: () =>
          Effect.sync(() => {
            scans++;
            return [{ operationId: "original-operation", input }];
          }),
      };
      const resume = (operationId: string, actual: PullRequestActionInput) =>
        Effect.gen(function* () {
          expect(actual).toEqual(input);
          yield* Queue.offer(called, operationId);
        });
      const at = "2026-10-07T00:00:00.000Z";
      const evidence = decodeMergeWakeEvidence({
        evidenceId: "managed-merge-permission:original",
        kind: "observation",
        summary: "Original human merge decision",
        recordedAt: at,
        revision: 0,
      });
      const event = (id: string, revision: number) => ({
        cursor: revision,
        event: {
          eventId: EventId.make(id),
          projectId: input.projectId,
          revision,
          type: "project-work.evidence.added" as const,
          evidence: { ...evidence, evidenceId: ProjectWorkEvidenceId.make(id) },
          addedAt: at,
          occurredAt: at,
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runProjectWorkManagedMergeRecovery(service, resume, Deferred.await(ready)).pipe(
              Effect.provideService(ProjectWorkEventBus, {
                ...bus,
                subscribe: bus.subscribe.pipe(
                  Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                ),
              }),
            ),
          );
          yield* Deferred.await(subscribed);
          yield* bus.publish([event("managed-merge-permission:original", 1)]);
          expect(scans).toBe(0);
          yield* Deferred.succeed(ready, undefined);
          expect(yield* Queue.take(called)).toBe("original-operation");
          expect(yield* Queue.take(called)).toBe("original-operation");
          yield* bus.publish([
            event("managed-merge-delivery:original", 2),
            event("managed-merge-permission:next", 3),
          ]);
          expect(yield* Queue.take(called)).toBe("original-operation");
          expect(scans).toBe(3);
        }),
      );
      yield* bus.publish([event("managed-merge-permission:after-drain", 4)]);
      expect(scans).toBe(3);
    }).pipe(Effect.provide(ProjectWorkEventBusLive)),
);

it.effect(
  "delivery acceptance recovery subscribes before readiness and advances past corrupt and unqualified rows over bounded pages",
  () =>
    Effect.gen(function* () {
      const bus = yield* ProjectWorkEventBus;
      const subscribed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const called = yield* Queue.unbounded<string>();
      const enabledChecks = yield* Queue.unbounded<boolean>();
      const pages = yield* Queue.unbounded<string | undefined>();
      let enabled = false;
      let scans = 0;
      const rows = Array.from({ length: 65 }, (_, index) => ({
        operationId: `retained-${String(index).padStart(3, "0")}`,
      }));
      const service = {
        pending: (after?: string) =>
          Effect.gen(function* () {
            scans++;
            yield* Queue.offer(pages, after);
            return rows.filter((r) => after === undefined || r.operationId > after).slice(0, 64);
          }),
        recover: (operationId: string) =>
          Effect.gen(function* () {
            yield* Queue.offer(called, operationId);
            if (operationId === rows[0]?.operationId)
              return yield* new ProjectTeamDeliveryAcceptanceError({
                code: "unavailable",
                reason: "Corrupt retained receipt",
              });
            return { _tag: "NotReady" as const, reason: "Criteria remain unsatisfied" };
          }),
      };
      const at = "2026-10-07T00:00:00.000Z";
      const evidence = decodeMergeWakeEvidence({
        evidenceId: "managed-merge-delivery:wake",
        kind: "observation",
        summary: "Retained confirmed delivery",
        recordedAt: at,
        revision: 0,
      });
      const wake = (revision: number) => ({
        cursor: revision,
        event: {
          eventId: EventId.make(`delivery-wake-${revision}`),
          projectId: ProjectId.make("delivery-recovery"),
          revision,
          type: "project-work.evidence.added" as const,
          evidence,
          addedAt: at,
          occurredAt: at,
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runProjectTeamDeliveryAcceptanceRecovery(
              service,
              Deferred.await(ready),
              Effect.gen(function* () {
                const current = enabled;
                yield* Queue.offer(enabledChecks, current);
                return current;
              }),
            ).pipe(
              Effect.provideService(ProjectWorkEventBus, {
                ...bus,
                subscribe: bus.subscribe.pipe(
                  Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                ),
              }),
            ),
          );
          yield* Deferred.await(subscribed);
          yield* bus.publish([wake(1)]);
          expect(scans).toBe(0);
          yield* Deferred.succeed(ready, undefined);
          expect(yield* Queue.take(enabledChecks)).toBe(false);
          expect(yield* Queue.take(enabledChecks)).toBe(false);
          enabled = true;
          yield* bus.publish([wake(2)]);
          expect(yield* Queue.take(pages)).toBeUndefined();
          expect(yield* Queue.take(pages)).toBe("retained-063");
          for (const row of rows) expect(yield* Queue.take(called)).toBe(row.operationId);
          expect(scans).toBe(2);
        }),
      );
      yield* bus.publish([wake(3)]);
      expect(scans).toBe(2);
    }).pipe(Effect.provide(ProjectWorkEventBusLive)),
);
