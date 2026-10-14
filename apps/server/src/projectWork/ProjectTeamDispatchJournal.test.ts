import { expect, it } from "@effect/vitest";
import {
  ProjectWorkFoundationCommitCommand,
  CommandId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectTeamExecutionHost } from "./ProjectTeamExecutionHost.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlError from "effect/unstable/sql/SqlError";
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
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamDispatchJournalError,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);

const makeFixture = (role: "implementer" | "integrator" = "implementer") =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const result = yield* seed(role, "reserved", {
      roleTools: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
      toolIds: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
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
const fixture = makeFixture();

it.effect("revalidates the admission loan before any domain writes and rolls back denial", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* readCurrentState(f.sql, projectId);
      let checked = false;
      const result = yield* f.journal
        .reserve(f.request, {
          beforeDomainWrite: Effect.gen(function* () {
            checked = true;
            expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(before.revision);
            expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toHaveLength(0);
            return yield* new ProjectTeamDispatchJournalError({ reason: "Physical input changed" });
          }).pipe(
            Effect.mapError(
              () => new ProjectTeamDispatchJournalError({ reason: "Physical input changed" }),
            ),
          ),
        })
        .pipe(Effect.result);
      expect(checked).toBe(true);
      expect(result._tag).toBe("Failure");
      expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(before.revision);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(0);
      expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toHaveLength(0);
    }),
  ),
);

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

it.effect(
  "settlement retains complete terminal history after expiry without releasing capacity",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let verified = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              verified++;
            }),
        });
        yield* TestClock.setTime(claimed.intent.limits.deadlineAtMs);
        const stopped = yield* journal.advanceStage(claimed.fence, {
          receiptId: "settlement-stop",
          stage: "stopping",
          evidence: {},
        });
        const terminal = {
          receiptId: "settlement-joined",
          stage: "settled",
          evidence: { joined: true },
        } as const;
        const settled = yield* journal.advanceStage(stopped.fence, terminal);
        expect(settled.fence.stage).toBe("settled");
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId)).map((r) => r.stage),
        ).toEqual(["stopping", "settled"]);
        expect((yield* journal.advanceStage(stopped.fence, terminal)).duplicate).toBe(true);
        expect(verified).toBe(2);
        expect((yield* journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* journal.readRecoveryPage({ limit: 128 })).toEqual([]);
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
          { status: "held" },
        ]);
        for (const stage of ["stopping", "quarantine", "settled", "workspace-ready"] as const)
          expect(
            (yield* journal
              .advanceStage(settled.fence, { receiptId: `after-${stage}`, stage, evidence: {} })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(verified).toBe(2);
      }),
    ),
);

it.effect("settlement rejects unproven drain and rolls back both header and receipt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      let verified = 0;
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () =>
          Effect.sync(() => {
            verified++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProjectTeamDispatchJournalError({ reason: "Writer drain is uncertain" }),
              ),
            ),
          ),
      });
      expect(
        (yield* journal
          .advanceStage(claimed.fence, {
            receiptId: "settlement-unproven",
            stage: "settled",
            evidence: {},
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(verified).toBe(1);
      expect((yield* f.journal.readRetained(f.request.dispatchId)).fence).toEqual(claimed.fence);
      expect(yield* f.journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
      expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
        { status: "held" },
      ]);
    }),
  ),
);

for (const canceled of [false, true]) {
  it.effect(`settlement cleans unclaimed reservation without inventing a claim: ${canceled}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const reserved = yield* f.journal.reserve(f.request);
        if (canceled) {
          const state = yield* readCurrentState(f.sql, projectId);
          const effect = state.foundationRecords?.find((r) => r.kind === "effect");
          if (effect?.kind !== "effect") return yield* Effect.die("Missing original effect");
          yield* f.repository.execute(
            yield* decodeCommit({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "cancel-before-effect-claim",
              expectedRevision: state.revision,
              attribution,
              committedAt: at,
              records: [{ ...effect, revision: effect.revision + 1, status: "canceled" }],
            }),
          );
        }
        let verified = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () =>
            Effect.sync(() => {
              verified++;
            }),
        });
        yield* TestClock.setTime(reserved.intent.limits.deadlineAtMs);
        const stopped = yield* journal.advanceStage(reserved.fence, {
          receiptId: "settlement-unclaimed-stop",
          stage: "stopping",
          evidence: { neverClaimed: true },
        });
        const settled = yield* journal.advanceStage(stopped.fence, {
          receiptId: "settlement-unclaimed-joined",
          stage: "settled",
          evidence: { neverClaimed: true },
        });
        expect(settled.fence.claimGeneration).toBe(0);
        expect(settled.fence.revision).toBe(2);
        expect(
          (yield* journal.readStageReceipts(f.request.dispatchId)).map((r) => [
            r.stage,
            r.claimGeneration,
          ]),
        ).toEqual([
          ["stopping", 0],
          ["settled", 0],
        ]);
        expect((yield* journal.claimEffect(settled.fence).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          yield* f.sql`SELECT * FROM project_work_command_receipts WHERE command_id LIKE '%claim-dispatch%'`,
        ).toEqual([]);
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
          { status: "held" },
        ]);
        expect(verified).toBe(2);
      }),
    ),
  );
}

it.effect("settlement survives actual project deletion as cleanup knowledge only", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      yield* Effect.gen(function* () {
        const lifecycle = yield* ProjectLifecycle;
        yield* lifecycle.permanentDelete({
          projectId,
          commandId: CommandId.make("delete-before-settlement"),
          workspaceRoot: "/workspace",
          confirmation: "permanent-local-delete",
        });
      }).pipe(Effect.provide(ProjectLifecycleLive));
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () => Effect.void,
      });
      const terminal = {
        receiptId: "settlement-deleted-joined",
        stage: "settled",
        evidence: {},
      } as const;
      const settled = yield* journal.advanceStage(claimed.fence, terminal);
      expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(settled.fence);
      expect((yield* journal.readStageReceipts(f.request.dispatchId)).map((r) => r.stage)).toEqual([
        "settled",
      ]);
      expect((yield* journal.advanceStage(claimed.fence, terminal)).duplicate).toBe(true);
      expect((yield* journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.sql`SELECT * FROM project_team_effect WHERE project_id=${projectId}`).toEqual(
        [],
      );
    }),
  ),
);

it.effect("settlement rejects retained cleanup appended after the terminal receipt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () => Effect.void,
      });
      const settled = yield* journal.advanceStage(claimed.fence, {
        receiptId: "settlement-terminal",
        stage: "settled",
        evidence: {},
      });
      yield* f.sql`INSERT INTO project_team_dispatch_receipt VALUES ('after-terminal',${f.request.dispatchId},${settled.fence.revision + 1},1,'stopping','{}',${at})`;
      yield* f.sql`UPDATE project_team_dispatch SET stage='stopping',revision=${settled.fence.revision + 1} WHERE dispatch_id=${f.request.dispatchId}`;
      expect(
        (yield* journal.readStageReceipts(f.request.dispatchId).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

const joinedReceipt = {
  receiptId: "original-joined-owners",
  stage: "settled" as const,
  evidence: { worker: "joined", setup: "joined", transport: "drained" },
};

it.effect("joined settlement atomically closes binding, writer, effects and active attempt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: () => Effect.void,
        verifySettlement: () => Effect.void,
      });
      const settled = yield* journal.settleAfterJoined(claimed.fence, joinedReceipt);
      const state = yield* readCurrentState(f.sql, projectId);
      expect(state.foundationRecords?.find((r) => r.kind === "run-binding")?.status).toBe(
        "settled",
      );
      expect(
        state.foundationRecords?.filter((r) => r.kind === "reservation" && r.status === "held"),
      ).toEqual([]);
      expect(state.foundationRecords?.find((r) => r.kind === "reservation")?.status).toBe(
        "released",
      );
      expect(
        state.foundationRecords?.find((r) => r.kind === "effect" && r.effectKind === "dispatch")
          ?.status,
      ).toBe("canceled");
      expect(state.attempts[0]?.state).toBe("canceled");
      expect(
        state.tasks.find((t) => t.taskId === state.attempts[0]?.taskId)?.activeAttemptId,
      ).toBeUndefined();
      expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(settled.fence);
      const before = state.revision;
      expect((yield* journal.settleAfterJoined(claimed.fence, joinedReceipt)).duplicate).toBe(true);
      expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(before);
      expect(
        (yield* journal
          .settleAfterJoined(settled.fence, { ...joinedReceipt, receiptId: "different-owner" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect(
  "joined Pi failure reflects once with the allowance frozen by the original dispatch",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let preparedAllowance: number | undefined;
        let preparations = 0;
        const initializedState = yield* readCurrentState(f.sql, projectId);
        const binding = initializedState.foundationRecords?.find((r) => r.kind === "run-binding");
        if (binding?.kind !== "run-binding") return yield* Effect.die("Missing original binding");
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "pi-native-fixture",
            expectedRevision: initializedState.revision,
            records: [{ ...binding, status: "running", revision: binding.revision + 1 }],
            committedAt: at,
            attribution: {
              actor: { kind: "system", id: "pi-runtime" },
              source: { kind: "system", id: "pi-runtime" },
              recordedAt: at,
            },
          }),
        );
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareFailure: (snapshot) => {
            preparations++;
            preparedAllowance = Math.min(
              snapshot.intent.limits.repairAllowance,
              snapshot.intent.rootCaps.repairAllowance,
            );
            return Effect.succeed({
              fingerprint: "e".repeat(64),
              operationId: "original-pi-operation",
            });
          },
        });
        const settled = yield* journal.settleAfterJoined(claimed.fence, joinedReceipt);
        const state = yield* readCurrentState(f.sql, projectId);
        const episode = state.foundationRecords?.find((r) => r.kind === "repair-episode");
        expect(preparations).toBe(1);
        expect(episode).toMatchObject({
          failureFingerprint: "e".repeat(64),
          allowance: preparedAllowance,
          semanticRepairs: 0,
          pendingSemanticRepair: false,
          transportRetries: 0,
          timeoutCount: 0,
        });
        expect(state.tasks[0]).toMatchObject({ state: "blocked", failureKind: "manual-triage" });
        expect(state.blockers.some((blocker) => blocker.attention)).toBe(true);
        const revision = state.revision;
        expect((yield* journal.settleAfterJoined(claimed.fence, joinedReceipt)).duplicate).toBe(
          true,
        );
        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(revision);
        expect(preparations).toBe(1);
        expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(settled.fence);
      }),
    ),
);

for (const failureAt of ["before", "final"] as const)
  it.effect(
    `unjoined ${failureAt} verification preserves writer and rolls back every settlement write`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
          const before = yield* readCurrentState(f.sql, projectId);
          let checks = 0;
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 4,
            verifyStage: () => Effect.void,
            verifySettlement: () =>
              Effect.suspend(() => {
                checks++;
                return checks === (failureAt === "before" ? 1 : 2)
                  ? Effect.fail(
                      new ProjectTeamDispatchJournalError({
                        reason: "Original parent transport is still uncertain",
                      }),
                    )
                  : Effect.void;
              }),
          });
          expect(
            (yield* journal.settleAfterJoined(claimed.fence, joinedReceipt).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
          expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(claimed.fence);
          expect(yield* journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
        }),
      ),
  );

it.effect(
  "joined cleanup releases original writer after authority and configured capacity are revoked",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const state = yield* readCurrentState(f.sql, projectId);
        const binding = state.foundationRecords?.find((r) => r.kind === "run-binding");
        const limits = state.foundationRecords?.find((r) => r.kind === "limits");
        if (binding?.kind !== "run-binding" || limits?.kind !== "limits")
          return yield* Effect.die("missing original records");
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "revoke-before-join",
            expectedRevision: state.revision,
            attribution,
            committedAt: at,
            records: [
              { ...binding, status: "revoked", revision: binding.revision + 1 },
              {
                ...limits,
                status: "disabled",
                revision: limits.revision + 1,
                projectWritableWorkers: 0,
              },
            ],
          }),
        );
        yield* TestClock.setTime(Date.parse(at) + 10000);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
        });
        expect((yield* journal.inspect(f.request.dispatchId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* journal.settleAfterJoined(claimed.fence, joinedReceipt);
        const final = yield* readCurrentState(f.sql, projectId);
        expect(final.foundationRecords?.find((r) => r.kind === "run-binding")?.status).toBe(
          "settled",
        );
        expect(final.foundationRecords?.find((r) => r.kind === "reservation")?.status).toBe(
          "released",
        );
        expect(final.foundationRecords?.find((r) => r.kind === "limits")?.status).toBe("disabled");
      }),
    ),
);

it.effect("missing joined-owner verifier grants no terminal domain transition", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserved = yield* f.journal.reserve(f.request);
      const before = yield* readCurrentState(f.sql, projectId);
      expect(
        (yield* f.journal.settleAfterJoined(reserved.fence, joinedReceipt).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      expect((yield* f.journal.readRetained(f.request.dispatchId)).fence).toEqual(reserved.fence);
    }),
  ),
);

it.effect("integrator with only read tools still reserves its isolated setup writer", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture("integrator");
      const admitted = yield* f.journal.reserve(f.request);
      expect(admitted.intent.limits.writable).toBe(true);
      expect(admitted.intent.writableReservationId).toBeDefined();
      const state = yield* readCurrentState(f.sql, projectId);
      expect(
        state.foundationRecords?.filter((r) => r.kind === "reservation" && r.status === "held"),
      ).toHaveLength(1);
    }),
  ),
);

for (const table of [
  "project_team_run_binding",
  "project_team_reservation",
  "project_team_effect",
  "project_work_tasks",
  "project_work_attempts",
] as const)
  it.effect(`joined repair rejects ignored physical write: ${table}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const before = yield* readCurrentState(f.sql, projectId);
        const projection = table === "project_work_tasks" || table === "project_work_attempts";
        const status =
          table === "project_team_run_binding"
            ? "settled"
            : table === "project_team_reservation"
              ? "released"
              : "canceled";
        yield* f.sql
          .unsafe(`CREATE TRIGGER ignore_joined_write BEFORE ${projection ? "INSERT" : "UPDATE"} ON ${table}
      ${projection ? "" : `WHEN NEW.status='${status}'`} BEGIN SELECT RAISE(IGNORE); END`);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
        });
        expect(
          (yield* journal.settleAfterJoined(claimed.fence, joinedReceipt).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
        expect(yield* journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
        expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(claimed.fence);
        expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
          { status: "held" },
        ]);
        yield* f.sql`DROP TRIGGER ignore_joined_write`;
        expect((yield* journal.settleAfterJoined(claimed.fence, joinedReceipt)).duplicate).toBe(
          false,
        );
      }),
    ),
  );

for (const target of [
  "binding-payload",
  "writer-slot",
  "task-active-attempt",
  "attempt-ended-at",
] as const)
  it.effect(`joined repair rejects physical identity disagreement: ${target}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const before = yield* readCurrentState(f.sql, projectId);
        const queries = {
          "binding-payload":
            "CREATE TRIGGER corrupt_joined_write AFTER UPDATE ON project_team_run_binding WHEN NEW.status='settled' BEGIN UPDATE project_team_run_binding SET payload_json=json_set(payload_json,'$.threadId','wrong-thread') WHERE record_id=NEW.record_id; END",
          "writer-slot":
            "CREATE TRIGGER corrupt_joined_write AFTER UPDATE ON project_team_reservation WHEN NEW.status='released' BEGIN UPDATE project_team_reservation SET slot=slot+1 WHERE record_id=NEW.record_id; END",
          "task-active-attempt":
            "CREATE TRIGGER corrupt_joined_write AFTER INSERT ON project_work_tasks WHEN NEW.active_attempt_id IS NULL BEGIN UPDATE project_work_tasks SET active_attempt_id='wrong-attempt' WHERE task_id=NEW.task_id; END",
          "attempt-ended-at":
            "CREATE TRIGGER corrupt_joined_write AFTER INSERT ON project_work_attempts WHEN NEW.state='canceled' BEGIN UPDATE project_work_attempts SET ended_at=NULL WHERE attempt_id=NEW.attempt_id; END",
        };
        yield* f.sql.unsafe(queries[target]);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
        });
        expect(
          (yield* journal.settleAfterJoined(claimed.fence, joinedReceipt).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
        expect(yield* journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
        yield* f.sql`DROP TRIGGER corrupt_joined_write`;
        expect((yield* journal.settleAfterJoined(claimed.fence, joinedReceipt)).duplicate).toBe(
          false,
        );
      }),
    ),
  );

for (const extraStop of [false, true])
  for (const exhausted of [false, true])
    it.effect(
      `joined repair checks complete aggregate event headroom: extraStop=${extraStop} exhausted=${exhausted}`,
      () =>
        scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const claimed = yield* f.journal.claimEffect(
              (yield* f.journal.reserve(f.request)).fence,
            );
            if (extraStop) {
              const current = yield* readCurrentState(f.sql, projectId);
              const dispatch = current.foundationRecords?.find((r) => r.kind === "effect");
              if (dispatch?.kind !== "effect") return yield* Effect.die("missing original effect");
              yield* f.repository.execute(
                yield* decodeCommit({
                  type: "project-work.foundation.commit",
                  projectId,
                  commandId: "extra-stop-effect",
                  expectedRevision: current.revision,
                  attribution,
                  committedAt: at,
                  records: [
                    {
                      ...dispatch,
                      recordId: "extra-stop",
                      effectId: "extra-stop-effect",
                      effectKind: "stop",
                      status: "pending",
                      claimGeneration: 0,
                      revision: 0,
                    },
                  ],
                }),
              );
            }
            const count = extraStop ? 5 : 4;
            const initialRevision = Number.MAX_SAFE_INTEGER - count + (exhausted ? 1 : 0);
            yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.revision',${initialRevision}) WHERE project_id=${projectId}`;
            const before = yield* readCurrentState(f.sql, projectId);
            const journal = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: () => Effect.void,
              verifySettlement: () => Effect.void,
            });
            const result = yield* journal
              .settleAfterJoined(claimed.fence, joinedReceipt)
              .pipe(Effect.result);
            const final = yield* readCurrentState(f.sql, projectId);
            if (exhausted) {
              expect(result._tag).toBe("Failure");
              expect(final).toEqual(before);
              expect(yield* journal.readStageReceipts(f.request.dispatchId)).toEqual([]);
            } else {
              expect(result._tag).toBe("Success");
              expect(final.revision).toBe(Number.MAX_SAFE_INTEGER);
              const rows = yield* f.sql<{
                revision: number;
              }>`SELECT json_extract(payload_json,'$.revision') AS revision FROM project_work_events WHERE event_type IN ('project-work.foundation.recorded','project-work.attempt.stopped') AND json_extract(payload_json,'$.revision')>${initialRevision} ORDER BY sequence`;
              expect(rows.map((r) => r.revision)).toEqual(
                Array.from({ length: count }, (_, i) => initialRevision + i + 1),
              );
            }
          }),
        ),
    );

it.effect(
  "review preparation shares settlement transaction before advancement and is skipped on exact replay",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        let prepared = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: (snapshot, receipt) =>
            Effect.gen(function* () {
              expect(yield* SqlClient.SqlClient).toBe(f.sql);
              expect(Option.isSome(yield* Effect.serviceOption(f.sql.transactionService))).toBe(
                true,
              );
              expect(snapshot).toEqual(claimed);
              expect(receipt).toEqual(joinedReceipt);
              expect(
                yield* f.sql`SELECT stage FROM project_team_dispatch WHERE dispatch_id=${f.request.dispatchId}`,
              ).toEqual([{ stage: "reserved" }]);
              prepared++;
              return undefined;
            }),
        });
        const settled = yield* journal.settleAfterJoined(claimed.fence, joinedReceipt);
        expect(prepared).toBe(1);
        const before = yield* readCurrentState(f.sql, projectId);
        expect((yield* journal.settleAfterJoined(claimed.fence, joinedReceipt)).duplicate).toBe(
          true,
        );
        expect(prepared).toBe(1);
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
        expect((yield* journal.readRetained(f.request.dispatchId)).fence).toEqual(settled.fence);
      }),
    ),
);

it.effect(
  "review preparation SQL failure rolls back original joined settlement and preserves retry",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const before = yield* readCurrentState(f.sql, projectId);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: () =>
            f.sql`SELECT * FROM missing_review_proof_storage`.pipe(Effect.as(undefined)),
        });
        const result = yield* journal
          .settleAfterJoined(claimed.fence, joinedReceipt)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(PersistenceSqlError);
          if (isPersistenceSqlError(result.failure)) {
            expect(result.failure.operation).toBe("ProjectWorkRepository.executeAtomic");
            expect(SqlError.isSqlError(result.failure.cause)).toBe(true);
          }
        }
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
        expect(yield* journal.readRetained(f.request.dispatchId)).toEqual(claimed);
        expect(
          yield* f.sql`SELECT receipt_id FROM project_team_dispatch_receipt WHERE dispatch_id=${f.request.dispatchId} AND stage='settled'`,
        ).toEqual([]);
        const retry = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: () => Effect.succeed(undefined),
        });
        expect((yield* retry.settleAfterJoined(claimed.fence, joinedReceipt)).fence.stage).toBe(
          "settled",
        );
      }),
    ),
);

it.effect(
  "execution host constructs its trusted review consumer from full host configuration without execution",
  () =>
    scoped(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed("reviewer", "running", { issueCredential: false });
          const sql = yield* SqlClient.SqlClient;
          const before = yield* readCurrentState(sql, projectId);
          const counts = sql`SELECT
      (SELECT COUNT(*) FROM project_work_events) AS events,
      (SELECT COUNT(*) FROM project_work_command_receipts) AS receipts,
      (SELECT COUNT(*) FROM project_team_dispatch) AS dispatches,
      (SELECT COUNT(*) FROM project_team_review_completion_proposal) AS proposals`;
          const beforeCounts = yield* counts;
          // Construction captures services; unimplemented mocks trap any execution or native spawn.
          const result = yield* makeProjectTeamExecutionHost({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            protectedRoots: ["/protected"],
            launchPolicy: { memoryBytes: 536870912, runtimeSeconds: 30 },
            assertEnabled: Effect.die("Construction must not admit execution"),
          }).pipe(Effect.result);
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") yield* result.success.stop;
          expect(yield* readCurrentState(sql, projectId)).toEqual(before);
          expect(yield* counts).toEqual(beforeCounts);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ProviderService)({}),
              Layer.mock(ServerSettingsService)({}),
              Layer.mock(OrchestrationEngineService)({}),
              Layer.mock(ProjectionSnapshotQuery)({}),
              Layer.mock(GitWorkflowService)({}),
              Layer.mock(ProjectTeamPiRuntime)({}),
              Layer.mock(ChildProcessSpawner)({}),
              Layer.succeed(HostProcessPlatform, "linux"),
              Layer.succeed(HostProcessUserId, 1000),
            ),
          ),
        ),
      ),
    ),
);
