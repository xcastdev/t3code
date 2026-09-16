/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type VcsRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";

const commands = vi.hoisted(() => ({
  draft: vi.fn(),
  executeMutation: vi.fn(),
  runAction: vi.fn(),
  stop: vi.fn(),
  update: vi.fn(),
}));
const selectorState = vi.hoisted(() => ({
  statusPhase: "ready" as "ready" | "pending" | "error",
  activeWorktreePath: null as string | null,
  draftThread: null as {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: "local" | "worktree";
    environmentSelection?: "auto" | "manual";
  } | null,
  refs: [] as VcsRef[],
  requestedCwds: [] as Array<string | null>,
  selectedRepositoryRoot: "/repo/packages/app" as string | null,
}));

const atoms = vi.hoisted(() => ({
  runAction: Symbol("run-action"),
  executeMutation: Symbol("execute-mutation"),
  status: Symbol("status"),
  refs: Symbol("refs"),
  stop: Symbol("stop"),
  update: Symbol("update"),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.runAction) return commands.runAction;
    if (atom === atoms.executeMutation) return commands.executeMutation;
    if (atom === atoms.stop) return commands.stop;
    return commands.update;
  },
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    listRefs: () => atoms.refs,
    status: () => atoms.status,
  },
}));
vi.mock("../state/sourceControl", () => ({
  sourceControlWorkspaceEnvironment: {
    runAction: atoms.runAction,
    executeMutation: atoms.executeMutation,
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { stopSession: atoms.stop, updateMetadata: atoms.update },
}));
vi.mock("../state/entities", () => ({
  useProject: () => ({ id: ProjectId.make("project"), workspaceRoot: "/repo" }),
  useThreadShell: () =>
    selectorState.draftThread === null
      ? {
          id: ThreadId.make("thread"),
          environmentId: EnvironmentId.make("environment"),
          projectId: ProjectId.make("project"),
          branch: "feature-a",
          worktreePath: selectorState.activeWorktreePath,
          session: { id: "session" },
        }
      : null,
  useThreadShellsForProjectRefs: () =>
    selectorState.activeWorktreePath ? [{ worktreePath: selectorState.activeWorktreePath }] : [],
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: (target: { cwd: string | null }) => {
    selectorState.requestedCwds.push(target.cwd);
    return {
      data: { nextCursor: null, totalCount: selectorState.refs.length },
      refs: selectorState.refs,
      isFetchingNextPage: false,
      isPending: false,
      loadNext: vi.fn(),
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (target: symbol | null) => ({
    data:
      target === atoms.refs
        ? { refs: selectorState.refs }
        : selectorState.statusPhase === "ready"
          ? {
              hasWorkingTreeChanges: false,
              refName: "feature-a",
              headCommit: "head-reviewed",
              indexTree: "index-reviewed",
              sourceControlProvider: null,
              pr: null,
            }
          : undefined,
    isPending: target === atoms.status && selectorState.statusPhase === "pending",
    error:
      target === atoms.status && selectorState.statusPhase === "error"
        ? new Error("status unavailable")
        : null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      getDraftSession: () => selectorState.draftThread,
      getDraftThreadByRef: () => selectorState.draftThread,
      setDraftThreadContext: commands.draft,
    }),
}));
vi.mock("./ThreadStatusIndicators", () => ({
  ThreadPullRequestBadgeControl: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  useLinkedThreadPullRequest: () => null,
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("~/sourceControlPresentation", () => ({
  getSourceControlPresentation: () => ({
    Icon: () => null,
    terminology: { singular: "pull request" },
  }),
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxInput: (props: React.ComponentProps<"input">) => <input {...props} />,
  ComboboxItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ComboboxListVirtualized: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxStatus: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: string[];
    renderItem: (input: { item: string; index: number }) => React.ReactNode;
  }) => <>{data.map((item, index) => renderItem({ item, index }))}</>,
}));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const roots: Root[] = [];

async function renderSelector(): Promise<void> {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(
      <BranchToolbarBranchSelector
        environmentId={environmentId}
        threadId={threadId}
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={() => undefined}
        selectedRepositoryRoot={selectorState.selectedRepositoryRoot}
      />,
    );
  });
}

function SelectedRepositoryBranchSelector() {
  const selectedRepositoryRoot = useRightPanelStore((state) =>
    state.getSourceControlRepositoryRoot(threadRef),
  );
  return (
    <BranchToolbarBranchSelector
      environmentId={environmentId}
      threadId={threadId}
      envLocked={false}
      startFromOrigin={false}
      onStartFromOriginChange={() => undefined}
      selectedRepositoryRoot={selectedRepositoryRoot}
    />
  );
}

async function renderSelectorFromRepositoryStore(): Promise<void> {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(<SelectedRepositoryBranchSelector />);
  });
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLElement>("button, [role=option]")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  selectorState.statusPhase = "ready";
  selectorState.activeWorktreePath = null;
  selectorState.draftThread = null;
  selectorState.requestedCwds = [];
  selectorState.selectedRepositoryRoot = "/repo/packages/app";
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
  selectorState.refs = [
    { name: "feature-b", current: false, isDefault: false, worktreePath: null },
  ];
  commands.runAction
    .mockReset()
    .mockImplementation(({ input }) =>
      Promise.resolve({ _tag: "Success", value: { refName: input.refName } }),
    );
  commands.executeMutation.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { status: "executed", completed: ["create-branch", "checkout"], results: [] },
  });
  commands.draft.mockReset();
  commands.stop.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BranchToolbarBranchSelector repository ownership", () => {
  it("follows one right-panel repository switch for both ref reads and checkout", async () => {
    selectorState.refs = [
      { name: "nested-branch", current: false, isDefault: false, worktreePath: null },
    ];
    useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo");
    await renderSelectorFromRepositoryStore();
    expect(selectorState.requestedCwds).toContain("/repo");

    await act(async () => {
      useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo/packages/app");
    });
    expect(selectorState.requestedCwds).toContain("/repo/packages/app");

    await click("feature-a");
    await click("nested-branch");
    expect(commands.runAction).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo/packages/app",
        action: "branch",
        branchOperation: "checkout",
        refName: "nested-branch",
        confirm: true,
        precondition: {
          expectedHeadCommit: "head-reviewed",
          expectedIndexTree: "index-reviewed",
          expectedRefName: "feature-a",
        },
      },
    });
  });

  it("asks for approval on a clean checkout and leaves the repository untouched when cancelled", async () => {
    selectorState.refs = [
      { name: "feature-b", current: false, isDefault: false, worktreePath: null },
    ];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    await renderSelector();
    await click("feature-a");
    await click("feature-b");
    expect(window.confirm).toHaveBeenCalledWith('Switch to "feature-b" in /repo/packages/app?');
    expect(commands.runAction).not.toHaveBeenCalled();
    expect(commands.update).not.toHaveBeenCalled();
  });

  it.each(["pending", "error"] as const)(
    "does not confirm or dispatch checkout or create while status is %s",
    async (statusPhase) => {
      selectorState.statusPhase = statusPhase;
      await renderSelector();

      await click("feature-a");
      await click("feature-b");

      const input = document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]');
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "feature-c");
      await act(async () => {
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
      await click('Create new ref "feature-c"');

      expect(window.confirm).not.toHaveBeenCalled();
      expect(commands.runAction).not.toHaveBeenCalled();
      expect(commands.executeMutation).not.toHaveBeenCalled();
    },
  );

  it("does not seed an outer draft worktree base from a nested repository default branch", async () => {
    selectorState.draftThread = {
      environmentId,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      environmentSelection: "auto",
    };
    selectorState.refs = [{ name: "main", current: true, isDefault: true, worktreePath: null }];

    await renderSelector();

    expect(selectorState.requestedCwds).toContain("/repo/packages/app");
    expect(commands.draft).not.toHaveBeenCalled();
    expect(commands.update).not.toHaveBeenCalled();
    expect(commands.stop).not.toHaveBeenCalled();
  });

  it("lists and checks out a nested repository without changing the outer thread or session", async () => {
    await renderSelector();
    await click("feature-a");
    await click("feature-b");

    expect(selectorState.requestedCwds).toContain("/repo/packages/app");
    expect(commands.runAction).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo/packages/app",
        action: "branch",
        branchOperation: "checkout",
        refName: "feature-b",
        confirm: true,
        precondition: {
          expectedHeadCommit: "head-reviewed",
          expectedIndexTree: "index-reviewed",
          expectedRefName: "feature-a",
        },
      },
    });
    expect(commands.update).not.toHaveBeenCalled();
    expect(commands.stop).not.toHaveBeenCalled();
  });

  it("reuses another thread-owned worktree when its active checkout selects that repository", async () => {
    selectorState.activeWorktreePath = "/repo/.t3/worktrees/feature-a";
    selectorState.selectedRepositoryRoot = "/repo/.t3/worktrees/feature-a";
    selectorState.refs = [
      {
        name: "feature-b",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/feature-b",
      },
    ];
    await renderSelector();
    await click("feature-a");
    await click("feature-b");

    expect(commands.runAction).not.toHaveBeenCalled();
    expect(commands.update).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId,
        branch: "feature-b",
        worktreePath: "/repo/.t3/worktrees/feature-b",
      },
    });
    expect(commands.stop).toHaveBeenCalledWith({ environmentId, input: { threadId } });
  });

  it("reuses the main checkout when its active worktree selects the default ref", async () => {
    selectorState.activeWorktreePath = "/repo/.t3/worktrees/feature-a";
    selectorState.selectedRepositoryRoot = "/repo/.t3/worktrees/feature-a";
    selectorState.refs = [{ name: "main", current: false, isDefault: true, worktreePath: "/repo" }];
    await renderSelector();
    await click("feature-a");
    await click("main");

    expect(commands.update).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, branch: "main", worktreePath: null },
    });
  });

  it("creates a branch in the active worktree and retains its thread lifecycle", async () => {
    selectorState.activeWorktreePath = "/repo/.t3/worktrees/feature-a";
    selectorState.selectedRepositoryRoot = "/repo/.t3/worktrees/feature-a";
    await renderSelector();
    await click("feature-a");
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]');
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "feature-c");
    await act(async () => {
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await click('Create new ref "feature-c"');

    expect(commands.executeMutation).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo/.t3/worktrees/feature-a",
        confirmation: "approved",
        steps: [
          {
            command: "runAction",
            input: {
              action: "branch",
              branchOperation: "create",
              refName: "feature-c",
              precondition: {
                expectedHeadCommit: "head-reviewed",
                expectedIndexTree: "index-reviewed",
                expectedRefName: "feature-a",
              },
            },
          },
          {
            command: "runAction",
            input: {
              action: "branch",
              branchOperation: "checkout",
              refName: "feature-c",
              precondition: {
                expectedHeadCommit: "head-reviewed",
                expectedIndexTree: "index-reviewed",
                expectedRefName: "feature-a",
              },
            },
          },
        ],
      },
    });
    expect(commands.update).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId,
        branch: "feature-c",
        worktreePath: "/repo/.t3/worktrees/feature-a",
      },
    });
  });
});
