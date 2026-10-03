import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  CommandId,
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
import { ProjectLifecycle, ProjectLifecycleLive } from "../project/ProjectLifecycle.ts";
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

const receipt = { receiptId: "workspace", stage: "workspace-ready" as const, evidence: {} };

it.effect("control: expiry reached inside verifier denies forward receipt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () => TestClock.setTime(claimed.intent.limits.deadlineAtMs),
      });
      const result = yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result);
      const rows = yield* f.sql`SELECT stage,revision FROM project_team_dispatch`;
      expect(result._tag).toBe("Failure");
      expect(rows).toEqual([{ stage: "reserved", revision: 1 }]);
    }),
  ),
);

it.effect("forward receipt must recheck the clock after awaited final authority reads", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      let verified = false;
      let clockChanged = false;
      const observingSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (verified && statement.compile()[0].includes("SELECT maximum_tokens,deadline_at_ms")) {
            return statement.pipe(
              Effect.tap(() => {
                clockChanged = true;
                return TestClock.setTime(claimed.intent.limits.deadlineAtMs);
              }),
            );
          }
          return statement;
        },
      });
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          Effect.sync(() => {
            verified = true;
          }),
      }).pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
      const result = yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result);
      expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
        { stage: "reserved", revision: 1 },
      ]);
      const receipts = yield* f.sql`SELECT stage,recorded_at FROM project_team_dispatch_receipt`;
      expect(clockChanged).toBe(true);
      expect(result._tag).toBe("Failure");
      expect(receipts).toEqual([]);
    }),
  ),
);

it.effect("control: stage CAS denies verifier mutation and rolls it back", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          f.sql`UPDATE project_team_dispatch SET stage='quarantine'`.pipe(
            Effect.asVoid,
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Control SQL failed" }),
            ),
          ),
      });
      const result = yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result);
      const rows = yield* f.sql`SELECT stage,revision FROM project_team_dispatch`;
      expect(result._tag).toBe("Failure");
      expect(rows).toEqual([{ stage: "reserved", revision: 1 }]);
      expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
    }),
  ),
);

it.effect(
  "control: exact replay after a later valid stage calls the verifier only once per new receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let calls = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        const workspace = yield* journal.advanceStage(claimed.fence, receipt);
        const setup = yield* journal.advanceStage(workspace.fence, {
          receiptId: "setup",
          stage: "setup-complete",
          evidence: {},
        });
        const replay = yield* journal.advanceStage(claimed.fence, receipt);
        expect(calls).toBe(2);
        expect(replay.duplicate).toBe(true);
        expect(replay.fence).toEqual(setup.fence);
      }),
    ),
);

it.effect(
  "retained history must reject a future-stage receipt while its dispatch is reserved",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        yield* f.sql`INSERT INTO project_team_dispatch_receipt VALUES
    ('restored-future', 'dispatch-intent', 1, 1, 'assignment-observed', '{}', ${at})`;
        const result = yield* f.journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
    ),
);

it.effect(
  "retained history must reject an impossible older stage even if the latest stage matches",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
        });
        const workspace = yield* journal.advanceStage(claimed.fence, receipt);
        const setupReceipt = { receiptId: "setup", stage: "setup-complete" as const, evidence: {} };
        const setup = yield* journal.advanceStage(workspace.fence, setupReceipt);
        yield* f.sql`DROP TRIGGER project_team_dispatch_receipt_no_update`;
        yield* f.sql`UPDATE project_team_dispatch_receipt SET stage='assignment-observed' WHERE receipt_id='workspace'`;
        const read = yield* journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result);
        const duplicate = yield* journal
          .advanceStage(workspace.fence, setupReceipt)
          .pipe(Effect.result);
        const progression = yield* journal
          .advanceStage(setup.fence, { receiptId: "session", stage: "session-bound", evidence: {} })
          .pipe(Effect.result);
        expect({
          read: read._tag,
          duplicate: duplicate._tag,
          progression: progression._tag,
        }).toEqual({ read: "Failure", duplicate: "Failure", progression: "Failure" });
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "setup-complete", revision: 3 },
        ]);
      }),
    ),
);

it.effect("malformed row identity must not make a bounded recovery cursor unusable", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.reserve(f.request);
      const binding = (yield* f.sql<
        Record<string, unknown>
      >`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0];
      const row = (yield* f.sql<Record<string, unknown>>`SELECT * FROM project_team_dispatch`)[0];
      if (!binding || !row) return yield* Effect.die("Missing control rows");
      yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({ ...binding, record_id: "restored-binding", attempt_id: "restored-attempt" })}`;
      const corruptId = "a".repeat(257);
      yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({
        ...row,
        dispatch_id: corruptId,
        binding_id: "restored-binding",
        attempt_id: "restored-attempt",
        worktree: "/restored-workspace",
      })}`;
      const first = yield* f.journal.readRecoveryCandidates({ limit: 1 });
      const cursor = first[0]?.position;
      if (!cursor) return yield* Effect.die("Missing corrupt candidate");
      const second = yield* f.journal
        .readRecoveryCandidates({ limit: 1, afterPosition: cursor })
        .pipe(Effect.result);
      expect(
        (yield* f.journal.readRecoveryCandidates({ limit: 2 })).map(
          (candidate) => candidate.snapshot._tag,
        ),
      ).toEqual(["Failure", "Success"]);
      expect(first[0]?.snapshot._tag).toBe("Failure");
      expect(second._tag).toBe("Success");
      if (second._tag === "Success")
        expect(second.success[0]?.dispatchId).toBe(f.request.dispatchId);
    }),
  ),
);

it.effect("control: malformed data under a valid ID allows recovery to reach the later owner", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.reserve(f.request);
      const binding = (yield* f.sql<
        Record<string, unknown>
      >`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0];
      const row = (yield* f.sql<Record<string, unknown>>`SELECT * FROM project_team_dispatch`)[0];
      if (!binding || !row) return yield* Effect.die("Missing control rows");
      yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({ ...binding, record_id: "restored-binding", attempt_id: "restored-attempt" })}`;
      yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({
        ...row,
        dispatch_id: "a-corrupt",
        binding_id: "restored-binding",
        attempt_id: "restored-attempt",
        worktree: "/restored-workspace",
      })}`;
      const first = yield* f.journal.readRecoveryCandidates({ limit: 1 });
      const cursor = first[0]?.dispatchId;
      if (typeof cursor !== "string") return yield* Effect.die("Missing legacy cursor");
      const second = yield* f.journal.readRecoveryCandidates({ limit: 1, afterDispatchId: cursor });
      expect(first[0]?.snapshot._tag).toBe("Failure");
      expect(second[0]?.snapshot._tag).toBe("Success");
      expect(second[0]?.dispatchId).toBe(f.request.dispatchId);
    }),
  ),
);

for (const boundary of ["lease-read", "receipt-write"] as const) {
  it.effect(`late expiry at ${boundary} rolls back forward stage admission`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const transition = f.request.claim.transition;
        if (transition?.kind !== "claim") return yield* Effect.die("Missing claim");
        const leaseDeadline = Date.parse(at) + 500;
        const request =
          boundary === "lease-read"
            ? {
                ...f.request,
                claim: {
                  ...f.request.claim,
                  transition: {
                    ...transition,
                    claim: { ...transition.claim, leasedUntil: "2026-01-01T00:00:00.500Z" },
                  },
                },
              }
            : f.request;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(request)).fence);
        let verified = false;
        let expired = false;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            const query = statement.compile()[0];
            if (
              verified &&
              (boundary === "lease-read"
                ? query.includes("SELECT maximum_tokens,deadline_at_ms")
                : query.includes("INSERT INTO project_team_dispatch_receipt"))
            ) {
              return statement.pipe(
                Effect.tap(() => {
                  expired = true;
                  return TestClock.setTime(
                    boundary === "lease-read" ? leaseDeadline : claimed.intent.limits.deadlineAtMs,
                  );
                }),
              );
            }
            return statement;
          },
        });
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              verified = true;
            }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        const result = yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result);
        expect(expired).toBe(true);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            reason:
              boundary === "lease-read"
                ? "Dispatch lease expired or changed"
                : "Frozen attempt deadline expired",
          });
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "reserved", revision: 1 },
        ]);
        expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
        // Cleanup keeps ownership after the same expiry instead of granting another forward stage.
        expect(
          (yield* journal.advanceStage(claimed.fence, {
            receiptId: "expired-stop",
            stage: "stopping",
            evidence: {},
          })).fence.stage,
        ).toBe("stopping");
      }),
    ),
  );
}

const restoredRecoveryFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const reserved = yield* f.journal.reserve(f.request);
  const binding = (yield* f.sql<
    Record<string, unknown>
  >`SELECT * FROM project_team_run_binding WHERE record_id='binding'`)[0];
  const row = (yield* f.sql<Record<string, unknown>>`SELECT * FROM project_team_dispatch`)[0];
  if (!binding || !row) return yield* Effect.die("Missing restored control rows");
  const insert = Effect.fn(function* (dispatchId: string | null | Uint8Array, ordinal: number) {
    const bindingId = `restored-binding-${ordinal}`;
    const attemptId = `restored-attempt-${ordinal}`;
    yield* f.sql`INSERT INTO project_team_run_binding ${f.sql.insert({ ...binding, record_id: bindingId, attempt_id: attemptId })}`;
    yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...row, dispatch_id: dispatchId, binding_id: bindingId, attempt_id: attemptId, worktree: `/restored-workspace-${ordinal}` })}`;
  });
  return { ...f, reserved, insert };
});

for (const actualClaim of [false, true])
  it.effect(`invented header claim baseline cannot authorize a verifier: ${actualClaim}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        if (actualClaim) yield* f.journal.claimEffect(reserved.fence);
        const invented = actualClaim ? 2 : 1;
        yield* f.sql`UPDATE project_team_dispatch SET revision=${invented},claim_generation=${invented}`;
        let calls = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        const history = yield* journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result);
        const result = yield* journal
          .advanceStage(
            { ...reserved.fence, revision: invented, claimGeneration: invented },
            receipt,
          )
          .pipe(Effect.result);
        expect({ history: history._tag, admission: result._tag, calls }).toEqual({
          history: "Failure",
          admission: "Failure",
          calls: 0,
        });
        expect(
          yield* f.sql`SELECT stage,revision,claim_generation FROM project_team_dispatch`,
        ).toEqual([{ stage: "reserved", revision: invented, claim_generation: invented }]);
        expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
        const effect = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.kind === "effect" && r.effectId === f.request.dispatchId,
        );
        expect(effect).toMatchObject({
          status: actualClaim ? "claimed" : "pending",
          claimGeneration: actualClaim ? 1 : 0,
        });
      }),
    ),
  );

it.effect("BLOB recovery keys have null diagnostics and resumable raw positions", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* restoredRecoveryFixture;
      yield* f.insert(new Uint8Array([1, 2, 3]), 0);
      yield* f.insert(new Uint8Array([1, 2, 4]), 1);
      const candidates = yield* f.journal.readRecoveryCandidates({ limit: 3 });
      expect(candidates.map((value) => value.dispatchId)).toEqual([
        f.request.dispatchId,
        null,
        null,
      ]);
      expect(candidates.map((value) => value.snapshot._tag)).toEqual([
        "Success",
        "Failure",
        "Failure",
      ]);
      const first = candidates[1];
      const second = candidates[2];
      if (!first || !second) return yield* Effect.die("Missing BLOB diagnostics");
      expect(first.position.dispatchIdHash).toBe(
        "49dca94a9788a66a62a139e86f6c0753caad873093967f9adfd331cd986a7cde",
      );
      expect(first.position.dispatchIdHash).not.toBe(second.position.dispatchIdHash);
      expect(
        yield* f.journal.readRecoveryCandidates({ limit: 1, afterPosition: first.position }),
      ).toEqual([second]);
      expect(
        yield* f.journal.readRecoveryCandidates({ limit: 1, afterPosition: second.position }),
      ).toEqual([]);
      expect(yield* f.journal.readRetained(f.request.dispatchId)).toEqual(f.reserved);
    }),
  ),
);

for (const boundary of ["before-verifier", "after-verifier", "after-append"] as const)
  it.effect(`committed effect SQL disagreement denies forward admission at ${boundary}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let calls = 0;
        let changed = false;
        const change =
          f.sql`UPDATE project_team_effect SET status='canceled' WHERE unique_key=${f.request.dispatchId}`.pipe(
            Effect.asVoid,
          );
        if (boundary === "before-verifier") yield* change;
        const observingSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              boundary === "after-append" &&
              statement.compile()[0].includes("INSERT INTO project_team_dispatch_receipt")
            )
              return statement.pipe(
                Effect.tap(() => change),
                Effect.tap(() =>
                  Effect.sync(() => {
                    changed = true;
                  }),
                ),
              );
            return statement;
          },
        });
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }).pipe(
              Effect.andThen(
                boundary === "after-verifier"
                  ? change.pipe(
                      Effect.mapError(
                        () => new ProjectTeamDispatchJournalError({ reason: "Control SQL failed" }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        }).pipe(Effect.provideService(SqlClient.SqlClient, observingSql));
        expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(calls).toBe(boundary === "before-verifier" ? 0 : 1);
        if (boundary === "after-append") expect(changed).toBe(true);
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "reserved", revision: 1 },
        ]);
        expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
        expect(yield* f.sql`SELECT status FROM project_team_effect`).toEqual([
          { status: boundary === "before-verifier" ? "canceled" : "claimed" },
        ]);
      }),
    ),
  );

it.effect("revoked member and terminal effect retain cleanup history and held ownership", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const state = yield* readCurrentState(f.sql, projectId);
      const member = state.foundationRecords?.find((value) => value.kind === "member");
      const effect = state.foundationRecords?.find((value) => value.kind === "effect");
      if (member?.kind !== "member" || effect?.kind !== "effect")
        return yield* Effect.die("Missing authority records");
      yield* f.repository.execute(
        yield* decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "stop-member-and-effect",
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [
            { ...member, revision: member.revision + 1, status: "paused" },
            { ...effect, revision: effect.revision + 1, status: "canceled" },
          ],
        }),
      );
      let calls = 0;
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          Effect.sync(() => {
            calls++;
          }),
      });
      expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(calls).toBe(0);
      expect(yield* journal.readRetained(f.request.dispatchId)).toEqual(claimed);
      expect(yield* journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
      const stopped = yield* journal.advanceStage(claimed.fence, {
        receiptId: "stop-member",
        stage: "stopping",
        evidence: {},
      });
      expect(
        (yield* journal.readStageReceipts(f.request.dispatchId)).map((value) => value.stage),
      ).toEqual(["stopping"]);
      expect(
        (yield* journal.advanceStage(claimed.fence, {
          receiptId: "stop-member",
          stage: "stopping",
          evidence: {},
        })).fence,
      ).toEqual(stopped.fence);
      expect(calls).toBe(1);
      expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
        { status: "held" },
      ]);
    }),
  ),
);

it.effect(
  "actual project deletion preserves retained stopping and quarantine without execution proof",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let calls = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        const workspace = yield* journal.advanceStage(claimed.fence, receipt);
        yield* Effect.gen(function* () {
          const lifecycle = yield* ProjectLifecycle;
          yield* lifecycle.permanentDelete({
            projectId,
            commandId: CommandId.make("delete-retained-journal"),
            workspaceRoot: "/workspace",
            confirmation: "permanent-local-delete",
          });
        }).pipe(Effect.provide(ProjectLifecycleLive));
        for (const table of [
          "project_team_effect",
          "project_work_events",
          "project_work_command_receipts",
        ])
          expect(yield* f.sql`SELECT * FROM ${f.sql(table)} WHERE project_id=${projectId}`).toEqual(
            [],
          );
        expect(
          yield* f.sql`SELECT state FROM project_lifecycle WHERE project_id=${projectId}`,
        ).toEqual([{ state: "tombstoned" }]);
        expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(workspace.fence);
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId)).map((value) => value.stage),
        ).toEqual(["workspace-ready"]);
        expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* journal
            .advanceStage(workspace.fence, {
              receiptId: "deleted-setup",
              stage: "setup-complete",
              evidence: {},
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(calls).toBe(1);
        const stopped = yield* journal.advanceStage(workspace.fence, {
          receiptId: "deleted-stop",
          stage: "stopping",
          evidence: {},
        });
        const quarantine = yield* journal.advanceStage(stopped.fence, {
          receiptId: "deleted-quarantine",
          stage: "quarantine",
          evidence: {},
        });
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId)).map((value) => value.stage),
        ).toEqual(["workspace-ready", "stopping", "quarantine"]);
        expect(
          (yield* journal.advanceStage(workspace.fence, {
            receiptId: "deleted-stop",
            stage: "stopping",
            evidence: {},
          })).fence,
        ).toEqual(quarantine.fence);
        expect(yield* f.sql`SELECT stage,claim_generation FROM project_team_dispatch`).toEqual([
          { stage: "quarantine", claim_generation: 1 },
        ]);
        expect(calls).toBe(3);
      }),
    ),
);

for (const loss of ["event", "command", "fingerprint", "effect"] as const)
  it.effect(`active history and forward admission require committed ${loss} proof`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const command = (yield* f.sql<{
          command_id: string;
        }>`SELECT command_id FROM project_work_events WHERE event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.kind')='effect' AND json_extract(payload_json,'$.record.status')='claimed'`)[0];
        if (!command) return yield* Effect.die("Missing committed claim event");
        if (loss === "event")
          yield* f.sql`DELETE FROM project_work_events WHERE command_id=${command.command_id}`;
        if (loss === "command")
          yield* f.sql`DELETE FROM project_work_command_receipts WHERE command_id=${command.command_id}`;
        if (loss === "fingerprint")
          yield* f.sql`UPDATE project_work_command_receipts SET payload_fingerprint='invented' WHERE command_id=${command.command_id}`;
        if (loss === "effect")
          yield* f.sql`DELETE FROM project_team_effect WHERE unique_key=${f.request.dispatchId}`;
        let calls = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(calls).toBe(0);
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: "reserved", revision: 1 },
        ]);
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
          { status: "held" },
        ]);
      }),
    ),
  );

for (const duplicate of [false, true])
  it.effect(`claim proof reads recheck execution time before receipt return: ${duplicate}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const original = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
        });
        const workspace = duplicate
          ? yield* original.advanceStage(claimed.fence, receipt)
          : undefined;
        let authorityRead = false;
        let expired = false;
        let calls = 0;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            const query = statement.compile()[0];
            if (query.includes("SELECT maximum_tokens,deadline_at_ms"))
              return statement.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    authorityRead = true;
                  }),
                ),
              );
            if (authorityRead && query.includes("SELECT * FROM project_work_command_receipts"))
              return statement.pipe(
                Effect.tap(() => TestClock.setTime(claimed.intent.limits.deadlineAtMs)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    expired = true;
                  }),
                ),
              );
            return statement;
          },
        });
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              calls++;
            }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(expired).toBe(true);
        expect(calls).toBe(0);
        expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
          { stage: workspace ? "workspace-ready" : "reserved", revision: workspace ? 2 : 1 },
        ]);
        expect((yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).length).toBe(
          duplicate ? 1 : 0,
        );
      }),
    ),
  );

it.effect(
  "private recovery positions traverse null ties, empty and oversized IDs without granting execution",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* restoredRecoveryFixture;
        const rawIds = [null, null, "", "a".repeat(257), f.request.dispatchId];
        for (const [ordinal, dispatchId] of rawIds.slice(0, -1).entries())
          yield* f.insert(dispatchId, ordinal);
        const first = yield* f.journal.readRecoveryCandidates({ limit: 1 });
        const candidate = first[0];
        if (!candidate) return yield* Effect.die("Missing first diagnostic");
        const visited = [candidate];
        for (let page = 1; page < rawIds.length; page++) {
          const previous = visited[page - 1];
          if (!previous) return yield* Effect.die("Missing previous recovery owner");
          const next = yield* f.journal.readRecoveryCandidates({
            limit: 1,
            afterPosition: previous.position,
          });
          expect(next).toHaveLength(1);
          if (!next[0]) return yield* Effect.die("Lost bounded recovery owner");
          visited.push(next[0]);
        }
        expect(visited.map((value) => value.dispatchId)).toEqual(rawIds);
        expect(visited.map((value) => value.snapshot._tag)).toEqual([
          "Failure",
          "Failure",
          "Failure",
          "Failure",
          "Success",
        ]);
        expect(new Set(visited.map((value) => value.position.rowId)).size).toBe(rawIds.length);
        expect(new Set(visited.map((value) => value.position.dispatchIdHash)).size).toBe(4);
        const last = visited.at(-1);
        if (!last) return yield* Effect.die("Missing final recovery owner");
        expect(
          yield* f.journal.readRecoveryCandidates({
            limit: 1,
            afterPosition: last.position,
          }),
        ).toEqual([]);
        const samePage = yield* f.journal.readRecoveryCandidates({ limit: 5 });
        expect(samePage.map((value) => value.snapshot._tag)).toEqual(
          visited.map((value) => value.snapshot._tag),
        );
        for (const dispatchId of ["", "a".repeat(257)]) {
          expect(
            (yield* f.journal.claimEffect({ ...f.reserved.fence, dispatchId }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* f.journal
              .readRecoveryCandidates({ limit: 1, afterDispatchId: dispatchId })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(yield* f.journal.readRetained(f.request.dispatchId)).toEqual(f.reserved);
      }),
    ),
);

for (const change of ["missing", "reused", "hash", "environment"] as const) {
  it.effect(`private recovery position rejects a ${change} owner`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* restoredRecoveryFixture;
        yield* f.insert("a".repeat(257), 0);
        const original = (yield* f.journal.readRecoveryCandidates({ limit: 1 }))[0];
        if (!original) return yield* Effect.die("Missing corrupt diagnostic");
        const { position } = original;
        if (change === "missing" || change === "reused") {
          const previous = (yield* f.sql<
            Record<string, unknown>
          >`SELECT * FROM project_team_dispatch WHERE rowid=CAST(${position.rowId} AS INTEGER)`)[0];
          if (!previous) return yield* Effect.die("Missing cursor owner");
          yield* f.sql`DELETE FROM project_team_dispatch WHERE rowid=CAST(${position.rowId} AS INTEGER)`;
          if (change === "reused")
            yield* f.sql`INSERT INTO project_team_dispatch ${f.sql.insert({ ...previous, rowid: position.rowId, dispatch_id: "a-reused" })}`;
        }
        const journal =
          change === "environment"
            ? yield* makeProjectTeamDispatchJournal({
                environmentId: "other-environment",
                maximumEnvironmentModelCalls: 4,
              })
            : f.journal;
        const cursor =
          change === "hash" ? { ...position, dispatchIdHash: "0".repeat(64) } : position;
        const result = yield* journal
          .readRecoveryCandidates({ limit: 1, afterPosition: cursor })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            reason: "Recovery continuation owner is missing or changed",
          });
        if (change === "hash")
          expect(
            (yield* f.journal.readRecoveryCandidates({ limit: 1, afterPosition: position }))[0]
              ?.dispatchId,
          ).toBe(f.request.dispatchId);
      }),
    ),
  );
}

it.effect("private recovery rejects ambiguous, noncanonical and unbounded cursors", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* restoredRecoveryFixture;
      const candidate = (yield* f.journal.readRecoveryCandidates({ limit: 1 }))[0];
      if (!candidate) return yield* Effect.die("Missing recovery owner");
      expect(
        (yield* f.journal
          .readRecoveryCandidates({
            limit: 1,
            afterPosition: candidate.position,
            afterDispatchId: f.request.dispatchId,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      for (const rowId of ["01", "-0", "1.0", "9223372036854775808", "999999999999999999999"]) {
        expect(
          (yield* f.journal
            .readRecoveryCandidates({ limit: 1, afterPosition: { ...candidate.position, rowId } })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(
        (yield* f.journal.readRecoveryCandidates({ limit: 129 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("complete forward and cleanup history remains replayable after expiry", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      let calls = 0;
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          Effect.sync(() => {
            calls++;
          }),
      });
      let latest = claimed;
      const stages = [
        "workspace-ready",
        "setup-complete",
        "session-bound",
        "assignment-intent",
        "assignment-observed",
      ] as const;
      for (const stage of stages)
        latest = yield* journal.advanceStage(latest.fence, {
          receiptId: stage,
          stage,
          evidence: {},
        });
      expect(
        (yield* journal.readStageReceipts(f.request.dispatchId)).map((value) => value.stage),
      ).toEqual(stages);
      const replay = yield* journal.advanceStage(claimed.fence, {
        receiptId: stages[0],
        stage: stages[0],
        evidence: {},
      });
      expect(replay.duplicate).toBe(true);
      expect(replay.fence).toEqual(latest.fence);
      yield* TestClock.setTime(claimed.intent.limits.deadlineAtMs);
      const stopped = yield* journal.advanceStage(latest.fence, {
        receiptId: "stop",
        stage: "stopping",
        evidence: {},
      });
      const quarantine = yield* journal.advanceStage(stopped.fence, {
        receiptId: "quarantine",
        stage: "quarantine",
        evidence: {},
      });
      expect(
        (yield* journal.readStageReceipts(f.request.dispatchId)).map((value) => value.stage),
      ).toEqual([...stages, "stopping", "quarantine"]);
      expect(
        (yield* journal.advanceStage(latest.fence, {
          receiptId: "stop",
          stage: "stopping",
          evidence: {},
        })).fence,
      ).toEqual(quarantine.fence);
      expect(calls).toBe(7);
    }),
  ),
);

it.effect("history injected during stage verification rolls back with the forward write", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          f.sql`INSERT INTO project_team_dispatch_receipt VALUES ('injected', 'dispatch-intent', 1, 1, 'assignment-observed', '{}', ${at})`.pipe(
            Effect.asVoid,
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Control SQL failed" }),
            ),
          ),
      });
      expect((yield* journal.advanceStage(claimed.fence, receipt).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT stage,revision FROM project_team_dispatch`).toEqual([
        { stage: "reserved", revision: 1 },
      ]);
      expect(yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt`).toEqual([]);
    }),
  ),
);
