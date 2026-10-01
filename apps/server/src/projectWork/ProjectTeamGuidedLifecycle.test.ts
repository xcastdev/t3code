import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkRelationshipId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkAttemptId,
  ProviderInstanceId,
  ThreadId,
  EnvironmentId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import { assertProjectTeamGuidedReplayCurrent } from "./ProjectTeamGuidedLifecycle.ts";
import {
  assertProjectTeamRunAuthority,
  projectTeamScopeHash,
  projectTeamSpecificationHash,
} from "./ProjectTeamPolicy.ts";

const projectId = ProjectId.make("guided-project");
const taskId = ProjectWorkTaskId.make("guided-task");
const at = "2026-01-01T00:00:00.000Z";
const attribution = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const, id: "client" },
  recordedAt: at,
};
const initial = () =>
  applyProjectWorkEvents(
    emptyProjectWorkReducerState(projectId),
    decideProjectWorkCommand(emptyProjectWorkReducerState(projectId), {
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make("capture"),
      title: "Unspecified issue",
      createdAt: at,
    }),
  );
const envelope = (state: ProjectWorkReducerState, id: string, targetId = taskId) => ({
  projectId,
  taskId: targetId,
  commandId: CommandId.make(id),
  expectedRevision: state.revision,
  expectedTaskRevision: state.tasks.find((t) => t.taskId === targetId)!.revision,
});
const compile = (
  intent: ProjectTeamGuidedIntent,
): Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> => ({
  type: "project-work.foundation.commit",
  projectId,
  commandId: intent.commandId,
  expectedRevision: intent.expectedRevision,
  attribution,
  records: [],
  committedAt: at,
  guided: { intent },
});
const run = (state: ProjectWorkReducerState, intent: ProjectTeamGuidedIntent) =>
  applyProjectWorkEvents(state, decideProjectWorkCommand(state, compile(intent)));
const investigate = (state = initial()) =>
  run(state, {
    ...envelope(state, "investigate"),
    type: "project-team.investigation.start",
    objective: "Find the cause without editing",
    outputDescriptions: ["Retained sourced findings"],
  });
const propose = (state = initial()) =>
  run(state, {
    ...envelope(state, "spec"),
    type: "project-team.specification.propose",
    expectedSpecRevision: 0,
    specification: {
      objective: "Deliver bounded fix",
      scopeIn: "One behavior",
      scopeOut: "Other behavior",
      criterionIds: [ProjectWorkCriterionId.make("acceptance")],
      revision: 1,
      protected: false,
    },
    criterionSnapshots: [
      {
        criterionId: ProjectWorkCriterionId.make("acceptance"),
        taskId,
        description: "Behavior verified",
        required: true,
        status: "unsatisfied",
        satisfiedByEvidenceIds: [],
        revision: 0,
        updatedAt: at,
      },
    ],
  });
const approveGates = (state: ProjectWorkReducerState) => {
  const records = state
    .foundationRecords!.filter(
      (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
        r.kind === "gate" && r.status === "pending",
    )
    .map((r) => ({ ...r, revision: r.revision + 1, status: "approved" as const }));
  return applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make(`approve-${state.revision}`),
      expectedRevision: state.revision,
      records,
      attribution,
      committedAt: at,
    }),
  );
};
const planned = () => {
  let state = approveGates(propose());
  state = run(state, {
    ...envelope(state, "plan"),
    type: "project-team.plan.propose",
    specRevision: 1,
    content: "Bounded implementation and validation",
    dependencyTaskIds: [],
  });
  return approveGates(state);
};
const startIntent = (
  state: ProjectWorkReducerState,
): Extract<ProjectTeamGuidedIntent, { type: "project-team.execution.start" }> => {
  const plan = state.foundationRecords!.find((r) => r.kind === "plan-revision")!;
  const specGate = state.foundationRecords!.find(
    (r) => r.kind === "gate" && r.gate === "specification",
  )!;
  const planGate = state.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan")!;
  return {
    ...envelope(state, "execute"),
    type: "project-team.execution.start",
    specRevision: 1,
    planRevision: 1,
    specGateId: specGate.recordId,
    expectedSpecGateRevision: specGate.revision,
    planId: plan.recordId,
    expectedPlanRecordRevision: plan.revision,
    planGateId: planGate.recordId,
    expectedPlanGateRevision: planGate.revision,
  };
};
const activeRun = () => {
  let state = planned();
  state = run(state, startIntent(state));
  const role: Extract<ProjectTeamRecord, { kind: "role-revision" }> = {
    recordId: "implementer-role",
    projectId,
    kind: "role-revision",
    status: "available",
    revision: 0,
    generation: 0,
    updatedAt: at,
    roleId: "implementer",
    roleRevision: 0,
    role: "implementer",
    instructions: "Implement bounded scope",
    skills: [],
    tools: ["project-work", "project-work.report", "read", "write"],
    model: "fixture-model",
    memoryAccess: "project",
    delegationDepth: 0,
  };
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("role-member"),
      expectedRevision: state.revision,
      attribution,
      committedAt: at,
      records: [
        role,
        {
          recordId: "worker",
          projectId,
          kind: "member",
          status: "active",
          revision: 0,
          generation: 0,
          updatedAt: at,
          name: "Worker",
          coordinator: false,
          roleRevisionId: role.recordId,
        },
      ],
    }),
  );
  const grant = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.gate === "execution",
  )!;
  const spec = state.foundationRecords!.find(
    (r) => r.kind === "gate" && r.gate === "specification",
  )!;
  const plan = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
      r.kind === "plan-revision" && r.status === "proposed",
  )!;
  const planGate = state.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "plan")!;
  const binding: Extract<ProjectTeamRecord, { kind: "run-binding" }> = {
    recordId: "run",
    projectId,
    kind: "run-binding",
    status: "reserved",
    revision: 0,
    generation: 0,
    updatedAt: at,
    taskId,
    attemptId: ProjectWorkAttemptId.make("attempt"),
    memberId: "worker",
    roleRevisionId: role.recordId,
    providerInstanceId: ProviderInstanceId.make("pi-test"),
    threadId: ThreadId.make("worker-thread"),
    environmentId: EnvironmentId.make("fixture-env"),
    model: role.model,
    configuration: {
      instructionsHash: "fixture-instructions",
      toolIds: role.tools,
      skillIds: [],
      runtimeVersion: "fixture",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/fixture/worker",
    branch: "fixture",
    leaseGeneration: 0,
    specRevision: 1,
    planRevision: 1,
    authorizationGateId: grant.recordId,
    specificationGateId: spec.recordId,
    planGateId: planGate.recordId,
    scopeHash: projectTeamScopeHash(state, taskId, plan),
  };
  const command: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> = {
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("claim"),
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "scheduler" },
      source: { kind: "system", id: "scheduler" },
      recordedAt: at,
    },
    records: [],
    committedAt: at,
    transition: {
      kind: "claim",
      taskId,
      expectedTaskRevision: state.tasks[0]!.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      binding,
      claim: {
        type: "project-work.task.claim",
        commandId: CommandId.make("claim"),
        projectId,
        taskId,
        attemptId: binding.attemptId,
        leaseToken: "token",
        leasedUntil: "2026-01-01T01:00:00.000Z",
        claimedAt: at,
      },
    },
  };
  const preClaim = state;
  state = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("running"),
      expectedRevision: state.revision,
      attribution,
      committedAt: at,
      records: [{ ...binding, status: "running", revision: 1 }],
    }),
  );
  return {
    state,
    preClaim,
    command,
    binding: { ...binding, status: "running" as const, revision: 1 },
  };
};
const internal = (
  state: ProjectWorkReducerState,
  label: string,
  transition: NonNullable<
    Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>["transition"]
  >,
) => {
  const command: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> = {
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make(label),
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "runtime" },
      source: { kind: "system", id: "runtime" },
      recordedAt: at,
    },
    committedAt: at,
    records: [],
    transition,
  };
  return applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
};

describe("guided lifecycle", () => {
  it("capture has no grant, assignment, worker, or effect", () => {
    const state = initial();
    expect(state.foundationRecords).toEqual([]);
    expect(state.attempts).toEqual([]);
  });
  it("creates one bounded readonly linked research assignment without claiming its parent", () => {
    const state = investigate();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.find((t) => t.taskId === taskId)).toMatchObject({
      state: "draft",
      specRevision: 0,
    });
    expect(state.attempts).toEqual([]);
    expect(state.foundationRecords!.find((r) => r.kind === "role-revision")).toMatchObject({
      role: "investigator",
      tools: ["read", "search", "project-work", "project-work.report"],
      delegationDepth: 0,
    });
    expect(
      state.foundationRecords!.find(
        (r) => r.kind === "task-membership" && r.parentTaskId === taskId,
      ),
    ).toMatchObject({ executionKind: "managed", deliverableKind: "research" });
    expect(
      state.foundationRecords!.filter((r) => r.kind === "gate" && r.gate === "investigation"),
    ).toHaveLength(1);
    expect(state.foundationRecords!.some((r) => r.kind === "effect")).toBe(false);
  });
  it("denies mismatched envelope, stale task and non-human investigation", () => {
    const state = initial();
    const intent = {
      ...envelope(state, "investigate"),
      type: "project-team.investigation.start" as const,
      objective: "Investigate",
      outputDescriptions: ["Findings"],
    };
    expect(() =>
      decideProjectWorkCommand(state, {
        ...compile(intent),
        commandId: CommandId.make("different"),
      }),
    ).toThrow(/enclosing command/);
    expect(() => run(state, { ...intent, expectedTaskRevision: 8 })).toThrow(/task revision/);
    expect(() =>
      decideProjectWorkCommand(state, {
        ...compile(intent),
        attribution: { ...attribution, actor: { kind: "agent", id: "forged" } },
      }),
    ).toThrow(/identity/);
  });
  it("ordinary and raw foundation claims cannot bypass investigation authority", () => {
    const state = investigate();
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    const claim = {
      type: "project-work.task.claim" as const,
      projectId,
      taskId: child.taskId,
      commandId: CommandId.make("bypass"),
      attemptId: ProjectWorkAttemptId.make("attempt"),
      leaseToken: "token",
      leasedUntil: "2026-01-01T01:00:00.000Z",
      claimedAt: at,
    };
    expect(() => decideProjectWorkCommand(state, claim)).toThrow(/guided transition/);
    expect(() =>
      decideProjectWorkCommand(state, {
        type: "project-work.foundation.commit",
        projectId,
        commandId: claim.commandId,
        expectedRevision: state.revision,
        attribution,
        committedAt: at,
        claim,
        records: [],
      }),
    ).toThrow(/guided transition/);
  });
  it("requires both exact current human anchors for execution and does not launch", () => {
    const state = planned();
    const intent = startIntent(state);
    const next = run(state, intent);
    expect(next.tasks[0]!.state).toBe("ready");
    expect(next.attempts).toEqual([]);
    expect(
      next.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "execution"),
    ).toMatchObject({ status: "approved", planRevision: 1 });
    expect(() =>
      run(state, { ...intent, type: "project-team.execution.start", expectedPlanGateRevision: 99 }),
    ).toThrow(/approval record changed/);
    const changed = {
      ...state,
      criteria: state.criteria.map((c) => ({ ...c, description: "A different acceptance scope" })),
    };
    expect(() => run(changed, intent)).toThrow(/approval is ineligible/);
  });
  it("scope hashes change for criteria and waivers but not evidence satisfaction", () => {
    const state = propose();
    const hash = projectTeamSpecificationHash(state, taskId);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      projectTeamSpecificationHash(
        { ...state, criteria: state.criteria.map((c) => ({ ...c, status: "satisfied" })) },
        taskId,
      ),
    ).toBe(hash);
    expect(
      projectTeamSpecificationHash(
        { ...state, criteria: state.criteria.map((c) => ({ ...c, required: false })) },
        taskId,
      ),
    ).not.toBe(hash);
  });
  it("changing a plan invalidates execution and evidence while preserving approved specification", () => {
    const state = run(planned(), startIntent(planned()));
    const previous = state.foundationRecords!.find((r) => r.kind === "plan-revision")!;
    const next = run(state, {
      ...envelope(state, "new-plan"),
      type: "project-team.plan.propose",
      specRevision: 1,
      content: "A changed bounded plan",
      dependencyTaskIds: [],
      previousPlanId: previous.recordId,
      expectedPreviousPlanRevision: previous.revision,
    });
    expect(
      next.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "execution"),
    ).toMatchObject({ status: "invalidated" });
    expect(
      next.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "specification"),
    ).toMatchObject({ status: "approved" });
  });
  it("canceled dependencies are not successful", () => {
    let state = planned();
    state = {
      ...state,
      tasks: [
        ...state.tasks,
        { ...state.tasks[0]!, taskId: ProjectWorkTaskId.make("dependency"), state: "canceled" },
      ],
    };
    const previous = state.foundationRecords!.find((r) => r.kind === "plan-revision")!;
    state = run(state, {
      ...envelope(state, "dependent-plan"),
      type: "project-team.plan.propose",
      specRevision: 1,
      content: "Needs dependency",
      dependencyTaskIds: [ProjectWorkTaskId.make("dependency")],
      previousPlanId: previous.recordId,
      expectedPreviousPlanRevision: previous.revision,
    });
    state = approveGates(state);
    const plan = state.foundationRecords!.find(
      (r) => r.kind === "plan-revision" && r.status === "proposed",
    )!;
    const planGate = state.foundationRecords!.find(
      (r) => r.kind === "gate" && r.gate === "plan" && r.status === "approved",
    )!;
    const intent = startIntent(state);
    expect(() =>
      run(state, {
        ...intent,
        type: "project-team.execution.start",
        planId: plan.recordId,
        expectedPlanRecordRevision: plan.revision,
        planRevision: 2,
        planGateId: planGate.recordId,
        expectedPlanGateRevision: planGate.revision,
      }),
    ).toThrow(/Dependency is ineligible/);
  });
  it("requires actual retained current outputs for non-code completion without fabricated Git proof", () => {
    let state = investigate();
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    const assignment = state.foundationRecords!.find(
      (r) => r.kind === "task-membership" && r.taskId === child.taskId,
    )!;
    const criterion = state.criteria.find((c) => c.taskId === child.taskId)!;
    const intent: ProjectTeamGuidedIntent = {
      ...envelope(state, "report", child.taskId),
      type: "project-team.assignment.report",
      specRevision: 1,
      planRevision: 0,
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: assignment.revision,
      summary: "Cause found",
      evidenceIds: [ProjectWorkEvidenceId.make("findings")],
      outputArtifactIds: [],
      outcome: "complete",
    };
    expect(() => run(state, intent)).toThrow(/missing retained evidence/);
    state = {
      ...state,
      evidence: [
        {
          evidenceId: ProjectWorkEvidenceId.make("findings"),
          taskId: child.taskId,
          criterionId: criterion.criterionId,
          kind: "observation",
          summary: "Cause found",
          detail: "The source and causal observations are retained here",
          scopeHash: projectTeamScopeHash(state, child.taskId),
          recordedAt: at,
          revision: 0,
          attribution,
        },
      ],
    };
    expect(run(state, intent).tasks.find((t) => t.taskId === child.taskId)!.state).toBe(
      "completed",
    );
    expect(
      run(state, intent).foundationRecords!.some((r) => r.kind === "evidence-applicability"),
    ).toBe(false);
    expect(() =>
      run(
        { ...state, evidence: state.evidence.map((e) => ({ ...e, scopeHash: "stale" })) },
        intent,
      ),
    ).toThrow(/scope is stale/);
  });
  it("managed code report cannot manufacture completion from approval", () => {
    const state = planned();
    const assignment = state.foundationRecords!.find((r) => r.kind === "task-membership")!;
    expect(() =>
      run(state, {
        ...envelope(state, "report"),
        type: "project-team.assignment.report",
        specRevision: 1,
        planRevision: 1,
        assignmentId: assignment.recordId,
        expectedAssignmentRevision: assignment.revision,
        summary: "Claimed done",
        evidenceIds: [],
        outputArtifactIds: [],
        outcome: "complete",
      }),
    ).toThrow(/actual delivery proof/);
  });
  it("removed membership keeps historical managed classification sticky", () => {
    const state = investigate();
    const records = state.foundationRecords!.map((r) =>
      r.kind === "task-membership" ? { ...r, status: "removed" as const } : r,
    );
    expect(() =>
      decideProjectWorkCommand(
        { ...state, foundationRecords: records },
        {
          type: "project-work.task.cancel",
          projectId,
          taskId,
          commandId: CommandId.make("old-cancel"),
          canceledAt: at,
          attribution,
        },
      ),
    ).toThrow(/guided transition/);
  });
  it("replay accepts its own post-revisions but rejects subsequent authority changes", () => {
    const state = initial();
    const intent: ProjectTeamGuidedIntent = {
      ...envelope(state, "investigate"),
      type: "project-team.investigation.start",
      objective: "Bounded objective",
      outputDescriptions: ["Findings"],
    };
    const events = decideProjectWorkCommand(state, compile(intent));
    const next = applyProjectWorkEvents(state, events);
    expect(() => assertProjectTeamGuidedReplayCurrent(next, intent, events)).not.toThrow();
    const records = next.foundationRecords!.map((r) =>
      r.kind === "task-membership" && r.parentTaskId === taskId
        ? { ...r, controlState: "paused" as const, revision: r.revision + 1 }
        : r,
    );
    expect(() =>
      assertProjectTeamGuidedReplayCurrent({ ...next, foundationRecords: records }, intent, events),
    ).toThrow(/semantic authority/);
  });
  it("consumes an exact execution grant atomically and never permits a second claim", () => {
    const { state, preClaim, command, binding } = activeRun();
    expect(state.attempts).toHaveLength(1);
    expect(
      state.foundationRecords!.find((r) => r.kind === "gate" && r.gate === "execution"),
    ).toMatchObject({
      status: "consumed",
      consumedByRunId: binding.recordId,
      consumedByCommandId: command.commandId,
    });
    const transition = command.transition;
    if (transition?.kind !== "claim") throw new Error("Expected claim fixture");
    expect(() =>
      decideProjectWorkCommand(state, {
        ...command,
        expectedRevision: state.revision,
        transition: { ...transition, expectedTaskRevision: state.tasks[0]!.revision },
      }),
    ).toThrow();
    const stale = {
      ...preClaim,
      criteria: preClaim.criteria.map((c) => ({ ...c, description: "Changed criterion" })),
    };
    expect(() => decideProjectWorkCommand(stale, command)).toThrow(/scope changed/);
  });
  it.each(["pause", "cancel", "reassign"] as const)(
    "%s revokes active run now and persists stop before replacement",
    (action) => {
      const { state, binding } = activeRun();
      const control =
        action === "reassign"
          ? {
              action,
              reason: "Human steering",
              recipientMemberId: "worker",
              expectedMemberRevision: 0,
            }
          : { action, reason: "Human steering" };
      const next = run(state, {
        ...envelope(state, `control-${action}`),
        type: "project-team.task.control",
        control,
      });
      expect(next.foundationRecords!.find((r) => r.recordId === binding.recordId)).toMatchObject({
        status: "stopping",
      });
      expect(
        next.foundationRecords!.find((r) => r.kind === "effect" && r.effectKind === "stop"),
      ).toMatchObject({
        status: "pending",
        runId: binding.recordId,
        claimGeneration: binding.generation,
      });
      expect(() =>
        decideProjectWorkCommand(next, {
          type: "project-work.attempt.renew",
          projectId,
          taskId,
          commandId: CommandId.make("renew-stopped"),
          attemptId: binding.attemptId,
          leaseToken: "token",
          leasedUntil: "2026-01-01T02:00:00.000Z",
          renewedAt: at,
        }),
      ).toThrow(/stopped/);
      expect(() =>
        run(next, {
          ...envelope(next, "resume"),
          type: "project-team.task.control",
          control: { action: "resume", reason: "Try too early" },
        }),
      ).toThrow(/authoritatively drained/);
    },
  );
  it("lease expiry quarantines a live run and persists a stop without proving exit", () => {
    const { state, binding } = activeRun();
    const next = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        type: "project-work.attempt.expire",
        projectId,
        taskId,
        commandId: CommandId.make("expire"),
        attemptId: binding.attemptId,
        expiredAt: "2026-01-01T02:00:00.000Z",
        reason: "Lease expired",
      }),
    );
    expect(next.foundationRecords!.find((r) => r.recordId === binding.recordId)).toMatchObject({
      status: "quarantined",
    });
    expect(
      next.foundationRecords!.some((r) => r.kind === "effect" && r.effectKind === "stop"),
    ).toBe(true);
    expect(() =>
      decideProjectWorkCommand(next, {
        type: "project-work.attempt.reclaim",
        projectId,
        taskId,
        commandId: CommandId.make("reclaim"),
        previousAttemptId: binding.attemptId,
        attemptId: ProjectWorkAttemptId.make("replacement"),
        leaseToken: "new",
        leasedUntil: "2026-01-01T03:00:00.000Z",
        claimedAt: "2026-01-01T02:00:00.000Z",
        attribution,
      }),
    ).toThrow(/guided transition/);
  });
  it("two semantic debits persist while transport and timeout counters remain separate", () => {
    let { state, binding } = activeRun();
    state = internal(state, "failure-1", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "tree-1",
      failureKind: "semantic",
      summary: "Test assertion fails",
    });
    let episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    state = internal(state, "repair-1", {
      kind: "repair.consume",
      episodeId: episode.recordId,
      expectedEpisodeRevision: episode.revision,
      bindingId: binding.recordId,
      generation: 0,
      relevantRevision: "tree-1",
    });
    state = internal(state, "transport", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "tree-2",
      failureKind: "transport",
      summary: "Transport retry",
    });
    state = internal(state, "timeout", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "tree-2",
      failureKind: "timeout",
      summary: "Timeout",
    });
    episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    expect(episode).toMatchObject({
      semanticRepairs: 1,
      transportRetries: 1,
      timeoutCount: 1,
      allowance: 2,
    });
    state = internal(state, "repair-2", {
      kind: "repair.consume",
      episodeId: episode.recordId,
      expectedEpisodeRevision: episode.revision,
      bindingId: binding.recordId,
      generation: 0,
      relevantRevision: "tree-2",
    });
    state = internal(state, "failure-3", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "tree-3",
      failureKind: "semantic",
      summary: "Limit exhausted",
    });
    expect(state.foundationRecords!.find((r) => r.kind === "repair-episode")).toMatchObject({
      semanticRepairs: 2,
      status: "exhausted",
    });
    expect(state.blockers).toHaveLength(1);
    expect(state.foundationRecords!.find((r) => r.recordId === binding.recordId)).toMatchObject({
      status: "stopping",
    });
  });
  it("unchanged failure escalates rather than consuming a second automatic repair", () => {
    let { state, binding } = activeRun();
    state = internal(state, "failure", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "same-tree",
      failureKind: "semantic",
      summary: "Failure",
    });
    const episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    state = internal(state, "repair", {
      kind: "repair.consume",
      episodeId: episode.recordId,
      expectedEpisodeRevision: 0,
      bindingId: binding.recordId,
      generation: 0,
      relevantRevision: "same-tree",
    });
    expect(() =>
      internal(state, "repeat-repair", {
        kind: "repair.consume",
        episodeId: episode.recordId,
        expectedEpisodeRevision: 1,
        bindingId: binding.recordId,
        generation: 0,
        relevantRevision: "same-tree",
      }),
    ).toThrow(/relevant change/);
    state = internal(state, "same-failure", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "same-tree",
      failureKind: "semantic",
      summary: "Failure persists",
    });
    expect(state.foundationRecords!.find((r) => r.kind === "repair-episode")).toMatchObject({
      semanticRepairs: 1,
      status: "exhausted",
    });
    expect(state.blockers[0]!.reason).toMatch(/without relevant change/);
  });
  it("one Human repair exception creates exactly one successor grant after trusted drain and never resets counters", () => {
    let { state, binding, command } = activeRun();
    state = internal(state, "failure-exception", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "persistent-cause",
      relevantRevision: "same-tree",
      failureKind: "semantic",
      summary: "Failure",
    });
    let episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    state = internal(state, "repair-before-exception", {
      kind: "repair.consume",
      episodeId: episode.recordId,
      expectedEpisodeRevision: 0,
      bindingId: binding.recordId,
      generation: 0,
      relevantRevision: "same-tree",
    });
    state = internal(state, "unchanged-exception", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "persistent-cause",
      relevantRevision: "same-tree",
      failureKind: "semantic",
      summary: "Still failing",
    });
    episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    state = run(state, {
      ...envelope(state, "human-exception"),
      type: "project-team.repair.resolve",
      episodeId: episode.recordId,
      expectedEpisodeRevision: episode.revision,
      failureFingerprint: episode.failureFingerprint,
      relevantRevision: episode.relevantRevision,
      decision: "approve-one-repair",
      reason: "One bounded diagnostic repair",
    });
    expect(() =>
      run(state, {
        ...envelope(state, "resolve-too-early"),
        type: "project-team.task.control",
        control: { action: "resolve-failure", reason: "Resume" },
      }),
    ).toThrow(/authoritatively drained/);
    // This pure state is an authoritative-drain fixture; it makes no OS exit claim.
    state = {
      ...state,
      foundationRecords: state.foundationRecords!.map((r) =>
        r.kind === "run-binding" && r.recordId === binding.recordId
          ? { ...r, status: "settled" as const }
          : r,
      ),
    };
    state = run(state, {
      ...envelope(state, "resolve-after-drain"),
      type: "project-team.task.control",
      control: { action: "resolve-failure", reason: "Use exact exception" },
    });
    episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    const original = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
        r.kind === "gate" && r.gate === "execution",
    )!;
    const exception = state.foundationRecords!.find(
      (r) => r.recordId === episode.exceptionGrantId,
    )!;
    const transition = command.transition;
    if (transition?.kind !== "claim") throw new Error("Expected claim fixture");
    const nextCommandId = CommandId.make("exception-successor");
    const repairTransition = {
      ...transition,
      expectedTaskRevision: state.tasks[0]!.revision,
      expectedGateRevision: original.revision,
      repair: {
        episodeId: episode.recordId,
        expectedEpisodeRevision: episode.revision,
        exceptionGateId: exception.recordId,
        expectedExceptionGateRevision: exception.revision,
      },
      claim: {
        ...transition.claim,
        commandId: nextCommandId,
        attemptId: ProjectWorkAttemptId.make("successor"),
      },
      binding: {
        ...transition.binding,
        recordId: "successor-run",
        attemptId: ProjectWorkAttemptId.make("successor"),
        generation: 1,
        leaseGeneration: 1,
        repairEpisodeId: episode.recordId,
      },
    };
    const next = internal(state, "exception-successor", repairTransition);
    expect(next.foundationRecords!.find((r) => r.kind === "repair-episode")).toMatchObject({
      semanticRepairs: 2,
      allowance: 2,
    });
    expect(next.foundationRecords!.find((r) => r.recordId === exception.recordId)).toMatchObject({
      status: "consumed",
      consumedByRunId: "successor-run",
      consumedByCommandId: nextCommandId,
    });
    expect(next.foundationRecords!.find((r) => r.recordId === original.recordId)).toMatchObject({
      consumedByRunId: binding.recordId,
    });
    expect(() =>
      internal(next, "exception-replay-other", {
        ...repairTransition,
        expectedTaskRevision: next.tasks[0]!.revision,
        claim: { ...repairTransition.claim, commandId: CommandId.make("exception-replay-other") },
      }),
    ).toThrow();
  });
  it("captures and completes a Human reminder without specification, plan, Git proof, or agent", () => {
    const empty = emptyProjectWorkReducerState(projectId);
    const state = applyProjectWorkEvents(
      empty,
      decideProjectWorkCommand(empty, {
        type: "project-work.task.create",
        projectId,
        taskId,
        commandId: CommandId.make("reminder-capture"),
        title: "Remember to check the release",
        deliverableKind: "reminder",
        createdAt: at,
        attribution,
      }),
    );
    const m = state.foundationRecords!.find((r) => r.kind === "task-membership")!;
    const next = run(state, {
      ...envelope(state, "reminder-complete"),
      type: "project-team.assignment.report",
      specRevision: 0,
      planRevision: 0,
      assignmentId: m.recordId,
      expectedAssignmentRevision: 0,
      summary: "Checked the release and retained the outcome",
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "complete",
    });
    expect(next.tasks[0]).toMatchObject({ state: "completed", specRevision: 0 });
    expect(next.tasks[0]!.specification).toBeUndefined();
    expect(next.attempts).toEqual([]);
    expect(next.comments![0]!.body).toContain("Checked the release");
    const reopened = run(next, {
      ...envelope(next, "reminder-reopen"),
      type: "project-team.task.control",
      control: { action: "reopen", reason: "Check once more" },
    });
    expect(reopened.tasks[0]!.state).toBe("draft");
  });
  it("retains explicitly returned research outputs without granting generic evidence writes", () => {
    const state = investigate();
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    const assignment = state.foundationRecords!.find(
      (r) => r.kind === "task-membership" && r.taskId === child.taskId,
    )!;
    const criterion = state.criteria.find((c) => c.taskId === child.taskId)!;
    const next = run(state, {
      ...envelope(state, "explicit-output", child.taskId),
      type: "project-team.assignment.report",
      specRevision: 1,
      planRevision: 0,
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: 0,
      summary: "Investigation findings",
      evidenceIds: [],
      outputArtifactIds: [],
      outputs: [
        {
          criterionId: criterion.criterionId,
          kind: "observation",
          detail: "Source foo.ts uses the stale revision; this retained finding cites that source.",
        },
      ],
      outcome: "complete",
    });
    expect(next.evidence).toHaveLength(1);
    expect(next.evidence[0]!.scopeHash).toBe(projectTeamScopeHash(state, child.taskId));
    expect(next.tasks.find((t) => t.taskId === child.taskId)!.state).toBe("completed");
  });
});

describe("ongoing frozen run authority", () => {
  it("keeps the frozen role when the member selects a profile for future runs", () => {
    const { state, binding } = activeRun();
    const role = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "role-revision" }> =>
        r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
    )!;
    const current = {
      ...state,
      foundationRecords: state.foundationRecords!.map((r) =>
        r.kind === "member" ? { ...r, roleRevisionId: "future-role", revision: r.revision + 1 } : r,
      ),
    };
    expect(() => assertProjectTeamRunAuthority(current, binding, role, false)).not.toThrow();
    expect(() =>
      assertProjectTeamRunAuthority(
        current,
        {
          ...binding,
          configuration: {
            ...binding.configuration,
            toolIds: [...binding.configuration.toolIds, "admin"],
          },
        },
        role,
        false,
      ),
    ).toThrow("frozen capabilities");
  });
  it("denies malformed imported anchors and canceled dependencies during a running assignment", () => {
    const { state, binding } = activeRun();
    const role = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "role-revision" }> =>
        r.kind === "role-revision" && r.recordId === binding.roleRevisionId,
    )!;
    for (const mutate of [
      (r: ProjectTeamRecord): ProjectTeamRecord =>
        r.kind === "gate" && r.recordId === binding.authorizationGateId
          ? { ...r, projectId: ProjectId.make("different-project") }
          : r,
      (r: ProjectTeamRecord): ProjectTeamRecord =>
        r.kind === "gate" && r.recordId === binding.authorizationGateId
          ? { ...r, specRevision: 2 }
          : r,
      (r: ProjectTeamRecord): ProjectTeamRecord =>
        r.kind === "plan-revision" ? { ...r, contentHash: "incorrect-hash" } : r,
    ]) {
      expect(() =>
        assertProjectTeamRunAuthority(
          { ...state, foundationRecords: state.foundationRecords!.map(mutate) },
          binding,
          role,
          false,
        ),
      ).toThrow();
    }
    const { authorizationGateId: _gate, ...missingGate } = binding;
    expect(() => assertProjectTeamRunAuthority(state, missingGate, role, false)).toThrow(
      "exact consumed human grant",
    );
    const dependency = {
      ...state.tasks[0]!,
      taskId: ProjectWorkTaskId.make("dependency"),
      state: "canceled" as const,
    };
    expect(() =>
      assertProjectTeamRunAuthority(
        {
          ...state,
          tasks: [...state.tasks, dependency],
          relationships: [
            ...state.relationships,
            {
              relationshipId: ProjectWorkRelationshipId.make("dep"),
              projectId,
              fromTaskId: taskId,
              toTaskId: dependency.taskId,
              kind: "depends-on" as const,
              revision: 0,
              createdAt: at,
            },
          ],
        },
        binding,
        role,
        false,
      ),
    ).toThrow("dependency changed");
  });
});
