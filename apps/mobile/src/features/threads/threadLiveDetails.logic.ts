import { msg } from "gt-react-native";
import {
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isFailedAgentStatus,
  isFinishedAgentStatus,
  type ThreadDetailsStatusBucket,
} from "@t3tools/client-runtime/state/thread-details";
import type {
  EnvironmentId,
  OrchestrationV2PlanStep,
  OrchestrationV2Subagent,
  ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

/** The drawer's collapsible sections, in the web thread details panel's order. */
export type ThreadDetailsSectionId =
  | "context"
  | "usage"
  | "versionControl"
  | "agents"
  | "sideChats"
  | "checklist"
  | "processes"
  | "mcp"
  | "automations";

/** The sections the live bar can open the drawer at. */
export type ThreadLiveDetailsSection =
  | Extract<ThreadDetailsSectionId, "checklist" | "agents" | "sideChats" | "context" | "usage">
  | "turn";

/**
 * Collapse is kept per section id across threads. A section the live bar opened stays open
 * until the user folds it, even when it was folded before.
 */
export function isThreadDetailsSectionCollapsed(input: {
  readonly id: ThreadDetailsSectionId;
  readonly collapsed: ReadonlyArray<string>;
  readonly opened: ThreadLiveDetailsSection | null;
}): boolean {
  return input.id !== input.opened && input.collapsed.includes(input.id);
}

export function toggleThreadDetailsSection(
  collapsed: ReadonlyArray<string>,
  id: ThreadDetailsSectionId,
  wasCollapsed: boolean,
): ReadonlyArray<string> {
  const without = collapsed.filter((entry) => entry !== id);
  return wasCollapsed ? without : [...without, id];
}

export type ThreadLiveTurn =
  | { readonly kind: "working"; readonly startedAt: string | null }
  | { readonly kind: "finished"; readonly durationMs: number }
  | null;

/** The turn running now, else how long the last one took when the shell knows both ends. */
export function deriveThreadLiveTurn(
  shell: Pick<EnvironmentThreadShell, "latestRun" | "runtime"> | null,
): ThreadLiveTurn {
  if (shell === null) return null;
  if (threadRuntimeIsActive(shell.runtime)) {
    return { kind: "working", startedAt: resolveThreadWorkingStartedAt(shell) };
  }
  const run = shell.latestRun;
  const startedAt = Date.parse(run?.startedAt ?? run?.requestedAt ?? "");
  const completedAt = Date.parse(run?.completedAt ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return null;
  }
  return { kind: "finished", durationMs: completedAt - startedAt };
}

export function checklistProgressLabel(
  steps: ReadonlyArray<Pick<OrchestrationV2PlanStep, "status">>,
): string {
  const done = steps.filter((step) => step.status === "completed").length;
  return `${done} of ${steps.length} done`;
}

export type SideChatState = "approval" | "input" | "running" | "failed" | "done" | "idle";

/** How a side chat counts in the section summary, matching web's buckets. */
export const SIDE_CHAT_STATUS_BUCKETS: Record<SideChatState, ThreadDetailsStatusBucket> = {
  approval: "input",
  input: "input",
  running: "running",
  failed: "failed",
  done: "done",
  idle: "done",
};

/** `msg()` labels; display sites resolve them. */
export const SIDE_CHAT_STATE_LABELS: Record<SideChatState, string> = {
  approval: msg("Needs approval"),
  input: msg("Needs input"),
  running: msg("Working", { $context: "side chat status" }),
  failed: msg("Failed", { $context: "side chat status" }),
  done: msg("Done", { $context: "side chat status" }),
  idle: msg("Not started"),
};

/** What a side chat needs or is doing, from its shell; a request outranks its run's status. */
export function sideChatState(
  shell: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "runtime"
    | "latestRun"
  >,
): SideChatState {
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") return "approval";
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") return "input";
  if (threadRuntimeIsActive(shell.runtime)) return "running";
  const status = shell.runtime?.status ?? shell.latestRun?.status;
  if (status === undefined || status === "idle") {
    return shell.latestRun === null ? "idle" : "done";
  }
  return status === "failed" ? "failed" : "done";
}

/** The scheduled tasks that run in this thread. */
export function threadAutomations(
  tasks: ReadonlyArray<ScheduledTask>,
  threadId: ThreadId,
): ReadonlyArray<ScheduledTask> {
  return tasks.filter((task) => task.threadId === threadId);
}

/**
 * Why Compact can't be sent now, mirroring web: it needs an operator, a provider that offers
 * `/compact`, and an idle thread with nothing already compacting or queued to.
 */
export function compactUnavailableReason(input: {
  readonly canOperate: boolean;
  readonly providerSupportsCompact: boolean;
  readonly busy: boolean;
  readonly compactQueued: boolean;
}): string | null {
  if (!input.canOperate) return "This connection cannot change threads.";
  if (!input.providerSupportsCompact) return "Compaction is unavailable for this provider.";
  if (input.compactQueued) return "Compacting…";
  if (input.busy) return "Available when the turn ends.";
  return null;
}

/** The thread provider's account first; the others only when asked for. */
export function usageAccountsToShow(input: {
  readonly accounts: ReadonlyArray<LimitAccount>;
  readonly threadAccount: LimitAccount | null;
  readonly showAll: boolean;
}): { readonly shown: ReadonlyArray<LimitAccount>; readonly hiddenCount: number } {
  const { accounts, threadAccount } = input;
  if (threadAccount === null) return { shown: accounts, hiddenCount: 0 };
  const others = accounts.filter((account) => account.key !== threadAccount.key);
  return {
    shown: input.showAll ? [threadAccount, ...others] : [threadAccount],
    hiddenCount: input.showAll ? 0 : others.length,
  };
}

type AgentForPartition = Pick<OrchestrationV2Subagent, "id" | "childThreadId" | "status" | "runId">;

export const PREVIOUS_AGENTS_PAGE = 6;

/**
 * The thread's agents as web lists them: live ones, then finished ones under "Previous agents".
 * A failure counts until it is seen on this device, by opening it or dismissing the badge.
 */
export function partitionThreadAgents<Agent extends AgentForPartition>(input: {
  readonly subagents: ReadonlyArray<Agent>;
  readonly environmentId: EnvironmentId;
  readonly seenFailures: ReadonlyArray<string>;
  readonly rolledBackRunIds?: ReadonlySet<string>;
}) {
  const active: Agent[] = [];
  const previous: Agent[] = [];
  const unseenFailedKeys: string[] = [];
  for (const subagent of input.subagents) {
    if (subagent.runId !== null && input.rolledBackRunIds?.has(subagent.runId)) continue;
    if (!isFinishedAgentStatus(subagent.status)) {
      active.push(subagent);
      continue;
    }
    previous.push(subagent);
    const key = seenFailureKey(input.environmentId, subagent);
    if (isFailedAgentStatus(subagent.status) && !input.seenFailures.includes(key)) {
      unseenFailedKeys.push(key);
    }
  }
  return {
    active,
    previous,
    unseenFailedKeys,
    counts: {
      running: active.filter((subagent) => subagent.status === "running").length,
      failed: unseenFailedKeys.length,
      done: previous.length - unseenFailedKeys.length,
    },
  };
}

export function seenFailureKey(
  environmentId: EnvironmentId,
  subagent: Pick<OrchestrationV2Subagent, "id" | "childThreadId">,
): string {
  return `${environmentId}:${subagent.childThreadId ?? subagent.id}`;
}
