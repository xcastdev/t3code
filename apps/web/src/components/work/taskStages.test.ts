import { describe, expect, it } from "vite-plus/test";

import { taskStages, type TaskStageInput } from "./taskStages";

const base: TaskStageInput = {
  state: "draft",
  hasSpecification: false,
  specificationGate: undefined,
  hasPlan: false,
  planGate: undefined,
  executionGranted: false,
  workerActive: false,
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
