import { ProviderInstanceId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveTurnWorkCounts } from "./turnWorkCounts.ts";

const threadId = ThreadId.make("thread");
const runId = RunId.make("run");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "historical-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const run = { id: runId, threadId, modelSelection, status: "completed" as const };
const item = (
  id: string,
  type: Parameters<typeof deriveTurnWorkCounts>[0]["turnItems"][number]["type"],
) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  type,
});

describe("deriveTurnWorkCounts", () => {
  it("combines overlapping retained pages by stable item IDs without merging repeated commands", () => {
    const first = item("command-1", "command_execution");
    const [counts] = deriveTurnWorkCounts({
      runs: [run, run],
      retention: "partial",
      turnItems: [
        first,
        first,
        item("command-2", "command_execution"),
        item("tool", "dynamic_tool"),
        item("child", "subagent"),
        item("reply", "assistant_message"),
      ],
    });
    expect(counts).toEqual({
      runId,
      threadId,
      modelSelection,
      status: "completed",
      retention: "partial",
      commandCount: 2,
      toolCallCount: 1,
      subagentCount: 1,
      messageCount: 1,
    });
    expect(counts).not.toHaveProperty("usage");
  });

  it("keeps unknown run provenance unknown and counts distinct child-thread identities separately", () => {
    const parent = item("same", "command_execution");
    const child = { ...parent, threadId: ThreadId.make("child") };
    const counts = deriveTurnWorkCounts({
      runs: [],
      retention: "complete",
      turnItems: [parent, child, child, { ...item("unbound", "dynamic_tool"), runId: null }],
    });
    expect(counts).toHaveLength(2);
    for (const row of counts) {
      expect(row).toMatchObject({
        modelSelection: null,
        status: null,
        retention: "unknown",
        commandCount: 1,
      });
    }
  });

  it("retains rolled-back provenance and excludes non-executing tool reports", () => {
    const [counts] = deriveTurnWorkCounts({
      runs: [{ ...run, status: "rolled_back" }],
      retention: "unknown",
      turnItems: [{ ...item("notice", "dynamic_tool"), toolNonExecutionKind: "plan" }],
    });
    expect(counts).toMatchObject({
      status: "rolled_back",
      retention: "unknown",
      commandCount: 0,
      toolCallCount: 0,
    });
  });
});
