import { expect } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { at, attribution, projectId, seed } from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchRequest,
} from "./ProjectTeamDispatchJournal.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeProjectWorkVerificationJobs } from "./ProjectWorkVerificationJobs.ts";
import {
  makeProjectWorkVerificationPreparation,
  ProjectWorkVerificationPreparationError,
  ProjectWorkVerificationPreparationSelection,
} from "./ProjectWorkVerificationPreparation.ts";
const decodeReceipt = Schema.decodeUnknownEffect(ProjectTeamWorkspaceReceipt);
const decodeSelection = Schema.decodeUnknownEffect(ProjectWorkVerificationPreparationSelection);
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
export const makeVerificationFixture = Effect.fn("makeVerificationFixture")(function* (
  role: "implementer" | "integrator" = "implementer",
) {
  const f = yield* makeFixture(role);
  const claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
  const settling = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    verifyStage: () => Effect.void,
    verifySettlement: () => Effect.void,
  });
  // Controlled joined receipts exercise real SQL settlement; no native worker ran.
  const snapshot = yield* settling.settleAfterJoined(claimed.fence, {
    receiptId: "prepared-joined",
    stage: "settled",
    evidence: { worker: "joined", setup: "joined", transport: "drained" },
  });
  const receipt = yield* decodeReceipt({
    assignment: f.request.git,
    primary: { path: "/workspace", dev: "1", ino: "1" },
    worktree: { path: "/workspace-assigned", dev: "1", ino: "2" },
    common: { path: "/workspace/.git", dev: "1", ino: "3" },
    gitDirectory: { path: "/workspace/.git/worktrees/assigned", dev: "1", ino: "4" },
    initialHeadOid: "a".repeat(40),
    pointerAndConfigurationHash: "b".repeat(64),
  });
  yield* f.sql`INSERT INTO project_team_workspace_receipt VALUES
    (${f.request.dispatchId},'environment','binding',0,${snapshot.fence.claimGeneration},${canonicalProjectWorkPayload(receipt.assignment)},${canonicalProjectWorkPayload(receipt)})`;
  const state = yield* readCurrentState(f.sql, projectId);
  const binding = state.foundationRecords?.find((r) => r.kind === "run-binding");
  if (binding?.kind !== "run-binding") return yield* Effect.die("Missing settled binding");
  const selectedTask = state.tasks.find((t) => t.taskId === binding.taskId);
  if (!selectedTask) return yield* Effect.die("Missing current task");
  const selection = yield* decodeSelection({
    jobId: "verification-1",
    projectId,
    taskId: selectedTask.taskId,
    expectedRevision: state.revision,
    expectedTaskRevision: selectedTask.revision,
    specRevision: selectedTask.specRevision,
    planRevision: binding.planRevision,
    bindingId: binding.recordId,
    expectedBindingRevision: binding.revision,
    generation: binding.generation,
    criterionIds: state.criteria
      .filter((c) => c.taskId === selectedTask.taskId)
      .map((c) => c.criterionId),
    command: {
      executable: "/bin/bash",
      argv: ["-n", "test.sh"],
      environment: "clean",
      limits: { maxDurationMs: 1000, maxOutputBytes: 4096 },
    },
  });
  const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment" });
  const preparation = yield* makeProjectWorkVerificationPreparation({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    assertHumanCurrent: () => Effect.void,
    captureWorkspace: (original, use) =>
      use({
        receipt: original.receipt,
        cwd: original.receipt.assignment.worktreePath,
        baseSha: "a".repeat(40),
        headSha: "c".repeat(40),
        testedCommit: "c".repeat(40),
        testedTree: "d".repeat(40),
      }),
    captureExecutable: (_binding, command, use) =>
      use({
        executableTarget: command.executable,
        sha256: "e".repeat(64),
        runtimeClosureSha256: "f".repeat(64),
      }),
    retainPrepared: (manifest) =>
      jobs
        .retainPrepared(manifest)
        .pipe(
          Effect.mapError(
            () =>
              new ProjectWorkVerificationPreparationError({ reason: "Fixture retention failed" }),
          ),
        ),
  });
  const principal = { actor: { kind: "human" as const, id: "maintainer" } };
  const prepared = yield* preparation.prepare(selection, principal);
  return { ...f, state, snapshot, receipt, selection, jobs, preparation, principal, prepared };
});

export const verificationFixture = makeVerificationFixture();
