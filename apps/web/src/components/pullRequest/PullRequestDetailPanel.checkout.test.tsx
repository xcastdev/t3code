/* @vitest-environment happy-dom */

import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const atoms = vi.hoisted(() => ({ prepare: Symbol("prepare-pull-request-thread") }));
const preparePullRequestThread = vi.hoisted(() => vi.fn());
const providerRun = vi.hoisted(() => vi.fn().mockResolvedValue({ _tag: "Success", value: {} }));
const newThread = vi.hoisted(() => vi.fn());
const commentComposer = vi.hoisted(() => ({
  onComment: null as ((body: string) => Promise<boolean>) | null,
  onCommentAction: null as
    | ((body: string, action: "close" | "reopen") => Promise<{ readonly commentPosted: boolean }>)
    | null,
}));
const atomValue = vi.hoisted(() => ({
  environment: { capabilities: { sourceControlWorkspace: true } },
  error: null,
  isRunning: false,
  operation: null,
}));
const projectState = vi.hoisted(() => ({
  projects: [] as object[],
  environments: [] as object[],
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => atomValue }));
vi.mock("~/state/git", () => ({ gitEnvironment: { preparePullRequestThread: atoms.prepare } }));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: Symbol("keybindings"),
  serverEnvironment: { configValueAtom: () => Symbol("server-config") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.prepare ? preparePullRequestThread : providerRun,
}));
vi.mock("~/state/vcs", () => ({
  vcsActionManager: {
    resetError: vi.fn(),
    stateAtom: () => Symbol("action-state"),
    track: (_registry: unknown, _scope: unknown, _action: unknown, execute: () => unknown) =>
      execute(),
  },
  vcsEnvironment: { listRefs: () => null, status: () => ({ kind: "status" }) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { kind?: string } | null) => ({
    data:
      target?.kind === "detail"
        ? detailForQuery
        : target?.kind === "activity"
          ? activity
          : target?.kind === "status"
            ? localStatusForQuery
            : null,
    error: target?.kind === "detail" ? detailQueryState.error : null,
    isPending: target?.kind === "detail" ? detailQueryState.isPending : false,
    isSuccess: target?.kind === "detail" ? detailQueryState.isSuccess : true,
    isFetching: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    detail: () => ({ kind: "detail" }),
    activity: () => ({ kind: "activity" }),
    invalidate: Symbol("invalidate"),
    runAction: Symbol("run-action"),
    comment: Symbol("comment"),
    update: Symbol("update"),
  },
  usePullRequestTurnRefresh: () => null,
  useSharedPullRequestSummary: (_environmentId: unknown, _reference: unknown, current: unknown) =>
    current,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => projectState.projects,
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: projectState.environments }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/state/usePullRequestStack", () => ({
  usePullRequestStack: () => ({ data: null, refresh: vi.fn() }),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: () => undefined,
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuItem: (props: React.ComponentProps<"button">) => <button {...props} />,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuRadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuRadioItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuSeparator: () => null,
  MenuShortcut: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));
vi.mock("./PullRequestSummaryTab", () => ({ PullRequestSummaryTab: () => <div /> }));
vi.mock("./PullRequestTimelineTab", () => ({ PullRequestTimelineTab: () => <div /> }));
vi.mock("./PullRequestCommentComposer", () => ({
  PullRequestCommentComposer: (props: {
    onComment: (body: string) => Promise<boolean>;
    onCommentAction: (
      body: string,
      action: "close" | "reopen",
    ) => Promise<{ readonly commentPosted: boolean }>;
  }) => {
    commentComposer.onComment = props.onComment;
    commentComposer.onCommentAction = props.onCommentAction;
    return null;
  },
}));
vi.mock("./PullRequestThreadLinks", () => ({ PullRequestThreadLinks: () => null }));
vi.mock("./PullRequestStackMenu", () => ({ PullRequestStackMenu: () => null }));
vi.mock("../ui/alert-dialog", () => {
  const Wrap = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) =>
      open ? (
        <div>
          <button onClick={() => onOpenChange(false)}>Dismiss confirmation</button>
          {children}
        </div>
      ) : null,
    AlertDialogPopup: Wrap,
    AlertDialogHeader: Wrap,
    AlertDialogTitle: Wrap,
    AlertDialogDescription: Wrap,
    AlertDialogFooter: Wrap,
    AlertDialogClose: Wrap,
  };
});

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const alternateEnvironmentId = EnvironmentId.make("alternate-environment");
const alternateProjectId = ProjectId.make("alternate-project");
const activity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

const detail: PullRequestDetailView = {
  provider: "github",
  projectId,
  projectTitle: "Project",
  workspaceRoot: "/repo",
  repository: "owner/repo",
  number: 7,
  title: "Scoped pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/7",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature/scoped",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: false,
    comment: false,
    search: false,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};
let detailForQuery = detail;
let detailQueryState: { isSuccess: boolean; isPending: boolean; error: Error | null } = {
  isSuccess: true,
  isPending: false,
  error: null,
};
const localStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/scoped",
  headCommit: "0123456789abcdef",
  indexTree: "fedcba9876543210",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
let localStatusForQuery: typeof localStatus | null = localStatus;

let renderer: ReactTestRenderer;

const renderedText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : renderedText(child))).join("");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preparePullRequestThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature/scoped", worktreePath: "/repo/.t3/worktrees/scoped" },
  });
  newThread.mockReset().mockResolvedValue({ threadId: "checkout-thread" });
  providerRun.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  detailForQuery = detail;
  detailQueryState = { isSuccess: true, isPending: false, error: null };
  localStatusForQuery = localStatus;
  projectState.projects = [];
  projectState.environments = [];
  commentComposer.onComment = null;
  commentComposer.onCommentAction = null;
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("PullRequestDetailPanel checkout scope", () => {
  it.each([
    ["an explicit outer repository root", "/repo", "/repo", "https://github.com/outer/repo/pull/7"],
    [
      "an explicit nested repository root",
      "/repo/packages/api",
      "/repo/packages/api",
      "https://github.com/nested/api/pull/7",
    ],
    ["an omitted repository root", undefined, "/repo", "https://github.com/legacy/repo/pull/7"],
  ])(
    "sends %s through its real checkout action",
    async (_name, repositoryRoot, cwd, referenceUrl) => {
      const reference = {
        projectId,
        repository: "owner/repo",
        number: 7,
        ...(repositoryRoot ? { repositoryRoot } : {}),
      };
      const scopedDetail = { ...detail, workspaceRoot: cwd, url: referenceUrl };
      detailForQuery = scopedDetail;

      await act(async () => {
        renderer = create(
          <PullRequestDetailPanel
            context="page"
            environmentId={environmentId}
            getShortcutContext={() => ({
              terminalFocus: false,
              terminalOpen: false,
              previewFocus: false,
              previewOpen: false,
            })}
            reference={reference}
            shortcutsEnabled={false}
          />,
        );
      });
      const worktree = renderer.root
        .findAllByType("button")
        .find((button) =>
          button
            .findAllByType("span")
            .some((span) => span.children.includes("In a separate worktree")),
        );
      expect(worktree).toBeDefined();
      expect(
        renderer.root
          .findAllByType("button")
          .find((button) => renderedText(button).includes("Environment B")),
      ).toBeUndefined();

      await act(async () => {
        worktree!.props.onClick();
        await Promise.resolve();
      });

      expect(preparePullRequestThread).toHaveBeenCalledWith({
        environmentId,
        input: {
          cwd,
          reference: referenceUrl,
          mode: "worktree",
          threadId: "checkout-thread",
        },
      });
    },
  );

  it("keeps an explicitly selected nested repository on this environment when another environment has only the outer project", async () => {
    projectState.projects = [
      {
        id: projectId,
        environmentId,
        workspaceRoot: "/repo",
        repositoryIdentity: { canonicalKey: "github.com/acme/outer" },
      },
      {
        id: alternateProjectId,
        environmentId: alternateEnvironmentId,
        workspaceRoot: "/other/repo",
        repositoryIdentity: { canonicalKey: "github.com/acme/outer" },
      },
    ];
    projectState.environments = [
      { environmentId, label: "Environment A", serverConfig: null },
      { environmentId: alternateEnvironmentId, label: "Environment B", serverConfig: null },
    ];
    const reference = {
      projectId,
      repository: "acme/api",
      number: 7,
      repositoryRoot: "/repo/packages/api",
    };
    detailForQuery = {
      ...detail,
      workspaceRoot: "/repo/packages/api",
      repository: "acme/api",
      url: "https://github.com/acme/api/pull/7",
    };

    await act(async () => {
      renderer = create(
        <PullRequestDetailPanel
          context="page"
          environmentId={environmentId}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
          })}
          reference={reference}
          shortcutsEnabled={false}
        />,
      );
    });
    const worktree = renderer.root
      .findAllByType("button")
      .find((button) =>
        button
          .findAllByType("span")
          .some((span) => span.children.includes("In a separate worktree")),
      );
    expect(worktree).toBeDefined();

    await act(async () => {
      worktree!.props.onClick();
      await Promise.resolve();
    });

    expect(preparePullRequestThread).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo/packages/api",
        reference: "https://github.com/acme/api/pull/7",
        mode: "worktree",
        threadId: "checkout-thread",
      },
    });
  });
});

describe("PullRequestDetailPanel mutation approval scope", () => {
  const panel = (number = 7) => (
    <PullRequestDetailPanel
      context="page"
      environmentId={environmentId}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
      })}
      reference={{ projectId, repository: "owner/repo", repositoryRoot: "/repo", number }}
      shortcutsEnabled={false}
    />
  );
  const buttonWithText = (text: string) =>
    renderer.root.findAllByType("button").find((button) => renderedText(button) === text);

  it("revokes a retained Close approval when the mounted PR target changes", async () => {
    detailForQuery = {
      ...detail,
      capabilities: { ...detail.capabilities, actions: ["close"] },
      viewerPermissions: { ...detail.viewerPermissions, actions: ["close"] },
    };
    await act(async () => {
      renderer = create(panel());
    });
    const close = buttonWithText("Close pull request");
    expect(close).toBeDefined();
    await act(async () => close?.props.onClick());
    const confirm = buttonWithText("Close");
    expect(confirm).toBeDefined();
    const onConfirm = confirm?.props.onClick as (() => void) | undefined;

    detailForQuery = {
      ...detailForQuery,
      number: 8,
      url: "https://github.com/owner/repo/pull/8",
    };
    await act(async () => {
      renderer.update(panel(8));
    });
    // Keep the old detached Confirm event as the browser can deliver it after React has closed
    // the dialog. It may not call the provider for whichever PR now occupies the panel.
    await act(async () => onConfirm?.());
    expect(providerRun).not.toHaveBeenCalled();
  });

  it("requires a fresh Reopen approval and keeps cancellation mutation-free", async () => {
    detailForQuery = {
      ...detail,
      state: "closed",
      capabilities: { ...detail.capabilities, actions: ["reopen"] },
      viewerPermissions: { ...detail.viewerPermissions, actions: ["reopen"] },
    };
    await act(async () => {
      renderer = create(panel());
    });
    const reopen = buttonWithText("Reopen pull request");
    expect(reopen).toBeDefined();
    await act(async () => reopen?.props.onClick());
    expect(providerRun).not.toHaveBeenCalled();
    await act(async () => buttonWithText("Dismiss confirmation")?.props.onClick());
    expect(providerRun).not.toHaveBeenCalled();

    await act(async () => reopen?.props.onClick());
    await act(async () => buttonWithText("Reopen")?.props.onClick());
    expect(providerRun).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        repository: "owner/repo",
        repositoryRoot: "/repo",
        number: 7,
        action: "reopen",
      },
    });
  });

  it("revokes a retained Merge approval when its reviewed provider snapshot changes", async () => {
    detailForQuery = {
      ...detail,
      capabilities: { ...detail.capabilities, actions: ["merge"], mergeMethods: ["squash"] },
      mergeCapabilities: { merge: false, squash: true, rebase: false },
      viewerPermissions: { ...detail.viewerPermissions, actions: ["merge"] },
    };
    await act(async () => {
      renderer = create(panel());
    });
    const merge = buttonWithText("Squash and merge");
    expect(merge).toBeDefined();
    await act(async () => merge?.props.onClick());
    const confirm = renderer.root
      .findAllByType("button")
      .findLast((button) => renderedText(button) === "Squash and merge");
    expect(confirm).toBeDefined();
    const onConfirm = confirm?.props.onClick as (() => void) | undefined;

    detailForQuery = { ...detailForQuery, headBranch: "feature/moved" };
    await act(async () => {
      renderer.update(panel());
    });
    await act(async () => onConfirm?.());
    expect(providerRun).not.toHaveBeenCalled();
  });

  it("revokes detail approval while its current query is pending or failed, and after unmount", async () => {
    detailForQuery = {
      ...detail,
      capabilities: { ...detail.capabilities, actions: ["close"] },
      viewerPermissions: { ...detail.viewerPermissions, actions: ["close"] },
    };
    await act(async () => {
      renderer = create(panel());
    });
    await act(async () => buttonWithText("Close pull request")?.props.onClick());
    const pendingConfirm = buttonWithText("Close")?.props.onClick as (() => void) | undefined;
    detailQueryState = { isSuccess: false, isPending: true, error: null };
    await act(async () => renderer.update(panel()));
    await act(async () => pendingConfirm?.());
    expect(providerRun).not.toHaveBeenCalled();

    detailQueryState = { isSuccess: true, isPending: false, error: null };
    await act(async () => renderer.update(panel()));
    await act(async () => buttonWithText("Close pull request")?.props.onClick());
    const failedConfirm = buttonWithText("Close")?.props.onClick as (() => void) | undefined;
    detailQueryState = { isSuccess: true, isPending: false, error: new Error("offline") };
    await act(async () => renderer.update(panel()));
    await act(async () => failedConfirm?.());
    expect(providerRun).not.toHaveBeenCalled();

    detailQueryState = { isSuccess: true, isPending: false, error: null };
    await act(async () => renderer.update(panel()));
    await act(async () => buttonWithText("Close pull request")?.props.onClick());
    const detachedConfirm = buttonWithText("Close")?.props.onClick as (() => void) | undefined;
    await act(async () => renderer.unmount());
    await act(async () => detachedConfirm?.());
    expect(providerRun).not.toHaveBeenCalled();
  });

  it("requires confirmation for ready and identifies the reviewed repository and source", async () => {
    detailForQuery = {
      ...detail,
      isDraft: true,
      capabilities: { ...detail.capabilities, actions: ["ready"] },
      viewerPermissions: { ...detail.viewerPermissions, actions: ["ready"] },
    };
    await act(async () => {
      renderer = create(panel());
    });
    await act(async () => buttonWithText("Ready for review")?.props.onClick());
    expect(providerRun).not.toHaveBeenCalled();
    expect(renderedText(renderer.root)).toContain("owner/repo (/repo)");
    expect(renderedText(renderer.root)).toContain("feature/scoped at 0123456789abcdef");
    await act(async () => buttonWithText("Mark ready")?.props.onClick());
    expect(providerRun).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        repository: "owner/repo",
        repositoryRoot: "/repo",
        number: 7,
        action: "ready",
      },
    });
  });

  it("never performs the approved close after its comment posts against a changed PR snapshot", async () => {
    detailForQuery = {
      ...detail,
      capabilities: { ...detail.capabilities, comment: true, actions: ["close"] },
      viewerPermissions: { ...detail.viewerPermissions, comment: true, actions: ["close"] },
    };
    let resolveComment: ((value: { _tag: "Success"; value: object }) => void) | null = null;
    providerRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveComment = resolve;
        }),
    );
    await act(async () => {
      renderer = create(panel());
    });
    expect(commentComposer.onCommentAction).not.toBeNull();
    let result: Promise<{ readonly commentPosted: boolean }> | null = null;
    await act(async () => {
      result = commentComposer.onCommentAction?.("A durable comment", "close") ?? null;
    });
    await act(async () => buttonWithText("Close")?.props.onClick());
    expect(providerRun).toHaveBeenCalledTimes(1);

    detailForQuery = { ...detailForQuery, headBranch: "feature/moved-after-comment" };
    await act(async () => renderer.update(panel()));
    await act(async () => resolveComment?.({ _tag: "Success", value: {} }));
    await expect(result).resolves.toEqual({ commentPosted: true });
    expect(providerRun).toHaveBeenCalledTimes(1);
  });
});
