import { describe, expect, it } from "vite-plus/test";
import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  fileAction,
  gitIndexWorkflowAvailability,
  sourceControlFileStatusLabel,
} from "./sourceControlPanel.logic.ts";

describe("merge-only guarded commits", () => {
  it("allows a reviewed pending merge without deriving staged state from rows", () => {
    expect(
      canSubmitSourceControlCommit({
        workflowAvailable: true,
        stagedCount: 0,
        message: "Merge branch",
        reviewedStateAvailable: true,
        hasReviewedBranch: true,
        hasReviewedMerge: true,
      }),
    ).toBe(true);
  });
});

describe("source control panel logic", () => {
  it("keeps index controls unavailable for older servers", () => {
    expect(gitIndexWorkflowAvailability(false, false)).toBe("loading");
    expect(gitIndexWorkflowAvailability(true, false)).toBe("unsupported");
    expect(fileAction(undefined)).toBeNull();
  });

  it("keeps both index operations available for a mixed file but leaves conflicts to Git", () => {
    expect(fileAction("both")).toEqual(["unstage", "stage"]);
    expect(fileAction("conflicted")).toEqual([]);
  });

  it("builds a guarded index-only commit from the reviewed status", () => {
    expect(
      buildSourceControlCommitInput({
        cwd: "/repo",
        message: " fix: index ",
        headCommit: "head",
        indexTree: "tree",
        refName: "feature/index",
        pendingMergeHeads: [],
        confirmDefaultRef: false,
      }),
    ).toEqual({
      cwd: "/repo",
      message: "fix: index",
      precondition: {
        expectedHeadCommit: "head",
        expectedIndexTree: "tree",
        expectedRefName: "feature/index",
        expectedMergeHeads: [],
      },
    });
    expect(sourceControlFileStatusLabel("both")).toBe("Staged + modified");
  });
});
