/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  RuntimeAgentKey,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

const panelMocks = vi.hoisted(() => ({
  pageResult: undefined as unknown,
  executeCommand: vi.fn(),
  refreshPage: vi.fn(),
  pageRequests: [] as Array<unknown>,
  pageResultsByCursor: new Map<string, unknown>(),
  readTranscriptPage: vi.fn(),
  connectionPhase: "connected" as string,
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (query: unknown) => {
      const input =
        typeof query === "object" && query !== null && "input" in query ? query.input : undefined;
      const cursor =
        typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
      return typeof cursor === "string"
        ? (panelMocks.pageResultsByCursor.get(cursor) ?? panelMocks.pageResult)
        : panelMocks.pageResult;
    },
    useAtomRefresh: () => panelMocks.refreshPage,
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: panelMocks.connectionPhase } }),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    agentTranscriptPage: (target: unknown) => {
      panelMocks.pageRequests.push(target);
      return target;
    },
    readAgentTranscriptPage: { label: "read agent transcript page" },
  },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    respondToApproval: { label: "respondToApproval" },
    respondToUserInput: { label: "respondToUserInput" },
    messageAgent: { label: "messageAgent" },
    stopAgent: { label: "stopAgent" },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string } | undefined) =>
    command?.label === "read agent transcript page"
      ? panelMocks.readTranscriptPage
      : panelMocks.executeCommand,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { AgentsPanel } from "./AgentsPanel";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";

const environmentId = EnvironmentId.make("agents-panel-environment");
const threadId = ThreadId.make("agents-panel-thread");
const agentKey = RuntimeAgentKey.make("agents-panel-child");
const approvalId = ApprovalRequestId.make("approval-child-1");
const roots: Root[] = [];

function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: kind.startsWith("approval") ? "approval" : "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    eventSequence: id.endsWith("1") ? 1 : 2,
    createdAt: "2026-09-24T10:00:00.000Z",
  };
}

const activities = [
  activity("task-started-1", "task.started", {
    taskId: "native-child",
    taskType: "subagent",
    agentKind: "agent",
    agentKey,
    title: "Researcher",
    status: "running",
  }),
  activity("approval-requested-1", "approval.requested", {
    requestId: approvalId,
    requestKind: "command",
    requestType: "exec_command_approval",
    detail: "run tests",
    options: [
      { decision: "accept", label: "Allow once" },
      {
        decision: "acceptForSession",
        label: "Allow for workspace",
        warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
      },
      { decision: "decline", label: "Deny" },
    ],
    agentKey,
    agentTitle: "Researcher",
  }),
  activity("agent-transcript-1", "agent.transcript.message", {
    agentKey,
    role: "assistant",
    content: "I am checking the tests.",
    status: "running",
  }),
];

const model = deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  panelMocks.pageResult = {
    _tag: "Success",
    waiting: false,
    value: {
      threadId,
      agent: {
        key: agentKey,
        parentKey: null,
        title: "Researcher",
        role: null,
        provider: ProviderDriverKind.make("opencode"),
        status: "running",
        capabilities: {
          transcript: { state: "supported" },
          message: { state: "unverified", reason: "No live child message handle." },
          answerRequests: { state: "unverified", reason: "No live request handle." },
          stop: { state: "unverified", reason: "No live child stop handle." },
        },
      },
      entries: [
        {
          id: EventId.make("agent-transcript-1"),
          eventSequence: 1,
          createdAt: "2026-09-24T10:00:00.000Z",
          kind: "message",
          role: "assistant",
          summary: "Agent response",
          content: "I am checking the tests.",
        },
      ],
      nextCursor: null,
      hasMore: false,
      snapshotSequence: 2,
      threadSequence: 2,
      completeness: { state: "partial", reason: "Only captured child activity is shown." },
    },
  };
  panelMocks.executeCommand.mockReset();
  panelMocks.executeCommand.mockResolvedValue({ _tag: "Success", value: undefined });
  panelMocks.readTranscriptPage.mockReset();
  const initialPage = panelMocks.pageResult as {
    readonly _tag: "Success";
    readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
  };
  panelMocks.readTranscriptPage.mockResolvedValue({
    _tag: "Success",
    value: initialPage.value,
  });
  panelMocks.refreshPage.mockReset();
  panelMocks.pageRequests = [];
  panelMocks.pageResultsByCursor.clear();
  panelMocks.connectionPhase = "connected";
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AgentsPanel agent detail", () => {
  it("refreshes the current page after the environment reconnects", async () => {
    panelMocks.connectionPhase = "offline";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderPanel = () => (
      <AgentsPanel
        model={model}
        environmentId={environmentId}
        threadId={threadId}
        activities={activities}
      />
    );
    await act(async () => root.render(renderPanel()));
    const openAgent = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Researcher agent transcript"]',
    );
    await act(async () => openAgent?.click());
    expect(panelMocks.refreshPage).not.toHaveBeenCalled();

    panelMocks.connectionPhase = "connected";
    await act(async () => root.render(renderPanel()));
    expect(panelMocks.refreshPage).toHaveBeenCalledOnce();
  });

  it("keeps a newest-boundary query active while loading earlier transcript pages", async () => {
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    panelMocks.pageResult = {
      ...current,
      value: { ...current.value, nextCursor: "older-agent-cursor", hasMore: true },
    };
    let currentActivities: ReadonlyArray<OrchestrationThreadActivity> = activities;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderPanel = () => (
      <AgentsPanel
        model={model}
        environmentId={environmentId}
        threadId={threadId}
        activities={currentActivities}
      />
    );
    await act(async () => root.render(renderPanel()));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Load earlier activity")
        ?.click();
    });

    const queryInputs = panelMocks.pageRequests.filter(
      (query): query is { input: { cursor?: string } } =>
        typeof query === "object" && query !== null && "input" in query,
    );
    expect(queryInputs.some((query) => query.input.cursor === undefined)).toBe(true);
    expect(queryInputs.some((query) => query.input.cursor === "older-agent-cursor")).toBe(true);

    currentActivities = [
      ...activities,
      activity("child-transcript-live-3", "agent.transcript.message", {
        agentKey,
        provider: "opencode",
        role: "assistant",
        content: "A newer child update arrived while I was paging older history.",
      }),
    ];
    await act(async () => root.render(renderPanel()));
    expect(panelMocks.refreshPage).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "A newer child update arrived while I was paging older history.",
    );
  });

  it("opens persisted/live child history and resolves the same child request id", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={activities}
        />,
      );
    });

    const openAgent = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Researcher agent transcript"]',
    );
    expect(openAgent).not.toBeNull();
    await act(async () => openAgent?.click());

    expect(container.textContent).toContain("I am checking the tests.");
    expect(container.textContent).toContain("Only captured child activity is shown.");
    expect(container.textContent).toContain("Subagent request");
    expect(container.textContent).toContain(
      "Applies to matching requests in other OpenCode sessions in this workspace.",
    );
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Allow once")
        ?.click();
    });
    expect(panelMocks.executeCommand).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, requestId: approvalId, decision: "accept" },
    });

    const settledActivities = [
      ...activities,
      activity("approval-resolved-1", "approval.resolved", { requestId: approvalId }),
    ];
    expect(derivePendingRequests(settledActivities).approvals).toEqual([]);
    await act(async () => {
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={settledActivities}
        />,
      );
    });
    expect(container.textContent).not.toContain("Subagent request");
  });

  it("renders child messages like the main chat and keeps tool activity compact", async () => {
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    panelMocks.pageResult = {
      ...current,
      value: {
        ...current.value,
        entries: [
          {
            id: EventId.make("agent-assistant-markdown"),
            eventSequence: 1,
            createdAt: "2026-09-24T10:00:00.000Z",
            kind: "message",
            role: "assistant",
            summary: "Agent response",
            content: "The **child chat** uses Markdown.",
            status: "running",
          },
          {
            id: EventId.make("agent-user-message"),
            eventSequence: 2,
            createdAt: "2026-09-24T10:00:01.000Z",
            kind: "message",
            role: "user",
            summary: "Please inspect `src/main.ts`.",
            content: "Please inspect `src/main.ts`.",
            deliveryStatus: "accepted",
          },
          {
            id: EventId.make("agent-tool-activity"),
            eventSequence: 3,
            createdAt: "2026-09-24T10:00:02.000Z",
            kind: "tool",
            summary: "Read file",
            detail: "src/main.ts",
          },
        ],
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          markdownCwd="/workspace/project"
          threadRef={{ environmentId, threadId }}
          activities={activities}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });

    expect(container.querySelector('[data-agent-transcript-role="assistant"]')).not.toBeNull();
    expect(container.querySelector(".chat-markdown strong")?.textContent).toBe("child chat");
    expect(container.querySelector(".chat-markdown[data-streaming]")).not.toBeNull();
    const userMessage = container.querySelector<HTMLElement>('[data-agent-transcript-role="user"]');
    expect(userMessage?.className).toContain("bg-message");
    expect(userMessage?.className).toContain("max-w-[80%]");
    expect(userMessage?.querySelector(".chat-markdown-file-link")?.getAttribute("href")).toBe(
      "/workspace/project/src/main.ts",
    );
    expect(container.textContent).toContain("Accepted by subagent");
    const toolActivity = container.querySelector<HTMLElement>(
      '[data-agent-transcript-kind="tool"]',
    );
    expect(toolActivity?.className).toContain("min-h-6");
    expect(toolActivity?.className).not.toContain("border-border/50");
    expect(container.textContent).toContain("Read file");
    expect(container.textContent).toContain("Researcher");
    expect(container.textContent).toContain("running");
  });

  it("collapses adjacent running status rows while keeping lifecycle rows visible", async () => {
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    const statusEntries = [
      {
        id: EventId.make("status-running-1"),
        eventSequence: 1,
        createdAt: "2026-09-24T10:00:00.000Z",
        kind: "status" as const,
        summary: "Subagent running",
        status: "running" as const,
      },
      {
        id: EventId.make("status-details-2"),
        eventSequence: 2,
        createdAt: "2026-09-24T10:00:01.000Z",
        kind: "status" as const,
        summary: "Subagent details updated",
        status: "running" as const,
      },
      {
        id: EventId.make("status-running-3"),
        eventSequence: 3,
        createdAt: "2026-09-24T10:00:02.000Z",
        kind: "status" as const,
        summary: "Subagent running",
        status: "running" as const,
      },
      {
        id: EventId.make("status-completed-4"),
        eventSequence: 4,
        createdAt: "2026-09-24T10:00:03.000Z",
        kind: "status" as const,
        summary: "Subagent completed",
        status: "completed" as const,
      },
    ];
    panelMocks.pageResult = {
      ...current,
      value: { ...current.value, entries: statusEntries },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={[]}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });

    const group = container.querySelector<HTMLDetailsElement>('[data-agent-status-group="3"]');
    expect(group?.open).toBe(false);
    expect(group?.querySelector("summary")?.textContent).toContain("3 updates");
    expect(group?.querySelectorAll('[data-agent-transcript-kind="status"]')).toHaveLength(3);
    const standaloneStatusRows = [
      ...container.querySelectorAll<HTMLElement>('[data-agent-transcript-kind="status"]'),
    ].filter((row) => row.closest("[data-agent-status-group]") === null);
    expect(standaloneStatusRows).toHaveLength(1);
    expect(standaloneStatusRows[0]?.textContent).toContain("Subagent completed");
    expect(
      (panelMocks.pageResult as { readonly value: { readonly entries: ReadonlyArray<unknown> } })
        .value.entries,
    ).toBe(statusEntries);

    await act(async () => {
      group?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(group?.open).toBe(true);
  });

  it("continues bounded reconnect catch-up from an explicit gap", async () => {
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    const makeEntry = (sequence: number) => ({
      id: EventId.make(`reconnect-entry-${sequence}`),
      eventSequence: sequence,
      createdAt: "2026-09-24T10:00:00.000Z",
      kind: "status" as const,
      summary: `reconnect row ${sequence}`,
    });
    panelMocks.pageResult = {
      ...current,
      value: { ...current.value, threadSequence: 2 },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderPanel = () => (
      <AgentsPanel
        model={model}
        environmentId={environmentId}
        threadId={threadId}
        activities={[]}
      />
    );
    await act(async () => root.render(renderPanel()));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });
    panelMocks.connectionPhase = "offline";
    await act(async () => root.render(renderPanel()));
    panelMocks.readTranscriptPage.mockImplementation(
      async ({ input }: { input: { cursor?: string } }) => {
        if (!input.cursor) {
          const newest = {
            ...current.value,
            entries: [makeEntry(200)],
            nextCursor: "catch-up-1",
            hasMore: true,
          };
          panelMocks.pageResult = {
            ...current,
            value: { ...current.value, entries: [makeEntry(210)] },
          };
          return {
            _tag: "Success",
            value: newest,
          };
        }
        const pageIndex = Number(input.cursor.slice("catch-up-".length));
        const sequence = pageIndex === 11 ? 2 : 200 + pageIndex;
        return {
          _tag: "Success",
          value: {
            ...current.value,
            entries: [makeEntry(sequence)],
            nextCursor: `catch-up-${pageIndex + 1}`,
            hasMore: true,
          },
        };
      },
    );
    panelMocks.connectionPhase = "connected";
    await act(async () => root.render(renderPanel()));
    await vi.waitFor(() => expect(panelMocks.readTranscriptPage).toHaveBeenCalledTimes(11));
    expect(container.textContent).toContain("Some child activity may be missing.");
    expect(container.textContent).toContain("Continue catch-up");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue catch-up")
        ?.click();
    });
    await vi.waitFor(() => expect(panelMocks.readTranscriptPage).toHaveBeenCalledTimes(12));
    expect(container.textContent).not.toContain("Reconnect catch-up stopped");
    expect(container.textContent).toContain("reconnect row 200");
    expect(container.textContent).toContain("reconnect row 210");
    expect(container.textContent).toContain("reconnect row 2");
  });

  it("opens the first page omitted by bounded reconnect retention", async () => {
    const original = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    const history = Array.from({ length: 1000 }, (_, index) => {
      const sequence = index + 1;
      return {
        id: EventId.make(`skipped-history-${sequence}`),
        eventSequence: sequence,
        createdAt: "2026-09-24T10:00:00.000Z",
        kind: "status" as const,
        summary: `skipped row ${sequence}`,
      };
    });
    const pageForCursor = (cursor: string | undefined) => {
      if (cursor === undefined) {
        return {
          ...original.value,
          entries: history.slice(950),
          nextCursor: "before-951",
          hasMore: true,
          threadSequence: 100,
        };
      }
      const boundary = Number(cursor.slice("before-".length));
      const start = boundary - 50;
      return {
        ...original.value,
        entries: history.slice(start - 1, start + 49),
        nextCursor: start > 1 ? `before-${start}` : null,
        hasMore: start > 1,
      };
    };
    const newestPage = pageForCursor(undefined);
    panelMocks.pageResult = { ...original, value: newestPage };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderPanel = () => (
      <AgentsPanel
        model={model}
        environmentId={environmentId}
        threadId={threadId}
        activities={activities}
      />
    );
    await act(async () => root.render(renderPanel()));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });
    panelMocks.connectionPhase = "offline";
    await act(async () => root.render(renderPanel()));
    panelMocks.readTranscriptPage.mockImplementation(
      async ({ input }: { input: { cursor?: string } }) => ({
        _tag: "Success",
        value: pageForCursor(input.cursor),
      }),
    );

    panelMocks.connectionPhase = "connected";
    await act(async () => root.render(renderPanel()));
    await vi.waitFor(() => expect(panelMocks.readTranscriptPage).toHaveBeenCalledTimes(11));
    expect(container.textContent).toContain("Continue catch-up");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue catch-up")
        ?.click();
    });
    await vi.waitFor(() => expect(panelMocks.readTranscriptPage).toHaveBeenCalledTimes(19));
    expect(container.textContent).not.toContain("Reconnect catch-up stopped");
    expect(container.textContent).toContain("Browse skipped history");

    panelMocks.pageResultsByCursor.set("before-501", {
      _tag: "Success",
      waiting: false,
      value: pageForCursor("before-501"),
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Browse skipped history")
        ?.click();
    });

    expect(panelMocks.pageRequests).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({ cursor: "before-501" }),
      }),
    );
    expect(container.textContent).toContain("skipped row 451");
    expect(container.textContent).toContain("skipped row 500");
    expect(container.textContent).toContain("Load earlier activity");
  });

  it("offers a retry when the reconnect newest-page read fails", async () => {
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderPanel = () => (
      <AgentsPanel
        model={model}
        environmentId={environmentId}
        threadId={threadId}
        activities={activities}
      />
    );
    await act(async () => root.render(renderPanel()));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });
    panelMocks.connectionPhase = "offline";
    await act(async () => root.render(renderPanel()));
    let failFirstRead = true;
    panelMocks.readTranscriptPage.mockImplementation(async () => {
      if (failFirstRead) {
        failFirstRead = false;
        return { _tag: "Failure", error: new Error("temporary read failure") };
      }
      return {
        _tag: "Success",
        value: { ...current.value, entries: [current.value.entries[0]!], nextCursor: null },
      };
    });
    panelMocks.connectionPhase = "connected";
    await act(async () => root.render(renderPanel()));
    await vi.waitFor(() => expect(container.textContent).toContain("Retry catch-up"));
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry catch-up")
        ?.click();
    });
    await vi.waitFor(() => expect(container.textContent).not.toContain("Retry catch-up"));
    expect(container.textContent).not.toContain("Some child activity may be missing.");
  });

  it("exposes message and stop only for currently supported child actions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const current = panelMocks.pageResult as {
      readonly _tag: "Success";
      readonly waiting: false;
      readonly value: import("@t3tools/contracts").OrchestrationAgentTranscriptPage;
    };
    expect(current.value.agent.capabilities.message.state).toBe("unverified");
    await act(async () =>
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={activities}
        />,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open Researcher agent transcript"]')
        ?.click();
    });
    expect(container.querySelector('[aria-label="Message this subagent"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();

    panelMocks.pageResult = {
      ...current,
      value: {
        ...current.value,
        agent: {
          ...current.value.agent,
          capabilities: {
            ...current.value.agent.capabilities,
            message: { state: "supported" },
            stop: { state: "supported" },
          },
        },
      },
    };
    panelMocks.connectionPhase = "offline";
    await act(async () =>
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={activities}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="Message this subagent"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();

    panelMocks.connectionPhase = "connected";
    await act(async () =>
      root.render(
        <AgentsPanel
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          activities={activities}
        />,
      ),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message this subagent"]',
    );
    expect(textarea).not.toBeNull();
    expect(textarea?.closest('[data-chat-composer-main-surface="true"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Send message to this subagent"]'),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
    await act(async () => {
      if (!textarea) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Please verify the failing assertion.",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(panelMocks.executeCommand).not.toHaveBeenCalled();
    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop subagent"]')?.click();
    });
    expect(panelMocks.executeCommand).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: { threadId, agentKey, text: "Please verify the failing assertion." },
    });
    expect(panelMocks.executeCommand).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: { threadId, agentKey },
    });
  });
});
