/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sheetMocks = vi.hoisted(() => ({
  page: undefined as unknown,
  olderPage: undefined as unknown,
  pageQueries: [] as Array<unknown>,
  refreshPage: vi.fn(),
  readTranscriptPage: vi.fn(),
  respondToUserInput: vi.fn(),
  messageAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => (props: Record<string, unknown>) =>
    React.createElement(tag, props, props.children as React.ReactNode);
  return {
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? React.createElement("div", { "data-modal": true }, children) : null,
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      disabled,
      onPress,
      children,
      ...props
    }: Record<string, unknown>) =>
      React.createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          disabled,
          onClick: onPress,
        },
        children as React.ReactNode,
      ),
    ScrollView: element("div"),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      editable,
      multiline: _multiline,
      ...props
    }: Record<string, unknown>) =>
      React.createElement("input", {
        ...props,
        "aria-label": accessibilityLabel,
        value,
        readOnly: editable === false,
        onChange: (event: Event) =>
          (onChangeText as ((text: string) => void) | undefined)?.(
            (event.currentTarget as HTMLInputElement).value,
          ),
      }),
    View: element("div"),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    sheetMocks.pageQueries.push(query);
    const cursor =
      typeof query === "object" &&
      query !== null &&
      "input" in query &&
      typeof query.input === "object" &&
      query.input !== null &&
      "cursor" in query.input
        ? query.input.cursor
        : undefined;
    return {
      data: cursor ? (sheetMocks.olderPage ?? sheetMocks.page) : sheetMocks.page,
      error: null,
      isPending: false,
      refresh: sheetMocks.refreshPage,
    };
  },
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    agentTranscriptPage: (target: unknown) => target,
    readAgentTranscriptPage: { label: "read agent transcript page" },
  },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    respondToUserInput: { label: "respondToUserInput" },
    messageAgent: { label: "messageAgent" },
    stopAgent: { label: "stopAgent" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "messageAgent"
      ? sheetMocks.messageAgent
      : command.label === "stopAgent"
        ? sheetMocks.stopAgent
        : command.label === "read agent transcript page"
          ? sheetMocks.readTranscriptPage
          : sheetMocks.respondToUserInput,
}));

import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  RuntimeAgentKey,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { AgentTranscriptSheet } from "./AgentTranscriptSheet";

const environmentId = EnvironmentId.make("mobile-agent-sheet-environment");
const threadId = ThreadId.make("mobile-agent-sheet-thread");
const agentKey = RuntimeAgentKey.make("mobile-agent-sheet-child");
const requestId = ApprovalRequestId.make("mobile-agent-sheet-request");
const roots: Root[] = [];

function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: kind === "approval.requested" ? "approval" : "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    eventSequence: id.endsWith("3") ? 3 : id.endsWith("2") ? 2 : 1,
    createdAt: "2026-09-24T10:00:00.000Z",
  };
}

const requested = activity("approval-request-1", "approval.requested", {
  requestId,
  requestKind: "command",
  agentKey,
  agentTitle: "Research agent",
  detail: "Run the focused tests?",
  options: [
    { decision: "accept", label: "Allow once" },
    { decision: "decline", label: "Deny" },
  ],
});
const page = {
  threadId,
  agent: {
    key: agentKey,
    parentKey: null,
    title: "Research agent",
    role: null,
    provider: ProviderDriverKind.make("opencode"),
    status: "waiting" as const,
    capabilities: {
      transcript: { state: "supported" as const },
      message: { state: "unverified" as const, reason: "Not verified." },
      answerRequests: { state: "supported" as const },
      stop: { state: "unverified" as const, reason: "Not verified." },
    },
  },
  entries: [],
  nextCursor: null,
  hasMore: false,
  snapshotSequence: 1,
  threadSequence: 1,
  completeness: { state: "partial" as const, reason: "Captured child activity only." },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sheetMocks.page = page;
  sheetMocks.olderPage = undefined;
  sheetMocks.pageQueries = [];
  sheetMocks.refreshPage.mockReset();
  sheetMocks.readTranscriptPage.mockReset();
  sheetMocks.respondToUserInput.mockReset();
  sheetMocks.respondToUserInput.mockResolvedValue({ _tag: "Success", value: undefined });
  sheetMocks.readTranscriptPage.mockResolvedValue({ _tag: "Success", value: page });
  sheetMocks.messageAgent.mockReset();
  sheetMocks.messageAgent.mockResolvedValue({ _tag: "Success", value: undefined });
  sheetMocks.stopAgent.mockReset();
  sheetMocks.stopAgent.mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AgentTranscriptSheet", () => {
  it("answers the shared request id, closes it in both views, and returns to the parent", async () => {
    const onRespondToApproval = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let activities = [requested];
    const renderSheet = () => (
      <AgentTranscriptSheet
        visible
        isConnected
        environmentId={environmentId}
        threadId={threadId}
        agentKey={agentKey}
        title="Research agent"
        activities={activities}
        respondingApprovalId={null}
        onRespondToApproval={onRespondToApproval}
        onClose={onClose}
      />
    );
    await act(async () => root.render(renderSheet()));

    expect(container.textContent).toContain("Approval needed");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Allow once")
        ?.click();
    });
    expect(onRespondToApproval).toHaveBeenCalledWith(requestId, "accept");

    activities = [requested, activity("approval-resolved-2", "approval.resolved", { requestId })];
    expect(derivePendingRequests(activities).approvals).toEqual([]);
    await act(async () => root.render(renderSheet()));
    expect(container.textContent).not.toContain("Approval needed");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Back to parent thread")
        ?.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("gates child actions by live capability and keeps an in-flight message single across close and reopen", async () => {
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let visible = true;
    let connected = true;
    const activities: OrchestrationThreadActivity[] = [];
    const renderSheet = () => (
      <AgentTranscriptSheet
        visible={visible}
        isConnected={connected}
        environmentId={environmentId}
        threadId={threadId}
        agentKey={agentKey}
        title="Research agent"
        activities={activities}
        respondingApprovalId={null}
        onRespondToApproval={vi.fn()}
        onClose={() => {
          visible = false;
          onClose();
        }}
      />
    );

    await act(async () => root.render(renderSheet()));
    expect(container.querySelector('[aria-label="Message this subagent"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Stop subagent",
      ),
    ).toBe(false);

    sheetMocks.page = {
      ...page,
      agent: {
        ...page.agent,
        capabilities: {
          ...page.agent.capabilities,
          message: { state: "supported" as const },
          stop: { state: "supported" as const },
        },
      },
    };
    connected = false;
    await act(async () => root.render(renderSheet()));
    expect(container.querySelector('[aria-label="Message this subagent"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Stop subagent",
      ),
    ).toBe(false);

    connected = true;
    let resolveMessage: ((value: unknown) => void) | undefined;
    sheetMocks.messageAgent.mockReturnValue(
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    );
    await act(async () => root.render(renderSheet()));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Message this subagent"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Please check the nested child.",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Send")
        ?.click();
    });
    expect(sheetMocks.messageAgent).toHaveBeenCalledOnce();
    expect(sheetMocks.messageAgent).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, agentKey, text: "Please check the nested child." },
    });

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Back to parent thread")
        ?.click();
      root.render(renderSheet());
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-modal]")).toBeNull();
    visible = true;
    await act(async () => root.render(renderSheet()));
    expect(sheetMocks.messageAgent).toHaveBeenCalledOnce();

    await act(async () => {
      resolveMessage?.({ _tag: "Success", value: undefined });
    });
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Message this subagent"]')?.value,
    ).toBe("");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Stop subagent")
        ?.click();
    });
    expect(sheetMocks.stopAgent).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, agentKey },
    });
  });

  it("refreshes the newest child boundary on lifecycle changes while browsing older pages", async () => {
    sheetMocks.page = {
      ...page,
      nextCursor: "older-agent-cursor",
      hasMore: true,
    };
    sheetMocks.olderPage = {
      ...page,
      entries: [],
      nextCursor: "even-older-agent-cursor",
      hasMore: true,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let activities: OrchestrationThreadActivity[] = [];
    const renderSheet = () => (
      <AgentTranscriptSheet
        visible
        isConnected
        environmentId={environmentId}
        threadId={threadId}
        agentKey={agentKey}
        title="Research agent"
        activities={activities}
        respondingApprovalId={null}
        onRespondToApproval={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await act(async () => root.render(renderSheet()));
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Load earlier activity"))
        ?.click();
    });
    const queryInputs = sheetMocks.pageQueries.filter(
      (query): query is { input: { cursor?: string } } =>
        typeof query === "object" && query !== null && "input" in query,
    );
    expect(queryInputs.some((query) => query.input.cursor === undefined)).toBe(true);
    expect(queryInputs.some((query) => query.input.cursor === "older-agent-cursor")).toBe(true);

    activities = [
      activity("agent-lifecycle-3", "task.progress", {
        agentKey,
        status: "running",
      }),
    ];
    await act(async () => root.render(renderSheet()));
    expect(sheetMocks.refreshPage).toHaveBeenCalledOnce();
  });

  it("continues bounded reconnect catch-up from an explicit gap", async () => {
    const makeEntry = (sequence: number) => ({
      id: EventId.make(`mobile-reconnect-entry-${sequence}`),
      eventSequence: sequence,
      createdAt: "2026-09-24T10:00:00.000Z",
      kind: "status" as const,
      summary: `mobile reconnect row ${sequence}`,
    });
    sheetMocks.page = { ...page, threadSequence: 1 };
    let connected = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderSheet = () => (
      <AgentTranscriptSheet
        visible
        isConnected={connected}
        environmentId={environmentId}
        threadId={threadId}
        agentKey={agentKey}
        title="Research agent"
        activities={[]}
        respondingApprovalId={null}
        onRespondToApproval={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await act(async () => root.render(renderSheet()));
    connected = false;
    await act(async () => root.render(renderSheet()));
    sheetMocks.readTranscriptPage.mockImplementation(
      async ({ input }: { input: { cursor?: string } }) => {
        if (!input.cursor) {
          const newest = {
            ...page,
            entries: [makeEntry(200)],
            nextCursor: "mobile-catch-up-1",
            hasMore: true,
          };
          sheetMocks.page = { ...page, entries: [makeEntry(210)] };
          return {
            _tag: "Success",
            value: newest,
          };
        }
        const pageIndex = Number(input.cursor.slice("mobile-catch-up-".length));
        const sequence = pageIndex === 11 ? 1 : 200 + pageIndex;
        return {
          _tag: "Success",
          value: {
            ...page,
            entries: [makeEntry(sequence)],
            nextCursor: `mobile-catch-up-${pageIndex + 1}`,
            hasMore: true,
          },
        };
      },
    );
    connected = true;
    await act(async () => root.render(renderSheet()));
    await vi.waitFor(() => expect(sheetMocks.readTranscriptPage).toHaveBeenCalledTimes(11));
    expect(container.textContent).toContain("Some child activity may be missing.");
    expect(container.textContent).toContain("Continue catch-up");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue catch-up")
        ?.click();
    });
    await vi.waitFor(() => expect(sheetMocks.readTranscriptPage).toHaveBeenCalledTimes(12));
    expect(container.textContent).not.toContain("Reconnect catch-up stopped");
    expect(container.textContent).toContain("mobile reconnect row 200");
    expect(container.textContent).toContain("mobile reconnect row 210");
    expect(container.textContent).toContain("mobile reconnect row 1");
  });

  it("opens the first page omitted by bounded mobile reconnect retention", async () => {
    const history = Array.from({ length: 1000 }, (_, index) => {
      const sequence = index + 1;
      return {
        id: EventId.make(`mobile-skipped-history-${sequence}`),
        eventSequence: sequence,
        createdAt: "2026-09-24T10:00:00.000Z",
        kind: "status" as const,
        summary: `mobile skipped row ${sequence}`,
      };
    });
    const pageForCursor = (cursor: string | undefined) => {
      if (cursor === undefined) {
        return {
          ...page,
          entries: history.slice(950),
          nextCursor: "before-951",
          hasMore: true,
          threadSequence: 100,
        };
      }
      const boundary = Number(cursor.slice("before-".length));
      const start = boundary - 50;
      return {
        ...page,
        entries: history.slice(start - 1, start + 49),
        nextCursor: start > 1 ? `before-${start}` : null,
        hasMore: start > 1,
      };
    };
    sheetMocks.page = { ...page, ...pageForCursor(undefined) };
    sheetMocks.olderPage = {
      ...page,
      ...pageForCursor("before-501"),
      nextCursor: "before-451",
      hasMore: true,
    };
    let connected = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderSheet = () => (
      <AgentTranscriptSheet
        visible
        isConnected={connected}
        environmentId={environmentId}
        threadId={threadId}
        agentKey={agentKey}
        title="Research agent"
        activities={[]}
        respondingApprovalId={null}
        onRespondToApproval={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await act(async () => root.render(renderSheet()));
    connected = false;
    await act(async () => root.render(renderSheet()));
    sheetMocks.readTranscriptPage.mockImplementation(
      async ({ input }: { input: { cursor?: string } }) => ({
        _tag: "Success",
        value: pageForCursor(input.cursor),
      }),
    );
    connected = true;
    await act(async () => root.render(renderSheet()));
    await vi.waitFor(() => expect(sheetMocks.readTranscriptPage).toHaveBeenCalledTimes(11));
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue catch-up")
        ?.click();
    });
    await vi.waitFor(() => expect(sheetMocks.readTranscriptPage).toHaveBeenCalledTimes(19));
    expect(container.textContent).toContain("Browse skipped history");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Browse skipped history")
        ?.click();
    });
    const queryInputs = sheetMocks.pageQueries.filter(
      (query): query is { input: { cursor?: string } } =>
        typeof query === "object" && query !== null && "input" in query,
    );
    expect(queryInputs.some((query) => query.input.cursor === "before-501")).toBe(true);
    expect(container.textContent).toContain("mobile skipped row 451");
    expect(container.textContent).toContain("mobile skipped row 500");
    expect(container.textContent).toContain("Load earlier activity");
  });
});
