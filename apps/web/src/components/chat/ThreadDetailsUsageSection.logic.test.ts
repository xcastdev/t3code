import { describe, expect, it } from "vite-plus/test";

import { shortPlanLabel } from "./ThreadDetailsUsageSection.logic";

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
