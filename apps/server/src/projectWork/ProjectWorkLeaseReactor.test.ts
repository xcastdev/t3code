import {
  CommandId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";

import {
  ProjectWorkLeaseReactor,
  ProjectWorkLeaseReactorLive,
  ProjectWorkLeaseError,
  assertProjectWorkLeaseFence,
  projectWorkLeaseExpired,
} from "./ProjectWorkLeaseReactor.ts";

const taskId = ProjectWorkTaskId.make("task-1");
const projectId = "project-1";
const base = {
  projectId,
  taskId,
  attemptId: ProjectWorkAttemptId.make("attempt-1"),
  leaseToken: "token-1",
  leasedUntil: "2026-01-01T01:00:00.000Z",
  claimedAt: "2026-01-01T00:00:00.000Z",
};

describe("ProjectWorkLeaseReactor", () => {
  it("fences stale and mismatched tokens", () => {
    const attempt = { ...base, state: "leased" as const, checkpointIds: [], revision: 0 };
    assert.equal(projectWorkLeaseExpired(attempt, "2026-01-01T00:30:00.000Z"), false);
    expect(() => assertProjectWorkLeaseFence(attempt, "wrong", "2026-01-01T00:30:00.000Z")).toThrow(
      ProjectWorkLeaseError,
    );
    expect(() =>
      assertProjectWorkLeaseFence(attempt, "token-1", "2026-01-01T01:00:00.000Z"),
    ).toThrow(/expired/i);
  });

  it.effect(
    "persists claims and checkpoints across fresh reactors and rejects a second active claim",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toForkMigrationInclusive: 8 });
        yield* runForkMigrations(9);
        const repository = yield* ProjectWorkRepository;
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("lease-create"),
          projectId: ProjectId.make(projectId),
          taskId,
          title: "Leased task",
          createdAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.criterion.upsert",
          commandId: CommandId.make("lease-criterion"),
          projectId: ProjectId.make(projectId),
          taskId,
          criterion: {
            criterionId: ProjectWorkCriterionId.make("lease-criterion"),
            taskId,
            description: "Ready",
            required: true,
            status: "satisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: base.claimedAt,
          },
          updatedAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.task.specify",
          commandId: CommandId.make("lease-specify"),
          projectId: ProjectId.make(projectId),
          taskId,
          specification: {
            objective: "Run",
            scopeIn: "Task",
            scopeOut: "Nothing",
            criterionIds: [ProjectWorkCriterionId.make("lease-criterion")],
            revision: 1,
            protected: false,
          },
          updatedAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.task.ready",
          commandId: CommandId.make("lease-ready"),
          projectId: ProjectId.make(projectId),
          taskId,
          updatedAt: base.claimedAt,
        });
        const first = yield* Effect.service(ProjectWorkLeaseReactor).pipe(
          Effect.provide(Layer.fresh(ProjectWorkLeaseReactorLive)),
        );
        const attempt = yield* first.claim(base);
        const checkpointEvent = yield* first.checkpoint({
          ...base,
          checkpointId: "checkpoint-1",
          ref: "refs/work/1",
          capturedAt: base.claimedAt,
        });
        expect(attempt.state).toBe("leased");
        expect(checkpointEvent.type).toBe("project-work.attempt.checkpointed");
        const secondReactor = yield* Effect.service(ProjectWorkLeaseReactor).pipe(
          Effect.provide(Layer.fresh(ProjectWorkLeaseReactorLive)),
        );
        const restarted = yield* secondReactor.get(base.attemptId);
        expect(restarted?.checkpointIds).toEqual(["checkpoint-1"]);
        const second = yield* Effect.result(
          secondReactor.claim({
            ...base,
            attemptId: ProjectWorkAttemptId.make("attempt-2"),
            leaseToken: "token-2",
          }),
        );
        expect(second._tag).toBe("Failure");
        const expired = yield* first.expire({ projectId, now: "2026-01-01T02:00:00.000Z" });
        expect(expired).toHaveLength(1);
        const afterExpiryReactor = yield* Effect.service(ProjectWorkLeaseReactor).pipe(
          Effect.provide(Layer.fresh(ProjectWorkLeaseReactorLive)),
        );
        const current = yield* afterExpiryReactor.get(base.attemptId);
        expect(current?.state).toBe("expired");
        expect(current?.checkpointIds).toEqual(["checkpoint-1"]);
      }).pipe(
        Effect.provide(
          Layer.merge(ProjectWorkRepositoryLive, ProjectWorkLeaseReactorLive).pipe(
            Layer.provideMerge(Layer.fresh(NodeSqliteClient.layerMemory())),
          ),
        ),
      ),
  );

  it.effect(
    "requires explicit takeover authorization and permits reclaim after durable expiry",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toForkMigrationInclusive: 8 });
        yield* runForkMigrations(9);
        const repository = yield* ProjectWorkRepository;
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("reclaim-create"),
          projectId: ProjectId.make(projectId),
          taskId,
          title: "Reclaimable task",
          createdAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.criterion.upsert",
          commandId: CommandId.make("reclaim-criterion"),
          projectId: ProjectId.make(projectId),
          taskId,
          criterion: {
            criterionId: ProjectWorkCriterionId.make("reclaim-criterion"),
            taskId,
            description: "Ready",
            required: true,
            status: "satisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: base.claimedAt,
          },
          updatedAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.task.specify",
          commandId: CommandId.make("reclaim-specify"),
          projectId: ProjectId.make(projectId),
          taskId,
          specification: {
            objective: "Run",
            scopeIn: "Task",
            scopeOut: "Nothing",
            criterionIds: [ProjectWorkCriterionId.make("reclaim-criterion")],
            revision: 1,
            protected: false,
          },
          updatedAt: base.claimedAt,
        });
        yield* repository.execute({
          type: "project-work.task.ready",
          commandId: CommandId.make("reclaim-ready"),
          projectId: ProjectId.make(projectId),
          taskId,
          updatedAt: base.claimedAt,
        });
        const reactor = yield* Effect.service(ProjectWorkLeaseReactor).pipe(
          Effect.provide(Layer.fresh(ProjectWorkLeaseReactorLive)),
        );
        yield* reactor.claim(base);
        const denied = yield* Effect.result(
          reactor.takeover({
            ...base,
            previousAttemptId: base.attemptId,
            attemptId: ProjectWorkAttemptId.make("attempt-2"),
            leaseToken: "token-2",
            authorized: false,
          }),
        );
        expect(denied._tag).toBe("Failure");
        yield* reactor.expire({ projectId, now: "2026-01-01T02:00:00.000Z" });
        const reclaimed = yield* reactor.reclaim({
          ...base,
          previousAttemptId: base.attemptId,
          attemptId: ProjectWorkAttemptId.make("attempt-2"),
          leaseToken: "token-2",
        });
        expect(reclaimed.attemptId).toBe("attempt-2");
      }).pipe(
        Effect.provide(
          Layer.merge(ProjectWorkRepositoryLive, ProjectWorkLeaseReactorLive).pipe(
            Layer.provideMerge(Layer.fresh(NodeSqliteClient.layerMemory())),
          ),
        ),
      ),
  );
});
