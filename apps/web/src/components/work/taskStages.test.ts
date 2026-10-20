import { describe, expect, it } from "vite-plus/test";

import { ProjectTeamRecord, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { linkedTaskProvenance, taskStages, type TaskStageInput } from "./taskStages";

const base: TaskStageInput = {
  state: "draft",
  hasSpecification: false,
  specificationGate: undefined,
  hasPlan: false,
  planGate: undefined,
  executionGranted: false,
  workersRunning: false,
};
const statuses = (input: TaskStageInput) =>
  taskStages(input).stages.map((stage) => `${stage.id}:${stage.status}`);

describe("taskStages", () => {
  it("starts at scope and asks for a specification", () => {
    expect(statuses(base)).toEqual([
      "scope:current",
      "plan:upcoming",
      "execution:upcoming",
      "review:upcoming",
    ]);
    expect(taskStages(base).next).toBe("Propose a specification");
  });

  it("does not treat a proposed specification as approved", () => {
    const result = taskStages({ ...base, hasSpecification: true, specificationGate: "pending" });
    expect(result.stages[0]?.status).toBe("current");
    expect(result.next).toBe("Approve or reject the specification");
  });

  it("keeps scope current when its approval was invalidated", () => {
    const result = taskStages({
      ...base,
      hasSpecification: true,
      specificationGate: "invalidated",
      hasPlan: true,
      planGate: "approved",
    });
    expect(result.stages.map((stage) => stage.status)).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("moves to review only after authorized execution and the in-review state", () => {
    const approved = {
      ...base,
      hasSpecification: true,
      specificationGate: "approved",
      hasPlan: true,
      planGate: "consumed",
    } as const;
    expect(statuses({ ...approved, state: "in-progress", executionGranted: true })).toEqual([
      "scope:done",
      "plan:done",
      "execution:current",
      "review:upcoming",
    ]);
    expect(statuses({ ...approved, state: "in-review", executionGranted: true })).toEqual([
      "scope:done",
      "plan:done",
      "execution:done",
      "review:current",
    ]);
  });

  it("names blocked and canceled tasks instead of a stage action", () => {
    expect(taskStages({ ...base, state: "blocked" }).next).toMatch(/^Blocked/);
    expect(taskStages({ ...base, state: "canceled" }).next).toMatch(/^Canceled/);
  });
});

describe("taskStages worker display", () => {
  const approved = {
    ...base,
    state: "in-progress",
    hasSpecification: true,
    specificationGate: "approved",
    hasPlan: true,
    planGate: "approved",
    executionGranted: true,
  } as const;
  it("names running workers only when a binding is running", () => {
    expect(taskStages({ ...approved, workersRunning: true }).next).toBe(
      "Workers recorded as running",
    );
    expect(taskStages({ ...approved, workersRunning: false }).next).toBe("Execution authorized");
  });
});

describe("linkedTaskProvenance", () => {
  const decode = Schema.decodeUnknownSync(ProjectTeamRecord);
  const at = "2026-10-01T10:00:00.000Z";
  const fields = { projectId: "project-1", revision: 1, generation: 0, updatedAt: at };
  const membership = (extra: Record<string, unknown> = {}) => {
    const record = decode({
      ...fields,
      recordId: "membership",
      kind: "task-membership",
      status: "active",
      taskId: "child",
      executionKind: "managed",
      deliverableKind: "plan",
      ...extra,
    });
    if (record.kind !== "task-membership") throw new Error("membership expected");
    return record;
  };
  const gate = (recordId: string) => {
    const record = decode({
      ...fields,
      recordId,
      kind: "gate",
      status: "approved",
      taskId: "child",
      gate: "investigation",
      specRevision: 1,
      planRevision: 0,
      contentHash: "scope",
      evidenceIds: [],
      attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt: at },
    });
    if (record.kind !== "gate") throw new Error("gate expected");
    return record;
  };
  const child = {
    parentTaskId: "parent",
    assignment: { authorizationGateId: "grant", outputDescriptions: ["Findings"] },
  };

  it("returns null for a root task so the stage rail applies", () => {
    expect(linkedTaskProvenance(membership(), [gate("grant")])).toBeNull();
    expect(linkedTaskProvenance(undefined, [])).toBeNull();
    // Root execution start records an assignment without parent lineage.
    expect(
      linkedTaskProvenance(membership({ assignment: child.assignment }), [gate("grant")]),
    ).toBeNull();
  });

  it("reports the single recorded authorization gate", () => {
    expect(linkedTaskProvenance(membership(child), [gate("grant")])).toEqual({
      parentTaskId: "parent",
      kind: "investigation",
      gateId: "grant",
      gateKind: "investigation",
      gateStatus: "approved",
    });
  });

  it("leaves the gate unknown when it is missing, ambiguous or belongs to another task", () => {
    const foreign = { ...gate("grant"), taskId: ProjectWorkTaskId.make("other") };
    for (const gates of [[], [gate("grant"), gate("grant")], [foreign]])
      expect(linkedTaskProvenance(membership(child), gates)).toMatchObject({
        gateId: "grant",
        gateKind: undefined,
        gateStatus: undefined,
      });
  });
});
