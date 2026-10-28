import { describe, expect, it } from "vite-plus/test";

import { memberActivity } from "./workTeamView";

describe("memberActivity", () => {
  it("does not mistake an enabled member or a finished run for a running worker", () => {
    expect(memberActivity("active", [{ status: "settled", taskId: "old" }], [], true).state).toBe(
      "available",
    );
    expect(memberActivity("paused", [], [], true).state).toBe("paused");
  });

  it("shows a question only when it belongs to the member's current work", () => {
    const bindings = [
      { status: "running", taskId: "current" },
      { status: "settled", taskId: "old" },
    ];
    expect(memberActivity("active", bindings, ["old"], true).state).toBe("running");
    expect(memberActivity("active", bindings, ["current"], true).state).toBe("waiting");
  });

  it("keeps recovery and stopping visible and never claims availability from incomplete records", () => {
    expect(
      memberActivity("active", [{ status: "quarantined", taskId: "unknown" }], [], true).state,
    ).toBe("recovery");
    expect(
      memberActivity("active", [{ status: "stopping", taskId: "closing" }], [], true).state,
    ).toBe("stopping");
    expect(memberActivity("active", [], [], false).state).toBe("unknown");
    expect(
      memberActivity("active", [{ status: "future-status", taskId: "new" }], [], true).state,
    ).toBe("unknown");
  });
});
