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
  /**
   * Activity kind, e.g. `tool.updated` or `tool.completed`. Only used to fold
   * id-less rows the way the work log does: a completed row ends a run, so an
   * identical row after it is new work rather than another update of the old.
   */
  readonly kind?: string | null | undefined;
  /** Row title. Part of the id-less fold key, as it is in the work log. */
  readonly summary?: string | null | undefined;
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
 * Fold key for a row with no tool call id, mirroring the work log's key so the
 * two sides agree on what counts as one call. Returns null when the row
 * carries nothing to fold on, which keeps such rows distinct.
 */
function foldKeyFor(activity: TurnWorkActivity): string | null {
  const detail = activity.detail?.trim() ?? "";
  const summary = activity.summary?.trim() ?? "";
  if (detail.length === 0 && summary.length === 0) {
    return null;
  }
  return `${activity.itemType ?? ""}\u001f${summary}\u001f${detail}`;
}

/**
 * Counts the distinct work a turn performed.
 *
 * Rows are deduped by `toolCallId` because one call emits several lifecycle
 * rows, and `info`-tone rows are excluded because they narrate rather than
 * report work. A row with no `toolCallId` folds only into the row directly
 * before it, and only while that run is still open — the same adjacency the
 * work log uses, so repeating a command counts twice rather than collapsing
 * into the earlier identical one. Rows the timeline hides are skipped, so a
 * fold's total always reconciles with the rows a user can actually expand.
 */
export function countTurnWork(activities: Iterable<TurnWorkActivity>): TurnWorkCounts {
  const seenToolCallIds = new Set<string>();
  // The open id-less run: its fold key, or null once a run has ended.
  let openContentKey: string | null = null;
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
      openContentKey = null;
    } else {
      // A provider that omits the call id leaves lifecycle rows with nothing
      // to dedupe on, so the work log folds each run of them into the row
      // before it and starts a new row once that run completes. Mirror that:
      // fold only into the open run, and close the run on a terminal row, so
      // the same command run twice still counts twice.
      const contentKey = foldKeyFor(activity);
      const foldsIntoOpenRun = contentKey !== null && contentKey === openContentKey;
      openContentKey = activity.kind === "tool.completed" ? null : contentKey;
      if (foldsIntoOpenRun) {
        continue;
      }
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
