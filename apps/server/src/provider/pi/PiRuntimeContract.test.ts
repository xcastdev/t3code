import { describe, expect, it } from "vitest";

import events from "./fixtures/runtime-events.json";

// These retained SDK traces are a regression oracle for future driver tests.
// They do not execute pi or establish live model, isolation, or packaging readiness.
describe("pi 0.99.1 runtime event oracle", () => {
  it("requires settlement after automatic recovery, beyond the first agent_end", () => {
    const lifecycle = events.retry.filter((event) =>
      ["agent_start", "agent_end", "auto_retry_start", "auto_retry_end", "agent_settled"].includes(
        event,
      ),
    );

    expect(lifecycle).toEqual([
      "agent_start",
      "agent_end",
      "auto_retry_start",
      "agent_start",
      "auto_retry_end",
      "agent_end",
      "agent_settled",
    ]);
  });

  it("retains steering and follow-up turns inside the unsettled run", () => {
    const lifecycle = events.steeringAndFollowUp.filter((event) =>
      ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled"].includes(event),
    );

    expect(lifecycle).toEqual([
      "agent_start",
      "turn_start",
      "turn_end",
      "turn_start",
      "turn_end",
      "turn_start",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(events.steeringAndFollowUp.filter((event) => event === "queue_update")).toHaveLength(4);
  });
});
