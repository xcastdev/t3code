/* @vitest-environment happy-dom */

import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // Scope authorization must remain correct before React flushes its reset effect.
  return { ...actual, useEffect: () => undefined };
});

const commands = vi.hoisted(() => ({
  commit: vi.fn(),
  diff: vi.fn(),
  refresh: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
}));

const statusQuery = vi.hoisted(() => ({
  data: null as VcsStatusResult | null,
  isPending: false,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => statusQuery,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === vcsAtoms.commit) return commands.commit;
    if (command === vcsAtoms.diff) return commands.diff;
    if (command === vcsAtoms.refresh) return commands.refresh;
    if (command === vcsAtoms.stage) return commands.stage;
    return commands.unstage;
  },
}));

const vcsAtoms = vi.hoisted(() => ({
  commit: Symbol("commit"),
  diff: Symbol("diff"),
  refresh: Symbol("refresh"),
  stage: Symbol("stage"),
  status: Symbol("status"),
  unstage: Symbol("unstage"),
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    commitIndex: vcsAtoms.commit,
    getWorkingTreeDiff: vcsAtoms.diff,
    refreshStatus: vcsAtoms.refresh,
    stageFiles: vcsAtoms.stage,
    status: () => vcsAtoms.status,
    unstageFiles: vcsAtoms.unstage,
  },
}));

vi.mock("../BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: () => <div />,
}));
vi.mock("../pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => <div />,
}));
vi.mock("../pullRequest/PullRequestGhosts", () => ({
  PullRequestListGhost: () => <div />,
}));
vi.mock("../pullRequest/PullRequestRow", () => ({
  PullRequestRow: () => <div />,
}));
vi.mock("../pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => <div />,
}));
vi.mock("~/state/pullRequests", () => ({
  usePullRequestList: () => ({ data: null }),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & {
    size?: unknown;
    variant?: unknown;
  }) => <button {...props} />,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogClose: ({ render }: { render: React.ReactNode }) => render,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  handleSourceControlCommitFailure,
} from "./sourceControlPanel.logic.ts";
import { SourceControlPanel, type SourceControlPanelProps } from "./SourceControlPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const projectId = ProjectId.make("project");
const roots: Root[] = [];

const reviewedStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  localRevision: "head\\0index",
  headCommit: "head",
  indexTree: "index",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/file.ts", insertions: 2, deletions: 1, indexStatus: "both" }],
    insertions: 2,
    deletions: 1,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function panel(overrides: Partial<SourceControlPanelProps> = {}) {
  return (
    <SourceControlPanel
      cwd="/repo"
      environmentId={environmentId}
      envLocked={false}
      gitIndexWorkflowCapabilityKnown
      onViewChange={() => undefined}
      projectId={projectId}
      pullRequestsCapabilityKnown
      supportsGitIndexWorkflow
      supportsPullRequests={false}
      threadId={threadId}
      threadRef={{ environmentId, threadId }}
      view="changes"
      {...overrides}
    />
  );
}

async function renderPanel(overrides: Partial<SourceControlPanelProps> = {}): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(panel(overrides));
  });
  return root;
}

async function rerenderPanel(
  root: Root,
  overrides: Partial<SourceControlPanelProps>,
): Promise<void> {
  await act(async () => {
    root.render(panel(overrides));
  });
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(element).toBeDefined();
  return element!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function input(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  await act(async () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  statusQuery.data = reviewedStatus;
  commands.commit
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { commitSha: "commit" } });
  commands.diff.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { diff: "", truncated: false },
  });
  commands.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.stage.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.unstage.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SourceControlPanel guarded commit interaction", () => {
  it("keeps reviewed tokens and refreshes after a stale-state rejection", async () => {
    const refreshStatus = vi.fn();
    const setError = vi.fn();
    const input = buildSourceControlCommitInput({
      cwd: "/repo",
      message: "keep draft",
      headCommit: "head-before-refresh",
      indexTree: "tree-before-refresh",
      refName: "feature/reviewed",
      pendingMergeHeads: [],
      confirmDefaultRef: false,
    });
    expect(input.precondition).toEqual({
      expectedHeadCommit: "head-before-refresh",
      expectedIndexTree: "tree-before-refresh",
      expectedRefName: "feature/reviewed",
      expectedMergeHeads: [],
    });
    await expect(
      handleSourceControlCommitFailure(
        { cause: Cause.fail({ code: "stale_git_state" }) },
        { refreshStatus, setError },
      ),
    ).resolves.toBe(true);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(
      "Repository changed; review the staged changes and try again.",
    );
  });

  it("requires an index review before enabling a commit", () => {
    expect(
      canSubmitSourceControlCommit({
        workflowAvailable: true,
        stagedCount: 1,
        message: "commit",
        reviewedStateAvailable: false,
        hasReviewedBranch: true,
      }),
    ).toBe(false);
  });

  it("asks before committing to the default ref and only sends the confirmation after approval", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    await click(button("Commit staged changes"));

    expect(commands.commit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Commit to the default branch?");

    await click(button("Commit"));
    expect(commands.commit).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        message: "reviewed commit",
        confirmDefaultRef: true,
        precondition: {
          expectedHeadCommit: "head",
          expectedIndexTree: "index",
          expectedRefName: "main",
        },
      },
    });
  });

  it("reviews staged and unstaged versions of a mixed file against the captured index", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Unstaged changes"));

    expect(commands.diff).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/file.ts",
        comparison: "index",
        reviewedState: { headCommit: "head", indexTree: "index" },
      },
    });
    expect(commands.diff).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/file.ts",
        comparison: "worktree-index",
      },
    });
  });

  it("uses the untracked-file fallback instead of an empty index diff", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      workingTree: {
        files: [
          {
            path: "src/untracked.ts",
            insertions: 1,
            deletions: 0,
            indexStatus: "untracked",
          },
        ],
        insertions: 1,
        deletions: 0,
      },
    };
    await renderPanel();
    await click(button("Untracked changes"));

    expect(document.body.textContent).toContain("untracked vs empty");
    expect(commands.diff).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/untracked.ts",
        comparison: "worktree-index",
      },
    });
  });

  it("only enables commit after a successful staged review", async () => {
    await renderPanel();
    await click(button("Unstaged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    expect(button("Commit staged changes").disabled).toBe(true);

    await click(button("Staged changes"));
    expect(button("Commit staged changes").disabled).toBe(false);
  });

  it("keeps commit disabled while a staged review is pending and after it fails", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    await renderPanel();
    await click(button("Staged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    expect(button("Commit staged changes").disabled).toBe(true);

    pending.resolve({
      _tag: "Failure",
      cause: Cause.fail(new Error("diff failed")),
    });
    await settle();
    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("does not authorize a staged response cancelled before it settles", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Cancel review"));
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "reviewed commit");

    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("does not authorize a stale staged response after reviewing the working tree", async () => {
    const pending = deferred<unknown>();
    commands.diff
      .mockReset()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { diff: "working tree", truncated: false },
      });
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Unstaged changes"));
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "reviewed commit");

    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("drops review authorization and ignores in-flight responses after the review scope changes", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    const root = await renderPanel();
    await click(button("Staged changes"));
    const nextEnvironmentId = EnvironmentId.make("environment-2");
    const nextThreadId = ThreadId.make("thread-2");
    await rerenderPanel(root, {
      cwd: "/other-repo",
      environmentId: nextEnvironmentId,
      threadId: nextThreadId,
      threadRef: { environmentId: nextEnvironmentId, threadId: nextThreadId },
    });
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "new scope commit");

    expect(button("Commit staged changes").disabled).toBe(true);
    expect(commands.commit).not.toHaveBeenCalled();
  });
});
