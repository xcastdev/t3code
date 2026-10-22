import {
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamRecord,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  evaluateProjectTeamDependency,
  evaluateProjectTeamGate,
  type ProjectTeamGateTarget,
  assertProjectTeamAssignmentAuthorization,
  projectTeamSpecificationHash,
  projectTeamScopeHash,
  projectTeamPlanHash,
  assertProjectTeamOrdinarySuccessor,
} from "./ProjectTeamPolicy.ts";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
type RepairEpisode = Extract<ProjectTeamRecord, { kind: "repair-episode" }>;
const projectId = ProjectId.make("project-a");
const taskId = ProjectWorkTaskId.make("task-a");
const now = "2026-09-30T00:00:00.000Z";
describe("ordinary successor repair fence", () => {
  const episode: RepairEpisode = {
    kind: "repair-episode",
    recordId: "episode",
    projectId,
    taskId,
    rootTaskId: taskId,
    revision: 0,
    generation: 0,
    updatedAt: now,
    status: "active",
    failureFingerprint: "failure",
    relevantRevision: "tree-a",
    allowance: 2,
    semanticRepairs: 0,
    transportRetries: 0,
    timeoutCount: 0,
    attemptIds: [],
  };
  it.each([undefined, true])("denies pending or ambiguous semantic history %s", (pending) => {
    const current =
      pending === undefined ? episode : { ...episode, pendingSemanticRepair: pending };
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [current] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).toThrow(
      "exact repair authorization",
    );
  });
  it("allows explicit transport-only or already debited history without resetting counters", () => {
    const current = {
      ...episode,
      pendingSemanticRepair: false,
      transportRetries: 3,
      semanticRepairs: 1,
    };
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [current] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).not.toThrow();
    expect(current.semanticRepairs).toBe(1);
    expect(current.transportRetries).toBe(3);
  });
  it("denies exhausted history even after a prior debit", () => {
    const state = {
      ...emptyProjectWorkReducerState(projectId),
      foundationRecords: [
        { ...episode, status: "exhausted" as const, pendingSemanticRepair: false },
      ],
    };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).toThrow();
  });
  it("ignores another task's episode", () => {
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [episode] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, "other-task")).not.toThrow();
  });
});
const gate = (overrides: Partial<Gate> = {}): Gate => ({
  kind: "gate",
  recordId: "execution-approval",
  projectId,
  taskId,
  revision: 1,
  generation: 0,
  updatedAt: now,
  gate: "execution",
  status: "approved",
  specRevision: 3,
  planRevision: 2,
  contentHash: "approved-assignment",
  evidenceIds: ["validation", "review"],
  attribution: {
    actor: { kind: "human", id: "maintainer" },
    source: { kind: "web", id: "client" },
    recordedAt: now,
  },
  ...overrides,
});
const target = (overrides: Partial<ProjectTeamGateTarget> = {}): ProjectTeamGateTarget => ({
  projectId,
  taskId,
  gate: "execution",
  specRevision: 3,
  planRevision: 2,
  contentHash: "approved-assignment",
  evidenceIds: ["validation", "review"],
  ...overrides,
});
const mergeTarget = (): ProjectTeamGateTarget =>
  target({
    gate: "merge",
    repository: "github.com/team/repo",
    pullRequestNumber: 17,
    headSha: "approved-head",
    targetBranch: "main",
    mergeMethod: "squash",
  });
const task = (overrides: Partial<ProjectWorkTask> = {}): ProjectWorkTask => ({
  projectId,
  taskId,
  title: "Dependency",
  state: "completed",
  watchers: [],
  revision: 4,
  specRevision: 3,
  createdAt: now,
  updatedAt: now,
  completedAt: now,
  ...overrides,
});
const membership = (overrides: Partial<Membership> = {}): Membership => ({
  kind: "task-membership",
  recordId: "membership-a",
  projectId,
  taskId,
  revision: 0,
  generation: 0,
  updatedAt: now,
  status: "active",
  executionKind: "managed",
  deliverableKind: "research",
  ...overrides,
});

describe("inherited assignment authorization", () => {
  const fixture = () => {
    const state = emptyProjectWorkReducerState(projectId);
    state.tasks.push(
      task({
        state: "ready",
        specification: {
          objective: "Approved objective",
          scopeIn: "One deliverable",
          scopeOut: "Unapproved implementation",
          criterionIds: [],
          revision: 3,
          protected: true,
        },
      }),
    );
    state.foundationRecords = [membership({ deliverableKind: "code" })];
    const specificationHash = projectTeamSpecificationHash(state, taskId);
    state.foundationRecords.push(
      gate({
        recordId: "specification",
        gate: "specification",
        contentHash: specificationHash,
        planRevision: 0,
        evidenceIds: [],
      }),
    );
    const assignment = gate({
      recordId: "planning",
      taskId: ProjectWorkTaskId.make("child"),
      gate: "assignment",
      specRevision: 1,
      planRevision: 0,
      evidenceIds: [],
      assignmentAuthorization: {
        assignmentKind: "planning",
        parentTaskId: taskId,
        parentSpecRevision: 3,
        parentSpecificationGateId: "specification",
        parentSpecificationHash: specificationHash,
        parentScopeHash: projectTeamScopeHash(state, taskId),
      },
    });
    return { state, assignment };
  };

  it("permits first-plan drafting from the exact Human-approved specification", () => {
    const { state, assignment } = fixture();
    expect(assertProjectTeamAssignmentAuthorization(state, assignment)).toEqual(
      assignment.assignmentAuthorization,
    );
  });

  it("rejects stale, foreign, unapproved and paused parent authority", () => {
    for (const change of ["specification", "approval", "pause", "project"] as const) {
      const { state, assignment } = fixture();
      if (change === "specification") state.tasks[0] = { ...state.tasks[0]!, specRevision: 4 };
      if (change === "approval")
        state.foundationRecords = state.foundationRecords!.map((record) =>
          record.kind === "gate" ? { ...record, status: "invalidated" } : record,
        );
      if (change === "pause")
        state.foundationRecords = state.foundationRecords!.map((record) =>
          record.kind === "task-membership" ? { ...record, controlState: "paused" } : record,
        );
      if (change === "project")
        state.tasks[0] = { ...state.tasks[0]!, projectId: ProjectId.make("foreign") };
      expect(() => assertProjectTeamAssignmentAuthorization(state, assignment)).toThrow();
    }
  });

  it("requires the review's exact approved parent plan and invalidates moved scope", () => {
    const { state, assignment } = fixture();
    const plan: Extract<ProjectTeamRecord, { kind: "plan-revision" }> = {
      kind: "plan-revision",
      recordId: "parent-plan",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: now,
      status: "proposed",
      taskId,
      specRevision: 3,
      planRevision: 1,
      content: "Approved bounded plan",
      dependencyTaskIds: [],
      contentHash: projectTeamPlanHash({ content: "Approved bounded plan", dependencyTaskIds: [] }),
    };
    state.foundationRecords!.push(
      plan,
      gate({
        recordId: "plan-approval",
        gate: "plan",
        contentHash: plan.contentHash,
        specRevision: 3,
        planRevision: 1,
        evidenceIds: [],
      }),
    );
    expect(() => assertProjectTeamAssignmentAuthorization(state, assignment)).toThrow();
    const review = {
      ...assignment,
      assignmentAuthorization: {
        ...assignment.assignmentAuthorization!,
        assignmentKind: "review" as const,
        parentScopeHash: projectTeamScopeHash(state, taskId, plan),
        parentPlan: {
          recordId: plan.recordId,
          planRevision: 1,
          contentHash: plan.contentHash,
          gateId: "plan-approval",
        },
      },
    };
    expect(assertProjectTeamAssignmentAuthorization(state, review)).toEqual(
      review.assignmentAuthorization,
    );
    state.foundationRecords = state.foundationRecords!.map((record) =>
      record.recordId === plan.recordId && record.kind === "plan-revision"
        ? { ...record, content: "Changed plan" }
        : record,
    );
    expect(() => assertProjectTeamAssignmentAuthorization(state, review)).toThrow();
  });
});

describe("evaluateProjectTeamGate", () => {
  it.each(["investigation", "specification", "plan", "execution"] as const)(
    "accepts an exact human-approved %s target",
    (kind) => {
      expect(evaluateProjectTeamGate(gate({ gate: kind }), target({ gate: kind }))).toEqual({
        available: true,
      });
    },
  );

  it("rejects a missing approval", () => {
    expect(evaluateProjectTeamGate(undefined, target())).toEqual({
      available: false,
      reason: "missing-gate",
    });
  });

  it.each(["proposed", "pending", "rejected", "invalidated", "consumed"] as const)(
    "rejects a %s gate without renewing it",
    (status) => {
      expect(evaluateProjectTeamGate(gate({ status }), target())).toEqual({
        available: false,
        reason: "gate-not-approved",
      });
    },
  );

  it("rejects agent-attributed approval", () => {
    const approval = gate();
    expect(
      evaluateProjectTeamGate(
        { ...approval, attribution: { ...approval.attribution, actor: { kind: "agent" } } },
        target(),
      ),
    ).toEqual({ available: false, reason: "human-approval-required" });
  });

  it.each([
    { projectId: ProjectId.make("project-b") },
    { taskId: ProjectWorkTaskId.make("task-b") },
    { gate: "plan" as const },
    { specRevision: 4 },
    { planRevision: 3 },
    { contentHash: "new-assignment" },
  ])("rejects approval for another target: %j", (change) => {
    expect(evaluateProjectTeamGate(gate(), target(change))).toEqual({
      available: false,
      reason: "stale-gate-target",
    });
  });

  it("treats evidence identity as a set", () => {
    expect(
      evaluateProjectTeamGate(gate(), target({ evidenceIds: ["review", "validation"] })),
    ).toEqual({ available: true });
  });

  it.each([["review"], ["review", "validation", "integration"], ["review", "other"]])(
    "rejects changed applicable evidence: %j",
    (...evidenceIds) => {
      expect(evaluateProjectTeamGate(gate(), target({ evidenceIds }))).toEqual({
        available: false,
        reason: "stale-gate-evidence",
      });
    },
  );

  it.each([
    ["review", "review"],
    [""],
    ["   "],
    [" review"],
    ["review "],
    ["x".repeat(257)],
    Array.from({ length: 65 }, (_, index) => `evidence-${index}`),
  ])("rejects malformed evidence in either side: %j", (...evidenceIds) => {
    expect(evaluateProjectTeamGate(gate({ evidenceIds }), target())).toEqual({
      available: false,
      reason: "invalid-gate-evidence",
    });
    expect(evaluateProjectTeamGate(gate(), target({ evidenceIds }))).toEqual({
      available: false,
      reason: "invalid-gate-evidence",
    });
  });

  it("accepts a merge approval for the exact remote target", () => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate(current), current)).toEqual({ available: true });
  });

  it.each([
    { repository: "github.com/team/other" },
    { pullRequestNumber: 18 },
    { headSha: "new-head" },
    { targetBranch: "release" },
    { mergeMethod: "rebase" as const },
  ])("rejects changed merge target: %j", (change) => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate(current), { ...current, ...change })).toEqual({
      available: false,
      reason: "stale-merge-target",
    });
  });

  it.each(["repository", "pullRequestNumber", "headSha", "targetBranch", "mergeMethod"] as const)(
    "rejects absent merge %s in either side",
    (field) => {
      const current = mergeTarget();
      const incomplete = { ...current };
      delete incomplete[field];
      expect(evaluateProjectTeamGate(gate(incomplete), current)).toEqual({
        available: false,
        reason: "invalid-merge-target",
      });
      expect(evaluateProjectTeamGate(gate(current), incomplete)).toEqual({
        available: false,
        reason: "invalid-merge-target",
      });
    },
  );

  it.each([
    { repository: " " },
    { headSha: "" },
    { targetBranch: " main" },
    { pullRequestNumber: 0 },
    { pullRequestNumber: -1 },
    { pullRequestNumber: 1.5 },
  ])("rejects malformed merge tuple: %j", (change) => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate({ ...current, ...change }), current)).toEqual({
      available: false,
      reason: "invalid-merge-target",
    });
  });

  it("permits empty applicable evidence without inventing evidence requirements", () => {
    expect(evaluateProjectTeamGate(gate({ evidenceIds: [] }), target({ evidenceIds: [] }))).toEqual(
      { available: true },
    );
  });
});

describe("evaluateProjectTeamDependency", () => {
  const evaluate = (
    dependency: ProjectWorkTask | undefined,
    memberships: ReadonlyArray<Membership>,
  ) => evaluateProjectTeamDependency({ projectId, taskId, task: dependency, memberships });

  it("accepts completed legacy work without membership", () => {
    expect(evaluate(task(), [])).toEqual({ available: true });
  });

  it.each(["human"] as const)("accepts completed %s work", (executionKind) => {
    expect(evaluate(task(), [membership({ executionKind, deliverableKind: "code" })])).toEqual({
      available: true,
    });
  });

  it.each(["research", "plan", "review", "reminder", "non-code"] as const)(
    "accepts completed managed %s without requiring a PR",
    (deliverableKind) => {
      expect(evaluate(task(), [membership({ deliverableKind })])).toEqual({ available: true });
    },
  );

  it("does not treat completed managed code as delivered", () => {
    expect(evaluate(task(), [membership({ deliverableKind: "code" })])).toEqual({
      available: false,
      reason: "delivery-proof-required",
    });
  });

  it.each([
    "draft",
    "specified",
    "ready",
    "in-progress",
    "blocked",
    "in-review",
    "failed",
    "canceled",
  ] as const)("does not treat %s as dependency success", (state) => {
    expect(evaluate(task({ state }), [membership()])).toEqual({
      available: false,
      reason: "dependency-not-completed",
    });
  });

  it("rejects a missing dependency", () => {
    expect(evaluate(undefined, [])).toEqual({ available: false, reason: "missing-dependency" });
  });

  it("rejects a dependency from another project", () => {
    expect(evaluate(task({ projectId: ProjectId.make("project-b") }), [])).toEqual({
      available: false,
      reason: "dependency-project-mismatch",
    });
  });

  it("rejects another task passed as the dependency", () => {
    expect(evaluate(task({ taskId: ProjectWorkTaskId.make("task-b") }), [])).toEqual({
      available: false,
      reason: "dependency-task-mismatch",
    });
  });

  it("rejects a matching membership from another project", () => {
    expect(evaluate(task(), [membership({ projectId: ProjectId.make("project-b") })])).toEqual({
      available: false,
      reason: "dependency-project-mismatch",
    });
  });

  it("does not downgrade removed managed code membership to legacy", () => {
    expect(evaluate(task(), [membership({ status: "removed", deliverableKind: "code" })])).toEqual({
      available: false,
      reason: "dependency-membership-removed",
    });
  });

  it("rejects conflicting memberships regardless of input order", () => {
    const records = [
      membership(),
      membership({ recordId: "membership-b", deliverableKind: "code" }),
    ];
    expect(evaluate(task(), records)).toEqual({
      available: false,
      reason: "ambiguous-dependency-membership",
    });
    expect(evaluate(task(), records.toReversed())).toEqual({
      available: false,
      reason: "ambiguous-dependency-membership",
    });
  });

  it("ignores unrelated task membership", () => {
    expect(
      evaluate(task(), [
        membership({ taskId: ProjectWorkTaskId.make("task-b"), deliverableKind: "code" }),
      ]),
    ).toEqual({ available: true });
  });
});
