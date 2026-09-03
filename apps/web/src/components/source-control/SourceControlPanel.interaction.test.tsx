import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  handleSourceControlCommitFailure,
  submitSourceControlCommit,
} from "./sourceControlPanel.logic";

describe("SourceControlPanel commit interaction", () => {
  it("sends the reviewed tokens, retains the draft, and refreshes both views on stale state", async () => {
    const commit = vi.fn(async () => ({
      _tag: "Failure" as const,
      cause: Cause.fail({ code: "stale_git_state" }),
    }));
    const refreshStatus = vi.fn();
    const refreshDiff = vi.fn();
    const setError = vi.fn();
    const commitInput = buildSourceControlCommitInput({
      cwd: "/repo",
      message: "keep this draft",
      headCommit: "head-before-refresh",
      indexTree: "index-before-refresh",
      refName: "feature/reviewed",
      confirmDefaultRef: false,
    });

    const result = await submitSourceControlCommit({
      commit,
      commitInput,
      onStale: (failure) =>
        handleSourceControlCommitFailure(failure, {
          refreshStatus,
          refreshDiff,
          setError,
        }),
    });

    expect(commit).toHaveBeenCalledWith({
      cwd: "/repo",
      message: "keep this draft",
      precondition: {
        expectedHeadCommit: "head-before-refresh",
        expectedIndexTree: "index-before-refresh",
        expectedRefName: "feature/reviewed",
      },
    });
    expect(result._tag).toBe("Failure");
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshDiff).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(
      "Repository changed; review the staged changes and try again.",
    );
  });

  it("does not send default-ref confirmation before the user confirms", () => {
    expect(
      buildSourceControlCommitInput({
        cwd: "/repo",
        message: "not yet confirmed",
        headCommit: "head-1",
        indexTree: "tree-1",
        confirmDefaultRef: false,
      }),
    ).not.toHaveProperty("confirmDefaultRef");
  });

  it("waits for the refreshed reviewed diff before sending a commit", async () => {
    const commit = vi.fn(async () => ({ _tag: "Success" as const, value: undefined }));
    const statusBeforeRefresh = { headCommit: "head-1", indexTree: "tree-1" };
    const statusAfterRefresh = { headCommit: "head-2", indexTree: "tree-2" };
    let diffReviewReady = false;

    const clickCommit = async (status: typeof statusAfterRefresh) => {
      if (
        !canSubmitSourceControlCommit({
          workflowAvailable: true,
          stagedCount: 1,
          message: "review after refresh",
          commitPending: false,
          diffReviewReady,
          reviewedStateAvailable: status.headCommit !== undefined && status.indexTree !== undefined,
        })
      ) {
        return;
      }
      await submitSourceControlCommit({
        commit,
        commitInput: buildSourceControlCommitInput({
          cwd: "/repo",
          message: "review after refresh",
          ...status,
          refName: "feature/reviewed",
          confirmDefaultRef: false,
        }),
        onStale: () => undefined,
      });
    };

    await clickCommit(statusBeforeRefresh);
    expect(commit).not.toHaveBeenCalled();

    diffReviewReady = true;
    await clickCommit(statusAfterRefresh);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({
      cwd: "/repo",
      message: "review after refresh",
      precondition: {
        expectedHeadCommit: "head-2",
        expectedIndexTree: "tree-2",
        expectedRefName: "feature/reviewed",
      },
    });
  });
});
