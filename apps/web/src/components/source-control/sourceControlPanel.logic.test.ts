import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  defaultSourceControlDiffComparison,
  fileActions,
  getGitMutationRejectionCode,
  gitIndexWorkflowAvailability,
  handleSourceControlCommitFailure,
  isFileStaged,
  pullRequestShortcutTarget,
  runAuthoritativeDirtyBranchMutation,
  sourceControlDiffRenderModel,
  sourceControlDiffState,
  sourceControlDiffComparisons,
} from "./sourceControlPanel.logic";

describe("source control panel logic", () => {
  it("does not use Git index workflow RPCs until support is advertised", () => {
    expect(gitIndexWorkflowAvailability(false, false)).toBe("loading");
    expect(gitIndexWorkflowAvailability(true, false)).toBe("unsupported");
    expect(gitIndexWorkflowAvailability(true, true)).toBe("available");
  });

  it("offers both reverse operations for staged and modified files", () => {
    expect(fileActions({ indexStatus: "unstaged" }).map((action) => action.kind)).toEqual([
      "stage",
    ]);
    expect(fileActions({ indexStatus: "staged" }).map((action) => action.kind)).toEqual([
      "unstage",
    ]);
    expect(fileActions({ indexStatus: "both" }).map((action) => action.kind)).toEqual([
      "unstage",
      "stage",
    ]);
  });

  it("keeps commit unavailable while the reviewed diff is refreshing", () => {
    const commitState = {
      workflowAvailable: true,
      stagedCount: 1,
      message: "reviewed change",
      commitPending: false,
      diffReviewReady: false,
      reviewedStateAvailable: true,
    };

    expect(canSubmitSourceControlCommit(commitState)).toBe(false);
    expect(canSubmitSourceControlCommit({ ...commitState, diffReviewReady: true })).toBe(true);
    expect(
      canSubmitSourceControlCommit({
        ...commitState,
        diffReviewReady: true,
        reviewedStateAvailable: false,
      }),
    ).toBe(false);
  });

  it("defaults commit-ready files to the index diff", () => {
    expect(defaultSourceControlDiffComparison({ indexStatus: "staged" })).toBe("index");
    expect(defaultSourceControlDiffComparison({ indexStatus: "both" })).toBe("index");
    expect(defaultSourceControlDiffComparison({ indexStatus: "unstaged" })).toBe("head");
    expect(defaultSourceControlDiffComparison({ indexStatus: "untracked" })).toBe("head");
    expect(sourceControlDiffComparisons({ indexStatus: "both" })).toEqual(["index", "head"]);
  });

  it("does not offer index mutations for conflicts or legacy status events", () => {
    expect(fileActions({ indexStatus: "conflicted" })).toEqual([
      {
        kind: "unavailable",
        label: "Unavailable",
        disabled: true,
        reason: "Conflict resolution is not available in Source Control yet.",
      },
    ]);
    expect(fileActions({})).toEqual([
      {
        kind: "unavailable",
        label: "Unavailable",
        disabled: true,
        reason: "This server does not report index state. Update T3 Code to enable staging.",
      },
    ]);
  });

  it("distinguishes loading, unsupported, error, empty, and ready diff states", () => {
    const base = {
      capabilityKnown: true,
      supported: true,
      pending: false,
      error: null,
      diff: "diff --git a/a.txt b/a.txt",
      truncated: false,
    };

    expect(sourceControlDiffState({ ...base, capabilityKnown: false })).toEqual({
      kind: "loading",
    });
    expect(sourceControlDiffState({ ...base, supported: false })).toEqual({
      kind: "unsupported",
    });
    expect(sourceControlDiffState({ ...base, pending: true })).toEqual({ kind: "loading" });
    expect(sourceControlDiffState({ ...base, error: "request failed" })).toEqual({
      kind: "error",
      message: "request failed",
    });
    expect(sourceControlDiffState({ ...base, diff: "" })).toEqual({ kind: "empty" });
    expect(sourceControlDiffState({ ...base, diff: "", truncated: true })).toEqual({
      kind: "ready",
      diff: "",
      truncated: true,
    });
    expect(sourceControlDiffState(base)).toEqual({
      kind: "ready",
      diff: base.diff,
      truncated: false,
    });
  });

  it("groups contiguous diff lines into bounded colored render runs", () => {
    const model = sourceControlDiffRenderModel(
      ["@@ -1 +1 @@", " context", "+added", "+added again", "-removed", "context"].join("\n") +
        "\n",
    );

    expect(model).toEqual([
      { tone: "hunk", text: "@@ -1 +1 @@\n", lineCount: 1 },
      { tone: "context", text: " context\n", lineCount: 1 },
      { tone: "addition", text: "+added\n+added again\n", lineCount: 2 },
      { tone: "deletion", text: "-removed\n", lineCount: 1 },
      { tone: "context", text: "context\n", lineCount: 1 },
    ]);

    const largeModel = sourceControlDiffRenderModel(`${"+line\n".repeat(4_000)}`);
    expect(largeModel).toHaveLength(1);
    expect(largeModel[0]?.lineCount).toBe(4_000);
  });

  it("counts staged index entries without treating conflicts as committable", () => {
    expect(isFileStaged({ indexStatus: "staged" })).toBe(true);
    expect(isFileStaged({ indexStatus: "both" })).toBe(true);
    expect(isFileStaged({ indexStatus: "conflicted" })).toBe(false);
    expect(isFileStaged({ indexStatus: "unstaged" })).toBe(false);
  });

  it("builds a commit request from the reviewed repository state", () => {
    expect(
      buildSourceControlCommitInput({
        cwd: "/repo",
        message: "reviewed change",
        headCommit: "head-1",
        indexTree: "tree-1",
        refName: "feature/workflow",
        confirmDefaultRef: false,
      }),
    ).toEqual({
      cwd: "/repo",
      message: "reviewed change",
      precondition: {
        expectedHeadCommit: "head-1",
        expectedIndexTree: "tree-1",
        expectedRefName: "feature/workflow",
      },
    });
    expect(
      buildSourceControlCommitInput({
        cwd: "/repo",
        message: "reviewed change",
        headCommit: "head-1",
        indexTree: "tree-1",
        refName: "feature/workflow",
        confirmDefaultRef: true,
      }),
    ).toMatchObject({ confirmDefaultRef: true });
  });

  it("recognizes typed Git mutation rejections without trusting message text", () => {
    const result = { cause: Cause.fail({ code: "stale_git_state", detail: "changed" }) };

    expect(getGitMutationRejectionCode(result)).toBe("stale_git_state");
    expect(
      getGitMutationRejectionCode({ cause: Cause.fail(new Error("stale_git_state")) }),
    ).toBeUndefined();
  });

  it("refreshes the reviewed views and retains the draft after a stale commit", () => {
    const refreshStatus = vi.fn();
    const refreshDiff = vi.fn();
    const setError = vi.fn();

    const handled = handleSourceControlCommitFailure(
      { cause: Cause.fail({ code: "stale_git_state" }) },
      { refreshStatus, refreshDiff, setError },
    );

    expect(handled).toBe(true);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshDiff).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(
      "Repository changed; review the staged changes and try again.",
    );
  });

  it("uses the server dirty-tree rejection as the single retry boundary", async () => {
    const confirm = vi.fn(async () => true);
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "Failure" as const,
        cause: Cause.fail({ code: "dirty_worktree_confirmation_required" }),
      })
      .mockResolvedValueOnce({ _tag: "Success" as const, value: { refName: "feature" } });

    const result = await runAuthoritativeDirtyBranchMutation({
      hasWorkingTreeChanges: false,
      confirm,
      mutate,
    });

    expect(result).toEqual({ _tag: "Success", value: { refName: "feature" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenNthCalledWith(1, false);
    expect(mutate).toHaveBeenNthCalledWith(2, true);
  });

  it("opens Source Control on Pull requests from the bottom-left shortcut", () => {
    expect(pullRequestShortcutTarget()).toEqual({
      kind: "source-control",
      view: "pull-requests",
    });
  });
});
