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
} from "./ProjectTeamPolicy.ts";

type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
const projectId = ProjectId.make("project-a");
const taskId = ProjectWorkTaskId.make("task-a");
const now = "2026-09-30T00:00:00.000Z";
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

  it.each(["legacy", "human"] as const)("accepts completed %s work", (executionKind) => {
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
