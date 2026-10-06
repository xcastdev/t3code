import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
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
  canonicalProjectWorkPayload,
  ProjectTeamReviewCompletionProof,
  type ProjectTeamGuidedIntent,
  ProjectTeamRecord,
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
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";

const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeReviewCompletionProof = Schema.decodeUnknownSync(ProjectTeamReviewCompletionProof, {
  onExcessProperty: "error",
});

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
  it("ordinary reports cannot silently consume criterion assessments", () => {
    const state = investigate();
    const child = state.tasks.find((task) => task.taskId !== taskId)!;
    const assignment = state.foundationRecords!.find(
      (record) => record.kind === "task-membership" && record.taskId === child.taskId,
    )!;
    const criterion = state.criteria.find((entry) => entry.taskId === child.taskId)!;
    const intent: Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }> = {
      ...envelope(state, "ordinary-assessment-report", child.taskId),
      type: "project-team.assignment.report",
      specRevision: child.specRevision,
      planRevision: 0,
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: assignment.revision,
      summary: "Retained investigation output",
      evidenceIds: [],
      outputArtifactIds: [],
      outputs: [
        {
          criterionId: criterion.criterionId,
          kind: "observation",
          detail: "Retained causal observations",
        },
      ],
      outcome: "complete",
    };
    expect(run(state, intent).tasks.find((task) => task.taskId === child.taskId)?.state).toBe(
      "completed",
    );
    const before = canonicalProjectWorkPayload(state);
    for (const criterionAssessments of [
      [],
      [
        {
          criterionId: criterion.criterionId,
          expectedRevision: criterion.revision,
          verdict: "met" as const,
          detail: "A caller-provided judgment",
          evidenceIds: ["claimed-parent-evidence"],
        },
      ],
    ]) {
      expect(() => run(state, { ...intent, criterionAssessments })).toThrow(
        "Criterion assessments require a trusted reviewer report",
      );
      expect(() =>
        assertProjectTeamGuidedReplayCurrent(state, { ...intent, criterionAssessments }, []),
      ).toThrow("Criterion assessments require a trusted reviewer report");
      expect(canonicalProjectWorkPayload(state)).toBe(before);
    }
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
    state = internal(state, "semantic-failure-2", {
      kind: "failure",
      bindingId: binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "same-cause",
      relevantRevision: "tree-2",
      failureKind: "semantic",
      summary: "Second actual product failure",
    });
    episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
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
    ).toThrow(/pending semantic failure|relevant change/);
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
    expect(next.evidence.filter((e) => e.criterionId !== undefined)).toHaveLength(1);
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

// Pure trusted state fixtures exercise policy only; P8 owns actual process drain receipts.
const trustedDrain = (state: ProjectWorkReducerState): ProjectWorkReducerState => ({
  ...state,
  tasks: state.tasks.map((t) => {
    if (t.activeAttemptId === undefined) return t;
    const { activeAttemptId: _attempt, ...rest } = t;
    return { ...rest, state: "ready" as const };
  }),
  attempts: state.attempts.map((a) => ({ ...a, state: "expired" as const })),
  foundationRecords: state.foundationRecords!.map((r) =>
    r.kind === "run-binding" ? { ...r, status: "settled" as const } : r,
  ),
});
const nextClaim = (
  state: ProjectWorkReducerState,
  original: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>,
  label: string,
  memberId?: string,
) => {
  const t = original.transition;
  if (t?.kind !== "claim") throw new Error("Claim fixture required");
  const assignment = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
      r.kind === "task-membership" && r.taskId === t.taskId,
  )!;
  const grant = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.recordId === assignment.assignment!.authorizationGateId,
  )!;
  const commandId = CommandId.make(label);
  const attemptId = ProjectWorkAttemptId.make(`${label}-attempt`);
  return {
    ...original,
    commandId,
    expectedRevision: state.revision,
    transition: {
      ...t,
      expectedTaskRevision: state.tasks.find((task) => task.taskId === t.taskId)!.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      claim: { ...t.claim, commandId, attemptId },
      binding: {
        ...t.binding,
        recordId: `${label}-run`,
        attemptId,
        authorizationGateId: grant.recordId,
        generation: 1,
        leaseGeneration: 1,
        ...(memberId === undefined ? {} : { memberId }),
      },
    },
  };
};

describe("review regressions for successor authorization and retained reports", () => {
  it("pause and trusted drain permit one fresh exact execution grant without reusing consumption", () => {
    const fixture = activeRun();
    const original = fixture.state.foundationRecords!.find(
      (r) => r.recordId === fixture.binding.authorizationGateId,
    )!;
    let state = run(fixture.state, {
      ...envelope(fixture.state, "pause-for-resume"),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause work" },
    });
    expect(() =>
      run(state, {
        ...envelope(state, "resume-before-drain"),
        type: "project-team.task.control",
        control: { action: "resume", reason: "Resume" },
      }),
    ).toThrow("authoritatively drained");
    state = trustedDrain(state);
    const resumed = run(state, {
      ...envelope(state, "resume-after-drain"),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Resume unchanged work" },
    });
    const assignment = resumed.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        r.kind === "task-membership" && r.taskId === taskId,
    )!;
    expect(assignment.assignment!.authorizationGateId).not.toBe(original.recordId);
    expect(resumed.foundationRecords!.find((r) => r.recordId === original.recordId)).toEqual(
      original,
    );
    const renewed = resumed.foundationRecords!.find(
      (r) => r.recordId === assignment.assignment!.authorizationGateId,
    )!;
    expect(renewed).toMatchObject({
      kind: "gate",
      gate: "execution",
      status: "approved",
      specRevision: 1,
      planRevision: 1,
      contentHash: fixture.binding.scopeHash,
      attribution,
    });
    expect(resumed.foundationRecords!.filter((r) => r.kind === "repair-episode")).toEqual(
      state.foundationRecords!.filter((r) => r.kind === "repair-episode"),
    );
    const claimed = applyProjectWorkEvents(
      resumed,
      decideProjectWorkCommand(resumed, nextClaim(resumed, fixture.command, "resumed")),
    );
    expect(claimed.foundationRecords!.find((r) => r.recordId === renewed.recordId)).toMatchObject({
      status: "consumed",
      consumedByRunId: "resumed-run",
      consumedByCommandId: "resumed",
    });
    expect(() =>
      decideProjectWorkCommand(claimed, nextClaim(claimed, fixture.command, "second-writer")),
    ).toThrow();
  });
  it("resume cannot erase an exhausted canonical repair budget or an unbound prior attempt", () => {
    const fixture = activeRun();
    const failure = internal(fixture.state, "resume-failure", {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "persistent-cause",
      relevantRevision: "tree-1",
      failureKind: "semantic",
      summary: "Actual failure receipt",
    });
    const episode = failure.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    const paused = run(failure, {
      ...envelope(failure, "pause-failure"),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause failed work" },
    });
    const exhausted = {
      ...trustedDrain(paused),
      foundationRecords: trustedDrain(paused).foundationRecords!.map((r) =>
        r.recordId === episode.recordId
          ? { ...episode, status: "exhausted" as const, semanticRepairs: 2 }
          : r,
      ),
    };
    expect(() =>
      run(exhausted, {
        ...envelope(exhausted, "resume-exhausted"),
        type: "project-team.task.control",
        control: { action: "resume", reason: "Try ordinary resume" },
      }),
    ).toThrow("exhausted");
    expect(exhausted.foundationRecords!.find((r) => r.recordId === episode.recordId)).toMatchObject(
      { semanticRepairs: 2, status: "exhausted", failureFingerprint: "persistent-cause" },
    );
    const missingDrain = {
      ...exhausted,
      foundationRecords: exhausted.foundationRecords!.filter(
        (r) => r.recordId !== fixture.binding.recordId,
      ),
    };
    expect(() =>
      run(missingDrain, {
        ...envelope(missingDrain, "resume-unbound"),
        type: "project-team.task.control",
        control: { action: "resume", reason: "Try without receipt" },
      }),
    ).toThrow("drain proof");
  });
  it("reassignment denies the original member and consumes only the requested current successor", () => {
    const fixture = activeRun();
    const original = fixture.preClaim.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "member" }> => r.kind === "member",
    )!;
    let state = applyProjectWorkEvents(
      fixture.preClaim,
      decideProjectWorkCommand(fixture.preClaim, {
        type: "project-work.foundation.commit",
        projectId,
        commandId: CommandId.make("successor"),
        expectedRevision: fixture.preClaim.revision,
        attribution,
        committedAt: at,
        records: [{ ...original, recordId: "successor" }],
      }),
    );
    state = run(state, {
      ...envelope(state, "reassign-original"),
      type: "project-team.task.control",
      control: {
        action: "reassign",
        reason: "New owner",
        recipientMemberId: "successor",
        expectedMemberRevision: 0,
      },
    });
    state = run(state, {
      ...envelope(state, "resume-successor"),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Resume successor" },
    });
    expect(() =>
      decideProjectWorkCommand(state, nextClaim(state, fixture.command, "wrong-member")),
    ).toThrow("requested successor");
    const inactive = {
      ...state,
      foundationRecords: state.foundationRecords!.map((r) =>
        r.kind === "member" && r.recordId === "successor" ? { ...r, status: "paused" as const } : r,
      ),
    };
    expect(() =>
      decideProjectWorkCommand(
        inactive,
        nextClaim(inactive, fixture.command, "inactive-member", "successor"),
      ),
    ).toThrow("current member");
    const claimed = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(
        state,
        nextClaim(state, fixture.command, "right-member", "successor"),
      ),
    );
    expect(claimed.foundationRecords!.find((r) => r.recordId === "right-member-run")).toMatchObject(
      {
        memberId: "successor",
        roleRevisionId: fixture.binding.roleRevisionId,
        configuration: fixture.binding.configuration,
      },
    );
  });
  it("retains exact current artifact references in a typed report and rejects stale artifacts", () => {
    let state = investigate();
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    const assignment = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        r.kind === "task-membership" && r.taskId === child.taskId,
    )!;
    const outputId = ProjectWorkEvidenceId.make("retained-output");
    state = {
      ...state,
      evidence: [
        {
          evidenceId: outputId,
          taskId: child.taskId,
          kind: "artifact",
          summary: "Actual retained finding",
          detail: "Source and finding belong to this assignment",
          scopeHash: projectTeamScopeHash(state, child.taskId),
          recordedAt: at,
          revision: 0,
          attribution,
        },
      ],
    };
    const intent: ProjectTeamGuidedIntent = {
      ...envelope(state, "report-artifact", child.taskId),
      type: "project-team.assignment.report",
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: assignment.revision,
      specRevision: 1,
      planRevision: 0,
      summary: "These are my findings",
      evidenceIds: [],
      outputArtifactIds: [outputId],
      outcome: "findings",
    };
    expect(() =>
      run(
        { ...state, evidence: state.evidence.map((e) => ({ ...e, scopeHash: "old-scope" })) },
        intent,
      ),
    ).toThrow("scope is stale");
    const events = decideProjectWorkCommand(state, compile(intent));
    const next = applyProjectWorkEvents(state, events);
    expect(next.evidence.find((e) => e.outputArtifactIds?.includes(outputId))).toMatchObject({
      taskId: child.taskId,
      kind: "observation",
      summary: intent.summary,
      scopeHash: state.evidence[0]!.scopeHash,
      attribution,
    });
    expect(() => assertProjectTeamGuidedReplayCurrent(next, intent, events)).not.toThrow();
    expect(() => run(state, { ...intent, outcome: "complete" })).toThrow("required criterion");
  });
});

const inheritedStart = (
  state: ProjectWorkReducerState,
  kind: "planning" | "review",
  label: string,
): Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.start" }> => {
  const spec = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.gate === "specification" && r.status === "approved",
  )!;
  const plan = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
      r.kind === "plan-revision" && r.status === "proposed",
  );
  const planGate = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.gate === "plan" && r.status === "approved",
  );
  return {
    ...envelope(state, label),
    type: "project-team.assignment.start",
    assignmentKind: kind,
    objective: kind === "planning" ? "Propose a bounded plan" : "Review the bounded approved scope",
    outputDescriptions: [
      kind === "planning" ? "Retained proposed plan" : "Sourced review findings",
    ],
    specRevision: 1,
    specificationGateId: spec.recordId,
    expectedSpecificationGateRevision: spec.revision,
    ...(plan === undefined || planGate === undefined
      ? {}
      : {
          parentPlan: {
            recordId: plan.recordId,
            expectedRecordRevision: plan.revision,
            planRevision: plan.planRevision,
            gateId: planGate.recordId,
            expectedGateRevision: planGate.revision,
          },
        }),
  };
};
const childRun = (input: ProjectWorkReducerState, childId: ProjectWorkTaskId) => {
  const template = activeRun().command;
  if (template.transition?.kind !== "claim") throw new Error("Claim template missing");
  const generatedRole = input.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "role-revision" }> =>
      r.kind === "role-revision" && r.model === "unconfigured",
  )!;
  const role = { ...generatedRole, recordId: "configured-child-role", model: "fixture-model" };
  let state = applyProjectWorkEvents(
    input,
    decideProjectWorkCommand(input, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("configure-child"),
      expectedRevision: input.revision,
      records: [
        role,
        {
          recordId: "child-member",
          projectId,
          kind: "member",
          status: "active",
          revision: 0,
          generation: 0,
          updatedAt: at,
          name: "Child worker",
          coordinator: false,
          roleRevisionId: role.recordId,
        },
      ],
      attribution,
      committedAt: at,
    }),
  );
  const grant = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.taskId === childId,
  )!;
  const { specificationGateId: _spec, planGateId: _plan, ...base } = template.transition.binding;
  const binding = {
    ...base,
    recordId: "child-run",
    taskId: childId,
    attemptId: ProjectWorkAttemptId.make("child-attempt"),
    memberId: "child-member",
    roleRevisionId: role.recordId,
    model: role.model,
    configuration: { ...base.configuration, toolIds: role.tools },
    specRevision: 1,
    planRevision: 0,
    authorizationGateId: grant.recordId,
    scopeHash: projectTeamScopeHash(state, childId),
  };
  const command = {
    ...template,
    commandId: CommandId.make("child-claim"),
    expectedRevision: state.revision,
    transition: {
      ...template.transition,
      taskId: childId,
      expectedTaskRevision: state.tasks.find((t) => t.taskId === childId)!.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      binding,
      claim: {
        ...template.transition.claim,
        commandId: CommandId.make("child-claim"),
        taskId: childId,
        attemptId: binding.attemptId,
      },
    },
  };
  const preClaim = state;
  state = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
  const running = { ...binding, status: "running" as const, revision: 1 };
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("child-running"),
      expectedRevision: state.revision,
      records: [running],
      attribution,
      committedAt: at,
    }),
  );
  return { state, preClaim, command, binding: running, role };
};
const reviewerReport = () => {
  const parent = planned();
  const assigned = run(parent, inheritedStart(parent, "review", "review-completion-assignment"));
  const child = assigned.tasks.find((task) => task.taskId !== taskId)!;
  const fixture = childRun(assigned, child.taskId);
  const assignment = fixture.state.foundationRecords!.find(
    (record) => record.kind === "task-membership" && record.taskId === child.taskId,
  )!;
  const criteria = fixture.state.criteria.filter((criterion) => criterion.taskId === child.taskId);
  expect(criteria.length).toBeGreaterThan(0);
  const intent: Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }> = {
    ...envelope(fixture.state, "reviewer-claimed-complete", child.taskId),
    type: "project-team.assignment.report",
    assignmentId: assignment.recordId,
    expectedAssignmentRevision: assignment.revision,
    specRevision: child.specRevision,
    planRevision: 0,
    summary: "The reviewer claims every output is complete",
    outputs: criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      kind: "observation",
      detail: "Nonblank reviewer-authored detail for the exact current criterion",
    })),
    evidenceIds: [],
    outputArtifactIds: [],
    outcome: "complete",
  };
  const command = {
    ...compile(intent),
    attribution: {
      actor: { kind: "agent" as const, id: "child-member" },
      source: { kind: "mcp" as const, id: "review-report" },
      recordedAt: at,
    },
    guided: { intent, bindingId: fixture.binding.recordId, generation: fixture.binding.generation },
  };
  return { state: fixture.state, binding: fixture.binding, child, intent, command };
};

describe("bounded inherited planning and review assignments", () => {
  it("denies managed reviewer completion from inline criterion outputs", () => {
    const fixture = reviewerReport();
    const before = canonicalProjectWorkPayload(fixture.state);
    expect(() => decideProjectWorkCommand(fixture.state, fixture.command)).toThrow(
      "trusted completed review receipt",
    );
    expect(canonicalProjectWorkPayload(fixture.state)).toBe(before);
  });
  it("denies a human-attributed completion report for the same managed reviewer assignment", () => {
    const fixture = reviewerReport();
    expect(() =>
      decideProjectWorkCommand(fixture.state, { ...fixture.command, attribution }),
    ).toThrow("trusted completed review receipt");
  });
  for (const actor of ["agent", "human"] as const)
    it(`denies ${actor} managed reviewer completion from actual retained criterion artifacts`, () => {
      const fixture = reviewerReport();
      const proposal = {
        ...fixture.intent,
        outcome: "findings" as const,
        outputs: fixture.intent.outputs!.map((output) => ({
          ...output,
          kind: "artifact" as const,
        })),
      };
      const proposed = applyProjectWorkEvents(
        fixture.state,
        decideProjectWorkCommand(fixture.state, {
          ...fixture.command,
          guided: { ...fixture.command.guided, intent: proposal },
        }),
      );
      const artifacts = proposed.evidence.filter(
        (evidence) =>
          evidence.taskId === fixture.child.taskId && evidence.criterionId !== undefined,
      );
      expect(artifacts).toHaveLength(fixture.intent.outputs!.length);
      const intent = {
        ...fixture.intent,
        ...envelope(proposed, `retained-review-complete-${actor}`, fixture.child.taskId),
        outputs: [],
        evidenceIds: artifacts.map((artifact) => artifact.evidenceId),
        outputArtifactIds: artifacts.map((artifact) => artifact.evidenceId),
      };
      const before = canonicalProjectWorkPayload(proposed);
      expect(() =>
        decideProjectWorkCommand(proposed, {
          ...compile(intent),
          attribution: actor === "human" ? attribution : fixture.command.attribution,
          guided: { ...fixture.command.guided, intent },
        }),
      ).toThrow("trusted completed review receipt");
      expect(canonicalProjectWorkPayload(proposed)).toBe(before);
    });
  for (const outcome of ["findings", "review-ready"] as const)
    it(`retains managed reviewer ${outcome} as a nonterminal proposal`, () => {
      const fixture = reviewerReport();
      const intent = { ...fixture.intent, outcome };
      const events = decideProjectWorkCommand(fixture.state, {
        ...fixture.command,
        guided: { ...fixture.command.guided, intent },
      });
      const next = applyProjectWorkEvents(fixture.state, events);
      expect(next.tasks.find((task) => task.taskId === fixture.child.taskId)).toEqual(
        fixture.state.tasks.find((task) => task.taskId === fixture.child.taskId),
      );
      expect(next.criteria).toEqual(fixture.state.criteria);
      expect(next.foundationRecords).toEqual(fixture.state.foundationRecords);
      expect(next.comments!.at(-1)?.body).toBe(intent.summary);
      expect(
        next.evidence.filter(
          (evidence) =>
            evidence.criterionId !== undefined && evidence.taskId === fixture.child.taskId,
        ),
      ).toHaveLength(intent.outputs!.length);
      expect(events.some((event) => event.type === "project-work.task.completed")).toBe(false);
      expect(() => assertProjectTeamGuidedReplayCurrent(next, intent, events)).not.toThrow();
    });
  it("preserves ordinary human review completion with exact criterion outputs", () => {
    const captured = applyProjectWorkEvents(
      emptyProjectWorkReducerState(projectId),
      decideProjectWorkCommand(emptyProjectWorkReducerState(projectId), {
        type: "project-work.task.create",
        projectId,
        taskId,
        commandId: CommandId.make("human-review-capture"),
        title: "Human review",
        deliverableKind: "review",
        createdAt: at,
        attribution,
      }),
    );
    const state = propose(captured);
    const assignment = state.foundationRecords!.find(
      (record) => record.kind === "task-membership",
    )!;
    expect(assignment).toMatchObject({ executionKind: "human", deliverableKind: "review" });
    const next = run(state, {
      ...envelope(state, "human-review-complete"),
      type: "project-team.assignment.report",
      assignmentId: assignment.recordId,
      expectedAssignmentRevision: assignment.revision,
      specRevision: 1,
      planRevision: 0,
      summary: "Human review retained",
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "complete",
      outputs: [
        {
          criterionId: ProjectWorkCriterionId.make("acceptance"),
          kind: "observation",
          detail: "The human's actual recorded review detail",
        },
      ],
    });
    expect(next.tasks[0]!.state).toBe("completed");
    expect(next.attempts).toEqual([]);
    expect(next.evidence.find((evidence) => evidence.criterionId === "acceptance")?.detail).toBe(
      "The human's actual recorded review detail",
    );
  });

  it("creates a planner before the first plan only from an exact approved Human specification", () => {
    const approved = approveGates(propose());
    const intent = inheritedStart(approved, "planning", "start-planner");
    expect(() =>
      run(approved, {
        ...intent,
        expectedSpecificationGateRevision: intent.expectedSpecificationGateRevision + 1,
      }),
    ).toThrow("approval changed");
    expect(() =>
      run(approved, { ...intent, outputDescriptions: ["Plan", "Other output"] }),
    ).toThrow("exactly one");
    const state = run(approved, intent);
    const child = state.tasks.find((t) => t.taskId !== taskId)!;
    expect(state.tasks.find((t) => t.taskId === taskId)!.activeAttemptId).toBeUndefined();
    expect(state.foundationRecords!.find((r) => r.kind === "role-revision")).toMatchObject({
      role: "planner",
      tools: ["read", "search", "project-work", "project-work.report", "project-work.plan"],
      delegationDepth: 0,
      model: "unconfigured",
    });
    expect(
      state.foundationRecords!.find((r) => r.kind === "gate" && r.taskId === child.taskId),
    ).toMatchObject({
      gate: "assignment",
      status: "approved",
      assignmentAuthorization: {
        assignmentKind: "planning",
        parentTaskId: taskId,
        parentSpecificationGateId: intent.specificationGateId,
        parentScopeHash: projectTeamScopeHash(approved, taskId),
      },
    });
    const fixture = childRun(state, child.taskId);
    expect(() =>
      assertProjectTeamRunAuthority(fixture.state, fixture.binding, fixture.role, false),
    ).not.toThrow();
    const scopeChanged = {
      ...fixture.preClaim,
      tasks: fixture.preClaim.tasks.map((t) =>
        t.taskId === taskId ? { ...t, specRevision: t.specRevision + 1 } : t,
      ),
    };
    expect(() => decideProjectWorkCommand(scopeChanged, fixture.command)).toThrow();
    const dependencyId = ProjectWorkTaskId.make("parent-dependency");
    const dependencyChanged = {
      ...fixture.state,
      tasks: [
        ...fixture.state.tasks,
        { ...fixture.state.tasks[0]!, taskId: dependencyId, state: "canceled" as const },
      ],
      relationships: [
        ...fixture.state.relationships,
        {
          relationshipId: ProjectWorkRelationshipId.make("parent-dependency-link"),
          projectId,
          fromTaskId: taskId,
          toTaskId: dependencyId,
          kind: "depends-on" as const,
          revision: 0,
          createdAt: at,
        },
      ],
    };
    expect(() =>
      assertProjectTeamRunAuthority(dependencyChanged, fixture.binding, fixture.role, false),
    ).toThrow("dependency");
  });
  it("retains the planner's actual parent proposal, completes and fences the child before replacing scope", () => {
    const approved = approveGates(propose());
    const started = run(approved, inheritedStart(approved, "planning", "planner-proposal"));
    const child = started.tasks.find((t) => t.taskId !== taskId)!;
    const fixture = childRun(started, child.taskId);
    const intent: ProjectTeamGuidedIntent = {
      ...envelope(fixture.state, "managed-parent-plan"),
      type: "project-team.plan.propose",
      specRevision: 1,
      content:
        "Inspect actual source, implement one behavior, and run the focused acceptance checks.",
      dependencyTaskIds: [],
    };
    const command = {
      ...compile(intent),
      attribution: {
        actor: { kind: "agent" as const, id: "child-worker" },
        source: { kind: "system" as const, id: "runtime" },
        recordedAt: at,
      },
      guided: { intent, bindingId: fixture.binding.recordId, generation: 0 },
    };
    const events = decideProjectWorkCommand(fixture.state, command);
    const next = applyProjectWorkEvents(fixture.state, events);
    expect(next.tasks.find((t) => t.taskId === child.taskId)!.state).toBe("completed");
    const childMembership = next.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        r.kind === "task-membership" && r.taskId === child.taskId,
    )!;
    expect(childMembership.controlState).toBe("paused");
    expect(() => assertProjectTeamGuidedReplayCurrent(next, intent, events)).not.toThrow();
    const replaced = {
      ...next,
      foundationRecords: next.foundationRecords!.map((r) =>
        r.recordId === childMembership.recordId
          ? {
              ...childMembership,
              revision: childMembership.revision + 1,
              controlState: "active" as const,
              assignment: {
                ...childMembership.assignment!,
                authorizationGateId: "new-child-grant",
              },
            }
          : r,
      ),
    };
    expect(() => assertProjectTeamGuidedReplayCurrent(replaced, intent, events)).toThrow(
      "semantic authority target changed",
    );

    expect(next.evidence.filter((e) => e.taskId === child.taskId)).toHaveLength(1);
    expect(next.evidence.find((e) => e.taskId === child.taskId)).toMatchObject({
      kind: "artifact",
      detail: intent.content,
      scopeHash: fixture.binding.scopeHash,
    });
    expect(
      next.foundationRecords!.find((r) => r.kind === "plan-revision" && r.taskId === taskId),
    ).toMatchObject({ content: intent.content, status: "proposed" });
    expect(
      next.foundationRecords!.find((r) => r.recordId === fixture.binding.recordId),
    ).toMatchObject({ status: "stopping" });
    expect(events.findIndex((e) => e.type === "project-work.task.completed")).toBeLessThan(
      events.findIndex(
        (e) => e.type === "project-work.foundation.recorded" && e.record.kind === "plan-revision",
      ),
    );
    expect(() =>
      assertProjectTeamRunAuthority(next, fixture.binding, fixture.role, false),
    ).toThrow();
    expect(() =>
      decideProjectWorkCommand(next, {
        ...command,
        commandId: CommandId.make("planner-replay-new"),
        expectedRevision: next.revision,
        guided: {
          ...command.guided,
          intent: { ...intent, ...envelope(next, "planner-replay-new") },
        },
      }),
    ).toThrow();
  });
  it("requires review's exact current parent plan and stops dependent children when parent scope changes", () => {
    const approved = planned();
    const intent = inheritedStart(approved, "review", "start-review");
    const { parentPlan: _plan, ...missingPlan } = intent;
    expect(() => run(approved, missingPlan)).toThrow("approved parent plan");
    const started = run(approved, intent);
    const child = started.tasks.find((t) => t.taskId !== taskId)!;
    const fixture = childRun(started, child.taskId);
    expect(fixture.role).toMatchObject({
      role: "reviewer",
      tools: ["read", "search", "project-work", "project-work.report"],
    });
    const previous = fixture.state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
        r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed",
    )!;
    const next = run(fixture.state, {
      ...envelope(fixture.state, "replace-parent-plan"),
      type: "project-team.plan.propose",
      specRevision: 1,
      previousPlanId: previous.recordId,
      expectedPreviousPlanRevision: previous.revision,
      content: "A changed bounded plan",
      dependencyTaskIds: [],
    });
    expect(
      next.foundationRecords!.find((r) => r.recordId === fixture.binding.recordId),
    ).toMatchObject({ status: "stopping" });
    expect(
      next.foundationRecords!.find((r) => r.kind === "gate" && r.taskId === child.taskId),
    ).toMatchObject({ status: "invalidated" });
    expect(
      next.foundationRecords!.find(
        (r) => r.kind === "effect" && r.effectKind === "stop" && r.taskId === child.taskId,
      ),
    ).toMatchObject({ status: "pending" });
    expect(() =>
      assertProjectTeamRunAuthority(next, fixture.binding, fixture.role, false),
    ).toThrow();
  });
  it("renews a consumed investigation after trusted drain without a semantic repair debit", () => {
    const investigated = investigate();
    const child = investigated.tasks.find((t) => t.taskId !== taskId)!;
    const fixture = childRun(investigated, child.taskId);
    let state = run(fixture.state, {
      ...envelope(fixture.state, "pause-research", child.taskId),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause research" },
    });
    state = trustedDrain(state);
    const next = run(state, {
      ...envelope(state, "resume-research", child.taskId),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Resume unchanged research" },
    });
    const claimed = applyProjectWorkEvents(
      next,
      decideProjectWorkCommand(next, nextClaim(next, fixture.command, "research-successor")),
    );
    expect(
      claimed.foundationRecords!.find((r) => r.recordId === "research-successor-run"),
    ).toMatchObject({ planRevision: 0, scopeHash: fixture.binding.scopeHash });
    expect(claimed.foundationRecords!.filter((r) => r.kind === "repair-episode")).toEqual([]);
  });
});

describe("inherited successor grants", () => {
  it.each(["planning", "review"] as const)(
    "renews %s only with unchanged current parent approvals",
    (kind) => {
      const approved = kind === "planning" ? approveGates(propose()) : planned();
      const started = run(approved, inheritedStart(approved, kind, `resumable-${kind}`));
      const child = started.tasks.find((t) => t.taskId !== taskId)!;
      const fixture = childRun(started, child.taskId);
      let state = run(fixture.state, {
        ...envelope(fixture.state, `pause-${kind}`, child.taskId),
        type: "project-team.task.control",
        control: { action: "pause", reason: "Pause bounded assignment" },
      });
      state = trustedDrain(state);
      const next = run(state, {
        ...envelope(state, `resume-${kind}`, child.taskId),
        type: "project-team.task.control",
        control: { action: "resume", reason: "Resume exact inherited scope" },
      });
      const claimed = applyProjectWorkEvents(
        next,
        decideProjectWorkCommand(next, nextClaim(next, fixture.command, `${kind}-successor`)),
      );
      const binding = claimed.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "run-binding" }> =>
          r.kind === "run-binding" && r.recordId === `${kind}-successor-run`,
      )!;
      const newGrant = claimed.foundationRecords!.find(
        (r) => r.recordId === binding.authorizationGateId,
      )!;
      expect(newGrant).toMatchObject({
        gate: "assignment",
        status: "consumed",
        assignmentAuthorization: { assignmentKind: kind, parentTaskId: taskId },
      });
      expect(
        claimed.foundationRecords!.find((r) => r.recordId === fixture.binding.authorizationGateId),
      ).toMatchObject({ status: "consumed", consumedByRunId: fixture.binding.recordId });
    },
  );
  it("a typed inherited repair claim preserves parent authority and debits the canonical episode once", () => {
    const approved = approveGates(propose());
    const started = run(approved, inheritedStart(approved, "planning", "repairable-planner"));
    const child = started.tasks.find((t) => t.taskId !== taskId)!;
    const fixture = childRun(started, child.taskId);
    const failed = internal(fixture.state, "child-semantic-failure", {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "planner-semantic-cause",
      relevantRevision: "parent-tree-1",
      failureKind: "semantic",
      summary: "Actual planner failure receipt",
    });
    const episode = failed.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    const state = trustedDrain(failed);
    const template = nextClaim(state, fixture.command, "planner-repair-successor");
    if (template.transition?.kind !== "claim") throw new Error("Claim required");
    const command = {
      ...template,
      transition: {
        ...template.transition,
        repair: { episodeId: episode.recordId, expectedEpisodeRevision: episode.revision },
        binding: { ...template.transition.binding, repairEpisodeId: episode.recordId },
      },
    };
    const next = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
    const binding = next.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "run-binding" }> =>
        r.kind === "run-binding" && r.recordId === "planner-repair-successor-run",
    )!;
    expect(
      next.foundationRecords!.find((r) => r.recordId === binding.authorizationGateId),
    ).toMatchObject({
      gate: "repair",
      assignmentAuthorization: { assignmentKind: "planning", parentTaskId: taskId },
      repairAuthorization: {
        inheritedGateId: fixture.binding.authorizationGateId,
        episodeId: episode.recordId,
        semanticRepairNumber: 1,
      },
    });
    expect(next.foundationRecords!.find((r) => r.recordId === episode.recordId)).toMatchObject({
      rootTaskId: taskId,
      semanticRepairs: 1,
    });
    expect(() => assertProjectTeamRunAuthority(next, binding, fixture.role, true)).not.toThrow();
  });
});

describe("canonical failure successor authorization", () => {
  it("does not convert a first semantic failure into ordinary successor authority through pause and drain", () => {
    const fixture = activeRun();
    let state = internal(fixture.state, "pending-semantic-failure", {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "pending-product-cause",
      relevantRevision: "tree-1",
      failureKind: "semantic",
      summary: "Product assertion failed",
    });
    state = run(state, {
      ...envelope(state, "pause-pending-semantic"),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause failed semantic work" },
    });
    state = trustedDrain(state);
    const intent: ProjectTeamGuidedIntent = {
      ...envelope(state, "resume-pending-semantic"),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Resume without a repair debit" },
    };
    const resumed = run(state, intent);
    const before = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
        r.kind === "task-membership" && r.taskId === taskId,
    )!;
    expect(resumed.foundationRecords!.find((r) => r.recordId === before.recordId)).toMatchObject({
      controlState: "active",
      assignment: before.assignment,
    });
    expect(resumed.foundationRecords!.filter((r) => r.kind === "gate")).toEqual(
      state.foundationRecords!.filter((r) => r.kind === "gate"),
    );
    expect(() =>
      decideProjectWorkCommand(
        resumed,
        nextClaim(resumed, fixture.command, "pending-ordinary-successor"),
      ),
    ).toThrow(/semantic.*repair/i);
    expect(() =>
      run(resumed, { ...startIntent(resumed), ...envelope(resumed, "pending-execution-start") }),
    ).toThrow(/semantic.*repair/i);
    const episode = resumed.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    const ordinary = nextClaim(resumed, fixture.command, "pending-exact-repair");
    if (ordinary.transition?.kind !== "claim") throw new Error("Claim required");
    const repair = {
      ...ordinary,
      transition: {
        ...ordinary.transition,
        repair: { episodeId: episode.recordId, expectedEpisodeRevision: episode.revision },
        binding: { ...ordinary.transition.binding, repairEpisodeId: episode.recordId },
      },
    };
    const repaired = applyProjectWorkEvents(resumed, decideProjectWorkCommand(resumed, repair));
    expect(repaired.foundationRecords!.find((r) => r.recordId === episode.recordId)).toMatchObject({
      pendingSemanticRepair: false,
      semanticRepairs: 1,
    });

    expect(state.foundationRecords!.find((r) => r.kind === "repair-episode")).toMatchObject({
      semanticRepairs: 0,
      transportRetries: 0,
      timeoutCount: 0,
    });
  });
  it("transport-only pause and drain keeps ordinary successor authority without a semantic debit", () => {
    const fixture = activeRun();
    let state = internal(fixture.state, "transport-failure-resume", {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "provider-transport-cause",
      relevantRevision: "tree-1",
      failureKind: "transport",
      summary: "Transport disconnected",
    });
    state = run(state, {
      ...envelope(state, "pause-transport"),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause disconnected work" },
    });
    state = trustedDrain(state);
    const resumed = run(state, {
      ...envelope(state, "resume-transport"),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Retry transport" },
    });
    const next = applyProjectWorkEvents(
      resumed,
      decideProjectWorkCommand(resumed, nextClaim(resumed, fixture.command, "transport-successor")),
    );
    expect(next.foundationRecords!.find((r) => r.kind === "repair-episode")).toMatchObject({
      semanticRepairs: 0,
      transportRetries: 1,
      timeoutCount: 0,
    });
  });
});

describe("semantic marker provenance", () => {
  it("preserves a pending semantic failure across transport and clears it only on its exact debit", () => {
    const fixture = activeRun();
    const transition = {
      kind: "failure" as const,
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "shared-cause",
      relevantRevision: "tree-1",
      failureKind: "semantic" as const,
      summary: "Actual semantic failure",
    };
    let state = internal(fixture.state, "marker-semantic", transition);
    state = internal(state, "marker-transport", {
      ...transition,
      failureKind: "transport",
      relevantRevision: "tree-2",
    });
    const episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    expect(episode).toMatchObject({
      pendingSemanticRepair: true,
      semanticRepairs: 0,
      transportRetries: 1,
      relevantRevision: "tree-2",
    });
    state = internal(state, "marker-debit", {
      kind: "repair.consume",
      bindingId: fixture.binding.recordId,
      generation: 0,
      episodeId: episode.recordId,
      expectedEpisodeRevision: episode.revision,
      relevantRevision: episode.relevantRevision,
    });
    const cleared = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    expect(cleared).toMatchObject({
      pendingSemanticRepair: false,
      semanticRepairs: 1,
      lastSemanticRevision: "tree-2",
      transportRetries: 1,
    });
    expect(() =>
      internal(state, "duplicate-semantic-debit", {
        kind: "repair.consume",
        bindingId: fixture.binding.recordId,
        generation: 0,
        episodeId: cleared.recordId,
        expectedEpisodeRevision: cleared.revision,
        relevantRevision: cleared.relevantRevision,
      }),
    ).toThrow("pending semantic failure");
  });
  it("legacy active episodes cannot become ordinary successors or automatic repair without an exact Human exception", () => {
    const fixture = activeRun();
    let state = internal(fixture.state, "legacy-transport", {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "legacy-cause",
      relevantRevision: "legacy-tree",
      failureKind: "transport",
      summary: "Legacy classification",
    });
    state = {
      ...state,
      foundationRecords: state.foundationRecords!.map((r) => {
        if (r.kind !== "repair-episode") return r;
        const { pendingSemanticRepair: _marker, ...legacy } = r;
        return legacy;
      }),
    };
    const episode = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    expect(() =>
      internal(state, "legacy-automatic", {
        kind: "repair.consume",
        bindingId: fixture.binding.recordId,
        generation: 0,
        episodeId: episode.recordId,
        expectedEpisodeRevision: episode.revision,
        relevantRevision: episode.relevantRevision,
      }),
    ).toThrow("pending semantic failure");
    state = run(state, {
      ...envelope(state, "legacy-pause"),
      type: "project-team.task.control",
      control: { action: "pause", reason: "Pause unknown classification" },
    });
    state = trustedDrain(state);
    state = run(state, {
      ...envelope(state, "legacy-resume"),
      type: "project-team.task.control",
      control: { action: "resume", reason: "Restore controls without authorizing semantic work" },
    });
    expect(() =>
      decideProjectWorkCommand(state, nextClaim(state, fixture.command, "legacy-ordinary")),
    ).toThrow(/semantic.*repair/i);
    state = run(state, {
      ...envelope(state, "legacy-human-repair"),
      type: "project-team.repair.resolve",
      episodeId: episode.recordId,
      expectedEpisodeRevision: episode.revision,
      failureFingerprint: episode.failureFingerprint,
      relevantRevision: episode.relevantRevision,
      decision: "approve-one-repair",
      reason: "Authorize exactly one repair of this retained failure",
    });
    const current = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
        r.kind === "repair-episode",
    )!;
    const exception = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
        r.kind === "gate" && r.recordId === current.exceptionGrantId,
    )!;
    const ordinary = nextClaim(state, fixture.command, "legacy-exact-repair");
    if (ordinary.transition?.kind !== "claim") throw new Error("Claim required");
    const repaired = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        ...ordinary,
        transition: {
          ...ordinary.transition,
          repair: {
            episodeId: current.recordId,
            expectedEpisodeRevision: current.revision,
            exceptionGateId: exception.recordId,
            expectedExceptionGateRevision: exception.revision,
          },
          binding: { ...ordinary.transition.binding, repairEpisodeId: current.recordId },
        },
      }),
    );
    expect(repaired.foundationRecords!.find((r) => r.recordId === current.recordId)).toMatchObject({
      pendingSemanticRepair: false,
      semanticRepairs: 1,
      transportRetries: 1,
    });
  });
});

it("an exact Human exception above the exhausted allowance permits only its debited run's semantic report", () => {
  const fixture = activeRun();
  let state = fixture.state;
  for (let n = 1; n <= 3; n++) {
    state = internal(state, `exhausted-exception-failure-${n}`, {
      kind: "failure",
      bindingId: fixture.binding.recordId,
      generation: 0,
      expectedBindingRevision: 1,
      failureFingerprint: "exhausted-same-cause",
      relevantRevision: `tree-${n}`,
      failureKind: "semantic",
      summary: "Actual product failure",
    });
    if (n < 3) {
      const episode = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> =>
          r.kind === "repair-episode",
      )!;
      state = internal(state, `exhausted-exception-debit-${n}`, {
        kind: "repair.consume",
        bindingId: fixture.binding.recordId,
        generation: 0,
        episodeId: episode.recordId,
        expectedEpisodeRevision: episode.revision,
        relevantRevision: episode.relevantRevision,
      });
    }
  }
  let episode = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> => r.kind === "repair-episode",
  )!;
  state = run(state, {
    ...envelope(state, "authorize-exhausted-exception"),
    type: "project-team.repair.resolve",
    episodeId: episode.recordId,
    expectedEpisodeRevision: episode.revision,
    failureFingerprint: episode.failureFingerprint,
    relevantRevision: episode.relevantRevision,
    decision: "approve-one-repair",
    reason: "Approve this exact third repair once",
  });
  state = trustedDrain(state);
  state = run(state, {
    ...envelope(state, "resolve-exhausted-exception"),
    type: "project-team.task.control",
    control: { action: "resolve-failure", reason: "Use this exact granted exception" },
  });
  episode = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "repair-episode" }> => r.kind === "repair-episode",
  )!;
  const exception = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
      r.kind === "gate" && r.recordId === episode.exceptionGrantId,
  )!;
  const ordinary = nextClaim(state, fixture.command, "above-allowance-run");
  if (ordinary.transition?.kind !== "claim") throw new Error("Claim required");
  const command = {
    ...ordinary,
    transition: {
      ...ordinary.transition,
      repair: {
        episodeId: episode.recordId,
        expectedEpisodeRevision: episode.revision,
        exceptionGateId: exception.recordId,
        expectedExceptionGateRevision: exception.revision,
      },
      binding: { ...ordinary.transition.binding, repairEpisodeId: episode.recordId },
    },
  };
  state = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
  const reserved = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "run-binding" }> =>
      r.kind === "run-binding" && r.recordId === "above-allowance-run-run",
  )!;
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make("above-allowance-running"),
      expectedRevision: state.revision,
      records: [{ ...reserved, status: "running", revision: reserved.revision + 1 }],
      attribution,
      committedAt: at,
    }),
  );
  const assignment = state.foundationRecords!.find(
    (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
      r.kind === "task-membership" && r.taskId === taskId,
  )!;
  const intent: ProjectTeamGuidedIntent = {
    ...envelope(state, "above-allowance-report"),
    type: "project-team.assignment.report",
    assignmentId: assignment.recordId,
    expectedAssignmentRevision: assignment.revision,
    specRevision: 1,
    planRevision: 1,
    summary: "The exact authorized repair retained its progress",
    evidenceIds: [],
    outputArtifactIds: [],
    outcome: "findings",
  };
  const report = {
    ...compile(intent),
    attribution: {
      actor: { kind: "agent" as const, id: "worker" },
      source: { kind: "system" as const, id: "runtime" },
      recordedAt: at,
    },
    guided: { intent, bindingId: reserved.recordId, generation: reserved.generation },
  };
  const next = applyProjectWorkEvents(state, decideProjectWorkCommand(state, report));
  expect(next.evidence.find((e) => e.summary === intent.summary)).toBeDefined();
  expect(next.foundationRecords!.find((r) => r.recordId === episode.recordId)).toMatchObject({
    semanticRepairs: 3,
    allowance: 2,
    status: "exhausted",
    pendingSemanticRepair: false,
  });
});

const reviewSettlementFixture = () => {
  const f = reviewerReport();
  const binding = { ...f.binding, sessionId: "original-review-session" };
  const dispatchId = "original-review-dispatch";
  const state: ProjectWorkReducerState = {
    ...f.state,
    foundationRecords: [
      ...f.state.foundationRecords!.map((record) =>
        record.recordId === binding.recordId ? binding : record,
      ),
      {
        kind: "effect",
        projectId,
        recordId: "original-review-dispatch-effect",
        revision: 0,
        generation: binding.generation,
        updatedAt: at,
        status: "claimed",
        effectId: dispatchId,
        effectKind: "dispatch",
        taskId: binding.taskId,
        runId: binding.recordId,
        targetId: binding.recordId,
        payload: { recordIds: [binding.recordId], expectedRevision: f.state.revision },
        claimGeneration: 1,
        availableAt: at,
      },
    ],
  };
  const assignment = state.foundationRecords!.find(
    (record) => record.kind === "task-membership" && record.taskId === binding.taskId,
  )!;
  const parent = state.tasks.find((task) => task.taskId === taskId)!;
  const target = {
    projectId,
    taskId,
    specRevision: parent.specRevision,
    planRevision: 1,
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  };
  const provenance = {
    reviewTaskId: binding.taskId,
    bindingId: binding.recordId,
    generation: binding.generation,
    memberId: binding.memberId,
    providerInstanceId: binding.providerInstanceId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    initializeOperationId: "original-review-initialize",
    dispatchId,
    targetSha256: "a".repeat(64),
  };
  const finding = decodeTeamRecord({
    kind: "review-finding",
    projectId,
    recordId: "critical-parent-finding",
    revision: 0,
    generation: 0,
    updatedAt: at,
    findingId: "critical-parent-finding",
    taskId,
    target,
    severity: "critical",
    criterionIds: state.criteria.filter((c) => c.taskId === taskId).map((c) => c.criterionId),
    detail: "Parent code still requires repair",
    status: "open",
    resolutionArtifactIds: [],
    originReviewer: provenance,
    reportedBy: provenance,
  });
  state.foundationRecords!.push(finding);
  const criteria = state.criteria.filter((c) => c.taskId === binding.taskId);
  const proof = decodeReviewCompletionProof({
    status: "completed",
    proposalCommandId: f.intent.commandId,
    proposalSha256: "a".repeat(64),
    assignmentOperationId: "original-review-assignment",
    assignmentRequestHash: "a".repeat(64),
    assignmentReceiptSha256: "a".repeat(64),
    joinedReceiptId: "original-review-joined",
    joinedEvidenceSha256: "a".repeat(64),
    report: f.intent,
    reportAttribution: f.command.attribution,
    assignment,
    target,
    provenance,
    criteria: criteria.map((c) => ({
      id: c.criterionId,
      revision: c.revision,
      sha256: reviewSnapshotHash(c),
    })),
    evidence: [],
    outputs: (f.intent.outputs ?? []).map((output, index) => ({
      evidenceId: projectTeamDerivedRecordId(f.intent.commandId, `report-output:${index}`),
      criterionId: output.criterionId,
      sha256: reviewSnapshotHash({
        ...output,
        summary:
          output.summary ?? criteria.find((c) => c.criterionId === output.criterionId)!.description,
      }),
    })),
    reportEvidenceId: projectTeamDerivedRecordId(f.intent.commandId, "report-evidence"),
    reportCommentId: projectTeamDerivedRecordId(f.intent.commandId, "report"),
    findings: [
      { findingId: "critical-parent-finding", revision: 0, sha256: reviewSnapshotHash(finding) },
    ],
  });
  if (proof.status !== "completed") throw new Error("Completed proof fixture required");
  const child = state.tasks.find((task) => task.taskId === binding.taskId)!;
  const attempt = state.attempts.find((a) => a.attemptId === binding.attemptId)!;
  const command: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> = {
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("original-review-joined-command"),
    expectedRevision: state.revision,
    attribution: {
      actor: { kind: "system", id: "project-team-runtime" },
      source: { kind: "system", id: "project-team-runtime" },
      recordedAt: at,
    },
    records: [],
    committedAt: at,
    transition: {
      kind: "run.settle",
      reviewCompletion: proof,
      bindingId: binding.recordId,
      generation: binding.generation,
      expectedBindingRevision: binding.revision,
      taskId: binding.taskId,
      expectedTaskRevision: child.revision,
      attemptId: binding.attemptId,
      expectedAttemptRevision: attempt.revision,
      dispatchId,
      receiptId: "original-review-joined",
      effectIds: ["original-review-dispatch-effect"],
    },
  };
  return { state, command, proof, binding, parent };
};
const reviewSnapshotHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

it("trusted review settlement completes only the child with critical findings and leaves parent work unchanged", () => {
  const f = reviewSettlementFixture();
  const next = applyProjectWorkEvents(f.state, decideProjectWorkCommand(f.state, f.command));
  expect(next.tasks.find((task) => task.taskId === f.binding.taskId)?.state).toBe("completed");
  expect(next.attempts.find((attempt) => attempt.attemptId === f.binding.attemptId)?.state).toBe(
    "succeeded",
  );
  expect(next.tasks.find((task) => task.taskId === taskId)).toEqual(f.parent);
  expect(next.criteria.filter((c) => c.taskId === taskId)).toEqual(
    f.state.criteria.filter((c) => c.taskId === taskId),
  );
  expect(
    next.criteria
      .filter((c) => c.taskId === f.binding.taskId)
      .every((c) => c.status === "satisfied"),
  ).toBe(true);
  expect(
    next.foundationRecords!.find((record) => record.recordId === "critical-parent-finding"),
  ).toEqual(
    f.state.foundationRecords!.find((record) => record.recordId === "critical-parent-finding"),
  );
  expect(next.evidence.some((e) => e.evidenceId === f.proof.reportEvidenceId)).toBe(true);
  expect((next.comments ?? []).some((c) => c.commentId === f.proof.reportCommentId)).toBe(true);
  expect(
    next.foundationRecords!.find((record) => record.recordId === f.binding.recordId)?.status,
  ).toBe("settled");
});

it("trusted review settlement rejects a changed full criterion snapshot before any state mutation", () => {
  const f = reviewSettlementFixture();
  if (f.command.transition?.kind !== "run.settle") throw new Error("Settlement fixture required");
  const transition = f.command.transition;
  const before = canonicalProjectWorkPayload(f.state);
  expect(() =>
    decideProjectWorkCommand(f.state, {
      ...f.command,
      transition: {
        ...transition,
        reviewCompletion: {
          ...f.proof,
          criteria: f.proof.criteria.map((c) => ({ ...c, sha256: "d".repeat(64) })),
        },
      },
    }),
  ).toThrow();
  expect(canonicalProjectWorkPayload(f.state)).toBe(before);
});

it("trusted review settlement retains denied child attention after stopping without granting completion", () => {
  const f = reviewSettlementFixture();
  if (f.command.transition?.kind !== "run.settle") throw new Error("Settlement fixture required");
  const transition = f.command.transition;
  const next = applyProjectWorkEvents(
    f.state,
    decideProjectWorkCommand(f.state, {
      ...f.command,
      transition: {
        ...transition,
        reviewCompletion: {
          status: "denied",
          proposalCommandId: f.proof.proposalCommandId,
          proposalSha256: f.proof.proposalSha256,
          assignmentOperationId: f.proof.assignmentOperationId,
          reason: "stale-proof",
        },
      },
    }),
  );
  expect(next.tasks.find((task) => task.taskId === f.binding.taskId)).toMatchObject({
    state: "blocked",
  });
  expect(
    next.tasks.find((task) => task.taskId === f.binding.taskId)?.activeAttemptId,
  ).toBeUndefined();
  expect(next.attempts.find((a) => a.attemptId === f.binding.attemptId)?.state).toBe("canceled");
  expect(next.blockers.some((b) => b.taskId === f.binding.taskId && b.attention)).toBe(true);
  expect(next.evidence).toEqual(f.state.evidence);
  expect(next.tasks.find((task) => task.taskId === taskId)).toEqual(f.parent);
});

it("trusted review settlement rejects an unfinished child deliverable of the review task", () => {
  const f = reviewSettlementFixture();
  const nestedId = ProjectWorkTaskId.make("nested-review-deliverable");
  const state: ProjectWorkReducerState = {
    ...f.state,
    tasks: [...f.state.tasks, { ...f.parent, taskId: nestedId, state: "ready" }],
    foundationRecords: [
      ...f.state.foundationRecords!,
      {
        ...f.proof.assignment,
        recordId: "nested-review-membership",
        taskId: nestedId,
        parentTaskId: f.binding.taskId,
      },
    ],
  };
  expect(() => decideProjectWorkCommand(state, f.command)).toThrow();
});

it.each(["canceled", "paused", "successor"] as const)(
  "trusted review settlement does not revive %s assignments when a proposal is denied",
  (mode) => {
    const f = reviewSettlementFixture();
    if (f.command.transition?.kind !== "run.settle") throw new Error("Settlement fixture required");
    const transition = f.command.transition;
    const state: ProjectWorkReducerState = {
      ...f.state,
      tasks: f.state.tasks.map((task) =>
        task.taskId === f.binding.taskId && mode === "canceled"
          ? { ...task, state: "canceled" }
          : task,
      ),
      foundationRecords: f.state.foundationRecords!.map((record) =>
        record.kind === "task-membership" && record.taskId === f.binding.taskId
          ? {
              ...record,
              ...(mode === "paused" ? { controlState: "paused" as const } : {}),
              ...(mode === "successor"
                ? { requestedSuccessorMemberId: "replacement-reviewer" }
                : {}),
            }
          : record,
      ),
    };
    const next = applyProjectWorkEvents(
      state,
      decideProjectWorkCommand(state, {
        ...f.command,
        transition: {
          ...transition,
          reviewCompletion: {
            status: "denied",
            proposalCommandId: f.proof.proposalCommandId,
            proposalSha256: f.proof.proposalSha256,
            assignmentOperationId: f.proof.assignmentOperationId,
            reason: "control-changed",
          },
        },
      }),
    );
    expect(next.tasks.find((task) => task.taskId === f.binding.taskId)?.state).toBe(
      mode === "canceled" ? "canceled" : "ready",
    );
    expect(next.blockers).toEqual(state.blockers);
    expect(next.evidence).toEqual(state.evidence);
    expect(
      next.foundationRecords!.find(
        (record) => record.kind === "task-membership" && record.taskId === f.binding.taskId,
      ),
    ).toEqual(
      state.foundationRecords!.find(
        (record) => record.kind === "task-membership" && record.taskId === f.binding.taskId,
      ),
    );
    expect(next.attempts.find((a) => a.attemptId === f.binding.attemptId)?.state).toBe("canceled");
  },
);

it("trusted review settlement rejects exhausted task revisions before stopping and adding attention", () => {
  const f = reviewSettlementFixture();
  if (f.command.transition?.kind !== "run.settle") throw new Error("Settlement fixture required");
  const transition = f.command.transition;
  const revision = Number.MAX_SAFE_INTEGER - 1;
  const state: ProjectWorkReducerState = {
    ...f.state,
    tasks: f.state.tasks.map((task) =>
      task.taskId === f.binding.taskId ? { ...task, revision } : task,
    ),
  };
  expect(() =>
    decideProjectWorkCommand(state, {
      ...f.command,
      transition: {
        ...transition,
        expectedTaskRevision: revision,
        reviewCompletion: {
          status: "denied",
          proposalCommandId: f.proof.proposalCommandId,
          proposalSha256: f.proof.proposalSha256,
          assignmentOperationId: f.proof.assignmentOperationId,
          reason: "stale-proof",
        },
      },
    }),
  ).toThrow();
});
