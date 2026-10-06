// @effect-diagnostics nodeBuiltinImport:off - Disposable SDK JSONL is the retained observation under test.
import { expect, it, vi } from "@effect/vitest";
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
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import {
  canonicalProjectWorkPayload,
  GitCommandError,
  ProjectTeamReviewFindingIntent,
  ProjectTeamReviewFindingProvenance,
  ProjectTeamRecord,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  ProjectTeamRecordRead,
  ProjectWorkCriterionId,
  ProjectTeamGuidedIntent,
  ThreadId,
  ProjectWorkEvidenceId,
  ProjectWorkCommand,
  ProjectWorkRelationship,
} from "@t3tools/contracts";
import {
  scoped,
  attribution,
  projectId,
  taskId,
  at,
  restoreHistoricalBinding,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import {
  makeProjectTeamReviewCompletionProposals,
  ProjectTeamReviewReportOperation,
  ProjectTeamReviewCompletionProposalError,
  type ProjectTeamReviewCompletionProposalManifest,
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
import { snapshotReviewCriterionAssessments } from "./ProjectTeamReviewCriterionAssessments.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import {
  makeProjectWorkVerificationGate,
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "./ProjectWorkVerificationGate.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
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
const establishControlledReviewRoot = (f: Effect.Success<typeof verificationFixture>) =>
  Effect.gen(function* () {
    const state = () => readCurrentState(f.sql, projectId);
    let current = yield* state();
    const old = current.foundationRecords?.find((r) => r.kind === "run-binding");
    const role = current.foundationRecords?.find((r) => r.kind === "role-revision");
    const member = current.foundationRecords?.find((r) => r.kind === "member");
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
    const rootRole = decodeRecord({
      ...role,
      recordId: "review-root-role",
      roleId: "review-root",
      role: "coordinator",
      model: "inclusionai/ling-3.1-flash:free",
      tools: ["pi.read"],
    });
    if (rootRole.kind !== "role-revision") return yield* Effect.die("Invalid controlled root role");
    yield* f.repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        commandId: "review-root-profile",
        projectId,
        expectedRevision: current.revision,
        attribution,
        committedAt: at,
        records: [
          rootRole,
          decodeRecord({
            ...member,
            recordId: "review-root-member",
            roleRevisionId: rootRole.recordId,
            coordinator: true,
          }),
          decodeRecord({ ...limits, recordId: "review-model-limits", model: rootRole.model }),
        ],
      }),
    );
    current = yield* state();
    yield* f.repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        commandId: "review-root-resume",
        projectId,
        expectedRevision: current.revision,
        attribution: { ...attribution, actor: f.principal.actor },
        committedAt: at,
        records: [],
        guided: {
          intent: {
            type: "project-team.task.control",
            commandId: "review-root-resume",
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
      recordId: "review-root-binding",
      status: "reserved",
      revision: 0,
      generation: 1,
      leaseGeneration: 1,
      updatedAt: at,
      attemptId: "review-root-attempt",
      memberId: "review-root-member",
      roleRevisionId: rootRole.recordId,
      threadId: "review-root-thread",
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
      commandId: "review-root-claim",
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
          commandId: "review-root-claim",
          attemptId: binding.attemptId,
          leaseToken: "review-root-lease",
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
      dispatchId: "review-root-dispatch",
      claim: rootClaim,
      git: {
        effectId: "review-root-dispatch",
        runId: binding.recordId,
        generation: binding.generation,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: workspace,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "review-root-owner",
        policyHash: "b".repeat(64),
      },
      setupId: "review-root-setup",
      initializeOperationId: "review-root-initialize",
      assignmentOperationId: "review-root-assignment",
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
      operationId: "review-root-initialize",
      threadId: binding.threadId,
    };
    const initialize = yield* operations.prepare(
      { providerInstanceId: binding.providerInstanceId, threadId: binding.threadId },
      request,
      digest(canonical(request)),
      {
        allocation,
        workerId: "review-root-worker",
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
      sessionId: "controlled-review-root",
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
  outcome: "success" | "failed",
) =>
  Effect.gen(function* () {
    const current = yield* readCurrentState(f.sql, projectId);
    const gate = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
    );
    if (gate?.kind !== "gate") return yield* Effect.die("Missing approved verification gate");
    const job = f.prepared.manifest;
    const nonce = "22222222-2222-4222-8222-222222222222";
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
      integration: false,
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
const makeFindingFixture = (coherentCustody = false, verificationOutcome?: "success" | "failed") =>
  Effect.gen(function* () {
    const initial = yield* verificationFixture;
    const f = coherentCustody
      ? yield* establishControlledReviewRoot(initial)
      : { ...initial, reviewRootBindingId: undefined };
    const controlledWorkspace = coherentCustody
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
      source: { kind: "web" as const, id: "findings-fixture" },
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
      commandId: "findings-verification-propose",
    });
    yield* repository.execute(
      yield* auth
        .intent(f.principal, proposal, human, false)
        .pipe(
          Effect.provideService(
            ProjectWorkVerificationApproval,
            trust(f.selection.expectedRevision),
          ),
        ),
    );
    let current = yield* state();
    const verificationGate = current.foundationRecords?.find(
      (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
    );
    if (verificationGate?.kind !== "gate")
      return yield* Effect.die("Missing original human verification gate");
    const response = decodeTeamIntent({
      type: "project-team.gate.respond",
      commandId: "findings-verification-approve",
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
    yield* repository.execute(
      yield* auth
        .intent(f.principal, response, human, false)
        .pipe(
          Effect.provideService(ProjectWorkVerificationApproval, trust(current.revision)),
          Effect.provideService(
            ProjectWorkVerificationRequest,
            ProjectWorkVerificationRequest.of({ assertCurrent: () => Effect.void }),
          ),
        ),
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
      recordId: "review-role",
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
      yield* commitRecords("findings-review-model-policy", [
        decodeRecord({ ...configured, recordId: "review-model-limits", model: reviewRole.model }),
      ]);
    }
    yield* commitRecords("findings-review-member", [
      reviewRole,
      decodeRecord({ ...member, recordId: "review-member", roleRevisionId: "review-role" }),
    ]);
    current = yield* state();
    yield* repository.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        commandId: "findings-assignment",
        projectId,
        expectedRevision: current.revision,
        attribution: human,
        committedAt: at,
        records: [],
        guided: {
          intent: {
            type: "project-team.assignment.start",
            commandId: "findings-assignment",
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
      (r) => r.kind === "gate" && r.gate === "assignment" && r.taskId !== parent.taskId,
    );
    const child = current.tasks.find(
      (t) => t.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
    );
    if (grant?.kind !== "gate" || !child) return yield* Effect.die("Missing original review child");
    const binding = decodeRecord({
      kind: "run-binding",
      projectId,
      recordId: "review-binding",
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "reserved",
      taskId: child.taskId,
      attemptId: "review-attempt",
      memberId: "review-member",
      roleRevisionId: "review-role",
      providerInstanceId: "pi",
      threadId: "review-thread",
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
      commandId: "findings-review-claim",
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
          commandId: "findings-review-claim",
          attemptId: binding.attemptId,
          leaseToken: "review-lease",
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: at,
        },
      },
    });
    const reservation = yield* journal.reserve({
      dispatchId: "review-dispatch",
      claim,
      git: {
        effectId: "review-dispatch",
        runId: binding.recordId,
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: binding.worktree,
        branchRef: binding.branch,
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "review-owner",
        policyHash: "b".repeat(64),
      },
      setupId: "review-setup",
      initializeOperationId: "review-initialize",
      assignmentOperationId: "review-assignment",
      assignment: "Review the original target",
    });
    const snapshot = yield* journal.claimEffect(reservation.fence);
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
      operationId: "review-initialize",
      threadId: binding.threadId,
      resumeCursor: null,
    };
    const nativeIntent = {
      request,
      binding,
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
      identity: { workerId: "review-worker", generation: 0 },
      operation: { operationId: "review-initialize", operationKind: "initialize" },
      outcome: "success",
      ownerCaptured: true,
      native,
      drain,
      accountingReceipts: [],
    };
    yield* sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
    operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json,native_json,terminal_json)
    VALUES ('review-initialize','environment',${projectId},${binding.recordId},0,${binding.providerInstanceId},${binding.threadId},'review-worker',0,'initialize',${digest(canonical(request))},
      ${binding.recordId},${binding.taskId},1000,100000,'settled',${canonical(nativeIntent)},${canonical(native)},${canonical(terminal)})`;
    yield* sql`INSERT INTO project_team_pi_process (unit,operation_id,allocation_json,status,owner_json,drain_json)
    VALUES (${allocation.unit},'review-initialize',${canonical(allocation)},'drained',${canonical(owner)},${canonical(drain)})`;
    const freshness = yield* makeProjectTeamReviewFreshness({ environmentId: "environment" });
    yield* freshness.capture({
      projectId,
      taskId: binding.taskId,
      bindingId: binding.recordId,
      generation: 0,
      providerInstanceId: binding.providerInstanceId,
      threadId: binding.threadId,
      operationId: "review-initialize",
      specRevision: binding.specRevision,
      planRevision: 0,
      sessionDirectoryRoot,
      expectedCwd: binding.worktree,
      native,
      expectedBriefing: briefing,
      assertCurrent: Effect.void,
    });
    const running = decodeRecord({
      ...binding,
      status: "running",
      sessionId: native.sessionId,
      revision: 1,
      ...(coherentCustody ? { updatedAt: DateTime.formatIso(yield* DateTime.now) } : {}),
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
    Effect.provide(Layer.fresh(ProjectWorkProjectionLive.pipe(Layer.provideMerge(gatewayRuntime)))),
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

it.effect(
  "failed owning COMMIT cannot expose a finding or successful receipt before connection cleanup; exact retry works",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* fixture;
        const gateway = yield* ProjectWorkGateway;
        const query = yield* ProjectWorkQuery;
        const intent = yield* f.report();
        const before = yield* f.state();
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
          { count: 1 },
        ]);
        expect(
          (yield* query
            .listFoundationRecords({ projectId, kinds: ["review-finding"] })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* gateway
            .read({ projectId, operation: "foundation-records", recordKinds: ["review-finding"] })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        // Disposable test connection only; production callers never manually clean a foreign loan.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
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
const makeProposalFixture = (coherentCustody = false, verificationOutcome?: "success" | "failed") =>
  Effect.gen(function* () {
    const f = yield* makeFindingFixture(coherentCustody, verificationOutcome);
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
        receiptId: "proposal-stage-" + stage,
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
    yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${canonical(originalInitialize)},root_binding_id=${root.recordId},root_task_id=${root.taskId},maximum_tokens=${operationLimits.maximumTokens},deadline_at_ms=${operationLimits.deadlineAtMs} WHERE operation_id='review-initialize'`;
    const request = {
      kind: "prompt",
      operationId: "review-assignment",
      threadId: f.running.threadId,
      prompt: "Review the original target",
      resumeCursor: f.native,
    };
    const intent = { ...originalInitialize, request, binding: f.running };
    yield* f.sql`INSERT INTO project_team_pi_operation (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
    operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
    VALUES ('review-assignment','environment',${projectId},${f.running.recordId},0,${f.running.providerInstanceId},${f.running.threadId},'review-assignment-worker',1,'prompt',${digest(canonical(request))},
    ${root.recordId},${root.taskId},${operationLimits.maximumTokens},${operationLimits.deadlineAtMs},'running',${canonical(intent)})`;
    // Synthetic retained custody only; no process is started by this fixture.
    const allocation = coherentCustody
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
    yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${canonical(assignedIntent)} WHERE operation_id='review-assignment'`;
    yield* f.sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status,owner_json) VALUES (${allocation.unit},'review-assignment',${canonical(allocation)},'captured',${canonical(assignmentOwner)})`;
    const operation = {
      environmentId: "environment",
      projectId,
      reviewTaskId: task.taskId,
      bindingId: f.running.recordId,
      generation: 0,
      providerInstanceId: f.running.providerInstanceId,
      threadId: f.running.threadId,
      operationId: "review-assignment",
      operationKind: "prompt" as const,
      workerId: "review-assignment-worker",
      ordinal: 1,
    };
    const criteria = current.criteria.filter(
      (c) =>
        c.taskId === task.taskId &&
        (c.required || task.specification?.criterionIds.includes(c.criterionId)),
    );
    const report = decodeCompletionReport({
      type: "project-team.assignment.report",
      commandId: "review-completion-report",
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
    readonly verificationOutcome?: "success" | "failed";
  } = {},
) =>
  Effect.gen(function* () {
    const f = yield* makeProposalFixture(true, options.verificationOutcome);
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
    const originalReceipt = yield* sessions.readAssignment(f.proposalSnapshot);
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
      receiptId: "review-original-joined",
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
      prompt,
      reservation,
      referenceId,
      criterion,
    };
  });
const consumedReviewFixture = makeConsumedReviewFixture();
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
          settled.criteria.filter((criterion) => criterion.taskId === f.selection.taskId),
        ).toEqual(before.criteria.filter((criterion) => criterion.taskId === f.selection.taskId));
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
        expect(
          after.criteria.filter((criterion) => criterion.taskId === f.selection.taskId),
        ).toEqual(before.criteria.filter((criterion) => criterion.taskId === f.selection.taskId));
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
  "completed assessment qualification retains a negative review of failed verification",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* makeConsumedReviewFixture({
          parentAssessment: true,
          assessmentVerdict: "not-met",
          verificationOutcome: "failed",
        });
        const before = yield* f.state();
        expect((yield* f.prepare())?.status).toBe("completed");
        expect(yield* f.state()).toEqual(before);
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
        expect(after.criteria.filter((c) => c.taskId === f.selection.taskId)).toEqual(
          before.criteria.filter((c) => c.taskId === f.selection.taskId),
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
  "integrated completed review settlement failed COMMIT exposes no successful completion or public snapshot before owned cleanup",
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
        ).toBeGreaterThan(0);
        expect((yield* query.snapshot(projectId).pipe(Effect.exit))._tag).toBe("Failure");
        expect(
          (yield* gateway
            .read({ projectId, operation: "foundation-records", recordKinds: ["review-finding"] })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        // Only this disposable test owns the connection loan; production never rolls back a foreign loan.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
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
        expect(yield* readProposal(f)).toBeUndefined();
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
  "pending criterion assessment failed owning COMMIT exposes no successful receipt or public state before cleanup",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* parentAssessmentFixture;
        const gateway = yield* ProjectWorkGateway;
        const query = yield* ProjectWorkQuery;
        const before = yield* f.state();
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
          { count: 1 },
        ]);
        expect((yield* readProposal(f).pipe(Effect.exit))._tag).toBe("Failure");
        expect(
          (yield* gateway
            .read({ projectId, operation: "foundation-records", recordKinds: ["review-finding"] })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect((yield* query.snapshot(projectId).pipe(Effect.exit))._tag).toBe("Failure");
        // This disposable connection loan is owned by the test; production never rolls back a foreign loan.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* f.sql.reserve;
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
        expect(yield* readProposal(f)).toBeUndefined();
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
