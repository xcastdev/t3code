/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environmentId: "environment-1",
  threadId: "thread-1",
  cwd: "/reviewed-worktree",
  connected: true,
  query: {
    data: null as unknown,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  navigate: vi.fn<(screen: string, params: Record<string, unknown>) => void>(),
  dispatch: vi.fn(),
  back: vi.fn(),
  requests: [] as unknown[],
  refRequests: [] as unknown[],
  actionDone: Promise.resolve<unknown>(null),
  registry: undefined as unknown,
  sequence: 0,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: fixture.navigate,
    dispatch: fixture.dispatch,
    goBack: fixture.back,
  }),
  CommonActions: {
    navigate: (name: string, params: unknown) => ({ type: "NAVIGATE", name, params }),
  },
  StackActions: { replace: (name: string, params: unknown) => ({ type: "REPLACE", name, params }) },
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", {}, children);
  return {
    Platform: { OS: "android", Version: 35 },
    Alert: { alert: vi.fn() },
    View: container,
    ScrollView: container,
    RefreshControl: () => null,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => React.createElement("button", { onClick: onPress, disabled }, children),
  };
});
vi.mock("react-native-screens", () => ({
  Screen: () => null,
  ScreenStack: () => null,
  ScreenStackHeaderConfig: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../../components/AppText", async () => {
  const React = await import("react");
  return {
    AppText: ({ children }: { children: ReactNode }) => React.createElement("span", {}, children),
    AppTextInput: ({
      value,
      onChangeText,
    }: {
      value: string;
      onChangeText: (text: string) => void;
    }) =>
      React.createElement("textarea", {
        value,
        onInput: (event: React.FormEvent<HTMLTextAreaElement>) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("../../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/AndroidScreenHeader", async () => {
  const React = await import("react");
  return {
    AndroidSheetHeader: ({ onBack }: { onBack: () => void }) =>
      React.createElement("button", { onClick: onBack }, "Back"),
  };
});
vi.mock("../../../native/StackHeader", async () => {
  const React = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", {}, children);
  const action = ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => React.createElement("button", { onClick: onPress, disabled }, children);
  return {
    nativeHeaderScrollEdgeEffects: () => ({}),
    NativeHeaderToolbar: Object.assign(container, {
      Menu: container,
      Label: container,
      MenuAction: action,
      Button: action,
    }),
  };
});
vi.mock("../../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: {
      id: ThreadId.make(fixture.threadId),
      environmentId: EnvironmentId.make(fixture.environmentId),
      branch: "reviewed",
      pullRequests: [],
    },
    selectedThreadProject: { workspaceRoot: fixture.cwd },
    selectedEnvironmentRuntime: {
      connectionState: fixture.connected ? "connected" : "disconnected",
      serverConfig: { environment: { capabilities: {} } },
    },
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: fixture.cwd,
    selectedThreadWorktreePath: fixture.cwd,
  }),
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => fixture.query }));
vi.mock("../../../state/queries", () => ({
  useBranches: () => ({ data: { refs: [] }, refresh: vi.fn() }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null, selectedThreadBranches: [] }),
}));
vi.mock("../../../state/use-vcs-action-state", () => ({ showGitActionResult: vi.fn() }));
vi.mock("../../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("../../../lib/uuid", () => ({ uuidv4: () => `mobile-action-${fixture.sequence++}` }));
vi.mock("../../../state/threads", async () => {
  const { createRuntimeCommand } = await import("@t3tools/client-runtime/state/runtime");
  return {
    threadEnvironment: {
      updateMetadata: createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "controlled-update",
        execute: () => Effect.void,
      }),
    },
  };
});
vi.mock("../../../state/vcs", async () => {
  const { createRuntimeCommand } = await import("@t3tools/client-runtime/state/runtime");
  const runtime = Atom.runtime(Layer.empty);
  const refresh = createRuntimeCommand(runtime, {
    label: "controlled-refresh",
    execute: () => Effect.void,
  });
  return {
    vcsEnvironment: {
      status: () => null,
      refreshStatus: refresh,
      switchRef: refresh,
      createRef: createRuntimeCommand(runtime, {
        label: "controlled-create-ref",
        execute: (input: unknown) =>
          Effect.sync(() => {
            fixture.refRequests.push(input);
            return { refName: "new-branch" };
          }),
      }),
      createWorktree: refresh,
      pull: refresh,
    },
    vcsActionManager: {
      track: (_registry: unknown, _target: unknown, _label: unknown, run: () => unknown) => run(),
      runStackedAction: (target: { environmentId: EnvironmentId | null; cwd: string | null }) => {
        const command = createRuntimeCommand(runtime, {
          label: "controlled-stacked-action",
          execute: (input: unknown) =>
            Effect.sync(() => {
              fixture.requests.push({ target, input });
              return {
                branch: { status: "skipped_not_requested" },
                toast: { title: "Recorded", cta: { kind: "none" } },
              };
            }),
        });
        return {
          ...command,
          run: (registry: AtomRegistry.AtomRegistry, input: unknown) => {
            const result = command.run(registry, input);
            fixture.actionDone = result;
            return result;
          },
        };
      },
    },
  };
});

import { GitOverviewSheet } from "./GitOverviewSheet";
import {
  captureDisplayedGitSource,
  cloneDisplayedGitSource,
  type DisplayedGitSource,
} from "./git-action-source";
import { GitConfirmSheet } from "./GitConfirmSheet";
import { GitCommitSheet } from "./GitCommitSheet";
import { ThreadGitMenu } from "../ThreadGitControls";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
function status(): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "reviewed",
    headCommit: "reviewed-head",
    indexTree: "reviewed-index",
    pendingMergeHeads: [],
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    aheadOfDefaultCount: 1,
    pr: null,
  };
}
async function mount(content: ReactNode) {
  await act(async () =>
    root.render(<RegistryContext.Provider value={registry}>{content}</RegistryContext.Provider>),
  );
}
async function renderOverview() {
  await mount(
    <GitOverviewSheet
      route={{
        params: { environmentId: "environment-1", threadId: "thread-1" },
      }}
    />,
  );
}
function source(): DisplayedGitSource {
  const captured = captureDisplayedGitSource(
    { environmentId: "environment-1", threadId: "thread-1", cwd: "/reviewed-worktree" },
    status(),
  );
  if (!captured) throw new Error("Controlled displayed source is incomplete");
  return captured;
}
function confirm(
  sourceSnapshot: DisplayedGitSource | null = source(),
  action = "create_pr",
  includesCommit = "false",
) {
  return (
    <GitConfirmSheet
      route={{
        params: {
          environmentId: "environment-1",
          threadId: "thread-1",
          confirmAction: action,
          branchName: "reviewed",
          includesCommit,
          source: sourceSnapshot,
        },
      }}
    />
  );
}
function QuickAction({ status: displayed }: { status: VcsStatusResult }) {
  const actions = useSelectedThreadGitActions();
  return (
    <ThreadGitMenu
      environmentId="environment-1"
      threadId="thread-1"
      currentBranch="reviewed"
      gitStatus={displayed}
      gitOperationLabel={null}
      onPull={actions.onPullSelectedThreadBranch}
      onRunAction={actions.onRunSelectedThreadGitAction}
    />
  );
}
function RetainedAction() {
  const actions = useSelectedThreadGitActions();
  const [originalAction] = useState(() => actions.onRunSelectedThreadGitAction);
  const [originalSource] = useState(source);
  return (
    <button
      onClick={() => {
        fixture.actionDone = originalAction({ action: "create_pr" }, originalSource);
      }}
    >
      Run retained action
    </button>
  );
}
async function press(label: string) {
  const buttons = [...container.querySelectorAll("button")];
  const button =
    buttons.find((entry) => entry.textContent?.trim() === label) ??
    buttons.find((entry) => entry.textContent?.includes(label));
  expect(button, label).toBeDefined();
  await act(async () => {
    button?.click();
    await fixture.actionDone;
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.requests = [];
  fixture.refRequests = [];
  fixture.navigate.mockClear();
  fixture.dispatch.mockClear();
  fixture.back.mockClear();
  fixture.environmentId = "environment-1";
  fixture.threadId = "thread-1";
  fixture.cwd = "/reviewed-worktree";
  fixture.connected = true;
  fixture.query.data = status();
  fixture.query.error = null;
  fixture.query.isPending = false;
  fixture.actionDone = Promise.resolve(null);
  registry = AtomRegistry.make();
  fixture.registry = registry;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  registry?.dispose();
  container?.remove();
  vi.unstubAllGlobals();
});
describe("mobile displayed Git source", () => {
  it("forwards the displayed source through Overview and the real action hook", async () => {
    await renderOverview();
    await press("Create PR");
    expect(fixture.requests).toEqual([
      {
        target: { environmentId: "environment-1", cwd: "/reviewed-worktree" },
        input: {
          actionId: expect.any(String),
          action: "create_pr",
          threadId: "thread-1",
          precondition: {
            expectedHeadCommit: "reviewed-head",
            expectedIndexTree: "reviewed-index",
            expectedRefName: "reviewed",
            expectedMergeHeads: [],
          },
        },
      },
    ]);
  });
  it("offers Create PR for an already-pushed branch while Push stays unavailable", async () => {
    const pushed = { ...status(), aheadCount: 0 };
    fixture.query.data = pushed;
    await renderOverview();
    const push = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("No local commits to push"),
    );
    expect(push?.disabled).toBe(true);
    await press("Create PR");
    expect(fixture.requests).toHaveLength(1);
    fixture.requests = [];
    await mount(<QuickAction status={pushed} />);
    await press("Create PR");
    expect(fixture.requests).toEqual([
      {
        target: { environmentId: "environment-1", cwd: "/reviewed-worktree" },
        input: {
          actionId: expect.any(String),
          action: "create_pr",
          threadId: "thread-1",
          precondition: {
            expectedHeadCommit: "reviewed-head",
            expectedIndexTree: "reviewed-index",
            expectedRefName: "reviewed",
            expectedMergeHeads: [],
          },
        },
      },
    ]);
  });

  it("retains the original quick-action source through default-branch confirmation", async () => {
    const displayed = { ...status(), isDefaultRef: true };
    fixture.query.data = displayed;
    await mount(<QuickAction status={displayed} />);
    await press("Push");
    expect(fixture.requests).toEqual([]);
    expect(fixture.navigate).toHaveBeenCalledWith(
      "GitConfirm",
      expect.objectContaining({
        environmentId: "environment-1",
        threadId: "thread-1",
        confirmAction: "commit_push",
        includesCommit: "true",
        source: {
          environmentId: "environment-1",
          threadId: "thread-1",
          cwd: "/reviewed-worktree",
          precondition: {
            expectedHeadCommit: "reviewed-head",
            expectedIndexTree: "reviewed-index",
            expectedRefName: "reviewed",
            expectedMergeHeads: [],
          },
        },
      }),
    );
    const params = fixture.navigate.mock.lastCall?.[1];
    if (typeof params?.confirmAction !== "string" || typeof params.includesCommit !== "string") {
      throw new Error("Quick action did not capture its confirmation parameters");
    }
    await mount(
      confirm(cloneDisplayedGitSource(params.source), params.confirmAction, params.includesCommit),
    );
    await press("Commit & push to reviewed");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      input: {
        action: params.confirmAction,
        precondition: {
          expectedHeadCommit: "reviewed-head",
          expectedIndexTree: "reviewed-index",
          expectedRefName: "reviewed",
          expectedMergeHeads: [],
        },
      },
    });
  });

  it("carries Overview's captured source into confirmation without sending on Back", async () => {
    fixture.query.data = { ...status(), isDefaultRef: true };
    await renderOverview();
    await press("Create PR");
    const params = fixture.navigate.mock.lastCall?.[1];
    expect(fixture.navigate.mock.lastCall?.[0]).toBe("GitConfirm");
    await mount(confirm(cloneDisplayedGitSource(params?.source)));
    await press("Back");
    expect(fixture.back).toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(confirm(cloneDisplayedGitSource(params?.source)));
    await press("Push & create PR");
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    ["head", { headCommit: "changed-head" }],
    ["index", { indexTree: "changed-index" }],
    ["branch", { refName: "changed-branch" }],
    ["merge", { pendingMergeHeads: ["merge-head"] }],
  ])("denies a changed %s rather than rebasing an open confirmation", async (_kind, changed) => {
    const original = source();
    await mount(confirm(original));
    fixture.query.data = { ...status(), ...changed };
    await mount(confirm(original));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
    expect(container.textContent).toContain("Close this sheet and review it again");
  });

  it("does not replace an open confirmation when its route source is changed", async () => {
    await mount(confirm());
    const changed = { ...status(), headCommit: "new-head", indexTree: "new-index" };
    fixture.query.data = changed;
    const replacement = captureDisplayedGitSource(
      { environmentId: "environment-1", threadId: "thread-1", cwd: "/reviewed-worktree" },
      changed,
    );
    await mount(confirm(replacement));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
  });

  it.each(["thread", "environment", "worktree"])(
    "denies a retained action after its %s owner switches",
    async (owner) => {
      await mount(<RetainedAction />);
      if (owner === "thread") fixture.threadId = "thread-2";
      if (owner === "environment") fixture.environmentId = "environment-2";
      if (owner === "worktree") fixture.cwd = "/other-worktree";
      await mount(<RetainedAction />);
      await press("Run retained action");
      expect(fixture.requests).toEqual([]);
    },
  );

  it("denies a disconnected confirmation and requires the original source on reconnect", async () => {
    const original = source();
    await mount(confirm(original));
    fixture.connected = false;
    await mount(confirm(original));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
    fixture.connected = true;
    fixture.query.data = { ...status(), indexTree: "changed-index" };
    await mount(confirm(original));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
    fixture.query.data = status();
    await mount(confirm(original));
    await press("Push & create PR");
    expect(fixture.requests).toHaveLength(1);
  });

  it.each(["headCommit", "indexTree"] as const)(
    "does not offer a mutation with missing %s",
    async (field) => {
      const incomplete = { ...status() };
      delete incomplete[field];
      fixture.query.data = incomplete;
      await renderOverview();
      await press("Create PR");
      expect(fixture.requests).toEqual([]);
    },
  );

  it("denies missing confirmation source and retained status during refresh or failure", async () => {
    await mount(confirm(null));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(container);
    const original = source();
    fixture.query.isPending = true;
    await mount(confirm(original));
    await press("Push & create PR");
    fixture.query.isPending = false;
    fixture.query.error = "Disconnected";
    await mount(confirm(original));
    await press("Push & create PR");
    expect(fixture.requests).toEqual([]);
  });

  it("opens branch selection without unconditioned creation or automatic continuation", async () => {
    await mount(confirm());
    await press("Choose another branch");
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "REPLACE",
      name: "GitBranches",
      params: { environmentId: "environment-1", threadId: "thread-1" },
    });
    expect(fixture.refRequests).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("keeps commit feature-branch confirmation in one source-fenced stacked action", async () => {
    await mount(confirm(source(), "commit_push", "true"));
    await press("Feature branch & continue");
    expect(fixture.refRequests).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      input: {
        action: "commit_push",
        featureBranch: true,
        precondition: {
          expectedHeadCommit: "reviewed-head",
          expectedIndexTree: "reviewed-index",
          expectedRefName: "reviewed",
          expectedMergeHeads: [],
        },
      },
    });
  });

  it("keeps Overview's source with the commit message and selected files", async () => {
    const displayed = {
      ...status(),
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: "first.ts", insertions: 1, deletions: 0 },
          { path: "second.ts", insertions: 2, deletions: 0 },
        ],
        insertions: 3,
        deletions: 0,
      },
    };
    fixture.query.data = displayed;
    await renderOverview();
    await press("Commit");
    const params = fixture.navigate.mock.lastCall?.[1];
    expect(fixture.navigate.mock.lastCall?.[0]).toBe("GitCommit");
    await mount(
      <GitCommitSheet
        route={{
          params: {
            environmentId: "environment-1",
            threadId: "thread-1",
            source: cloneDisplayedGitSource(params?.source),
          },
        }}
      />,
    );
    await press("Edit");
    await press("second.ts");
    const message = container.querySelector("textarea");
    if (!message) throw new Error("Commit message field was not mounted");
    await act(async () => {
      message.value = "Keep selected change";
      message.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Commit");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      input: {
        action: "commit",
        commitMessage: "Keep selected change",
        filePaths: ["first.ts"],
        precondition: {
          expectedHeadCommit: "reviewed-head",
          expectedIndexTree: "reviewed-index",
          expectedRefName: "reviewed",
          expectedMergeHeads: [],
        },
      },
    });
  });

  it("does not rebaseline the commit sheet when the index changes", async () => {
    fixture.query.data = {
      ...status(),
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "first.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    };
    const params = { environmentId: "environment-1", threadId: "thread-1", source: source() };
    await mount(<GitCommitSheet route={{ params }} />);
    fixture.query.data = {
      ...status(),
      indexTree: "new-index",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "first.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    };
    await mount(<GitCommitSheet route={{ params }} />);
    await press("Commit");
    await press("Back");
    expect(fixture.requests).toEqual([]);
    expect(fixture.back).toHaveBeenCalled();
  });
});
