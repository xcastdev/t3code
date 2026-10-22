import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  ProviderDriverKind,
  NodeId,
  RunAttemptId,
  ProjectVerificationJobManifest,
  ProjectTeamMemorySourcesRead,
  ProjectMemorySource,
  ProjectTeamRunBinding,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Runner from "../processRunner.ts";
import * as Runtime from "./ProjectWorkRuntime.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Admission from "./ProjectWorkRunAdmission.ts";
import * as Journal from "./ProjectTeamDispatchJournal.ts";
import { makeHarness } from "./ProjectTeamDispatch.testkit.ts";
import { setup as gitFixture, output } from "./ProjectWorkVerification.testFixtures.ts";
import {
  runtimeExternalServices,
  seed,
  awaitPreparation,
  at,
  attribution,
  projectId,
  modelSelection,
} from "./ProjectWorkWorkflow.testkit.ts";

const environmentId = EnvironmentId.make("dispatch-environment");
const human = { actor: attribution.actor, source: attribution.source, projectId, environmentId };
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    kind: Schema.Literal("verification-job"),
    manifest: ProjectVerificationJobManifest,
    sha256: Schema.String,
  }),
);
const decodeMemoryCandidates = Schema.decodeUnknownEffect(ProjectTeamMemorySourcesRead);
const decodeMemoryCurrent = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(ProjectMemorySource) }),
);
const authenticate = Effect.gen(function* () {
  yield* (yield* AuthSessions.AuthSessionRepository).create({
    sessionId: AuthSessionId.make("client"),
    subject: "maintainer",
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie",
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: DateTime.makeUnsafe(at),
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
  });
});

const scenario = Effect.fn("WorkflowIntegration.scenario")(function* (
  changeSource = false,
  captureMemory = false,
  review = false,
  retirePlan = false,
) {
  const f = yield* gitFixture();
  f.git(["tag", "base"]);
  const harness = makeHarness({
    providers: [
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: at,
        models: [
          { slug: modelSelection.model, name: "Fixture", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  });
  harness.createWorktree.mockImplementation(() =>
    Effect.succeed({ worktree: { path: f.repo, refName: "main" } }),
  );
  harness.renameBranch.mockImplementation((input) =>
    Effect.sync(() => {
      f.git(["branch", "-m", input.newBranch]);
      return { branch: input.newBranch };
    }),
  );
  let executions = 0;
  const runner = Layer.succeed(
    Runner.ProcessRunner,
    Runner.ProcessRunner.of({
      run: (request) =>
        Effect.sync(() => {
          if (request.command === "git") return { ...output, stdout: f.git(request.args) };
          executions++;
          assert.equal(request.command, process.execPath);
          assert.deepStrictEqual(request.args, ["source"]);
          assert.equal(request.cwd, f.repo);
          assert.equal(request.extendEnv, false);
          if (changeSource) f.changeHead();
          return output;
        }),
    }),
  );
  const base = Layer.mergeAll(
    Repository.ProjectWorkRepositoryLive,
    Admission.layer,
    Journal.layer,
    AuthSessions.layer,
  ).pipe(Layer.provideMerge(harness.layer));
  const runtime = Runtime.executionLayer.pipe(
    Layer.provideMerge(base),
    Layer.provide(
      Layer.mergeAll(
        runtimeExternalServices(harness, runner),
        Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
  return yield* Effect.gen(function* () {
    const input = yield* seed({ type: "worktree", baseRef: "refs/tags/base" });
    yield* authenticate;
    const gateway = yield* Gateway.ProjectWorkGateway;
    yield* gateway.write(input, human);
    const { sql, binding: preparedBinding, state, projection } = yield* awaitPreparation;
    assert.equal(preparedBinding.worktree, f.repo);
    assert.equal(projection.runs.length, 1);
    // The fake provider owns these observations; Work authorization and execution remain real.
    if (preparedBinding.runId === undefined) return yield* Effect.die("Missing admitted run");
    const nodeId = NodeId.make("fixture-node");
    const binding = {
      ...preparedBinding,
      runId: preparedBinding.runId,
      nodeId,
      runAttemptId: RunAttemptId.make("fixture-native-attempt"),
      revision: preparedBinding.revision + 1,
    };
    yield* sql.withTransaction(
      Repository.appendAdmissionFoundationRecords(
        sql,
        projectId,
        "fixture-native-observation",
        [binding],
        at,
      ),
    );
    yield* sql`UPDATE t3_workflow_v2_run_admissions SET run_attempt_id=${binding.runAttemptId} WHERE binding_id=${binding.recordId}`;
    const node = {
      id: nodeId,
      threadId: binding.threadId,
      runId: binding.runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: "fixture-checkpoint",
      startedAt: at,
      completedAt: at,
    };
    yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({ node_id: nodeId, thread_id: binding.threadId, run_id: binding.runId, parent_node_id: null, root_node_id: nodeId, kind: "root_turn", status: "completed", provider_thread_id: null, provider_turn_id: null, runtime_request_id: null, checkpoint_scope_id: "fixture-checkpoint", started_at: at, completed_at: at, payload_json: JSON.stringify(node) })}`;
    const task = state.tasks.find((t) => t.taskId === binding.taskId)!;
    const plan = state.foundationRecords!.find(
      (r) => r.kind === "plan-revision" && r.taskId === task.taskId,
    );
    assert.equal(plan?.kind, "plan-revision");
    const criterionId = state.criteria.find((c) => c.taskId === task.taskId)!.criterionId;
    const current = yield* Repository.readCurrentState(sql, projectId);
    const proposal = {
      type: "project-team.verification.propose" as const,
      projectId,
      commandId: CommandId.make("propose-verification"),
      taskId: task.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks.find((t) => t.taskId === task.taskId)!.revision,
      specRevision: task.specRevision,
      planRevision: plan?.kind === "plan-revision" ? plan.planRevision : 0,
      jobId: "runtime-verification",
      bindingId: binding.recordId,
      expectedBindingRevision: binding.revision,
      generation: binding.generation,
      criterionIds: [criterionId],
      command: {
        executable: process.execPath,
        argv: ["source"],
        environment: "clean" as const,
        limits: { maxDurationMs: 1000, maxOutputBytes: 4096 },
      },
    };
    assert.equal(
      (yield* gateway
        .write(proposal, { ...human, source: { kind: "web", id: "unretained-session" } })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(executions, 0);
    yield* gateway.write(proposal, human);
    const retained = yield* decodeManifest(
      yield* gateway.read(
        {
          operation: "verification-job",
          projectId,
          taskId: task.taskId,
          verificationJobId: proposal.jobId,
        },
        human,
      ),
    );
    assert.equal(retained.manifest.bindingId, binding.recordId);
    assert.equal(retained.manifest.target.worktree, f.repo);
    const prepared = yield* Repository.readCurrentState(sql, projectId);
    const gate = prepared.foundationRecords!.find(
      (r) => r.kind === "gate" && r.recordId === `verification:${proposal.jobId}`,
    );
    if (gate?.kind !== "gate") return yield* Effect.die("Missing prepared verification gate");
    const approval = {
      type: "project-team.gate.respond",
      projectId,
      commandId: CommandId.make("approve-verification"),
      taskId: task.taskId,
      expectedRevision: prepared.revision,
      expectedTaskRevision: prepared.tasks.find((t) => t.taskId === task.taskId)!.revision,
      specRevision: task.specRevision,
      planRevision: proposal.planRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      response: "approved",
    } as const;
    if (retirePlan) {
      if (plan?.kind !== "plan-revision") return yield* Effect.die("Missing current plan");
      yield* gateway.write(
        {
          type: "project-team.plan.propose",
          projectId,
          commandId: CommandId.make("replace-verification-plan"),
          taskId: task.taskId,
          expectedRevision: prepared.revision,
          expectedTaskRevision: prepared.tasks.find((t) => t.taskId === task.taskId)!.revision,
          specRevision: task.specRevision,
          content: "Current replacement plan",
          dependencyTaskIds: [],
          previousPlanId: plan.recordId,
          expectedPreviousPlanRevision: plan.revision,
        },
        human,
      );
      const replaced = yield* Repository.readCurrentState(sql, projectId);
      assert.isTrue(
        replaced.foundationRecords!.some(
          (r) =>
            r.kind === "plan-revision" &&
            r.recordId === plan.recordId &&
            r.status === "retired" &&
            r.planRevision === 0,
        ),
      );
      assert.isTrue(
        replaced.foundationRecords!.some(
          (r) =>
            r.kind === "plan-revision" &&
            r.taskId === task.taskId &&
            r.status === "proposed" &&
            r.planRevision === 1,
        ),
      );
      const oldGate = replaced.foundationRecords!.find(
        (r) => r.kind === "gate" && r.recordId === gate.recordId,
      );
      const currentBinding = replaced.foundationRecords!.find(
        (r) => r.kind === "run-binding" && r.recordId === binding.recordId,
      );
      if (oldGate?.kind !== "gate" || currentBinding?.kind !== "run-binding")
        return yield* Effect.die("Missing retired verification targets");
      assert.equal(
        (yield* gateway
          .write(
            {
              ...approval,
              expectedRevision: replaced.revision,
              expectedTaskRevision: replaced.tasks.find((t) => t.taskId === task.taskId)!.revision,
              expectedGateRevision: oldGate.revision,
            },
            human,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const afterApproval = yield* Repository.readCurrentState(sql, projectId);
      assert.equal(afterApproval.revision, replaced.revision);
      assert.deepStrictEqual(
        afterApproval.foundationRecords!.find(
          (r) => r.kind === "gate" && r.recordId === oldGate.recordId,
        ),
        oldGate,
      );
      assert.equal(
        (yield* gateway
          .write(
            {
              ...proposal,
              commandId: CommandId.make("propose-retired-verification"),
              jobId: "retired-plan-verification",
              expectedRevision: afterApproval.revision,
              expectedTaskRevision: afterApproval.tasks.find((t) => t.taskId === task.taskId)!
                .revision,
              expectedBindingRevision: currentBinding.revision,
            },
            human,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const jobs = yield* sql<{
        stage: string;
      }>`SELECT stage FROM t3_workflow_v2_verification_jobs WHERE project_id=${projectId}`;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.stage, "prepared");
      assert.equal(executions, 0);
      assert.equal(afterApproval.evidence.length, 0);
      return { projectId };
    }
    yield* gateway.write(approval, human);
    yield* gateway.write(approval, human);
    const final = yield* Repository.readCurrentState(sql, projectId);
    const rows = yield* sql<{
      stage: string;
      result_json: string;
    }>`SELECT stage,result_json FROM t3_workflow_v2_verification_jobs WHERE project_id=${projectId} AND job_id=${proposal.jobId}`;
    assert.equal(executions, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.stage, changeSource ? "finished" : "applied");
    assert.equal(JSON.parse(rows[0]!.result_json).outcome, changeSource ? "stale" : "success");
    assert.equal(
      final.evidence.filter((e) => e.evidenceId === `verification:${proposal.jobId}`).length,
      changeSource ? 0 : 1,
    );
    if (!changeSource)
      assert.equal(
        final.evidence.find((e) => e.evidenceId === `verification:${proposal.jobId}`)!.scopeHash,
        binding.scopeHash,
      );
    if (review) yield* reviewScenario(gateway, binding, proposal.jobId);
    if (captureMemory) {
      const candidates = yield* decodeMemoryCandidates(
        yield* gateway.read({ operation: "memory-sources", projectId, taskId: task.taskId }, human),
      );
      const selected = candidates.items.find(
        (i) => i.selection.retainedId === `verification:${proposal.jobId}`,
      );
      assert.isDefined(selected);
      yield* gateway.write(
        {
          type: "project-team.memory.process",
          projectId,
          commandId: CommandId.make("capture-runtime-memory"),
          taskId: task.taskId,
          expectedRevision: final.revision,
          expectedTaskRevision: final.tasks.find((t) => t.taskId === task.taskId)!.revision,
          specRevision: task.specRevision,
          planRevision: proposal.planRevision,
          selection: selected!.selection,
        },
        human,
      );
      const recalled = yield* decodeMemoryCurrent(
        yield* gateway.read(
          { operation: "memory-recall", projectId, taskId: task.taskId, query: "Verification" },
          human,
        ),
      );
      assert.equal(recalled.items.length, 1);
      assert.equal(
        recalled.items[0]!.content,
        final.evidence.find((e) => e.evidenceId === `verification:${proposal.jobId}`)!.detail,
      );
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_memory_sources`).length, 1);
    }
    return { projectId: final.projectId };
  }).pipe(Effect.provide(runtime));
});

it.live(
  "authenticated Work approval executes its host-qualified manifest and atomically retains canonical evidence",
  () => Effect.scoped(scenario()),
);
it.live(
  "source changes during an approved successful command retain stale outcome without canonical evidence",
  () => Effect.scoped(scenario(true)),
);

it.live(
  "production Work memory intent captures verified evidence and recalls current SQL memory with optional processing disabled",
  () => Effect.scoped(scenario(false, true)),
);

const reviewScenario = Effect.fn("WorkflowIntegration.review")(function* (
  gateway: Gateway.ProjectWorkGateway["Service"],
  source: typeof ProjectTeamRunBinding.Type,
  jobId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  let state = yield* Repository.readCurrentState(sql, projectId);
  const membership = state.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === source.taskId,
  );
  if (membership?.kind !== "task-membership") return yield* Effect.die("Missing source assignment");
  yield* sql.withTransaction(
    Repository.appendAdmissionFoundationRecords(
      sql,
      projectId,
      "fixture-source-terminal",
      [
        { ...source, status: "settled", revision: source.revision + 1 },
        { ...membership, deliverableKind: "code", revision: membership.revision + 1 },
      ],
      at,
    ),
  );
  state = yield* Repository.readCurrentState(sql, projectId);
  const sourceTask = state.tasks.find((t) => t.taskId === source.taskId)!;
  yield* gateway.write(
    {
      type: "project-team.assignment.start",
      projectId,
      commandId: CommandId.make("independent-review-assignment"),
      taskId: source.taskId,
      expectedRevision: state.revision,
      expectedTaskRevision: sourceTask.revision,
      assignmentKind: "review",
      objective: "Review the exact verified source",
      outputDescriptions: ["Independent review verdict"],
      specRevision: source.specRevision,
      specificationGateId: "fixture-specification-gate",
      expectedSpecificationGateRevision: 0,
      parentPlan: {
        recordId: "fixture-plan",
        expectedRecordRevision: 0,
        planRevision: source.planRevision,
        gateId: "fixture-plan-gate",
        expectedGateRevision: 0,
      },
    },
    human,
  );
  state = yield* Repository.readCurrentState(sql, projectId);
  const assignment = state.foundationRecords!.find(
    (r) =>
      r.kind === "task-membership" &&
      r.parentTaskId === source.taskId &&
      r.deliverableKind === "review",
  );
  if (assignment?.kind !== "task-membership")
    return yield* Effect.die("Missing independent review assignment");
  const reviewTask = state.tasks.find((t) => t.taskId === assignment.taskId)!;
  const role = state.foundationRecords!.find(
    (r) => r.kind === "role-revision" && r.role === "reviewer",
  );
  const grant = state.foundationRecords!.find(
    (r) => r.kind === "gate" && r.taskId === reviewTask.taskId && r.gate === "assignment",
  );
  if (role?.kind !== "role-revision" || grant?.kind !== "gate")
    return yield* Effect.die("Missing reviewer authorization");
  const member: Extract<ProjectTeamRecord, { kind: "member" }> = {
    kind: "member",
    projectId,
    recordId: "independent-reviewer",
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "active",
    name: "Reviewer",
    coordinator: false,
    roleRevisionId: role.recordId,
  };
  yield* sql.withTransaction(
    Repository.appendAdmissionFoundationRecords(
      sql,
      projectId,
      "configure-reviewer",
      [
        { ...role, model: modelSelection.model, revision: role.revision + 1, delegationDepth: 3 },
        member,
      ],
      at,
    ),
  );
  state = yield* Repository.readCurrentState(sql, projectId);
  yield* gateway.write(
    {
      type: "project-team.dispatch",
      projectId,
      commandId: CommandId.make("dispatch-independent-review"),
      taskId: reviewTask.taskId,
      expectedRevision: state.revision,
      expectedTaskRevision: reviewTask.revision,
      memberId: member.recordId,
      expectedMemberRevision: 0,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      modelSelection,
      workspace: { type: "root" },
      reviewVerificationJobId: jobId,
    },
    human,
  );
  const rows = yield* sql<{
    snapshot_json: string;
  }>`SELECT snapshot_json FROM t3_workflow_v2_team_reviews WHERE project_id=${projectId}`;
  assert.equal(rows.length, 1);
  const snapshot = JSON.parse(rows[0]!.snapshot_json);
  assert.equal(snapshot.reviewer.status, "reserved");
  assert.isUndefined(snapshot.reviewer.runId);
  assert.equal(snapshot.manifest.jobId, jobId);
  assert.notEqual(snapshot.reviewer.memberId, snapshot.source.memberId);
  state = yield* Repository.readCurrentState(sql, projectId);
  assert.isDefined(
    state.foundationRecords!.find(
      (r) => r.kind === "run-binding" && r.taskId === reviewTask.taskId && r.runId !== undefined,
    ),
  );
});
it.live(
  "production reviewer dispatch freezes exact verified source before launching an independent run",
  () => Effect.scoped(scenario(false, false, true)),
);

it.live(
  "a normal plan replacement rejects retired verification proposals and approval before runner execution",
  () => Effect.scoped(scenario(false, false, false, true)),
);
