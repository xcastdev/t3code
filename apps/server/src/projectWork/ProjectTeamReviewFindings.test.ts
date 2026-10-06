// @effect-diagnostics nodeBuiltinImport:off - Disposable SDK JSONL is the retained observation under test.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import {
  canonicalProjectWorkPayload,
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
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import {
  makeProjectWorkVerificationGate,
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "./ProjectWorkVerificationGate.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { makeProjectWorkArtifacts } from "./ProjectWorkArtifacts.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { executePiProjectWorkBridgeTool } from "../provider/pi/PiProjectWorkTools.ts";
import { preallocatePiManagedProcess } from "../provider/pi/PiManagedProcess.ts";

const canonical = canonicalProjectWorkPayload;
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const decodeIntent = Schema.decodeUnknownSync(ProjectTeamReviewFindingIntent, strict);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, strict);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord, strict);
const decodeTeamIntent = Schema.decodeUnknownSync(ProjectTeamWriteIntent, strict);
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
const fixture = Effect.gen(function* () {
  const f = yield* verificationFixture;
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
        Effect.provideService(ProjectWorkVerificationApproval, trust(f.selection.expectedRevision)),
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
    recordId: "review-role",
    roleId: "reviewer",
    role: "reviewer",
    tools: ["pi.read", "project-work.report"],
  });
  if (reviewRole.kind !== "role-revision") return yield* Effect.die("Invalid review role");
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
    worktree: "/workspace-assigned",
    branch: "refs/heads/assigned",
    leaseGeneration: 0,
    specRevision: child.specRevision,
    planRevision: 0,
    authorizationGateId: grant.recordId,
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
    workspaceRoot: workspace,
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
const proposalFixture = Effect.gen(function* () {
  const f = yield* fixture;
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
      (r) => r.kind === "run-binding" && r.taskId === rootBudget.rootTaskId,
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
  const allocation = { ...f.allocation, unit: f.allocation.unit + "-assignment" };
  const assignedIntent = { ...intent, allocation };
  yield* f.sql`UPDATE project_team_pi_operation SET intent_json=${canonical(assignedIntent)} WHERE operation_id='review-assignment'`;
  yield* f.sql`INSERT INTO project_team_pi_process(unit,operation_id,allocation_json,status,owner_json) VALUES (${allocation.unit},'review-assignment',${canonical(allocation)},'captured',${canonical({ ...f.owner, unit: allocation.unit, cgroup: "/sys/fs/cgroup/" + allocation.unit })})`;
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
  return { ...f, proposals, operation, completionReport: report, compileProposal: compile };
});
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
  "proposal insertion failure rolls back the public receipt and leaves an exact original retry available",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const before = yield* f.state();
        yield* f.sql`CREATE TRIGGER reject_pending_proposal BEFORE INSERT ON project_team_review_completion_proposal BEGIN SELECT RAISE(ABORT,'controlled proposal storage failure'); END`;
        expect((yield* completionTool(f).pipe(Effect.exit))._tag).toBe("Failure");
        expect(yield* readProposal(f)).toBeUndefined();
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM project_work_command_receipts WHERE command_id=${f.completionReport.commandId}`,
        ).toEqual([{ count: 0 }]);
        yield* f.sql`DROP TRIGGER reject_pending_proposal`;
        yield* completionTool(f);
        expect(yield* readProposal(f)).toBeDefined();
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "failed owning COMMIT exposes no successful proposal receipt or public state before owned test cleanup",
  () =>
    scopedGateway(
      Effect.gen(function* () {
        const f = yield* proposalFixture;
        const gateway = yield* ProjectWorkGateway;
        const query = yield* ProjectWorkQuery;
        const before = yield* f.state();
        yield* f.sql`CREATE TABLE proposal_commit_parent(id TEXT PRIMARY KEY)`;
        yield* f.sql`CREATE TABLE proposal_commit_child(id TEXT REFERENCES proposal_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        yield* f.sql`CREATE TRIGGER proposal_commit_failure AFTER INSERT ON project_team_review_completion_proposal BEGIN INSERT INTO proposal_commit_child VALUES ('missing'); END`;
        let escaped = false;
        expect(
          (yield* completionTool(f).pipe(
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
        yield* completionTool(f);
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
