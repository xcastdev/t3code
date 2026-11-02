import { describe, expect, it } from "vite-plus/test";

import { createChecklistSteps, formatChecklist, updateChecklistStep } from "./checklist.ts";

const statuses = (steps: ReturnType<typeof createChecklistSteps> | string) =>
  typeof steps === "string" ? steps : steps.map((step) => step.status);

describe("checklist", () => {
  it("starts the first step when a checklist is created", () => {
    expect(statuses(createChecklistSteps(["Read", "Fix", "Test"]))).toEqual([
      "running",
      "pending",
      "pending",
    ]);
  });

  it("starts the next step when one is done", () => {
    const steps = createChecklistSteps(["Read", "Fix", "Test"]);
    expect(statuses(updateChecklistStep(steps, 1, "done"))).toEqual([
      "completed",
      "running",
      "pending",
    ]);
  });

  it("keeps one step in progress at a time", () => {
    const steps = createChecklistSteps(["Read", "Fix", "Test"]);
    expect(statuses(updateChecklistStep(steps, 3, "in_progress"))).toEqual([
      "pending",
      "pending",
      "running",
    ]);
  });

  it("goes back to an earlier pending step once the last is done", () => {
    const steps = updateChecklistStep(createChecklistSteps(["Read", "Fix"]), 2, "in_progress");
    if (typeof steps === "string") throw new Error(steps);
    expect(statuses(updateChecklistStep(steps, 2, "done"))).toEqual(["running", "completed"]);
  });

  it("names the valid range for a step that doesn't exist", () => {
    const steps = createChecklistSteps(["Read", "Fix"]);
    expect(updateChecklistStep(steps, 3, "done")).toBe(
      "Step 3 doesn't exist. The checklist has steps 1 to 2.",
    );
    expect(updateChecklistStep(steps, 0, "done")).toBe(
      "Step 0 doesn't exist. The checklist has steps 1 to 2.",
    );
  });

  it("numbers steps the way update refers to them", () => {
    expect(formatChecklist(createChecklistSteps(["Read", "Fix"]))).toBe(
      "1. [in progress] Read\n2. [pending] Fix",
    );
  });
});
