import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countThreadDetailsStatuses,
  markFailedAgentsSeen,
  MAX_SEEN_FAILED_AGENTS,
  shortPlanLabel,
  threadDetailsStatusBucket,
  usageSummaryWindows,
} from "./threadDetails.ts";

describe("threadDetailsStatusBucket", () => {
  it("puts a waiting request ahead of the run's status", () => {
    expect(threadDetailsStatusBucket({ status: "failed", needsInput: true })).toBe("input");
  });

  it("buckets failed, finished and live statuses", () => {
    const bucket = (status: string | null) =>
      threadDetailsStatusBucket({ status, needsInput: false });
    expect(bucket("failed")).toBe("failed");
    expect(bucket("error")).toBe("failed");
    expect(["completed", "cancelled", "interrupted", "idle"].map(bucket)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(bucket("running")).toBe("running");
    expect(bucket("waiting")).toBe("running");
    expect(bucket(null)).toBe("running");
  });

  it("counts each bucket", () => {
    expect(countThreadDetailsStatuses(["running", "done", "done", "input"])).toEqual({
      running: 1,
      input: 1,
      failed: 0,
      done: 2,
    });
  });
});

describe("markFailedAgentsSeen", () => {
  it("drops the oldest marks past the cap", () => {
    const current = Array.from({ length: MAX_SEEN_FAILED_AGENTS }, (_, index) => `old-${index}`);
    const next = markFailedAgentsSeen(current, ["new"]);
    expect(next).toHaveLength(MAX_SEEN_FAILED_AGENTS);
    expect(next[0]).toBe("old-1");
    expect(next.at(-1)).toBe("new");
  });
});

describe("shortPlanLabel", () => {
  it("keeps only the plan's own name", () => {
    expect(shortPlanLabel("ChatGPT Pro 200 Subscription", "Codex")).toBe("Pro 200");
    expect(shortPlanLabel("Max 20x", "Claude")).toBe("Max 20x");
    expect(shortPlanLabel("Cursor Ultra", "Cursor")).toBe("Ultra");
  });

  it("drops a label that is only brand words", () => {
    expect(shortPlanLabel("Claude Subscription", "Claude")).toBeNull();
  });
});

describe("usageSummaryWindows", () => {
  const window = (id: string, usedPercent: number) =>
    ({ id, kind: "other", label: id, usedPercent }) as unknown as ServerProviderUsageWindow;

  it("keeps the two tightest windows in the provider's order", () => {
    const windows = [window("session", 20), window("weekly", 90), window("opus", 60)];
    expect(usageSummaryWindows(windows).map((entry) => entry.id)).toEqual(["weekly", "opus"]);
  });
});
