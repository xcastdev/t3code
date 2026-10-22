import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latestRunWork } from "./runWorkSummary";

const run = (id: string, effort?: string) =>
  ({
    id,
    threadId: "thread-1",
    status: "completed",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5",
      ...(effort ? { options: [{ id: "reasoningEffort", value: effort }] } : {}),
    },
  }) as unknown as OrchestrationV2Run;

const item = (id: string, runId: string, type: string) =>
  ({ id, threadId: "thread-1", runId, type }) as unknown as OrchestrationV2TurnItem;

describe("latestRunWork", () => {
  it("counts only the latest run's retained rows and says when older rows are missing", () => {
    const summary = latestRunWork({
      runs: [run("run-1"), run("run-2")],
      turnItems: [
        item("a", "run-1", "user_message"),
        item("b", "run-2", "user_message"),
        item("c", "run-2", "assistant_message"),
        item("c", "run-2", "assistant_message"),
        item("d", "run-2", "command_execution"),
        item("e", "run-2", "subagent"),
      ],
      hasMoreHistory: true,
    });
    expect(summary?.counts).toMatchObject({
      runId: "run-2",
      messageCount: 2,
      commandCount: 1,
      toolCallCount: 0,
      subagentCount: 1,
      retention: "partial",
    });
    expect(summary?.label).toBe("2 messages · 1 command · 0 tool calls · 1 subagent");
  });

  it("is complete only when no older history remains, and has nothing without a run", () => {
    expect(
      latestRunWork({ runs: [run("run-1")], turnItems: [], hasMoreHistory: false })?.counts
        .retention,
    ).toBe("complete");
    expect(latestRunWork({ runs: [], turnItems: [], hasMoreHistory: false })).toBeNull();
  });
});
