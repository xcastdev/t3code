import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";

const FINISHED_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "interrupted",
  "idle",
]);

export const isFinishedAgentStatus = (status: string | null | undefined) =>
  FINISHED_AGENT_STATUSES.has(status ?? "");

export const isFailedAgentStatus = (status: string | null | undefined) =>
  status === "failed" || status === "error";

export type ThreadDetailsStatusBucket = "running" | "input" | "failed" | "done";

/** Where a related thread counts in a summary: a waiting request outranks its run's status. */
export function threadDetailsStatusBucket(input: {
  readonly status: string | null | undefined;
  readonly needsInput: boolean;
}): ThreadDetailsStatusBucket {
  if (input.needsInput) return "input";
  if (isFailedAgentStatus(input.status)) return "failed";
  return isFinishedAgentStatus(input.status) ? "done" : "running";
}

export type ThreadDetailsStatusCounts = Readonly<Record<ThreadDetailsStatusBucket, number>>;

export function countThreadDetailsStatuses(
  buckets: Iterable<ThreadDetailsStatusBucket>,
): ThreadDetailsStatusCounts {
  const counts = { running: 0, input: 0, failed: 0, done: 0 };
  for (const bucket of buckets) counts[bucket] += 1;
  return counts;
}

// Seen failures are kept per device; the oldest marks drop first.
export const MAX_SEEN_FAILED_AGENTS = 500;

export function markFailedAgentsSeen(
  current: ReadonlyArray<string>,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...current, ...keys].slice(-MAX_SEEN_FAILED_AGENTS);
}

// Providers label plans with their brand and "Subscription" ("ChatGPT Pro 200 Subscription").
const PLAN_NOISE_WORDS = new Set(["subscription", "chatgpt", "claude"]);

/** The plan's own name ("Pro 200", "Max 20x"), or null when nothing but brand words remain. */
export function shortPlanLabel(plan: string, providerLabel: string): string | null {
  const noise = new Set([
    ...PLAN_NOISE_WORDS,
    ...providerLabel
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 0),
  ]);
  const words = plan
    .split(/\s+/)
    .filter((word) => word.length > 0 && !noise.has(word.toLowerCase()));
  return words.length > 0 ? words.join(" ") : null;
}

/** Room for two gauges: the two windows closest to running out, in the provider's own order. */
export function usageSummaryWindows<Window extends ServerProviderUsageWindow>(
  windows: ReadonlyArray<Window>,
): ReadonlyArray<Window> {
  const tightestTwo = [...windows]
    .sort((a, b) => remainingPercent(a) - remainingPercent(b))
    .slice(0, 2);
  return windows.filter((window) => tightestTwo.includes(window));
}
