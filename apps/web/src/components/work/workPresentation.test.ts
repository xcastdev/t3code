import { describe, expect, it } from "vite-plus/test";

import {
  isWorkTab,
  taskNeedsSpecification,
  taskStateLabel,
  taskStateVariant,
  workReadStatus,
} from "./workPresentation";

describe("work presentation", () => {
  it("recognizes the three first-release tabs", () => {
    expect(isWorkTab("overview")).toBe(true);
    expect(isWorkTab("tasks")).toBe(true);
    expect(isWorkTab("knowledge")).toBe(true);
    expect(isWorkTab("activity")).toBe(false);
  });

  it("keeps draft tasks in the progressive specification step", () => {
    expect(taskNeedsSpecification({ state: "draft" })).toBe(true);
    expect(taskNeedsSpecification({ state: "specified" })).toBe(false);
    expect(taskStateLabel("in-progress")).toBe("In Progress");
    expect(taskStateVariant("blocked")).toBe("error");
  });

  it("distinguishes live, stale, and waiting reads", () => {
    expect(workReadStatus({ connected: true, hasValue: true })).toBe("live");
    expect(workReadStatus({ connected: false, hasValue: true })).toBe("stale");
    expect(workReadStatus({ connected: false, hasValue: false })).toBe("waiting");
  });
});
