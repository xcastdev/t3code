import * as NodeCrypto from "node:crypto";
import { expect } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  ProjectTeamRecord,
  type ProjectTeamIntegrationSources,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import {
  at,
  attribution,
  projectId,
  seed,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
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
const decodeTeamRecord = Schema.decodeUnknownEffect(ProjectTeamRecord);
const sourceRefs = (selection: ProjectTeamIntegrationSources) =>
  selection.sources.map((source) => ({
    taskId: source.taskId,
    bindingId: source.bindingId,
    expectedBindingRevision: source.bindingRevision,
    generation: source.generation,
    reviewDispatchId: source.reviewDispatchId,
    expectedReviewProposalSha256: source.reviewProposalSha256,
    verificationJobId: source.jobId,
    expectedManifestHash: source.manifestHash,
    expectedBranchRef: source.branchRef,
    expectedBaseSha: source.baseSha,
    expectedHeadSha: source.headSha,
    expectedTestedTree: source.testedTree,
  }));
const selectionHash = (selection: ProjectTeamIntegrationSources) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(selection)).digest("hex");
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const makeFixture = (
  role: "implementer" | "integrator" = "implementer",
  suffix = "",
  integration?: ProjectTeamIntegrationSources,
) =>
  Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = yield* SqlClient.SqlClient;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    // The real fixture commits approvals and the execution grant; intercept only its final claim.
    const key = (id: string) => id + suffix;
    const start = Effect.gen(function* () {
      if (suffix === "")
        return yield* seed(role, "reserved", {
          roleTools: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
          toolIds: role === "integrator" ? ["pi.read"] : ["pi.read", "pi.write"],
          issueCredential: false,
        });
      return yield* Effect.gen(function* () {
        const current = yield* readCurrentState(sql, projectId);
        let originalRole = current.foundationRecords?.find(
          (record) => record.kind === "role-revision" && record.role === role,
        );
        let binding = current.foundationRecords?.find(
          (record) =>
            record.kind === "run-binding" && record.roleRevisionId === originalRole?.recordId,
        );
        if (originalRole === undefined && role === "integrator") {
          const implementation = current.foundationRecords?.find(
            (record) => record.kind === "role-revision" && record.role === "implementer",
          );
          const member = current.foundationRecords?.find((record) => record.kind === "member");
          const original = current.foundationRecords?.find(
            (record) =>
              record.kind === "run-binding" && record.roleRevisionId === implementation?.recordId,
          );
          if (
            implementation?.kind !== "role-revision" ||
            member?.kind !== "member" ||
            original?.kind !== "run-binding"
          )
            return yield* Effect.die("Missing existing integration fixture policy");
          originalRole = yield* decodeTeamRecord({
            ...implementation,
            recordId: key("integration-role"),
            roleId: key("integrator"),
            role: "integrator",
            tools: ["pi.read"],
          });
          if (originalRole.kind !== "role-revision")
            return yield* Effect.die("Invalid integration fixture role");
          yield* repository.execute(
            yield* decodeCommit({
              type: "project-work.foundation.commit",
              projectId,
              commandId: key("integration-profile"),
              expectedRevision: current.revision,
              attribution,
              committedAt: at,
              records: [
                originalRole,
                {
                  ...member,
                  recordId: key("integration-member"),
                  roleRevisionId: originalRole.recordId,
                },
              ],
            }),
          );
          binding = {
            ...original,
            memberId: key("integration-member"),
            configuration: { ...original.configuration, toolIds: ["pi.read"] },
          };
        }
        if (originalRole?.kind !== "role-revision" || binding?.kind !== "run-binding")
          return yield* Effect.die("Missing configured additional source role");
        return yield* createManagedAssignment({
          taskId: ProjectWorkTaskId.make(key("verification-task")),
          recordId: key("binding"),
          attemptId: key("attempt"),
          commandId: key("claim"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          threadId: ThreadId.make(key("verification-thread")),
          role: originalRole,
          status: "reserved",
          configuration: binding.configuration,
          memberId: binding.memberId,
        });
      });
    });
    const result = yield* start.pipe(
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
          if (
            integration !== undefined &&
            command.type === "project-work.foundation.commit" &&
            command.guided?.intent.type === "project-team.plan.propose"
          )
            return repository.execute({
              ...command,
              guided: {
                ...command.guided,
                intent: {
                  ...command.guided.intent,
                  integrationSourceRefs: sourceRefs(integration),
                },
                integrationSources: integration,
              },
            });
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Fixture did not capture its claim");
    if (suffix === "")
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
          branch: key("refs/heads/assigned"),
          worktree: key("/workspace-assigned"),
        },
      },
    };
    const request: ProjectTeamDispatchRequest = {
      dispatchId: key("dispatch-intent"),
      claim,
      git: {
        effectId: key("dispatch-intent"),
        runId: key("binding"),
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: key("/workspace-assigned"),
        branchRef: key("refs/heads/assigned"),
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: key("setup"),
      initializeOperationId: key("initialize"),
      assignmentOperationId: key("assignment"),
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
  suffix = "",
  integration?: ProjectTeamIntegrationSources,
) {
  const key = (id: string) => id + suffix;
  const f = yield* makeFixture(role, suffix, integration);
  let claimed = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
  const settling = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    verifyStage: () => Effect.void,
    verifySettlement: () => Effect.void,
  });
  const receipt = yield* decodeReceipt({
    assignment: f.request.git,
    primary: { path: "/workspace", dev: "1", ino: "1" },
    worktree: { path: key("/workspace-assigned"), dev: "1", ino: "2" },
    common: { path: "/workspace/.git", dev: "1", ino: "3" },
    gitDirectory: { path: key("/workspace/.git/worktrees/assigned"), dev: "1", ino: "4" },
    initialHeadOid: "a".repeat(40),
    pointerAndConfigurationHash: "b".repeat(64),
  });
  if (integration !== undefined) {
    yield* f.sql`INSERT INTO project_team_workspace_receipt VALUES
    (${f.request.dispatchId},'environment',${key("binding")},0,${claimed.fence.claimGeneration},${canonicalProjectWorkPayload(receipt.assignment)},${canonicalProjectWorkPayload(receipt)})`;
    claimed = yield* settling.advanceStage(claimed.fence, {
      receiptId: key("integration-workspace-ready"),
      stage: "workspace-ready",
      evidence: {
        workspace: receipt,
        integration: {
          version: 1,
          selectionSha256: selectionHash(integration),
          baseSha: "a".repeat(40),
          combinedHeadSha: "9".repeat(40),
          combinedTree: "8".repeat(40),
          sourceHeads: integration.sources.map((source) => source.headSha),
        },
      },
    });
  }
  // Controlled joined receipts exercise real SQL settlement; no native worker ran.
  const snapshot = yield* settling.settleAfterJoined(claimed.fence, {
    receiptId: key("prepared-joined"),
    stage: "settled",
    evidence: { worker: "joined", setup: "joined", transport: "drained" },
  });
  if (integration === undefined) {
    yield* f.sql`INSERT INTO project_team_workspace_receipt VALUES
    (${f.request.dispatchId},'environment',${key("binding")},0,${snapshot.fence.claimGeneration},${canonicalProjectWorkPayload(receipt.assignment)},${canonicalProjectWorkPayload(receipt)})`;
  }
  const state = yield* readCurrentState(f.sql, projectId);
  const binding = state.foundationRecords?.find(
    (r) => r.kind === "run-binding" && r.recordId === key("binding"),
  );
  if (binding?.kind !== "run-binding") return yield* Effect.die("Missing settled binding");
  const selectedTask = state.tasks.find((t) => t.taskId === binding.taskId);
  if (!selectedTask) return yield* Effect.die("Missing current task");
  const selection = yield* decodeSelection({
    jobId: key("verification-1"),
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
        headSha: (suffix === "" ? "c" : "9").repeat(40),
        testedCommit: (suffix === "" ? "c" : "9").repeat(40),
        testedTree: (suffix === "" ? "d" : "8").repeat(40),
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

/** Additional controlled assignment before workspace/native entry; caller supplies host-qualified sources. */
export const makeVerificationAssignmentFixture = makeFixture;
export const verificationFixture = makeVerificationFixture();
