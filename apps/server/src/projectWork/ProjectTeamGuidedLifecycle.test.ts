import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkAttemptId,
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

import { projectTeamSpecificationHash } from "./ProjectTeamPolicy.ts";

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
const waiverIntent = (state: ProjectWorkReducerState, commandId = "waive") => ({
  ...envelope(state, commandId),
  type: "project-team.criterion.waiver" as const,
  criterionId: state.criteria[0]!.criterionId,
  expectedCriterionRevision: state.criteria[0]!.revision,
  expectedSpecRevision: state.tasks[0]!.specRevision,
  expectedSpecificationHash: projectTeamSpecificationHash(state, taskId),
  action: { kind: "waive" as const, reason: "Human exception", evidenceIds: [] },
});

it("revokes only the selected guided waiver and audits historical retry without restoring it", () => {
  const before = planned();
  const intent = waiverIntent(before);
  const originalEvents = decideProjectWorkCommand(before, compile(intent));
  const waived = applyProjectWorkEvents(before, originalEvents);
  expect(waived.tasks[0]!.revision).toBe(before.tasks[0]!.revision);
  expect(waived.criteria[0]).toMatchObject({ status: "waived", waiver: { attribution } });
  const another = {
    ...waived.criteria[0]!,
    criterionId: ProjectWorkCriterionId.make("independent-waiver"),
    description: "Independent exception",
    satisfiedByEvidenceIds: [ProjectWorkEvidenceId.make("preserved-evidence")],
  };
  const withOther = { ...waived, criteria: [...waived.criteria, another] };
  const revoke = { ...waiverIntent(withOther, "revoke"), action: { kind: "revoke" as const } };
  const reversed = run(withOther, revoke);
  expect(reversed.criteria[0]).toMatchObject({
    status: "unsatisfied",
    revision: waived.criteria[0]!.revision + 1,
  });
  expect(reversed.criteria[0]!.waiver).toBeUndefined();
  expect(reversed.criteria[1]).toEqual(another);
  expect(() =>
    assertProjectTeamGuidedReplayCurrent(reversed, intent, originalEvents),
  ).not.toThrow();
  expect(reversed.criteria[0]!.waiver).toBeUndefined();
  expect(() =>
    assertProjectTeamGuidedReplayCurrent(reversed, intent, originalEvents.slice(1)),
  ).toThrow(/waiver/);
});

it("denies stale, foreign and protected guided waiver targets", () => {
  const state = planned();
  const intent = waiverIntent(state);
  for (const change of [
    { expectedCriterionRevision: intent.expectedCriterionRevision + 1 },
    { expectedSpecRevision: intent.expectedSpecRevision + 1 },
    { expectedSpecificationHash: "b".repeat(64) },
    { criterionId: ProjectWorkCriterionId.make("foreign-criterion") },
  ])
    expect(() => run(state, { ...intent, ...change })).toThrow();
  const protectedState = {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      specification: { ...task.specification!, protected: true },
    })),
  };
  expect(() => run(protectedState, waiverIntent(protectedState))).toThrow(
    /protected specification/,
  );
  expect(() => run(state, { ...intent, action: { kind: "revoke" } })).toThrow(/no current waiver/);
});
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
    ).toThrow();
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
    expect(() => decideProjectWorkCommand(state, claim)).toThrow();
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
    ).toThrow();
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
});

const inheritedStart = (
  state: ProjectWorkReducerState,
  kind: "planning" | "review" | "implementation",
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
    ...(kind === "implementation"
      ? {
          parentCriterionIds: state.tasks.find((t) => t.taskId === taskId)!.specification!
            .criterionIds,
        }
      : {}),
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

it("implementation children retain approved criteria and immutable root policy", () => {
  const approved = planned();
  const derived = run(approved, inheritedStart(approved, "implementation", "derive"));
  const child = derived.tasks.find((entry) => entry.taskId !== taskId)!;
  const parentMembership = derived.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === taskId,
  )!;
  const childMembership = derived.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === child.taskId,
  )!;
  expect(parentMembership.kind).toBe("task-membership");
  if (parentMembership.kind !== "task-membership" || childMembership.kind !== "task-membership")
    throw new Error("Missing memberships");
  expect(childMembership.rootConstraints).toEqual(parentMembership.rootConstraints);
  expect(childMembership.rootConstraints?.rootTaskId).toBe(taskId);
  expect(childMembership.rootConstraints?.deadline).toBeUndefined();
  expect(child.specification?.scopeIn).toBe(approved.tasks[0]!.specification!.scopeIn);
  expect(derived.criteria.find((c) => c.taskId === child.taskId)?.description).toBe(
    approved.criteria[0]!.description,
  );
  expect(derived.attempts).toEqual([]);
  expect(
    derived.foundationRecords!.some((r) => r.kind === "run-binding" || r.kind === "effect"),
  ).toBe(false);
  const changed = {
    ...parentMembership,
    rootConstraints: { ...parentMembership.rootConstraints!, maximumDelegationDepth: 8 },
    revision: parentMembership.revision + 1,
  };
  const changedAgain = {
    ...changed,
    rootConstraints: { ...changed.rootConstraints, repairAllowance: 16 },
  };
  expect(() =>
    decideProjectWorkCommand(derived, {
      type: "project-work.foundation.commit",
      commandId: CommandId.make("mutate-frozen"),
      expectedRevision: derived.revision,
      projectId,
      records: [changedAgain],
      attribution,
      committedAt: at,
    }),
  ).toThrow(/Frozen root constraints/);
  expect(() =>
    run(approved, {
      ...inheritedStart(approved, "implementation", "bad-criteria"),
      parentCriterionIds: [ProjectWorkCriterionId.make("foreign")],
    }),
  ).toThrow(/criteria/);
});
it("pause, resume, cancel and reopen preserve the frozen root policy", () => {
  let state = run(planned(), startIntent(planned()));
  const root = state.foundationRecords!.find(
    (r) => r.kind === "task-membership" && r.taskId === taskId,
  );
  for (const action of ["pause", "resume", "cancel", "reopen"] as const) {
    state = run(state, {
      ...envelope(state, action),
      type: "project-team.task.control",
      control: { action, reason: "Human steering" },
    });
    const current = state.foundationRecords!.find(
      (r) => r.kind === "task-membership" && r.taskId === taskId,
    );
    if (root?.kind !== "task-membership" || current?.kind !== "task-membership")
      throw new Error("Missing root membership");
    expect(current.rootConstraints).toEqual(root.rootConstraints);
    expect(state.attempts).toEqual([]);
  }
  expect(state.tasks[0]!.canceledAt).toBeUndefined();
});

it("requires the approved protected-revision route when replacing a protected specification", () => {
  const state = propose();
  const intent: ProjectTeamGuidedIntent = {
    ...envelope(state, "replace-specification"),
    type: "project-team.specification.propose",
    expectedSpecRevision: 1,
    specification: {
      ...state.tasks[0]!.specification!,
      objective: "Changed objective",
      scopeIn: "Broader scope",
      revision: 2,
      protected: false,
    },
    criterionSnapshots: state.criteria,
  };
  const protectedState = {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      specification: { ...task.specification!, protected: true },
    })),
  };
  const before = structuredClone(protectedState);
  expect(() => run(protectedState, intent)).toThrow(/approved protected specification revision/);
  expect(protectedState).toEqual(before);
  expect(run(state, intent).tasks[0]!.specification).toMatchObject({
    objective: "Changed objective",
    revision: 2,
    protected: false,
  });
});
