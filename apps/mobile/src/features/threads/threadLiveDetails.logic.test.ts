import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  checklistProgressLabel,
  compactUnavailableReason,
  deriveThreadLiveTurn,
  isThreadDetailsSectionCollapsed,
  partitionThreadAgents,
  sideChatState,
  threadAutomations,
  toggleThreadDetailsSection,
  usageAccountsToShow,
} from "./threadLiveDetails.logic";

const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claude");

type ShellState = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime" | "latestRun"
>;

function run(
  status: NonNullable<EnvironmentThreadShell["latestRun"]>["status"],
  times: { startedAt?: string; completedAt?: string | null } = {},
): NonNullable<EnvironmentThreadShell["latestRun"]> {
  return {
    runId,
    status,
    requestedAt: null,
    startedAt: times.startedAt ?? "2026-11-17T10:00:00.000Z",
    completedAt: times.completedAt === undefined ? null : times.completedAt,
    assistantMessageId: null,
  };
}

function runtime(
  status: NonNullable<EnvironmentThreadShell["runtime"]>["status"],
): NonNullable<EnvironmentThreadShell["runtime"]> {
  return {
    status,
    activeRunId: status === "idle" ? null : runId,
    activityStartedAt: status === "running" ? "2026-11-17T10:00:05.000Z" : undefined,
    providerInstanceId: instanceId,
    providerName: null,
    lastError: null,
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

const quiet: ShellState = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: null,
  latestRun: null,
};

describe("deriveThreadLiveTurn", () => {
  it("counts a running turn from its activity start", () => {
    expect(
      deriveThreadLiveTurn({ runtime: runtime("running"), latestRun: run("running") }),
    ).toEqual({ kind: "working", startedAt: "2026-11-17T10:00:05.000Z" });
  });

  it("reports how long a finished turn worked, and nothing when it never ran", () => {
    expect(
      deriveThreadLiveTurn({
        runtime: runtime("idle"),
        latestRun: run("completed", { completedAt: "2026-11-17T10:01:23.000Z" }),
      }),
    ).toEqual({ kind: "finished", durationMs: 83_000 });
    expect(deriveThreadLiveTurn({ runtime: null, latestRun: null })).toBeNull();
  });
});

describe("checklistProgressLabel", () => {
  it("counts only completed steps as done", () => {
    expect(
      checklistProgressLabel([
        { status: "completed" },
        { status: "running" },
        { status: "pending" },
      ]),
    ).toBe("1 of 3 done");
  });
});

describe("sideChatState", () => {
  it("puts a waiting request ahead of the run's status", () => {
    expect(
      sideChatState({ ...quiet, hasPendingApprovals: true, runtime: runtime("running") }),
    ).toBe("approval");
    expect(sideChatState({ ...quiet, pendingSubagentRequest: "approval" })).toBe("approval");
    expect(sideChatState({ ...quiet, hasPendingUserInput: true })).toBe("input");
    expect(sideChatState({ ...quiet, pendingSubagentRequest: "user_input" })).toBe("input");
  });

  it("follows the run: working, failed, done, or not started", () => {
    expect(sideChatState({ ...quiet, runtime: runtime("running") })).toBe("running");
    expect(sideChatState({ ...quiet, runtime: runtime("failed"), latestRun: run("failed") })).toBe(
      "failed",
    );
    expect(sideChatState({ ...quiet, latestRun: run("failed") })).toBe("failed");
    expect(sideChatState({ ...quiet, runtime: runtime("idle"), latestRun: run("completed") })).toBe(
      "done",
    );
    expect(sideChatState(quiet)).toBe("idle");
  });
});

describe("threadAutomations", () => {
  it("keeps only tasks bound to this thread", () => {
    const threadId = ThreadId.make("thread-1");
    const task = (id: string, bound: ThreadId | null) =>
      ({
        id: ScheduledTaskId.make(id),
        threadId: bound,
        projectId: ProjectId.make("project-1"),
      }) as unknown as ScheduledTask;
    expect(
      threadAutomations(
        [task("a", threadId), task("b", ThreadId.make("thread-2")), task("c", null)],
        threadId,
      ).map((entry) => entry.id),
    ).toEqual(["a"]);
  });
});

describe("compactUnavailableReason", () => {
  const ready = {
    canOperate: true,
    providerSupportsCompact: true,
    busy: false,
    compactQueued: false,
  };

  it("allows Compact only on an idle thread whose provider offers it", () => {
    expect(compactUnavailableReason(ready)).toBeNull();
    expect(compactUnavailableReason({ ...ready, busy: true })).not.toBeNull();
    expect(compactUnavailableReason({ ...ready, compactQueued: true })).not.toBeNull();
    expect(compactUnavailableReason({ ...ready, providerSupportsCompact: false })).not.toBeNull();
    expect(compactUnavailableReason({ ...ready, canOperate: false })).not.toBeNull();
  });
});

describe("usageAccountsToShow", () => {
  const account = (key: string) =>
    ({
      key,
      driver: "claudeAgent",
      environments: [{ environmentId: EnvironmentId.make("environment-1"), label: "" }],
    }) as unknown as LimitAccount;
  const thread = account("thread");
  const accounts = [account("other-1"), thread, account("other-2")];

  it("shows the thread's account and counts the rest behind the toggle", () => {
    expect(usageAccountsToShow({ accounts, threadAccount: thread, showAll: false })).toEqual({
      shown: [thread],
      hiddenCount: 2,
    });
    const expanded = usageAccountsToShow({ accounts, threadAccount: thread, showAll: true });
    expect(expanded.shown.map((entry) => entry.key)).toEqual(["thread", "other-1", "other-2"]);
    expect(expanded.hiddenCount).toBe(0);
  });

  it("shows every account when the thread's provider reports none", () => {
    expect(usageAccountsToShow({ accounts, threadAccount: null, showAll: false })).toEqual({
      shown: accounts,
      hiddenCount: 0,
    });
  });
});

describe("thread details collapse", () => {
  it("opens the section the live bar asked for, and folds it again on toggle", () => {
    const collapsed = ["agents", "mcp"];
    expect(isThreadDetailsSectionCollapsed({ id: "agents", collapsed, opened: "agents" })).toBe(
      false,
    );
    expect(isThreadDetailsSectionCollapsed({ id: "mcp", collapsed, opened: "agents" })).toBe(true);
    expect(toggleThreadDetailsSection(collapsed, "mcp", true)).toEqual(["agents"]);
    expect(toggleThreadDetailsSection(["mcp"], "agents", false)).toEqual(["mcp", "agents"]);
  });
});

describe("partitionThreadAgents", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const agent = (
    id: string,
    status: "running" | "waiting" | "completed" | "failed",
    childThreadId: string | null = `child-${id}`,
  ) => ({
    id: NodeId.make(id),
    status,
    runId,
    childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
  });

  it("splits live agents from previous ones and counts unseen failures", () => {
    const result = partitionThreadAgents({
      subagents: [
        agent("a", "running"),
        agent("b", "waiting"),
        agent("c", "completed"),
        agent("d", "failed"),
        agent("e", "failed", null),
      ],
      environmentId,
      seenFailures: ["environment-1:child-d"],
    });
    expect(result.active.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.previous.map((entry) => entry.id)).toEqual(["c", "d", "e"]);
    expect(result.unseenFailedKeys).toEqual(["environment-1:e"]);
    expect(result.counts).toEqual({ running: 1, failed: 1, done: 2 });
  });

  it("leaves out agents of a rolled-back turn", () => {
    const result = partitionThreadAgents({
      subagents: [agent("a", "running")],
      environmentId,
      seenFailures: [],
      rolledBackRunIds: new Set([runId]),
    });
    expect(result.active).toEqual([]);
  });
});
