// @effect-diagnostics nodeBuiltinImport:off - Disposable SDK JSONL and controlled retained custody only.
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import * as Option from "effect/Option";
import { expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import {
  canonicalProjectWorkPayload,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  GitCommandError,
  ProjectTeamReviewFindingIntent,
  ProjectTeamRecord,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  ProjectTeamGuidedIntent,
  ThreadId,
  ProjectWorkEvidenceId,
  ProjectWorkCommand,
  ProjectWorkTaskId,
  ProjectTeamIntegrationSourceRef,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import {
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
} from "./ProjectTeamReviewCompletionProposals.ts";
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
import {
  verificationFixture,
  makeVerificationFixture,
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
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import { PROJECT_TASK_MEMORY_BYTES } from "./ProjectTaskResources.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
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
const decodeControlledWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
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
    const allocated = yield* preallocatePiManagedProcess({
      workspaceRoot: controlledWorkspace ?? workspace,
      workspaceAccess: "readonly",
      nativeStateRoot: nativeRoot,
      protectedRoots: [NodePath.join(root, "protected")],
      runtimeFiles: [{ source: yield* fs.realPath("/usr/bin/true"), target: "/bin/true" }],
      argv: ["/bin/true"],
      memoryBytes: 33554432,
      runtimeSeconds: 10,
    });
    // Current retained operation readers require the exact reviewed mount descriptor.
    // These are controlled historical custody facts, matching the original receipt;
    // no physical worker or target loan is manufactured by the fixture.
    const allocation = {
      ...allocated,
      launch: {
        ...allocated.launch,
        reviewTarget: {
          source: target.prepared.manifest.target.worktree,
          target: "/review-target" as const,
          targetHash: digest(canonical(target)),
          manifestHash: target.prepared.sha256,
          testedCommit: target.prepared.manifest.target.testedCommit,
          testedTree: target.prepared.manifest.target.testedTree,
          dev: Number(f.receipt.worktree.dev),
          ino: Number(f.receipt.worktree.ino),
        },
      },
    };
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
    const allocated =
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
    const allocation = {
      ...allocated,
      launch: { ...allocated.launch, reviewTarget: f.allocation.launch.reviewTarget },
    };
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
const decodeIntegrationSourceRef = Schema.decodeUnknownEffect(
  ProjectTeamIntegrationSourceRef,
  strict,
);

import { makeProjectTeamReviewedWorkReader } from "./ProjectTeamReviewedWorkReader.ts";

const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(ProjectTeamWorkspaceReceipt));

// Retain real authorization, verification and joined SQL history with controlled custody.
// No worker, Git command or network request runs in these fixtures.
const readerFixture = Effect.gen(function* () {
  const f = yield* makeConsumedReviewFixture({ verificationOutcome: "success" });
  const ref = yield* completeIntegrationSourceReview(f);
  const reader = yield* makeProjectTeamReviewedWorkReader({ environmentId: "environment" });
  const rows = yield* f.sql<{
    receipt_json: string;
  }>`SELECT receipt_json FROM project_team_workspace_receipt WHERE dispatch_id=${f.prepared.manifest.dispatchId}`;
  const receipt = yield* decodeControlledWorkspace(rows[0]!.receipt_json);
  const encoded = encodeWorkspace(receipt);
  expect(encoded).not.toBe(canonical(receipt));
  expect(digest(canonical(receipt))).toBe(f.prepared.manifest.workspaceReceiptHash);
  const read = () => f.sql.withTransaction(reader.readCurrentInTransaction({ projectId, ref }));
  const canonicalSource = yield* read();
  expect(canonicalSource.source).toMatchObject({
    bindingId: f.prepared.manifest.bindingId,
    workspaceReceiptSha256: f.prepared.manifest.workspaceReceiptHash,
    headSha: f.prepared.manifest.target.headSha,
    reviewDispatchId: f.proposalSnapshot.fence.dispatchId,
  });
  // Only disposable SQLite is altered to exercise alternate retained bytes and corruption.
  yield* f.sql`DROP TRIGGER project_team_workspace_receipt_immutable`;
  const replace = (bytes: string) =>
    f.sql`UPDATE project_team_workspace_receipt SET receipt_json=${bytes} WHERE dispatch_id=${f.prepared.manifest.dispatchId}`;
  return { f, ref, reader, receipt, encoded, read, replace, canonicalSource };
});

it.effect(
  "reviewed work admits production-encoded and canonical ownership receipts through real SQL history",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* readerFixture;
        yield* f.replace(f.encoded);
        expect(yield* f.read()).toEqual(f.canonicalSource);
        expect(
          yield* f.f.sql.withTransaction(
            f.reader.withCurrentInTransaction({ projectId }, (read) => read(f.ref)),
          ),
        ).toEqual(f.canonicalSource);
        yield* f.replace(canonical(f.receipt));
        expect(yield* f.read()).toEqual(f.canonicalSource);
      }),
    ),
);

for (const mutation of ["semantic", "assignment", "invalid", "excess", "nested-excess"] as const) {
  it.effect(
    `reviewed work rejects ${mutation} ownership receipts after authentic history admission`,
    () =>
      scopedGateway(
        Effect.gen(function* () {
          const f = yield* readerFixture;
          const mutated =
            mutation === "semantic"
              ? { ...f.receipt, initialHeadOid: "e".repeat(40) }
              : mutation === "assignment"
                ? {
                    ...f.receipt,
                    assignment: { ...f.receipt.assignment, ownershipToken: "foreign-owner" },
                  }
                : mutation === "invalid"
                  ? { ...f.receipt, worktree: { ...f.receipt.worktree, ino: 123 } }
                  : mutation === "nested-excess"
                    ? { ...f.receipt, worktree: { ...f.receipt.worktree, extra: true } }
                    : { ...f.receipt, extra: true };
          yield* f.replace(canonical(mutated));
          expect(yield* f.read().pipe(Effect.flip)).toMatchObject(
            mutation === "semantic" || mutation === "assignment"
              ? {
                  _tag: "ProjectTeamIntegrationSourcesError",
                  code: "ineligible",
                  reason: "Original source physical ownership changed",
                }
              : {
                  _tag: "ProjectTeamIntegrationSourcesError",
                  code: "unavailable",
                  reason: "Integration source history is unavailable",
                },
          );
          yield* f.replace(f.encoded);
          expect(yield* f.read()).toEqual(f.canonicalSource);
        }),
      ),
  );
}

it.effect(
  "reviewed work retains caller authority and assignment guards with production receipt encoding",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* readerFixture;
        yield* f.replace(f.encoded);
        const input = { projectId, ref: f.ref };
        expect(yield* f.reader.readCurrentInTransaction(input).pipe(Effect.flip)).toMatchObject({
          code: "invalid",
        });
        expect(
          yield* f.f.sql
            .withTransaction(
              f.reader
                .readCurrentInTransaction(input)
                .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.f.sql })),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "invalid" });
        expect(
          yield* f.f.sql
            .withTransaction(
              f.reader
                .readCurrentInTransaction(input)
                .pipe(Effect.provideService(ProjectWorkRepository, { ...f.f.repository })),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "invalid" });
        const changedRef = { ...f.ref, expectedHeadSha: "e".repeat(40) };
        expect(
          yield* f.f.sql
            .withTransaction(f.reader.readCurrentInTransaction({ projectId, ref: changedRef }))
            .pipe(Effect.flip),
        ).toMatchObject({
          code: "ineligible",
          reason: "Review and verification do not describe the exact selected source",
        });
        yield* f.f
          .sql`UPDATE project_team_workspace_receipt SET assignment_json=${canonical({ ...f.receipt.assignment, ownershipToken: "foreign-owner" })} WHERE dispatch_id=${f.f.prepared.manifest.dispatchId}`;
        expect(yield* f.read().pipe(Effect.flip)).toMatchObject({
          code: "ineligible",
          reason: "Original source ownership receipt changed",
        });
      }),
    ),
);
