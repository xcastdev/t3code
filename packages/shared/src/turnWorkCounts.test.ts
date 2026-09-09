import { describe, expect, it } from "vite-plus/test";

import { countTurnWork, EMPTY_TURN_WORK_COUNTS } from "./turnWorkCounts.ts";

describe("countTurnWork", () => {
  it("counts nothing for an empty activity list", () => {
    expect(countTurnWork([])).toEqual(EMPTY_TURN_WORK_COUNTS);
  });

  it("separates commands from other tool calls", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-2" },
        { tone: "tool", itemType: "dynamic_tool_call", toolCallId: "call-3" },
        { tone: "tool", itemType: "file_change", toolCallId: "call-4" },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 2, subagentCount: 0 });
  });

  it("counts collaborating agents as subagents rather than tool calls", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: "collab_agent_tool_call", toolCallId: "call-1" },
        { tone: "tool", itemType: "dynamic_tool_call", toolCallId: "call-2" },
      ]),
    ).toEqual({ commandCount: 0, toolCallCount: 1, subagentCount: 1 });
  });

  it("dedupes the many rows one tool call produces", () => {
    // A single call emits several lifecycle rows (started/updated/completed);
    // the live database showed 3 calls producing 12 activity rows.
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "file_change", toolCallId: "call-2" },
        { tone: "tool", itemType: "file_change", toolCallId: "call-2" },
      ]),
    ).toEqual({ commandCount: 1, toolCallCount: 1, subagentCount: 0 });
  });

  it("excludes info-tone rows even when they carry a tool item type", () => {
    expect(
      countTurnWork([
        { tone: "info", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-2" },
      ]),
    ).toEqual({ commandCount: 1, toolCallCount: 0, subagentCount: 0 });
  });

  it("counts error and approval rows for real tool work", () => {
    // A failed command still ran; dropping it would under-report the turn.
    expect(
      countTurnWork([
        { tone: "error", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "approval", itemType: "file_change", toolCallId: "call-2" },
      ]),
    ).toEqual({ commandCount: 1, toolCallCount: 1, subagentCount: 0 });
  });

  it("ignores rows with no tool item type", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: undefined, toolCallId: "call-1" },
        { tone: "tool", itemType: null, toolCallId: "call-2" },
      ]),
    ).toEqual(EMPTY_TURN_WORK_COUNTS);
  });

  it("counts rows without a tool call id individually", () => {
    // Missing ids cannot be deduped against each other, so each row is its own
    // unit of work rather than collapsing into one.
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: undefined },
        { tone: "tool", itemType: "command_execution", toolCallId: undefined },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 0, subagentCount: 0 });
  });

  it("dedupes a tool call id across differing item types by first classification", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "dynamic_tool_call", toolCallId: "call-1" },
      ]),
    ).toEqual({ commandCount: 1, toolCallCount: 0, subagentCount: 0 });
  });

  it("counts every remaining tool item type as a tool call", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: "mcp_tool_call", toolCallId: "call-1" },
        { tone: "tool", itemType: "web_search", toolCallId: "call-2" },
        { tone: "tool", itemType: "image_view", toolCallId: "call-3" },
      ]),
    ).toEqual({ commandCount: 0, toolCallCount: 3, subagentCount: 0 });
  });

  it("skips a subagent's own tool calls while still counting the delegation", () => {
    // The timeline re-homes agent-attributed rows out of the turn, so counting
    // them would make a settled fold outrun the subfolds a user can expand.
    // The delegation itself still counts, via the parent's own collab row.
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1" },
        { tone: "tool", itemType: "collab_agent_tool_call", toolCallId: "call-2" },
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: "call-3",
          agentId: "agent-1",
        },
        { tone: "tool", itemType: "file_change", toolCallId: "call-4", agentId: "agent-1" },
      ]),
    ).toEqual({ commandCount: 1, toolCallCount: 0, subagentCount: 1 });
  });

  it("counts a row whose agent id is blank", () => {
    // Only a real attribution re-homes a row; an empty stamp is not one.
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: "call-1", agentId: "   " },
        { tone: "tool", itemType: "command_execution", toolCallId: "call-2", agentId: null },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 0, subagentCount: 0 });
  });

  it("skips the plan-mode boundary tool the timeline renders as its own row", () => {
    expect(
      countTurnWork([
        {
          tone: "tool",
          itemType: "dynamic_tool_call",
          toolCallId: "call-1",
          detail: "ExitPlanMode: {}",
        },
        { tone: "tool", itemType: "dynamic_tool_call", toolCallId: "call-2", detail: "Read: a.ts" },
      ]),
    ).toEqual({ commandCount: 0, toolCallCount: 1, subagentCount: 0 });
  });

  it("folds id-less lifecycle rows the client shows as one row", () => {
    // A provider that omits the call id emits several rows for one call. The
    // work log folds them by content, so counting each would report more work
    // than the turn's own subfolds can account for.
    expect(
      countTurnWork([
        {
          tone: "tool",
          itemType: "file_change",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Read",
          detail: "Read File: a.ts",
        },
        {
          tone: "tool",
          itemType: "file_change",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Read",
          detail: "Read File: a.ts",
        },
        {
          tone: "tool",
          itemType: "file_change",
          toolCallId: null,
          kind: "tool.completed",
          summary: "Read",
          detail: "Read File: a.ts",
        },
      ]),
    ).toEqual({ commandCount: 0, toolCallCount: 1, subagentCount: 0 });
  });

  it("counts the same id-less command run twice as two", () => {
    // The work log starts a new row once a call completes, so an identical
    // call after it is new work rather than another update of the finished one.
    expect(
      countTurnWork([
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Bash",
          detail: "Bash: pnpm test",
        },
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.completed",
          summary: "Bash",
          detail: "Bash: pnpm test",
        },
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Bash",
          detail: "Bash: pnpm test",
        },
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.completed",
          summary: "Bash",
          detail: "Bash: pnpm test",
        },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 0, subagentCount: 0 });
  });

  it("does not fold id-less rows separated by other work", () => {
    expect(
      countTurnWork([
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Bash",
          detail: "Bash: ls",
        },
        {
          tone: "tool",
          itemType: "file_change",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Edit",
          detail: "Edit: a.ts",
        },
        {
          tone: "tool",
          itemType: "command_execution",
          toolCallId: null,
          kind: "tool.updated",
          summary: "Bash",
          detail: "Bash: ls",
        },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 1, subagentCount: 0 });
  });

  it("keeps id-less rows apart when they describe different work", () => {
    expect(
      countTurnWork([
        { tone: "tool", itemType: "command_execution", toolCallId: null, detail: "ls" },
        { tone: "tool", itemType: "command_execution", toolCallId: null, detail: "pwd" },
      ]),
    ).toEqual({ commandCount: 2, toolCallCount: 0, subagentCount: 0 });
  });
});
