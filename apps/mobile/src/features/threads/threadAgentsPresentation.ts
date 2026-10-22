import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { savedEffortLabel } from "@t3tools/client-runtime/state/thread-history-presentation";
import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { deriveTurnWorkCounts, type TurnWorkCounts } from "@t3tools/shared/turnWorkCounts";

const PROMPT_TITLE_LIMIT = 80;

type WorkCountsInput = Parameters<typeof deriveTurnWorkCounts>[0];

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}

/** The effort persisted with the agent; workflow members and older rows have none to show. */
export function subagentEffortText(subagent: Pick<OrchestrationV2Subagent, "modelSelection">) {
  const effort = savedEffortLabel(subagent.modelSelection);
  return effort === null ? "effort not recorded" : `${effort} effort`;
}

export const TURN_WORK_RETENTION_LABELS: Record<TurnWorkCounts["retention"], string> = {
  complete: "All loaded",
  partial: "Loaded rows only",
  unknown: "Coverage unknown",
};

/**
 * Counts for the turn behind the Agents sheet, from the thread detail that is already
 * loaded. A bounded snapshot with earlier history left is a prefix, and missing history
 * metadata cannot support a completeness claim.
 */
export function deriveTurnAgentWork(input: {
  readonly runId: OrchestrationV2ThreadProjection["runs"][number]["id"] | null;
  readonly projection: {
    readonly runs: WorkCountsInput["runs"];
    readonly turnItems: WorkCountsInput["turnItems"];
  } | null;
  readonly history: { readonly hasMoreHistory: boolean; readonly error: string | null } | null;
}): TurnWorkCounts | null {
  const { runId, projection, history } = input;
  if (runId === null || projection === null) return null;
  const [counts] = deriveTurnWorkCounts({
    runs: projection.runs.filter((run) => run.id === runId),
    turnItems: projection.turnItems.filter((item) => item.runId === runId),
    retention:
      history === null || history.error !== null
        ? "unknown"
        : history.hasMoreHistory
          ? "partial"
          : "complete",
  });
  return counts ?? null;
}
