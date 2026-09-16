/* @vitest-environment happy-dom */

import { act, Children, cloneElement, isValidElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { VcsStatusResult } from "@t3tools/contracts";

const statusQuery = vi.hoisted(() => ({
  data: {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "feature/test",
    headCommit: "reviewed-head",
    indexTree: "reviewed-index",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/file.ts", insertions: 1, deletions: 0, indexStatus: "unstaged" }],
      insertions: 1,
      deletions: 0,
    } as VcsStatusResult["workingTree"],
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  } as VcsStatusResult,
  error: null as unknown,
  isPending: false,
}));
const gitActionRun = vi.hoisted(() =>
  vi.fn((_input: unknown) =>
    Promise.resolve({
      _tag: "Success",
      value: {
        branch: { status: "unchanged" },
        toast: { cta: { kind: "none" }, title: "Committed" },
      },
    }),
  ),
);
const toastAdd = vi.hoisted(() => vi.fn());
const publishRepositoryRun = vi.hoisted(() =>
  vi.fn((_scope: unknown, _input: unknown) => new Promise(() => {})),
);

const sourceControlDiscovery = vi.hoisted(() => Symbol("source-control-discovery"));
const workspaceDiscovery = vi.hoisted(() => Symbol("workspace-discovery"));
const workspaceRefresh = vi.hoisted(() => Symbol("workspace-refresh"));
const workspaceRunAction = vi.hoisted(() => Symbol("workspace-run-action"));
const workspaceRunActionRun = vi.hoisted(() => vi.fn());
const workspaceInit = vi.hoisted(() => Symbol("workspace-init"));
const workspaceInitRun = vi.hoisted(() => vi.fn());
const pullRequestRunAction = vi.hoisted(() => Symbol("pull-request-run-action"));
const pullRequestInvalidate = vi.hoisted(() => Symbol("pull-request-invalidate"));
const pullRequestDetail = vi.hoisted(() => Symbol("pull-request-detail"));
const pullRequestRun = vi.hoisted(() => vi.fn());
const pullRequestInvalidateRun = vi.hoisted(() => vi.fn());
const pullRequestDetailQuery = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
}));
const projects = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
const workspaceStatus = vi.hoisted(() => Symbol("workspace-status"));
const workspaceProgress = vi.hoisted(() => ({
  value: { isRunning: false, currentStep: null, completed: [] } as Record<string, unknown>,
}));
const createWorktree = vi.hoisted(() => Symbol("create-worktree"));
const createWorktreeRun = vi.hoisted(() => vi.fn());
const workspaceDiscoverRun = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    _tag: "Success",
    value: {
      repositories: [{ rootPath: "/repo", capabilities: { actions: [] } }],
    },
  }),
);
const sourceControlDiscoveryQuery = vi.hoisted(() => ({
  data: {
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        status: "available",
        installHint: null,
        auth: {
          status: "authenticated",
          account: { _id: "Option", _tag: "Some", value: "octo" },
          detail: { _id: "Option", _tag: "None" },
        },
      },
    ],
  },
  error: null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "workspace-progress" ? workspaceProgress.value : { availableEditors: [] },
}));
vi.mock("@t3tools/client-runtime/state/sourceControlWorkspace", () => ({
  sourceControlWorkspaceProgressAtom: () => "workspace-progress",
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: symbol | null) =>
    query === sourceControlDiscovery
      ? sourceControlDiscoveryQuery
      : query === pullRequestDetail
        ? pullRequestDetailQuery
        : statusQuery,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => Symbol("config") },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: Symbol("update") } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === workspaceDiscovery) return workspaceDiscoverRun;
    if (command === createWorktree) return createWorktreeRun;
    if (command === workspaceRunAction) return workspaceRunActionRun;
    if (command === workspaceInit) return workspaceInitRun;
    if (command === workspaceRefresh) return vi.fn();
    if (command === pullRequestRunAction) return pullRequestRun;
    if (command === pullRequestInvalidate) return pullRequestInvalidateRun;
    return vi.fn();
  },
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => sourceControlDiscovery },
  sourceControlWorkspaceEnvironment: {
    status: () => workspaceStatus,
    refreshStatus: workspaceRefresh,
    discoverRepositories: workspaceDiscovery,
    runAction: workspaceRunAction,
    init: workspaceInit,
    createWorktree,
  },
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    detail: () => pullRequestDetail,
    runAction: pullRequestRunAction,
    invalidate: pullRequestInvalidate,
  },
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  useProjects: () => projects.current,
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      setDraftThreadContext: () => undefined,
    }),
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("~/terminal-links", () => ({ resolvePathLinkTarget: (path: string) => path }));
vi.mock("~/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  randomUUID: () => "action",
}));
vi.mock("~/sourceControlPresentation", () => ({
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY: { singular: "pull request", shortLabel: "PR" },
  getChangeRequestTerminology: () => ({ singular: "pull request", shortLabel: "PR" }),
  getSourceControlPresentation: () => ({
    Icon: () => <span />,
    terminology: { singular: "pull request", shortLabel: "PR" },
  }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: gitActionRun }),
  usePreparePullRequestThreadAction: () => ({ run: vi.fn() }),
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({ isPending: false, run: vi.fn() }),
  useVcsPullAction: () => ({ run: vi.fn() }),
  useSourceControlPublishRepositoryAction: (scope: unknown) => ({
    isPending: false,
    run: (input: unknown) => publishRepositoryRun(scope, input),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@base-ui/react/radio", () => ({
  Radio: {
    Root: ({ children, value, ...props }: React.ComponentProps<"button"> & { value: string }) => (
      <button {...props} data-radio-value={value}>
        {children}
      </button>
    ),
  },
}));

vi.mock("../StartTruncatedPath", () => ({
  StartTruncatedPath: ({ path }: { path: string }) => <span>{path}</span>,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { size?: unknown; variant?: unknown }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange,
    indeterminate: _indeterminate,
    ...props
  }: {
    onCheckedChange?: () => void;
    indeterminate?: boolean;
  }) => <input type="checkbox" onChange={() => onCheckedChange?.()} {...props} />,
}));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      {Children.map(children, (child) =>
        isValidElement<{ value: string; onClick?: () => void }>(child)
          ? cloneElement(child as ReactElement<{ value: string; onClick?: () => void }>, {
              onClick: () => onValueChange(child.props.value),
            })
          : child,
      )}
    </div>
  ),
}));
vi.mock("../ui/spinner", () => ({ Spinner: () => <span /> }));
vi.mock("../ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../ui/group", () => ({
  Group: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  GroupSeparator: (props: React.ComponentProps<"div">) => <div {...props} />,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuCheckboxItem: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { checked?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  MenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
  MenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSubPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSubTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  MenuTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: toastAdd, close: vi.fn(), update: vi.fn() },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/wizard", () => ({
  WizardFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardSteps: () => <div />,
}));

import SourceControlActions from "./SourceControlActions";

const roots: Root[] = [];
const ActionsWithTarget = SourceControlActions as unknown as (props: {
  activeThreadRef: { environmentId: string; threadId: string };
  gitCwd: string;
  target: HTMLElement | null;
}) => React.ReactNode;

async function render(
  root: Root,
  target: HTMLElement | null,
  environmentId = "environment",
  cwd = "/repo",
): Promise<void> {
  await act(async () => {
    root.render(
      <ActionsWithTarget
        activeThreadRef={{ environmentId, threadId: "thread" }}
        gitCwd={cwd}
        target={target}
      />,
    );
  });
}

async function typeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  gitActionRun.mockClear();
  publishRepositoryRun.mockClear();
  createWorktreeRun.mockReset();
  workspaceRunActionRun.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      completed: ["branch"],
      branch: { status: "unchanged" },
      toast: { cta: { kind: "none" }, title: "Done" },
    },
  });
  workspaceInitRun.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  workspaceProgress.value = { isRunning: false, currentStep: null, completed: [] };
  pullRequestRun.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  pullRequestInvalidateRun.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  pullRequestDetailQuery.data = null;
  pullRequestDetailQuery.error = null;
  projects.current = [];
  statusQuery.data = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "feature/test",
    headCommit: "reviewed-head",
    indexTree: "reviewed-index",
    hasWorkingTreeChanges: true,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    sourceControlProvider: undefined,
    pr: null,
    workingTree: {
      files: [{ path: "src/file.ts", insertions: 1, deletions: 0 }],
      insertions: 1,
      deletions: 0,
    },
  };
  statusQuery.error = null;
  statusQuery.isPending = false;
  toastAdd.mockClear();
  workspaceDiscoverRun.mockResolvedValue({
    _tag: "Success",
    value: { repositories: [{ rootPath: "/repo", capabilities: { actions: [] } }] },
  });
  document.body.replaceChildren();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});

async function clickButton(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}

describe("SourceControlActions target lifetime", () => {
  it("keeps mutation controls disabled through incomplete, pending, and failed snapshots", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["push"] } }] },
    });
    const baseStatus = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      aheadCount: 1,
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    for (const unavailable of ["refName", "headCommit", "indexTree", "pending", "error"] as const) {
      const nextStatus = { ...baseStatus } as Record<string, unknown>;
      if (unavailable !== "pending" && unavailable !== "error") delete nextStatus[unavailable];
      statusQuery.data = nextStatus as VcsStatusResult;
      statusQuery.isPending = unavailable === "pending";
      statusQuery.error = unavailable === "error" ? "status failed" : null;
      await render(root, target);
      const disabledPush = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Push",
      );
      expect(disabledPush?.disabled, unavailable).toBe(true);
      await act(async () => disabledPush?.click());
      expect(document.body.textContent).not.toContain("Confirm Git action");
      expect(workspaceRunActionRun).not.toHaveBeenCalled();
    }

    statusQuery.data = { ...baseStatus, indexTree: "reviewed-index" };
    statusQuery.isPending = false;
    statusQuery.error = null;
    await render(root, target);
    const enabledPush = [...document.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Push",
    );
    expect(enabledPush?.disabled).toBe(false);
    await act(async () => enabledPush?.click());
    expect(document.body.textContent).toContain("Confirm Git action");
    expect(document.body.textContent).toContain("Repository /repo, branch feature/test");

    const lostStatus = { ...statusQuery.data } as Record<string, unknown>;
    delete lostStatus.indexTree;
    statusQuery.data = lostStatus as VcsStatusResult;
    await render(root, target);
    expect(document.body.textContent).not.toContain("Confirm Git action");
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("requires explicit approval before the Initialize control invokes the shared adapter", async () => {
    statusQuery.data = { ...statusQuery.data, isRepo: false };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await clickButton("Initialize Git");
    expect(workspaceInitRun).not.toHaveBeenCalled();
    await clickButton("Initialize Git");
    expect(workspaceInitRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/repo", confirmation: "approved" },
    });
  });

  it("opens the header continuation confirmation with its actual target and lets cancel send no RPC", async () => {
    workspaceProgress.value = {
      isRunning: false,
      currentStep: null,
      completed: ["commit"],
      commitSha: "abc123",
      continuation: {
        action: "push",
        remoteName: "upstream",
        refName: "feature/retry",
        strategy: "rebase",
      },
    };
    statusQuery.data = {
      ...statusQuery.data,
      remoteName: "upstream",
      remoteRefName: "feature/retry",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await clickButton("Retry push after abc123");
    expect(document.body.textContent).toContain("Repository /repo, branch feature/test");
    expect(document.body.textContent).toContain("upstream/feature/retry");
    await clickButton("Cancel");
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
    await clickButton("Retry push after abc123");
    await clickButton("Continue");
    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        cwd: "/repo",
        action: "push",
        confirm: true,
        remoteName: "upstream",
        refName: "feature/retry",
        strategy: "rebase",
        precondition: {
          expectedHeadCommit: "reviewed-head",
          expectedIndexTree: "reviewed-index",
          expectedRefName: "feature/test",
        },
      },
    });
  });

  it("cancels a header approval before a changed pull or publication target can run", async () => {
    workspaceProgress.value = {
      isRunning: false,
      currentStep: null,
      completed: ["commit"],
      commitSha: "abc123",
      continuation: { action: "push", remoteName: "origin", refName: "reviewed-target" },
    };
    statusQuery.data = {
      ...statusQuery.data,
      remoteName: "origin",
      remoteRefName: "reviewed-target",
      pullRemoteName: "origin",
      pullRefName: "reviewed-target",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await clickButton("Retry push after abc123");
    expect(document.body.textContent).toContain("Confirm Git action");

    statusQuery.data = {
      ...statusQuery.data,
      remoteName: "other",
      remoteRefName: "changed-target",
      pullRemoteName: "other",
      pullRefName: "changed-target",
    };
    await render(root, target);

    expect(document.body.textContent).not.toContain("Confirm Git action");
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("routes the header Commit entry point through the typed, staged-only workflow", async () => {
    statusQuery.data = { ...statusQuery.data, hasPrimaryRemote: false, hasUpstream: false };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await act(async () => {
      [...target.querySelectorAll("button")]
        .find((button) => button.textContent === "Commit")
        ?.click();
    });
    const message = document.querySelector<HTMLInputElement>(
      'input[aria-label="Workflow message"]',
    );
    expect(message).not.toBeNull();
    await typeInput(message!, "commit staged changes");
    await clickButton("Run action");
    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: expect.objectContaining({
        cwd: "/repo",
        action: "commit",
        confirm: false,
        message: "commit staged changes",
      }),
    });
    expect(gitActionRun).not.toHaveBeenCalled();
  });

  it("cancels a stale commit approval without accepting its changed index", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: false,
      hasUpstream: false,
      indexTree: "index-reviewed",
      headCommit: "head-reviewed",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await act(async () => {
      [...target.querySelectorAll("button")]
        .find((button) => button.textContent === "Commit")
        ?.click();
    });
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Workflow message"]')!,
      "reviewed index",
    );
    statusQuery.data = { ...statusQuery.data, indexTree: "index-added-after-review" };
    await render(root, target);
    expect(document.querySelector('input[aria-label="Workflow message"]')).toBeNull();
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("keeps an open typed commit draft when its Source Control target disappears and returns", async () => {
    statusQuery.data = { ...statusQuery.data, hasPrimaryRemote: false, hasUpstream: false };
    const host = document.createElement("div");
    const firstTarget = document.createElement("div");
    const nextTarget = document.createElement("div");
    document.body.append(host, firstTarget, nextTarget);
    const root = createRoot(host);
    roots.push(root);

    await render(root, firstTarget);
    expect(firstTarget.querySelector("[data-source-control-actions]")).not.toBeNull();

    await act(async () => {
      [...firstTarget.querySelectorAll("button")]
        .find((button) => button.textContent === "Commit")
        ?.click();
    });
    const draft = document.querySelector<HTMLInputElement>('input[aria-label="Workflow message"]')!;
    await typeInput(draft, "keep this commit message");

    await render(root, null);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Workflow message"]')?.value,
    ).toBe("keep this commit message");

    await render(root, nextTarget);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Workflow message"]')?.value,
    ).toBe("keep this commit message");
  });

  it("keeps publish wizard input when its Source Control target disappears and returns", async () => {
    const host = document.createElement("div");
    const firstTarget = document.createElement("div");
    const nextTarget = document.createElement("div");
    document.body.append(host, firstTarget, nextTarget);
    const root = createRoot(host);
    roots.push(root);

    await render(root, firstTarget);
    await act(async () => {
      [...firstTarget.querySelectorAll("button")]
        .find((button) => button.textContent === "Publish repository...")
        ?.click();
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Next")
        ?.click();
    });
    const repository = document.querySelector<HTMLInputElement>("#publish-repository-path")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(repository, "octo/persistent-repository");
    await act(async () => repository.dispatchEvent(new Event("input", { bubbles: true })));

    await render(root, null);
    expect(document.querySelector<HTMLInputElement>("#publish-repository-path")?.value).toBe(
      "octo/persistent-repository",
    );

    await render(root, nextTarget);
    expect(document.querySelector<HTMLInputElement>("#publish-repository-path")?.value).toBe(
      "octo/persistent-repository",
    );
  });

  it("submits the publication snapshot that its wizard reviewed", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: false,
      refName: "feature/publish",
      headCommit: "publish-head",
      indexTree: "publish-index",
    };
    publishRepositoryRun.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        repository: {
          provider: "github",
          nameWithOwner: "octo/reviewed",
          url: "https://github.com/octo/reviewed",
          sshUrl: "git@github.com:octo/reviewed.git",
        },
        remoteName: "origin",
        remoteUrl: "git@github.com:octo/reviewed.git",
        branch: "feature/publish",
        status: "pushed",
      },
    });
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Publish repository...");
    await clickButton("Next");
    await typeInput(
      document.querySelector<HTMLInputElement>("#publish-repository-path")!,
      "octo/reviewed",
    );
    await clickButton("Publish");
    await act(async () => {
      await Promise.resolve();
    });

    expect(publishRepositoryRun).toHaveBeenCalledWith(
      { environmentId: "environment", cwd: "/repo" },
      expect.objectContaining({
        provider: "github",
        repository: "octo/reviewed",
        precondition: {
          expectedHeadCommit: "publish-head",
          expectedIndexTree: "publish-index",
          expectedRefName: "feature/publish",
        },
      }),
    );
  });

  it("creates a worktree from the workflow menu using typed inputs", async () => {
    // Do not inherit the reviewed index from a prior mounted workflow case.
    statusQuery.data = {
      ...statusQuery.data,
      refName: "feature/test",
      headCommit: "head-worktree",
      indexTree: "index-worktree",
    };
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["branch"] } }] },
    });
    createWorktreeRun.mockResolvedValue({
      _tag: "Success",
      value: { worktree: { path: "/tmp/feature", refName: "feature/worktree" } },
    });
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Worktree");
    expect(document.querySelector('input[aria-label="Worktree ref"]')).not.toBeNull();
    const branch = document.querySelector<HTMLInputElement>('input[aria-label="Worktree branch"]')!;
    const path = document.querySelector<HTMLInputElement>('input[aria-label="Worktree path"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(branch, "feature/worktree");
    await act(async () => branch.dispatchEvent(new Event("input", { bubbles: true })));
    setter?.call(path, "/tmp/feature");
    await act(async () => path.dispatchEvent(new Event("input", { bubbles: true })));
    await clickButton("Create worktree");
    expect(createWorktreeRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        cwd: "/repo",
        refName: "feature/test",
        newRefName: "feature/worktree",
        baseRefName: "feature/test",
        path: "/tmp/feature",
        confirmation: "approved",
        precondition: {
          expectedHeadCommit: "head-worktree",
          expectedIndexTree: "index-worktree",
          expectedRefName: "feature/test",
        },
      },
    });
  });

  it("renders Create Branch From's required source and sends it through the typed workflow request", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["branch"] } }] },
    });
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Branch From...");
    const source = document.querySelector<HTMLInputElement>('input[aria-label="Source ref"]');
    expect(source).not.toBeNull();
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Ref name"]')!,
      "feature/next",
    );
    await typeInput(source!, "origin/main");
    await clickButton("Run action");

    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: expect.objectContaining({
        cwd: "/repo",
        action: "branch",
        branchOperation: "create-from",
        refName: "feature/next",
        sourceRef: "origin/main",
        confirm: true,
      }),
    });
  });

  it("renders Checkout's ref and submits the typed checkout operation", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["branch"] } }] },
    });
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Checkout");
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Ref name"]')!,
      "feature/next",
    );
    await clickButton("Run action");

    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: expect.objectContaining({
        cwd: "/repo",
        action: "branch",
        branchOperation: "checkout",
        refName: "feature/next",
        confirm: true,
      }),
    });
  });

  it("invalidates Undo Last Commit when its reviewed source ref or HEAD moves", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["reset"] } }] },
    });
    statusQuery.data = {
      ...statusQuery.data,
      refName: "feature/reviewed",
      headCommit: "a".repeat(40),
      headHasParent: true,
      indexTree: "index-reviewed",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Undo Last Commit");
    expect(document.body.textContent).toContain("Repository /repo");
    expect(document.body.textContent).toContain(`feature/reviewed at ${"a".repeat(40)}`);

    statusQuery.data = {
      ...statusQuery.data,
      refName: "feature/other",
      headCommit: "b".repeat(40),
    };
    await render(root, target);

    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Run action",
      ),
    ).toBe(false);
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("shows Merge's reviewed repository and target, then cancels it on source drift", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["merge"] } }] },
    });
    statusQuery.data = {
      ...statusQuery.data,
      refName: "feature/reviewed",
      headCommit: "a".repeat(40),
      indexTree: "index-reviewed",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Merge");
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Target ref"]')!,
      "origin/main",
    );
    expect(document.body.textContent).toContain("Repository /repo");
    expect(document.body.textContent).toContain("Merge will run from feature/reviewed");
    expect(document.body.textContent).toContain("target origin/main");

    statusQuery.data = { ...statusQuery.data, headCommit: "b".repeat(40) };
    await render(root, target);

    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Run action",
      ),
    ).toBe(false);
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("sends a reviewed source precondition for a successful typed branch mutation", async () => {
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: { repositories: [{ rootPath: "/repo", capabilities: { actions: ["branch"] } }] },
    });
    statusQuery.data = {
      ...statusQuery.data,
      refName: "feature/reviewed",
      headCommit: "a".repeat(40),
      indexTree: "index-reviewed",
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Branch From...");
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Ref name"]')!,
      "feature/next",
    );
    await typeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Source ref"]')!,
      "origin/main",
    );
    await clickButton("Run action");

    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: expect.objectContaining({
        precondition: {
          expectedHeadCommit: "a".repeat(40),
          expectedIndexTree: "index-reviewed",
          expectedRefName: "feature/reviewed",
        },
      }),
    });
  });

  it("confirms and sends Merge Pull Request through the selected repository controller", async () => {
    projects.current = [
      {
        id: "project",
        environmentId: "environment",
        workspaceRoot: "/repo",
        repositoryIdentity: { provider: "github", displayName: "octo/repository" },
      },
    ];
    statusQuery.data = {
      ...statusQuery.data,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      pr: {
        number: 7,
        title: "Ship it",
        url: "https://github.com/octo/repository/pull/7",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    };
    pullRequestDetailQuery.data = {
      capabilities: { actions: ["merge", "close"] },
      viewerPermissions: { actions: ["merge", "close"] },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Merge Pull Request");
    await clickButton("Confirm");

    expect(pullRequestRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        projectId: "project",
        repositoryRoot: "/repo",
        repository: "octo/repository",
        number: 7,
        action: "merge",
      },
    });
  });

  it.each([
    { label: "a missing ref", unavailable: "refName" },
    { label: "a missing HEAD", unavailable: "headCommit" },
    { label: "a missing index", unavailable: "indexTree" },
    { label: "a pending status", unavailable: "pending" },
    { label: "a failed status", unavailable: "error" },
  ] as const)(
    "closes a Merge Pull Request approval on $label and requires fresh approval after recovery",
    async ({ unavailable }) => {
      projects.current = [
        {
          id: "project",
          environmentId: "environment",
          workspaceRoot: "/repo",
          repositoryIdentity: { provider: "github", displayName: "octo/repository" },
        },
      ];
      statusQuery.data = {
        ...statusQuery.data,
        sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
        pr: {
          number: 7,
          title: "Ship it",
          url: "https://github.com/octo/repository/pull/7",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      };
      pullRequestDetailQuery.data = {
        capabilities: { actions: ["merge", "close"] },
        viewerPermissions: { actions: ["merge", "close"] },
      };
      const host = document.createElement("div");
      const target = document.createElement("div");
      document.body.append(host, target);
      const root = createRoot(host);
      roots.push(root);

      await render(root, target);
      await clickButton("Merge Pull Request");
      const staleConfirm = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Confirm",
      );
      expect(staleConfirm).toBeDefined();

      const next = { ...statusQuery.data } as Record<string, unknown>;
      if (unavailable === "pending") statusQuery.isPending = true;
      else if (unavailable === "error") statusQuery.error = "status failed";
      else delete next[unavailable];
      statusQuery.data = next as VcsStatusResult;
      await render(root, target);

      expect(
        [...document.querySelectorAll("button")].some((button) => button.textContent === "Confirm"),
      ).toBe(false);
      // A queued click from the just-closed dialog also fails closed against the
      // latest snapshot rather than submitting its captured merge.
      await act(async () => staleConfirm?.click());
      expect(pullRequestRun).not.toHaveBeenCalled();

      statusQuery.data = {
        ...statusQuery.data,
        refName: "feature/test",
        headCommit: "reviewed-head",
        indexTree: "reviewed-index",
      };
      statusQuery.isPending = false;
      statusQuery.error = null;
      await render(root, target);
      await clickButton("Merge Pull Request");
      await clickButton("Confirm");

      expect(pullRequestRun).toHaveBeenCalledWith({
        environmentId: "environment",
        input: {
          projectId: "project",
          repositoryRoot: "/repo",
          repository: "octo/repository",
          number: 7,
          action: "merge",
        },
      });
    },
  );

  it("keeps Refresh Pull Request invokable after detail loading fails", async () => {
    projects.current = [
      {
        id: "project",
        environmentId: "environment",
        workspaceRoot: "/repo",
        repositoryIdentity: { provider: "github", displayName: "octo/repository" },
      },
    ];
    statusQuery.data = {
      ...statusQuery.data,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      pr: {
        number: 7,
        title: "Ship it",
        url: "https://github.com/octo/repository/pull/7",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    };
    pullRequestDetailQuery.error = new Error("transient detail failure");
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Refresh Pull Request");

    expect(pullRequestInvalidateRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        reference: {
          projectId: "project",
          repositoryRoot: "/repo",
          repository: "octo/repository",
          number: 7,
        },
      },
    });
  });

  it("uses the selected child repository identity when parent and child PR numbers overlap", async () => {
    projects.current = [
      {
        id: "parent",
        environmentId: "environment",
        workspaceRoot: "/repo",
        repositoryIdentity: { provider: "github", displayName: "octo/parent" },
      },
      {
        id: "child",
        environmentId: "environment",
        workspaceRoot: "/repo/packages/child",
        repositoryIdentity: { provider: "github", displayName: "octo/child" },
      },
    ];
    statusQuery.data = {
      ...statusQuery.data,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      pr: {
        number: 7,
        title: "Child",
        url: "https://github.com/octo/child/pull/7",
        baseRef: "main",
        headRef: "feature/child",
        state: "open",
      },
    };
    pullRequestDetailQuery.data = {
      capabilities: { actions: ["merge", "close"] },
      viewerPermissions: { actions: ["merge", "close"] },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target, "environment", "/repo/packages/child");
    await clickButton("Merge Pull Request");
    await clickButton("Confirm");

    expect(pullRequestRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        projectId: "child",
        repositoryRoot: "/repo/packages/child",
        repository: "octo/child",
        number: 7,
        action: "merge",
      },
    });
  });

  it("closes a PR confirmation when its selected repository scope changes", async () => {
    projects.current = [
      {
        id: "project",
        environmentId: "environment",
        workspaceRoot: "/repo",
        repositoryIdentity: { provider: "github", displayName: "octo/repository" },
      },
    ];
    statusQuery.data = {
      ...statusQuery.data,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      pr: {
        number: 7,
        title: "Ship it",
        url: "https://github.com/octo/repository/pull/7",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    };
    pullRequestDetailQuery.data = {
      capabilities: { actions: ["merge", "close"] },
      viewerPermissions: { actions: ["merge", "close"] },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Merge Pull Request");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Confirm"),
    ).toBe(true);
    await render(root, target, "environment", "/repo/other");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Confirm"),
    ).toBe(false);
  });

  it("cancels default-branch PR approval when its repository scope changes", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      isDefaultRef: true,
      pr: null,
      refName: "main",
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Pull Request");
    expect(document.body.textContent).toContain("Check out feature branch & continue");
    await render(root, target, "environment", "/repo/other");

    expect(document.body.textContent).not.toContain("Check out feature branch & continue");
    expect(workspaceRunActionRun).not.toHaveBeenCalled();
  });

  it("cancels default-branch PR approval when its reviewed source ref changes", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      isDefaultRef: true,
      pr: null,
      refName: "main",
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Pull Request");
    expect(document.body.textContent).toContain("Check out feature branch & continue");

    statusQuery.data = { ...statusQuery.data, isDefaultRef: false, refName: "other-feature" };
    await render(root, target);

    expect(document.body.textContent).not.toContain("Check out feature branch & continue");
    expect(gitActionRun).not.toHaveBeenCalled();
  });

  it("cancels default-branch PR approval when its reviewed publication target changes", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      isDefaultRef: true,
      pr: null,
      refName: "main",
      remoteName: "origin",
      remoteRefName: "main",
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Pull Request");
    expect(document.body.textContent).toContain("Check out feature branch & continue");

    statusQuery.data = { ...statusQuery.data, remoteRefName: "release" };
    await render(root, target);

    expect(document.body.textContent).not.toContain("Check out feature branch & continue");
    expect(gitActionRun).not.toHaveBeenCalled();
  });

  it("cancels publication before retained destination details can cross repository scope", async () => {
    statusQuery.data = { ...statusQuery.data, hasPrimaryRemote: false, refName: "feature/test" };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Publish repository...");
    await clickButton("Next");
    const repository = document.querySelector<HTMLInputElement>("#publish-repository-path");
    expect(repository).not.toBeNull();
    await typeInput(repository!, "octo/reviewed-target");
    await render(root, target, "environment", "/repo/other");

    expect(document.querySelector("#publish-repository-path")).toBeNull();
    expect(publishRepositoryRun).not.toHaveBeenCalled();
  });

  it("cancels publication before retained provider choices can cross environment scope", async () => {
    statusQuery.data = { ...statusQuery.data, hasPrimaryRemote: false, refName: "feature/test" };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Publish repository...");
    await clickButton("Next");
    expect(document.querySelector("#publish-repository-path")).not.toBeNull();
    await render(root, target, "other-environment", "/repo");

    expect(document.querySelector("#publish-repository-path")).toBeNull();
    expect(publishRepositoryRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the reviewed source ref and head change",
      nextStatus: {
        refName: "feature/other",
        headCommit: "b".repeat(40),
        isDefaultRef: false,
      },
      environmentId: "environment",
      cwd: "/repo",
    },
    {
      label: "the reviewed source becomes the default ref",
      nextStatus: {
        refName: "main",
        headCommit: "b".repeat(40),
        isDefaultRef: true,
      },
      environmentId: "environment",
      cwd: "/repo",
    },
    {
      label: "the reviewed publication target changes",
      nextStatus: { remoteName: "upstream", remoteRefName: "release" },
      environmentId: "environment",
      cwd: "/repo",
    },
    {
      label: "the environment changes",
      nextStatus: {},
      environmentId: "other-environment",
      cwd: "/repo",
    },
    {
      label: "the selected repository changes",
      nextStatus: {},
      environmentId: "environment",
      cwd: "/repo/other",
    },
  ])(
    "cancels ordinary Create Pull Request approval when $label",
    async ({ nextStatus, environmentId, cwd }) => {
      statusQuery.data = {
        ...statusQuery.data,
        hasPrimaryRemote: true,
        hasUpstream: true,
        hasWorkingTreeChanges: false,
        isDefaultRef: false,
        pr: null,
        refName: "feature/reviewed",
        headCommit: "a".repeat(40),
        remoteName: "origin",
        remoteRefName: "feature/reviewed",
        sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      };
      const host = document.createElement("div");
      const target = document.createElement("div");
      document.body.append(host, target);
      const root = createRoot(host);
      roots.push(root);

      await render(root, target);
      await clickButton("Create Pull Request");
      expect(document.body.textContent).toContain("Repository /repo, branch feature/reviewed");

      statusQuery.data = { ...statusQuery.data, ...nextStatus };
      await render(root, target, environmentId, cwd);

      expect(
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Continue",
        ),
      ).toBe(false);
      expect(gitActionRun).not.toHaveBeenCalled();
    },
  );

  it("runs the exact ordinary Create Pull Request action it presented", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      isDefaultRef: false,
      pr: null,
      refName: "feature/reviewed",
      headCommit: "a".repeat(40),
      remoteName: "origin",
      remoteRefName: "feature/reviewed",
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    await clickButton("Create Pull Request");
    expect(document.body.textContent).toContain("Confirm Git action");
    await clickButton("Continue");

    expect(gitActionRun).toHaveBeenCalledWith(expect.objectContaining({ action: "create_pr" }));
  });

  it.each([
    {
      label: "the reviewed source ref and head change",
      nextStatus: { refName: "feature/other", headCommit: "b".repeat(40) },
      environmentId: "environment",
      cwd: "/repo",
    },
    {
      label: "the environment changes",
      nextStatus: {},
      environmentId: "other-environment",
      cwd: "/repo",
    },
    {
      label: "the selected repository changes",
      nextStatus: {},
      environmentId: "environment",
      cwd: "/repo/other",
    },
  ])(
    "cancels publication and prevents its retained submit when $label",
    async ({ nextStatus, environmentId, cwd }) => {
      statusQuery.data = {
        ...statusQuery.data,
        hasPrimaryRemote: false,
        hasUpstream: false,
        hasWorkingTreeChanges: false,
        isDefaultRef: false,
        pr: null,
        refName: "feature/reviewed",
        headCommit: "a".repeat(40),
      };
      const host = document.createElement("div");
      const target = document.createElement("div");
      document.body.append(host, target);
      const root = createRoot(host);
      roots.push(root);

      await render(root, target);
      await clickButton("Publish repository...");
      await clickButton("Next");
      await typeInput(
        document.querySelector<HTMLInputElement>("#publish-repository-path")!,
        "octo/reviewed-target",
      );

      statusQuery.data = { ...statusQuery.data, ...nextStatus };
      await render(root, target, environmentId, cwd);

      expect(document.querySelector("#publish-repository-path")).toBeNull();
      expect(publishRepositoryRun).not.toHaveBeenCalled();
    },
  );

  it("keeps Fetch usable from loaded remote identity while a mutation snapshot is incomplete", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      hasPrimaryRemote: true,
      hasUpstream: true,
      hasWorkingTreeChanges: false,
      aheadCount: 1,
    };
    delete (statusQuery.data as Record<string, unknown>).indexTree;
    workspaceDiscoverRun.mockResolvedValue({
      _tag: "Success",
      value: {
        repositories: [{ rootPath: "/repo", capabilities: { actions: ["fetch", "push"] } }],
      },
    });
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    const fetches = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent === "Fetch",
    );
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((button) => !button.disabled)).toBe(true);
    await act(async () => fetches[0]?.click());
    expect(workspaceRunActionRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/repo", action: "fetch", confirm: false },
    });
  });

  it("disables a retry whose reviewed mutation snapshot is no longer available", async () => {
    workspaceProgress.value = {
      isRunning: false,
      currentStep: null,
      completed: ["commit"],
      commitSha: "abc123",
      continuation: { action: "push", remoteName: "origin", refName: "target" },
    };
    const next = { ...statusQuery.data, hasPrimaryRemote: true, hasUpstream: true } as Record<
      string,
      unknown
    >;
    delete next.indexTree;
    statusQuery.data = next as VcsStatusResult;
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry push after abc123",
    );
    expect(retry?.disabled).toBe(true);
    expect(retry?.getAttribute("title")).toBe(
      "Repository index status is incomplete. Refresh and try again.",
    );
  });

  it("keeps Open and Refresh Pull Request usable from loaded PR identity while mutations are unavailable", async () => {
    projects.current = [
      {
        id: "project",
        environmentId: "environment",
        workspaceRoot: "/repo",
        repositoryIdentity: { provider: "github", displayName: "octo/repository" },
      },
    ];
    const next = {
      ...statusQuery.data,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      pr: {
        number: 7,
        title: "Ship it",
        url: "https://github.com/octo/repository/pull/7",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    } as Record<string, unknown>;
    delete next.indexTree;
    statusQuery.data = next as VcsStatusResult;
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);

    await render(root, target);
    const actions = [...document.querySelectorAll("button")].filter(
      (button) =>
        button.textContent === "Open Pull Request" || button.textContent === "Refresh Pull Request",
    );
    expect(actions).toHaveLength(2);
    expect(actions.every((button) => !button.disabled)).toBe(true);
    await clickButton("Refresh Pull Request");
    expect(pullRequestInvalidateRun).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        reference: {
          projectId: "project",
          repositoryRoot: "/repo",
          repository: "octo/repository",
          number: 7,
        },
      },
    });
  });
});
