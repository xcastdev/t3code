// @effect-diagnostics nodeBuiltinImport:off - Disposable SDK JSONL is the retained observation under test.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import {
  canonicalProjectWorkPayload,
  ProjectTeamReviewFindingIntent,
  ProjectTeamRecord,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  ProjectTeamRecordRead,
  ProjectWorkCriterionId,
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
