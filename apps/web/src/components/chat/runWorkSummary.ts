import {
  RETENTION_LABELS,
  savedEffortLabel,
} from "@t3tools/client-runtime/state/thread-history-presentation";
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { deriveTurnWorkCounts, type TurnWorkCounts } from "@t3tools/shared/turnWorkCounts";

export interface RunWorkSummary {
  readonly counts: TurnWorkCounts;
  readonly effort: string | null;
  readonly label: string;
  readonly retentionLabel: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The latest run's work, counted from the rows this client already holds.
 * Older rows that are not loaded make the count partial, and it says so.
 */
export function latestRunWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly hasMoreHistory: boolean;
}): RunWorkSummary | null {
  const latest = input.runs.at(-1);
  if (latest === undefined) return null;
  const counts = deriveTurnWorkCounts({
    runs: [latest],
    turnItems: input.turnItems.filter((item) => item.runId === latest.id),
    retention: input.hasMoreHistory ? "partial" : "complete",
  }).find((row) => row.runId === latest.id && row.threadId === latest.threadId);
  if (counts === undefined) return null;
  return {
    counts,
    effort: savedEffortLabel(counts.modelSelection),
    label: [
      plural(counts.messageCount, "message", "messages"),
      plural(counts.commandCount, "command", "commands"),
      plural(counts.toolCallCount, "tool call", "tool calls"),
      plural(counts.subagentCount, "subagent", "subagents"),
    ].join(" · "),
    retentionLabel: RETENTION_LABELS[counts.retention],
  };
}
