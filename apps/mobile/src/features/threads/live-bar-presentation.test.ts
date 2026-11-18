import { describe, expect, it } from "vite-plus/test";

import {
  contextUsagePercent,
  formatLiveClock,
  lastTurnDurationMs,
  liveBarCardTargetWidth,
  presentChecklist,
  resolveScrollButtonPlacement,
  summarizeSideChats,
} from "./live-bar-presentation";

describe("formatLiveClock", () => {
  it.each([
    [0, "0:00"],
    [45_900, "0:45"],
    [61_000, "1:01"],
    [3_600_000 + 65_000, "1:01:05"],
    [-5, "0:00"],
  ])("formats %d ms as %s", (elapsed, label) => {
    expect(formatLiveClock(elapsed)).toBe(label);
  });
});

describe("lastTurnDurationMs", () => {
  it("measures a finished turn and ignores one without both ends", () => {
    expect(
      lastTurnDurationMs({
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:28.000Z",
      }),
    ).toBe(28_000);
    expect(lastTurnDurationMs({ startedAt: "2026-01-01T00:00:00.000Z", completedAt: null })).toBe(
      null,
    );
    expect(lastTurnDurationMs(null)).toBe(null);
  });
});

describe("summarizeSideChats", () => {
  const quiet = { hasPendingApprovals: false, hasPendingUserInput: false };

  it("flags side chats that wait on the user", () => {
    expect(summarizeSideChats([])).toBe(null);
    expect(summarizeSideChats([quiet, quiet])).toEqual({ count: 2, needsAttention: false });
    expect(summarizeSideChats([quiet, { ...quiet, hasPendingUserInput: true }])).toEqual({
      count: 2,
      needsAttention: true,
    });
    expect(summarizeSideChats([{ ...quiet, pendingSubagentRequest: "approval" }])).toEqual({
      count: 1,
      needsAttention: true,
    });
  });
});

describe("contextUsagePercent", () => {
  it("rounds and clamps a known percentage", () => {
    expect(contextUsagePercent({ usedPercentage: 33.6 })).toBe(34);
    expect(contextUsagePercent({ usedPercentage: 140 })).toBe(100);
    expect(contextUsagePercent({ usedPercentage: null })).toBe(null);
    expect(contextUsagePercent(null)).toBe(null);
  });
});

describe("live bar placement", () => {
  it("widens a strip to its minimum, and takes the full width when expanded", () => {
    const base = { rowWidth: 90, hasStrip: false, fullWidth: false, availableWidth: 360 };
    expect(liveBarCardTargetWidth(base)).toBe(90);
    expect(liveBarCardTargetWidth({ ...base, hasStrip: true })).toBe(196);
    expect(liveBarCardTargetWidth({ ...base, rowWidth: 400 })).toBe(360);
    expect(liveBarCardTargetWidth({ ...base, fullWidth: true })).toBe(360);
  });

  it.each([
    [{ visible: false, hasLiveBar: true, expanded: false, cardTargetWidth: 100 }, "hidden"],
    [{ visible: true, hasLiveBar: true, expanded: true, cardTargetWidth: 100 }, "hidden"],
    [{ visible: true, hasLiveBar: false, expanded: false, cardTargetWidth: 0 }, "alone"],
    [{ visible: true, hasLiveBar: true, expanded: false, cardTargetWidth: 219 }, "beside"],
    [{ visible: true, hasLiveBar: true, expanded: false, cardTargetWidth: 220 }, "above"],
  ] as const)("places the scroll button for %o as %s", (input, placement) => {
    expect(resolveScrollButtonPlacement(input)).toBe(placement);
  });
});

describe("presentChecklist", () => {
  it("names the running step and labels known durations", () => {
    const checklist = presentChecklist([
      { id: "a", text: "Read the manifest", status: "completed", durationMs: 6_000 },
      { id: "b", text: "Add a clamp helper", status: "running" },
      { id: "c", text: "Run the tests", status: "pending" },
    ]);
    expect(checklist).toMatchObject({
      total: 3,
      done: 1,
      position: 2,
      currentText: "Add a clamp helper",
      allDone: false,
    });
    expect(checklist?.steps.map((step) => step.durationLabel)).toEqual(["6s", null, null]);
  });

  it("falls back to the next pending step, then to done", () => {
    expect(
      presentChecklist([
        { id: "a", text: "One", status: "completed" },
        { id: "b", text: "Two", status: "pending" },
      ]),
    ).toMatchObject({ position: 2, currentText: "Two" });
    expect(presentChecklist([{ id: "a", text: "One", status: "completed" }])).toMatchObject({
      position: 1,
      currentText: "All steps done",
      allDone: true,
    });
    expect(presentChecklist([])).toBe(null);
  });
});
