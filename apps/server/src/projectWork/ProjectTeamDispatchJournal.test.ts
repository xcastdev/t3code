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
  ProjectTeamDispatchJournalError,
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

it.effect("cannot advance a durable stage without Root's actual receipt verifier", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const result = yield* f.journal
        .advanceStage(claimed.fence, {
          receiptId: "workspace",
          stage: "workspace-ready",
          evidence: { claimed: true },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
        { stage: "reserved", revision: 1 },
      ]);
      expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
    }),
  ),
);

it.effect(
  "persists verified stages in order and deduplicates only the exact original receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        // SQLite sequencing control only: production verifier must inspect real Git/setup/native receipts.
        const verified = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: (receipt, snapshot) =>
            receipt.evidence.bindingId === snapshot.intent.request.git.runId
              ? Effect.void
              : Effect.fail(
                  new ProjectTeamDispatchJournalError({
                    reason: "Control rejects mismatched binding",
                  }),
                ),
        });
        const receipt = {
          receiptId: "workspace",
          stage: "workspace-ready" as const,
          evidence: { bindingId: "binding" },
        };
        const first = yield* verified.advanceStage(claimed.fence, receipt);
        expect(first.fence).toEqual({ ...claimed.fence, stage: "workspace-ready", revision: 2 });
        expect((yield* verified.advanceStage(claimed.fence, receipt)).duplicate).toBe(true);
        expect(
          (yield* verified
            .advanceStage(first.fence, { ...receipt, evidence: { bindingId: "other" } })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* verified
            .advanceStage(first.fence, {
              receiptId: "session",
              stage: "session-bound",
              evidence: { bindingId: "binding" },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* verified
            .advanceStage(claimed.fence, {
              receiptId: "setup",
              stage: "setup-complete",
              evidence: { bindingId: "binding" },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const setup = yield* verified.advanceStage(first.fence, {
          receiptId: "setup",
          stage: "setup-complete",
          evidence: { bindingId: "binding" },
        });
        expect(setup.fence.stage).toBe("setup-complete");
        expect(
          (yield* verified.readStageReceipts(f.request.dispatchId)).map((r) => r.receiptId),
        ).toEqual(["workspace", "setup"]);
      }),
    ),
);

it.effect("rolls back stage progression if verifier or final append fails", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const receipt = { receiptId: "workspace", stage: "workspace-ready" as const, evidence: {} };
      const denied = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          Effect.fail(new ProjectTeamDispatchJournalError({ reason: "No actual native receipt" })),
      });
      expect((yield* denied.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      const accepted = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () => Effect.void,
      });
      yield* f.sql`CREATE TRIGGER reject_stage BEFORE INSERT ON project_team_dispatch_receipt
    BEGIN SELECT RAISE(ABORT,'control fails final append'); END`;
      expect((yield* accepted.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
        { stage: "reserved", revision: 1 },
      ]);
      expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
    }),
  ),
);

it.effect(
  "retained recovery reads survive expired execution authority without granting another effect",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        yield* TestClock.setTime(reserved.intent.limits.deadlineAtMs);
        expect((yield* f.journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.journal.readRetained(f.request.dispatchId)).toEqual(reserved);
        const candidates = yield* f.journal.readRecoveryCandidates({ limit: 1 });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.dispatchId).toBe(f.request.dispatchId);
        expect(candidates[0]?.snapshot._tag).toBe("Success");
        expect((yield* f.journal.claimEffect(reserved.fence).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT revision,claim_generation FROM project_team_dispatch`).toEqual([
          { revision: 0, claim_generation: 0 },
        ]);
      }),
    ),
);

it.effect("a corrupt retained row remains a bounded recovery candidate with a failed decode", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.reserve(f.request);
      // Simulate restored state whose mutable scalar no longer matches its immutable intent.
      yield* f.sql`UPDATE project_team_dispatch SET updated_at='invalid-clock'`;
      expect((yield* f.journal.readRecoveryPage({ limit: 1 }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      const candidates = yield* f.journal.readRecoveryCandidates({ limit: 1 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.dispatchId).toBe(f.request.dispatchId);
      expect(candidates[0]?.snapshot._tag).toBe("Failure");
      expect(
        yield* f.journal.readRecoveryCandidates({
          afterDispatchId: f.request.dispatchId,
          limit: 1,
        }),
      ).toEqual([]);
      expect(
        (yield* f.journal.readRecoveryCandidates({ limit: 129 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT dispatch_id,stage FROM project_team_dispatch`).toEqual([
        { dispatch_id: f.request.dispatchId, stage: "reserved" },
      ]);
    }),
  ),
);

it.effect(
  "retained cleanup stages remain recordable after expiry and never release the writer",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        yield* TestClock.setTime(claimed.intent.limits.deadlineAtMs);
        const cleanup = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          // Sequencing control only: actual physical owner/drain verification is a required Root port.
          verifyStage: (receipt) =>
            receipt.stage === "stopping"
              ? Effect.void
              : Effect.fail(
                  new ProjectTeamDispatchJournalError({ reason: "No physical forward receipt" }),
                ),
        });
        const stopped = yield* cleanup.advanceStage(claimed.fence, {
          receiptId: "stop",
          stage: "stopping",
          evidence: { owner: "retained" },
        });
        expect(stopped.fence.stage).toBe("stopping");
        expect((yield* cleanup.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (r) => r.kind === "reservation",
          )?.status,
        ).toBe("held");
        expect(
          (yield* cleanup.readStageReceipts(f.request.dispatchId)).map((r) => r.stage),
        ).toEqual(["stopping"]);
      }),
    ),
);

it.effect(
  "final stage authorization rejects binding projection loss during receipt verification",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`.pipe(
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({ reason: "Control SQL verifier failed" }),
              ),
            ),
        });
        expect(
          (yield* journal
            .advanceStage(claimed.fence, {
              receiptId: "workspace",
              stage: "workspace-ready",
              evidence: {},
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "reserved", revision: 1 },
        ]);
        expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
        // The verifier's controlled SQL mutation is rolled back with the denied stage.
        expect(
          yield* f.sql`SELECT record_id FROM project_team_run_binding WHERE record_id='binding'`,
        ).toEqual([{ record_id: "binding" }]);
      }),
    ),
);

for (const corruption of ["generation", "revision", "time", "stage"] as const)
  it.effect(`retained receipt corruption cannot become stage evidence: ${corruption}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
        });
        const receipt = { receiptId: "workspace", stage: "workspace-ready" as const, evidence: {} };
        yield* journal.advanceStage(claimed.fence, receipt);
        // Restore corruption is injected only after removing the actual append-only update guard.
        yield* f.sql`DROP TRIGGER project_team_dispatch_receipt_no_update`;
        if (corruption === "generation")
          yield* f.sql`UPDATE project_team_dispatch_receipt SET claim_generation=0`;
        if (corruption === "revision")
          yield* f.sql`UPDATE project_team_dispatch_receipt SET revision=50`;
        if (corruption === "time")
          yield* f.sql`UPDATE project_team_dispatch_receipt SET recorded_at='invalid-clock'`;
        if (corruption === "stage")
          yield* f.sql`UPDATE project_team_dispatch_receipt SET stage='setup-complete'`;
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "workspace-ready", revision: 2 },
        ]);
      }),
    ),
  );

for (const stage of ["stopping", "quarantine"] as const)
  it.effect(`cleanup stage denies current forward execution before expiry: ${stage}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
        });
        const stopped = yield* journal.advanceStage(claimed.fence, {
          receiptId: stage,
          stage,
          evidence: {},
        });
        expect((yield* journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* journal.reserve(f.request).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* journal.readRetained(f.request.dispatchId)).toEqual({
          fence: stopped.fence,
          intent: stopped.intent,
        });
        expect(
          (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (r) => r.kind === "reservation",
          )?.status,
        ).toBe("held");
      }),
    ),
  );
