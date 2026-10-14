// @effect-diagnostics nodeBuiltinImport:off - Disposable SDK JSONL is the retained observation under test.
import { makeProjectTeamDeliveryAcceptance } from "./ProjectTeamDeliveryAcceptance.ts";
import {
  readDeliveryAcceptance,
  deliveryAcceptanceHash,
  deliveryCriterionSnapshots,
  assertDeliveryAcceptanceCurrent,
} from "./ProjectTeamDeliveryAcceptanceState.ts";
import { evaluateProjectTeamDependency } from "./ProjectTeamPolicy.ts";
import { runProjectWorkManagedMergeRecovery } from "./ProjectWorkRuntime.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import * as Queue from "effect/Queue";
import * as PullService from "../pullRequest/PullRequestService.ts";
import * as PullRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as PullReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as GitHubPullCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as GitHubPullProvider from "../pullRequest/GitHubPullRequestProvider.ts";
import * as SourceProviders from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as PlatformPath from "@effect/platform-node/NodePath";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  ProjectWorkHumanMergeRequest,
  makeProjectWorkHumanMergeRequest,
} from "./ProjectWorkHumanMergeRequest.ts";
import {
  ProjectWorkManagedMerge,
  makeProjectWorkManagedMerge,
  type ManagedMergePorts,
} from "./ProjectWorkManagedMerge.ts";
import {
  makeProjectWorkManagedMergeJournal,
  ManagedMergeError,
} from "./ProjectWorkManagedMergeJournal.ts";
import * as MergeGuard from "./ProjectWorkPullRequestActionGuard.ts";
import { expect, it, vi } from "@effect/vitest";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { makeProjectTeamWorkspace } from "./ProjectTeamWorkspace.ts";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectId,
  EventId,
  EnvironmentId,
  ProviderInstanceId,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type GitRunStackedActionInput,
  type PullRequestActionInput,
  type OrchestrationProjectShell,
  GitCommandError,
  ProjectTeamReviewFindingIntent,
  ProjectTeamReviewFindingProvenance,
  ProjectTeamRecord,
  ProjectTeamGate,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  ProjectTeamRecordRead,
  ProjectWorkCriterionId,
  ProjectTeamGuidedIntent,
  ThreadId,
  ProjectWorkEvidenceId,
  ProjectWorkEvidence,
  ProjectWorkCriterion,
  ProjectWorkCommand,
  ProjectWorkPublicationRequest,
  ProjectWorkRelationship,
  ProjectWorkTaskId,
  ProjectTeamIntegrationSourceRef,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import {
  scoped,
  attribution,
  projectId,
  taskId,
  at,
  restoreHistoricalBinding,
  gatewayRuntime,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamReviewCompletionProposals,
  ProjectTeamReviewReportOperation,
  ProjectTeamReviewCompletionProposalError,
  type ProjectTeamReviewCompletionProposalManifest,
} from "./ProjectTeamReviewCompletionProposals.ts";
import { makeProjectTeamReviewResolutionReader } from "./ProjectTeamReviewResolution.ts";
import { makeProjectTeamReviewFindings } from "./ProjectTeamReviewFindings.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { makeProjectTeamReviewCompletion } from "./ProjectTeamReviewCompletion.ts";
import {
  makeProjectTeamReviewCurrentTarget,
  ProjectTeamReviewCurrentTarget,
} from "./ProjectTeamReviewCurrentTarget.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { snapshotReviewCriterionAssessments } from "./ProjectTeamReviewCriterionAssessments.ts";
import {
  makeProjectWorkVerificationPreparation,
  ProjectWorkVerificationPreparationError,
} from "./ProjectWorkVerificationPreparation.ts";
import {
  verificationFixture,
  makeVerificationFixture,
  makeVerificationAssignmentFixture,
} from "./ProjectWorkVerification.testFixtures.ts";
import {
  makeProjectWorkVerificationGate,
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "./ProjectWorkVerificationGate.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import { projectTeamDerivedRecordId, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  ProjectTeamWorkspaceEvidence,
  ProjectTeamDispatchJournalError,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { makeProjectTeamReviewedWorkReader } from "./ProjectTeamReviewedWorkReader.ts";
import {
  makeProjectWorkPublicationAuthorization,
  ProjectWorkPublicationAuthorization,
} from "./ProjectWorkPublicationAuthorization.ts";
import {
  makeProjectWorkHumanPublicationRequest,
  makeProjectWorkHumanPublication,
} from "./ProjectWorkHumanPublicationRequest.ts";
import * as Publication from "./ProjectWorkPullRequests.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  bindIssueRepositoryProject,
  ensureIssueRepositoryTables,
} from "./ProjectIssueRepositoryState.ts";
import { makeProjectTeamCompletedReviewReader } from "./ProjectTeamReviewCompleted.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import { PROJECT_TASK_MEMORY_BYTES } from "./ProjectTaskResources.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { executePiProjectWorkBridgeTool } from "../provider/pi/PiProjectWorkTools.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";
import { makeProjectTeamPiOperations, type PiDurableOperation } from "./ProjectTeamPiOperations.ts";
import type { PiSessionTerminal } from "../provider/pi/PiSessionRuntime.ts";
import { make as makeModelAccounting } from "./ProjectTeamModelAccounting.ts";
import { makeProjectTeamMailboxConsumption } from "./ProjectTeamMailboxConsumption.ts";
import { makeProjectTeamSessionReceipts } from "./ProjectTeamSessionReceipts.ts";
import {
  makeProjectWorkVerificationExecutionJournal,
  verificationExecutionHash,
  ProjectWorkVerificationExecutionError,
  ProjectWorkVerificationExecutionIntent,
} from "./ProjectWorkVerificationExecutionJournal.ts";
import {
  prepareProjectTeamConfiguredAdmission,
  type ProjectTeamConfiguredAdmissionFacts,
} from "./ProjectTeamConfiguredAdmission.ts";

const canonical = canonicalProjectWorkPayload;
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const decodeIntent = Schema.decodeUnknownSync(ProjectTeamReviewFindingIntent, strict);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, strict);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord, strict);
const decodeTeamIntent = Schema.decodeUnknownSync(ProjectTeamWriteIntent, strict);
const decodeWorkCommand = Schema.decodeUnknownEffect(ProjectWorkCommand, strict);
const decodeControlledJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.JsonObject),
  strict,
);
const decodeControlledRelationship = Schema.decodeUnknownEffect(ProjectWorkRelationship, strict);
const decodeControlledWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  strict,
);
const decodeVerificationIntent = Schema.decodeUnknownEffect(
  ProjectWorkVerificationExecutionIntent,
  strict,
);
const decodeStoredVerificationIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkVerificationExecutionIntent),
  strict,
);
const input = () =>
  decodeIntent({
    type: "project-team.review.finding.record",
    commandId: "finding-command",
    projectId,
    taskId,
    expectedRevision: 0,
    expectedTaskRevision: 0,
    specRevision: 0,
    planRevision: 0,
    findingId: "finding",
    revision: 0,
    severity: "high",
    criterionIds: ["criterion"],
    detail: "A reproducible review finding",
    status: "open",
    resolutionArtifactIds: [],
  });
it.effect(
  "finding compiler requires its actual caller transaction before resolving authority",
  () =>
    scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let resolutions = 0;
        const compiler = yield* makeProjectTeamReviewFindings(() =>
          Effect.sync(() => {
            resolutions++;
            return undefined;
          }),
        );
        const principal = { actor: attribution.actor };
        expect(
          (yield* compiler.compile(principal, input(), attribution, false).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* sql
            .withTransaction(
              compiler
                .compile(principal, input(), attribution, false)
                .pipe(Effect.provideService(SqlClient.SqlClient, { ...sql })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql
            .withTransaction(
              compiler
                .compile(principal, input(), attribution, false)
                .pipe(
                  Effect.updateContext((context: Context.Context<never>) =>
                    Context.omit(SqlClient.SqlClient)(context),
                  ),
                ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(resolutions).toBe(0);
      }),
    ),
);

/** Actual migrated SQLite, real authorization and original claim; no worker or model execution. */
const establishControlledReviewRoot = (
  f: Effect.Success<typeof verificationFixture>,
  suffix = "",
) =>
  Effect.gen(function* () {
    const key = (id: string) => id + suffix;
    const state = () => readCurrentState(f.sql, projectId);
    let current = yield* state();
    const old = current.foundationRecords?.find(
      (r) => r.kind === "run-binding" && r.recordId === f.selection.bindingId,
    );
    const role = current.foundationRecords?.find(
      (r) =>
        r.kind === "role-revision" &&
        r.recordId === (old?.kind === "run-binding" ? old.roleRevisionId : undefined),
    );
    const member = current.foundationRecords?.find(
      (r) =>
        r.kind === "member" &&
        r.recordId === (old?.kind === "run-binding" ? old.memberId : undefined),
    );
    const limits = current.foundationRecords?.find(
      (r) => r.kind === "limits" && r.status === "configured",
    );
    const task = current.tasks.find((t) => t.taskId === f.selection.taskId);
    if (
      old?.kind !== "run-binding" ||
      role?.kind !== "role-revision" ||
      member?.kind !== "member" ||
      limits?.kind !== "limits" ||
      !task
    )
      return yield* Effect.die("Missing original root fixture scope");
    const existingCoordinator = suffix
      ? current.foundationRecords?.find(
          (record) => record.kind === "member" && record.coordinator && record.status === "active",
        )
      : undefined;
    const existingRootRole =
      existingCoordinator?.kind === "member"
        ? current.foundationRecords?.find(
            (record) =>
              record.kind === "role-revision" &&
              record.recordId === existingCoordinator.roleRevisionId,
          )
        : undefined;
    const rootRole =
      existingRootRole ??
      decodeRecord({
        ...role,
        recordId: key("review-root-role"),
        roleId: key("review-root"),
        role: "coordinator",
        model: "inclusionai/ling-3.1-flash:free",
        tools: ["pi.read"],
      });
    if (rootRole.kind !== "role-revision") return yield* Effect.die("Invalid controlled root role");
    const rootMember =
      existingCoordinator ??
      decodeRecord({
        ...member,
        recordId: key("review-root-member"),
        roleRevisionId: rootRole.recordId,
        coordinator: true,
      });
    if (rootMember.kind !== "member") return yield* Effect.die("Invalid controlled root member");
    if (!existingCoordinator)
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          commandId: key("review-root-profile"),
          projectId,
          expectedRevision: current.revision,
          attribution,
          committedAt: at,
          records: [
            rootRole,
            rootMember,
            ...(current.foundationRecords?.some(
              (record) =>
                record.kind === "limits" &&
                record.status === "configured" &&
                record.model === rootRole.model,
            )
              ? []
              : [
                  decodeRecord({
                    ...limits,
                    recordId: key("review-model-limits"),
                    model: rootRole.model,
                  }),
                ]),
          ],
        }),
      );
    current = yield* state();
    yield* f.repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        commandId: key("review-root-resume"),
        projectId,
        expectedRevision: current.revision,
        attribution: { ...attribution, actor: f.principal.actor },
        committedAt: at,
        records: [],
        guided: {
          intent: {
            type: "project-team.task.control",
            commandId: key("review-root-resume"),
            projectId,
            taskId: task.taskId,
            expectedRevision: current.revision,
            expectedTaskRevision: task.revision,
            control: { action: "resume", reason: "Retain independent controlled review root" },
          },
        },
      }),
    );
    current = yield* state();
    const parent = current.tasks.find((t) => t.taskId === task.taskId)!;
    const membership = current.foundationRecords?.find(
      (r) => r.kind === "task-membership" && r.taskId === task.taskId,
    );
    const gate = current.foundationRecords?.find(
      (r) =>
        r.kind === "gate" &&
        r.recordId ===
          (membership?.kind === "task-membership"
            ? membership.assignment?.authorizationGateId
            : undefined),
    );
    if (gate?.kind !== "gate") return yield* Effect.die("Missing renewed original root grant");
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const workspace = NodePath.join(root, "workspace");
    const nativeRoot = NodePath.join(root, "native");
    const protectedRoot = NodePath.join(root, "protected");
    for (const path of [workspace, nativeRoot, protectedRoot]) yield* fs.makeDirectory(path);
    const { sessionId: _oldSession, ...oldIdentity } = old;
    const binding = decodeRecord({
      ...oldIdentity,
      recordId: key("review-root-binding"),
      status: "reserved",
      revision: 0,
      generation: 1,
      leaseGeneration: 1,
      updatedAt: at,
      attemptId: key("review-root-attempt"),
      memberId: rootMember.recordId,
      roleRevisionId: rootRole.recordId,
      threadId: key("review-root-thread"),
      model: rootRole.model,
      worktree: workspace,
      branch: "refs/heads/review-root",
      authorizationGateId: gate.recordId,
      configuration: {
        ...old.configuration,
        toolIds: ["pi.read"],
        instructionsHash: digest(rootRole.instructions),
      },
    });
    if (binding.kind !== "run-binding") return yield* Effect.die("Invalid controlled root binding");
    const rootClaim = decodeCommit({
      type: "project-work.foundation.commit",
      commandId: key("review-root-claim"),
      projectId,
      expectedRevision: current.revision,
      attribution,
      committedAt: at,
      records: [],
      transition: {
        kind: "claim",
        taskId: task.taskId,
        expectedTaskRevision: parent.revision,
        authorizationGateId: gate.recordId,
        expectedGateRevision: gate.revision,
        binding,
        claim: {
          type: "project-work.task.claim",
          projectId,
          taskId: task.taskId,
          commandId: key("review-root-claim"),
          attemptId: binding.attemptId,
          leaseToken: key("review-root-lease"),
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: at,
        },
      },
    });
    const rootJournal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const reservedRoot = yield* rootJournal.reserve({
      dispatchId: key("review-root-dispatch"),
      claim: rootClaim,
      git: {
        effectId: key("review-root-dispatch"),
        runId: binding.recordId,
        generation: binding.generation,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: workspace,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: key("review-root-owner"),
        policyHash: "b".repeat(64),
      },
      setupId: key("review-root-setup"),
      initializeOperationId: key("review-root-initialize"),
      assignmentOperationId: key("review-root-assignment"),
      assignment: "Own the bounded review root",
    });
    yield* rootJournal.claimEffect(reservedRoot.fence);
    const allocation = yield* preallocatePiManagedProcess({
      workspaceRoot: workspace,
      workspaceAccess: "readonly",
      nativeStateRoot: nativeRoot,
      protectedRoots: [protectedRoot],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    const request = {
      kind: "initialize" as const,
      operationId: key("review-root-initialize"),
      threadId: binding.threadId,
    };
    const initialize = yield* operations.prepare(
      { providerInstanceId: binding.providerInstanceId, threadId: binding.threadId },
      request,
      digest(canonical(request)),
      {
        allocation,
        workerId: key("review-root-worker"),
        operationId: request.operationId,
        resourceHash: "a".repeat(64),
      },
    );
    const owner = {
      type: "owner" as const,
      unit: allocation.unit,
      nonce: allocation.nonce,
      invocation: "b".repeat(32),
      cgroup: "/sys/fs/cgroup/" + allocation.unit,
      pid: 223,
      memoryBytes: allocation.policy.memoryBytes,
      swapBytes: 0 as const,
      oomGroup: 1 as const,
    };
    // Real persistence callbacks retain controlled custody. No allocation is activated on the host.
    yield* operations.persistence(initialize).claimActivation(allocation);
    yield* operations.persistence(initialize).beforeStart(owner);
    yield* operations.persistNative(initialize, {
      sessionId: key("controlled-review-root"),
      sessionReference: "sessions/root.jsonl",
      leafId: null,
      persisted: true,
    });
    current = yield* state();
    const selection = {
      ...f.selection,
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks.find((t) => t.taskId === task.taskId)!.revision,
    };
    const prepared = yield* f.preparation.prepare(selection, f.principal);
    expect(prepared.sha256).toBe(f.prepared.sha256);
    expect(prepared.manifest).toEqual(f.prepared.manifest);
    return { ...f, selection, prepared, reviewRootBindingId: binding.recordId };
  });
// Actual disposable execution storage with controlled custody; no process or Git probe runs.
const retainControlledVerification = (
  f: Effect.Success<typeof verificationFixture>,
  outcome: "success" | "failed" | "timed-out" | "canceled",
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at) + 1);
    const current = yield* readCurrentState(f.sql, projectId);
    const gate = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
    );
    if (gate?.kind !== "gate") return yield* Effect.die("Missing approved verification gate");
    const job = f.prepared.manifest;
    const allocationDigest = digest(canonical({ dispatchId: job.dispatchId, jobId: job.jobId }));
    const nonce = `${allocationDigest.slice(0, 8)}-${allocationDigest.slice(8, 12)}-4${allocationDigest.slice(13, 16)}-8${allocationDigest.slice(17, 20)}-${allocationDigest.slice(20, 32)}`;
    const memoryBytes = 536870912;
    const runtimeSeconds = Math.ceil(job.command.limits.maxDurationMs / 1000);
    const allocation = {
      version: 1 as const,
      unit: `t3-pi-managed-${nonce}.service`,
      nonce,
      policy: { memoryBytes, runtimeSeconds },
      launch: {
        workspaceRoot: job.target.worktree,
        workspaceAccess: "readonly" as const,
        workspace: { path: job.target.worktree, dev: 1, ino: 2 },
        protectedRoots: ["/controlled-protected"],
        protectedWorkspaceEntries: [],
        runtimeFiles: [
          { source: "/controlled/executable", target: job.command.executable, dev: 1, ino: 3 },
        ],
        argv: [job.command.executable, ...job.command.argv],
        memoryBytes,
        runtimeSeconds,
      },
    };
    const dispatchJournal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const originalDispatch = yield* dispatchJournal.readRetained(job.dispatchId);
    const originalClaim = originalDispatch.intent.compiledClaim.transition;
    const sourceBinding = originalClaim?.kind === "claim" ? originalClaim.binding : undefined;
    const authorityTuple = {
      manifest: {
        dispatchId: job.dispatchId,
        projectId: job.projectId,
        taskId: job.taskId,
        bindingId: job.bindingId,
        generation: job.generation,
      },
      retained: {
        dispatchId: originalDispatch.intent.request.dispatchId,
        projectId: originalDispatch.intent.request.claim.projectId,
        taskId: sourceBinding?.taskId ?? null,
        bindingId: sourceBinding?.recordId ?? null,
        generation: sourceBinding?.generation ?? null,
      },
    };
    if (
      originalClaim?.kind !== "claim" ||
      originalDispatch.intent.request.claim.projectId !== job.projectId ||
      originalClaim.binding.taskId !== job.taskId ||
      originalClaim.binding.recordId !== job.bindingId ||
      originalClaim.binding.generation !== job.generation
    )
      return yield* Effect.die(
        `Verification fixture lost its original dispatch authority: ${canonical(authorityTuple)}`,
      );
    // The controlled fixture retains the budget from the exact settled dispatch. Verification
    // cannot create or renew this root allocation itself.
    yield* f.sql`INSERT OR IGNORE INTO project_task_resource_budget VALUES(
      ${job.environmentId},${job.projectId},${originalDispatch.intent.limits.rootTaskId},
      ${originalDispatch.intent.limits.rootDeadlineAtMs},${PROJECT_TASK_MEMORY_BYTES})`;
    const retainedBudget = yield* f.sql<{
      deadline_at_ms: number;
      memory_bytes: number;
    }>`SELECT deadline_at_ms,memory_bytes FROM project_task_resource_budget
      WHERE environment_id=${job.environmentId} AND project_id=${job.projectId}
      AND task_id=${originalDispatch.intent.limits.rootTaskId} LIMIT 2`;
    expect(retainedBudget).toEqual([
      {
        deadline_at_ms: originalDispatch.intent.limits.rootDeadlineAtMs,
        memory_bytes: PROJECT_TASK_MEMORY_BYTES,
      },
    ]);
    const journal = yield* makeProjectWorkVerificationExecutionJournal({
      environmentId: "environment",
      assertCurrent: (intent, state, phase, attemptId) =>
        Effect.gen(function* () {
          const matches =
            state.foundationRecords?.filter((r) => r.recordId === intent.gate.recordId) ?? [];
          const selected = matches[0];
          if (
            matches.length !== 1 ||
            selected?.kind !== "gate" ||
            selected.status !== (phase === "approved" ? "approved" : "consumed") ||
            selected.contentHash !== intent.receipt.sha256 ||
            (phase === "consumed" && selected.consumedByRunId !== attemptId)
          )
            return yield* new ProjectWorkVerificationExecutionError({
              reason: "Controlled original gate changed",
            });
        }),
      consumeApproval: (intent, attemptId, state) =>
        Effect.gen(function* () {
          const task = state.tasks.find((t) => t.taskId === job.taskId);
          if (!task) return yield* Effect.die("Missing verification parent");
          return [
            decodeCommit({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "controlled-verification-claim:" + attemptId,
              expectedRevision: state.revision,
              attribution: {
                actor: { kind: "system", id: "project-team-verification" },
                source: { kind: "system", id: "project-team-verification" },
                recordedAt: at,
              },
              committedAt: at,
              records: [],
              transition: {
                kind: "verification.claim",
                taskId: task.taskId,
                expectedTaskRevision: task.revision,
                gateId: intent.gate.recordId,
                expectedGateRevision: intent.gate.revision,
                jobId: job.jobId,
                manifestHash: intent.receipt.sha256,
                attemptId,
              },
            }),
          ];
        }),
      verifyResult: () => Effect.void,
    });
    const claimed = yield* journal.claim({
      receipt: f.prepared,
      gate,
      allocation,
      deadlineAtMs: (yield* Clock.currentTimeMillis) + job.command.limits.maxDurationMs,
    });
    if (claimed._tag !== "Claimed")
      return yield* Effect.die("Missing controlled verification claim");
    const claim = claimed.claim;
    const owner = {
      type: "owner" as const,
      unit: allocation.unit,
      nonce,
      invocation: "c".repeat(32),
      cgroup: "/sys/fs/cgroup/controlled/" + allocation.unit,
      pid: 420,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const persistence = journal.persistence(claim);
    yield* persistence.claimActivation(allocation);
    yield* persistence.beforeStart(owner);
    const exitCode = outcome === "success" ? 0 : 1;
    const environmentSummary = "controlled retained verification";
    const applicability = {
      projectId: job.projectId,
      taskId: job.taskId,
      specRevision: job.specRevision,
      planRevision: job.planRevision,
      repository: job.target.repository,
      worktree: job.target.worktree,
      testedTree: job.target.testedTree,
      testedCommit: job.target.testedCommit,
      baseSha: job.target.baseSha,
      headSha: job.target.headSha,
      command: canonical({ executable: job.command.executable, argv: job.command.argv }),
      exitCode,
      environmentSummary,
      integration: job.integration === true,
    };
    const artifacts = yield* makeProjectWorkArtifacts({
      environmentId: "environment",
      maximumArtifactBytes: 4096,
    });
    const stdout = yield* artifacts.retain({
      artifactId: claim.attemptId + ":stdout",
      sourceId: claim.attemptId,
      applicability,
      bytes: new Uint8Array([0, 255, 10]),
    });
    const stderr = yield* artifacts.retain({
      artifactId: claim.attemptId + ":stderr",
      sourceId: claim.attemptId,
      applicability,
      bytes: new Uint8Array([27, 0]),
    });
    const drain = {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      ownerPid: owner.pid,
      memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
      launcherPid: 410,
      childPid: 430,
      childExitCode: exitCode,
      kernel: "populated 0",
    };
    yield* journal.complete(claim, {
      version: 1,
      jobId: job.jobId,
      attemptId: claim.attemptId,
      manifestHash: f.prepared.sha256,
      allocationHash: verificationExecutionHash(allocation),
      outcome,
      exitCode,
      outputComplete: true,
      stdout,
      stderr,
      drain,
      drainHash: verificationExecutionHash(drain),
      environmentSummary,
      finishedAtMs: yield* Clock.currentTimeMillis,
    });
  });
const configuredReviewModel = "inclusionai/ling-3.1-flash:free";
const configuredReviewProvider = ProviderInstanceId.make("pi");
const configuredReviewRoles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
const configuredReviewConfiguration: ProjectTeamConfigurationIntent = {
  type: "project-team.configure",
  commandId: CommandId.make("configured-review-configure"),
  projectId,
  expectedRevision: 0,
  expectedConfigurationGeneration: 0,
  enabled: true,
  providerInstanceId: configuredReviewProvider,
  projectPriority: 1,
  taskPriorities: [],
  profiles: configuredReviewRoles.map((role) => ({
    role,
    instructions: `Instructions for ${role}`,
    skills: [],
    tools:
      role === "implementer" || role === "integrator"
        ? ["pi.read", "pi.write", "project-work.report"]
        : ["pi.read", "project-work.report"],
    model: configuredReviewModel,
    memoryAccess: "project",
    delegationDepth: 2,
  })),
  modelPolicies: [
    { model: configuredReviewModel, tokenLimit: 8192, durationLimitMs: 60_000, modelCalls: 2 },
  ],
};
const configuredReviewGit: ProjectTeamConfiguredAdmissionFacts["git"] = {
  primaryRoot: "/workspace",
  commonGitDirectory: "/workspace/.git",
  worktreePath: "/assigned-worktree",
  branchRef: "refs/heads/assigned",
  baseRef: "refs/heads/main",
  baseOid: "a".repeat(40),
  policyHash: "b".repeat(64),
  writable: true,
};
const configuredReviewFacts = (
  rootAnchor: ProjectTeamConfiguredAdmissionFacts["rootAnchor"],
  git: ProjectTeamConfiguredAdmissionFacts["git"] = configuredReviewGit,
): ProjectTeamConfiguredAdmissionFacts => ({
  environmentId: EnvironmentId.make("environment"),
  provider: {
    instanceId: configuredReviewProvider,
    driverKind: "piAgent",
    enabled: true,
    runtimeVersion: "0.99.1",
    maxInputTokens: 1024,
    maxOutputTokens: 512,
    catalogue: {
      source: "https://api.commandcode.ai/provider/v1/models",
      fetchedAt: at,
      selectedEntry: {
        id: configuredReviewModel,
        owned_by: "command-code",
        context_length: 262144,
        supported_endpoints: ["/chat/completions"],
      },
    },
  },
  supportedToolIds: ["pi.read", "pi.write", "project-work.report"],
  ownedSkillIds: [],
  git,
  rootAnchor,
});
const makeConfiguredReviewSourceFixture = (suffix: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const gateway = yield* ProjectWorkGateway;
    const repository = yield* ProjectWorkRepository;
    const taskId = ProjectWorkTaskId.make("parent");
    const nowMs = Date.parse(at) + 1;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace','[]',${at},${at})`;
    yield* gateway.write(
      configuredReviewConfiguration,
      { kind: "human", id: "human" },
      { kind: "web", id: "web" },
      { actor: { kind: "human", id: "human" } },
    );
    yield* repository.execute({
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("configured-review-create-parent"),
      title: "Implement the approved task",
      createdAt: at,
    });
    let state = yield* readCurrentState(sql, projectId);
    const role = state.foundationRecords?.find(
      (record) => record.kind === "role-revision" && record.role === "implementer",
    );
    const member = state.foundationRecords?.find(
      (record) => record.kind === "member" && record.roleRevisionId === role?.recordId,
    );
    if (role?.kind !== "role-revision" || member?.kind !== "member")
      return yield* Effect.die("Missing configured implementation member");
    const uncommitted = yield* createManagedAssignment({
      taskId,
      recordId: "configured-review-uncommitted",
      attemptId: "configured-review-uncommitted-attempt",
      commandId: "configured-review-uncommitted-claim",
      providerInstanceId: configuredReviewProvider,
      threadId: ThreadId.make("configured-review-thread"),
      role,
      memberId: member.recordId,
      status: "reserved",
      configuration: {
        instructionsHash: "configured-review-fixture",
        toolIds: role.tools,
        skillIds: [],
        runtimeVersion: "0.99.1",
        maxTokens: 8192,
        maxDurationMs: 60_000,
        paidFallback: false,
      },
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) =>
          command.type === "project-work.foundation.commit" && command.transition?.kind === "claim"
            ? Effect.fail(new ProjectWorkPolicyError("invalid-state", "Retain the approved grant"))
            : repository.execute(command),
      }),
      Effect.result,
    );
    expect(uncommitted._tag).toBe("Failure");
    state = yield* readCurrentState(sql, projectId);
    yield* TestClock.setTime(nowMs);
    const prepared = prepareProjectTeamConfiguredAdmission({
      state,
      taskId,
      nowMs,
      facts: configuredReviewFacts({ _tag: "NewRoot" }),
    });
    if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      verifyStage: () => Effect.void,
      verifySettlement: () => Effect.void,
    });
    const reserved = yield* journal.reserve(prepared.request);
    const claimed = yield* journal.claimEffect(reserved.fence);
    yield* journal.settleAfterJoined(claimed.fence, {
      receiptId: "configured-review-root-settlement",
      stage: "settled",
      evidence: { controlledDrain: true },
    });
    return yield* makeVerificationFixture("implementer", suffix);
  });
const makeFindingFixture = (
  coherentCustody = false,
  verificationOutcome?: "success" | "failed" | "timed-out" | "canceled",
  existing?: Effect.Success<typeof verificationFixture> & {
    readonly reviewRootBindingId: string | undefined;
  },
  suffix = "",
  configuredAdmissionSource = false,
) =>
  Effect.gen(function* () {
    const initial =
      existing ??
      (configuredAdmissionSource
        ? yield* Effect.serviceOption(ProjectWorkGateway).pipe(
            Effect.flatMap((gateway) =>
              Option.match(gateway, {
                onNone: () => Effect.die("Configured review source requires its existing gateway"),
                onSome: (existingGateway) =>
                  makeConfiguredReviewSourceFixture(suffix).pipe(
                    Effect.provideService(ProjectWorkGateway, existingGateway),
                  ),
              }),
            ),
          )
        : yield* verificationFixture);
    const key = (id: string) => id + suffix;
    const f =
      existing ??
      (coherentCustody
        ? yield* establishControlledReviewRoot(initial)
        : { ...initial, reviewRootBindingId: undefined });
    const controlledWorkspace =
      coherentCustody || configuredAdmissionSource
        ? yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        : undefined;
    const { sql, repository } = f;
    const auth = yield* ProjectTeamAuthorization;
    const state = () => readCurrentState(sql, projectId);
    const commitRecords = (commandId: string, records: ReadonlyArray<ProjectTeamRecord>) =>
      Effect.gen(function* () {
        return yield* repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId,
            expectedRevision: (yield* state()).revision,
            attribution,
            committedAt: at,
            records,
          }),
        );
      });
    const gates = yield* makeProjectWorkVerificationGate({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const human = {
      actor: f.principal.actor,
      source: { kind: "web" as const, id: key("findings-fixture") },
      recordedAt: at,
    };
    const trust = (expectedRevision: number) =>
      ProjectWorkVerificationApproval.of({
        selection: { ...f.selection, expectedRevision },
        receipt: f.prepared,
        assertCurrent: (current, duplicate) =>
          gates
            .assertCurrent(current, f.prepared, { ...f.selection, expectedRevision }, duplicate)
            .pipe(
              Effect.mapError(
                () =>
                  new ProjectWorkVerificationGateError({
                    reason: "Controlled verification target changed",
                  }),
              ),
            ),
      });
    const proposal = decodeTeamIntent({
      ...f.selection,
      type: "project-team.verification.propose",
      commandId: key("findings-verification-propose"),
    });
    yield* repository.executeAtomic(
      auth
        .intent(f.principal, proposal, human, false)
        .pipe(
          Effect.provideService(
            ProjectWorkVerificationApproval,
            trust(f.selection.expectedRevision),
          ),
        )
        .pipe(Effect.map((command) => [command])),
    );
    let current = yield* state();
    const verificationGate = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
    );
    if (verificationGate?.kind !== "gate")
      return yield* Effect.die("Missing original human verification gate");
    const response = decodeTeamIntent({
      type: "project-team.gate.respond",
      commandId: key("findings-verification-approve"),
      projectId,
      taskId: f.selection.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: f.selection.expectedTaskRevision,
      specRevision: f.selection.specRevision,
      planRevision: f.selection.planRevision,
      gateId: verificationGate.recordId,
      expectedGateRevision: verificationGate.revision,
      response: "approved",
    });
    yield* repository.executeAtomic(
      auth
        .intent(f.principal, response, human, false)
        .pipe(
          Effect.provideService(ProjectWorkVerificationApproval, trust(current.revision)),
          Effect.provideService(
            ProjectWorkVerificationRequest,
            ProjectWorkVerificationRequest.of({ assertCurrent: () => Effect.void }),
          ),
        )
        .pipe(Effect.map((command) => [command])),
    );
    if (verificationOutcome) yield* retainControlledVerification(f, verificationOutcome);
    current = yield* state();
    const role = current.foundationRecords?.find((r) => r.kind === "role-revision");
    const member = current.foundationRecords?.find((r) => r.kind === "member");
    const parent = current.tasks.find((t) => t.taskId === f.selection.taskId);
    const spec = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "specification",
    );
    const plan = current.foundationRecords?.find(
      (r) => r.kind === "plan-revision" && r.taskId === parent?.taskId,
    );
    const planGate = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "plan",
    );
    if (
      role?.kind !== "role-revision" ||
      member?.kind !== "member" ||
      !parent ||
      spec?.kind !== "gate" ||
      plan?.kind !== "plan-revision" ||
      planGate?.kind !== "gate"
    )
      return yield* Effect.die("Missing original parent scope");
    const reviewRole = decodeRecord({
      ...role,
      model: coherentCustody ? "inclusionai/ling-3.1-flash:free" : role.model,
      recordId: key("review-role"),
      roleId: "reviewer",
      role: "reviewer",
      tools: ["pi.read", "project-work.report"],
    });
    if (reviewRole.kind !== "role-revision") return yield* Effect.die("Invalid review role");
    if (
      coherentCustody &&
      !current.foundationRecords?.some(
        (r) => r.kind === "limits" && r.status === "configured" && r.model === reviewRole.model,
      )
    ) {
      const configured = current.foundationRecords?.find(
        (r) => r.kind === "limits" && r.status === "configured",
      );
      if (configured?.kind !== "limits")
        return yield* Effect.die("Missing controlled model limits");
      yield* commitRecords(key("findings-review-model-policy"), [
        decodeRecord({
          ...configured,
          recordId: key("review-model-limits"),
          model: reviewRole.model,
        }),
      ]);
    }
    yield* commitRecords(key("findings-review-member"), [
      reviewRole,
      decodeRecord({
        ...member,
        recordId: key("review-member"),
        roleRevisionId: key("review-role"),
        coordinator: false,
      }),
    ]);
    current = yield* state();
    yield* repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        commandId: key("findings-assignment"),
        projectId,
        expectedRevision: current.revision,
        attribution: human,
        committedAt: at,
        records: [],
        guided: {
          intent: {
            type: "project-team.assignment.start",
            commandId: key("findings-assignment"),
            projectId,
            taskId: parent.taskId,
            expectedRevision: current.revision,
            expectedTaskRevision: parent.revision,
            assignmentKind: "review",
            objective: "Independent review",
            outputDescriptions: ["Review findings"],
            specRevision: parent.specRevision,
            specificationGateId: spec.recordId,
            expectedSpecificationGateRevision: spec.revision,
            parentPlan: {
              recordId: plan.recordId,
              expectedRecordRevision: plan.revision,
              planRevision: plan.planRevision,
              gateId: planGate.recordId,
              expectedGateRevision: planGate.revision,
            },
          },
        },
      }),
    );
    current = yield* state();
    const grant = current.foundationRecords?.find(
      (r) =>
        r.kind === "gate" &&
        r.gate === "assignment" &&
        r.recordId === projectTeamDerivedRecordId(key("findings-assignment"), "assignment"),
    );
    const child = current.tasks.find(
      (t) => t.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
    );
    if (grant?.kind !== "gate" || !child) return yield* Effect.die("Missing original review child");
    const binding = decodeRecord({
      kind: "run-binding",
      projectId,
      recordId: key("review-binding"),
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "reserved",
      taskId: child.taskId,
      attemptId: key("review-attempt"),
      memberId: key("review-member"),
      roleRevisionId: key("review-role"),
      providerInstanceId: "pi",
      threadId: key("review-thread"),
      environmentId: "environment",
      model: reviewRole.model,
      configuration: {
        instructionsHash: digest(reviewRole.instructions),
        toolIds: ["pi.read", "project-work.report"],
        skillIds: [],
        runtimeVersion: "test",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: controlledWorkspace ?? "/workspace-assigned",
      branch: "refs/heads/assigned",
      leaseGeneration: 0,
      specRevision: child.specRevision,
      planRevision: 0,
      authorizationGateId: grant.recordId,
      ...(f.reviewRootBindingId === undefined ? {} : { parentRunId: f.reviewRootBindingId }),
      scopeHash: projectTeamScopeHash(current, child.taskId),
    });
    if (binding.kind !== "run-binding") return yield* Effect.die("Invalid reviewer binding");
    yield* TestClock.setTime(Date.parse(at) + 1);
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const claim = decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: key("findings-review-claim"),
      expectedRevision: (yield* state()).revision,
      attribution,
      committedAt: at,
      records: [],
      transition: {
        kind: "claim",
        taskId: child.taskId,
        expectedTaskRevision: child.revision,
        authorizationGateId: grant.recordId,
        expectedGateRevision: grant.revision,
        binding,
        claim: {
          type: "project-work.task.claim",
          projectId,
          taskId: child.taskId,
          commandId: key("findings-review-claim"),
          attemptId: binding.attemptId,
          leaseToken: key("review-lease"),
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: at,
        },
      },
    });
    const reservation = yield* journal.reserve({
      dispatchId: key("review-dispatch"),
      claim,
      git: {
        effectId: key("review-dispatch"),
        runId: binding.recordId,
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: binding.worktree,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: key("review-owner"),
        policyHash: "b".repeat(64),
      },
      setupId: key("review-setup"),
      initializeOperationId: key("review-initialize"),
      assignmentOperationId: key("review-assignment"),
      assignment: "Review the original target",
    });
    const snapshot = yield* journal.claimEffect(reservation.fence);
    const compiledClaim = snapshot.intent.compiledClaim.transition;
    if (compiledClaim?.kind !== "claim")
      return yield* Effect.die("Missing compiled reviewer claim binding");
    expect(compiledClaim.binding.recordId).toBe(binding.recordId);
    expect(compiledClaim.binding.generation).toBe(binding.generation);
    expect(compiledClaim.binding.configuration.maxTokens).toBe(
      snapshot.intent.limits.attemptMaximumTokens,
    );
    expect(compiledClaim.binding.configuration.maxDurationMs).toBe(
      snapshot.intent.limits.deadlineAtMs - (Date.parse(at) + 1),
    );
    expect(Date.parse(compiledClaim.claim.leasedUntil)).toBe(snapshot.intent.limits.deadlineAtMs);
    const targets = yield* makeProjectTeamReviewTargets({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const target = yield* sql.withTransaction(targets.captureInitial(snapshot));
    // Only disposable SDK bytes and controlled custody receipts; no child process is launched.
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const nativeRoot = NodePath.join(root, "native");
    const workspace = NodePath.join(root, "workspace");
    yield* fs.makeDirectory(nativeRoot);
    yield* fs.makeDirectory(workspace);
    yield* fs.makeDirectory(NodePath.join(root, "protected"));
    const sessionDirectoryRoot = NodePath.join(nativeRoot, "sessions");
    const manager = yield* Effect.sync(() =>
      SessionManager.create(binding.worktree, sessionDirectoryRoot),
    );
    const briefing = "Independent reviewer; only the original retained verification target.";
    manager.appendModelChange("synthetic", "fixture-only");
    const leafId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: briefing }],
      timestamp: 1,
    });
    const file = manager.getSessionFile();
    if (!file) return yield* Effect.die("Missing disposable JSONL");
    const native = {
      sessionId: manager.getSessionId(),
      sessionReference: `sessions/${NodePath.basename(file)}`,
      leafId,
      persisted: true,
    };
    const allocation = yield* preallocatePiManagedProcess({
      workspaceRoot: controlledWorkspace ?? workspace,
      workspaceAccess: "readonly",
      nativeStateRoot: nativeRoot,
      protectedRoots: [NodePath.join(root, "protected")],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    const request = {
      kind: "initialize",
      operationId: key("review-initialize"),
      threadId: binding.threadId,
      resumeCursor: null,
    };
    const nativeIntent = {
      request,
      binding: compiledClaim.binding,
      role: reviewRole,
      allocation,
      resourceHash: "a".repeat(64),
      rootBudget: { rootTaskId: binding.taskId, maximumTokens: 1000, deadlineAtMs: 100000 },
      operationLimits: { maximumTokens: 1000, deadlineAtMs: 100000 },
    };
    const owner = {
      type: "owner",
      unit: allocation.unit,
      nonce: allocation.nonce,
      invocation: "a".repeat(32),
      cgroup: `/sys/fs/cgroup/${allocation.unit}`,
      pid: 123,
      memoryBytes: allocation.policy.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
    };
    const drain = {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      ownerPid: owner.pid,
      memoryBytes: owner.memoryBytes,
      swapBytes: 0,
      oomGroup: 1,
      launcherPid: 122,
      childPid: 124,
      childExitCode: 0,
      kernel: "populated 0\nfrozen 0\n",
    };
    const terminal = {
      identity: { workerId: key("review-worker"), generation: 0 },
      operation: { operationId: key("review-initialize"), operationKind: "initialize" },
      outcome: "success",
      ownerCaptured: true,
      native,
      drain,
      accountingReceipts: [],
    };
    yield* sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
    operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json,native_json,terminal_json)
    VALUES (${key("review-initialize")},'environment',${projectId},${binding.recordId},0,${binding.providerInstanceId},${binding.threadId},${key("review-worker")},0,'initialize',${digest(canonical(request))},
      ${binding.recordId},${binding.taskId},1000,100000,'settled',${canonical(nativeIntent)},${canonical(native)},${canonical(terminal)})`;
    yield* sql`INSERT INTO project_team_pi_process (unit,operation_id,allocation_json,status,owner_json,drain_json)
    VALUES (${allocation.unit},${key("review-initialize")},${canonical(allocation)},'drained',${canonical(owner)},${canonical(drain)})`;
    const freshness = yield* makeProjectTeamReviewFreshness({ environmentId: "environment" });
    yield* freshness.capture({
      projectId,
      taskId: binding.taskId,
      bindingId: binding.recordId,
      generation: 0,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
      operationId: key("review-initialize"),
      specRevision: binding.specRevision,
      planRevision: 0,
      sessionDirectoryRoot,
      expectedCwd: binding.worktree,
      native,
      expectedBriefing: briefing,
      assertCurrent: Effect.void,
    });
    const running = decodeRecord({
      ...compiledClaim.binding,
      status: "running",
      sessionId: native.sessionId,
      revision: 1,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (running.kind !== "run-binding") return yield* Effect.die("Invalid running binding");
    yield* restoreHistoricalBinding(running);
    const managed = {
      projectId,
      bindingId: binding.recordId,
      generation: 0,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
    };
    const principal = { actor: { kind: "agent" as const, id: managedActorId(managed) }, managed };
    const reportAttribution = {
      actor: principal.actor,
      source: { kind: "mcp" as const, id: "project-work.report" },
      recordedAt: at,
    };
    const compiler = yield* makeProjectTeamReviewFindings(auth.resolve);
    const report = (overrides: Partial<ProjectTeamReviewFindingIntent> = {}) =>
      Effect.gen(function* () {
        const current = yield* state();
        const selected = current.tasks.find((t) => t.taskId === binding.taskId)!;
        return decodeIntent({
          ...input(),
          taskId: binding.taskId,
          expectedRevision: current.revision,
          expectedTaskRevision: selected.revision,
          specRevision: binding.specRevision,
          planRevision: binding.planRevision,
          criterionIds: f.selection.criterionIds,
          ...overrides,
        });
      });
    const compile = (intent: ProjectTeamReviewFindingIntent) =>
      sql.withTransaction(compiler.compile(principal, intent, reportAttribution, false));
    return {
      ...f,
      verificationBase: f,
      compiler,
      principal,
      reportAttribution,
      report,
      compile,
      target,
      running,
      state,
      commitRecords,
      reviewRole,
      nativeIntent,
      native,
      allocation,
      owner,
      snapshot,
    };
  });
const fixture = makeFindingFixture();

it.effect(
  "compiles an open parent finding from exact retained reviewer custody without changing tasks or criteria",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.state();
        const command = yield* f.compile(yield* f.report());
        expect(command.records).toHaveLength(1);
        const record = command.records[0];
        expect(record).toMatchObject({
          kind: "review-finding",
          taskId: f.selection.taskId,
          generation: 0,
          revision: 0,
          status: "open",
          originReviewer: {
            bindingId: "review-binding",
            dispatchId: "review-dispatch",
            initializeOperationId: "review-initialize",
            targetSha256: digest(canonical(f.target)),
          },
        });
        expect(record?.recordId.length).toBeLessThanOrEqual(256);
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "same revision retains the old provenance and timestamp; exact next revision preserves origin",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.compile(yield* f.report());
        const original = first.records[0]!;
        yield* restoreHistoricalBinding(original);
        const same = yield* f.sql.withTransaction(
          f.compiler.compile(
            f.principal,
            yield* f.report({
              commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("same-revision"),
            }),
            { ...f.reportAttribution, recordedAt: "2026-01-02T00:00:00.000Z" },
            false,
          ),
        );
        expect(same.records).toEqual([original]);
        const updated = (yield* f.compile(
          yield* f.report({ revision: 1, detail: "Precise reproduction and consequence" }),
        )).records[0];
        expect(updated).toMatchObject({
          revision: 1,
          originReviewer: original.kind === "review-finding" ? original.originReviewer : undefined,
        });
      }),
    ),
);

for (const change of [
  "task",
  "spec",
  "plan",
  "aggregate",
  "criterion",
  "initial-revision",
  "resolution",
  "conflict",
] as const)
  it.effect(`denies ${change} without changing retained findings`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = yield* f.report();
        const candidate = { ...original };
        if (change === "task") candidate.taskId = taskId;
        if (change === "spec") candidate.specRevision++;
        if (change === "plan") candidate.planRevision++;
        if (change === "aggregate") candidate.expectedRevision++;
        if (change === "criterion")
          candidate.criterionIds = [
            ProjectWorkCriterionId.make(f.selection.criterionIds[0]! + "-foreign"),
          ];
        if (change === "initial-revision") candidate.revision = 1;
        if (change === "resolution") {
          candidate.status = "resolved";
          candidate.resolutionArtifactIds = ["retained-looking-output"];
        }
        if (change === "conflict") {
          yield* restoreHistoricalBinding((yield* f.compile(original)).records[0]!);
          candidate.expectedRevision = (yield* f.state()).revision;
          candidate.detail = "A conflicting same revision";
        }
        const before = yield* f.state();
        expect((yield* f.compile(decodeIntent(candidate)).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.state()).toEqual(before);
      }),
    ),
  );

for (const change of [
  "role-tool",
  "binding-tool",
  "human",
  "generation",
  "target",
  "raw",
  "operation",
  "historical-member",
  "historical-thread",
  "historical-session",
] as const)
  it.effect(`denies ${change} reviewer custody before producing a finding`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        if (change === "role-tool")
          yield* restoreHistoricalBinding(
            decodeRecord({
              ...f.reviewRole,
              tools: ["pi.read"],
              revision: f.reviewRole.revision + 1,
            }),
          );
        if (change === "binding-tool")
          yield* restoreHistoricalBinding(
            decodeRecord({
              ...f.running,
              configuration: { ...f.running.configuration, toolIds: ["pi.read"] },
              revision: 2,
            }),
          );
        if (change === "target") {
          yield* f.sql`DROP TRIGGER project_team_review_target_immutable`;
          yield* f.sql`UPDATE project_team_review_target SET manifest_json=' ' || manifest_json`;
        }
        if (change === "raw") {
          yield* f.sql`DROP TRIGGER project_team_review_freshness_immutable`;
          yield* f.sql`UPDATE project_team_review_freshness SET native_jsonl=native_jsonl || ' '`;
        }
        if (change === "operation")
          yield* f.sql`UPDATE project_team_pi_operation SET request_hash=${"b".repeat(64)} WHERE operation_id='review-initialize'`;
        if (change.startsWith("historical-")) {
          const prior = (yield* f.state()).foundationRecords?.find(
            (r) => r.kind === "run-binding" && r.taskId === f.selection.taskId,
          );
          if (prior?.kind !== "run-binding")
            return yield* Effect.die("Missing original implementation history");
          const { sessionId: _old, ...withoutSession } = prior;
          const historical = decodeRecord({
            ...withoutSession,
            recordId: "historical-implementation",
            revision: 0,
            ...(change === "historical-member" ? { memberId: f.running.memberId } : {}),
            ...(change === "historical-thread" ? { threadId: f.running.threadId } : {}),
            ...(change === "historical-session"
              ? { sessionId: f.running.sessionId, providerInstanceId: f.running.providerInstanceId }
              : {}),
          });
          yield* restoreHistoricalBinding(historical);
        }
        const principal =
          change === "human"
            ? { actor: { kind: "human" as const, id: "reviewer" } }
            : change === "generation"
              ? { ...f.principal, managed: { ...f.principal.managed, generation: 1 } }
              : f.principal;
        const before = yield* f.state();
        expect(
          (yield* f.sql
            .withTransaction(
              f.compiler.compile(
                principal,
                yield* f.report(),
                { ...f.reportAttribution, actor: principal.actor },
                false,
              ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
  );

it.effect(
  "captures principal, intent and attribution before SQL yields and rejects unknown host provenance",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.report();
        const principal = structuredClone(f.principal);
        const attribution = structuredClone(f.reportAttribution);
        const effect = f.compiler.compile(principal, request, attribution, false);
        Reflect.set(request, "detail", "mutated after capture");
        Reflect.set(principal.managed, "bindingId", "foreign");
        Reflect.set(attribution.actor, "id", "spoofed");
        expect((yield* f.sql.withTransaction(effect)).records[0]).toMatchObject({
          detail: "A reproducible review finding",
        });
        const injection = { ...(yield* f.report()), target: { headSha: "caller-host-sha" } };
        expect(
          (yield* f.sql
            .withTransaction(f.compiler.compile(f.principal, injection, f.reportAttribution, false))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

const scopedGateway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.fresh(
        ProjectWorkProjectionLive.pipe(
          Layer.provideMerge(
            gatewayRuntime.pipe(
              Layer.provideMerge(ProjectWorkEventBusLive),
              Layer.provide(
                Layer.succeed(ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
const decodePage = Schema.decodeUnknownSync(
  Schema.Struct({ items: Schema.Array(ProjectTeamRecordRead) }),
);
const reportTool = (f: Effect.Success<typeof fixture>, intent: ProjectTeamReviewFindingIntent) =>
  executePiProjectWorkBridgeTool({
    toolName: "project_work_report",
    arguments: { intentJSON: canonical(intent) },
    principal: f.principal,
    source: f.reportAttribution.source,
  });

it.effect(
  "actual Pi report persists one parent finding through Gateway and public reads; exact and semantic retries add no events",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* fixture;
        const gateway = yield* ProjectWorkGateway;
        const before = yield* f.state();
        const intent = yield* f.report();
        yield* reportTool(f, intent);
        const after = yield* f.state();
        expect(after.revision).toBe(before.revision + 1);
        expect(after.tasks).toEqual(before.tasks);
        expect(after.criteria).toEqual(before.criteria);
        expect(after.evidence).toEqual(before.evidence);
        const first = decodePage(
          yield* gateway.read(
            { operation: "foundation-records", projectId, recordKinds: ["review-finding"] },
            { actor: { kind: "human", id: "maintainer" } },
          ),
        ).items;
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
          kind: "review-finding",
          taskId: f.selection.taskId,
          status: "open",
        });
        yield* reportTool(f, intent);
        const sameRevision = yield* f.report({
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("semantic-duplicate"),
        });
        yield* reportTool(f, sameRevision);
        yield* reportTool(f, sameRevision);
        expect(yield* f.state()).toEqual(after);
        expect(
          decodePage(
            yield* gateway.read({
              operation: "foundation-records",
              projectId,
              recordKinds: ["review-finding"],
            }),
          ).items,
        ).toEqual(first);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id=${projectId} AND command_id IN (${intent.commandId},${sameRevision.commandId})`,
        ).toEqual([{ count: 1 }]);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id IN (${intent.commandId},${sameRevision.commandId})`,
        ).toEqual([{ count: 2 }]);
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.checkpointVersion',2,'$.foundationRecords',json('[]')) WHERE project_id=${projectId}`;
        const replayed = yield* f.state();
        expect(replayed.foundationRecords).toEqual(after.foundationRecords);
        expect(replayed.revision).toBe(after.revision);
        expect(replayed.tasks).toEqual(after.tasks);
        expect(replayed.criteria).toEqual(after.criteria);
        const projection = yield* ProjectWorkProjection;
        yield* projection.rebuild(projectId);
        expect(yield* f.state()).toEqual(after);
        expect(
          decodePage(
            yield* gateway.read({
              projectId,
              operation: "foundation-records",
              recordKinds: ["review-finding"],
            }),
          ).items,
        ).toEqual(first);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id=${projectId} AND command_id IN (${intent.commandId},${sameRevision.commandId})`,
        ).toEqual([{ count: 1 }]);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id IN (${intent.commandId},${sameRevision.commandId})`,
        ).toEqual([{ count: 2 }]);
      }),
    ),
);

it.effect("actual report route denies inherited/foreign compilation and raw record injection", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* fixture;
      const auth = yield* ProjectTeamAuthorization;
      const intent = yield* f.report();
      expect(
        (yield* auth.intent(f.principal, intent, f.reportAttribution, false).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql
          .withTransaction(
            auth
              .intent(f.principal, intent, f.reportAttribution, false)
              .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const command = yield* f.compile(intent);
      const gateway = yield* ProjectWorkGateway;
      for (const principal of [
        f.principal,
        { actor: { kind: "human" as const, id: "maintainer" } },
      ]) {
        expect((yield* auth.write(principal, command).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* gateway
            .write(command, principal.actor, f.reportAttribution.source, principal)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(
        (yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_report",
          arguments: { intentJSON: canonical(intent) },
          principal: { actor: { kind: "human", id: "maintainer" } },
          source: { kind: "web", id: "fixture-human" },
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.state()).foundationRecords?.filter((r) => r.kind === "review-finding"),
      ).toEqual([]);
    }),
  ),
);

it.effect("failed owning COMMIT leaves no finding or successful receipt; exact retry works", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* fixture;
      const gateway = yield* ProjectWorkGateway;
      const query = yield* ProjectWorkQuery;
      const intent = yield* f.report();
      const before = yield* f.state();
      const beforeSnapshot = yield* query.snapshot(projectId);
      yield* f.sql`CREATE TABLE controlled_findings_parent (id TEXT PRIMARY KEY)`;
      yield* f.sql`CREATE TABLE controlled_findings_child (id TEXT REFERENCES controlled_findings_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      yield* f.sql`CREATE TRIGGER controlled_findings_commit_failure AFTER INSERT ON project_team_review_finding BEGIN INSERT INTO controlled_findings_child VALUES ('missing'); END`;
      let escaped = false;
      expect(
        (yield* reportTool(f, intent).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              escaped = true;
            }),
          ),
          Effect.exit,
        ))._tag,
      ).toBe("Failure");
      expect(escaped).toBe(false);
      expect(yield* f.sql`SELECT COUNT(*) AS count FROM controlled_findings_child`).toEqual([
        { count: 0 },
      ]);
      expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
      expect(
        decodePage(
          yield* gateway.read({
            projectId,
            operation: "foundation-records",
            recordKinds: ["review-finding"],
          }),
        ).items,
      ).toHaveLength(0);
      expect(yield* f.state()).toEqual(before);
      expect(
        yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
      ).toEqual([{ count: 0 }]);
      yield* f.sql`DROP TRIGGER controlled_findings_commit_failure`;
      yield* reportTool(f, intent);
      expect(
        decodePage(
          yield* gateway.read({
            projectId,
            operation: "foundation-records",
            recordKinds: ["review-finding"],
          }),
        ).items,
      ).toHaveLength(1);
    }),
  ),
);

it.effect(
  "raw retained bytes, an approved verification target and success-looking IDs do not authorize finding resolution",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = (yield* f.compile(yield* f.report())).records[0]!;
        yield* restoreHistoricalBinding(original);
        const job = f.target.prepared.manifest;
        const artifacts = yield* makeProjectWorkArtifacts({
          environmentId: "environment",
          maximumArtifactBytes: 1024,
        });
        const retained = yield* artifacts.retain({
          artifactId: "resolution-looking-output",
          sourceId: job.jobId,
          bytes: new Uint8Array([112, 97, 115, 115]),
          applicability: {
            projectId,
            taskId: job.taskId,
            specRevision: job.specRevision,
            planRevision: job.planRevision,
            repository: job.target.repository,
            worktree: job.target.worktree,
            testedTree: job.target.testedTree,
            testedCommit: job.target.testedCommit,
            baseSha: job.target.baseSha,
            headSha: job.target.headSha,
            command: canonical(job.command),
            exitCode: 0,
            environmentSummary: "Controlled retained output only",
            integration: false,
          },
        });
        expect(yield* artifacts.readRetained(retained.artifactId)).toBeDefined();
        const before = yield* f.state();
        expect(
          (yield* f
            .compile(
              yield* f.report({
                revision: 1,
                status: "resolved",
                resolutionArtifactIds: [retained.artifactId],
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "a reviewer grant revoked during actual final validation rolls back the finding and receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.state();
        const intent = yield* f.report();
        let escaped = false;
        const result = yield* f.repository
          .executeAtomic(
            f.compiler
              .compile(f.principal, intent, f.reportAttribution, false)
              .pipe(Effect.map((command) => [command])),
            Effect.gen(function* () {
              yield* restoreHistoricalBinding(
                decodeRecord({
                  ...f.reviewRole,
                  status: "retired",
                  revision: f.reviewRole.revision + 1,
                }),
              );
              yield* f.compiler.compile(f.principal, intent, f.reportAttribution, true);
            }),
          )
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.result,
          );
        expect(result._tag).toBe("Failure");
        expect(escaped).toBe(false);
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM project_team_review_finding`).toEqual([
          { count: 0 },
        ]);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
);

it.effect(
  "latest finding revision preserves immutable origin and denies stale original command replay",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* fixture;
        const gateway = yield* ProjectWorkGateway;
        const initial = yield* f.report();
        yield* reportTool(f, initial);
        const first = decodeRecord(
          decodePage(
            yield* gateway.read({
              projectId,
              operation: "foundation-records",
              recordKinds: ["review-finding"],
            }),
          ).items[0],
        );
        if (first?.kind !== "review-finding") return yield* Effect.die("Missing original finding");
        const next = yield* f.report({
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("finding-next"),
          revision: 1,
          detail: "Reproduction narrowed to the original criterion",
        });
        yield* reportTool(f, next);
        const beforeReplay = yield* f.state();
        const latest = decodePage(
          yield* gateway.read({
            projectId,
            operation: "foundation-records",
            recordKinds: ["review-finding"],
          }),
        ).items[0];
        expect(latest).toMatchObject({
          recordId: first.recordId,
          revision: 1,
          generation: 0,
          target: first.target,
          originReviewer: first.originReviewer,
          detail: next.detail,
        });
        expect((yield* reportTool(f, initial).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(beforeReplay);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_events WHERE project_id=${projectId} AND command_id IN (${initial.commandId},${next.commandId})`,
        ).toEqual([{ count: 2 }]);
      }),
    ),
);

it.effect("stable finding identity rejects reuse against a replaced original target", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = (yield* f.compile(yield* f.report())).records[0];
      if (original?.kind !== "review-finding") return yield* Effect.die("Missing original finding");
      yield* restoreHistoricalBinding(
        decodeRecord({ ...original, target: { ...original.target, headSha: "replaced-head" } }),
      );
      expect((yield* f.compile(yield* f.report()).pipe(Effect.result))._tag).toBe("Failure");
    }),
  ),
);

const decodeCompletionReport = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, strict);
const makeProposalFixture = (
  coherentCustody = false,
  verificationOutcome?: "success" | "failed" | "timed-out" | "canceled",
  existing?: Effect.Success<ReturnType<typeof makeFindingFixture>>,
  suffix = "",
  configuredAdmissionSource = false,
) =>
  Effect.gen(function* () {
    const f =
      existing ??
      (yield* makeFindingFixture(
        coherentCustody,
        verificationOutcome,
        undefined,
        suffix,
        configuredAdmissionSource,
      ));
    const key = (value: string) => value + suffix;
    const current = yield* f.state();
    const task = current.tasks.find((t) => t.taskId === f.running.taskId)!;
    const memberships =
      current.foundationRecords?.filter(
        (r) => r.kind === "task-membership" && r.taskId === task.taskId,
      ) ?? [];
    const membership = memberships[0];
    if (memberships.length !== 1 || membership?.kind !== "task-membership")
      return yield* Effect.die("Missing reviewer membership");
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      verifyStage: () => Effect.void,
    });
    let snapshot = f.snapshot;
    for (const stage of [
      "workspace-ready",
      "setup-complete",
      "session-bound",
      "assignment-intent",
    ] as const) {
      snapshot = yield* journal.advanceStage(snapshot.fence, {
        receiptId: key("proposal-stage-" + stage),
        stage,
        evidence: { controlledCustody: true },
      });
    }
    const rootBudget = {
      rootTaskId: snapshot.intent.limits.rootTaskId,
      maximumTokens: snapshot.intent.limits.maximumTokens,
      deadlineAtMs: snapshot.intent.limits.rootDeadlineAtMs,
    };
    const operationLimits = {
      maximumTokens: snapshot.intent.limits.attemptMaximumTokens,
      deadlineAtMs: snapshot.intent.limits.deadlineAtMs,
    };
    const roots =
      current.foundationRecords?.filter(
        (r) =>
          r.kind === "run-binding" &&
          (f.running.parentRunId === undefined
            ? r.taskId === rootBudget.rootTaskId
            : r.recordId === f.running.parentRunId),
      ) ?? [];
    const root = roots[0];
    if (roots.length !== 1 || root?.kind !== "run-binding")
      return yield* Effect.die("Missing original root binding");
    const originalInitialize = { ...f.nativeIntent, rootBudget, operationLimits };
    yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${canonical(originalInitialize)},root_binding_id=${root.recordId},root_task_id=${root.taskId},maximum_tokens=${operationLimits.maximumTokens},deadline_at_ms=${operationLimits.deadlineAtMs} WHERE operation_id=${key("review-initialize")}`;
    const request = {
      kind: "prompt",
      operationId: key("review-assignment"),
      threadId: f.running.threadId,
      prompt: "Review the original target",
      resumeCursor: f.native,
    };
    const intent = { ...originalInitialize, request, binding: f.running };
    yield* f.sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
    operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    VALUES (${key("review-assignment")},'environment',${projectId},${f.running.recordId},0,${f.running.providerInstanceId},${f.running.threadId},${key("review-assignment-worker")},1,'prompt',${digest(canonical(request))},
    ${root.recordId},${root.taskId},${operationLimits.maximumTokens},${operationLimits.deadlineAtMs},'running',${canonical(intent)})`;
    // Synthetic retained custody only; no process is started by this fixture.
    const allocation =
      coherentCustody || configuredAdmissionSource
        ? yield* preallocatePiManagedProcess({
            workspaceRoot: f.running.worktree,
            workspaceAccess: "readonly",
            nativeStateRoot: f.allocation.launch.nativeState!.path,
            protectedRoots: f.allocation.launch.protectedRoots,
            runtimeFiles: f.allocation.launch.runtimeFiles.map((file) => ({
              source: file.source,
              target: file.target,
            })),
            argv: f.allocation.launch.argv,
            memoryBytes: f.allocation.policy.memoryBytes,
            runtimeSeconds: f.allocation.policy.runtimeSeconds,
          })
        : { ...f.allocation, unit: f.allocation.unit + "-assignment" };
    const assignmentOwner = {
      ...f.owner,
      unit: allocation.unit,
      nonce: allocation.nonce,
      cgroup: "/sys/fs/cgroup/" + allocation.unit,
    };
    const assignedIntent = { ...intent, allocation };
    yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${canonical(assignedIntent)} WHERE operation_id=${key("review-assignment")}`;
    yield* f.sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status,owner_json) VALUES (${allocation.unit},${key("review-assignment")},${canonical(allocation)},'captured',${canonical(assignmentOwner)})`;
    const operation = {
      environmentId: "environment",
      projectId,
      reviewTaskId: task.taskId,
      bindingId: f.running.recordId,
      generation: 0,
      providerInstanceId: f.running.providerInstanceId,
      threadId: f.running.threadId,
      operationId: key("review-assignment"),
      operationKind: "prompt" as const,
      workerId: key("review-assignment-worker"),
      ordinal: 1,
    };
    const criteria = current.criteria.filter(
      (c) =>
        c.taskId === task.taskId &&
        (c.required || task.specification?.criterionIds.includes(c.criterionId)),
    );
    const report = decodeCompletionReport({
      type: "project-team.assignment.report",
      commandId: key("review-completion-report"),
      projectId,
      taskId: task.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: task.revision,
      specRevision: f.running.specRevision,
      planRevision: f.running.planRevision,
      assignmentId: membership.recordId,
      expectedAssignmentRevision: membership.revision,
      summary: "Original independent review completed; pending qualification",
      evidenceIds: [],
      outputArtifactIds: [],
      outputs: criteria.map((c) => ({
        criterionId: c.criterionId,
        kind: "observation",
        detail: "Checked the original target; no findings in this control",
      })),
      outcome: "complete",
    });
    const auth = yield* ProjectTeamAuthorization;
    if (report.type !== "project-team.assignment.report")
      return yield* Effect.die("Invalid completion report fixture");
    const proposals = yield* makeProjectTeamReviewCompletionProposals(auth.resolve);
    const compile = () =>
      f.sql.withTransaction(
        proposals
          .compile(f.principal, report, f.reportAttribution)
          .pipe(Effect.provideService(ProjectTeamReviewReportOperation, operation)),
      );
    const proposalSnapshot = yield* journal.readRetained(snapshot.fence.dispatchId);
    return {
      ...f,
      proposals,
      operation,
      completionReport: report,
      compileProposal: compile,
      proposalSnapshot,
      assignmentAllocation: allocation,
      assignmentOwner,
      operationLimits,
      receiptRootBindingId: root.recordId,
    };
  });
const proposalFixture = makeProposalFixture();
const completionJoin = {
  receiptId: "review-joined",
  stage: "settled" as const,
  evidence: { controlledOwnedDrain: true },
};
it.effect(
  "completed review consumer requires the original SQL, repository, and caller transaction",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const repo = yield* ProjectWorkRepository;
        const consumer = yield* makeProjectTeamReviewCompletion({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        expect(
          (yield* consumer.prepare(f.proposalSnapshot, completionJoin).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              consumer
                .prepare(f.proposalSnapshot, completionJoin)
                .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              consumer
                .prepare(f.proposalSnapshot, completionJoin)
                .pipe(Effect.provideService(ProjectWorkRepository, { ...repo })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              consumer
                .prepare(f.proposalSnapshot, completionJoin)
                .pipe(
                  Effect.updateContext((context: Context.Context<never>) =>
                    Context.omit(SqlClient.SqlClient)(context),
                  ),
                ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);
it.effect("completed review consumer leaves an original review without a proposal unchanged", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* proposalFixture;
      const before = yield* f.state();
      const consumer = yield* makeProjectTeamReviewCompletion({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 128,
      });
      expect(
        yield* f.sql.withTransaction(consumer.prepare(f.proposalSnapshot, completionJoin)),
      ).toBeUndefined();
      expect(yield* f.state()).toEqual(before);
    }),
  ),
);
it.effect(
  "completed review consumer denies a pending report without original terminal consumption",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const before = yield* f.state();
        const consumer = yield* makeProjectTeamReviewCompletion({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const proof = yield* f.sql.withTransaction(
          consumer.prepare(f.proposalSnapshot, completionJoin),
        );
        expect(proof?.status).toBe("denied");
        if (proof?.status === "denied") expect(proof.reason).toBe("assignment-incomplete");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);
const makeConsumedReviewFixture = (
  options: {
    readonly criticalFinding?: boolean;
    readonly referencedEvidence?: boolean;
    readonly parentAssessment?: boolean | "empty";
    readonly withoutCurrentTarget?: boolean;
    readonly assessmentVerdict?: "met" | "not-met";
    readonly verificationOutcome?: "success" | "failed" | "timed-out" | "canceled";
    readonly suffix?: string;
  } = {},
  existing?: Effect.Success<ReturnType<typeof makeProposalFixture>>,
) =>
  Effect.gen(function* () {
    const f = existing ?? (yield* makeProposalFixture(true, options.verificationOutcome));
    if (options.criticalFinding)
      yield* f.repository.execute(yield* f.compile(yield* f.report({ severity: "critical" })));
    const initial = yield* f.state();
    const criterion = initial.criteria.find((c) => c.taskId === f.running.taskId);
    if (!criterion) return yield* Effect.die("Missing original child criterion");
    const referenceId = ProjectWorkEvidenceId.make("review-reference");
    if (options.referencedEvidence)
      yield* f.repository.execute(
        yield* decodeWorkCommand({
          type: "project-work.evidence.add",
          commandId: "review-reference-add",
          projectId,
          evidence: {
            taskId: f.running.taskId,
            evidenceId: referenceId,
            criterionId: criterion.criterionId,
            kind: "observation",
            summary: "Retained review observation",
            detail: "Exact retained review observation",
            scopeHash: projectTeamScopeHash(initial, f.running.taskId),
            recordedAt: at,
            revision: 0,
            attribution,
          },
          addedAt: at,
        }),
      );
    const parentCriterion = initial.criteria.find(
      (c) => c.criterionId === f.selection.criterionIds[0] && c.taskId === f.selection.taskId,
    );
    const parentReferenceId = ProjectWorkEvidenceId.make("consumed-parent-assessment");
    if (options.parentAssessment === true) {
      if (!parentCriterion) return yield* Effect.die("Missing original parent criterion");
      const plan = initial.foundationRecords?.find(
        (r) =>
          r.kind === "plan-revision" &&
          r.taskId === parentCriterion.taskId &&
          r.planRevision === f.target.prepared.manifest.planRevision,
      );
      yield* f.repository.execute(
        yield* decodeWorkCommand({
          type: "project-work.evidence.add",
          commandId: "consumed-parent-assessment-add",
          projectId,
          evidence: {
            evidenceId: parentReferenceId,
            taskId: parentCriterion.taskId,
            criterionId: parentCriterion.criterionId,
            kind: "observation",
            summary: "Original parent review observation",
            detail: "Inspected the exact original parent criterion",
            scopeHash: projectTeamScopeHash(
              initial,
              parentCriterion.taskId,
              plan?.kind === "plan-revision" ? plan : undefined,
            ),
            recordedAt: at,
            revision: 0,
            attribution,
          },
          addedAt: at,
        }),
      );
    }
    const completionReport = decodeCompletionReport({
      ...f.completionReport,
      expectedRevision: (yield* f.state()).revision,
      evidenceIds: options.referencedEvidence ? [referenceId] : [],
      ...(options.parentAssessment === "empty"
        ? { criterionAssessments: [] }
        : options.parentAssessment && parentCriterion
          ? {
              criterionAssessments: [
                {
                  criterionId: parentCriterion.criterionId,
                  expectedRevision: parentCriterion.revision,
                  verdict: options.assessmentVerdict ?? "met",
                  detail: "Original pending parent assessment",
                  evidenceIds: [parentReferenceId],
                },
              ],
            }
          : {}),
    });
    if (completionReport.type !== "project-team.assignment.report")
      return yield* Effect.die("Invalid consumed report fixture");
    yield* f.sql.withTransaction(
      f.proposals
        .compile(f.principal, completionReport, f.reportAttribution)
        .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
    );
    const authorization = yield* ProjectTeamAuthorization;
    const authority = yield* authorization.resolve(f.principal);
    if (!authority) return yield* Effect.die("Missing original controlled reviewer authority");
    const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
    const prompt: PiDurableOperation = {
      operation: { operationId: f.operation.operationId, operationKind: "prompt" },
      workerId: f.operation.workerId,
      ordinal: f.operation.ordinal,
      authority,
      principal: f.principal,
      allocation: f.assignmentAllocation,
      maximumTokens: f.operationLimits.maximumTokens,
      deadlineAtMs: f.operationLimits.deadlineAtMs,
    };
    yield* operations.persistNative(prompt, f.native);
    const mailbox = yield* makeProjectTeamMailboxConsumption({ environmentId: "environment" });
    const sealed = yield* mailbox.sealInitialAssignment({
      operationId: f.operation.operationId,
      baseSystemText: f.reviewRole.instructions,
    });
    const accounting = yield* makeModelAccounting({
      environmentId: "environment",
      routeId: "command-code-ling-free",
      model: authority.binding.model,
      acceptedReportedModels: [authority.binding.model],
      resolveOperation: operations.resolveOperation,
    });
    const fields = {
      workerId: prompt.workerId,
      operationId: prompt.operation.operationId,
      generation: authority.binding.generation,
      requestId: 1,
      routeId: "command-code-ling-free",
      provider: "command-code" as const,
      model: authority.binding.model,
      maxInputTokens: 10,
      maxOutputTokens: 10,
      callCount: 1 as const,
      deadlineAtMs: prompt.deadlineAtMs,
    };
    const reservation = yield* accounting.reserve(f.principal, fields);
    const limits = f.proposalSnapshot.intent.limits;
    const persistedRoot = yield* f.sql<{
      root_binding_id: string;
      root_task_id: string;
    }>`SELECT root_binding_id,root_task_id FROM project_team_pi_operation WHERE operation_id=${f.operation.operationId} LIMIT 2`;
    const operationRootProof = yield* f.sql.withTransaction(
      operations.resolveOperation(authority, fields),
    );
    if (
      persistedRoot.length !== 1 ||
      persistedRoot[0]?.root_binding_id !== f.receiptRootBindingId ||
      persistedRoot[0]?.root_task_id !== limits.rootTaskId ||
      operationRootProof.rootTaskId !== limits.rootTaskId
    )
      return yield* Effect.die(
        `PiOperations.resolveOperation did not retain the original human root before receipt read: ${canonical(
          {
            rowCount: persistedRoot.length,
            rowRootBindingId: persistedRoot[0]?.root_binding_id ?? null,
            retainedRootBindingId: f.receiptRootBindingId,
            rowRootTaskId: persistedRoot[0]?.root_task_id ?? null,
            proofRootTaskId: operationRootProof.rootTaskId,
            expectedRootTaskId: limits.rootTaskId,
          },
        )}`,
      );
    // Controlled broker-input custody, not an HTTP/model request.
    yield* mailbox.bindRequestInput({
      operationId: f.operation.operationId,
      reservationId: reservation.reservationId,
      encodedRequestSha256: digest(
        canonical({
          model: fields.model,
          messages: [
            { role: "system", content: sealed.systemText },
            { role: "user", content: f.proposalSnapshot.intent.request.assignment },
          ],
        }),
      ),
    });
    const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
    const settlement = yield* accounting.settle({
      ...fields,
      reservationId: reservation.reservationId,
      outcome: "reported",
      transportDrained: true,
      chargedInputTokens: 2,
      chargedOutputTokens: 1,
      reportedModel: fields.model,
      reportedUsage: usage,
    });
    const owner = f.assignmentOwner;
    const drain = {
      unit: owner.unit,
      invocation: owner.invocation,
      cgroup: owner.cgroup,
      ownerPid: owner.pid,
      memoryBytes: owner.memoryBytes,
      swapBytes: 0 as const,
      oomGroup: 1 as const,
      launcherPid: 122,
      childPid: 124,
      childExitCode: 0,
      kernel: "populated 0\nfrozen 0\n",
    };
    const terminal: PiSessionTerminal = {
      identity: { workerId: prompt.workerId, generation: authority.binding.generation },
      operation: prompt.operation,
      outcome: "success",
      ownerCaptured: true,
      native: f.native,
      drain,
      accountingReceipts: [
        {
          requestId: 1,
          reservationId: reservation.reservationId,
          accountingReceiptId: settlement.accountingReceiptId,
          routeId: fields.routeId,
          provider: fields.provider,
          model: fields.model,
          reportedModel: fields.model,
          usage,
        },
      ],
    };
    yield* operations.persistTerminal(prompt, terminal);
    const sessions = yield* makeProjectTeamSessionReceipts({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 128,
    });
    const receiptClaim = f.proposalSnapshot.intent.compiledClaim.transition;
    if (receiptClaim?.kind !== "claim")
      return yield* Effect.die("Missing reviewer claim before session receipt read");
    const originalReceipt = yield* sessions.readAssignment(f.proposalSnapshot).pipe(
      Effect.tapError((error) =>
        Effect.die(
          new Error(
            `Actual session receipt reader rejected the operation accepted by Pi accounting: ${canonical(
              {
                receiptError: { code: error.code, reason: error.reason },
                operationRootTaskId: operationRootProof.rootTaskId,
                reviewerBindingId: receiptClaim.binding.recordId,
                reviewerParentRunId: receiptClaim.binding.parentRunId ?? null,
                rootTaskId: limits.rootTaskId,
                constructedRootBindingId: f.receiptRootBindingId,
                producerAcceptedRoot: {
                  rowBindingId: persistedRoot[0]?.root_binding_id ?? null,
                  rowTaskId: persistedRoot[0]?.root_task_id ?? null,
                  rootTaskId: operationRootProof.rootTaskId,
                },
              },
            )}`,
          ),
        ),
      ),
    );
    if (!originalReceipt) return yield* Effect.die("Missing full original assignment receipt");
    const job = f.target.prepared.manifest;
    const implementationBinding = (yield* f.state()).foundationRecords?.find(
      (record) => record.kind === "run-binding" && record.recordId === job.bindingId,
    );
    if (implementationBinding?.kind !== "run-binding")
      return yield* Effect.die("Missing original target binding");
    const workspaceRows = yield* f.sql<{
      receipt_json: string;
    }>`SELECT receipt_json FROM project_team_workspace_receipt WHERE dispatch_id=${job.dispatchId} LIMIT 2`;
    if (workspaceRows.length !== 1) return yield* Effect.die("Missing original target workspace");
    const workspace = yield* decodeControlledWorkspace(workspaceRows[0]!.receipt_json);
    const registry = yield* makeProjectTeamPiRuntime();
    yield* registry.publishAssets(
      implementationBinding.providerInstanceId,
      {
        runtimeFiles: [],
        revalidate: Effect.void,
        borrow: (effect) => effect,
      },
      {
        inspect: Effect.die("Unexpected runtime inspection"),
        prepareOperation: () => Effect.die("Unexpected native preparation"),
        readSession: () => Effect.die("Unexpected native session read"),
        readThread: () => Effect.die("Unexpected native thread read"),
        requestStop: () => Effect.die("Unexpected native stop"),
        stopAll: Effect.die("Unexpected native stop"),
        authorizeSkills: () => Effect.die("Unexpected native skill authorization"),
        discoverNativeSkills: () => Effect.die("Unexpected native skill discovery"),
      },
    );
    const targetObservation: ManagedGit.ManagedVerificationTarget = {
      receipt: workspace,
      cwd: job.target.worktree,
      baseSha: job.target.baseSha,
      headSha: job.target.headSha,
      testedCommit: job.target.testedCommit,
      testedTree: job.target.testedTree,
    };
    const targetControl = {
      calls: 0,
      driftAt: 0,
      postFailureAt: 0,
      permits: 0,
      insidePermit: false,
    };
    const makeTarget = makeProjectTeamReviewCurrentTarget({
      environmentId: "environment",
    });
    const targetService = yield* Effect.gen(function* () {
      return yield* makeTarget;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectTeamPiRuntime, registry),
          Layer.mock(GitWorkflowService, {
            withRepositoryPermit: (_operation, cwd, effect) =>
              Effect.gen(function* () {
                expect((yield* Effect.serviceOption(f.sql.transactionService))._tag).toBe("None");
                expect(cwd).toBe(workspace.assignment.primaryRoot);
                expect(targetControl.insidePermit).toBe(false);
                targetControl.permits++;
                targetControl.insidePermit = true;
                return yield* effect.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      targetControl.insidePermit = false;
                    }),
                  ),
                );
              }),
          }),
        ),
      ),
    );
    const makeConsumer = makeProjectTeamReviewCompletion({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 128,
    });
    const consumer = yield* Effect.gen(function* () {
      return yield* makeConsumer;
    }).pipe(Effect.provideService(ProjectTeamReviewCurrentTarget, targetService));
    const joined = {
      receiptId: "review-original-joined" + (options.suffix ?? ""),
      stage: "settled" as const,
      evidence: yield* decodeControlledJson(
        canonical({
          version: 1,
          dispatchId: f.proposalSnapshot.fence.dispatchId,
          bindingId: f.running.recordId,
          generation: f.running.generation,
          claimGeneration: f.proposalSnapshot.fence.claimGeneration,
          setup: { controlledCustody: true },
          operations: [
            {
              operationId: prompt.operation.operationId,
              allocation: f.assignmentAllocation,
              owner,
              reconciliation: {
                state: "drained",
                unit: owner.unit,
                invocation: owner.invocation,
                cgroup: owner.cgroup,
                kernel: "removed",
              },
            },
          ],
        }),
      ),
    };
    const withTarget = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Both native entry points are intercepted: this token intentionally has no private branding or filesystem authority.
          const controlledContext = {} as ManagedGit.ManagedGitExecution;
          const make = vi.spyOn(ManagedGit, "make").mockImplementation(() => {
            expect(targetControl.insidePermit).toBe(true);
            return Effect.succeed(controlledContext);
          });
          const controlledRead: typeof ManagedGit.withManagedVerificationTarget = (_context, use) =>
            Effect.gen(function* () {
              expect(targetControl.insidePermit).toBe(true);
              expect((yield* Effect.serviceOption(f.sql.transactionService))._tag).toBe("Some");
              const call = ++targetControl.calls;
              return yield* use(
                call === targetControl.driftAt
                  ? { ...targetObservation, headSha: "f".repeat(40) }
                  : targetObservation,
              ).pipe(
                Effect.onExit(() =>
                  call === targetControl.postFailureAt
                    ? Effect.fail(
                        new GitCommandError({
                          operation: "ControlledReviewTarget",
                          command: "/usr/bin/git",
                          cwd: job.target.worktree,
                          detail: "Controlled post-callback target drift",
                        }),
                      )
                    : Effect.void,
                ),
              );
            });
          const read = vi
            .spyOn(ManagedGit, "withManagedVerificationTarget")
            .mockImplementation(controlledRead);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              read.mockRestore();
              make.mockRestore();
            }),
          );
          return yield* targetService.withOriginalTarget(f.proposalSnapshot, joined, effect);
        }),
      );
    const prepare = () =>
      options.withoutCurrentTarget
        ? f.sql.withTransaction(consumer.prepare(f.proposalSnapshot, joined))
        : withTarget(f.sql.withTransaction(consumer.prepare(f.proposalSnapshot, joined)));
    return {
      ...f,
      completionReport,
      consumer,
      targetService,
      targetControl,
      withTarget,
      prepare,
      joined,
      originalReceipt,
      sessions,
      prompt,
      reservation,
      referenceId,
      criterion,
    };
  });
const consumedReviewFixture = makeConsumedReviewFixture();

it.effect("reads a completed human-approved child receipt against its retained original root", () =>
  scopedGateway(
    Effect.gen(function* () {
      const proposal = yield* makeProposalFixture(
        false,
        "failed",
        undefined,
        "-receipt-root",
        true,
      );
      const f = yield* makeConsumedReviewFixture(
        {
          parentAssessment: true,
          verificationOutcome: "failed",
        },
        proposal,
      );
      const state = yield* f.state();
      expect(
        state.tasks.find((task) => task.taskId === f.proposalSnapshot.intent.limits.rootTaskId)
          ?.state,
      ).toBe("ready");
      expect(yield* f.sessions.readAssignment(f.proposalSnapshot)).toEqual(f.originalReceipt);
      const rows = yield* f.sql<{
        root_binding_id: string;
        root_task_id: string;
      }>`SELECT root_binding_id,root_task_id FROM project_team_pi_operation WHERE operation_id=${f.operation.operationId} LIMIT 2`;
      expect(rows).toEqual([
        {
          root_binding_id: f.receiptRootBindingId,
          root_task_id: f.proposalSnapshot.intent.limits.rootTaskId,
        },
      ]);
    }),
  ),
);

it.effect("denies a completed child receipt when its operation names a foreign root binding", () =>
  scopedGateway(
    Effect.gen(function* () {
      const proposal = yield* makeProposalFixture(
        false,
        "failed",
        undefined,
        "-receipt-root",
        true,
      );
      const f = yield* makeConsumedReviewFixture({ verificationOutcome: "failed" }, proposal);
      yield* f.sql`UPDATE project_team_pi_operation SET root_binding_id='foreign-retained-root' WHERE operation_id=${f.operation.operationId}`;
      expect((yield* f.sessions.readAssignment(f.proposalSnapshot).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  ),
);

it.effect("denies a completed child receipt after its original root grant is invalidated", () =>
  scopedGateway(
    Effect.gen(function* () {
      const proposal = yield* makeProposalFixture(
        false,
        "failed",
        undefined,
        "-receipt-root",
        true,
      );
      const f = yield* makeConsumedReviewFixture({ verificationOutcome: "failed" }, proposal);
      const state = yield* f.state();
      const root = state.foundationRecords?.find(
        (record) => record.kind === "run-binding" && record.recordId === f.receiptRootBindingId,
      );
      if (root?.kind !== "run-binding") return yield* Effect.die("Missing original retained root");
      const rootGate = state.foundationRecords?.find(
        (record) => record.kind === "gate" && record.recordId === root.authorizationGateId,
      );
      if (rootGate?.kind !== "gate") return yield* Effect.die("Missing original root grant");
      yield* restoreHistoricalBinding({
        ...rootGate,
        status: "invalidated",
        revision: rootGate.revision + 1,
      });
      expect(
        (yield* f.state()).foundationRecords?.find(
          (record) => record.kind === "gate" && record.recordId === rootGate.recordId,
        ),
      ).toMatchObject({ status: "invalidated", revision: rootGate.revision + 1 });
      expect((yield* f.sessions.readAssignment(f.proposalSnapshot).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  ),
);

it.effect(
  "a historical completed review reader authenticates accepted joined review without a new target loan",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const proof = yield* f.prepare();
        if (proof?.status !== "completed")
          return yield* Effect.die("Missing controlled completed review");
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const reader = yield* makeProjectTeamCompletedReviewReader({
          environmentId: "environment",
        });
        const loans = f.targetControl.permits;
        const retained = yield* f.sql.withTransaction(
          reader.readInTransaction({
            dispatchId: f.proposalSnapshot.fence.dispatchId,
            expectedProposalSha256: proof.proposalSha256,
          }),
        );
        expect(retained.proposal.sha256).toBe(proof.proposalSha256);
        expect(retained.proposal.manifest.target).toEqual(proof.target);
        expect(retained.joined.receiptId).toBe(f.joined.receiptId);
        expect(f.targetControl.permits).toBe(loans);
        expect(
          (yield* reader
            .readInTransaction({
              dispatchId: f.proposalSnapshot.fence.dispatchId,
              expectedProposalSha256: proof.proposalSha256,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);
const completeIntegrationSourceReview = Effect.fn("integrationTest.completeSourceReview")(
  function* (f: Effect.Success<ReturnType<typeof makeConsumedReviewFixture>>) {
    const proof = yield* f.prepare();
    if (proof?.status !== "completed")
      return yield* Effect.die("Missing actual accepted source review");
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 128,
      verifyStage: () => Effect.void,
      verifySettlement: () => Effect.void,
      prepareReviewCompletion: f.consumer.prepare,
      verifyReviewTarget: f.targetService.assertOriginalInTransaction,
    });
    yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
    const current = yield* f.state();
    const binding = current.foundationRecords?.find(
      (record) => record.kind === "run-binding" && record.recordId === f.selection.bindingId,
    );
    if (binding?.kind !== "run-binding")
      return yield* Effect.die("Missing selected original source binding");
    const job = f.prepared.manifest;
    return yield* decodeIntegrationSourceRef({
      taskId: job.taskId,
      bindingId: job.bindingId,
      expectedBindingRevision: binding.revision,
      generation: job.generation,
      reviewDispatchId: f.proposalSnapshot.fence.dispatchId,
      expectedReviewProposalSha256: proof.proposalSha256,
      verificationJobId: job.jobId,
      expectedManifestHash: f.prepared.sha256,
      expectedBranchRef: job.target.branchRef,
      expectedBaseSha: job.target.baseSha,
      expectedHeadSha: job.target.headSha,
      expectedTestedTree: job.target.testedTree,
    });
  },
);
const noPublicationNetwork = () => Effect.die("Publication enqueue must not execute GitHub");
const makeHumanPublicationFixture = Effect.fn("publicationTest.authenticFixture")(function* (
  options: {
    readonly accepted?: boolean;
    readonly verificationOutcome?: "success" | "failed";
    readonly parentAssessment?: boolean;
    readonly settleReviewRoot?: boolean;
  } = {},
  shared?: Effect.Success<ReturnType<typeof makeConsumedReviewFixture>>,
) {
  const f =
    shared ??
    (yield* makeConsumedReviewFixture({
      verificationOutcome: options.verificationOutcome ?? "success",
      ...(options.parentAssessment === undefined
        ? {}
        : { parentAssessment: options.parentAssessment }),
    }));
  if (options.accepted !== false) yield* completeIntegrationSourceReview(f);
  if (options.settleReviewRoot) {
    const rows =
      yield* f.sql`SELECT dispatch_id FROM project_team_dispatch WHERE environment_id='environment' AND binding_id=${f.reviewRootBindingId} LIMIT 2`;
    if (rows.length !== 1 || typeof rows[0]?.dispatch_id !== "string")
      return yield* Effect.die("Missing controlled coordinator dispatch");
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      verifyStage: () => Effect.void,
      verifySettlement: () => Effect.void,
    });
    const original = yield* journal.readRetained(rows[0].dispatch_id);
    // Actual SQL settlement with a controlled joined receipt; no host process was activated or joined.
    yield* journal.settleAfterJoined(original.fence, {
      receiptId: "delivery-review-root-joined",
      stage: "settled",
      evidence: { worker: "joined", setup: "joined", transport: "drained" },
    });
  }
  yield* ensureIssueRepositoryTables(f.sql);
  yield* bindIssueRepositoryProject(f.sql, {
    key: { host: "github.com", repositoryNodeId: "R_publication" },
    projectId,
    repositoryName: "owner/reviewed",
    accountNodeId: "U_publication",
    credentialEpoch: "controlled-epoch",
    since: at.replace(".000Z", "Z"),
    expectedBindingRevision: null,
  });
  const sessions = yield* AuthSessions.make;
  const now = yield* Clock.currentTimeMillis;
  const session = {
    sessionId: AuthSessionId.make("human-publication-session"),
    subject: "user:publication-human",
    identity: { kind: "user" as const, id: "user:publication-human" },
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie" as const,
    expiresAt: DateTime.makeUnsafe(now + 60000),
  };
  yield* sessions.create({
    ...session,
    issuedAt: DateTime.makeUnsafe(now),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  const job = f.prepared.manifest;
  const target = {
    cwd: job.target.worktree,
    localBranch: job.target.branchRef.slice("refs/heads/".length),
    headSha: job.target.headSha,
    testedTree: job.target.testedTree,
    indexTree: job.target.testedTree,
    remoteName: "origin",
    remoteUrl: "git@github.com:owner/reviewed.git",
  };
  const input: GitRunStackedActionInput = {
    cwd: target.cwd,
    action: "create_pr",
    actionId: "reviewed-human-pr",
    precondition: {
      expectedHeadCommit: target.headSha,
      expectedIndexTree: target.indexTree,
      expectedRefName: job.target.branchRef,
    },
  };
  const permission = yield* makeProjectWorkHumanPublicationRequest(session, input).pipe(
    Effect.provideService(AuthSessions.AuthSessionRepository, sessions),
  );
  const authorization = yield* makeProjectWorkPublicationAuthorization({
    environmentId: "environment",
  });
  const publication = yield* Publication.make({
    authorizePublication: authorization.assertCurrent,
    resolveCredential: () =>
      Effect.fail(new Publication.PublicationError({ reason: "credential-mismatch" })),
  }).pipe(
    Effect.provideService(GitHubCli.GitHubCli, {
      execute: noPublicationNetwork,
      listOpenPullRequests: noPublicationNetwork,
      getPullRequest: noPublicationNetwork,
      getRepositoryCloneUrls: noPublicationNetwork,
      createRepository: noPublicationNetwork,
      createPullRequest: noPublicationNetwork,
      getDefaultBranch: noPublicationNetwork,
      checkoutPullRequest: noPublicationNetwork,
    }),
  );
  return { f, sessions, session, now, job, target, input, permission, authorization, publication };
});
it.effect(
  "a human publication atomically retains accepted review and verification before exact retry and background audit",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const {
          f,
          sessions,
          session,
          now,
          job,
          target,
          input,
          permission,
          authorization,
          publication,
        } = yield* makeHumanPublicationFixture();
        const before = yield* f.repository.replay(projectId);
        const prepared = authorization.prepareInTransaction({ input, target, permission });
        const first = yield* publication.enqueuePrepared(prepared);
        expect(first).toMatchObject({ status: "pending", duplicate: false });
        const after = yield* f.repository.replay(projectId);
        const added = after.slice(before.length);
        expect(added.map((event) => event.type)).toEqual([
          "project-work.evidence.added",
          "project-work.foundation.recorded",
        ]);
        const evidence = added[0];
        const pending = added[1];
        if (
          evidence?.type !== "project-work.evidence.added" ||
          pending?.type !== "project-work.foundation.recorded" ||
          pending.record.kind !== "effect"
        )
          return yield* Effect.die("Missing actual publication permission and pending effect");
        expect(evidence.evidence.attribution?.actor).toEqual({
          kind: "human",
          id: "user:publication-human",
        });
        expect(pending.record.status).toBe("pending");
        const request = yield* decodeControlledPublicationRequest(pending.record.payload.summary);
        expect(request.target.headSha).toBe(job.target.headSha);
        expect(request.repository).toEqual({
          host: "github.com",
          nodeId: "R_publication",
          nameWithOwner: "owner/reviewed",
        });
        yield* authorization.assertCurrent(request, "dispatch");
        expect(
          yield* publication.enqueuePrepared(
            authorization.prepareInTransaction({ input, target, permission }),
          ),
        ).toMatchObject({ operationId: first.operationId, duplicate: true });
        expect(yield* f.repository.replay(projectId)).toEqual(after);
        yield* sessions.revoke({
          sessionId: session.sessionId,
          revokedAt: DateTime.makeUnsafe(now),
        });
        // A committed human decision remains auditable after browser/session loss; a new enqueue still needs a current request.
        yield* authorization.assertCurrent(request, "dispatch");
        expect(
          (yield* publication
            .enqueuePrepared(authorization.prepareInTransaction({ input, target, permission }))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.repository.replay(projectId)).toEqual(after);
      }),
    ),
);

for (const unavailable of ["pending-review", "failed-verification"] as const) {
  it.effect(
    `human publication rejects ${unavailable} without retaining permission or pending work`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const { f, input, target, permission, authorization, publication } =
            yield* makeHumanPublicationFixture(
              unavailable === "pending-review"
                ? { accepted: false }
                : { verificationOutcome: "failed" },
            );
          const before = yield* f.repository.replay(projectId);
          expect(
            (yield* publication
              .enqueuePrepared(authorization.prepareInTransaction({ input, target, permission }))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.repository.replay(projectId)).toEqual(before);
          expect(
            yield* f.sql`SELECT record_id FROM project_team_effect WHERE json_extract(payload_json,'$.effectKind')='publication'`,
          ).toEqual([]);
        }),
      ),
  );
}
it.effect(
  "human publication rejects changed local target, remote and caller loans before enqueue",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const { f, input, target, permission, authorization, publication } =
          yield* makeHumanPublicationFixture();
        const before = yield* f.repository.replay(projectId);
        for (const changed of [
          { ...target, headSha: "e".repeat(40) },
          { ...target, indexTree: "e".repeat(40) },
          { ...target, localBranch: "unreviewed" },
          { ...target, remoteUrl: "git@github.com:other/repository.git" },
        ]) {
          expect(
            (yield* publication
              .enqueuePrepared(
                authorization.prepareInTransaction({ input, target: changed, permission }),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const prepare = authorization.prepareInTransaction({ input, target, permission });
        expect((yield* prepare.pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(prepare.pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              prepare.pipe(Effect.provideService(ProjectWorkRepository, { ...f.repository })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* f.sql.withTransaction(prepare)).request.target.headSha).toBe(target.headSha);
        expect(yield* f.repository.replay(projectId)).toEqual(before);
      }),
    ),
);
it.effect(
  "human publication captures the exact input and target synchronously before enqueue",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const { f, input, target, permission, authorization, publication } =
          yield* makeHumanPublicationFixture();
        const mutableInput = { ...input };
        const mutableTarget = { ...target };
        const prepared = authorization.prepareInTransaction({
          input: mutableInput,
          target: mutableTarget,
          permission,
        });
        mutableInput.cwd = "/foreign-after-capture";
        mutableTarget.headSha = "e".repeat(40);
        mutableTarget.remoteUrl = "git@github.com:other/repository.git";
        const receipt = yield* publication.enqueuePrepared(prepared);
        const pending = (yield* f.state()).foundationRecords?.find(
          (row) => row.recordId === receipt.operationId,
        );
        if (pending?.kind !== "effect")
          return yield* Effect.die("Missing captured publication effect");
        const request = yield* decodeControlledPublicationRequest(pending.payload.summary);
        expect(request.target.headSha).toBe(target.headSha);
        expect(request.repository.nameWithOwner).toBe("owner/reviewed");
        yield* authorization.assertCurrent(request, "dispatch");
      }),
    ),
);
for (const corrupt of ["raw-output", "permission-receipt", "enqueue-events"] as const) {
  it.effect(
    `human publication refuses ${corrupt} corruption without dispatch or replacement proof`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const { f, input, target, permission, authorization, publication } =
            yield* makeHumanPublicationFixture();
          const receipt = yield* publication.enqueuePrepared(
            authorization.prepareInTransaction({ input, target, permission }),
          );
          const pending = (yield* f.state()).foundationRecords?.find(
            (row) => row.recordId === receipt.operationId,
          );
          if (pending?.kind !== "effect") return yield* Effect.die("Missing publication effect");
          const request = yield* decodeControlledPublicationRequest(pending.payload.summary);
          const before = yield* f.repository.replay(projectId);
          if (corrupt === "raw-output") {
            const rows = yield* f.sql<{
              artifactId: string;
              raw: Uint8Array;
            }>`SELECT artifact_id AS artifactId,raw_bytes AS raw FROM project_work_artifacts WHERE artifact_id LIKE '%:stderr' LIMIT 2`;
            if (rows.length !== 1 || !rows[0] || rows[0].raw.length === 0)
              return yield* Effect.die("Missing controlled raw stderr");
            const bytes = new Uint8Array(rows[0].raw);
            bytes[0] = bytes[0]! ^ 255;
            yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
            yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${bytes} WHERE artifact_id=${rows[0].artifactId}`;
          } else if (corrupt === "permission-receipt") {
            yield* f.sql`UPDATE project_work_command_receipts SET payload_fingerprint='00000000' WHERE command_id=${"publication-permission:" + receipt.operationId}`;
          } else {
            yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]' WHERE command_id=${"publication-enqueue:" + receipt.operationId}`;
          }
          expect(
            (yield* authorization.assertCurrent(request, "dispatch").pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* publication
              .enqueuePrepared(authorization.prepareInTransaction({ input, target, permission }))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.repository.replay(projectId)).toEqual(before);
          expect(
            (yield* f.state()).foundationRecords?.find(
              (row) => row.recordId === receipt.operationId,
            ),
          ).toEqual(pending);
        }),
      ),
  );
}
it.effect(
  "a human publication failed owning COMMIT leaves no permission and exact retry keeps one pending request",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const { f, input, target, permission, authorization, publication } =
          yield* makeHumanPublicationFixture();
        const before = yield* f.repository.replay(projectId);
        const query = yield* ProjectWorkQuery;
        const beforeSnapshot = yield* query.snapshot(projectId);
        yield* f.sql`CREATE TABLE controlled_publication_parent (id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE controlled_publication_child (id TEXT REFERENCES controlled_publication_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER controlled_publication_commit_failure AFTER INSERT ON project_work_evidence WHEN NEW.evidence_id LIKE 'publication-permission:%' BEGIN INSERT INTO controlled_publication_child VALUES ('missing'); END`;
        let escaped = false;
        expect(
          (yield* publication
            .enqueuePrepared(authorization.prepareInTransaction({ input, target, permission }))
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  escaped = true;
                }),
              ),
              Effect.exit,
            ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM controlled_publication_child`).toEqual([
          { count: 0 },
        ]);
        const physical = yield* f.sql<{
          payload: string;
        }>`SELECT json_extract(payload_json,'$.payload.summary') AS payload FROM project_team_effect WHERE json_extract(payload_json,'$.effectKind')='publication' LIMIT 2`;
        expect(physical).toHaveLength(0);
        expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
        expect(yield* f.repository.replay(projectId)).toEqual(before);
        yield* f.sql`DROP TRIGGER controlled_publication_commit_failure`;
        const retained = yield* publication.enqueuePrepared(
          authorization.prepareInTransaction({ input, target, permission }),
        );
        const after = yield* f.repository.replay(projectId);
        expect(after.slice(before.length)).toHaveLength(2);
        expect(
          yield* publication.enqueuePrepared(
            authorization.prepareInTransaction({ input, target, permission }),
          ),
        ).toMatchObject({ operationId: retained.operationId, duplicate: true });
        expect(yield* f.repository.replay(projectId)).toEqual(after);
      }),
    ),
);

it.effect(
  "human publication pending dispatch denies a revoked original grant without external work",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const { f, input, target, permission, authorization, publication } =
          yield* makeHumanPublicationFixture();
        const retained = yield* publication.enqueuePrepared(
          authorization.prepareInTransaction({ input, target, permission }),
        );
        const state = yield* f.state();
        const gate = state.foundationRecords?.find(
          (row) => row.kind === "gate" && row.verificationJobId === f.prepared.manifest.jobId,
        );
        if (gate?.kind !== "gate")
          return yield* Effect.die("Missing actual original verification grant");
        yield* f.repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "revoke-publication-verification",
            expectedRevision: state.revision,
            attribution: {
              actor: { kind: "human", id: "maintainer" },
              source: { kind: "web", id: "publication-revocation" },
              recordedAt: at,
            },
            committedAt: at,
            records: [{ ...gate, status: "invalidated", revision: gate.revision + 1 }],
          }),
        );
        const before = yield* f.repository.replay(projectId);
        expect(yield* publication.dispatchPending()).toEqual({
          processed: 1,
          confirmed: 0,
          uncertain: 0,
          denied: 1,
        });
        expect(yield* f.repository.replay(projectId)).toEqual(before);
        expect(
          (yield* f.state()).foundationRecords?.find(
            (row) => row.recordId === retained.operationId,
          ),
        ).toMatchObject({ status: "pending", claimGeneration: 0 });
      }),
    ),
);
it.effect(
  "human publication pending dispatch confirms only the fixed reviewed remote head and retained receipt",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const { f, input, target, permission, authorization, publication } =
          yield* makeHumanPublicationFixture();
        const first = yield* publication.enqueuePrepared(
          authorization.prepareInTransaction({ input, target, permission }),
        );
        const pending = (yield* f.state()).foundationRecords?.find(
          (row) => row.recordId === first.operationId,
        );
        if (pending?.kind !== "effect")
          return yield* Effect.die("Missing original pending publication");
        const request = yield* decodeControlledPublicationRequest(pending.payload.summary);
        let created = false;
        let writes = 0;
        const response = (value: unknown): VcsProcess.VcsProcessOutput => ({
          stdout: canonical(value),
          stderr: "",
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        const run: VcsProcess.VcsProcess["Service"]["run"] = (command) =>
          Effect.sync(() => {
            if (command.args.includes("graphql"))
              return response({
                data: {
                  base: {
                    id: request.repository.nodeId,
                    nameWithOwner: request.repository.nameWithOwner,
                    ref: { name: request.target.baseRef, target: { oid: request.target.baseSha } },
                  },
                  head: {
                    id: request.target.headRepositoryNodeId,
                    nameWithOwner: request.repository.nameWithOwner,
                    ref: { name: request.target.headRef, target: { oid: request.target.headSha } },
                  },
                },
              });
            if (command.args.includes("POST")) {
              expect(command.stdin).toContain(`"head":"${request.target.headSelector}"`);
              expect(command.stdin).toContain(`"base":"${request.target.baseRef}"`);
              expect(command.stdin).toContain(request.marker);
              writes++;
              created = true;
              return response({});
            }
            if (command.args.at(-1) === `repos/${request.repository.nameWithOwner}`)
              return response({
                node_id: request.repository.nodeId,
                full_name: request.repository.nameWithOwner,
              });
            return response(
              created
                ? [
                    {
                      node_id: "PR_reviewed",
                      number: 42,
                      html_url: "https://github.com/owner/reviewed/pull/42",
                      state: "open",
                      merged_at: null,
                      body: `<!-- t3-project-work-publication:v1:${request.marker} -->`,
                      base: {
                        sha: request.target.baseSha,
                        ref: request.target.baseRef,
                        repo: {
                          node_id: request.repository.nodeId,
                          full_name: request.repository.nameWithOwner,
                        },
                      },
                      head: {
                        sha: request.target.headSha,
                        ref: request.target.headRef,
                        repo: { node_id: request.target.headRepositoryNodeId },
                      },
                    },
                  ]
                : [],
            );
          });
        const dispatcher = yield* Publication.make({
          authorizePublication: authorization.assertCurrent,
          resolveCredential: () =>
            Effect.succeed({
              cwd: target.cwd,
              host: request.repository.host,
              repositoryNodeId: request.repository.nodeId,
              headRepositoryNodeId: request.target.headRepositoryNodeId,
              credentialFingerprint: "controlled-epoch",
              token: Redacted.make("synthetic-controlled-token"),
            }),
        }).pipe(
          Effect.provide(
            GitHubCli.layer.pipe(
              Layer.provide(
                Layer.succeed(VcsProcess.VcsProcess, VcsProcess.VcsProcess.of({ run })),
              ),
            ),
          ),
        );
        expect(yield* dispatcher.dispatchPending()).toEqual({
          processed: 1,
          confirmed: 1,
          uncertain: 0,
          denied: 0,
        });
        const outcome = yield* dispatcher.dispatch(first.operationId);
        expect(outcome).toMatchObject({
          kind: "confirmed",
          operationId: first.operationId,
          pullRequest: { url: "https://github.com/owner/reviewed/pull/42" },
        });
        const human = yield* makeProjectWorkHumanPublication.pipe(
          Effect.provideService(ProjectWorkPublicationAuthorization, authorization),
          Effect.provideService(Publication.ProjectWorkPullRequests, dispatcher),
        );
        const mutableInput = { ...input };
        const mutableTarget = { ...target };
        const capturedRetry = human.create(mutableInput, mutableTarget, permission);
        mutableInput.cwd = "/foreign-after-create";
        mutableTarget.headSha = "e".repeat(40);
        expect(yield* capturedRetry).toEqual(outcome);
        expect(
          (yield* human
            .create(input, target, permission)
            .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql }), Effect.result))._tag,
        ).toBe("Failure");
        expect(writes).toBe(1);
        expect(yield* dispatcher.dispatchPending()).toEqual({
          processed: 0,
          confirmed: 0,
          uncertain: 0,
          denied: 0,
        });
        expect(writes).toBe(1);
        expect(
          (yield* f.state()).foundationRecords?.find((row) => row.recordId === first.operationId),
        ).toMatchObject({ status: "succeeded", claimGeneration: 1 });
      }),
    ),
);

it.effect("reviewed work batch reads cannot escape their original transaction callback", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
      const ref = yield* completeIntegrationSourceReview(f);
      const reader = yield* makeProjectTeamReviewedWorkReader({ environmentId: "environment" });
      const escaped = yield* f.sql.withTransaction(
        reader.withCurrentInTransaction({ projectId }, (read) =>
          Effect.gen(function* () {
            expect((yield* read(ref)).source.headSha).toBe(f.prepared.manifest.target.headSha);
            return read(ref);
          }),
        ),
      );
      expect((yield* f.sql.withTransaction(escaped).pipe(Effect.result))._tag).toBe("Failure");
    }),
  ),
);
const decodeControlledPublicationRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
  strict,
);
const decodeIntegrationSourceRef = Schema.decodeUnknownEffect(
  ProjectTeamIntegrationSourceRef,
  strict,
);
const integrationSelectionTask = Effect.fn("integrationTest.selectionTask")(function* (
  f: Effect.Success<ReturnType<typeof makeConsumedReviewFixture>>,
) {
  const task = ProjectWorkTaskId.make("integration-selection");
  const criterion = ProjectWorkCriterionId.make("integration-selection-criterion");
  yield* f.repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId: task,
    commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("integration-selection-create"),
    title: "Combine the selected reviewed commits",
    createdAt: at,
  });
  const state = yield* f.state();
  const selected = state.tasks.find((row) => row.taskId === task);
  if (!selected) return yield* Effect.die("Missing integration task");
  const human = {
    actor: { kind: "human" as const, id: "maintainer" },
    source: { kind: "web" as const, id: "integration-selection-test" },
    recordedAt: at,
  };
  yield* f.repository.execute(
    decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "integration-selection-spec",
      expectedRevision: state.revision,
      attribution: human,
      committedAt: at,
      records: [],
      guided: {
        intent: {
          type: "project-team.specification.propose",
          projectId,
          taskId: task,
          commandId: "integration-selection-spec",
          expectedRevision: state.revision,
          expectedTaskRevision: selected.revision,
          expectedSpecRevision: 0,
          specification: {
            objective: "Combine approved inputs",
            scopeIn: "Selected exact commits",
            scopeOut: "Other sources",
            criterionIds: [criterion],
            revision: 1,
            protected: false,
          },
          criterionSnapshots: [
            {
              criterionId: criterion,
              taskId: task,
              description: "Verify the combined commits",
              required: true,
              status: "unsatisfied",
              satisfiedByEvidenceIds: [],
              revision: 0,
              updatedAt: at,
            },
          ],
        },
      },
    }),
  );
  return { task, human };
});
it.effect(
  "integration source selection freezes actual accepted review and raw verification facts",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const ref = yield* completeIntegrationSourceReview(f);
        const integration = yield* integrationSelectionTask(f);
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const request = { projectId, integrationTaskId: integration.task, refs: [ref] };
        expect((yield* sources.compileInTransaction(request).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const selected = yield* f.sql.withTransaction(sources.compileInTransaction(request));
        expect(selected.sources).toHaveLength(1);
        expect(selected.sources[0]).toMatchObject({
          taskId: f.selection.taskId,
          branchRef: f.prepared.manifest.target.branchRef,
          headSha: f.prepared.manifest.target.headSha,
          manifestHash: f.prepared.sha256,
          reviewProposalSha256: ref.expectedReviewProposalSha256,
          joinedReceiptId: f.joined.receiptId,
        });
        expect(
          (yield* f.state()).tasks.find((task) => task.taskId === f.selection.taskId)?.state,
        ).not.toBe("completed");
        expect(yield* f.sql.withTransaction(sources.compileInTransaction(request))).toEqual(
          selected,
        );
        const mutable = { ...request, refs: [{ ...ref }] };
        const originalRequest = sources.compileInTransaction(mutable);
        mutable.refs[0]!.expectedHeadSha = "0".repeat(40);
        expect(yield* f.sql.withTransaction(originalRequest)).toEqual(selected);
        const page = yield* f.sql.withTransaction(
          sources.candidatesInTransaction({
            projectId,
            integrationTaskId: integration.task,
            offset: 0,
            limit: 1,
          }),
        );
        expect(page.candidates.map((candidate) => candidate.ref)).toEqual([ref]);
        expect(page.nextOffset).toBe(1);
        yield* f.sql.withTransaction(
          sources.assertCurrentInTransaction({
            projectId,
            integrationTaskId: integration.task,
            sources: selected,
          }),
        );
        expect(
          (yield* f.sql
            .withTransaction(
              sources.compileInTransaction({
                ...request,
                refs: [{ ...ref, expectedHeadSha: "0".repeat(40) }],
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              sources.compileInTransaction({ ...request, integrationTaskId: ref.taskId }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);
it.effect(
  "integration source selection preserves explicit order across two independently reviewed tasks",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const first = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
        const firstRef = yield* completeIntegrationSourceReview(first);
        const secondBase = yield* makeVerificationFixture("implementer", "-second");
        const secondRoot = yield* establishControlledReviewRoot(secondBase, "-second");
        const secondFinding = yield* makeFindingFixture(true, "success", secondRoot, "-second");
        const secondProposal = yield* makeProposalFixture(
          true,
          "success",
          secondFinding,
          "-second",
        );
        const second = yield* makeConsumedReviewFixture({ suffix: "-second" }, secondProposal);
        const secondRef = yield* completeIntegrationSourceReview(second);
        const integration = yield* integrationSelectionTask(first);
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const selection = yield* first.sql.withTransaction(
          sources.compileInTransaction({
            projectId,
            integrationTaskId: integration.task,
            refs: [secondRef, firstRef],
          }),
        );
        expect(selection.sources.map((source) => source.taskId)).toEqual([
          secondRef.taskId,
          firstRef.taskId,
        ]);
        expect(selection.sources.map((source) => source.headSha)).toEqual([
          secondRef.expectedHeadSha,
          firstRef.expectedHeadSha,
        ]);
        const before = yield* first.state();
        yield* first.sql.withTransaction(
          sources.assertCurrentInTransaction({
            projectId,
            integrationTaskId: integration.task,
            sources: selection,
          }),
        );
        expect(yield* first.state()).toEqual(before);
      }),
    ),
);
it.effect(
  "integration source qualification rejects a reviewed transitive source after its original input grant is revoked",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const original = yield* makeConsumedReviewFixture({
          parentAssessment: "empty",
          verificationOutcome: "success",
        });
        const originalRef = yield* completeIntegrationSourceReview(original);
        const owner = yield* integrationSelectionTask(original);
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const originalSelection = yield* original.sql.withTransaction(
          sources.compileInTransaction({
            projectId,
            integrationTaskId: owner.task,
            refs: [originalRef],
          }),
        );
        const firstBase = yield* makeVerificationFixture(
          "integrator",
          "-nested-a",
          originalSelection,
        );
        const wrongRole = yield* makeVerificationAssignmentFixture(
          "implementer",
          "-wrong-nested",
          originalSelection,
        );
        const beforeWrongRole = yield* original.state();
        const wrongRoleResult = yield* wrongRole.journal
          .reserve(wrongRole.request)
          .pipe(Effect.result);
        expect(wrongRoleResult._tag).toBe("Failure");
        if (wrongRoleResult._tag === "Failure")
          expect(wrongRoleResult.failure).toMatchObject({
            _tag: "ProjectTeamDispatchJournalError",
            reason:
              "Integration dispatch requires its exact approved source plan and original integrator",
          });
        expect(yield* original.state()).toEqual(beforeWrongRole);
        const firstRoot = yield* establishControlledReviewRoot(firstBase, "-nested-a");
        const rootHistory = yield* original.sql.withTransaction(
          firstBase.journal.readHistoricalInTransaction("review-root-dispatch-nested-a"),
        );
        expect(rootHistory.snapshot.intent.integration).toBeUndefined();
        expect(rootHistory.snapshot.intent.limits.writable).toBe(false);
        const rootRequest = rootHistory.snapshot.intent.request;
        const rootTransition = rootRequest.claim.transition;
        if (rootTransition?.kind !== "claim")
          return yield* Effect.die("Missing original coordinator claim");
        const beforeWritableCoordinator = yield* original.state();
        const writableCoordinator = yield* firstBase.journal
          .reserve({
            ...rootRequest,
            dispatchId: "writable-coordinator-dispatch",
            git: { ...rootRequest.git, effectId: "writable-coordinator-dispatch" },
            claim: {
              ...rootRequest.claim,
              transition: {
                ...rootTransition,
                binding: {
                  ...rootTransition.binding,
                  configuration: {
                    ...rootTransition.binding.configuration,
                    toolIds: ["pi.read", "pi.bash"],
                  },
                },
              },
            },
          })
          .pipe(Effect.result);
        expect(writableCoordinator._tag).toBe("Failure");
        if (writableCoordinator._tag === "Failure")
          expect(writableCoordinator.failure).toMatchObject({
            _tag: "ProjectTeamDispatchJournalError",
            reason:
              "Integration dispatch requires its exact approved source plan and original integrator",
          });
        expect(yield* original.state()).toEqual(beforeWritableCoordinator);
        const verificationGate = yield* makeProjectWorkVerificationGate({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        expect(
          yield* original.sql
            .withTransaction(
              verificationGate.assertCurrent(
                yield* original.state(),
                firstRoot.prepared,
                firstRoot.selection,
              ),
            )
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Success" });
        const firstFinding = yield* makeFindingFixture(true, "success", firstRoot, "-nested-a");
        const firstProposal = yield* makeProposalFixture(
          true,
          "success",
          firstFinding,
          "-nested-a",
        );
        const first = yield* makeConsumedReviewFixture(
          { suffix: "-nested-a", parentAssessment: "empty" },
          firstProposal,
        );
        const firstRef = yield* completeIntegrationSourceReview(first);
        const firstSelection = yield* original.sql.withTransaction(
          sources.compileInTransaction({
            projectId,
            integrationTaskId: owner.task,
            refs: [firstRef],
          }),
        );
        const secondBase = yield* makeVerificationFixture(
          "integrator",
          "-nested-b",
          firstSelection,
        );
        const secondRoot = yield* establishControlledReviewRoot(secondBase, "-nested-b");
        const secondFinding = yield* makeFindingFixture(true, "success", secondRoot, "-nested-b");
        const secondProposal = yield* makeProposalFixture(
          true,
          "success",
          secondFinding,
          "-nested-b",
        );
        const second = yield* makeConsumedReviewFixture(
          { suffix: "-nested-b", parentAssessment: "empty" },
          secondProposal,
        );
        const secondRef = yield* completeIntegrationSourceReview(second);
        // The same accepted integrator must publish only its retained selection and combination coverage.
        const humanPublication = yield* makeHumanPublicationFixture({ accepted: false }, second);
        expect(second.prepared.manifest.integration).toBe(true);
        expect(second.prepared.manifest.integrationCoverage).toBeDefined();
        const pendingPublication = yield* humanPublication.publication.enqueuePrepared(
          humanPublication.authorization.prepareInTransaction({
            input: humanPublication.input,
            target: humanPublication.target,
            permission: humanPublication.permission,
          }),
        );
        const pendingRecord = (yield* second.state()).foundationRecords?.find(
          (row) => row.recordId === pendingPublication.operationId,
        );
        if (pendingRecord?.kind !== "effect")
          return yield* Effect.die("Missing reviewed integrator publication");
        const frozenPublication = yield* decodeControlledPublicationRequest(
          pendingRecord.payload.summary,
        );
        yield* humanPublication.authorization.assertCurrent(frozenPublication, "dispatch");
        expect(frozenPublication.target.headSha).toBe(second.prepared.manifest.target.headSha);
        const request = { projectId, integrationTaskId: owner.task, refs: [secondRef] };
        const selected = yield* original.sql.withTransaction(sources.compileInTransaction(request));
        yield* original.sql.withTransaction(
          sources.assertCurrentInTransaction({
            projectId,
            integrationTaskId: owner.task,
            sources: selected,
          }),
        );
        const before = yield* original.state();
        const gate = before.foundationRecords?.find(
          (record) =>
            record.kind === "gate" && record.verificationJobId === originalRef.verificationJobId,
        );
        if (gate?.kind !== "gate") return yield* Effect.die("Missing original nested input grant");
        yield* original.repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "revoke-nested-original-input",
            expectedRevision: before.revision,
            attribution: owner.human,
            committedAt: at,
            records: [{ ...gate, status: "invalidated", revision: gate.revision + 1 }],
          }),
        );
        expect(
          (yield* humanPublication.authorization
            .assertCurrent(frozenPublication, "dispatch")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const page = yield* original.sql.withTransaction(
          sources.candidatesInTransaction({
            projectId,
            integrationTaskId: owner.task,
            offset: 0,
            limit: 64,
          }),
        );
        expect(page.candidates.some((candidate) => candidate.ref.taskId === secondRef.taskId)).toBe(
          false,
        );
        expect(
          (yield* original.sql
            .withTransaction(sources.compileInTransaction(request))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* original.sql
            .withTransaction(
              sources.assertCurrentInTransaction({
                projectId,
                integrationTaskId: owner.task,
                sources: selected,
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const after = yield* original.state();
        for (const ref of [originalRef, firstRef, secondRef]) {
          expect(after.tasks.find((task) => task.taskId === ref.taskId)?.state).not.toBe(
            "completed",
          );
          const plan = after.foundationRecords?.find(
            (record) => record.kind === "plan-revision" && record.taskId === ref.taskId,
          );
          expect(plan).toEqual(
            before.foundationRecords?.find((record) => record.recordId === plan?.recordId),
          );
        }
      }),
    ),
);
it.effect("source grant revocation retains the integration list and invalidates its approval", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
      const ref = yield* completeIntegrationSourceReview(f);
      const integration = yield* integrationSelectionTask(f);
      const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
      const selection = yield* f.sql.withTransaction(
        sources.compileInTransaction({
          projectId,
          integrationTaskId: integration.task,
          refs: [ref],
        }),
      );
      let state = yield* f.state();
      const task = state.tasks.find((task) => task.taskId === integration.task)!;
      const intent = {
        type: "project-team.plan.propose",
        projectId,
        taskId: integration.task,
        commandId: "integration-list-plan",
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        specRevision: task.specRevision,
        content: "Combine and test exactly the approved sources",
        dependencyTaskIds: [],
        integrationSourceRefs: [ref],
      };
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: intent.commandId,
          expectedRevision: state.revision,
          attribution: integration.human,
          records: [],
          committedAt: at,
          guided: { intent, integrationSources: selection },
        }),
      );
      state = yield* f.state();
      const gate = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" && record.taskId === integration.task && record.gate === "plan",
      );
      if (gate?.kind !== "gate") return yield* Effect.die("Missing integration plan gate");
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "integration-list-approve",
          expectedRevision: state.revision,
          attribution: integration.human,
          committedAt: at,
          records: [
            {
              ...gate,
              status: "approved",
              revision: gate.revision + 1,
              attribution: integration.human,
            },
          ],
        }),
      );
      state = yield* f.state();
      const sourceGate = state.foundationRecords?.find(
        (record) => record.kind === "gate" && record.verificationJobId === ref.verificationJobId,
      );
      if (sourceGate?.kind !== "gate")
        return yield* Effect.die("Missing original source verification approval");
      yield* f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: "invalidate-selected-source",
          expectedRevision: state.revision,
          attribution: integration.human,
          committedAt: at,
          records: [{ ...sourceGate, status: "invalidated", revision: sourceGate.revision + 1 }],
        }),
      );
      const invalidated = yield* f.state();
      expect(
        invalidated.foundationRecords?.find(
          (record) => record.kind === "gate" && record.recordId === gate.recordId,
        )?.status,
      ).toBe("invalidated");
      const plan = invalidated.foundationRecords?.find(
        (record) => record.kind === "plan-revision" && record.taskId === integration.task,
      );
      expect(plan?.kind === "plan-revision" ? plan.integrationSources : undefined).toEqual(
        selection,
      );
      expect(
        (yield* f.sql
          .withTransaction(
            sources.assertCurrentInTransaction({
              projectId,
              integrationTaskId: integration.task,
              sources: selection,
            }),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);
it.effect(
  "integration candidate pages advance past a pending independent review without treating it as accepted",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
        const proof = yield* f.prepare();
        if (proof?.status !== "completed")
          return yield* Effect.die("Missing pending completed judgment");
        const integration = yield* integrationSelectionTask(f);
        const service = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const page = yield* f.sql.withTransaction(
          service.candidatesInTransaction({
            projectId,
            integrationTaskId: integration.task,
            offset: 0,
            limit: 1,
          }),
        );
        expect(page).toEqual({ candidates: [], nextOffset: 1, hasMore: false });
        expect(
          (yield* f.state()).tasks.find((task) => task.taskId === f.running.taskId)?.state,
        ).not.toBe("completed");
      }),
    ),
);
for (const corruption of ["raw output", "accepted command", "failed result"] as const)
  it.effect(`integration sources reject ${corruption} instead of inventing review proof`, () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          verificationOutcome: corruption === "failed result" ? "failed" : "success",
        });
        const ref = yield* completeIntegrationSourceReview(f);
        const integration = yield* integrationSelectionTask(f);
        if (corruption === "raw output") {
          yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
          yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array([255])},byte_count=1 WHERE task_id=${ref.taskId}`;
        } else if (corruption === "accepted command") {
          yield* f.sql`UPDATE project_work_command_receipts SET actor_id='unrelated' WHERE command_id=${projectTeamDerivedRecordId(f.joined.receiptId, "joined-domain")}`;
        }
        const service = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const before = yield* f.state();
        expect(
          (yield* f.sql
            .withTransaction(
              service.compileInTransaction({
                projectId,
                integrationTaskId: integration.task,
                refs: [ref],
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
  );
it.effect("an integration selection cannot escape its failed owning COMMIT", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
      const ref = yield* completeIntegrationSourceReview(f);
      const integration = yield* integrationSelectionTask(f);
      const service = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
      const before = yield* f.state();
      const query = yield* ProjectWorkQuery;
      const beforeSnapshot = yield* query.snapshot(projectId);
      yield* f.sql`CREATE TABLE controlled_sources_parent(id TEXT PRIMARY KEY)`;
      yield* f.sql`CREATE TABLE controlled_sources_child(id TEXT REFERENCES controlled_sources_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      let escaped = false;
      const effect = f.sql
        .withTransaction(
          Effect.gen(function* () {
            yield* f.sql`INSERT INTO controlled_sources_child VALUES ('missing')`;
            return yield* service.compileInTransaction({
              projectId,
              integrationTaskId: integration.task,
              refs: [ref],
            });
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              escaped = true;
            }),
          ),
          Effect.exit,
        );
      expect((yield* effect)._tag).toBe("Failure");
      expect(escaped).toBe(false);
      expect(yield* f.sql`SELECT COUNT(*) AS count FROM controlled_sources_child`).toEqual([
        { count: 0 },
      ]);
      expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
      expect(yield* f.state()).toEqual(before);
      const selected = yield* f.sql.withTransaction(
        service.compileInTransaction({
          projectId,
          integrationTaskId: integration.task,
          refs: [ref],
        }),
      );
      expect(selected.sources).toHaveLength(1);
    }),
  ),
);
it.effect(
  "integration verification preparation and approval consume the exact retained combination coverage",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const source = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
        const ref = yield* completeIntegrationSourceReview(source);
        const owner = yield* integrationSelectionTask(source);
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const selected = yield* source.sql.withTransaction(
          sources.compileInTransaction({ projectId, integrationTaskId: owner.task, refs: [ref] }),
        );
        // Actual approved plan/dispatch/stage/preparation and Gate; only the physical capture is controlled.
        const integration = yield* makeVerificationFixture("integrator", "-combined", selected);
        const job = integration.prepared.manifest;
        expect(job.integration).toBe(true);
        expect(job.integrationCoverage?.selectionSha256).toBe(digest(canonical(selected)));
        const retained = yield* integration.sql.withTransaction(
          integration.journal.readHistoricalInTransaction(integration.snapshot.fence.dispatchId),
        );
        const stage = retained.receipts.find((receipt) => receipt.stage === "workspace-ready");
        if (!stage) return yield* Effect.die("Missing retained integration Workspace stage");
        const envelope = yield* decodeIntegrationWorkspace(stage.evidence);
        if (!envelope.integration)
          return yield* Effect.die("Missing retained integration combination");
        expect(job.integrationCoverage?.combinationSha256).toBe(
          digest(canonical(envelope.integration)),
        );
        const gate = yield* makeProjectWorkVerificationGate({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        yield* integration.sql.withTransaction(
          gate.assertCurrent(integration.state, integration.prepared, integration.selection),
        );
        const { integrationCoverage: _coverage, ...missing } = job;
        expect(
          (yield* integration.sql
            .withTransaction(
              gate.assertCurrent(
                integration.state,
                { manifest: missing, sha256: digest(canonical(missing)) },
                integration.selection,
              ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const wrong = {
          ...job,
          integrationCoverage: {
            version: 1 as const,
            selectionSha256: "0".repeat(64),
            combinationSha256: job.integrationCoverage!.combinationSha256,
          },
        };
        expect(
          (yield* integration.sql
            .withTransaction(
              gate.assertCurrent(
                integration.state,
                { manifest: wrong, sha256: digest(canonical(wrong)) },
                integration.selection,
              ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* integration.jobs.readPrepared(job.jobId)).toEqual(integration.prepared);
      }),
    ),
);
it.effect(
  "actual integration Workspace holds controlled physical loans through the first Journal stage commit",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const source = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
        const ref = yield* completeIntegrationSourceReview(source);
        const selectionTask = yield* integrationSelectionTask(source);
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const selection = yield* source.sql.withTransaction(
          sources.compileInTransaction({
            projectId,
            integrationTaskId: selectionTask.task,
            refs: [ref],
          }),
        );
        const f = yield* makeVerificationAssignmentFixture("integrator", "-loan", selection);
        let current = yield* f.journal.claimEffect((yield* f.journal.reserve(f.request)).fence);
        const constructors = new WeakMap<
          ManagedGit.ManagedGitExecution,
          Parameters<typeof ManagedGit.make>[0]
        >();
        const originalMake = ManagedGit.make;
        let loans = 0,
          permit = false,
          merges = 0;
        const make = vi
          .spyOn(ManagedGit, "make")
          .mockImplementation((input) =>
            originalMake(input).pipe(
              Effect.tap((context) => Effect.sync(() => constructors.set(context, input))),
            ),
          );
        const target = (context: ManagedGit.ManagedGitExecution) => {
          const options = constructors.get(context);
          if (!options?.priorReceipt) throw Error("Missing controlled original ownership");
          const selected = selection.sources.find(
            (selected) => selected.bindingId === options.assignment.runId,
          );
          return {
            options,
            target: {
              receipt: options.priorReceipt,
              cwd: options.assignment.worktreePath,
              baseSha: options.assignment.baseOid,
              headSha: selected?.headSha ?? "9".repeat(40),
              testedCommit: selected?.headSha ?? "9".repeat(40),
              testedTree: selected?.testedTree ?? "8".repeat(40),
            },
          };
        };
        const controlledRead: typeof ManagedGit.withManagedVerificationTarget = (context, use) =>
          Effect.gen(function* () {
            const captured = target(context);
            yield* captured.options.revalidate;
            loans++;
            return yield* use(captured.target).pipe(
              Effect.tap(() => captured.options.revalidate),
              Effect.ensuring(
                Effect.sync(() => {
                  loans--;
                }),
              ),
            );
          });
        const read = vi
          .spyOn(ManagedGit, "withManagedVerificationTarget")
          .mockImplementation(controlledRead);
        const controlledCombine: typeof ManagedGit.withManagedIntegrationTarget = (
          context,
          input,
          use,
        ) =>
          Effect.gen(function* () {
            expect(permit).toBe(true);
            expect(input.sourceHeads).toEqual(selection.sources.map((source) => source.headSha));
            merges++;
            return yield* controlledRead(context, use);
          });
        const combine = vi
          .spyOn(ManagedGit, "withManagedIntegrationTarget")
          .mockImplementation(controlledCombine);
        const controlledAncestry: typeof ManagedGit.withManagedVerificationAncestry = (
          context,
          _input,
          use,
        ) => controlledRead(context, use);
        const ancestry = vi
          .spyOn(ManagedGit, "withManagedVerificationAncestry")
          .mockImplementation(controlledAncestry);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            make.mockRestore();
            read.mockRestore();
            combine.mockRestore();
            ancestry.mockRestore();
          }),
        );
        const workflow = Layer.mock(GitWorkflowService, {
          withRepositoryPermit: (_operation, _cwd, effect) =>
            Effect.gen(function* () {
              expect(permit).toBe(false);
              permit = true;
              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    permit = false;
                  }),
                ),
              );
            }),
          createWorktree: (input, options) =>
            Effect.gen(function* () {
              if (!options?.managed) return yield* Effect.die("Missing managed context");
              const captured = constructors.get(options.managed);
              if (!captured) return yield* Effect.die("Missing real branded controlled context");
              const receipt = captured.priorReceipt ?? {
                assignment: captured.assignment,
                primary: { path: captured.assignment.primaryRoot, dev: "1", ino: "1" },
                worktree: { path: captured.assignment.worktreePath, dev: "1", ino: "2" },
                common: { path: captured.assignment.commonGitDirectory, dev: "1", ino: "3" },
                gitDirectory: {
                  path: captured.assignment.commonGitDirectory + "/worktrees/integration-loan",
                  dev: "1",
                  ino: "4",
                },
                initialHeadOid: captured.assignment.baseOid,
                pointerAndConfigurationHash: "b".repeat(64),
              };
              yield* captured.persistWorkspace(receipt);
              return {
                worktree: {
                  path: captured.assignment.worktreePath,
                  refName: captured.assignment.branchRef.slice(11),
                },
              };
            }),
        });
        const workspace = yield* makeProjectTeamWorkspace({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          launchPolicy: { memoryBytes: 536870912, runtimeSeconds: 2 },
          protectedRoots: [],
          assertCurrent: (snapshot) =>
            Effect.gen(function* () {
              const observed = yield* f.journal.inspect(snapshot.fence.dispatchId);
              expect(observed.fence).toEqual(snapshot.fence);
            }).pipe(
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({
                    reason: "Controlled current Workspace dispatch unavailable",
                  }),
              ),
            ),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              workflow,
              Layer.mock(ProjectTeamPiRuntime, {
                withInstance: () => Effect.die("No runtime entry"),
              }),
              Layer.mock(ProjectionSnapshotQuery, {}),
            ),
          ),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessUserId, 0),
        );
        const operationScope = yield* Scope.Scope;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: (receipt, snapshot) =>
            Effect.gen(function* () {
              expect(loans).toBe(2);
              expect(permit).toBe(true);
              const evidence = yield* decodeIntegrationWorkspace(receipt.evidence);
              yield* workspace.verifyWorkspace(snapshot, evidence.workspace);
              if (!evidence.integration) return yield* Effect.die("Missing integration receipt");
              yield* workspace.verifyIntegration(snapshot, evidence.integration);
            }).pipe(
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({
                    reason: "Controlled Workspace verification failed",
                  }),
              ),
              Effect.provideService(Scope.Scope, operationScope),
            ),
        });
        const ready = yield* workspace.withWorkspace(current, (evidence) =>
          Effect.gen(function* () {
            expect(loans).toBe(2);
            expect(permit).toBe(true);
            current = yield* journal.advanceStage(current.fence, {
              receiptId: "actual-integration-stage",
              stage: "workspace-ready",
              evidence,
            });
            return evidence;
          }),
        );
        expect(ready.integration?.sourceHeads).toEqual([ref.expectedHeadSha]);
        expect(current.fence.stage).toBe("workspace-ready");
        expect(loans).toBe(0);
        expect(permit).toBe(false);
        expect(merges).toBe(1);
        const retained = yield* f.sql.withTransaction(
          journal.readHistoricalInTransaction(current.fence.dispatchId),
        );
        expect(
          retained.receipts.find((receipt) => receipt.stage === "workspace-ready")?.evidence,
        ).toEqual(ready);
        yield* workspace.withWorkspace(current, Effect.succeed);
        expect(merges).toBe(1);
      }),
    ),
);
const decodeIntegrationWorkspace = Schema.decodeUnknownEffect(ProjectTeamWorkspaceEvidence, strict);
it.effect("current review target denies assessment completion without a concrete target loan", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({
        parentAssessment: true,
        verificationOutcome: "success",
        withoutCurrentTarget: true,
      });
      const before = yield* f.state();
      const retained = yield* readProposal(f);
      expect(retained?.manifest.criterionAssessments).toHaveLength(1);
      expect((yield* f.prepare().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* readProposal(f)).toEqual(retained);
      expect(yield* f.state()).toEqual(before);
    }),
  ),
);
it.effect(
  "current review target qualifies the actual joined settlement and replays without a new host loan",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          // Retained SQL/custody fixtures control stage verification; no Host/native drain proof is claimed.
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const settled = yield* f.state();
        expect(settled.tasks.find((task) => task.taskId === f.running.taskId)?.state).toBe(
          "completed",
        );
        expect(settled.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((task) => task.taskId === f.selection.taskId),
        );
        expect(
          settled.criteria.find(
            (criterion) => criterion.criterionId === f.selection.criterionIds[0],
          )?.status,
        ).toBe("satisfied");
        expect(
          settled.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId &&
              !f.selection.criterionIds.includes(criterion.criterionId),
          ),
        ).toEqual(
          before.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId &&
              !f.selection.criterionIds.includes(criterion.criterionId),
          ),
        );
        expect(f.targetControl.calls).toBe(2);
        expect(f.targetControl.permits).toBe(1);
        yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z") + 1);
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)))
            .duplicate,
        ).toBe(true);
        expect(f.targetControl.calls).toBe(2);
        expect(f.targetControl.permits).toBe(1);
        expect(yield* f.state()).toEqual(settled);
      }),
    ),
);

it.effect(
  "qualified joined review advances only its selected parent criterion and exact retry retains the original progress",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const selectedId = f.selection.criterionIds[0];
        const original = before.criteria.find(
          (criterion) =>
            criterion.criterionId === selectedId && criterion.taskId === f.selection.taskId,
        );
        if (!original) return yield* Effect.die("Missing selected parent criterion");
        expect(original.status).toBe("unsatisfied");
        expect(original.satisfiedByEvidenceIds).toEqual([]);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          // Actual disposable SQL and retained SDK/custody records; native entry and drain ports remain controlled.
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        const receipt = yield* f.withTarget(
          journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined),
        );
        expect(receipt.fence.stage).toBe("settled");
        const after = yield* f.state();
        const selected = after.criteria.find(
          (criterion) =>
            criterion.criterionId === selectedId && criterion.taskId === f.selection.taskId,
        );
        expect(selected?.status).toBe("satisfied");
        expect(selected?.satisfiedByEvidenceIds).toHaveLength(1);
        const reviewEvidence = after.evidence.find(
          (evidence) => evidence.evidenceId === selected?.satisfiedByEvidenceIds[0],
        );
        expect(reviewEvidence).toMatchObject({
          taskId: f.selection.taskId,
          criterionId: selectedId,
          kind: "review",
          attribution: {
            actor: { kind: "system", id: "project-team-review-criterion-progress" },
            source: { kind: "system", id: "project-team-review-criterion-progress" },
          },
        });
        if (!reviewEvidence?.detail)
          return yield* Effect.die("Missing qualified parent review provenance");
        expect(yield* decodeControlledJson(reviewEvidence.detail)).toMatchObject({
          version: 1,
          kind: "project-team.review-criterion-progress",
          proposalCommandId: f.completionReport.commandId,
          joinedReceiptId: f.joined.receiptId,
          verification: {
            jobId: f.target.prepared.manifest.jobId,
            manifestHash: f.target.prepared.sha256,
            outcome: "success",
            exitCode: 0,
          },
        });
        expect(
          before.evidence.some((evidence) => evidence.evidenceId === reviewEvidence.evidenceId),
        ).toBe(false);
        expect(after.tasks.find((task) => task.taskId === f.running.taskId)?.state).toBe(
          "completed",
        );
        expect(after.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((task) => task.taskId === f.selection.taskId),
        );
        expect(
          after.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId && criterion.criterionId !== selectedId,
          ),
        ).toEqual(
          before.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId && criterion.criterionId !== selectedId,
          ),
        );
        const counts =
          yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts,(SELECT COUNT(*) FROM project_work_evidence WHERE project_id=${projectId}) AS evidence`;
        expect(
          (yield* journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)).duplicate,
        ).toBe(true);
        expect(yield* f.state()).toEqual(after);
        expect(
          yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts,(SELECT COUNT(*) FROM project_work_evidence WHERE project_id=${projectId}) AS evidence`,
        ).toEqual(counts);
        const query = yield* ProjectWorkQuery;
        expect(
          (yield* query.snapshot(projectId)).criteria.find(
            (criterion) => criterion.criterionId === selectedId,
          ),
        ).toEqual(selected);
      }),
    ),
);

for (const assessmentMode of ["negative", "empty", "absent"] as const) {
  it.effect(
    `joined ${assessmentMode} review retains its judgment without granting parent progress`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConsumedReviewFixture({
            ...(assessmentMode === "negative"
              ? { parentAssessment: true, assessmentVerdict: "not-met" }
              : assessmentMode === "empty"
                ? { parentAssessment: "empty" }
                : {}),
            verificationOutcome: assessmentMode === "negative" ? "failed" : "success",
          });
          const before = yield* f.state();
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            // SQL/SDK observations are controlled; no actual native entry or drain is exercised.
            verifyStage: () => Effect.void,
            verifySettlement: () => Effect.void,
            prepareReviewCompletion: f.consumer.prepare,
            verifyReviewTarget: f.targetService.assertOriginalInTransaction,
          });
          yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
          const after = yield* f.state();
          expect(after.criteria.filter((c) => c.taskId === f.selection.taskId)).toEqual(
            before.criteria.filter((c) => c.taskId === f.selection.taskId),
          );
          expect(after.tasks.find((t) => t.taskId === f.selection.taskId)).toEqual(
            before.tasks.find((t) => t.taskId === f.selection.taskId),
          );
          expect(after.tasks.find((t) => t.taskId === f.running.taskId)?.state).toBe("completed");
          const added = after.evidence.filter(
            (e) =>
              e.taskId === f.selection.taskId &&
              !before.evidence.some((old) => old.evidenceId === e.evidenceId),
          );
          expect(added).toHaveLength(assessmentMode === "negative" ? 1 : 0);
          if (assessmentMode === "negative") {
            expect(added[0]?.kind).toBe("review");
            expect(yield* decodeControlledJson(added[0]?.detail ?? "")).toMatchObject({
              assessment: { verdict: "not-met" },
              verification: { outcome: "failed", exitCode: 1 },
            });
          }
        }),
      ),
  );
}

it.effect(
  "retained applicability drift revokes original criterion progress and exact settlement replay does not regrant it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const active = yield* f.state();
        const selected = active.criteria.find((c) => c.criterionId === f.selection.criterionIds[0]);
        expect(selected?.status).toBe("satisfied");
        const applicability = active.foundationRecords?.find(
          (r) =>
            r.kind === "evidence-applicability" &&
            r.taskId === f.selection.taskId &&
            r.status === "current",
        );
        if (applicability?.kind !== "evidence-applicability")
          return yield* Effect.die("Missing original verification applicability");
        yield* f.repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "invalidate-original-review-applicability",
            expectedRevision: active.revision,
            attribution: {
              actor: { kind: "human", id: "fixture-human" },
              source: { kind: "web", id: "fixture-browser" },
              recordedAt: at,
            },
            committedAt: at,
            records: [
              {
                ...applicability,
                status: "stale",
                revision: applicability.revision + 1,
                updatedAt: at,
              },
            ],
          }),
        );
        const revoked = yield* f.state();
        expect(revoked.criteria.find((c) => c.criterionId === selected?.criterionId)).toMatchObject(
          { status: "unsatisfied", satisfiedByEvidenceIds: [] },
        );
        expect(revoked.evidence).toEqual(active.evidence);
        expect(
          (yield* journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)).duplicate,
        ).toBe(true);
        expect(yield* f.state()).toEqual(revoked);
      }),
    ),
);

for (const projectionFailure of ["dropped", "corrupt"] as const) {
  it.effect(
    `${projectionFailure} parent criterion projection rolls back qualified progress and preserves exact retry`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConsumedReviewFixture({
            parentAssessment: true,
            verificationOutcome: "success",
          });
          const before = yield* f.state();
          const history = yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId);
          const counts =
            yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts`;
          const selectedId = f.selection.criterionIds[0];
          yield* f.sql`CREATE TABLE controlled_parent_progress_target (criterion_id TEXT NOT NULL)`;
          yield* f.sql`INSERT INTO controlled_parent_progress_target VALUES (${selectedId})`;
          if (projectionFailure === "dropped")
            yield* f.sql`CREATE TRIGGER break_parent_progress BEFORE INSERT ON project_work_criteria WHEN NEW.criterion_id IN (SELECT criterion_id FROM controlled_parent_progress_target) AND NEW.status='satisfied' BEGIN SELECT RAISE(IGNORE); END`;
          else
            yield* f.sql`CREATE TRIGGER break_parent_progress AFTER INSERT ON project_work_criteria WHEN NEW.criterion_id IN (SELECT criterion_id FROM controlled_parent_progress_target) AND NEW.status='satisfied' BEGIN UPDATE project_work_criteria SET status='unsatisfied',satisfied_by_evidence_ids_json='[]' WHERE criterion_id=NEW.criterion_id AND project_id=NEW.project_id; END`;
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            verifyStage: () => Effect.void,
            verifySettlement: () => Effect.void,
            prepareReviewCompletion: f.consumer.prepare,
            verifyReviewTarget: f.targetService.assertOriginalInTransaction,
          });
          expect(
            (yield* f
              .withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* f.state()).toEqual(before);
          expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
            history,
          );
          expect(
            yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts`,
          ).toEqual(counts);
          yield* f.sql`DROP TRIGGER break_parent_progress`;
          yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
          expect(
            (yield* f.state()).criteria.find((c) => c.criterionId === selectedId)?.status,
          ).toBe("satisfied");
        }),
      ),
  );
}

it.effect("current review target requires its final hook before advancing the original stage", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({
        parentAssessment: true,
        verificationOutcome: "success",
      });
      const before = yield* f.state();
      const history = yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId);
      const journal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 128,
        verifyStage: () => Effect.void,
        verifySettlement: () => Effect.void,
        prepareReviewCompletion: f.consumer.prepare,
      });
      expect(
        (yield* f
          .withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.journal.readRetained(f.proposalSnapshot.fence.dispatchId)).toEqual(
        f.proposalSnapshot,
      );
      expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
        history,
      );
      expect(yield* f.state()).toEqual(before);
    }),
  ),
);

it.effect(
  "current review target observed commit mismatch denies qualification without accepting the parent",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        f.targetControl.driftAt = 1;
        expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "current review target postprojection native failure rolls back the joined settlement and exact retry remains",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const history = yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: (snapshot, receipt) =>
            Effect.gen(function* () {
              expect(
                (yield* f.state()).tasks.find((task) => task.taskId === f.running.taskId)?.state,
              ).toBe("completed");
              yield* f.targetService.assertOriginalInTransaction(snapshot, receipt);
            }),
        });
        f.targetControl.postFailureAt = 2;
        let escaped = false;
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(f.targetControl.calls).toBe(2);
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
          history,
        );
        expect(yield* f.journal.readRetained(f.proposalSnapshot.fence.dispatchId)).toEqual(
          f.proposalSnapshot,
        );
        f.targetControl.postFailureAt = 0;
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        expect(
          (yield* f.state()).tasks.find((task) => task.taskId === f.running.taskId)?.state,
        ).toBe("completed");
      }),
    ),
);
it.effect(
  "current review target preserves combined callback and native postcheck failures before settlement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const history = yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId);
        const receipts =
          yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} ORDER BY command_id`;
        const events =
          yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`;
        let completionFailures: ReadonlyArray<unknown> = [];
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: (snapshot, receipt) =>
            f.consumer.prepare(snapshot, receipt).pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() => {
                  completionFailures = cause.reasons
                    .filter(Cause.isFailReason)
                    .map((reason) => reason.error);
                }),
              ),
            ),
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        f.targetControl.driftAt = 1;
        f.targetControl.postFailureAt = 1;
        let escaped = false;
        const exit = yield* f
          .withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined))
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          );
        expect(exit._tag).toBe("Failure");
        // Observe both errors before the repository's existing outer error normalization.
        expect(completionFailures).toMatchObject([
          {
            _tag: "ProjectTeamReviewCurrentTargetError",
            reason: "changed",
            detail: "Current committed review target changed",
          },
          { _tag: "GitCommandError", detail: "Controlled post-callback target drift" },
        ]);
        expect(escaped).toBe(false);
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.journal.readRetained(f.proposalSnapshot.fence.dispatchId)).toEqual(
          f.proposalSnapshot,
        );
        expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
          history,
        );
        expect(
          yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} ORDER BY command_id`,
        ).toEqual(receipts);
        expect(
          yield* f.sql`SELECT * FROM project_work_events WHERE project_id=${projectId} ORDER BY sequence`,
        ).toEqual(events);
        f.targetControl.driftAt = 0;
        f.targetControl.postFailureAt = 0;
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const after = yield* f.state();
        expect(after.tasks.find((task) => task.taskId === f.running.taskId)?.state).toBe(
          "completed",
        );
        expect(after.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((task) => task.taskId === f.selection.taskId),
        );
        const selectedId = f.selection.criterionIds[0];
        expect(
          after.criteria.find((criterion) => criterion.criterionId === selectedId),
        ).toMatchObject({
          status: "satisfied",
          revision:
            before.criteria.find((criterion) => criterion.criterionId === selectedId)!.revision + 1,
        });
        expect(
          after.criteria.find((criterion) => criterion.criterionId === selectedId)
            ?.satisfiedByEvidenceIds,
        ).toHaveLength(1);
        expect(
          after.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId && criterion.criterionId !== selectedId,
          ),
        ).toEqual(
          before.criteria.filter(
            (criterion) =>
              criterion.taskId === f.selection.taskId && criterion.criterionId !== selectedId,
          ),
        );
      }),
    ),
);
it.effect(
  "completed assessment qualification denies a missing verification result without changing work",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({ parentAssessment: true });
        const before = yield* f.state();
        const retained = yield* readProposal(f);
        expect(retained?.manifest.criterionAssessments).toHaveLength(1);
        expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);
it.effect(
  "completed assessment qualification accepts intact successful verification without parent acceptance",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const proof = yield* f.prepare();
        expect(proof?.status).toBe("completed");
        expect(yield* f.state()).toEqual(before);
        expect(
          before.criteria.find((c) => c.criterionId === f.selection.criterionIds[0])?.status,
        ).toBe("unsatisfied");
      }),
    ),
);
it.effect("completed assessment qualification denies an intact failed verification result", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({
        parentAssessment: true,
        verificationOutcome: "failed",
      });
      const before = yield* f.state();
      expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
      expect(yield* f.state()).toEqual(before);
    }),
  ),
);
for (const channel of ["stdout", "stderr"] as const) {
  it.effect(
    `completed assessment qualification propagates corrupt ${channel} verification bytes`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConsumedReviewFixture({
            parentAssessment: true,
            verificationOutcome: "success",
          });
          const before = yield* f.state();
          const rows = yield* f.sql<{
            attempt_id: string;
          }>`SELECT attempt_id FROM project_work_verification_execution WHERE job_id=${f.selection.jobId}`;
          const attempt = rows[0]?.attempt_id;
          if (!attempt) return yield* Effect.die("Missing original verification execution");
          // Corrupt the disposable database beneath its normal immutable-write protection.
          yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
          yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array(channel === "stdout" ? [1, 255, 10] : [26, 0])} WHERE artifact_id=${attempt + ":" + channel}`;
          expect((yield* f.prepare().pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.state()).toEqual(before);
        }),
      ),
  );
}
it.effect("completed assessment qualification rechecks full parent evidence snapshots", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({
        parentAssessment: true,
        verificationOutcome: "success",
      });
      const before = yield* f.state();
      const id = f.completionReport.criterionAssessments?.[0]?.evidenceIds[0];
      const index = before.evidence.findIndex((e) => e.evidenceId === id);
      expect(index).toBeGreaterThanOrEqual(0);
      // Same-revision retained-detail corruption leaves the prepared target intact.
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${"$.evidence[" + index + "].detail"},'Changed parent observation') WHERE project_id=${projectId}`;
      const changed = yield* f.state();
      expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
      expect(yield* f.state()).toEqual(changed);
    }),
  ),
);
it.effect("completed assessment qualification binds the original human verification approval", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* makeConsumedReviewFixture({
        parentAssessment: true,
        verificationOutcome: "success",
      });
      const before = yield* f.state();
      const rows = yield* f.sql<{
        intent_json: string;
      }>`SELECT intent_json FROM project_work_verification_execution WHERE job_id=${f.selection.jobId}`;
      const original = yield* decodeStoredVerificationIntent(rows[0]?.intent_json);
      const changed = yield* decodeVerificationIntent({
        ...original,
        gate: { ...original.gate, recordId: "different-human-approval" },
      });
      // Self-consistent disposable storage corruption leaves the exact job and terminal artifacts intact.
      yield* f.sql`DROP TRIGGER project_work_verification_execution_progress`;
      yield* f.sql`DROP TRIGGER project_work_verification_execution_intent_immutable`;
      yield* f.sql`UPDATE project_work_verification_execution SET intent_json=${canonical(changed)},intent_hash=${verificationExecutionHash(changed)},gate_id=${changed.gate.recordId} WHERE job_id=${f.selection.jobId}`;
      expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
      expect(yield* f.state()).toEqual(before);
    }),
  ),
);
for (const verificationOutcome of [undefined, "success"] as const) {
  it.effect(
    `completed assessment qualification handles explicit empty assessments with ${verificationOutcome ?? "missing"} verification`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* makeConsumedReviewFixture({
            parentAssessment: "empty",
            ...(verificationOutcome === undefined ? {} : { verificationOutcome }),
          });
          const before = yield* f.state();
          expect((yield* readProposal(f))?.manifest.criterionAssessments).toEqual([]);
          expect(yield* f.prepare()).toMatchObject(
            verificationOutcome === "success"
              ? { status: "completed" }
              : { status: "denied", reason: "stale-proof" },
          );
          expect(yield* f.state()).toEqual(before);
        }),
      ),
  );
}
it.effect(
  "a qualified negative review atomically records one bounded semantic repair episode for its original implementation target",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const proposal = yield* makeProposalFixture(
          false,
          "failed",
          undefined,
          "-semantic-negative",
          true,
        );
        const f = yield* makeConsumedReviewFixture(
          {
            parentAssessment: true,
            assessmentVerdict: "not-met",
            verificationOutcome: "failed",
          },
          proposal,
        );
        if (f.completionReport.type !== "project-team.assignment.report")
          return yield* Effect.die("Completed reviewer report required");
        const before = yield* f.state();
        expect(before.tasks.find((task) => task.taskId === f.selection.taskId)?.state).toBe(
          "ready",
        );
        const originalJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const original = yield* originalJournal.readRetained(f.target.prepared.manifest.dispatchId);
        yield* originalJournal.readStageReceipts(original.fence.dispatchId);
        expect(original.fence.stage).toBe("settled");
        expect(original.intent.compiledClaim.transition).toMatchObject({
          kind: "claim",
          binding: {
            projectId: f.selection.projectId,
            taskId: f.selection.taskId,
            recordId: f.target.prepared.manifest.bindingId,
            generation: f.target.prepared.manifest.generation,
          },
        });
        const transition = original.intent.compiledClaim.transition;
        if (transition?.kind !== "claim")
          return yield* Effect.die("Original implementation claim required");
        const configuredLimit = before.foundationRecords
          ?.filter((record) => record.kind === "limits")
          .find((record) => record.status === "configured");
        const reviewedCriterionIds = (f.completionReport.criterionAssessments ?? [])
          .map((assessment) => assessment.criterionId)
          .sort();
        const expectedFingerprint = digest(
          canonical({
            rootTaskId: original.intent.limits.rootTaskId,
            taskId: f.selection.taskId,
            semanticCause: "failed-verification",
            criterionIds: reviewedCriterionIds,
          }),
        );
        const expectedRelevantRevision = digest(
          canonical({
            scopeHash: transition.binding.scopeHash,
            testedTree: f.target.prepared.manifest.target.testedTree,
          }),
        );
        expect((yield* f.prepare())?.status).toBe("completed");
        expect(yield* f.state()).toEqual(before);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const after = yield* f.state();
        const episodes = after.foundationRecords?.filter(
          (record) =>
            record.kind === "repair-episode" &&
            (record.rootTaskId ?? record.taskId) === original.intent.limits.rootTaskId,
        );
        expect(episodes).toHaveLength(1);
        expect(episodes?.[0]).toMatchObject({
          taskId: f.selection.taskId,
          rootTaskId: original.intent.limits.rootTaskId,
          failureFingerprint: expectedFingerprint,
          relevantRevision: expectedRelevantRevision,
          allowance: Math.min(
            original.intent.limits.repairAllowance,
            original.intent.rootCaps.repairAllowance,
            configuredLimit?.repairAllowance ?? 0,
          ),
          semanticRepairs: 0,
          pendingSemanticRepair: true,
          status: "active",
        });
        expect(after.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((task) => task.taskId === f.selection.taskId),
        );
        expect(
          after.criteria.filter((criterion) => criterion.taskId === f.selection.taskId),
        ).toEqual(before.criteria.filter((criterion) => criterion.taskId === f.selection.taskId));
        expect(after.blockers).toEqual(before.blockers);
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)))
            .duplicate,
        ).toBe(true);
        expect(yield* f.state()).toEqual(after);
      }),
    ),
);
it.effect(
  "a qualified review episode flows through configured admission and debits its original root grant once",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const proposal = yield* makeProposalFixture(
          false,
          "failed",
          undefined,
          "-integrated-admission",
          true,
        );
        const f = yield* makeConsumedReviewFixture(
          {
            parentAssessment: true,
            assessmentVerdict: "not-met",
            verificationOutcome: "failed",
          },
          proposal,
        );
        if (f.completionReport.type !== "project-team.assignment.report")
          return yield* Effect.die("Completed reviewer report required");
        const originalJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const original = yield* originalJournal.readRetained(f.target.prepared.manifest.dispatchId);
        const originalClaim = original.intent.compiledClaim.transition;
        if (originalClaim?.kind !== "claim")
          return yield* Effect.die("Original implementation claim required");
        expect(original.fence.stage).toBe("settled");
        expect(originalClaim.binding.model).toBe(configuredReviewModel);
        expect(
          (yield* f.state()).tasks.find((task) => task.taskId === f.selection.taskId)?.state,
        ).toBe("ready");
        const qualifiedReview = yield* f.prepare();
        expect(qualifiedReview?.status).toBe("completed");
        if (qualifiedReview?.status === "completed")
          expect(qualifiedReview.parentAssessments?.semanticRepair).toMatchObject({
            action: "repair",
            rootTaskId: original.intent.limits.rootTaskId,
            taskId: f.selection.taskId,
          });

        const reviewerJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(reviewerJournal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const afterReview = yield* f.state();
        const episodes = afterReview.foundationRecords?.filter(
          (record) =>
            record.kind === "repair-episode" &&
            (record.rootTaskId ?? record.taskId) === original.intent.limits.rootTaskId,
        );
        expect(episodes).toHaveLength(1);
        const episode = episodes?.[0];
        if (episode?.kind !== "repair-episode")
          return yield* Effect.die(
            "Qualified reviewer settlement did not create its repair episode",
          );
        expect(episode).toMatchObject({
          taskId: f.selection.taskId,
          rootTaskId: original.intent.limits.rootTaskId,
          pendingSemanticRepair: true,
          semanticRepairs: 0,
          status: "active",
        });

        const originalGit = original.intent.request.git;
        const repairFacts = configuredReviewFacts(
          {
            _tag: "RetainedRoot",
            budget: {
              rootTaskId: original.intent.limits.rootTaskId,
              maximumTokens: original.intent.limits.maximumTokens,
              deadlineAtMs: original.intent.limits.rootDeadlineAtMs,
            },
            caps: original.intent.rootCaps,
          },
          {
            primaryRoot: originalGit.primaryRoot,
            commonGitDirectory: originalGit.commonGitDirectory,
            worktreePath: originalGit.worktreePath,
            branchRef: originalGit.branchRef,
            baseRef: originalGit.baseRef,
            baseOid: originalGit.baseOid,
            policyHash: originalGit.policyHash,
            writable: true,
          },
        );
        const repairJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
        });
        const prepared = prepareProjectTeamConfiguredAdmission({
          state: afterReview,
          taskId: f.selection.taskId,
          nowMs: Date.parse(at) + 10,
          facts: repairFacts,
        });
        if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
        expect(prepared.request.claim.transition).toMatchObject({
          kind: "claim",
          repair: { episodeId: episode.recordId },
        });

        const repairClaim = prepared.request.claim.transition;
        if (repairClaim?.kind !== "claim" || repairClaim.repair?.episodeId !== episode.recordId)
          return yield* Effect.die("Prepared repair claim lost its canonical episode");
        const mismatchedGrantRequest = {
          ...prepared.request,
          claim: {
            ...prepared.request.claim,
            transition: {
              ...repairClaim,
              binding: {
                ...repairClaim.binding,
                authorizationGateId: projectTeamDerivedRecordId(
                  prepared.request.claim.commandId,
                  "foreign-repair-inherited-grant",
                ),
              },
            },
          },
        };
        expect(
          (yield* repairJournal.reserve(mismatchedGrantRequest).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(afterReview);
        expect(
          yield* f.sql`SELECT * FROM project_team_dispatch WHERE dispatch_id=${prepared.request.dispatchId}`,
        ).toEqual([]);
        const foreignGrantRequest = {
          ...prepared.request,
          claim: {
            ...prepared.request.claim,
            transition: {
              ...repairClaim,
              authorizationGateId: projectTeamDerivedRecordId(
                prepared.request.claim.commandId,
                "foreign-repair-grant",
              ),
            },
          },
        };
        expect((yield* repairJournal.reserve(foreignGrantRequest).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(afterReview);
        expect(
          yield* f.sql`SELECT * FROM project_team_dispatch WHERE dispatch_id=${prepared.request.dispatchId}`,
        ).toEqual([]);

        const rejected = yield* repairJournal
          .reserve({
            ...prepared.request,
            claim: {
              ...prepared.request.claim,
              expectedRevision: prepared.request.claim.expectedRevision + 1,
            },
          })
          .pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(afterReview);
        expect(
          yield* f.sql`SELECT * FROM project_team_dispatch WHERE dispatch_id=${prepared.request.dispatchId}`,
        ).toEqual([]);
        const repairDispatch = yield* repairJournal.reserve(prepared.request);
        expect(repairDispatch.intent.limits).toMatchObject({
          maximumTokens: original.intent.limits.maximumTokens,
          rootDeadlineAtMs: original.intent.limits.rootDeadlineAtMs,
          repairAllowance: original.intent.limits.repairAllowance,
        });
        expect(repairDispatch.intent.rootCaps).toEqual(original.intent.rootCaps);
        const afterDebit = yield* readCurrentState(f.sql, projectId);
        const expectedRepairGrantId = projectTeamDerivedRecordId(
          repairDispatch.intent.compiledClaim.commandId,
          `repair-grant:${episode.recordId}:${repairClaim.binding.generation}`,
        );
        const repairBindings = afterDebit.foundationRecords?.filter(
          (record) =>
            record.kind === "run-binding" && record.recordId === repairClaim.binding.recordId,
        );
        const repairGrants = afterDebit.foundationRecords?.filter(
          (record) => record.kind === "gate" && record.recordId === expectedRepairGrantId,
        );
        expect(repairBindings).toHaveLength(1);
        expect(repairBindings?.[0]).toMatchObject({
          authorizationGateId: expectedRepairGrantId,
          repairEpisodeId: episode.recordId,
        });
        expect(repairGrants).toHaveLength(1);
        expect(repairGrants?.[0]).toMatchObject({
          gate: "repair",
          status: "consumed",
          consumedByRunId: repairClaim.binding.recordId,
          repairAuthorization: {
            episodeId: episode.recordId,
            inheritedGateId: repairClaim.authorizationGateId,
          },
        });
        expect(
          afterDebit.foundationRecords?.find(
            (record) => record.kind === "repair-episode" && record.recordId === episode.recordId,
          ),
        ).toMatchObject({
          status: "active",
          semanticRepairs: 1,
          allowance: original.intent.limits.repairAllowance,
          pendingSemanticRepair: false,
          lastSemanticRevision: episode.relevantRevision,
        });
        expect(
          afterDebit.foundationRecords?.find(
            (record) => record.kind === "task-membership" && record.taskId === f.selection.taskId,
          ),
        ).toMatchObject({ assignment: { repairEpisodeId: episode.recordId } });
        const repairBinding = repairBindings?.[0];
        if (repairBinding?.kind !== "run-binding")
          return yield* Effect.die("Missing repair binding");
        const repairOperations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        });
        const repairAuthority = yield* repairOperations.current(
          {
            providerInstanceId: repairBinding.providerInstanceId,
            threadId: repairBinding.threadId,
          },
          true,
        );
        expect(
          yield* repairOperations.readRootBudget(
            repairAuthority,
            {
              operationId: repairDispatch.intent.request.initializeOperationId,
              operationKind: "initialize",
            },
            {
              kind: "initialize",
              operationId: repairDispatch.intent.request.initializeOperationId,
              threadId: repairBinding.threadId,
              resumeCursor: null,
            },
            "a".repeat(64),
          ),
        ).toEqual({
          rootTaskId: original.intent.limits.rootTaskId,
          maximumTokens: original.intent.limits.maximumTokens,
          deadlineAtMs: original.intent.limits.rootDeadlineAtMs,
        });
        expect(yield* repairJournal.reserve(prepared.request)).toEqual(repairDispatch);
        expect(
          yield* f.withTarget(
            reviewerJournal.settleAfterJoined(f.proposalSnapshot.fence, f.joined),
          ),
        ).toMatchObject({ duplicate: true });
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(afterDebit);
      }),
    ),
);
for (const initialPendingSemanticRepair of [false, true, "legacy"] as const) {
  it.effect(
    `a qualified positive assessment resolves only its matching semantic repair episode${
      initialPendingSemanticRepair === true
        ? " with an existing pending repair fence"
        : initialPendingSemanticRepair === "legacy"
          ? " with a legacy episode lacking the pending marker"
          : ""
    }`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const proposal = yield* makeProposalFixture(
            false,
            "success",
            undefined,
            "-semantic-positive",
            true,
          );
          const f = yield* makeConsumedReviewFixture(
            {
              parentAssessment: true,
              assessmentVerdict: "met",
              verificationOutcome: "success",
            },
            proposal,
          );
          if (f.completionReport.type !== "project-team.assignment.report")
            return yield* Effect.die("Completed reviewer report required");
          const originalJournal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
          });
          const original = yield* originalJournal.readRetained(
            f.target.prepared.manifest.dispatchId,
          );
          const originalClaim = original.intent.compiledClaim.transition;
          if (originalClaim?.kind !== "claim")
            return yield* Effect.die("Original implementation claim required");
          const criterionIds = (f.completionReport.criterionAssessments ?? [])
            .map((assessment) => assessment.criterionId)
            .sort();
          const failureFingerprint = digest(
            canonical({
              rootTaskId: original.intent.limits.rootTaskId,
              taskId: f.selection.taskId,
              semanticCause: "failed-verification",
              criterionIds,
            }),
          );
          const relevantRevision = digest(
            canonical({
              scopeHash: originalClaim.binding.scopeHash,
              testedTree: f.target.prepared.manifest.target.testedTree,
            }),
          );
          const allowance = Math.min(
            original.intent.limits.repairAllowance,
            original.intent.rootCaps.repairAllowance,
          );
          const makeEpisode = (
            recordId: string,
            fingerprint: string,
            status: "active" | "resolved",
            pendingSemanticRepair: boolean | "legacy" = false,
          ): ProjectTeamRecord => ({
            kind: "repair-episode",
            projectId,
            recordId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status,
            taskId: f.selection.taskId,
            rootTaskId: original.intent.limits.rootTaskId,
            failureFingerprint: fingerprint,
            relevantRevision,
            allowance,
            semanticRepairs: Math.min(1, allowance),
            ...(pendingSemanticRepair === "legacy" ? {} : { pendingSemanticRepair }),
            ...(allowance === 0 ? {} : { lastSemanticRevision: relevantRevision }),
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [originalClaim.claim.attemptId],
          });
          const resolvedAlready = makeEpisode(
            "unrelated-resolved-semantic-episode",
            "b".repeat(64),
            "resolved",
          );
          yield* f.commitRecords("seed-review-repair-episodes", [
            makeEpisode(
              "matching-semantic-episode",
              failureFingerprint,
              "active",
              initialPendingSemanticRepair,
            ),
            resolvedAlready,
          ]);
          const before = yield* f.state();
          const pendingEpisode = before.foundationRecords?.find(
            (record): record is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
              record.kind === "repair-episode" && record.recordId === "matching-semantic-episode",
          );
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            verifyStage: () => Effect.void,
            verifySettlement: () => Effect.void,
            prepareReviewCompletion: f.consumer.prepare,
            verifyReviewTarget: f.targetService.assertOriginalInTransaction,
          });
          yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
          const after = yield* f.state();
          expect(
            after.foundationRecords?.find(
              (record) =>
                record.kind === "repair-episode" && record.recordId === "matching-semantic-episode",
            ),
          ).toMatchObject({
            status: "resolved",
            pendingSemanticRepair: false,
            revision: (pendingEpisode?.revision ?? -1) + 1,
            generation: pendingEpisode?.generation,
            failureFingerprint,
            relevantRevision,
            lastSemanticRevision: pendingEpisode?.lastSemanticRevision,
            semanticRepairs: Math.min(1, allowance),
            allowance,
            rootTaskId: original.intent.limits.rootTaskId,
            transportRetries: pendingEpisode?.transportRetries,
            timeoutCount: pendingEpisode?.timeoutCount,
            attemptIds: pendingEpisode?.attemptIds,
          });
          expect(
            after.foundationRecords?.find(
              (record) =>
                record.kind === "repair-episode" &&
                record.recordId === "unrelated-resolved-semantic-episode",
            ),
          ).toEqual(resolvedAlready);
          expect(after.blockers).toEqual(before.blockers);
          expect(after.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
            before.tasks.find((task) => task.taskId === f.selection.taskId),
          );
          const retainedAfter = yield* originalJournal.readRetained(
            f.target.prepared.manifest.dispatchId,
          );
          expect(retainedAfter.intent.limits).toEqual(original.intent.limits);
          expect(retainedAfter.intent.rootCaps).toEqual(original.intent.rootCaps);
          expect(
            (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)))
              .duplicate,
          ).toBe(true);
          expect(yield* f.state()).toEqual(after);
        }),
      ),
  );
}
it.effect(
  "a repeated qualified failure on the same tested tree exhausts the matching episode and opens actionable attention",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const proposal = yield* makeProposalFixture(
          false,
          "failed",
          undefined,
          "-semantic-repeat",
          true,
        );
        const f = yield* makeConsumedReviewFixture(
          {
            parentAssessment: true,
            assessmentVerdict: "not-met",
            verificationOutcome: "failed",
          },
          proposal,
        );
        if (f.completionReport.type !== "project-team.assignment.report")
          return yield* Effect.die("Completed reviewer report required");
        const originalJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const original = yield* originalJournal.readRetained(f.target.prepared.manifest.dispatchId);
        const originalClaim = original.intent.compiledClaim.transition;
        if (originalClaim?.kind !== "claim")
          return yield* Effect.die("Original implementation claim required");
        const criterionIds = (f.completionReport.criterionAssessments ?? [])
          .map((assessment) => assessment.criterionId)
          .sort();
        const failureFingerprint = digest(
          canonical({
            rootTaskId: original.intent.limits.rootTaskId,
            taskId: f.selection.taskId,
            semanticCause: "failed-verification",
            criterionIds,
          }),
        );
        const relevantRevision = digest(
          canonical({
            scopeHash: originalClaim.binding.scopeHash,
            testedTree: f.target.prepared.manifest.target.testedTree,
          }),
        );
        const allowance = Math.min(
          original.intent.limits.repairAllowance,
          original.intent.rootCaps.repairAllowance,
        );
        yield* f.commitRecords("seed-repeated-semantic-episode", [
          {
            kind: "repair-episode",
            projectId,
            recordId: "repeated-semantic-episode",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            taskId: f.selection.taskId,
            rootTaskId: original.intent.limits.rootTaskId,
            failureFingerprint,
            relevantRevision,
            allowance,
            semanticRepairs: 0,
            pendingSemanticRepair: true,
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [originalClaim.claim.attemptId],
          },
        ]);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        const after = yield* f.state();
        expect(
          after.foundationRecords?.find(
            (record) =>
              record.kind === "repair-episode" && record.recordId === "repeated-semantic-episode",
          ),
        ).toMatchObject({
          status: "exhausted",
          pendingSemanticRepair: true,
          allowance,
          semanticRepairs: 0,
          failureFingerprint,
          relevantRevision,
        });
        expect(
          after.blockers.find(
            (blocker) =>
              blocker.taskId === f.selection.taskId &&
              blocker.resolvedAt === undefined &&
              blocker.referenceIds.includes("repeated-semantic-episode"),
          ),
        ).toMatchObject({
          attention: true,
          reason: expect.stringContaining("Repeated verification failure"),
        });
      }),
    ),
);
it.effect(
  "a qualified failure after a consumed repair reopens the same episode for a changed tested tree",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const proposal = yield* makeProposalFixture(
          false,
          "failed",
          undefined,
          "-semantic-repair-retry",
          true,
        );
        const f = yield* makeConsumedReviewFixture(
          {
            parentAssessment: true,
            assessmentVerdict: "not-met",
            verificationOutcome: "failed",
          },
          proposal,
        );
        if (f.completionReport.type !== "project-team.assignment.report")
          return yield* Effect.die("Completed reviewer report required");
        const originalJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const original = yield* originalJournal.readRetained(f.target.prepared.manifest.dispatchId);
        const originalClaim = original.intent.compiledClaim.transition;
        if (originalClaim?.kind !== "claim")
          return yield* Effect.die("Original implementation claim required");
        const criterionIds = (f.completionReport.criterionAssessments ?? [])
          .map((assessment) => assessment.criterionId)
          .sort();
        const failureFingerprint = digest(
          canonical({
            rootTaskId: original.intent.limits.rootTaskId,
            taskId: f.selection.taskId,
            semanticCause: "failed-verification",
            criterionIds,
          }),
        );
        const previousRevision = digest(
          canonical({
            scopeHash: originalClaim.binding.scopeHash,
            testedTree: "prior-tested-tree",
          }),
        );
        const allowance = Math.min(
          original.intent.limits.repairAllowance,
          original.intent.rootCaps.repairAllowance,
        );
        yield* f.commitRecords("seed-consumed-semantic-repair", [
          {
            kind: "repair-episode",
            projectId,
            recordId: "consumed-semantic-repair",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            taskId: f.selection.taskId,
            rootTaskId: original.intent.limits.rootTaskId,
            failureFingerprint,
            relevantRevision: previousRevision,
            allowance,
            semanticRepairs: 1,
            pendingSemanticRepair: false,
            lastSemanticRevision: previousRevision,
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [originalClaim.claim.attemptId],
          },
        ]);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        expect(
          (yield* f.state()).foundationRecords?.find(
            (record) =>
              record.kind === "repair-episode" && record.recordId === "consumed-semantic-repair",
          ),
        ).toMatchObject({
          status: "active",
          allowance,
          semanticRepairs: 1,
          pendingSemanticRepair: true,
          lastSemanticRevision: previousRevision,
        });
      }),
    ),
);
it.effect(
  "a lower current configured repair allowance exhausts an episode at that effective cap",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const proposal = yield* makeProposalFixture(
          false,
          "failed",
          undefined,
          "-semantic-lowered-cap",
          true,
        );
        const f = yield* makeConsumedReviewFixture(
          {
            parentAssessment: true,
            assessmentVerdict: "not-met",
            verificationOutcome: "failed",
          },
          proposal,
        );
        if (f.completionReport.type !== "project-team.assignment.report")
          return yield* Effect.die("Completed reviewer report required");
        const originalJournal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
        });
        const original = yield* originalJournal.readRetained(f.target.prepared.manifest.dispatchId);
        const originalClaim = original.intent.compiledClaim.transition;
        if (originalClaim?.kind !== "claim")
          return yield* Effect.die("Original implementation claim required");
        const criterionIds = (f.completionReport.criterionAssessments ?? [])
          .map((assessment) => assessment.criterionId)
          .sort();
        const failureFingerprint = digest(
          canonical({
            rootTaskId: original.intent.limits.rootTaskId,
            taskId: f.selection.taskId,
            semanticCause: "failed-verification",
            criterionIds,
          }),
        );
        const priorRevision = digest(
          canonical({
            scopeHash: originalClaim.binding.scopeHash,
            testedTree: "prior-tested-tree",
          }),
        );
        const allowance = Math.min(
          original.intent.limits.repairAllowance,
          original.intent.rootCaps.repairAllowance,
        );
        const configuredLimits = (yield* f.state()).foundationRecords?.find(
          (record) => record.kind === "limits" && record.status === "configured",
        );
        if (configuredLimits?.kind !== "limits" || configuredLimits.repairAllowance < 2)
          return yield* Effect.die(
            "Fixture requires a configured repair allowance of at least two",
          );
        yield* f.commitRecords("lower-current-semantic-repair-allowance", [
          { ...configuredLimits, revision: configuredLimits.revision + 1, repairAllowance: 1 },
          {
            kind: "repair-episode",
            projectId,
            recordId: "current-cap-semantic-repair",
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "active",
            taskId: f.selection.taskId,
            rootTaskId: original.intent.limits.rootTaskId,
            failureFingerprint,
            relevantRevision: priorRevision,
            allowance,
            semanticRepairs: 1,
            pendingSemanticRepair: false,
            lastSemanticRevision: priorRevision,
            transportRetries: 0,
            timeoutCount: 0,
            attemptIds: [originalClaim.claim.attemptId],
          },
        ]);
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
        expect(
          (yield* f.state()).foundationRecords?.find(
            (record) =>
              record.kind === "repair-episode" && record.recordId === "current-cap-semantic-repair",
          ),
        ).toMatchObject({
          status: "exhausted",
          allowance,
          semanticRepairs: 1,
          pendingSemanticRepair: true,
        });
      }),
    ),
);
for (const verificationOutcome of ["timed-out", "canceled"] as const)
  it.effect(
    `a negative review with ${verificationOutcome} verification remains visible without semantic repair authority`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const proposal = yield* makeProposalFixture(
            false,
            verificationOutcome,
            undefined,
            "-semantic-terminal",
            true,
          );
          const f = yield* makeConsumedReviewFixture(
            {
              parentAssessment: true,
              assessmentVerdict: "not-met",
            },
            proposal,
          );
          const before = yield* f.state();
          const proof = yield* f.prepare();
          expect(proof?.status).toBe("completed");
          if (proof?.status === "completed")
            expect(proof.parentAssessments?.semanticRepair).toBeUndefined();
          expect(yield* f.state()).toEqual(before);
          const journal = yield* makeProjectTeamDispatchJournal({
            environmentId: "environment",
            maximumEnvironmentModelCalls: 128,
            verifyStage: () => Effect.void,
            verifySettlement: () => Effect.void,
            prepareReviewCompletion: f.consumer.prepare,
            verifyReviewTarget: f.targetService.assertOriginalInTransaction,
          });
          yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined));
          const after = yield* f.state();
          expect(
            after.foundationRecords?.some(
              (record) => record.kind === "repair-episode" && record.taskId === f.selection.taskId,
            ),
          ).toBe(false);
          expect(after.tasks.find((task) => task.taskId === f.selection.taskId)).toEqual(
            before.tasks.find((task) => task.taskId === f.selection.taskId),
          );
          expect(after.tasks.find((task) => task.taskId === f.running.taskId)?.state).toBe(
            "completed",
          );
        }),
      ),
  );
it.effect(
  "completed assessment qualification settles only the reviewer child and exact replay remains stable",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined))).fence
            .stage,
        ).toBe("settled");
        const after = yield* f.state();
        expect(after.tasks.find((t) => t.taskId === f.running.taskId)?.state).toBe("completed");
        expect(after.tasks.find((t) => t.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((t) => t.taskId === f.selection.taskId),
        );
        expect(
          after.criteria.find((c) => c.criterionId === f.selection.criterionIds[0])?.status,
        ).toBe("satisfied");
        expect(
          after.criteria.filter(
            (c) =>
              c.taskId === f.selection.taskId && !f.selection.criterionIds.includes(c.criterionId),
          ),
        ).toEqual(
          before.criteria.filter(
            (c) =>
              c.taskId === f.selection.taskId && !f.selection.criterionIds.includes(c.criterionId),
          ),
        );
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)))
            .duplicate,
        ).toBe(true);
        expect(yield* f.state()).toEqual(after);
      }),
    ),
);
it.effect(
  "completed review consumer qualifies only exact original consumed proof without completing the child",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedReviewFixture;
        const before = yield* f.state();
        const retained = yield* readProposal(f);
        const proof = yield* f.prepare();
        expect(proof?.status).toBe("completed");
        if (proof?.status !== "completed" || !retained)
          return yield* Effect.die("Missing qualified review proof");
        expect(proof.proposalSha256).toBe(retained.sha256);
        expect(proof.assignmentReceiptSha256).toBe(digest(canonical(f.originalReceipt)));
        expect(proof.report).toEqual(f.completionReport);
        expect(proof.criteria).toEqual(retained.manifest.criteria);
        expect(proof.findings).toEqual([]);
        expect(yield* f.prepare()).toEqual(proof);
        expect(yield* f.state()).toEqual(before);
        expect(before.tasks.find((t) => t.taskId === proof.target.taskId)?.state).not.toBe(
          "completed",
        );
      }),
    ),
);
it.effect(
  "completed review consumer allows a retained critical finding and unfinished parent",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({ criticalFinding: true });
        const proof = yield* f.prepare();
        expect(proof?.status).toBe("completed");
        if (proof?.status !== "completed")
          return yield* Effect.die("Missing critical-finding review proof");
        expect(proof.findings).toHaveLength(1);
        expect(
          (yield* f.state()).tasks.find((t) => t.taskId === proof.target.taskId)?.state,
        ).not.toBe("completed");
      }),
    ),
);
it.effect(
  "completed review consumer permits expired historical leases without current authorization",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedReviewFixture;
        yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z") + 1);
        expect(
          (yield* (yield* ProjectTeamAuthorization).resolve(f.principal).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* f.prepare())?.status).toBe("completed");
      }),
    ),
);
it.effect(
  "completed review consumer denies newly reported findings after an explicit empty snapshot",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedReviewFixture;
        yield* f.repository.execute(yield* f.compile(yield* f.report({ severity: "critical" })));
        const before = yield* f.state();
        expect(yield* f.prepare()).toMatchObject({ status: "denied", reason: "stale-proof" });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);
for (const change of [
  "criterion",
  "evidence",
  "target",
  "member",
  "control",
  "dependency",
  "child",
  "failed",
  "missing",
  "input",
  "freshness",
] as const) {
  it.effect(`completed review consumer denies changed original proof: ${change}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({ referencedEvidence: change === "evidence" });
        if (change === "criterion" || change === "evidence") {
          // Disposable derived-snapshot corruption; this is not a public mutation permission.
          const changed = yield* f.state();
          const altered =
            change === "criterion"
              ? {
                  ...changed,
                  criteria: changed.criteria.map((c) =>
                    c.criterionId === f.criterion.criterionId
                      ? { ...c, description: "Changed criterion content", revision: c.revision + 1 }
                      : c,
                  ),
                }
              : {
                  ...changed,
                  evidence: changed.evidence.map((e) =>
                    e.evidenceId === f.referenceId
                      ? { ...e, detail: "Changed evidence content", revision: e.revision + 1 }
                      : e,
                  ),
                };
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${canonical(altered)} WHERE project_id=${projectId}`;
        }
        if (change === "target")
          yield* f.sql`DELETE FROM project_team_review_target WHERE dispatch_id=${f.proposalSnapshot.fence.dispatchId}`;
        if (change === "member") {
          const member = (yield* f.state()).foundationRecords?.find(
            (r) => r.kind === "member" && r.recordId === f.running.memberId,
          );
          if (member?.kind !== "member") return yield* Effect.die("Missing original member");
          yield* f.commitRecords("review-member-pause", [
            decodeRecord({ ...member, status: "paused", revision: member.revision + 1 }),
          ]);
        }
        if (change === "control") {
          const membership = (yield* f.state()).foundationRecords?.find(
            (r) => r.kind === "task-membership" && r.taskId === f.running.taskId,
          );
          if (membership?.kind !== "task-membership")
            return yield* Effect.die("Missing original membership");
          yield* f.commitRecords("review-control-pause", [
            decodeRecord({
              ...membership,
              controlState: "paused",
              revision: membership.revision + 1,
            }),
          ]);
        }
        if (change === "dependency") {
          // Ordinary links into a managed task are protected; corrupt only this disposable derived snapshot.
          const changed = yield* f.state();
          const relationship = yield* decodeControlledRelationship({
            relationshipId: "review-explicit-dependency",
            projectId,
            fromTaskId: f.running.taskId,
            toTaskId: f.selection.taskId,
            kind: "depends-on",
            revision: 0,
            createdAt: at,
            attribution,
          });
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=${canonical({ ...changed, relationships: [...changed.relationships, relationship] })} WHERE project_id=${projectId}`;
        }
        if (change === "child") {
          yield* f.repository.execute(
            yield* decodeWorkCommand({
              type: "project-work.task.create",
              commandId: "review-active-child",
              projectId,
              taskId: "review-active-child",
              title: "Explicit dependent review child",
              createdAt: at,
              attribution,
            }),
          );
          yield* f.commitRecords("review-child-membership", [
            decodeRecord({
              kind: "task-membership",
              recordId: "review-child-membership",
              projectId,
              revision: 0,
              generation: 0,
              updatedAt: at,
              status: "active",
              taskId: "review-active-child",
              parentTaskId: f.running.taskId,
              executionKind: "human",
              deliverableKind: "non-code",
            }),
          ]);
        }
        if (change === "failed")
          yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=json_set(terminal_json,'$.outcome','failed') WHERE operation_id=${f.operation.operationId}`;
        if (change === "missing") {
          yield* f.sql`DELETE FROM project_team_pi_process WHERE operation_id=${f.operation.operationId}`;
        }
        if (change === "input") {
          yield* f.sql`DROP TRIGGER project_team_mailbox_input_immutable`;
          yield* f.sql`UPDATE project_team_mailbox_input SET worker_id='foreign' WHERE operation_id=${f.operation.operationId}`;
        }
        if (change === "freshness") {
          // Bypass an immutable trigger only to simulate corruption of disposable retained custody.
          yield* f.sql`DROP TRIGGER project_team_review_freshness_immutable`;
          yield* f.sql`UPDATE project_team_review_freshness SET native_jsonl='x' WHERE operation_id='review-initialize'`;
        }
        const before = yield* f.state();
        const proof = yield* f.prepare();
        expect(proof?.status).toBe("denied");
        if (change === "dependency" || change === "child")
          expect(proof).toMatchObject({ reason: "dependency-incomplete" });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
  );
}
it.effect(
  "completed review consumer captures caller input before yielding and rejects extra fields",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedReviewFixture;
        const snapshot = structuredClone(f.proposalSnapshot);
        const joined = structuredClone(f.joined);
        const effect = f.consumer.prepare(snapshot, joined);
        Reflect.set(snapshot.fence, "dispatchId", "foreign");
        Reflect.set(joined.evidence, "bindingId", "foreign");
        expect((yield* f.sql.withTransaction(effect))?.status).toBe("completed");
        const injected = { ...f.proposalSnapshot, injected: true };
        expect(
          (yield* f.sql.withTransaction(f.consumer.prepare(injected, f.joined)).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    ),
);
it.effect("completed review consumer preserves SQL failure and rolls back owning writes", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* consumedReviewFixture;
      const before = yield* f.state();
      // Establish a valid cached statement before the controlled transactional schema fault.
      expect((yield* f.prepare())?.status).toBe("completed");
      const result = yield* f.sql
        .withTransaction(
          Effect.gen(function* () {
            yield* f.sql`DROP TABLE project_team_mailbox_input`;
            return yield* f.consumer.prepare(f.proposalSnapshot, f.joined);
          }),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SqlError");
      expect(yield* f.state()).toEqual(before);
      expect((yield* f.prepare())?.status).toBe("completed");
    }),
  ),
);
it.effect(
  "integrated completed review settlement completes only the original review child and replays exactly after lease expiry",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({ criticalFinding: true });
        const before = yield* f.state();
        const proof = yield* f.prepare();
        if (proof?.status !== "completed")
          return yield* Effect.die("Missing original completed proof");
        let qualifications = 0;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          // Disposable retained SQL/custody descriptors, not actual Host/native drain verification.
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: (snapshot, receipt) =>
            f.consumer.prepare(snapshot, receipt).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  qualifications++;
                }),
              ),
            ),
        });
        yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z") + 1);
        const settled = yield* journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined);
        expect(settled.fence.stage).toBe("settled");
        const after = yield* f.state();
        expect(after.tasks.find((t) => t.taskId === f.running.taskId)?.state).toBe("completed");
        expect(after.attempts.find((a) => a.attemptId === f.running.attemptId)?.state).toBe(
          "succeeded",
        );
        expect(
          after.foundationRecords?.find((r) => r.recordId === f.running.recordId),
        ).toMatchObject({ status: "settled" });
        expect(after.tasks.find((t) => t.taskId === proof.target.taskId)).toEqual(
          before.tasks.find((t) => t.taskId === proof.target.taskId),
        );
        expect(after.criteria.filter((c) => c.taskId === proof.target.taskId)).toEqual(
          before.criteria.filter((c) => c.taskId === proof.target.taskId),
        );
        expect(
          after.foundationRecords?.filter(
            (r) => r.kind === "gate" && r.taskId === proof.target.taskId,
          ),
        ).toEqual(
          before.foundationRecords?.filter(
            (r) => r.kind === "gate" && r.taskId === proof.target.taskId,
          ),
        );
        expect(after.foundationRecords?.filter((r) => r.kind === "review-finding")).toEqual(
          before.foundationRecords?.filter((r) => r.kind === "review-finding"),
        );
        expect(
          after.evidence.filter((e) => proof.outputs.some((o) => o.evidenceId === e.evidenceId)),
        ).toHaveLength(proof.outputs.length);
        expect(after.evidence.find((e) => e.evidenceId === proof.reportEvidenceId)).toMatchObject({
          taskId: f.running.taskId,
          detail: f.completionReport.summary,
          attribution: f.reportAttribution,
        });
        expect(after.comments?.find((c) => c.commentId === proof.reportCommentId)).toMatchObject({
          taskId: f.running.taskId,
          body: f.completionReport.summary,
        });
        const events = yield* f.sql<{
          event_type: string;
        }>`SELECT event_type FROM project_work_events WHERE project_id=${projectId} AND command_id=(SELECT command_id FROM project_work_events WHERE project_id=${projectId} AND event_type='project-work.task.completed' AND json_extract(payload_json,'$.taskId')=${f.running.taskId} LIMIT 1) ORDER BY sequence`;
        const types = events.map((e) => e.event_type);
        expect(types.slice(0, proof.outputs.length)).toEqual(
          proof.outputs.map(() => "project-work.evidence.added"),
        );
        expect(types.slice(proof.outputs.length, proof.outputs.length + 3)).toEqual([
          "project-work.evidence.added",
          "project-work.comment.added",
          "project-work.task.completed",
        ]);
        expect(types[proof.outputs.length + 3]).toBe("project-work.foundation.recorded");
        expect(types).not.toContain("project-work.attempt.stopped");
        const counts =
          yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts`;
        expect(
          (yield* journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)).duplicate,
        ).toBe(true);
        expect(qualifications).toBe(1);
        expect(yield* f.state()).toEqual(after);
        expect(
          yield* f.sql`SELECT (SELECT COUNT(*) FROM project_work_events WHERE project_id=${projectId}) AS events,(SELECT COUNT(*) FROM project_work_command_receipts WHERE project_id=${projectId}) AS receipts`,
        ).toEqual(counts);
        const query = yield* ProjectWorkQuery;
        expect(
          (yield* query.snapshot(projectId)).tasks.find((t) => t.taskId === f.running.taskId)
            ?.state,
        ).toBe("completed");
      }),
    ),
);
it.effect(
  "integrated completed review settlement denies changed findings then stops and retains child attention without report outputs",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* consumedReviewFixture;
        yield* f.repository.execute(yield* f.compile(yield* f.report({ severity: "critical" })));
        const before = yield* f.state();
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
        });
        yield* journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined);
        const after = yield* f.state();
        expect(after.tasks.find((t) => t.taskId === f.running.taskId)?.state).toBe("blocked");
        expect(after.attempts.find((a) => a.attemptId === f.running.attemptId)?.state).toBe(
          "canceled",
        );
        expect(after.blockers.some((b) => b.taskId === f.running.taskId && b.attention)).toBe(true);
        expect(
          after.foundationRecords?.find((r) => r.recordId === f.running.recordId),
        ).toMatchObject({ status: "settled" });
        expect(after.evidence).toEqual(before.evidence);
        expect(after.comments).toEqual(before.comments);
        expect(after.tasks.find((t) => t.taskId === f.selection.taskId)).toEqual(
          before.tasks.find((t) => t.taskId === f.selection.taskId),
        );
        const blocked = yield* f.sql<{
          event_type: string;
        }>`SELECT event_type FROM project_work_events WHERE project_id=${projectId} AND json_extract(payload_json,'$.taskId')=${f.running.taskId} AND event_type IN ('project-work.attempt.stopped','project-work.task.blocked','project-work.task.completed') ORDER BY sequence`;
        expect(blocked.map((e) => e.event_type)).toEqual([
          "project-work.attempt.stopped",
          "project-work.task.blocked",
        ]);
      }),
    ),
);
it.effect(
  "integrated completed review settlement propagates consumer SQL failure and rolls back its stage before exact retry",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        expect((yield* f.prepare())?.status).toBe("completed");
        const before = yield* f.state();
        const priorReceipts = yield* f.journal.readStageReceipts(
          f.proposalSnapshot.fence.dispatchId,
        );
        const inputs =
          yield* f.sql`SELECT * FROM project_team_mailbox_input WHERE operation_id=${f.operation.operationId}`;
        const broken = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: (snapshot, receipt) =>
            Effect.gen(function* () {
              // Controlled transactional storage fault, followed by the actual consumer.
              yield* f.sql`DROP TABLE project_team_mailbox_input`;
              return yield* f.consumer.prepare(snapshot, receipt);
            }),
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        const result = yield* f
          .withTarget(broken.settleAfterJoined(f.proposalSnapshot.fence, f.joined))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "PersistenceSqlError",
            cause: { _tag: "SqlError" },
          });
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
          priorReceipts,
        );
        expect(
          yield* f.sql`SELECT * FROM project_team_mailbox_input WHERE operation_id=${f.operation.operationId}`,
        ).toEqual(inputs);
        const retry = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        expect(
          (yield* f.withTarget(retry.settleAfterJoined(f.proposalSnapshot.fence, f.joined))).fence
            .stage,
        ).toBe("settled");
        expect((yield* f.state()).tasks.find((t) => t.taskId === f.running.taskId)?.state).toBe(
          "completed",
        );
      }),
    ),
);
it.effect(
  "integrated completed review settlement failed COMMIT exposes no completion or public snapshot",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          verificationOutcome: "success",
        });
        const before = yield* f.state();
        const priorReceipts = yield* f.journal.readStageReceipts(
          f.proposalSnapshot.fence.dispatchId,
        );
        const query = yield* ProjectWorkQuery;
        const gateway = yield* ProjectWorkGateway;
        const beforeSnapshot = yield* query.snapshot(projectId);
        const beforeFindings = decodePage(
          yield* gateway.read({
            projectId,
            operation: "foundation-records",
            recordKinds: ["review-finding"],
          }),
        ).items;
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 128,
          verifyStage: () => Effect.void,
          verifySettlement: () => Effect.void,
          prepareReviewCompletion: f.consumer.prepare,
          verifyReviewTarget: f.targetService.assertOriginalInTransaction,
        });
        yield* f.sql`CREATE TABLE completion_commit_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE completion_commit_child(id TEXT REFERENCES completion_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER completion_commit_failure AFTER INSERT ON project_work_events BEGIN INSERT INTO completion_commit_child VALUES ('missing'); END`;
        let escaped = false;
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(
          (yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM completion_commit_child`)[0]?.count,
        ).toBe(0);
        expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
        expect(
          decodePage(
            yield* gateway.read({
              projectId,
              operation: "foundation-records",
              recordKinds: ["review-finding"],
            }),
          ).items,
        ).toEqual(beforeFindings);
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.journal.readStageReceipts(f.proposalSnapshot.fence.dispatchId)).toEqual(
          priorReceipts,
        );
        yield* f.sql`DROP TRIGGER completion_commit_failure`;
        expect(
          (yield* f.withTarget(journal.settleAfterJoined(f.proposalSnapshot.fence, f.joined))).fence
            .stage,
        ).toBe("settled");
        expect(
          (yield* query.snapshot(projectId)).tasks.find((t) => t.taskId === f.running.taskId)
            ?.state,
        ).toBe("completed");
      }),
    ),
);
it.effect(
  "retains a pending original review completion proposal with explicit empty findings and no work-state changes",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        const command = yield* f.compileProposal();
        expect(command.records).toEqual([]);
        expect(() => decodeCommit(command)).toThrow();
        const retained = yield* f.sql.withTransaction(
          f.proposals.readRetained({
            environmentId: "environment",
            projectId,
            commandId: f.completionReport.commandId,
          }),
        );
        expect(retained?.manifest.findings).toEqual([]);
        expect(retained?.manifest.report).toEqual(f.completionReport);
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

const completionTool = (f: Effect.Success<typeof proposalFixture>, report = f.completionReport) =>
  executePiProjectWorkBridgeTool({
    toolName: "project_work_report",
    arguments: { intentJSON: canonical(report) },
    principal: f.principal,
    source: f.reportAttribution.source,
  }).pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation));
const readProposal = (f: Effect.Success<typeof proposalFixture>) =>
  f.sql.withTransaction(
    f.proposals.readRetained({
      environmentId: "environment",
      projectId,
      commandId: f.completionReport.commandId,
    }),
  );

const parentAssessmentFixture = Effect.gen(function* () {
  const f = yield* proposalFixture;
  const current = yield* f.state();
  const criterion = current.criteria.find((c) => c.criterionId === f.selection.criterionIds[0]);
  if (!criterion || criterion.taskId !== f.selection.taskId)
    return yield* Effect.die("Missing selected parent criterion");
  const plan = current.foundationRecords?.find(
    (r) =>
      r.kind === "plan-revision" &&
      r.taskId === criterion.taskId &&
      r.planRevision === f.target.prepared.manifest.planRevision,
  );
  const evidence = {
    evidenceId: ProjectWorkEvidenceId.make("parent-assessment-note"),
    taskId: criterion.taskId,
    criterionId: criterion.criterionId,
    kind: "observation" as const,
    summary: "Retained original parent review observation",
    detail: "The selected criterion was inspected against the original target",
    recordedAt: at,
    revision: 0,
    attribution: f.reportAttribution,
    scopeHash: projectTeamScopeHash(
      current,
      criterion.taskId,
      plan?.kind === "plan-revision" ? plan : undefined,
    ),
  };
  yield* f.repository.execute({
    type: "project-work.evidence.add",
    projectId,
    commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("parent-assessment-evidence"),
    evidence,
    addedAt: at,
  });
  const assessment = {
    criterionId: criterion.criterionId,
    expectedRevision: criterion.revision,
    verdict: "met" as const,
    detail: "Explicit pending assessment of the original criterion",
    evidenceIds: [evidence.evidenceId],
  };
  return { ...f, criterion, parentEvidence: evidence, assessment };
});

it.effect(
  "criterion assessment lookup bounds aggregate identity reads while preserving snapshots",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const original = yield* f.state();
        const prepared = f.target.prepared.manifest;
        const target = {
          projectId: prepared.projectId,
          taskId: prepared.taskId,
          specRevision: prepared.specRevision,
          planRevision: prepared.planRevision,
          baseSha: prepared.target.baseSha,
          headSha: prepared.target.headSha,
        };
        const plan = original.foundationRecords?.find(
          (record) =>
            record.kind === "plan-revision" &&
            record.taskId === target.taskId &&
            record.planRevision === target.planRevision,
        );
        if (plan?.kind !== "plan-revision") return yield* Effect.die("Missing parent plan");
        // This synthetic aggregate exercises the actual helper's bounded work; it grants no reviewer custody or admission.
        const selectedCriteria = Array.from({ length: 64 }, (_, index) => ({
          ...f.criterion,
          criterionId: ProjectWorkCriterionId.make("lookup-criterion-" + index),
        }));
        const criteria = [
          ...selectedCriteria,
          ...Array.from({ length: 10000 }, (_, index) => ({
            ...f.criterion,
            taskId: f.running.taskId,
            criterionId: ProjectWorkCriterionId.make("lookup-unrelated-criterion-" + index),
          })),
        ];
        const state = { ...original, criteria, evidence: [] };
        const scopeHash = projectTeamScopeHash(state, target.taskId, plan);
        const { criterionId: _criterionId, ...unassigned } = f.parentEvidence;
        const useful = Array.from({ length: 20 }, (_, index) => ({
          ...unassigned,
          evidenceId: ProjectWorkEvidenceId.make("lookup-evidence-" + index),
          scopeHash,
        }));
        const evidence = [
          ...useful,
          ...Array.from({ length: 50000 - useful.length }, (_, index) => ({
            ...unassigned,
            taskId: f.running.taskId,
            evidenceId: ProjectWorkEvidenceId.make("lookup-unrelated-evidence-" + index),
          })),
        ];
        const selected = selectedCriteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          revision: criterion.revision,
        }));
        const evidenceIds = useful.map((entry) => entry.evidenceId);
        const assessments = selectedCriteria.map((criterion) => ({
          ...f.assessment,
          criterionId: criterion.criterionId,
          evidenceIds,
        }));
        const expectedEvidence = useful.map((entry) => ({
          id: entry.evidenceId,
          taskId: target.taskId,
          revision: entry.revision,
          scopeHash,
          sha256: digest(canonical(entry)),
        }));
        const expectedCriteria = selectedCriteria.map((criterion) => ({
          id: criterion.criterionId,
          revision: criterion.revision,
          sha256: digest(canonical(criterion)),
        }));
        let evidenceReads = 0;
        let criterionReads = 0;
        let selectedReads = 0;
        for (const entry of evidence) {
          const id = entry.evidenceId;
          Object.defineProperty(entry, "evidenceId", {
            enumerable: true,
            get: () => {
              evidenceReads++;
              return id;
            },
          });
        }
        for (const criterion of criteria) {
          const id = criterion.criterionId;
          Object.defineProperty(criterion, "criterionId", {
            enumerable: true,
            get: () => {
              criterionReads++;
              return id;
            },
          });
        }
        for (const criterion of selected) {
          const id = criterion.criterionId;
          Object.defineProperty(criterion, "criterionId", {
            enumerable: true,
            get: () => {
              selectedReads++;
              return id;
            },
          });
        }
        const snapshots = yield* snapshotReviewCriterionAssessments({
          state: { ...state, evidence },
          target,
          prepared: { ...prepared, criteria: selected },
          assessments,
        });
        expect(snapshots?.length).toBe(64);
        expect(snapshots?.map((snapshot) => snapshot.criterion)).toEqual(expectedCriteria);
        expect(snapshots?.map((snapshot) => snapshot.evidence)).toEqual(
          selectedCriteria.map(() => expectedEvidence),
        );
        expect(
          Buffer.byteLength(
            canonical({ ...f.completionReport, criterionAssessments: assessments }),
            "utf8",
          ),
        ).toBeLessThan(131072);
        expect(Buffer.byteLength(canonical({ assessments, snapshots }), "utf8")).toBeLessThan(
          524288 - 32768,
        );
        const references = assessments.length * evidenceIds.length;
        // Generous linear ceilings allow decoding/hash accesses and expose repeated aggregate scans without timing assumptions.
        expect(evidenceReads).toBeLessThanOrEqual(2 * evidence.length + 16 * references);
        expect(criterionReads).toBeLessThanOrEqual(4 * criteria.length + 16 * assessments.length);
        expect(selectedReads).toBeLessThanOrEqual(2 * selected.length + 16 * assessments.length);
      }),
    ),
);

it.effect("criterion assessment lookup denies global evidence ambiguity from a foreign task", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* parentAssessmentFixture;
      const before = yield* f.state();
      const foreign = { ...f.parentEvidence, taskId: f.running.taskId };
      // Disposable checkpoint corruption supplies a foreign duplicate; it is not a production evidence mutation path.
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_insert(state_json,'$.evidence[#]',json(${canonical(foreign)})) WHERE project_id=${projectId}`;
      const corrupted = yield* f.state();
      const report = {
        ...f.completionReport,
        expectedRevision: before.revision,
        criterionAssessments: [f.assessment],
      };
      expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* readProposal(f)).toBeUndefined();
      expect(yield* f.state()).toEqual(corrupted);
      expect(
        yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${report.commandId}`,
      ).toEqual([{ count: 0 }]);
    }),
  ),
);

it.effect(
  "pending criterion assessment retains exact parent snapshots without accepting work",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        yield* completionTool(f, report);
        const retained = yield* readProposal(f);
        expect(retained?.manifest).toMatchObject({
          report,
          criterionAssessments: [
            {
              assessmentSha256: digest(canonical(f.assessment)),
              projectId,
              taskId: f.selection.taskId,
              criterion: {
                id: f.criterion.criterionId,
                revision: f.criterion.revision,
                sha256: digest(canonical(f.criterion)),
              },
              evidence: [
                {
                  id: f.parentEvidence.evidenceId,
                  taskId: f.selection.taskId,
                  revision: 0,
                  sha256: digest(canonical(f.parentEvidence)),
                },
              ],
            },
          ],
        });
        expect(yield* f.state()).toEqual(before);
        yield* completionTool(f, report);
        expect(yield* readProposal(f)).toEqual(retained);
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "pending criterion assessment denies met with an open critical target finding but retains not-met",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        yield* f.repository.execute(yield* f.compile(yield* f.report({ severity: "critical" })));
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        const negative = {
          ...report,
          criterionAssessments: [{ ...f.assessment, verdict: "not-met" as const, evidenceIds: [] }],
        };
        yield* completionTool(f, negative);
        expect((yield* readProposal(f))?.manifest.report).toEqual(negative);
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

for (const invalid of [
  "child-criterion",
  "revision",
  "missing-evidence",
  "duplicate-criterion",
  "duplicate-evidence",
  "empty-met",
  "overflow",
  "secret",
] as const) {
  it.effect(`pending criterion assessment denies ${invalid} without retaining a proposal`, () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const before = yield* f.state();
        const childCriterion = before.criteria.find((c) => c.taskId === f.running.taskId);
        if (!childCriterion) return yield* Effect.die("Missing child criterion");
        const assessment =
          invalid === "child-criterion"
            ? { ...f.assessment, criterionId: childCriterion.criterionId }
            : invalid === "revision"
              ? { ...f.assessment, expectedRevision: f.assessment.expectedRevision + 1 }
              : invalid === "missing-evidence"
                ? { ...f.assessment, evidenceIds: ["missing"] }
                : invalid === "duplicate-evidence"
                  ? {
                      ...f.assessment,
                      evidenceIds: [...f.assessment.evidenceIds, ...f.assessment.evidenceIds],
                    }
                  : invalid === "empty-met"
                    ? { ...f.assessment, evidenceIds: [] }
                    : invalid === "overflow"
                      ? { ...f.assessment, detail: "界".repeat(45000) }
                      : invalid === "secret"
                        ? {
                            ...f.assessment,
                            detail: "Authorization: Bearer sk-proj-" + "a".repeat(80),
                          }
                        : f.assessment;
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments:
            invalid === "duplicate-criterion" ? [assessment, assessment] : [assessment],
        };
        expect((yield* completionTool(f, report).pipe(Effect.exit))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${report.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
  );
}

for (const drift of ["task", "criterion", "scope", "detail", "revision"] as const) {
  it.effect(
    `pending criterion assessment denies ${drift} evidence drift without refreshing its first snapshot`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* parentAssessmentFixture;
          const before = yield* f.state();
          const report = {
            ...f.completionReport,
            expectedRevision: before.revision,
            criterionAssessments: [f.assessment],
          };
          yield* completionTool(f, report);
          const retained = yield* readProposal(f);
          const index = before.evidence.findIndex(
            (e) => e.evidenceId === f.parentEvidence.evidenceId,
          );
          const field =
            drift === "task"
              ? "taskId"
              : drift === "criterion"
                ? "criterionId"
                : drift === "scope"
                  ? "scopeHash"
                  : drift;
          const value = drift === "revision" ? 1 : "changed";
          // Disposable checkpoint corruption tests changed persisted metadata; it grants no production mutation authority.
          yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${"$.evidence[" + index + "]." + field},${value}) WHERE project_id=${projectId}`;
          expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* readProposal(f)).toEqual(retained);
          expect(
            yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${report.commandId}`,
          ).toEqual([{ count: 1 }]);
        }),
      ),
  );
}

it.effect("pending criterion assessment preserves unassigned parent evidence compatibility", () =>
  scopedGateway(
    Effect.gen(function* () {
      const f = yield* parentAssessmentFixture;
      const before = yield* f.state();
      const index = before.evidence.findIndex((e) => e.evidenceId === f.parentEvidence.evidenceId);
      // The disposable checkpoint supplies a real scoped parent observation without a criterion-specific assignment.
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_remove(state_json,${"$.evidence[" + index + "].criterionId"}) WHERE project_id=${projectId}`;
      const report = {
        ...f.completionReport,
        expectedRevision: before.revision,
        criterionAssessments: [f.assessment],
      };
      yield* completionTool(f, report);
      const retained = yield* readProposal(f);
      expect(retained?.manifest.criterionAssessments?.[0]?.evidence[0]).not.toHaveProperty(
        "criterionId",
      );
      expect(yield* f.state()).toEqual({
        ...before,
        evidence: before.evidence.map((entry, position) => {
          if (position !== index) return entry;
          const { criterionId: _criterion, ...unassigned } = entry;
          return unassigned;
        }),
      });
    }),
  ),
);

it.effect(
  "pending criterion assessment preserves an explicit empty list without inferring acceptance",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        const report = { ...f.completionReport, criterionAssessments: [] };
        yield* completionTool(f, report);
        expect((yield* readProposal(f))?.manifest).toMatchObject({
          report,
          criterionAssessments: [],
        });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "pending criterion assessment requires the captured SQL transaction and original host context",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        const compile = () => f.proposals.compile(f.principal, report, f.reportAttribution);
        expect(
          (yield* compile().pipe(
            Effect.provideService(ProjectTeamReviewReportOperation, f.operation),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect((yield* f.sql.withTransaction(compile()).pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              compile().pipe(
                Effect.provideService(ProjectTeamReviewReportOperation, f.operation),
                Effect.updateContext((context: Context.Context<never>) =>
                  Context.omit(SqlClient.SqlClient)(context),
                ),
              ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(
              compile().pipe(
                Effect.provideService(ProjectTeamReviewReportOperation, {
                  ...f.operation,
                  workerId: "foreign-worker",
                }),
              ),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "pending criterion assessment duplicate validation rejects sensitive retained detail even with coherent hashes",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        yield* completionTool(f, report);
        const retained = yield* readProposal(f);
        const snapshot = retained?.manifest.criterionAssessments?.[0];
        if (!retained || !snapshot) return yield* Effect.die("Missing assessment snapshot");
        const assessment = {
          ...f.assessment,
          detail: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        };
        const sensitive = { ...report, criterionAssessments: [assessment] };
        const manifest = {
          ...retained.manifest,
          report: sensitive,
          criterionAssessments: [{ ...snapshot, assessmentSha256: digest(canonical(assessment)) }],
        };
        const json = canonical(manifest);
        // Only disposable corruption bypasses immutability; coherent hashes are not a content-safety grant.
        yield* f.sql`DROP TRIGGER project_team_review_completion_proposal_immutable`;
        yield* f.sql`UPDATE project_team_review_completion_proposal SET manifest_json=${json},sha256=${digest(json)}`;
        expect((yield* readProposal(f))?.manifest).toEqual(manifest);
        expect(
          (yield* f.sql
            .withTransaction(
              f.proposals
                .validate(f.principal, sensitive, f.reportAttribution, { duplicate: true })
                .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${report.commandId}`,
        ).toEqual([{ count: 1 }]);
      }),
    ),
);

it.effect(
  "pending criterion assessment captures caller input before awaiting original authority and exact retry survives unrelated revision",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const auth = yield* ProjectTeamAuthorization;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const proposals = yield* makeProjectTeamReviewCompletionProposals((principal) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* auth.resolve(principal);
          }),
        );
        const before = yield* f.state();
        const assessment = { ...f.assessment, evidenceIds: [...f.assessment.evidenceIds] };
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [assessment],
        };
        const original = structuredClone(report);
        const pending = proposals.compile(f.principal, report, f.reportAttribution);
        const fiber = yield* f.sql
          .withTransaction(
            pending.pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assessment.detail = "Changed after the first await";
        assessment.evidenceIds[0] = ProjectWorkEvidenceId.make("foreign-after-await");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        const retained = yield* readProposal(f);
        expect(retained?.manifest.report).toEqual(original);
        expect(yield* f.state()).toEqual(before);
        yield* f.repository.execute({
          type: "project-work.task.create",
          projectId,
          taskId: ProjectTeamReviewFindingIntent.fields.taskId.make("assessment-unrelated"),
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make(
            "assessment-unrelated-create",
          ),
          title: "Unrelated work",
          createdAt: at,
        });
        yield* f.sql.withTransaction(
          f.proposals
            .compile(f.principal, original, f.reportAttribution)
            .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
        );
        expect(yield* readProposal(f)).toEqual(retained);
        expect(
          (yield* f.sql
            .withTransaction(
              f.proposals
                .compile(f.principal, report, f.reportAttribution)
                .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);

for (const contradiction of [
  "missing",
  "report-detail",
  "parent",
  "target",
  "criterion",
  "revision",
  "evidence",
  "evidence-owner",
  "evidence-criterion",
  "evidence-scope",
] as const) {
  it.effect(
    `pending criterion assessment retained reader denies ${contradiction} intrinsic contradiction`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* parentAssessmentFixture;
          const before = yield* f.state();
          const report = {
            ...f.completionReport,
            expectedRevision: before.revision,
            criterionAssessments: [f.assessment],
          };
          yield* completionTool(f, report);
          const retained = yield* readProposal(f);
          const snapshot = retained?.manifest.criterionAssessments?.[0];
          const evidence = snapshot?.evidence[0];
          if (!retained || !snapshot || !evidence)
            return yield* Effect.die("Missing retained assessment");
          const changed =
            contradiction === "parent"
              ? { ...snapshot, taskId: "foreign" }
              : contradiction === "target"
                ? { ...snapshot, target: { ...snapshot.target, headSha: "foreign" } }
                : contradiction === "criterion"
                  ? { ...snapshot, criterion: { ...snapshot.criterion, id: "foreign" } }
                  : contradiction === "revision"
                    ? {
                        ...snapshot,
                        criterion: {
                          ...snapshot.criterion,
                          revision: snapshot.criterion.revision + 1,
                        },
                      }
                    : contradiction === "evidence"
                      ? { ...snapshot, evidence: [{ ...evidence, id: "foreign" }] }
                      : contradiction === "evidence-owner"
                        ? { ...snapshot, evidence: [{ ...evidence, taskId: "foreign" }] }
                        : contradiction === "evidence-criterion"
                          ? { ...snapshot, evidence: [{ ...evidence, criterionId: "foreign" }] }
                          : contradiction === "evidence-scope"
                            ? { ...snapshot, evidence: [{ ...evidence, scopeHash: "foreign" }] }
                            : snapshot;
          const manifest = {
            ...retained.manifest,
            ...(contradiction === "report-detail"
              ? {
                  report: {
                    ...report,
                    criterionAssessments: [
                      { ...f.assessment, detail: "Different persisted judgment" },
                    ],
                  },
                }
              : {}),
            criterionAssessments: contradiction === "missing" ? [] : [changed],
          };
          const json = canonical(manifest);
          // Deliberately bypass only immutability in disposable SQL; recomputed whole-manifest hash must not hide contradictory linkage.
          yield* f.sql`DROP TRIGGER project_team_review_completion_proposal_immutable`;
          yield* f.sql`UPDATE project_team_review_completion_proposal SET manifest_json=${json},sha256=${digest(json)}`;
          expect((yield* readProposal(f).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.state()).toEqual(before);
        }),
      ),
  );
}

it.effect(
  "actual report tool commits only a pending proposal and zero-event receipt; exact retry survives unrelated project revision",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        yield* completionTool(f);
        expect(yield* f.state()).toEqual(before);
        const retained = yield* readProposal(f);
        expect(retained?.manifest.findings).toEqual([]);
        expect(
          yield* f.sql`SELECT event_ids_json AS ids FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${f.completionReport.commandId}`,
        ).toEqual([{ ids: "[]" }]);
        yield* f.repository.execute({
          type: "project-work.task.create",
          projectId,
          taskId: ProjectTeamReviewFindingIntent.fields.taskId.make("unrelated-task"),
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("unrelated-create"),
          title: "Unrelated work",
          createdAt: at,
        });
        const moved = yield* f.state();
        yield* TestClock.setTime(Date.parse(at) + 2);
        yield* completionTool(f);
        expect(yield* f.state()).toEqual(moved);
        expect(yield* readProposal(f)).toEqual(retained);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 1 }]);
      }),
    ),
);

it.effect(
  "live validation never retains a proposal, including a duplicate marker without an original receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.sql.withTransaction(
          f.proposals
            .validate(f.principal, f.completionReport, f.reportAttribution, { duplicate: false })
            .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
        );
        expect(yield* readProposal(f)).toBeUndefined();
        expect(
          (yield* f.sql
            .withTransaction(
              f.proposals
                .validate(f.principal, f.completionReport, f.reportAttribution, { duplicate: true })
                .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
      }),
    ),
);

for (const change of [
  "absent",
  "human",
  "foreign-environment",
  "foreign-worker",
  "later-prompt",
  "compact",
  "extra-host-field",
] as const) {
  it.effect(
    `pending completion denies ${change} host custody without proposal, receipt or domain changes`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* proposalFixture;
          const before = yield* f.state();
          const operation = {
            ...f.operation,
            ...(change === "foreign-environment" ? { environmentId: "foreign" } : {}),
            ...(change === "foreign-worker" ? { workerId: "another-worker" } : {}),
            ...(change === "later-prompt" ? { operationId: "later-prompt", ordinal: 2 } : {}),
          };
          // Deliberately corrupt only disposable private-context data, retaining its declared host type.
          if (change === "compact")
            Object.defineProperty(operation, "operationKind", { value: "compact" });
          if (change === "extra-host-field")
            Object.defineProperty(operation, "callerSuppliedReceipt", {
              value: "untrusted",
              enumerable: true,
            });
          const gateway = yield* ProjectWorkGateway;
          const principal =
            change === "human" ? { actor: { kind: "human" as const, id: "human" } } : f.principal;
          const effect = gateway.write(
            f.completionReport,
            principal.actor,
            f.reportAttribution.source,
            principal,
          );
          const guarded =
            change === "absent"
              ? effect.pipe(
                  Effect.updateContext((context: Context.Context<never>) =>
                    Context.omit(ProjectTeamReviewReportOperation)(context),
                  ),
                )
              : effect.pipe(Effect.provideService(ProjectTeamReviewReportOperation, operation));
          expect((yield* guarded.pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* readProposal(f)).toBeUndefined();
          expect(yield* f.state()).toEqual(before);
          expect(
            yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
          ).toEqual([{ count: 0 }]);
        }),
      ),
  );
}

it.effect(
  "a secret-bearing completion report is rejected before any private proposal or public receipt is retained",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          summary: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        };
        expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${report.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
);

it.effect(
  "generic managed review completion remains denied even with report outputs and a retained pending proposal",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const before = yield* f.state();
        const command = decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: f.completionReport.commandId,
          expectedRevision: f.completionReport.expectedRevision,
          attribution: f.reportAttribution,
          committedAt: at,
          records: [],
          guided: {
            intent: f.completionReport,
            bindingId: f.running.recordId,
            generation: f.running.generation,
          },
        });
        expect((yield* f.repository.execute(command).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "pending proposals accept retained nested systemd custody and reject path traversal",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const unit = f.allocation.unit + "-assignment";
        const nested = {
          ...f.owner,
          unit,
          cgroup: "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/" + unit,
        };
        yield* f.sql`UPDATE project_team_pi_process SET owner_json=${canonical(nested)} WHERE operation_id='review-assignment'`;
        yield* f.compileProposal();
        const retained = yield* readProposal(f);
        expect(retained).toBeDefined();
        yield* f.sql`UPDATE project_team_pi_process SET owner_json=${canonical({ ...nested, cgroup: "/sys/fs/cgroup/user.slice/../" + unit })} WHERE operation_id='review-assignment'`;
        expect((yield* f.compileProposal().pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toEqual(retained);
      }),
    ),
);

it.effect(
  "public authorization rejects foreign SQL and a missing original caller transaction for completion",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const auth = yield* ProjectTeamAuthorization;
        const action = auth
          .guided(f.principal, f.completionReport, f.reportAttribution, false)
          .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation));
        expect((yield* action.pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* f.sql
            .withTransaction(action.pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
      }),
    ),
);

it.effect(
  "proposal inputs and private host context are captured before an awaited real authority read",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const auth = yield* ProjectTeamAuthorization;
        const entered = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const proposals = yield* makeProjectTeamReviewCompletionProposals((principal) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(proceed);
            return yield* auth.resolve(principal);
          }),
        );
        const principal = { ...f.principal, managed: { ...f.principal.managed } };
        const report = {
          ...f.completionReport,
          outputs: (f.completionReport.outputs ?? []).map((output) => ({ ...output })),
        };
        const attribution = { ...f.reportAttribution, source: { ...f.reportAttribution.source } };
        const operation = { ...f.operation };
        const original = structuredClone({ report, attribution, operation });
        const action = proposals.compile(principal, report, attribution);
        report.summary = "Changed before the effect even starts";
        const running = yield* Effect.forkChild(
          f.sql.withTransaction(
            action.pipe(Effect.provideService(ProjectTeamReviewReportOperation, operation)),
          ),
        );
        yield* Deferred.await(entered);
        operation.workerId = "retargeted-worker";
        operation.operationId = "replacement-prompt";
        principal.managed.threadId = ThreadId.make("retargeted-thread");
        attribution.source.id = "retargeted-source";
        report.outputs[0]!.detail = "Changed after ownership capture";
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(running);
        const receipt = yield* readProposal(f);
        expect(receipt?.manifest.report).toEqual(original.report);
        expect(receipt?.manifest.attribution).toEqual(original.attribution);
        expect(receipt?.manifest.operation).toEqual(original.operation);
      }),
    ),
);

it.effect(
  "a retained original proposal forbids a changed report or a second command for the same assignment",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const first = yield* readProposal(f);
        const before = yield* f.state();
        for (const report of [
          { ...f.completionReport, summary: "A materially changed report" },
          {
            ...f.completionReport,
            commandId: ProjectTeamReviewFindingIntent.fields.commandId.make(
              "second-completion-command",
            ),
          },
        ]) {
          expect(
            (yield* f.sql
              .withTransaction(
                f.proposals
                  .compile(f.principal, report, f.reportAttribution)
                  .pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(yield* readProposal(f)).toEqual(first);
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_team_review_completion_proposal`,
        ).toEqual([{ count: 1 }]);
      }),
    ),
);

it.effect(
  "pending proposal replay denies new parent findings and preserves its original empty finding snapshot",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* completionTool(f);
        const original = yield* readProposal(f);
        yield* reportTool(f, yield* f.report());
        const changed = yield* f.state();
        expect((yield* completionTool(f).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(changed);
        expect(yield* readProposal(f)).toEqual(original);
        expect(original?.manifest.findings).toEqual([]);
      }),
    ),
);

it.effect(
  "pending proposal replay denies a same-content required child criterion revision change",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* completionTool(f);
        const original = yield* readProposal(f);
        const before = yield* f.state();
        const criterion = before.criteria.find((c) => c.taskId === f.running.taskId)!;
        const index = before.criteria.findIndex((c) => c.criterionId === criterion.criterionId);
        // Disposable derived-checkpoint corruption tests changed criterion metadata; raw managed writes stay denied.
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${"$.criteria[" + index + "].revision"},${criterion.revision + 1}) WHERE project_id=${projectId}`;
        const changed = yield* f.state();
        expect(changed.tasks.find((t) => t.taskId === f.running.taskId)?.revision).toBe(
          before.tasks.find((t) => t.taskId === f.running.taskId)?.revision,
        );
        expect((yield* completionTool(f).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toEqual(original);
        expect(yield* f.state()).toEqual(changed);
      }),
    ),
);

it.effect(
  "proposal replay denies referenced evidence detail drift without refreshing the retained evidence snapshot",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const scopeHash = f.running.scopeHash;
        if (scopeHash === undefined) return yield* Effect.die("Missing reviewer evidence scope");
        const evidence = {
          evidenceId: ProjectWorkEvidenceId.make("review-supporting-evidence"),
          taskId: f.running.taskId,
          kind: "observation" as const,
          summary: "Retained supporting review note",
          detail: "Original retained detail",
          recordedAt: at,
          revision: 0,
          attribution: f.reportAttribution,
          scopeHash,
        };
        yield* f.repository.execute({
          type: "project-work.evidence.add",
          projectId,
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("retain-review-note"),
          evidence,
          addedAt: at,
        });
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          evidenceIds: [evidence.evidenceId],
        };
        yield* completionTool(f, report);
        const original = yield* readProposal(f);
        const index = before.evidence.findIndex((e) => e.evidenceId === evidence.evidenceId);
        // Disposable derived-checkpoint corruption represents changed retained evidence metadata.
        yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${"$.evidence[" + index + "].detail"},'Changed retained detail',${"$.evidence[" + index + "].revision"},1) WHERE project_id=${projectId}`;
        expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toEqual(original);
      }),
    ),
);

it.effect(
  "real final authorization revocation rolls back proposal retention and the accepted zero-event receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const auth = yield* ProjectTeamAuthorization;
        const before = yield* f.state();
        const result = yield* f.repository
          .executeAtomic(
            auth.guided(f.principal, f.completionReport, f.reportAttribution, false).pipe(
              Effect.provideService(ProjectTeamReviewReportOperation, f.operation),
              Effect.map((command) => [command]),
            ),
            Effect.gen(function* () {
              yield* restoreHistoricalBinding(
                decodeRecord({
                  ...f.reviewRole,
                  status: "retired",
                  revision: f.reviewRole.revision + 1,
                }),
              );
              yield* auth.guided(
                f.principal,
                f.completionReport,
                f.reportAttribution,
                true,
                "validate",
              );
            }).pipe(Effect.provideService(ProjectTeamReviewReportOperation, f.operation)),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
);

it.effect(
  "pending criterion assessment insertion failure rolls back the public receipt and leaves exact retry available",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const before = yield* f.state();
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        yield* f.sql`CREATE TRIGGER reject_pending_proposal BEFORE INSERT ON project_team_review_completion_proposal BEGIN SELECT RAISE(ABORT,'controlled proposal storage failure'); END`;
        expect((yield* completionTool(f, report).pipe(Effect.exit))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 0 }]);
        yield* f.sql`DROP TRIGGER reject_pending_proposal`;
        yield* completionTool(f, report);
        expect(yield* readProposal(f)).toBeDefined();
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "pending criterion assessment failed owning COMMIT exposes no successful receipt or public state",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const gateway = yield* ProjectWorkGateway;
        const query = yield* ProjectWorkQuery;
        const before = yield* f.state();
        const beforeSnapshot = yield* query.snapshot(projectId);
        const beforeFindings = decodePage(
          yield* gateway.read({
            projectId,
            operation: "foundation-records",
            recordKinds: ["review-finding"],
          }),
        ).items;
        const report = {
          ...f.completionReport,
          expectedRevision: before.revision,
          criterionAssessments: [f.assessment],
        };
        yield* f.sql`CREATE TABLE proposal_commit_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE proposal_commit_child(id TEXT REFERENCES proposal_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER proposal_commit_failure AFTER INSERT ON project_team_review_completion_proposal BEGIN INSERT INTO proposal_commit_child VALUES ('missing'); END`;
        let escaped = false;
        expect(
          (yield* completionTool(f, report).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM proposal_commit_child`).toEqual([
          { count: 0 },
        ]);
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
        expect(
          decodePage(
            yield* gateway.read({
              projectId,
              operation: "foundation-records",
              recordKinds: ["review-finding"],
            }),
          ).items,
        ).toEqual(beforeFindings);
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 0 }]);
        yield* f.sql`DROP TRIGGER proposal_commit_failure`;
        yield* completionTool(f, report);
        expect(yield* readProposal(f)).toBeDefined();
      }),
    ),
);

it.effect(
  "pending proposal captures the exact original parent finding revision and denies its later update",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* reportTool(f, yield* f.report());
        const before = yield* f.state();
        const finding = before.foundationRecords?.find((r) => r.kind === "review-finding");
        if (finding?.kind !== "review-finding")
          return yield* Effect.die("Missing retained parent finding");
        const report = { ...f.completionReport, expectedRevision: before.revision };
        yield* completionTool(f, report);
        const retained = yield* readProposal(f);
        expect(retained?.manifest.findings).toEqual([
          {
            findingId: finding.findingId,
            revision: finding.revision,
            sha256: digest(canonical(finding)),
          },
        ]);
        yield* reportTool(
          f,
          yield* f.report({
            commandId:
              ProjectTeamReviewFindingIntent.fields.commandId.make("finding-after-pending"),
            revision: 1,
            detail: "A refined original finding",
          }),
        );
        const changed = yield* f.state();
        expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toEqual(retained);
        expect(yield* f.state()).toEqual(changed);
      }),
    ),
);

for (const status of ["prepared", "starting", "settled", "quarantine"] as const) {
  it.effect(`pending completion denies an original prompt with ${status} custody`, () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        yield* f.sql`UPDATE project_team_pi_operation SET status=${status} WHERE operation_id='review-assignment'`;
        expect((yield* completionTool(f).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
  );
}

it.effect(
  "required review output coverage and unique current output identities are mandatory",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        const outputs = f.completionReport.outputs ?? [];
        expect(outputs.length).toBeGreaterThan(0);
        for (const report of [
          { ...f.completionReport, outputs: [] },
          { ...f.completionReport, outputs: [...outputs, outputs[0]!] },
          {
            ...f.completionReport,
            outputs: [
              { ...outputs[0]!, criterionId: ProjectWorkCriterionId.make("foreign-criterion") },
            ],
          },
        ]) {
          expect((yield* completionTool(f, report).pipe(Effect.result))._tag).toBe("Failure");
        }
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect("retained pending proposal SQL rows cannot be updated or deleted", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* proposalFixture;
      yield* f.compileProposal();
      const original = yield* readProposal(f);
      expect(
        (yield* f.sql`UPDATE project_team_review_completion_proposal SET sha256=${"a".repeat(64)}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql`DELETE FROM project_team_review_completion_proposal`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(yield* readProposal(f)).toEqual(original);
    }),
  ),
);

for (const corruption of ["noncanonical", "hash", "identity", "oversized"] as const) {
  it.effect(`retained pending proposal denies ${corruption} stored manifest corruption`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const original = yield* readProposal(f);
        if (!original) return yield* Effect.die("Missing proposal");
        // Only this disposable corruption control bypasses the immutable row and physical size checks.
        yield* f.sql`DROP TRIGGER project_team_review_completion_proposal_immutable`;
        yield* f.sql`PRAGMA ignore_check_constraints=ON`;
        const changed =
          corruption === "identity"
            ? {
                ...original.manifest,
                operation: { ...original.manifest.operation, bindingId: "foreign-binding" },
              }
            : original.manifest;
        const json =
          corruption === "noncanonical"
            ? " " + canonical(changed)
            : corruption === "oversized"
              ? " ".repeat(524289)
              : canonical(changed);
        yield* f.sql`UPDATE project_team_review_completion_proposal SET manifest_json=${json},sha256=${corruption === "hash" ? "a".repeat(64) : digest(json)}`;
        expect((yield* readProposal(f).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );
}

const isProposalReadError = Schema.is(ProjectTeamReviewCompletionProposalError);
const retainedIdentityContradictions: Array<{
  name: string;
  change: (
    manifest: ProjectTeamReviewCompletionProposalManifest,
  ) => ProjectTeamReviewCompletionProposalManifest;
}> = [
  {
    name: "operation-project",
    change: (m) => ({ ...m, operation: { ...m.operation, projectId: "foreign-project" } }),
  },
  {
    name: "target-project",
    change: (m) => ({
      ...m,
      target: {
        ...m.target,
        projectId: ProjectTeamReviewFindingIntent.fields.projectId.make("foreign-project"),
      },
    }),
  },
  {
    name: "membership-project",
    change: (m) => ({
      ...m,
      assignment: {
        ...m.assignment,
        projectId: ProjectTeamReviewFindingIntent.fields.projectId.make("foreign-project"),
      },
    }),
  },
  {
    name: "report-child",
    change: (m) => ({
      ...m,
      report: {
        ...m.report,
        taskId: ProjectTeamReviewFindingIntent.fields.taskId.make("foreign-child"),
      },
    }),
  },
  {
    name: "provenance-child",
    change: (m) => ({
      ...m,
      provenance: {
        ...m.provenance,
        reviewTaskId: ProjectTeamReviewFindingIntent.fields.taskId.make("foreign-child"),
      },
    }),
  },
  {
    name: "membership-child",
    change: (m) => ({
      ...m,
      assignment: {
        ...m.assignment,
        taskId: ProjectTeamReviewFindingIntent.fields.taskId.make("foreign-child"),
      },
    }),
  },
  {
    name: "provenance-binding",
    change: (m) => ({ ...m, provenance: { ...m.provenance, bindingId: "foreign-binding" } }),
  },
  {
    name: "provenance-generation",
    change: (m) => ({
      ...m,
      provenance: { ...m.provenance, generation: m.operation.generation + 1 },
    }),
  },
  {
    name: "membership-parent",
    change: (m) => ({
      ...m,
      assignment: {
        ...m.assignment,
        parentTaskId: ProjectTeamReviewFindingIntent.fields.taskId.make("foreign-parent"),
      },
    }),
  },
  {
    name: "membership-record",
    change: (m) => ({ ...m, assignment: { ...m.assignment, recordId: "foreign-membership" } }),
  },
  {
    name: "report-membership",
    change: (m) => ({ ...m, report: { ...m.report, assignmentId: "foreign-membership" } }),
  },
  {
    name: "membership-revision",
    change: (m) =>
      m.report.type === "project-team.assignment.report"
        ? {
            ...m,
            assignment: { ...m.assignment, revision: m.report.expectedAssignmentRevision + 1 },
          }
        : m,
  },
  {
    name: "report-membership-revision",
    change: (m) => ({
      ...m,
      report: { ...m.report, expectedAssignmentRevision: m.assignment.revision + 1 },
    }),
  },
  {
    name: "provenance-provider",
    change: (m) => ({
      ...m,
      provenance: {
        ...m.provenance,
        providerInstanceId:
          ProjectTeamReviewFindingProvenance.fields.providerInstanceId.make("foreign-provider"),
      },
    }),
  },
  {
    name: "provenance-thread",
    change: (m) => ({
      ...m,
      provenance: { ...m.provenance, threadId: ThreadId.make("foreign-thread") },
    }),
  },
  {
    name: "provenance-initialize",
    change: (m) => ({
      ...m,
      provenance: { ...m.provenance, initializeOperationId: "foreign-initialize" },
    }),
  },
  {
    name: "freshness-initialize",
    change: (m) => ({
      ...m,
      freshness: { ...m.freshness, initializeOperationId: "foreign-initialize" },
    }),
  },
];

for (const contradiction of retainedIdentityContradictions) {
  it.effect(`R1 retained reader denies rehashed ${contradiction.name} contradiction`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const original = yield* readProposal(f);
        if (!original) return yield* Effect.die("Missing original proposal");
        const before = yield* f.state();
        const json = canonical(contradiction.change(original.manifest));
        // Bypass only UPDATE immutability in this disposable corruption control; retain real FK and namespace bindings.
        yield* f.sql`DROP TRIGGER project_team_review_completion_proposal_immutable`;
        yield* f.sql`UPDATE project_team_review_completion_proposal SET manifest_json=${json},sha256=${digest(json)}`;
        const result = yield* readProposal(f).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(isProposalReadError(result.failure)).toBe(true);
        expect(yield* f.state()).toEqual(before);
        expect(yield* f.sql`SELECT sha256 FROM project_team_review_completion_proposal`).toEqual([
          { sha256: digest(json) },
        ]);
      }),
    ),
  );
}

it.effect(
  "R1 intrinsic reader permits distinct parent-child revisions and membership-binding generations without granting live authority",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        yield* f.compileProposal();
        const original = yield* readProposal(f);
        if (!original) return yield* Effect.die("Missing original proposal");
        if (original.manifest.report.type !== "project-team.assignment.report")
          return yield* Effect.die("Original proposal must retain an assignment report");
        expect(original.manifest.provenance.targetSha256).not.toBe(
          digest(canonical(original.manifest.target)),
        );
        const before = yield* f.state();
        // This retained-reader compatibility fixture changes only independent metadata; it is not an authenticated producer proof for the new scope.
        const manifest = {
          ...original.manifest,
          target: {
            ...original.manifest.target,
            specRevision: original.manifest.report.specRevision + 3,
            planRevision: original.manifest.report.planRevision + 5,
          },
          assignment: {
            ...original.manifest.assignment,
            generation: original.manifest.operation.generation + 7,
          },
        };
        const json = canonical(manifest);
        yield* f.sql`DROP TRIGGER project_team_review_completion_proposal_immutable`;
        yield* f.sql`UPDATE project_team_review_completion_proposal SET manifest_json=${json},sha256=${digest(json)}`;
        expect((yield* readProposal(f))?.manifest).toEqual(manifest);
        expect((yield* f.compileProposal().pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "actual successful verification artifacts and an independent Pi resolution report retain one resolution receipt",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeFindingFixture(true, "success");
        const resultRows = yield* f.sql<{
          attemptId: string;
        }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${f.prepared.manifest.jobId}`;
        expect(resultRows).toHaveLength(1);
        const intent = yield* f.report({
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("é".repeat(256)),
          status: "resolved",
          resolutionArtifactIds: [
            resultRows[0]!.attemptId + ":stdout",
            resultRows[0]!.attemptId + ":stderr",
          ],
        });
        const before = yield* f.state();
        const firstWrite = yield* reportTool(f, intent).pipe(Effect.result);
        expect(firstWrite, "first actual resolution write").toMatchObject({ _tag: "Success" });
        const after = yield* f.state();
        const finding = after.foundationRecords?.find(
          (r) => r.kind === "review-finding" && r.findingId === intent.findingId,
        );
        expect(finding).toMatchObject({
          status: "resolved",
          revision: 0,
          target: {
            headSha: f.prepared.manifest.target.headSha,
          },
          reportedBy: { dispatchId: f.snapshot.fence.dispatchId },
        });
        expect(
          after.evidence.filter((e) => e.evidenceId.startsWith("review-finding-resolution:")),
        ).toHaveLength(1);
        expect(after.tasks).toEqual(before.tasks);
        expect(after.criteria).toEqual(before.criteria);
        if (finding?.kind !== "review-finding")
          return yield* Effect.die("Resolution finding missing");
        const reader = yield* makeProjectTeamReviewResolutionReader({
          environmentId: "environment",
        });
        const historical = yield* f.sql
          .withTransaction(
            reader.readInTransaction({
              findingRecordId: finding.recordId,
              expectedFindingRevision: finding.revision,
              expectedFindingSha256: digest(canonical(finding)),
            }),
          )
          .pipe(Effect.result);
        expect(historical, "historical retained resolution audit before retry").toMatchObject({
          _tag: "Success",
        });
        const replay = yield* reportTool(f, intent).pipe(Effect.result);
        expect(replay, "exact actual resolution retry").toMatchObject({ _tag: "Success" });
        expect(yield* f.state()).toEqual(after);
      }),
    ),
);

it.effect(
  "a repaired-head independent Pi report resolves the old finding without replacing its origin",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const first = yield* makeFindingFixture(true, "success");
        const originalIntent = yield* first.report();
        yield* reportTool(first, originalIntent);
        const original = (yield* first.state()).foundationRecords?.find(
          (r) => r.kind === "review-finding" && r.findingId === originalIntent.findingId,
        );
        if (original?.kind !== "review-finding")
          return yield* Effect.die("Original finding missing");
        const oldGate = (yield* first.state()).foundationRecords?.find(
          (r) => r.kind === "gate" && r.verificationJobId === first.prepared.manifest.jobId,
        );
        if (oldGate?.kind !== "gate")
          return yield* Effect.die("Original verification gate missing");
        yield* first.commitRecords("invalidate-old-resolution-job", [
          decodeRecord({ ...oldGate, status: "invalidated", revision: oldGate.revision + 1 }),
        ]);
        // Synthetic settled binding only: its disposable initialize already has joined custody. This does not prove production cleanup.
        yield* restoreHistoricalBinding(
          decodeRecord({
            ...first.running,
            status: "settled",
            revision: first.running.revision + 1,
          }),
        );
        const current = yield* first.state();
        const selection = {
          ...first.selection,
          jobId: "verification-repaired",
          expectedRevision: current.revision,
        };
        const human = { actor: { kind: "human" as const, id: "maintainer" } };
        const preparation = yield* makeProjectWorkVerificationPreparation({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          assertHumanCurrent: () => Effect.void,
          captureWorkspace: (original, use) =>
            use({
              receipt: original.receipt,
              cwd: original.receipt.assignment.worktreePath,
              baseSha: "a".repeat(40),
              headSha: "e".repeat(40),
              testedCommit: "e".repeat(40),
              testedTree: "f".repeat(40),
            }),
          captureExecutable: (_binding, command, use) =>
            use({
              executableTarget: command.executable,
              sha256: "e".repeat(64),
              runtimeClosureSha256: "f".repeat(64),
            }),
          retainPrepared: (manifest) =>
            first.jobs.retainPrepared(manifest).pipe(
              Effect.mapError(
                () =>
                  new ProjectWorkVerificationPreparationError({
                    reason: "Controlled repaired target retention failed",
                  }),
              ),
            ),
        });
        const prepared = yield* preparation.prepare(selection, human);
        expect(prepared.manifest.target.headSha).toBe("e".repeat(40));
        const second = yield* makeFindingFixture(
          true,
          "success",
          {
            ...first.verificationBase,
            state: yield* first.state(),
            principal: human,
            selection,
            prepared,
          },
          "-repaired",
        );
        const attempts = yield* second.sql<{
          attemptId: string;
        }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${prepared.manifest.jobId}`;
        const intent = yield* second.report({
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make("resolve-repaired-head"),
          revision: 1,
          status: "resolved",
          resolutionArtifactIds: [
            attempts[0]!.attemptId + ":stdout",
            attempts[0]!.attemptId + ":stderr",
          ],
        });
        const before = yield* second.state();
        yield* reportTool(second, intent);
        const after = yield* second.state();
        const resolved = after.foundationRecords?.find((r) => r.recordId === original.recordId);
        expect(resolved).toMatchObject({
          revision: 1,
          status: "resolved",
          target: original.target,
          originReviewer: original.originReviewer,
          reportedBy: {
            bindingId: "review-binding-repaired",
            targetSha256: digest(canonical(second.target)),
          },
        });
        if (resolved?.kind !== "review-finding")
          return yield* Effect.die("Resolved finding missing");
        const reader = yield* makeProjectTeamReviewResolutionReader({
          environmentId: "environment",
        });
        const association = yield* second.sql.withTransaction(
          reader.readInTransaction({
            findingRecordId: resolved.recordId,
            expectedFindingRevision: 1,
            expectedFindingSha256: digest(canonical(resolved)),
          }),
        );
        expect(association?.detail.proof.target.headSha).toBe("e".repeat(40));
        expect(association?.finding.target.headSha).toBe("c".repeat(40));
        expect(after.tasks).toEqual(before.tasks);
        expect(after.criteria).toEqual(before.criteria);
        const retry = yield* second.report({
          ...intent,
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make(
            "semantic-resolution-retry",
          ),
          expectedRevision: after.revision,
        });
        yield* reportTool(second, retry);
        expect(yield* second.state()).toEqual(after);
        yield* reportTool(second, intent);
        expect(yield* second.state()).toEqual(after);
        const proposal = yield* makeProposalFixture(true, undefined, second, "-repaired");
        const consumed = yield* makeConsumedReviewFixture({}, proposal);
        const retainedProposal = yield* readProposal(consumed);
        expect(retainedProposal?.manifest.findings).toHaveLength(1);
        expect(retainedProposal?.manifest.target.headSha).toBe("e".repeat(40));
        const proof = yield* consumed.prepare();
        expect(proof).toMatchObject({ status: "completed", target: { headSha: "e".repeat(40) } });
        if (proof?.status !== "completed")
          return yield* Effect.die("Repaired review completion denied");
        expect(proof.findings).toEqual(retainedProposal?.manifest.findings);
        expect((yield* consumed.state()).tasks.find((t) => t.taskId === taskId)?.state).not.toBe(
          "completed",
        );
      }),
    ),
);

for (const failure of [
  "missing-result",
  "failed-result",
  "arbitrary-artifact",
  "corrupt-stdout",
  "foreign-artifact-scope",
] as const) {
  it.effect(`an actual Pi resolution denies ${failure} without finding or receipt effects`, () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeFindingFixture(
          true,
          failure === "missing-result"
            ? undefined
            : failure === "failed-result"
              ? "failed"
              : "success",
        );
        const rows = yield* f.sql<{
          attemptId: string;
        }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${f.prepared.manifest.jobId}`;
        const artifactId = (rows[0]?.attemptId ?? "missing-verification-attempt") + ":stdout";
        if (failure === "corrupt-stdout" || failure === "foreign-artifact-scope") {
          yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
          if (failure === "corrupt-stdout")
            yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array([255, 0, 1])} WHERE artifact_id=${artifactId}`;
          else
            yield* f.sql`UPDATE project_work_artifacts SET project_id='foreign-project' WHERE artifact_id=${artifactId}`;
        }
        const intent = yield* f.report({
          status: "resolved",
          resolutionArtifactIds: [
            failure === "arbitrary-artifact" ? "unrelated-output" : artifactId,
          ],
        });
        const before = yield* f.state();
        const outcome = yield* reportTool(f, intent).pipe(Effect.result);
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProjectTeamAuthorizationError" },
        });
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
        ).toEqual([{ count: 0 }]);
      }),
    ),
  );
}

it.effect(
  "resolution history remains readable after reviewer revocation while fresh semantic reports stay denied",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeFindingFixture(true, "success");
        const rows = yield* f.sql<{
          attemptId: string;
        }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${f.prepared.manifest.jobId}`;
        const intent = yield* f.report({
          status: "resolved",
          resolutionArtifactIds: [rows[0]!.attemptId + ":stdout"],
        });
        yield* reportTool(f, intent);
        const finding = (yield* f.state()).foundationRecords?.find(
          (r) => r.kind === "review-finding" && r.findingId === intent.findingId,
        );
        if (finding?.kind !== "review-finding")
          return yield* Effect.die("Missing retained resolution");
        yield* restoreHistoricalBinding(
          decodeRecord({ ...f.running, status: "revoked", revision: f.running.revision + 1 }),
        );
        const reader = yield* makeProjectTeamReviewResolutionReader({
          environmentId: "environment",
        });
        const historical = yield* f.sql.withTransaction(
          reader.readInTransaction({
            findingRecordId: finding.recordId,
            expectedFindingRevision: finding.revision,
            expectedFindingSha256: digest(canonical(finding)),
          }),
        );
        expect(historical?.finding).toEqual(finding);
        const before = yield* f.state();
        const retry = yield* f.report({
          ...intent,
          commandId: ProjectTeamReviewFindingIntent.fields.commandId.make(
            "revoked-resolution-retry",
          ),
          expectedRevision: before.revision,
        });
        expect((yield* reportTool(f, retry).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

for (const corrupt of ["stderr", "receipt-attribution", "receipt-events"] as const) {
  it.effect(
    `resolution historical audit denies corrupt ${corrupt} and never produces replacement proof`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* makeFindingFixture(true, "success");
          const rows = yield* f.sql<{
            attemptId: string;
          }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${f.prepared.manifest.jobId}`;
          const intent = yield* f.report({
            status: "resolved",
            resolutionArtifactIds: [rows[0]!.attemptId + ":stdout"],
          });
          yield* reportTool(f, intent);
          const after = yield* f.state();
          const finding = after.foundationRecords?.find(
            (r) => r.kind === "review-finding" && r.findingId === intent.findingId,
          );
          if (finding?.kind !== "review-finding")
            return yield* Effect.die("Missing retained resolution");
          if (corrupt === "stderr") {
            yield* f.sql`DROP TRIGGER project_work_artifacts_immutable`;
            yield* f.sql`UPDATE project_work_artifacts SET raw_bytes=${new Uint8Array([0, 255])} WHERE artifact_id=${rows[0]!.attemptId + ":stderr"}`;
          } else if (corrupt === "receipt-attribution")
            yield* f.sql`UPDATE project_work_command_receipts SET actor_id='another-reviewer' WHERE command_id=${intent.commandId}`;
          else
            yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]' WHERE command_id=${intent.commandId}`;
          const reader = yield* makeProjectTeamReviewResolutionReader({
            environmentId: "environment",
          });
          expect(
            (yield* f.sql
              .withTransaction(
                reader.readInTransaction({
                  findingRecordId: finding.recordId,
                  expectedFindingRevision: finding.revision,
                  expectedFindingSha256: digest(canonical(finding)),
                }),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const retry = yield* f.report({
            ...intent,
            commandId: ProjectTeamReviewFindingIntent.fields.commandId.make(
              "corrupt-resolution-retry",
            ),
            expectedRevision: after.revision,
          });
          expect((yield* reportTool(f, retry).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.state()).toEqual(after);
        }),
      ),
  );
}

it.effect(
  "a resolution failed owning COMMIT retains no proof and exact retry keeps the original judgment",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* makeFindingFixture(true, "success");
        const rows = yield* f.sql<{
          attemptId: string;
        }>`SELECT attempt_id AS attemptId FROM project_work_verification_execution WHERE environment_id='environment' AND job_id=${f.prepared.manifest.jobId}`;
        const intent = yield* f.report({
          status: "resolved",
          resolutionArtifactIds: [rows[0]!.attemptId + ":stdout"],
        });
        const before = yield* f.state();
        const query = yield* ProjectWorkQuery;
        const beforeSnapshot = yield* query.snapshot(projectId);
        yield* f.sql`CREATE TABLE controlled_resolution_parent (id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE controlled_resolution_child (id TEXT REFERENCES controlled_resolution_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER controlled_resolution_commit_failure AFTER INSERT ON project_work_evidence WHEN NEW.evidence_id LIKE 'review-finding-resolution:%' BEGIN INSERT INTO controlled_resolution_child VALUES ('missing'); END`;
        let escaped = false;
        expect(
          (yield* reportTool(f, intent).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                escaped = true;
              }),
            ),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(escaped).toBe(false);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM controlled_resolution_child`).toEqual([
          { count: 0 },
        ]);
        expect(yield* query.snapshot(projectId)).toEqual(beforeSnapshot);
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${intent.commandId}`,
        ).toEqual([{ count: 0 }]);
        yield* f.sql`DROP TRIGGER controlled_resolution_commit_failure`;
        yield* reportTool(f, intent);
        const after = yield* f.state();
        expect(
          after.evidence.filter((e) => e.evidenceId.startsWith("review-finding-resolution:")),
        ).toHaveLength(1);
        yield* reportTool(f, intent);
        expect(yield* f.state()).toEqual(after);
      }),
    ),
);

const makeHumanManagedMergeFixture = Effect.fn("mergeTest.authenticFixture")(function* (
  options: { readonly parentAssessment?: boolean; readonly settleReviewRoot?: boolean } = {},
) {
  const p = yield* makeHumanPublicationFixture(options);
  const { f, input, target, permission, authorization } = p;
  const pending = yield* p.publication.enqueuePrepared(
    authorization.prepareInTransaction({ input, target, permission }),
  );
  const effect = (yield* f.state()).foundationRecords?.find(
    (entry) => entry.recordId === pending.operationId,
  );
  if (effect?.kind !== "effect") return yield* Effect.die("Missing real publication operation");
  const request = yield* decodeControlledPublicationRequest(effect.payload.summary);
  let created = false;
  const pr = {
    node_id: "PR_merge",
    number: 42,
    html_url: "https://github.com/owner/reviewed/pull/42",
    state: "open",
    merged_at: null,
    body: `<!-- t3-project-work-publication:v1:${request.marker} -->`,
    base: {
      sha: request.target.baseSha,
      ref: request.target.baseRef,
      repo: { node_id: request.repository.nodeId, full_name: request.repository.nameWithOwner },
    },
    head: {
      sha: request.target.headSha,
      ref: request.target.headRef,
      repo: { node_id: request.target.headRepositoryNodeId },
    },
  };
  const run: VcsProcess.VcsProcess["Service"]["run"] = (command) =>
    Effect.sync(() => {
      let value: unknown;
      if (command.args.includes("graphql"))
        value = {
          data: {
            base: {
              id: request.repository.nodeId,
              nameWithOwner: request.repository.nameWithOwner,
              ref: { name: request.target.baseRef, target: { oid: request.target.baseSha } },
            },
            head: {
              id: request.target.headRepositoryNodeId,
              nameWithOwner: request.repository.nameWithOwner,
              ref: { name: request.target.headRef, target: { oid: request.target.headSha } },
            },
          },
        };
      else if (command.args.includes("POST")) {
        created = true;
        value = {};
      } else if (command.args.at(-1) === `repos/${request.repository.nameWithOwner}`)
        value = { node_id: request.repository.nodeId, full_name: request.repository.nameWithOwner };
      else value = created ? [pr] : [];
      return {
        stdout: canonical(value),
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  const publication = yield* Publication.make({
    authorizePublication: authorization.assertCurrent,
    resolveCredential: () =>
      Effect.succeed({
        cwd: target.cwd,
        host: request.repository.host,
        repositoryNodeId: request.repository.nodeId,
        headRepositoryNodeId: request.target.headRepositoryNodeId,
        credentialFingerprint: "controlled-epoch",
        token: Redacted.make("controlled-merge-publication-token"),
      }),
  }).pipe(
    Effect.provide(
      GitHubCli.layer.pipe(
        Layer.provide(Layer.succeed(VcsProcess.VcsProcess, VcsProcess.VcsProcess.of({ run }))),
      ),
    ),
  );
  const published = yield* publication.dispatch(pending.operationId);
  expect(published.kind).toBe("confirmed");
  const mergeInput: PullRequestActionInput = {
    projectId,
    host: request.repository.host,
    repository: request.repository.nameWithOwner,
    number: 42,
    action: "merge",
    mergeMethod: "squash",
  };
  const human = yield* makeProjectWorkHumanMergeRequest(p.session, mergeInput).pipe(
    Effect.provideService(AuthSessions.AuthSessionRepository, p.sessions),
  );
  const service = yield* makeProjectWorkManagedMerge({ environmentId: "environment" }).pipe(
    Effect.provideService(ProjectWorkPublicationAuthorization, authorization),
    Effect.provide(MergeGuard.layer),
  );
  const journal = yield* makeProjectWorkManagedMergeJournal({ environmentId: "environment" });
  let writes = 0;
  let reads = 0;
  const ports: ManagedMergePorts = {
    mergeExactHead: (decision) =>
      Effect.gen(function* () {
        const stored = yield* f.sql.withTransaction(
          journal.readInTransaction(decision.operationId),
        );
        expect(stored?.status).toBe("claimed");
        expect(stored?.decision.gate.attribution.actor.kind).toBe("human");
        writes++;
        return {
          kind: "merged" as const,
          host: request.repository.host,
          repository: request.repository.nameWithOwner,
          number: 42,
          authorizedHeadSha: request.target.headSha,
          baseRef: request.target.baseRef,
          mergeCommitSha: "d".repeat(40),
          mergedAt: at,
          mergedBy: "controlled-human",
          observedAt: at,
        };
      }).pipe(Effect.mapError((cause) => new ManagedMergeError({ reason: "persistence", cause }))),
    reconcileExactHead: () =>
      Effect.sync(() => {
        reads++;
        return {
          state: "merged",
          headSha: request.target.headSha,
          baseRef: request.target.baseRef,
        };
      }),
  };
  return {
    ...p,
    request,
    mergeInput,
    human,
    service,
    journal,
    ports,
    counts: () => ({ writes, reads }),
    resolved: {
      projectId,
      host: request.repository.host,
      repository: request.repository.nameWithOwner,
    },
  };
});
it.effect(
  "authenticated managed merge retains the exact human decision before sending and returns one delivery receipt",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const before = yield* m.f.state();
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        expect(receipt.confirmation.authorizedHeadSha).toBe(m.request.target.headSha);
        expect(receipt.confirmation.baseRef).toBe(m.request.target.baseRef);
        expect(receipt.evidence.kind).toBe("observation");
        expect(receipt.evidence.attribution?.actor).toEqual({
          kind: "system",
          id: "project-work-managed-merge",
        });
        const after = yield* m.f.state();
        expect(after.tasks).toEqual(before.tasks);
        expect(
          after.evidence.filter((entry) => entry.evidenceId === receipt.evidence.evidenceId),
        ).toEqual([receipt.evidence]);
        expect(yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports)).toEqual(receipt);
        expect(yield* m.service.resume(receipt.operationId, m.ports)).toEqual(receipt);
        expect(m.counts()).toEqual({ writes: 1, reads: 0 });
        expect(
          (yield* m.f.sql.withTransaction(m.journal.readInTransaction(receipt.operationId)))
            ?.receipt,
        ).toEqual(receipt);
      }),
    ),
);

it.effect(
  "managed merge denies another selected project before retaining approval or remote work",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const foreignProject = ProjectId.make("foreign-selected-project");
        const input = { ...m.mergeInput, projectId: foreignProject };
        const human = yield* makeProjectWorkHumanMergeRequest(m.session, input).pipe(
          Effect.provideService(AuthSessions.AuthSessionRepository, m.sessions),
        );
        const before = yield* m.f.repository.replay(projectId);
        const receipts = yield* m.f
          .sql`SELECT COUNT(*) AS count FROM project_work_command_receipts`;
        const events = yield* m.f.sql`SELECT COUNT(*) AS count FROM project_work_events`;
        const outcome = yield* m.service
          .run(input, { ...m.resolved, projectId: foreignProject }, human, m.ports)
          .pipe(Effect.result);
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ManagedMergeError", reason: "authorization-denied" },
        });
        expect(yield* m.f.repository.replay(projectId)).toEqual(before);
        expect(yield* m.f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts`).toEqual(
          receipts,
        );
        expect(yield* m.f.sql`SELECT COUNT(*) AS count FROM project_work_events`).toEqual(events);
        expect(yield* m.f.sql`SELECT COUNT(*) AS count FROM project_work_managed_merge`).toEqual([
          { count: 0 },
        ]);
        expect(m.counts()).toEqual({ writes: 0, reads: 0 });
      }),
    ),
);

const decodeMergeGate = Schema.decodeUnknownEffect(ProjectTeamGate, strict);
const retainCompatibleMergeGate = Effect.fn("mergeTest.existingHumanGate")(function* (
  m: Effect.Success<ReturnType<typeof makeHumanManagedMergeFixture>>,
) {
  const state = yield* m.f.state();
  const human = yield* m.human.assertCurrent(projectId, m.mergeInput);
  const gate = yield* decodeMergeGate({
    kind: "gate",
    recordId: "existing-reviewed-merge-gate",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: human.recordedAt,
    status: "approved",
    taskId: m.request.target.taskId,
    gate: "merge",
    specRevision: m.request.target.specRevision,
    planRevision: m.request.target.planRevision,
    contentHash: "existing-reviewed-fixed-approval",
    attribution: human,
    repository: `${m.request.repository.host}/${m.request.repository.nameWithOwner}`,
    pullRequestNumber: 42,
    headSha: m.request.target.headSha,
    targetBranch: m.request.target.baseRef,
    mergeMethod: "squash",
    evidenceIds: m.request.authorizationRecordIds,
  });
  yield* m.f.repository.execute(
    decodeCommit({
      type: "project-work.foundation.commit",
      commandId: "existing-merge-approval-0",
      projectId,
      expectedRevision: state.revision,
      attribution: human,
      committedAt: human.recordedAt,
      records: [gate],
    }),
  );
  return gate;
});
it.effect(
  "managed merge reuses exact human approval and distinguishes a genuinely fresh gate revision",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const gate = yield* retainCompatibleMergeGate(m);
        const first = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const retained = yield* m.f.sql.withTransaction(
          m.journal.readInTransaction(first.operationId),
        );
        expect(retained?.decision.gate).toEqual(gate);
        expect(retained?.decision.gateApproval).toBeDefined();
        expect(retained?.decision.commands).toHaveLength(1);
        const state = yield* m.f.state();
        const renewed = { ...gate, revision: 1 };
        yield* m.f.repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            commandId: "existing-merge-approval-1",
            projectId,
            expectedRevision: state.revision,
            attribution: gate.attribution,
            committedAt: gate.updatedAt,
            records: [renewed],
          }),
        );
        const refusal = {
          ...m.ports,
          mergeExactHead: () => Effect.fail(new ManagedMergeError({ reason: "uncertain" })),
        };
        expect(
          (yield* m.service.run(m.mergeInput, m.resolved, m.human, refusal).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        const rows = yield* m.f.sql<{
          operation_id: string;
          gate_revision: number;
          status: string;
        }>`SELECT operation_id,gate_revision,status FROM project_work_managed_merge ORDER BY gate_revision`;
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ gate_revision: 0, status: "confirmed" });
        expect(rows[1]).toMatchObject({ gate_revision: 1, status: "uncertain" });
        expect(rows[1]?.operation_id).not.toBe(first.operationId);
        expect(m.counts()).toEqual({ writes: 1, reads: 0 });
      }),
    ),
);
it.effect("managed merge failed owning COMMIT sends nothing and retains no partial approval", () =>
  scopedGateway(
    Effect.gen(function* () {
      const m = yield* makeHumanManagedMergeFixture();
      const before = yield* m.f.repository.replay(projectId);
      yield* m.f.sql`CREATE TABLE controlled_merge_parent(id TEXT PRIMARY KEY)`;
      yield* m.f
        .sql`CREATE TABLE controlled_merge_child(id TEXT REFERENCES controlled_merge_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      yield* m.f
        .sql`CREATE TRIGGER controlled_merge_failed_commit AFTER INSERT ON project_work_evidence WHEN NEW.evidence_id LIKE 'managed-merge-permission:%' BEGIN INSERT INTO controlled_merge_child VALUES ('missing'); END`;
      expect(
        (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(m.counts().writes).toBe(0);
      expect(yield* m.f.sql`SELECT COUNT(*) AS count FROM controlled_merge_child`).toEqual([
        { count: 0 },
      ]);
      expect(yield* m.f.repository.replay(projectId)).toEqual(before);
      expect(yield* m.f.sql`SELECT operation_id FROM project_work_managed_merge`).toEqual([]);
      yield* m.f.sql`DROP TRIGGER controlled_merge_failed_commit`;
      expect(
        (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports)).confirmation.kind,
      ).toBe("merged");
      expect(m.counts().writes).toBe(1);
    }),
  ),
);
it.effect(
  "managed merge uncertainty reconciles external observations without resending or producing delivery",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        let writes = 0;
        const ambiguous = {
          ...m.ports,
          mergeExactHead: () =>
            Effect.sync(() => {
              writes++;
              return {
                kind: "merged" as const,
                host: m.request.repository.host,
                repository: m.request.repository.nameWithOwner,
                number: 42,
                authorizedHeadSha: "e".repeat(40),
                baseRef: m.request.target.baseRef,
                mergeCommitSha: "d".repeat(40),
                mergedAt: at,
                mergedBy: "external-human",
                observedAt: at,
              };
            }),
        };
        expect(
          (yield* m.service.run(m.mergeInput, m.resolved, m.human, ambiguous).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        const pending = yield* m.service.pending();
        expect(pending).toHaveLength(1);
        const operation = pending[0];
        if (!operation) return yield* Effect.die("Missing uncertain merge");
        expect(
          (yield* m.service.resume(operation.operationId, m.ports).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const stored = yield* m.f.sql.withTransaction(
          m.journal.readInTransaction(operation.operationId),
        );
        expect(stored).toMatchObject({
          status: "uncertain",
          attention: { reason: "write-unconfirmed" },
        });
        expect(
          (yield* m.f.state()).evidence.some((entry) =>
            entry.evidenceId.startsWith("managed-merge-delivery:"),
          ),
        ).toBe(false);
        expect(writes).toBe(1);
        expect(m.counts()).toEqual({ writes: 0, reads: 1 });
      }),
    ),
);
it.effect(
  "managed merge retains browser-independent consent but rejects new revoked-session and foreign-loan requests",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const before = yield* m.f.repository.replay(projectId);
        expect(
          (yield* m.service
            .run(m.mergeInput, m.resolved, m.human, m.ports)
            .pipe(Effect.provideService(SqlClient.SqlClient, { ...m.f.sql }), Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* m.f.repository.replay(projectId)).toEqual(before);
        expect(m.counts().writes).toBe(0);
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        yield* m.f
          .sql`UPDATE auth_sessions SET revoked_at=${DateTime.formatIso(DateTime.makeUnsafe(m.now))} WHERE session_id=${m.session.sessionId}`;
        expect(yield* m.service.resume(receipt.operationId, m.ports)).toEqual(receipt);
        expect(
          (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(m.counts().writes).toBe(1);
      }),
    ),
);
it.effect("managed merge rejects changed source grants before any remote write", () =>
  scopedGateway(
    Effect.gen(function* () {
      const m = yield* makeHumanManagedMergeFixture();
      const before = yield* m.f.repository.replay(projectId);
      const grant = (yield* m.f.state()).foundationRecords?.find(
        (entry) => entry.kind === "gate" && entry.verificationJobId === m.f.prepared.manifest.jobId,
      );
      if (grant?.kind !== "gate")
        return yield* Effect.die("Missing original verification permission");
      yield* m.f.repository.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          commandId: "merge-revoke-verification",
          projectId,
          expectedRevision: (yield* m.f.state()).revision,
          attribution: grant.attribution,
          committedAt: at,
          records: [
            { ...grant, status: "invalidated", revision: grant.revision + 1, updatedAt: at },
          ],
        }),
      );
      expect(
        (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(m.counts().writes).toBe(0);
      expect(yield* m.f.sql`SELECT operation_id FROM project_work_managed_merge`).toEqual([]);
      expect((yield* m.f.repository.replay(projectId)).length).toBeGreaterThan(before.length);
    }),
  ),
);

it.effect(
  "managed merge through the real pull request service uses the exact provider confirmation and notifies after retained delivery",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const provider = yield* GitHubPullProvider.make.pipe(
          Effect.provide(
            Layer.mock(GitHubPullCli.GitHubPullRequestCli)({
              getViewerLogin: () => Effect.succeed("controlled-human"),
              getViewerAccess: () =>
                Effect.succeed({
                  canWrite: true,
                  canTriage: false,
                  canUpdate: true,
                  didAuthor: false,
                }),
              confirmExactHeadMerge: (input) =>
                Effect.gen(function* () {
                  expect(input).toMatchObject({
                    repository: m.request.repository.nameWithOwner,
                    host: m.request.repository.host,
                    number: 42,
                    expectedHeadSha: m.request.target.headSha,
                    expectedBaseRef: m.request.target.baseRef,
                    expectedBaseSha: m.request.target.baseSha,
                    mergeMethod: "squash",
                  });
                  const rows = yield* m.f.sql<{
                    operation_id: string;
                  }>`SELECT operation_id FROM project_work_managed_merge WHERE status='claimed'`;
                  expect(rows).toHaveLength(1);
                  const row = rows[0];
                  if (!row) return yield* Effect.die("Missing retained claim");
                  const retained = yield* m.f.sql.withTransaction(
                    m.journal.readInTransaction(row.operation_id),
                  );
                  if (!retained) return yield* Effect.die("Missing retained decision");
                  return yield* m.ports.mergeExactHead(retained.decision);
                }).pipe(
                  Effect.provideService(SqlClient.SqlClient, m.f.sql),
                  Effect.provideService(ProjectWorkRepository, m.f.repository),
                  Effect.mapError(
                    (cause) =>
                      new GitHubPullCli.GitHubPullRequestReadError({
                        command: "gh",
                        cwd: input.cwd,
                        operation: "exactHeadMergeDetail",
                        cause,
                      }),
                  ),
                ),
              runPullRequestAction: () =>
                Effect.die("Managed work must not enter an ordinary merge"),
              getPullRequestSummary: () =>
                Effect.die("The validated managed receipt supplies the merge notification"),
            }),
          ),
        );
        const shell: OrchestrationProjectShell = {
          id: projectId,
          title: "Reviewed work",
          workspaceRoot: m.target.cwd,
          repositoryIdentity: {
            canonicalKey: "github.com/owner/reviewed",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://github.com/owner/reviewed.git",
            },
            provider: "github",
            displayName: "owner/reviewed",
          },
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        };
        const service = yield* PullService.make.pipe(
          Effect.provideService(ProjectWorkManagedMerge, m.service),
          Effect.provide(
            Layer.mergeAll(
              MergeGuard.layer,
              Layer.succeed(
                PullRegistry.PullRequestProviderRegistry,
                PullRegistry.fromProviders([provider]),
              ),
              Layer.succeed(PullReadCache.PullRequestReadCache, {
                get: (_key, read) => read,
                invalidate: Effect.void,
              }),
              Layer.mock(ProjectionSnapshotQuery)({
                getProjectShells: () => Effect.succeed([shell]),
                getProjectShellById: () => Effect.succeed(Option.some(shell)),
              }),
              Layer.mock(SourceProviders.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                resolveHandle: () => Effect.die("Unexpected repository replacement"),
              }),
              Layer.succeed(
                FileSystem.FileSystem,
                FileSystem.makeNoop({
                  realPath: (path) => Effect.succeed(path),
                  readFileString: () => Effect.succeed(""),
                }),
              ),
              SourceRateLimit.layer,
              PlatformPath.layer,
            ),
          ),
        );
        const merged = yield* service.subscribeMerges;
        const observed = yield* Deferred.make<PullService.PullRequestMergeEvent>();
        yield* Effect.forkScoped(
          merged.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Deferred.succeed(observed, event)),
          ),
        );
        yield* service
          .runAction(m.mergeInput)
          .pipe(Effect.provideService(ProjectWorkHumanMergeRequest, m.human));
        const event = yield* Deferred.await(observed);
        expect(event).toMatchObject({
          projectId,
          repository: m.request.repository.nameWithOwner,
          number: 42,
          mergedAt: at,
        });
        const rows = yield* m.f.sql<{
          operation_id: string;
        }>`SELECT operation_id FROM project_work_managed_merge WHERE status='confirmed'`;
        expect(rows).toHaveLength(1);
        expect(m.counts()).toEqual({ writes: 1, reads: 0 });
        expect(
          (yield* m.f.state()).evidence.some((entry) =>
            entry.evidenceId.startsWith("managed-merge-delivery:"),
          ),
        ).toBe(true);
        yield* service
          .runAction(m.mergeInput)
          .pipe(Effect.provideService(ProjectWorkHumanMergeRequest, m.human));
        expect(m.counts().writes).toBe(1);
      }),
    ),
);

it.effect(
  "managed merge denies corrupt original verification before retaining approval or contacting the provider",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const rows = yield* m.f.sql<{
          artifactId: string;
          raw: Uint8Array;
        }>`SELECT artifact_id AS artifactId,raw_bytes AS raw FROM project_work_artifacts WHERE artifact_id LIKE '%:stderr' LIMIT 2`;
        const row = rows[0];
        if (rows.length !== 1 || !row || !row.raw.length)
          return yield* Effect.die("Missing original verification stderr");
        const bytes = new Uint8Array(row.raw);
        bytes[0] = bytes[0]! ^ 255;
        yield* m.f.sql`DROP TRIGGER project_work_artifacts_immutable`;
        yield* m.f
          .sql`UPDATE project_work_artifacts SET raw_bytes=${bytes} WHERE artifact_id=${row.artifactId}`;
        const before = yield* m.f.repository.replay(projectId);
        expect(
          (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(yield* m.f.repository.replay(projectId)).toEqual(before);
        expect(yield* m.f.sql`SELECT operation_id FROM project_work_managed_merge`).toEqual([]);
        expect(m.counts()).toEqual({ writes: 0, reads: 0 });
      }),
    ),
);
it.effect(
  "managed merge interrupted after claiming recovers by observation without repeating its write",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const entered = yield* Deferred.make<void>();
        let writes = 0;
        const ports = {
          ...m.ports,
          mergeExactHead: () =>
            Effect.gen(function* () {
              writes++;
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        };
        const running = yield* m.service
          .run(m.mergeInput, m.resolved, m.human, ports)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(running);
        const rows = yield* m.service.pending();
        expect(rows).toHaveLength(1);
        const row = rows[0];
        if (!row) return yield* Effect.die("Missing claimed operation");
        const restarted = yield* makeProjectWorkManagedMerge({ environmentId: "environment" }).pipe(
          Effect.provideService(ProjectWorkPublicationAuthorization, m.authorization),
          Effect.provide(MergeGuard.layer),
        );
        expect((yield* restarted.resume(row.operationId, m.ports).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const stored = yield* m.f.sql.withTransaction(m.journal.readInTransaction(row.operationId));
        expect(stored).toMatchObject({
          status: "uncertain",
          attention: { reason: "reconciled", state: "merged", headSha: m.request.target.headSha },
        });
        expect(writes).toBe(1);
        expect(m.counts()).toEqual({ writes: 0, reads: 1 });
        expect(
          (yield* m.f.state()).evidence.some((entry) =>
            entry.evidenceId.startsWith("managed-merge-delivery:"),
          ),
        ).toBe(false);
      }),
    ),
);

it.effect(
  "managed merge recovery scans past sixty-four uncertain decisions without resending and catches committed wakes",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture();
        const originalGate = yield* retainCompatibleMergeGate(m);
        let attemptedWrites = 0;
        const interruptedPorts = {
          ...m.ports,
          mergeExactHead: () =>
            Effect.sync(() => {
              attemptedWrites++;
              return new ManagedMergeError({ reason: "uncertain" });
            }).pipe(Effect.flatMap(Effect.fail)),
        };
        for (let revision = 0; revision < 65; revision++) {
          if (revision > 0) {
            const gate = { ...originalGate, revision };
            yield* m.f.repository.execute(
              decodeCommit({
                type: "project-work.foundation.commit",
                commandId: `paged-merge-approval-${revision}`,
                projectId,
                expectedRevision: (yield* m.f.state()).revision,
                attribution: gate.attribution,
                committedAt: at,
                records: [gate],
              }),
            );
          }
          expect(
            (yield* m.service
              .run(m.mergeInput, m.resolved, m.human, interruptedPorts)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const all = yield* m.f.sql<{
          operation_id: string;
        }>`SELECT operation_id FROM project_work_managed_merge ORDER BY operation_id`;
        expect(all).toHaveLength(65);
        expect(attemptedWrites).toBe(65);
        const firstPage = yield* m.service.pending();
        expect(firstPage).toHaveLength(64);
        expect(
          (yield* m.service.pending(firstPage.at(-1)?.operationId)).map((row) => row.operationId),
        ).toEqual(all.slice(64).map((row) => row.operation_id));
        const bus = yield* ProjectWorkEventBus;
        const subscribed = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const observed = yield* Queue.unbounded<string>();
        const worker = yield* runProjectWorkManagedMergeRecovery(
          m.service,
          (operationId) =>
            Effect.gen(function* () {
              expect((yield* m.service.resume(operationId, m.ports).pipe(Effect.result))._tag).toBe(
                "Failure",
              );
              yield* Queue.offer(observed, operationId);
            }),
          Deferred.await(ready),
        ).pipe(
          Effect.provideService(ProjectWorkEventBus, {
            ...bus,
            subscribe: bus.subscribe.pipe(
              Effect.tap(() => Deferred.succeed(subscribed, undefined)),
            ),
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        yield* Deferred.succeed(ready, undefined);
        const discovered: string[] = [];
        for (let index = 0; index < 65; index++) discovered.push(yield* Queue.take(observed));
        expect(discovered).toEqual(all.map((row) => row.operation_id));
        const afterWake: string[] = [];
        // Re-publish an actual retained permission event; waking conveys no additional authority.
        const events = yield* m.f.repository.replay(projectId);
        const permission = events.find(
          (event) =>
            event.type === "project-work.evidence.added" &&
            event.evidence.evidenceId.startsWith("managed-merge-permission:"),
        );
        if (!permission) return yield* Effect.die("Missing retained human permission");
        yield* bus.publish([{ cursor: permission.revision, event: permission }]);
        for (let index = 0; index < 65; index++) afterWake.push(yield* Queue.take(observed));
        expect(afterWake).toEqual(discovered);
        yield* Fiber.interrupt(worker);
        expect(attemptedWrites).toBe(65);
        expect(m.counts()).toEqual({ writes: 0, reads: 130 });
        expect(
          (yield* m.f.state()).evidence.some((entry) =>
            entry.evidenceId.startsWith("managed-merge-delivery:"),
          ),
        ).toBe(false);
      }),
    ),
);

it.effect(
  "confirmed reviewed delivery accepts only its qualified code task without rewriting criteria",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({
          parentAssessment: true,
          settleReviewRoot: true,
        });
        const before = yield* m.f.state();
        const taskId = m.request.target.taskId;
        const required = before.criteria.filter((c) => c.taskId === taskId && c.required);
        expect(required.length).toBeGreaterThan(0);
        expect(required.every((c) => c.status === "satisfied" || c.status === "waived")).toBe(true);
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const after = yield* m.f.state();
        expect(after.tasks.find((t) => t.taskId === taskId)?.state).toBe("completed");
        expect(after.criteria).toEqual(before.criteria);
        expect(after.tasks.filter((t) => t.taskId !== taskId)).toEqual(
          before.tasks.filter((t) => t.taskId !== taskId),
        );
        expect(yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports)).toEqual(receipt);
        expect(yield* m.f.state()).toEqual(after);
        expect(m.counts()).toEqual({ writes: 1, reads: 0 });
      }),
    ),
);
it.effect(
  "confirmed delivery preserves criteria while an active coordinator prevents acceptance",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({ parentAssessment: true });
        const before = yield* m.f.state();
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const after = yield* m.f.state();
        expect(after.tasks).toEqual(before.tasks);
        expect(after.criteria).toEqual(before.criteria);
        expect(after.evidence.some((e) => e.evidenceId.startsWith("delivery-acceptance:"))).toBe(
          false,
        );
        expect(
          (yield* m.f.sql.withTransaction(m.journal.readInTransaction(receipt.operationId)))
            ?.receipt,
        ).toEqual(receipt);
        expect(m.counts()).toEqual({ writes: 1, reads: 0 });
      }),
    ),
);
const decodeDeliveryTestCommand = Schema.decodeUnknownSync(ProjectWorkCommand, strict);
const decodeDeliveryGuidedIntent = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, strict);
const decodeDeliveryCriterion = Schema.decodeUnknownSync(ProjectWorkCriterion, strict);
const decodeDeliveryEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const deliveredDependencyFixture = Effect.fn("deliveryTest.dependency")(function* () {
  const m = yield* makeHumanManagedMergeFixture({ parentAssessment: true, settleReviewRoot: true });
  const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
  const downstream = yield* makeVerificationAssignmentFixture(
    "implementer",
    "-delivered-dependent",
  ).pipe(
    Effect.provideService(ProjectWorkRepository, {
      ...m.f.repository,
      execute: (command) =>
        m.f.repository.execute(
          command.type === "project-work.foundation.commit" &&
            command.guided?.intent.type === "project-team.plan.propose"
            ? {
                ...command,
                guided: {
                  ...command.guided,
                  intent: {
                    ...command.guided.intent,
                    dependencyTaskIds: [m.request.target.taskId],
                  },
                },
              }
            : command,
        ),
    }),
  );
  const transition = downstream.request.claim.transition;
  if (transition?.kind !== "claim") return yield* Effect.die("Missing original downstream claim");
  const dependencyId = transition.binding.taskId;
  const command = decodeDeliveryTestCommand;
  const auth = yield* ProjectTeamAuthorization;
  const state = yield* m.f.state();
  const plan = state.foundationRecords?.find(
    (r) => r.kind === "plan-revision" && r.taskId === dependencyId,
  );
  const specGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.taskId === dependencyId && r.gate === "specification",
  );
  const planGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.taskId === dependencyId && r.gate === "plan",
  );
  if (plan?.kind !== "plan-revision" || specGate?.kind !== "gate" || planGate?.kind !== "gate")
    return yield* Effect.die("Missing exact downstream approvals");
  const human = {
    actor: { kind: "human" as const, id: "fixture-human" },
    source: { kind: "web" as const, id: "fixture-browser" },
    recordedAt: at,
  };
  const executionIntent = (current: typeof state) =>
    decodeDeliveryGuidedIntent({
      type: "project-team.execution.start",
      commandId: "downstream-authority",
      projectId,
      expectedRevision: current.revision,
      taskId: dependencyId,
      expectedTaskRevision: current.tasks.find((t) => t.taskId === dependencyId)?.revision,
      specRevision: specGate.specRevision,
      planRevision: plan.planRevision,
      specGateId: specGate.recordId,
      expectedSpecGateRevision: specGate.revision,
      planId: plan.recordId,
      expectedPlanRecordRevision: plan.revision,
      planGateId: planGate.recordId,
      expectedPlanGateRevision: planGate.revision,
    });
  const compile = (current: typeof state) =>
    m.f.sql.withTransaction(
      auth.guided({ actor: human.actor }, executionIntent(current), human, false),
    );
  const authorized = yield* compile(state);
  expect(authorized.type).toBe("project-work.foundation.commit");
  if (authorized.type !== "project-work.foundation.commit")
    return yield* Effect.die("Missing actual guided foundation command");
  expect(authorized.guided?.intent.type).toBe("project-team.execution.start");
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const request = {
    ...downstream.request,
    claim: { ...downstream.request.claim, expectedRevision: state.revision },
  };
  const reserved = yield* journal.reserve(request);
  yield* journal.inspect(reserved.fence.dispatchId);
  const acceptance = yield* makeProjectTeamDeliveryAcceptance({
    environmentId: "environment",
  }).pipe(Effect.provideService(ProjectWorkPublicationAuthorization, m.authorization));
  const assertDependencies = m.f.sql.withTransaction(
    acceptance.assertTaskDependenciesInTransaction({ projectId, taskId: dependencyId }),
  );
  return {
    m,
    receipt,
    dependencyId,
    acceptance,
    assertDependencies,
    command,
    journal,
    reserved,
    compile,
  };
});
it.effect(
  "accepted delivery qualifies real SQL dependencies while watch metadata preserves the original scope",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* deliveredDependencyFixture();
        yield* f.assertDependencies;
        let state = yield* f.m.f.state();
        const task = state.tasks.find((t) => t.taskId === f.m.request.target.taskId);
        const membership = state.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.taskId === task?.taskId,
        );
        expect(
          evaluateProjectTeamDependency({
            projectId,
            taskId: f.m.request.target.taskId,
            task,
            memberships: membership?.kind === "task-membership" ? [membership] : [],
            state,
          }).available,
        ).toBe(true);
        const evidence = state.evidence.find((e) =>
          e.evidenceId.startsWith("delivery-acceptance:"),
        );
        for (const action of ["watch", "unwatch"] as const) {
          state = yield* f.m.f.state();
          yield* f.m.f.repository.execute(
            f.command({
              type: `project-work.task.${action}`,
              commandId: `delivery-${action}`,
              projectId,
              expectedRevision: state.revision,
              taskId: f.m.request.target.taskId,
              watcher: { kind: "human", id: "observer" },
              ...(action === "watch" ? { watchedAt: at } : { unwatchedAt: at }),
              attribution,
            }),
          );
          yield* f.assertDependencies;
          yield* f.journal.inspect(f.reserved.fence.dispatchId);
        }
        expect(
          (yield* f.m.f.state()).evidence.find((e) => e.evidenceId === evidence?.evidenceId),
        ).toEqual(evidence);
        expect(f.m.counts().writes).toBe(1);
      }),
    ),
);
for (const corruption of ["merge-receipt", "acceptance-command"] as const)
  it.effect(
    `accepted delivery denies new dependency authority after original ${corruption} corruption with unchanged projections`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* deliveredDependencyFixture();
          yield* f.assertDependencies;
          const before = yield* f.m.f.state();
          const retained = readDeliveryAcceptance(before, f.m.request.target.taskId);
          if (!retained) return yield* Effect.die("Missing original acceptance association");
          if (corruption === "merge-receipt") {
            // Deliberately corrupt only the disposable store; production immutability remains unchanged.
            yield* f.m.f.sql`DROP TRIGGER project_work_managed_merge_immutable`;
            yield* f.m.f.sql`DROP TRIGGER project_work_managed_merge_status`;
            yield* f.m.f
              .sql`UPDATE project_work_managed_merge SET receipt_json=json_set(receipt_json,'$.confirmation.mergeCommitSha',${"e".repeat(40)}) WHERE operation_id=${f.receipt.operationId}`;
          } else
            yield* f.m.f
              .sql`UPDATE project_work_command_receipts SET payload_fingerprint='corrupt' WHERE command_id=${retained.detail.commandId}`;
          expect(yield* f.m.f.state()).toEqual(before);
          expect((yield* f.assertDependencies.pipe(Effect.result))._tag).toBe("Failure");
          const deniedCompile = yield* f.compile(before).pipe(Effect.result);
          expect(deniedCompile._tag).toBe("Failure");
          if (deniedCompile._tag === "Failure")
            expect(deniedCompile.failure.reason).toBe(
              "Delivered dependency history is no longer qualified",
            );
          const deniedDispatch = yield* f.journal
            .inspect(f.reserved.fence.dispatchId)
            .pipe(Effect.result);
          expect(deniedDispatch._tag).toBe("Failure");
          if (deniedDispatch._tag === "Failure")
            expect(deniedDispatch.failure.reason).toBe("Delivered dependency history changed");
          expect(yield* f.m.f.state()).toEqual(before);
          expect(f.m.counts().writes).toBe(1);
        }),
      ),
  );

it.effect(
  "reopened delivered work loses dependency authority while historical acceptance replay never regrants completion",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* deliveredDependencyFixture();
        const state = yield* f.m.f.state();
        const auth = yield* ProjectTeamAuthorization;
        const human = {
          actor: { kind: "human" as const, id: "fixture-human" },
          source: { kind: "web" as const, id: "fixture-browser" },
          recordedAt: at,
        };
        yield* f.m.f.repository.executeAtomic(
          auth
            .guided(
              { actor: human.actor },
              decodeDeliveryGuidedIntent({
                type: "project-team.task.control",
                commandId: "delivery-reopen",
                projectId,
                expectedRevision: state.revision,
                taskId: f.m.request.target.taskId,
                expectedTaskRevision: state.tasks.find(
                  (t) => t.taskId === f.m.request.target.taskId,
                )?.revision,
                control: {
                  action: "reopen",
                  reason: "Human requests another review of delivered work",
                },
              }),
              human,
              false,
            )
            .pipe(Effect.map((command) => [command])),
        );
        const reopened = yield* f.m.f.state();
        expect((yield* f.assertDependencies.pipe(Effect.result))._tag).toBe("Failure");
        expect(
          yield* f.acceptance.accept({
            operationId: f.receipt.operationId,
            expectedReceiptSha256: deliveryAcceptanceHash(f.receipt),
          }),
        ).toMatchObject({ _tag: "Accepted" });
        expect(yield* f.m.f.state()).toEqual(reopened);
        expect(f.m.counts().writes).toBe(1);
      }),
    ),
);
it.effect(
  "confirmed delivery without satisfied required criteria remains recoverable without completing its task",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({ settleReviewRoot: true });
        const before = yield* m.f.state();
        expect(
          before.criteria.some(
            (c) => c.taskId === m.request.target.taskId && c.required && c.status === "unsatisfied",
          ),
        ).toBe(true);
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const acceptance = yield* makeProjectTeamDeliveryAcceptance({
          environmentId: "environment",
        }).pipe(Effect.provideService(ProjectWorkPublicationAuthorization, m.authorization));
        expect(yield* acceptance.recover(receipt.operationId)).toMatchObject({ _tag: "NotReady" });
        expect(
          (yield* acceptance.pending()).some((r) => r.operationId === receipt.operationId),
        ).toBe(true);
        expect((yield* m.f.state()).tasks).toEqual(before.tasks);
        expect((yield* m.f.state()).criteria).toEqual(before.criteria);
        expect(m.counts().writes).toBe(1);
      }),
    ),
);
it.effect(
  "pure delivery qualification preserves existing human waiver and URI-only evidence bytes",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({
          parentAssessment: true,
          settleReviewRoot: true,
        });
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const actual = yield* m.f.state();
        const accepted = readDeliveryAcceptance(
          actual,
          m.request.target.taskId,
          receipt.operationId,
        );
        if (!accepted) return yield* Effect.die("Missing original accepted source");
        const taskId = m.request.target.taskId;
        const waiverAttribution = {
          actor: { kind: "human" as const, id: "existing-waiver-human" },
          source: { kind: "web" as const, id: "existing-waiver-browser" },
          recordedAt: at,
        };
        const support = actual.criteria
          .filter((c) => c.taskId === taskId && c.required)
          .map((c) =>
            decodeDeliveryEvidence({
              evidenceId: `human-waiver:${c.criterionId}`,
              taskId,
              kind: "observation",
              summary: "Human accepted this limitation",
              uri: "https://example.test/decision",
              recordedAt: at,
              revision: 0,
              attribution: waiverAttribution,
            }),
          );
        // Pure retained-state observation only: the current guided API cannot produce a new waiver.
        const state = {
          ...actual,
          evidence: [...actual.evidence, ...support],
          criteria: actual.criteria.map((c) =>
            c.taskId === taskId && c.required
              ? decodeDeliveryCriterion({
                  ...c,
                  status: "waived",
                  satisfiedByEvidenceIds: [],
                  waiver: {
                    reason: "Existing explicitly accepted limitation",
                    evidenceIds: [`human-waiver:${c.criterionId}`],
                    specRevision: accepted.detail.proof.source.specRevision,
                    waivedAt: at,
                    attribution: waiverAttribution,
                  },
                })
              : c,
          ),
        };
        const before = structuredClone(state);
        const snapshots = deliveryCriterionSnapshots(state, accepted.detail.proof.source);
        expect(() =>
          assertDeliveryAcceptanceCurrent(state, { ...accepted.detail.proof, ...snapshots }),
        ).toThrow("Delivered source is no longer current");
        expect(state).toEqual(before);
        expect(snapshots.support).toEqual(
          support
            .map((e) => ({
              evidenceId: e.evidenceId,
              sha256: deliveryAcceptanceHash(e),
            }))
            .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
        );
        for (const invalid of ["actor", "spec"] as const) {
          const changed = {
            ...state,
            criteria: state.criteria.map((c) =>
              c.waiver
                ? decodeDeliveryCriterion({
                    ...c,
                    waiver: {
                      ...c.waiver,
                      ...(invalid === "spec"
                        ? { specRevision: c.waiver.specRevision + 1 }
                        : {
                            attribution: {
                              ...c.waiver.attribution,
                              actor: { kind: "agent", id: "agent-waiver" },
                            },
                          }),
                    },
                  })
                : c,
            ),
          };
          expect(() => deliveryCriterionSnapshots(changed, accepted.detail.proof.source)).toThrow(
            "Required criterion has no current human waiver",
          );
        }
        expect(yield* m.f.state()).toEqual(actual);
      }),
    ),
);

it.effect(
  "failed acceptance COMMIT preserves delivered receipt and permits one atomic acceptance retry",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({
          parentAssessment: true,
          settleReviewRoot: true,
        });
        const before = yield* m.f.state();
        const bus = yield* ProjectWorkEventBus;
        const published: string[] = [];
        const drained = yield* Deferred.make<void>();
        const changes = yield* bus.subscribe;
        const markerId = ProjectWorkEvidenceId.make("acceptance-test-drain");
        yield* Effect.forkScoped(
          changes.pipe(
            Stream.runForEach(({ event }) =>
              Effect.gen(function* () {
                if (event.type !== "project-work.evidence.added") return;
                published.push(event.evidence.evidenceId);
                if (event.evidence.evidenceId === markerId)
                  yield* Deferred.succeed(drained, undefined);
              }),
            ),
          ),
        );
        yield* m.f.sql`CREATE TABLE controlled_acceptance_parent(id TEXT PRIMARY KEY)`;
        yield* m.f
          .sql`CREATE TABLE controlled_acceptance_child(id TEXT REFERENCES controlled_acceptance_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* m.f
          .sql`CREATE TRIGGER controlled_acceptance_commit AFTER INSERT ON project_work_evidence WHEN NEW.evidence_id LIKE 'delivery-acceptance:%' BEGIN INSERT INTO controlled_acceptance_child VALUES ('missing'); END`;
        // The SQLite client rolls back the failed owning COMMIT while preserving its defect.
        expect(
          (yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* m.f.sql`SELECT COUNT(*) AS count FROM controlled_acceptance_child`).toEqual([
          { count: 0 },
        ]);
        // This unpersisted bus marker drains only the controlled observer, granting no domain authority.
        yield* bus.publish([
          {
            cursor: before.revision,
            event: {
              eventId: EventId.make("acceptance-observer-drain"),
              projectId,
              revision: before.revision,
              type: "project-work.evidence.added",
              evidence: {
                evidenceId: markerId,
                kind: "observation",
                summary: "Controlled observer drain",
                recordedAt: at,
                revision: 0,
              },
              addedAt: at,
              occurredAt: at,
            },
          },
        ]);
        yield* Deferred.await(drained);
        expect(published.some((id) => id.startsWith("delivery-acceptance:"))).toBe(false);
        const afterFailedAcceptance = yield* m.f.state();
        expect(
          afterFailedAcceptance.evidence.some((e) =>
            e.evidenceId.startsWith("delivery-acceptance:"),
          ),
        ).toBe(false);
        expect(afterFailedAcceptance.tasks).toEqual(before.tasks);
        expect(afterFailedAcceptance.criteria).toEqual(before.criteria);
        expect(
          afterFailedAcceptance.evidence.some((e) =>
            e.evidenceId.startsWith("managed-merge-permission:"),
          ),
        ).toBe(true);
        const deliveries = yield* m.f
          .sql`SELECT operation_id FROM project_work_managed_merge WHERE project_id=${projectId} AND status='confirmed' LIMIT 2`;
        expect(deliveries.length).toBe(1);
        const operationId = deliveries[0]?.operation_id;
        if (typeof operationId !== "string")
          return yield* Effect.die("Missing original confirmed delivery");
        const original = yield* m.f.sql.withTransaction(m.journal.readInTransaction(operationId));
        if (!original?.receipt) return yield* Effect.die("Confirmed delivery receipt was lost");
        const receipt = original.receipt;
        yield* m.f.sql`DROP TRIGGER controlled_acceptance_commit`;
        const acceptance = yield* makeProjectTeamDeliveryAcceptance({
          environmentId: "environment",
        }).pipe(Effect.provideService(ProjectWorkPublicationAuthorization, m.authorization));
        expect(yield* acceptance.recover(receipt.operationId)).toMatchObject({ _tag: "Accepted" });
        const after = yield* m.f.state();
        expect(after.tasks.find((t) => t.taskId === m.request.target.taskId)?.state).toBe(
          "completed",
        );
        expect(yield* acceptance.recover(receipt.operationId)).toMatchObject({ _tag: "Accepted" });
        expect(yield* m.f.state()).toEqual(after);
        expect(m.counts().writes).toBe(1);
      }),
    ),
);

it.effect(
  "ordinary evidence and caller-shaped delivery transitions cannot forge task acceptance",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({
          parentAssessment: true,
          settleReviewRoot: true,
        });
        const before = yield* m.f.state();
        const evidence = {
          evidenceId: "delivery-acceptance:" + "a".repeat(64),
          taskId: m.request.target.taskId,
          kind: "observation",
          summary: "System-looking caller evidence",
          recordedAt: at,
          revision: 0,
          attribution: {
            actor: { kind: "system", id: "project-team-delivery-acceptance" },
            source: { kind: "system", id: "project-team-delivery-acceptance" },
            recordedAt: at,
          },
        };
        expect(
          (yield* m.f.repository
            .execute(
              decodeDeliveryTestCommand({
                type: "project-work.evidence.add",
                commandId: "forge-delivery",
                projectId,
                expectedRevision: before.revision,
                evidence,
                addedAt: at,
                attribution,
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* m.f.state()).toEqual(before);
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const after = yield* m.f.state();
        const retained = readDeliveryAcceptance(
          after,
          m.request.target.taskId,
          receipt.operationId,
        );
        if (!retained) return yield* Effect.die("Missing real retained association");
        expect(
          (yield* m.f.repository
            .execute(
              decodeCommit({
                type: "project-work.foundation.commit",
                commandId: "human-raw-delivery",
                projectId,
                expectedRevision: after.revision,
                records: [],
                committedAt: at,
                attribution: {
                  actor: { kind: "human", id: "caller" },
                  source: { kind: "web", id: "caller" },
                  recordedAt: at,
                },
                transition: {
                  kind: "delivery.accept",
                  expectedTaskRevision: after.tasks.find(
                    (t) => t.taskId === m.request.target.taskId,
                  )?.revision,
                  proof: retained.detail.proof,
                },
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* m.f.state()).toEqual(after);
        expect(m.counts().writes).toBe(1);
      }),
    ),
);
it.effect(
  "later source grant revocation preserves accepted delivery history while denying dependency use",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* deliveredDependencyFixture();
        yield* f.assertDependencies;
        const before = yield* f.m.f.state();
        const retained = readDeliveryAcceptance(
          before,
          f.m.request.target.taskId,
          f.receipt.operationId,
        );
        const grant = before.foundationRecords?.find(
          (r) => r.kind === "gate" && r.verificationJobId === f.m.f.prepared.manifest.jobId,
        );
        if (grant?.kind !== "gate" || !retained)
          return yield* Effect.die("Missing original delivery grant");
        yield* f.m.f.repository.execute(
          decodeCommit({
            type: "project-work.foundation.commit",
            commandId: "accepted-source-revoked",
            projectId,
            expectedRevision: before.revision,
            attribution: grant.attribution,
            committedAt: at,
            records: [
              { ...grant, status: "invalidated", revision: grant.revision + 1, updatedAt: at },
            ],
          }),
        );
        expect((yield* f.assertDependencies.pipe(Effect.result))._tag).toBe("Failure");
        const after = yield* f.m.f.state();
        expect(after.evidence.find((e) => e.evidenceId === retained.evidence.evidenceId)).toEqual(
          retained.evidence,
        );
        expect(yield* f.acceptance.recover(f.receipt.operationId)).toMatchObject({
          _tag: "Accepted",
        });
        expect(yield* f.m.f.state()).toEqual(after);
        expect(f.m.counts().writes).toBe(1);
      }),
    ),
);
it.effect(
  "corrupt unaccepted receipt remains a bounded recovery identity and never grants completion",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const m = yield* makeHumanManagedMergeFixture({ settleReviewRoot: true });
        const receipt = yield* m.service.run(m.mergeInput, m.resolved, m.human, m.ports);
        const before = yield* m.f.state();
        yield* m.f.sql`DROP TRIGGER project_work_managed_merge_immutable`;
        yield* m.f.sql`DROP TRIGGER project_work_managed_merge_status`;
        yield* m.f
          .sql`UPDATE project_work_managed_merge SET receipt_json=json_set(receipt_json,'$.confirmation.mergeCommitSha',${"e".repeat(40)}) WHERE operation_id=${receipt.operationId}`;
        const acceptance = yield* makeProjectTeamDeliveryAcceptance({
          environmentId: "environment",
        }).pipe(Effect.provideService(ProjectWorkPublicationAuthorization, m.authorization));
        expect(yield* acceptance.pending()).toEqual([{ operationId: receipt.operationId }]);
        expect((yield* acceptance.recover(receipt.operationId).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* m.f.state()).toEqual(before);
        expect(m.counts().writes).toBe(1);
      }),
    ),
);
