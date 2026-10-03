import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  at,
  createManagedAssignment,
  attribution,
  projectId,
  seed,
  scoped,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkProjection } from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";

const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const fixture = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
  // The real fixture commits approvals and the execution grant; intercept only its final claim.
  const result = yield* seed("implementer", "reserved", {
    roleTools: ["pi.read", "pi.write"],
    toolIds: ["pi.read", "pi.write"],
    issueCredential: false,
  }).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...repository,
      execute: (command) => {
        if (
          command.type === "project-work.foundation.commit" &&
          command.transition?.kind === "claim"
        ) {
          pending = command;
          return Effect.fail(
            new ProjectWorkPolicyError("invalid-state", "Fixture retains the uncommitted claim"),
          );
        }
        return repository.execute(command);
      },
    }),
    Effect.result,
  );
  expect(result._tag).toBe("Failure");
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Fixture did not capture its claim");
  yield* repository.execute(
    yield* decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "configure-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: at,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "limits",
          revision: 0,
          generation: 0,
          updatedAt: at,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 1,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model: "test",
          tokenLimit: 2000,
          durationLimitMs: 2000,
        },
      ],
    }),
  );
  yield* TestClock.setTime(Date.parse(at) + 1);
  const claim = {
    ...pending,
    expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
    transition: {
      ...pending.transition,
      binding: {
        ...pending.transition.binding,
        branch: "refs/heads/assigned",
        worktree: "/workspace-assigned",
      },
    },
  };
  const request: ProjectTeamDispatchRequest = {
    dispatchId: "dispatch-intent",
    claim,
    git: {
      effectId: "dispatch-intent",
      runId: "binding",
      generation: 0,
      primaryRoot: "/workspace",
      commonGitDirectory: "/workspace/.git",
      worktreePath: "/workspace-assigned",
      branchRef: "refs/heads/assigned",
      baseRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      ownershipToken: "owner",
      policyHash: "b".repeat(64),
    },
    setupId: "setup",
    initializeOperationId: "initialize",
    assignmentOperationId: "assignment",
    assignment: "Implement the approved task",
  };
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  return { sql, repository, request, journal };
});

it.effect(
  "atomically admits one run, writer reservation and pending dispatch; exact retries add nothing",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.journal.reserve(f.request);
        const state = yield* readCurrentState(f.sql, projectId);
        expect(state.attempts).toHaveLength(1);
        expect(
          state.foundationRecords?.filter((r) => r.kind === "reservation" && r.status === "held"),
        ).toHaveLength(1);
        expect(
          state.foundationRecords?.filter(
            (r) => r.kind === "effect" && r.effectKind === "dispatch" && r.status === "pending",
          ),
        ).toHaveLength(1);
        expect(
          yield* f.sql`SELECT root_maximum_tokens,attempt_maximum_tokens,revision,claim_generation FROM project_team_dispatch`,
        ).toEqual([
          {
            root_maximum_tokens: 1000,
            attempt_maximum_tokens: 1000,
            revision: 0,
            claim_generation: 0,
          },
        ]);
        const repeated = yield* f.journal.reserve(f.request);
        expect(repeated).toEqual(first);
        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(state.revision);
        expect(yield* f.sql`SELECT maximum_tokens FROM project_team_model_budget`).toEqual([
          { maximum_tokens: 1000 },
        ]);
      }),
    ),
);

it.effect("one durable effect claimant wins; stale or repeated consumers cannot launch again", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserved = yield* f.journal.reserve(f.request);
      const claimed = yield* f.journal.claimEffect(reserved.fence);
      expect(claimed.fence).toEqual({ ...reserved.fence, revision: 1, claimGeneration: 1 });
      const revision = (yield* readCurrentState(f.sql, projectId)).revision;
      expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* f.journal.claimEffect(claimed.fence).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(revision);
      expect((yield* f.journal.inspect(f.request.dispatchId)).fence).toEqual(claimed.fence);
    }),
  ),
);

it.effect(
  "a journal insertion failure rolls back grant consumption, attempt, reservation and budget",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* readCurrentState(f.sql, projectId);
        yield* f.sql`CREATE TRIGGER reject_dispatch BEFORE INSERT ON project_team_dispatch
    BEGIN SELECT RAISE(ABORT,'fixture rejects final journal commit'); END`;
        expect((yield* f.journal.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
        const after = yield* readCurrentState(f.sql, projectId);
        expect(after.revision).toBe(before.revision);
        expect(after.attempts).toEqual([]);
        expect(after.foundationRecords).toEqual(before.foundationRecords);
        expect(yield* f.sql`SELECT root_task_id FROM project_team_model_budget`).toEqual([]);
        expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
        yield* f.sql`DROP TRIGGER reject_dispatch`;
        yield* f.journal.reserve(f.request);
      }),
    ),
);

it.effect(
  "rejects changed retry content and expired authority while preserving cleanup discovery",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        expect(
          (yield* f.journal
            .reserve({ ...f.request, assignment: "Changed assignment" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* TestClock.setTime(reserved.intent.limits.deadlineAtMs);
        expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.journal.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* f.journal.readRecoveryPage({ limit: 1 })).map((r) => r.fence.dispatchId),
        ).toEqual([f.request.dispatchId]);
        expect(
          yield* f.journal.readRecoveryPage({ afterDispatchId: f.request.dispatchId, limit: 1 }),
        ).toEqual([]);
      }),
    ),
);

it.effect("rejects assignment/run mismatch before spending the approved execution grant", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* readCurrentState(f.sql, projectId);
      expect(
        (yield* f.journal
          .reserve({ ...f.request, git: { ...f.request.git, generation: 1 } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(before.revision);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect(
  "current member pause blocks duplicate and queued claims while retaining the writer",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        const state = yield* readCurrentState(f.sql, projectId);
        const member = state.foundationRecords?.find((r) => r.kind === "member");
        if (member?.kind !== "member") return yield* Effect.die("Missing fixture member");
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "pause-member",
            expectedRevision: state.revision,
            attribution,
            committedAt: at,
            records: [{ ...member, revision: member.revision + 1, status: "paused" }],
          }),
        );
        expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.journal.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
          { status: "held" },
        ]);
      }),
    ),
);

it.effect("budget drift cannot reset a retry or grant execution after restart", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserved = yield* f.journal.reserve(f.request);
      yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=2000`;
      const reopened = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
      });
      expect((yield* reopened.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* reopened.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* reopened.readRecoveryPage({ limit: 10 }))[0]?.intent.limits.maximumTokens,
      ).toBe(1000);
    }),
  ),
);

it.effect("another approved task cannot claim a writer slot held by this project's run", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.reserve(f.request);
      const role = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (r) => r.kind === "role-revision",
      );
      if (role?.kind !== "role-revision") return yield* Effect.die("Missing role");
      let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
      const firstClaim = f.request.claim.transition;
      if (firstClaim?.kind !== "claim") return yield* Effect.die("Missing initial claim");
      yield* createManagedAssignment({
        taskId: ProjectWorkTaskId.make("other-task"),
        recordId: "other-binding",
        attemptId: "other-attempt",
        commandId: "other-dispatch",
        providerInstanceId: ProviderInstanceId.make("pi"),
        threadId: ThreadId.make("other-thread"),
        role,
        status: "reserved",
        configuration: firstClaim.binding.configuration,
      }).pipe(
        Effect.provideService(ProjectWorkRepository, {
          ...f.repository,
          execute: (command) => {
            if (
              command.type === "project-work.foundation.commit" &&
              command.transition?.kind === "claim"
            ) {
              pending = command;
              return Effect.fail(
                new ProjectWorkPolicyError("invalid-state", "Retain second approved claim"),
              );
            }
            return f.repository.execute(command);
          },
        }),
        Effect.result,
      );
      if (!pending || pending.transition?.kind !== "claim")
        return yield* Effect.die("Missing second claim");
      const before = yield* readCurrentState(f.sql, projectId);
      const request: ProjectTeamDispatchRequest = {
        ...f.request,
        dispatchId: "other-dispatch",
        claim: {
          ...pending,
          transition: {
            ...pending.transition,
            binding: {
              ...pending.transition.binding,
              branch: "refs/heads/other",
              worktree: "/other-worktree",
            },
          },
        },
        git: {
          ...f.request.git,
          effectId: "other-dispatch",
          runId: "other-binding",
          branchRef: "refs/heads/other",
          worktreePath: "/other-worktree",
          ownershipToken: "other-owner",
        },
        setupId: "other-setup",
        initializeOperationId: "other-init",
        assignmentOperationId: "other-prompt",
      };
      const result = yield* f.journal.reserve(request).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "Writable project capacity exhausted" });
      expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(before.revision);
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
        { dispatch_id: "dispatch-intent" },
      ]);
      expect(yield* f.sql`SELECT root_task_id FROM project_team_model_budget`).toEqual([
        { root_task_id: "authorization-task" },
      ]);
    }),
  ),
);

it.effect("projection rebuild preserves authoritative dispatch ownership and pending work", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const projection = yield* ProjectWorkProjection;
      yield* projection.rebuild(projectId);
      const reserved = yield* f.journal.reserve(f.request);
      const state = yield* readCurrentState(f.sql, projectId);
      yield* projection.rebuild(projectId);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
      expect(yield* f.journal.inspect(f.request.dispatchId)).toEqual(reserved);
      yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id=${reserved.intent.compiledClaim.transition?.kind === "claim" ? reserved.intent.compiledClaim.transition.binding.recordId : "missing"}`;
      expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.journal.readRecoveryPage({ limit: 1 })).toEqual([reserved]);
    }),
  ),
);

it.effect("released writer denies replay and claiming while retaining cleanup discovery", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserved = yield* f.journal.reserve(f.request);
      const state = yield* readCurrentState(f.sql, projectId);
      const writer = state.foundationRecords?.find(
        (r) => r.kind === "reservation" && r.recordId === reserved.intent.writableReservationId,
      );
      if (writer?.kind !== "reservation") return yield* Effect.die("Missing writer fixture");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "release-writer",
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [{ ...writer, revision: writer.revision + 1, status: "released" }],
        }),
      );
      expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* f.journal.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.journal.readRecoveryPage({ limit: 1 })).toEqual([reserved]);
    }),
  ),
);

for (const patch of [
  { status: "released" },
  { scope_key: "wrong-scope" },
  { slot: 1 },
  { generation: 1 },
  { task_id: "wrong-task" },
  { attempt_id: "wrong-attempt" },
])
  it.effect(`writer SQL ${Object.keys(patch)[0]} disagreement denies launch`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        if (!reserved.intent.writableReservationId) return yield* Effect.die("Missing writer");
        yield* f.sql`UPDATE project_team_reservation SET ${f.sql.update(patch)} WHERE record_id=${reserved.intent.writableReservationId}`;
        expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.journal.readRecoveryPage({ limit: 1 })).toEqual([reserved]);
      }),
    ),
  );

for (const patch of [
  { worktree: "/different-owner" },
  { task_id: "wrong-task" },
  { attempt_id: "wrong-attempt" },
  { branch: "refs/heads/wrong" },
  { root_maximum_tokens: 2000 },
  { attempt_maximum_tokens: 100 },
  { attempt_deadline_at_ms: Date.parse(at) + 999 },
  { repair_allowance: 1 },
  { root_deadline_at_ms: Date.parse(at) + 3000 },
  { delegation_depth: 1 },
  { maximum_delegation_depth: 3 },
  { created_at: "2026-10-03T00:00:00.000Z" },
])
  it.effect(
    `retained journal ${Object.keys(patch)[0]} mismatch denies authority and recovery`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const reserved = yield* f.journal.reserve(f.request);
          const rows = yield* f.sql<Record<string, unknown>>`SELECT * FROM project_team_dispatch`;
          const row = rows[0];
          if (!row) return yield* Effect.die("Missing journal fixture");
          // Restore one inconsistent snapshot with every actual migration trigger still active.
          yield* f.sql`DELETE FROM project_team_dispatch WHERE dispatch_id=${f.request.dispatchId}`;
          yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...row, ...patch })}`;
          expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* f.journal.readRecoveryPage({ limit: 1 }).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }),
      ),
  );
