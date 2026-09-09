import type { ToolLifecycleItemType } from "@t3tools/contracts";

/**
 * Work counts summarising what a turn actually did. The server stamps these
 * onto a turn when it settles and the client derives the same numbers for the
 * live turn and for subfolds, so both sides share this module: a turn fold and
 * its subfolds can never disagree about what counts as a command.
 */
export interface TurnWorkCounts {
  readonly commandCount: number;
  readonly toolCallCount: number;
  readonly subagentCount: number;
}

export const EMPTY_TURN_WORK_COUNTS: TurnWorkCounts = {
  commandCount: 0,
  toolCallCount: 0,
  subagentCount: 0,
};

/**
 * One activity row as stored. `toolName` is deliberately absent: it is null for
 * the large majority of stored command rows, so classification keys on
 * `itemType` instead.
 */
export interface TurnWorkActivity {
  readonly tone: string;
  readonly itemType?: ToolLifecycleItemType | string | null | undefined;
  readonly toolCallId?: string | null | undefined;
  /** Set when the row is a subagent's own tool call rather than the agent's. */
  readonly agentId?: string | null | undefined;
  /** Tool request summary; carries the tool name for rows the timeline hides. */
  readonly detail?: string | null | undefined;
}

type WorkCategory = "command" | "tool" | "subagent";

function classifyWorkCategory(
  itemType: ToolLifecycleItemType | string | null | undefined,
): WorkCategory | undefined {
  switch (itemType) {
    case "command_execution":
      return "command";
    // A collaborating agent is reported as a subagent rather than a tool call:
    // it represents delegated work, not a single call the agent made.
    case "collab_agent_tool_call":
      return "subagent";
    case "file_change":
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "web_search":
    case "image_view":
      return "tool";
    default:
      return undefined;
  }
}

/**
 * A row the timeline hides, and so must not be counted.
 *
 * A subagent's own tool calls (`agentId`) are re-homed out of the main timeline
 * and belong to the subagent, not to this turn — the delegation itself is still
 * counted, through the parent's own un-attributed `collab_agent_tool_call` row.
 * Plan-mode boundaries are hidden as well: the plan is rendered as its own row,
 * so counting the tool that produced it would double-report it.
 */
function isHiddenFromTimeline(activity: TurnWorkActivity): boolean {
  if (activity.agentId?.trim()) {
    return true;
  }
  return activity.detail?.startsWith("ExitPlanMode:") === true;
}

/**
 * Counts the distinct work a turn performed.
 *
 * Rows are deduped by `toolCallId` because one call emits several lifecycle
 * rows, and `info`-tone rows are excluded because they narrate rather than
 * report work. Rows without a `toolCallId` cannot be deduped against each
 * other, so each counts once. Rows the timeline hides are skipped, so a fold's
 * total always reconciles with the rows a user can actually expand.
 */
export function countTurnWork(activities: Iterable<TurnWorkActivity>): TurnWorkCounts {
  const seenToolCallIds = new Set<string>();
  let commandCount = 0;
  let toolCallCount = 0;
  let subagentCount = 0;

  for (const activity of activities) {
    if (activity.tone === "info" || isHiddenFromTimeline(activity)) {
      continue;
    }

    const category = classifyWorkCategory(activity.itemType);
    if (category === undefined) {
      continue;
    }

    const toolCallId = activity.toolCallId?.trim();
    if (toolCallId) {
      if (seenToolCallIds.has(toolCallId)) {
        continue;
      }
      seenToolCallIds.add(toolCallId);
    }

    if (category === "command") {
      commandCount += 1;
    } else if (category === "subagent") {
      subagentCount += 1;
    } else {
      toolCallCount += 1;
    }
  }

  return { commandCount, toolCallCount, subagentCount };
}
