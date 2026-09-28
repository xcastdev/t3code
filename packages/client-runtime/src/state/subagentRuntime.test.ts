import { describe, expect, it } from "vite-plus/test";
import {
  classifyTaskAgentKind,
  EventId,
  ProviderDriverKind,
  RuntimeAgentKey,
  ThreadId,
  type OrchestrationAgentTranscriptEntry,
  type OrchestrationAgentTranscriptPage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  firstDiscardedAgentTranscriptCursor,
  mergeAgentTranscriptEntries,
  mergeAgentTranscriptPageWindows,
  recoverAgentTranscriptGap,
  agentTranscriptEntriesFromActivities,
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "./subagentRuntime.ts";

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("foldSubagentActivities", () => {
  it("seeds a child from provider lifecycle while its first request is pending", () => {
    const agentKey = RuntimeAgentKey.make("opencode-child-key");
    const parentAgentKey = RuntimeAgentKey.make("opencode-parent-key");
    const agents = fold([
      activity("agent.status", {
        agentKey,
        parentAgentKey,
        provider: "opencode",
        title: "Approval helper",
        status: "running",
        timelineBypass: true,
      }),
      activity("task.started", {
        taskId: "open-code-task-id",
        taskType: "subagent",
        agentKey,
        parentAgentKey,
        title: "Approval helper",
      }),
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "open-code-task-id",
      agentKey,
      parentAgentKey,
      title: "Approval helper",
      kind: "subagent",
      status: "running",
    });
  });

  it("keeps opaque child identity from persisted lifecycle rows", () => {
    const agentKey = RuntimeAgentKey.make("child-key-1");
    const parentAgentKey = RuntimeAgentKey.make("parent-key-1");
    const agents = fold([
      activity("task.started", {
        taskId: "provider-child-1",
        taskType: "subagent",
        title: "Researcher",
        agentKey,
        parentAgentKey,
      }),
      activity("task.updated", {
        taskId: "provider-child-1",
        status: "running",
        agentKey,
        parentAgentKey,
      }),
    ]);

    expect(agents[0]).toMatchObject({ agentKey, parentAgentKey, title: "Researcher" });
  });

  it("shows the batch status limit after its parent turn ends without claiming a result", () => {
    const running = activity("task.progress", {
      taskId: "batch-1",
      taskType: "subagent_batch",
      title: "Antigravity subagent batch",
      status: "running",
      summary: "Launch readers",
    });
    const agents = fold([
      running,
      activity("task.updated", {
        taskId: "batch-1",
        taskType: "subagent_batch",
        status: "idle",
        detail: "Turn ended. Individual agent status is unavailable.",
        timelineBypass: true,
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      title: "Antigravity subagent batch",
      kind: "subagent_batch",
      status: "idle",
      progress: "Turn ended. Individual agent status is unavailable.",
      result: null,
      error: null,
    });
  });

  it("learns batch identity from a later update and retains it on sparse updates", () => {
    const agents = fold([
      activity("task.progress", { taskId: "batch-1", taskType: "subagent", status: "running" }),
      activity("task.updated", { taskId: "batch-1", taskType: "subagent_batch", status: "idle" }),
      activity("task.updated", { taskId: "batch-1", status: "idle" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ kind: "subagent_batch", status: "idle" });
  });

  it("builds an agent from start → progress → completion", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-1",
        title: "Audit auth flow",
        role: "explorer",
      }),
      activity("task.progress", {
        taskId: "task-1",
        lastToolName: "Read",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
      }),
      activity("task.completed", {
        taskId: "task-1",
        status: "completed",
        summary: "Found 2 issues",
        typedUsage: { totalTokens: 5000, toolUses: 9 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Audit auth flow");
    expect(agent.role).toBe("explorer");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Found 2 issues");
    expect(agent.usage?.totalTokens).toBe(5000);
    expect(agent.activationCount).toBe(1);
    expect(agent.completedAt).not.toBeNull();
  });

  it("progress can create an agent when its start row aged out of retention", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "task-orphan",
        title: "Recovered agent",
        role: "verifier",
        typedUsage: { totalTokens: 100 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Recovered agent");
    expect(agents[0]!.status).toBe("running");
  });

  it("completion before start stays terminal; a late start only fills metadata", () => {
    const agents = fold([
      activity("task.completed", {
        taskId: "task-2",
        status: "failed",
        summary: "boom",
        role: "fixer",
      }),
      activity("task.started", { taskId: "task-2", title: "Late metadata", role: "fixer" }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Late metadata");
    expect(agent.role).toBe("fixer");
    // The late start must NOT reopen the terminal activation as a new run.
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("duplicate terminal events are idempotent (timestamps do not slide)", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-3", taskType: "local_agent" }),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("reactivation increments the run count and clears result/error", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-4", taskType: "local_agent" }),
      activity("task.completed", { taskId: "task-4", status: "completed", summary: "run 1 done" }),
      activity("task.updated", { taskId: "task-4", status: "running" }),
    ]);
    const agent = agents[0]!;
    expect(agent.activationCount).toBe(2);
    expect(agent.result).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.status).toBe("running");
  });

  it("idle is nonterminal: an idle agent resumes without losing identity", () => {
    const agents = fold([
      activity("task.started", { taskId: "codex-child-1", title: "Marlow", role: "explorer" }),
      activity("task.updated", { taskId: "codex-child-1", status: "idle" }),
      activity("task.updated", { taskId: "codex-child-1", status: "running" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(2);
    expect(agents[0]!.status).toBe("running");
  });

  it("cumulative usage max-merges: duplicate and late frames never shrink or double-count", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-5", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", { taskId: "task-5", typedUsage: { totalTokens: 500 } }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 900, inputTokens: 700 });
  });

  it("usage snapshots enrich an existing agent without changing its status", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "usage-waiting", taskType: "local_agent" }),
      activity("task.progress", { taskId: "usage-waiting", status: "waiting" }),
      activity("task.progress", {
        taskId: "usage-waiting",
        usageSnapshot: true,
        typedUsage: { totalTokens: 1_200 },
      }),
    ]);

    expect(agent?.status).toBe("waiting");
    expect(agent?.usage?.totalTokens).toBe(1_200);
  });

  it("a retained usage snapshot can still reconstruct a running agent", () => {
    const [agent] = fold([
      activity("task.progress", {
        taskId: "usage-only",
        usageSnapshot: true,
        typedUsage: { totalTokens: 800 },
      }),
    ]);

    expect(agent?.status).toBe("running");
    expect(agent?.usage?.totalTokens).toBe(800);
  });

  it("partial terminal usage preserves known breakdown fields", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-6", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-6",
        typedUsage: { totalTokens: 800, inputTokens: 600, outputTokens: 150 },
      }),
      activity("task.completed", {
        taskId: "task-6",
        status: "completed",
        typedUsage: { totalTokens: 1000 },
      }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 1000, inputTokens: 600, outputTokens: 150 });
  });

  it("skips malformed rows individually without failing the fold", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-7", title: "Good", taskType: "local_agent" }),
      activity("task.progress", { bogus: true }),
      activity("task.progress", { taskId: 42 }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Good");
  });

  it("bounds repeated strings at 180 chars and the activity ring at 6 deduped entries", () => {
    const long = "x".repeat(500);
    const rows = [activity("task.started", { taskId: "task-8", taskType: "local_agent" })];
    for (let i = 0; i < 10; i += 1) {
      rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-${i}` }));
    }
    rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-9` }));
    const agents = fold(rows);
    const agent = agents[0]!;
    expect(agent.recentActivity.length).toBeLessThanOrEqual(6);
    for (const entry of agent.recentActivity) {
      expect(entry.summary.length).toBeLessThanOrEqual(180);
    }
    // Consecutive identical summaries dedupe (truncation makes them equal).
    const summaries = agent.recentActivity.map((entry) => entry.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("plan tasks are not agents", () => {
    const agents = fold([activity("task.started", { taskId: "plan-1", taskType: "plan" })]);
    expect(agents).toHaveLength(0);
  });

  it("workflow members key by stable slot and attach to their coordinator", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit-auth-flow",
        workflowName: "audit-auth-flow",
      }),
      activity("task.progress", {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "audit:entrypoints",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Audit",
        timelineBypass: true,
      }),
    ]);
    const workflow = agents.find((agent) => agent.id === "wf-1");
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.phases).toEqual([
      { index: 0, title: "Audit" },
      { index: 1, title: "Verify" },
    ]);
    expect(member?.kind).toBe("workflow_agent");
    expect(member?.parentAgentId).toBe("wf-1");
  });

  it("a workflow member retry (attempt bump) is a reactivation of the same slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "failed",
        error: "attempt 1 died",
        parentAgentId: "wf-2",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "running",
        parentAgentId: "wf-2",
        attempt: 2,
      }),
    ]);
    expect(agents).toHaveLength(1);
    const member = agents[0]!;
    expect(member.activationCount).toBeGreaterThanOrEqual(2);
    expect(member.error).toBeNull();
    expect(member.status).toBe("running");
  });

  it("drops non-http(s) session urls at the fold boundary", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        runHandles: { sessionUrl: "javascript:alert(1)", runId: "run-1" },
      }),
    ]);
    expect(agents[0]!.runHandles?.sessionUrl).toBeUndefined();
    expect(agents[0]!.runHandles?.runId).toBe("run-1");
  });
});

describe("agent transcript merge", () => {
  const transcriptPage = (
    entries: ReadonlyArray<OrchestrationAgentTranscriptEntry>,
    nextCursor: string | null,
    hasMore: boolean,
  ): OrchestrationAgentTranscriptPage => ({
    threadId: ThreadId.make("thread-transcript"),
    agent: {
      key: RuntimeAgentKey.make("agent-transcript"),
      parentKey: null,
      title: "Researcher",
      role: null,
      provider: ProviderDriverKind.make("opencode"),
      status: "running",
      capabilities: {
        transcript: { state: "supported" },
        message: { state: "supported" },
        answerRequests: { state: "unverified" },
        stop: { state: "supported" },
      },
    },
    entries,
    nextCursor,
    hasMore,
    snapshotSequence: 250,
    threadSequence: 250,
    completeness: { state: "complete" },
  });

  const entries = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const eventSequence = from + index;
      return {
        id: EventId.make(`transcript-${eventSequence}`),
        eventSequence,
        providerOrderKey: `transcript:${String(eventSequence).padStart(12, "0")}`,
        createdAt: `2026-08-01T10:00:${String(eventSequence % 60).padStart(2, "0")}.000Z`,
        kind: "message" as const,
        role: "assistant" as const,
        summary: `entry ${eventSequence}`,
      };
    });

  it("walks backward across more than one page to recover a reconnect watermark", async () => {
    const pages = new Map<string, OrchestrationAgentTranscriptPage>([
      ["cursor-1", transcriptPage(entries(151, 200), "cursor-2", true)],
      ["cursor-2", transcriptPage(entries(101, 150), "cursor-3", true)],
      ["cursor-3", transcriptPage(entries(51, 100), "cursor-4", true)],
    ]);
    const fetched: Array<string> = [];
    const recovered = await recoverAgentTranscriptGap({
      startCursor: "cursor-1",
      watermark: 100,
      fetchPage: async (cursor) => {
        fetched.push(cursor);
        const page = pages.get(cursor);
        if (!page) throw new Error(`Unexpected transcript cursor ${cursor}`);
        return page;
      },
    });

    expect(fetched).toEqual(["cursor-1", "cursor-2", "cursor-3"]);
    expect(recovered).toMatchObject({
      reachedWatermark: true,
      nextCursor: null,
      pagesRead: 3,
    });
    expect(recovered.entries).toHaveLength(150);
    expect(recovered.entries[0]?.eventSequence).toBe(151);
    expect(recovered.entries.at(-1)?.eventSequence).toBe(100);
  });

  it("returns a continuation cursor when bounded reconnect catch-up cannot reach the watermark", async () => {
    const recovered = await recoverAgentTranscriptGap({
      startCursor: "cursor-1",
      watermark: 100,
      maxPages: 1,
      fetchPage: async () => transcriptPage(entries(151, 200), "cursor-2", true),
    });
    expect(recovered).toMatchObject({
      reachedWatermark: false,
      nextCursor: "cursor-2",
      pagesRead: 1,
    });
    expect(recovered.entries).toHaveLength(50);
  });

  it("keeps reconnect incompleteness cursor-driven across more than 500 recovered rows", async () => {
    const readCursorPage = async (cursor: string) => {
      const pageIndex = Number(cursor.slice("cursor-".length));
      const from = 951 - pageIndex * 50;
      return transcriptPage(entries(from, from + 49), `cursor-${pageIndex + 1}`, true);
    };
    const firstBatch = await recoverAgentTranscriptGap({
      startCursor: "cursor-0",
      watermark: 1,
      maxPages: 10,
      fetchPage: readCursorPage,
    });
    expect(firstBatch).toMatchObject({
      reachedWatermark: false,
      nextCursor: "cursor-10",
      pagesRead: 10,
    });

    const firstWindow = mergeAgentTranscriptEntries([], firstBatch.entries);
    expect(firstWindow).toHaveLength(500);
    const secondBatch = await recoverAgentTranscriptGap({
      startCursor: firstBatch.nextCursor,
      watermark: 1,
      maxPages: 10,
      fetchPage: readCursorPage,
    });
    expect(secondBatch).toMatchObject({ reachedWatermark: true, nextCursor: null, pagesRead: 10 });

    const retainedWindow = mergeAgentTranscriptEntries(firstWindow, secondBatch.entries);
    expect(retainedWindow).toHaveLength(500);
    expect(retainedWindow.at(-1)?.eventSequence).toBe(1000);
  });

  it("keeps the first discarded reconnect page reachable from its cursor", () => {
    const current = entries(951, 1000);
    const recovered = entries(51, 950);
    const cursorByEntryId = new Map<string, string>();
    const pageByCursor = new Map<string, ReadonlyArray<OrchestrationAgentTranscriptEntry>>();
    for (let start = 51; start <= 901; start += 50) {
      const cursor = `before-${start + 50}`;
      const page = entries(start, start + 49);
      pageByCursor.set(cursor, page);
      for (const entry of page) {
        cursorByEntryId.set(entry.id, cursor);
      }
    }

    const retained = mergeAgentTranscriptEntries(current, recovered);
    expect(retained).toHaveLength(500);
    expect(retained[0]?.eventSequence).toBe(501);
    expect(retained.at(-1)?.eventSequence).toBe(1000);

    const discardedPageCursor = firstDiscardedAgentTranscriptCursor(
      current,
      recovered,
      cursorByEntryId,
    );
    expect(discardedPageCursor).toBe("before-501");
    if (discardedPageCursor === null) throw new Error("Expected a cursor for discarded history");
    const browsedPage = pageByCursor.get(discardedPageCursor);
    expect(browsedPage?.[0]?.eventSequence).toBe(451);
    expect(browsedPage?.at(-1)?.eventSequence).toBe(500);
  });

  it("deduplicates page and live rows by activity id and keeps the newer event sequence", () => {
    const oldPageEntry = {
      id: EventId.make("activity-transcript-1"),
      eventSequence: 11,
      createdAt: "2026-08-01T10:00:00.000Z",
      kind: "message" as const,
      role: "assistant" as const,
      summary: "Searching",
      content: "Searching",
    };
    const liveEntry = { ...oldPageEntry, eventSequence: 18, content: "Searching the repository" };

    expect(mergeAgentTranscriptEntries([oldPageEntry], [liveEntry, liveEntry])).toEqual([
      liveEntry,
    ]);
  });

  it("merges revisions by native identity and keeps provider chronology during live extension", () => {
    const selected = RuntimeAgentKey.make("child-native-revision");
    const oldRevision: OrchestrationAgentTranscriptEntry = {
      id: EventId.make("revision-old-event"),
      eventSequence: 10,
      nativeEntryId: "provider-message-a:block-0",
      providerOrderKey: "001",
      createdAt: "2026-08-01T10:00:00.000Z",
      kind: "message",
      role: "assistant",
      summary: "partial answer",
      content: "The answer is",
    };
    const nextChronologically: OrchestrationAgentTranscriptEntry = {
      id: EventId.make("later-message-event"),
      eventSequence: 11,
      nativeEntryId: "provider-message-b:block-0",
      providerOrderKey: "002",
      createdAt: "2026-08-01T10:00:01.000Z",
      kind: "message",
      role: "assistant",
      summary: "second answer",
      content: "Second message",
    };
    const revision = {
      ...oldRevision,
      id: EventId.make("revision-new-event"),
      eventSequence: 100,
      summary: "complete answer",
      content: "The answer is complete.",
    };

    const live = agentTranscriptEntriesFromActivities(
      [
        {
          ...activity("agent.transcript.message", {
            agentKey: selected,
            nativeEntryId: revision.nativeEntryId,
            providerOrderKey: revision.providerOrderKey,
            role: "assistant",
            content: revision.content,
          }),
          eventSequence: 101,
        },
      ],
      selected,
    );
    const merged = mergeAgentTranscriptEntries(
      [oldRevision, nextChronologically],
      [revision, ...live],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      nativeEntryId: "provider-message-a:block-0",
      providerOrderKey: "001",
      eventSequence: 101,
      content: "The answer is complete.",
    });
    expect(merged[1]).toMatchObject({
      nativeEntryId: "provider-message-b:block-0",
      providerOrderKey: "002",
      content: "Second message",
    });
  });

  it("sorts OpenCode text parts by native timestamps instead of numeric-looking IDs", () => {
    const observed = [0, 1, 10, 2, 3, 4, 5, 6, 7, 8, 9, 11].map((index) => {
      const providerOrderKey = `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      return {
        id: EventId.make(`opencode-part-event-${index}`),
        eventSequence: index + 1,
        nativeEntryId: `opencode:child:part-text-${index}`,
        providerOrderKey,
        createdAt: providerOrderKey,
        kind: "message" as const,
        role: "assistant" as const,
        summary: `block ${index}`,
        content: `block-${index}`,
      };
    });

    expect(mergeAgentTranscriptEntries([], observed).map((entry) => entry.content)).toEqual(
      Array.from({ length: 12 }, (_, index) => `block-${index}`),
    );
  });

  it("projects only activities owned by the selected key and caps retained history", () => {
    const selected = RuntimeAgentKey.make("child-key-1");
    const other = RuntimeAgentKey.make("child-key-2");
    const activities = [
      activity("agent.transcript.message", {
        agentKey: selected,
        role: "assistant",
        content: "hello",
        status: "running",
      }),
      activity("agent.transcript.message", {
        agentKey: other,
        role: "assistant",
        content: "sibling text",
      }),
    ];
    const live = agentTranscriptEntriesFromActivities(activities, selected);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: "message", role: "assistant", content: "hello" });

    const history = Array.from({ length: 4 }, (_, index) => ({
      id: EventId.make(`entry-${index}`),
      eventSequence: index,
      createdAt: `2026-08-01T10:00:0${index}.000Z`,
      kind: "status" as const,
      summary: `status ${index}`,
    }));
    expect(mergeAgentTranscriptEntries([], history, 2).map((entry) => entry.id)).toEqual([
      "entry-2",
      "entry-3",
    ]);
    expect(mergeAgentTranscriptEntries([], history, 2, "oldest").map((entry) => entry.id)).toEqual([
      "entry-0",
      "entry-1",
    ]);
    expect(
      mergeAgentTranscriptEntries(history.slice(-2), history.slice(0, 2), 3, "oldest").map(
        (entry) => entry.id,
      ),
    ).toEqual(["entry-0", "entry-1", "entry-2"]);
  });

  it("keeps Load earlier pages visible after the 500-entry window fills", () => {
    const history = Array.from({ length: 600 }, (_, index) => ({
      id: EventId.make(`entry-${index}`),
      eventSequence: index,
      createdAt: `2026-08-01T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      kind: "status" as const,
      summary: `status ${index}`,
    }));

    // The initial page fills the client window with the newest 500 rows.
    const initialPage = {
      entries: history.slice(-500),
      nextCursor: "cursor-before-entry-100",
      hasMore: true,
    };
    const firstPage = mergeAgentTranscriptEntries([], initialPage.entries);
    expect(firstPage).toHaveLength(500);
    expect(firstPage[0]?.id).toBe("entry-100");

    // The next API page comes from the cursor before that initial page.
    const earlierRequestCursor = initialPage.nextCursor;
    expect(earlierRequestCursor).toBe("cursor-before-entry-100");
    const earlierPage = {
      entries: history.slice(0, 100),
      nextCursor: null,
      hasMore: false,
    };
    const secondPage = mergeAgentTranscriptEntries(
      firstPage,
      earlierPage.entries,
      undefined,
      "oldest",
    );

    expect(secondPage).toHaveLength(500);
    expect(secondPage[0]?.id).toBe("entry-0");
    expect(secondPage.at(-1)?.id).toBe("entry-499");
    expect(secondPage.some((entry) => entry.id === "entry-0")).toBe(true);
    expect(secondPage.some((entry) => entry.id === "entry-599")).toBe(false);
    // Paging state advances to the returned cursor even while the retained
    // display window stays capped.
    expect(earlierPage.nextCursor).toBeNull();
    expect(earlierPage.hasMore).toBe(false);
  });

  it("keeps the older 500-row page window while merging a fresh newest boundary", () => {
    const loadedOlderWindow = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`older-entry-${index}`),
      eventSequence: index,
      createdAt: `2026-08-01T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      kind: "status" as const,
      summary: `older ${index}`,
    }));
    const newestPage = Array.from({ length: 50 }, (_, index) => ({
      id: EventId.make(`newest-entry-${index}`),
      eventSequence: 1_000 + index,
      createdAt: `2026-08-02T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      kind: "message" as const,
      role: "assistant" as const,
      summary: `newest ${index}`,
      content: `newest content ${index}`,
    }));
    const liveUpdate = {
      ...newestPage[49]!,
      eventSequence: 1_050,
      content: "child replied after the older page was loaded",
    };

    const merged = mergeAgentTranscriptPageWindows(loadedOlderWindow, newestPage, [liveUpdate]);

    expect(merged).toHaveLength(550);
    expect(merged[0]?.id).toBe("older-entry-0");
    expect(merged[499]?.id).toBe("older-entry-499");
    expect(merged.at(-1)).toMatchObject({
      id: "newest-entry-49",
      eventSequence: 1_050,
      content: "child replied after the older page was loaded",
    });
  });

  it("retains a bounded reconnect bridge between a loaded history page and newest rows", () => {
    const loaded = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`bridge-old-${index}`),
      eventSequence: index,
      providerOrderKey: `bridge:${String(index).padStart(6, "0")}`,
      createdAt: "2026-08-01T10:00:00.000Z",
      kind: "status" as const,
      summary: `old ${index}`,
    }));
    const recovered = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`bridge-gap-${index}`),
      eventSequence: 500 + index,
      providerOrderKey: `bridge:${String(500 + index).padStart(6, "0")}`,
      createdAt: "2026-08-01T10:00:01.000Z",
      kind: "status" as const,
      summary: `gap ${index}`,
    }));
    const newest = Array.from({ length: 50 }, (_, index) => ({
      id: EventId.make(`bridge-new-${index}`),
      eventSequence: 1_000 + index,
      providerOrderKey: `bridge:${String(1_000 + index).padStart(6, "0")}`,
      createdAt: "2026-08-01T10:00:02.000Z",
      kind: "status" as const,
      summary: `new ${index}`,
    }));

    const merged = mergeAgentTranscriptPageWindows(loaded, newest, [], recovered);
    expect(merged).toHaveLength(1_050);
    expect(merged[0]?.id).toBe("bridge-old-0");
    expect(merged[499]?.id).toBe("bridge-old-499");
    expect(merged[500]?.id).toBe("bridge-gap-0");
    expect(merged[999]?.id).toBe("bridge-gap-499");
    expect(merged.at(-1)?.id).toBe("bridge-new-49");
  });
});

describe("deriveAgentPanelModel", () => {
  const roster = fold([
    activity("task.started", { taskId: "wf-1", taskType: "local_workflow", title: "audit" }),
    activity("task.progress", {
      taskId: "wf-1",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    }),
    activity("task.progress", {
      taskId: "wf-1:wf:0",
      title: "audit:a",
      status: "completed",
      parentAgentId: "wf-1",
      agentIndex: 0,
      phaseIndex: 0,
    }),
    activity("task.completed", { taskId: "wf-1:wf:0", status: "completed", parentAgentId: "wf-1" }),
    activity("task.progress", {
      taskId: "wf-1:wf:1",
      title: "verify:b",
      status: "running",
      parentAgentId: "wf-1",
      agentIndex: 1,
      phaseIndex: 1,
      typedUsage: { totalTokens: 4000 },
    }),
    activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
    activity("task.updated", { taskId: "direct-1", status: "idle" }),
  ]);

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
  });

  it("counts idle deliberately and waiting as active", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.idleCount).toBe(1);
    // Member 1 is running; the wf-1 coordinator is a container, not a worker.
    expect(model.runningCount).toBe(1);
    // Every agent lands in exactly one bucket, except coordinators that stand
    // in for their members.
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length - 1,
    );
  });

  it("omits a workflow coordinator from the working-agent count", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    // One member still running plus one idle direct spawn. The coordinator
    // reports running for the whole workflow and must not inflate the banner.
    expect(model.liveCount).toBe(1);
  });

  it("omits a finished workflow coordinator from the settled count", () => {
    const finished = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow", title: "sweep" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        title: "sweep:a",
        status: "completed",
        parentAgentId: "wf-2",
        agentIndex: 0,
        phaseIndex: 0,
      }),
      activity("task.completed", {
        taskId: "wf-2:wf:0",
        status: "completed",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "completed" }),
    ]);

    const model = deriveAgentPanelModel({ agents: finished });

    // Only the member settled. The coordinator stands in for it, so counting
    // both would report two finished agents where one ran.
    expect(model.settledCount).toBe(1);
    expect(model.liveCount).toBe(0);
  });

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = fold([
      activity("task.started", { taskId: "direct-a", title: "First" }, "2026-08-01T11:00:00.000Z"),
      activity("task.started", { taskId: "direct-b", title: "Second" }, "2026-08-01T11:00:01.000Z"),
      activity(
        "task.progress",
        { taskId: "direct-a", summary: "Newest activity" },
        "2026-08-01T11:00:02.000Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: directRoster }).directAgents.map((agent) => agent.id),
    ).toEqual(["direct-a", "direct-b"]);
  });

  it("keeps first-seen order after the roster retention ranking runs", () => {
    const starts = Array.from({ length: 101 }, (_, index) =>
      activity(
        "task.started",
        { taskId: `capped-${index}`, title: `Agent ${index}` },
        `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
      ),
    );
    const cappedRoster = fold([
      ...starts,
      activity(
        "task.progress",
        { taskId: "capped-0", summary: "Newest activity" },
        "2026-08-01T12:02:00.000Z",
      ),
    ]);

    const ids = deriveAgentPanelModel({ agents: cappedRoster }).directAgents.map(
      (agent) => agent.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(["capped-0", "capped-2", "capped-3"]);
    expect(ids.at(-1)).toBe("capped-100");
  });

  it("a phase with only pending members never reads as running", () => {
    const pendingRoster = fold([
      activity("task.started", { taskId: "wf-9", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-9",
        phases: [{ index: 0, title: "Fix" }],
      }),
      activity("task.progress", {
        taskId: "wf-9:wf:0",
        title: "fixer",
        status: "pending",
        parentAgentId: "wf-9",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: pendingRoster });
    // "pending" counts as active liveness (queued work), so the phase reads
    // running only if a member is genuinely pending/running — this asserts
    // the settled-count rule: no member settled, phase not done.
    expect(model.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("v2 projection wins outright and sources are never merged", () => {
    const v2Agent = { ...roster[0]!, id: "v2-only", title: "From v2" };
    const model = deriveAgentPanelModel({ agents: roster, v2Projection: [v2Agent] });
    const allIds = [
      ...model.workflows.map((group) => group.workflow.id),
      ...model.directAgents.map((agent) => agent.id),
    ];
    expect(allIds).toContain("v2-only");
    expect(allIds).not.toContain("direct-1");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = fold([
      activity("task.progress", {
        taskId: "gone:wf:0",
        title: "orphan",
        status: "running",
        parentAgentId: "gone",
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: orphans });
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["gone:wf:0"]);
  });
});

describe("formatSubagentTokenCount", () => {
  it("formats plain counters", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("model and effort attribution", () => {
  it("carries model/effort from start rows and refines model from later rows", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-m",
        title: "Verify math",
        model: "sonnet",
        effort: "high",
      }),
      // Later row refines with the authoritative API model id; effort absent
      // must not clear the known value.
      activity("task.progress", { taskId: "task-m", model: "claude-sonnet-5[1m]" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-sonnet-5[1m]");
    expect(agents[0]!.effort).toBe("high");
  });

  it("applies metadata-only updates without changing the current status", () => {
    const waitingRows = [
      activity("task.updated", {
        taskId: "task-metadata",
        title: "Check metadata",
        status: "waiting",
      }),
      activity("task.updated", {
        taskId: "task-metadata",
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ];
    const waitingAgent = fold(waitingRows)[0]!;
    expect(waitingAgent.status).toBe("waiting");
    expect(formatSubagentModelLabel(waitingAgent.model, waitingAgent.effort)).toBe(
      "gpt-5.6-sol · high",
    );

    const idleRows = [
      ...waitingRows,
      activity("task.updated", { taskId: "task-metadata", status: "idle" }),
      activity("task.updated", { taskId: "task-metadata", model: "gpt-5.6-sol" }),
    ];
    expect(fold(idleRows)[0]!.status).toBe("idle");

    const completedAgent = fold([
      ...idleRows,
      activity("task.progress", { taskId: "task-metadata", typedUsage: { totalTokens: 42 } }),
      activity("task.completed", { taskId: "task-metadata", status: "completed" }),
      activity("task.updated", { taskId: "task-metadata", effort: "high" }),
    ])[0]!;
    expect(completedAgent.status).toBe("completed");
    expect(completedAgent.model).toBe("gpt-5.6-sol");
    expect(completedAgent.effort).toBe("high");
  });

  it("formatSubagentModelLabel compacts ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol", "low")).toBe("gpt-5.6-sol · low");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("background task exclusion", () => {
  it("shells and monitors never join the roster (from any lifecycle row)", () => {
    const agents = fold([
      activity("task.started", { taskId: "shell-1", taskType: "shell", title: "Run 12s stall" }),
      activity("task.progress", { taskId: "shell-2", taskType: "shell", title: "Run stall" }),
      activity("task.completed", { taskId: "mon-1", taskType: "monitor", status: "completed" }),
      activity("task.started", { taskId: "agent-1", taskType: "subagent", title: "Real agent" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
  });

  it("rows without a taskType stay in the roster (workflow members, Codex children)", () => {
    const agents = fold([
      activity("task.progress", { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" }),
    ]);
    expect(agents).toHaveLength(1);
  });

  it("the server stamp is the only classifier: no stamp means no roster row", () => {
    const agents = fold([
      // Stamped background: agent-looking fields don't matter.
      activity("task.started", {
        taskId: "bg-1",
        agentKind: "background",
        role: "watcher",
        model: "sonnet",
      }),
      // Stamped agent: plain row still joins the roster.
      activity("task.started", { taskId: "ag-1", agentKind: "agent", detail: "plain row" }),
      // Legacy pre-stamp rows (old threads/servers) stay in the work log —
      // exactly their pre-upgrade behavior.
      legacyActivity("task.started", { taskId: "old-task", detail: "tailing logs" }),
      legacyActivity("task.progress", { taskId: "old-task", summary: "still tailing" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["ag-1"]);
  });

  it("membership is sticky: a stampless later row still reaches a known agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "a1", taskType: "local_agent", title: "Agent" }),
      // Terminal row missing the stamp (defensive: adapters synthesize some
      // rows) — sticky membership still routes it to the agent.
      legacyActivity("task.completed", { taskId: "a1", status: "completed", summary: "done" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
    expect(agents[0]!.result).toBe("done");
  });
});

describe("session-derived interruption", () => {
  it("dead session interrupts live agents but preserves idle and settled", () => {
    const rows = [
      activity("task.started", { taskId: "live-1", taskType: "local_agent" }),
      activity("task.started", { taskId: "idle-1", taskType: "local_agent" }),
      activity("task.updated", { taskId: "idle-1", status: "idle" }),
      activity("task.started", { taskId: "done-1", taskType: "local_agent" }),
      activity("task.completed", { taskId: "done-1", status: "completed" }),
    ];
    const dead = foldSubagentActivities(rows, { sessionLive: false });
    expect(dead.find((agent) => agent.id === "live-1")?.status).toBe("interrupted");
    expect(dead.find((agent) => agent.id === "idle-1")?.status).toBe("idle");
    expect(dead.find((agent) => agent.id === "done-1")?.status).toBe("completed");
    const alive = foldSubagentActivities(rows, { sessionLive: true });
    expect(alive.find((agent) => agent.id === "live-1")?.status).toBe("running");
  });
});

describe("terminal robustness", () => {
  it("task.updated creating an agent (start row aged out) counts one activation", () => {
    const agents = fold([
      activity("task.updated", { taskId: "orphan-u", status: "running", role: "worker" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(1);
    expect(agents[0]!.status).toBe("running");
  });

  it("a late start after a terminal task.updated does not reopen the run", () => {
    const agents = fold([
      activity("task.updated", { taskId: "t1", status: "failed", role: "worker" }),
      activity("task.started", { taskId: "t1", taskType: "local_agent", title: "Late" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(agents[0]!.title).toBe("Late");
  });

  it("a completion after a terminal task.updated still enriches result and usage", () => {
    // Claude commonly emits terminal task.updated before task.completed;
    // the completion carries the summary and final usage the update lacked.
    const agents = fold([
      activity("task.started", { taskId: "te-1", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "te-1", status: "completed", endedAt: "2026-08-01T10:59:00.000Z" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        {
          taskId: "te-1",
          status: "completed",
          summary: "final answer",
          typedUsage: { totalTokens: 4200, toolUses: 7 },
        },
        "2026-08-01T11:00:01.000Z",
      ),
    ]);
    const agent = agents[0]!;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("final answer");
    expect(agent.usage?.totalTokens).toBe(4200);
    // Timestamps stay pinned to the transition that settled the run.
    expect(agent.completedAt).toBe("2026-08-01T10:59:00.000Z");
  });

  it("duplicate completions keep the FIRST result, not the last", () => {
    const agents = fold([
      activity("task.started", { taskId: "t2", taskType: "local_agent" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "first result" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "second result" }),
    ]);
    expect(agents[0]!.result).toBe("first result");
  });

  it("provider endedAt wins over ingestion time on the settling transition", () => {
    const agents = fold([
      activity("task.started", { taskId: "t3", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "t3", status: "failed", endedAt: "2026-08-01T09:59:59.000Z" },
        "2026-08-01T10:00:30.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:59:59.000Z");
  });

  it("workflow retries count each attempt once", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "failed",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 2,
      }),
    ]);
    expect(agents[0]!.activationCount).toBe(2);
  });
});

describe("phase membership", () => {
  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", {
          taskId: "wf-p",
          taskType: "local_workflow",
          phases: [{ index: 0, title: "Only phase" }],
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:0",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 0,
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:9",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 9,
        }),
      ]),
    });
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((member) => member.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });
});

describe("coordinator settle cascade", () => {
  it("members without their own terminal row settle when the coordinator does", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "stalled member",
        status: "running",
        parentAgentId: "wf-1",
      }),
      activity("task.completed", {
        taskId: "wf-1",
        status: "completed",
        taskType: "local_workflow",
      }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(member?.status).toBe("completed");
    expect(member?.completedAt).not.toBeNull();
  });

  it("a failed coordinator marks unfinished members interrupted, not completed", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        status: "running",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "failed", taskType: "local_workflow" }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-2:wf:0");
    expect(member?.status).toBe("interrupted");
  });
});

describe("task type classification is a denylist", () => {
  it("unknown agent-flavored types (local_agent, future names) join the roster", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "a1",
        taskType: "local_agent",
        title: "Math test 1",
        role: "claude",
      }),
      activity("task.started", { taskId: "a2", taskType: "some_future_agent_kind", title: "X" }),
    ]);
    expect(agents.map((agent) => agent.id).toSorted()).toEqual(["a1", "a2"]);
  });
});

describe("nested agents vs subagent shells", () => {
  it("a nested agent (agentId + agent taskType) stays in the roster; its shells do not", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "nested-1",
        taskType: "local_agent",
        agentId: "parent-agent",
        title: "Nested researcher",
      }),
      activity("task.started", {
        taskId: "shell-1",
        taskType: "local_bash",
        agentId: "parent-agent",
        title: "Nested sleep",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["nested-1"]);
  });
});
