import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2PlanStep } from "@t3tools/contracts";

/** A card narrower than this keeps the scroll button beside it rather than above. */
const LIVE_BAR_BESIDE_MAX_WIDTH = 220;
const LIVE_BAR_STRIP_MIN_WIDTH = 196;

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatLiveClock(elapsedMs: number): string {
  const total = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

/** How long the last finished turn took, or null when either end is unknown. */
export function lastTurnDurationMs(
  run: { readonly startedAt: string | null; readonly completedAt: string | null } | null,
): number | null {
  if (run === null || run.startedAt === null || run.completedAt === null) return null;
  const elapsed = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function formatLastTurnDuration(elapsedMs: number): string {
  return formatWorkingDurationLabel(elapsedMs);
}

export interface SideChatSummary {
  readonly count: number;
  readonly needsAttention: boolean;
}

export function summarizeSideChats(
  sideChats: ReadonlyArray<{
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly pendingSubagentRequest?: unknown;
  }>,
): SideChatSummary | null {
  if (sideChats.length === 0) return null;
  return {
    count: sideChats.length,
    needsAttention: sideChats.some(
      (chat) =>
        chat.hasPendingApprovals ||
        chat.hasPendingUserInput ||
        (chat.pendingSubagentRequest !== undefined && chat.pendingSubagentRequest !== null),
    ),
  };
}

export function anySubagentFailed(subagents: ReadonlyArray<{ readonly status: string }>): boolean {
  return subagents.some((subagent) => subagent.status === "failed");
}

/** Whole percent of the context window in use, or null while the window is unknown. */
export function contextUsagePercent(
  snapshot: { readonly usedPercentage: number | null } | null,
): number | null {
  const used = snapshot?.usedPercentage;
  if (used === null || used === undefined || !Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, Math.round(used)));
}

/** The card's resting width; deciding placement from it keeps the scroll button still mid-animation. */
export function liveBarCardTargetWidth(input: {
  readonly rowWidth: number;
  readonly hasStrip: boolean;
  readonly fullWidth: boolean;
  readonly availableWidth: number;
}): number {
  if (input.fullWidth) return input.availableWidth;
  const natural = Math.max(input.rowWidth, input.hasStrip ? LIVE_BAR_STRIP_MIN_WIDTH : 0);
  return Math.min(natural, input.availableWidth);
}

export type ScrollButtonPlacement = "hidden" | "alone" | "beside" | "above";

export function resolveScrollButtonPlacement(input: {
  readonly visible: boolean;
  readonly hasLiveBar: boolean;
  readonly expanded: boolean;
  readonly cardTargetWidth: number;
}): ScrollButtonPlacement {
  if (!input.visible || input.expanded) return "hidden";
  if (!input.hasLiveBar) return "alone";
  return input.cardTargetWidth < LIVE_BAR_BESIDE_MAX_WIDTH ? "beside" : "above";
}

export interface ChecklistStepPresentation {
  readonly id: string;
  readonly text: string;
  readonly status: OrchestrationV2PlanStep["status"];
  readonly durationLabel: string | null;
}

export interface ChecklistPresentation {
  readonly steps: ReadonlyArray<ChecklistStepPresentation>;
  readonly total: number;
  readonly done: number;
  /** 1-based position of the step the strip names. */
  readonly position: number;
  readonly currentText: string;
  readonly allDone: boolean;
}

/** The strip names the running step, else the next pending one; null for an empty list. */
export function presentChecklist(
  steps: ReadonlyArray<
    Pick<OrchestrationV2PlanStep, "id" | "text" | "status" | "durationMs">
  > | null,
): ChecklistPresentation | null {
  if (steps === null || steps.length === 0) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const runningIndex = steps.findIndex((step) => step.status === "running");
  const currentIndex =
    runningIndex !== -1 ? runningIndex : steps.findIndex((step) => step.status === "pending");
  const allDone = currentIndex === -1;
  return {
    steps: steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status,
      durationLabel:
        step.durationMs === undefined ? null : formatWorkingDurationLabel(step.durationMs),
    })),
    total: steps.length,
    done,
    position: allDone ? steps.length : currentIndex + 1,
    currentText: allDone ? "All steps done" : steps[currentIndex]!.text,
    allDone,
  };
}
