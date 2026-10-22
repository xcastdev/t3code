import { ProviderInstanceId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { deriveTurnWorkCounts } from "@t3tools/shared/turnWorkCounts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTurnAgentWork,
  subagentEffortText,
  TURN_WORK_RETENTION_LABELS,
} from "./threadAgentsPresentation";

const threadId = ThreadId.make("thread");
const selection = (model: string, effort?: string) => ({
  instanceId: ProviderInstanceId.make("codex"),
  model,
  ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
});
const run = (id: string, effort: string) => ({
  id: RunId.make(id),
  threadId,
  modelSelection: selection("historical-model", effort),
  status: "completed" as const,
});
const item = (
  id: string,
  runId: string,
  type: Parameters<typeof deriveTurnWorkCounts>[0]["turnItems"][number]["type"],
) => ({ id: TurnItemId.make(id), threadId, runId: RunId.make(runId), type });

const projection = {
  runs: [run("run-1", "low"), run("run-2", "high")],
  turnItems: [
    item("old-command", "run-1", "command_execution"),
    item("command", "run-2", "command_execution"),
    item("tool", "run-2", "dynamic_tool"),
    item("child", "run-2", "subagent"),
    item("reply", "run-2", "assistant_message"),
  ],
};

describe("deriveTurnAgentWork", () => {
  it("counts only the sheet's turn and keeps that run's saved effort", () => {
    const work = deriveTurnAgentWork({
      runId: RunId.make("run-2"),
      projection,
      history: { hasMoreHistory: false, error: null },
    });
    expect(work).toMatchObject({
      commandCount: 1,
      toolCallCount: 1,
      subagentCount: 1,
      messageCount: 1,
      retention: "complete",
    });
    expect(subagentEffortText({ modelSelection: work?.modelSelection ?? undefined })).toBe(
      "high effort",
    );
  });

  it("labels a bounded snapshot with earlier history as loaded rows only", () => {
    const work = deriveTurnAgentWork({
      runId: RunId.make("run-2"),
      projection,
      history: { hasMoreHistory: true, error: null },
    });
    expect(work?.retention).toBe("partial");
    expect(TURN_WORK_RETENTION_LABELS[work?.retention ?? "unknown"]).toBe("Loaded rows only");
  });

  it("refuses a completeness claim without usable history metadata", () => {
    for (const history of [null, { hasMoreHistory: false, error: "offline" }]) {
      expect(
        deriveTurnAgentWork({ runId: RunId.make("run-2"), projection, history })?.retention,
      ).toBe("unknown");
    }
    expect(deriveTurnAgentWork({ runId: null, projection, history: null })).toBeNull();
  });
});

describe("subagentEffortText", () => {
  it("keeps differently configured agents distinguishable and admits missing effort", () => {
    expect(subagentEffortText({ modelSelection: selection("model", "low") })).toBe("low effort");
    expect(subagentEffortText({ modelSelection: selection("model", "xhigh") })).toBe(
      "xhigh effort",
    );
    expect(subagentEffortText({ modelSelection: selection("model") })).toBe("effort not recorded");
    expect(subagentEffortText({})).toBe("effort not recorded");
  });
});
