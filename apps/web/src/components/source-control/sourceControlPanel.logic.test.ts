import { describe, expect, it } from "vite-plus/test";

import {
  canAttemptDirtyBranchSwitch,
  defaultSourceControlDiffComparison,
  fileActions,
  gitIndexWorkflowAvailability,
  isFileStaged,
  needsDirtyBranchConfirmation,
  pullRequestShortcutTarget,
  sourceControlDiffComparisons,
} from "./sourceControlPanel.logic";

describe("source control panel logic", () => {
  it("does not use Git index workflow RPCs until support is advertised", () => {
    expect(gitIndexWorkflowAvailability(false, false)).toBe("loading");
    expect(gitIndexWorkflowAvailability(true, false)).toBe("unsupported");
    expect(gitIndexWorkflowAvailability(true, true)).toBe("available");
  });

  it("blocks branch switching until status is known", () => {
    expect(canAttemptDirtyBranchSwitch(undefined)).toBe(false);
    expect(canAttemptDirtyBranchSwitch(false)).toBe(true);
    expect(canAttemptDirtyBranchSwitch(true)).toBe(true);
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

  it("counts staged index entries without treating conflicts as committable", () => {
    expect(isFileStaged({ indexStatus: "staged" })).toBe(true);
    expect(isFileStaged({ indexStatus: "both" })).toBe(true);
    expect(isFileStaged({ indexStatus: "conflicted" })).toBe(false);
    expect(isFileStaged({ indexStatus: "unstaged" })).toBe(false);
  });

  it("requires confirmation before switching a dirty tree", () => {
    expect(needsDirtyBranchConfirmation(true)).toBe(true);
    expect(needsDirtyBranchConfirmation(false)).toBe(false);
  });

  it("opens Source Control on Pull requests from the bottom-left shortcut", () => {
    expect(pullRequestShortcutTarget()).toEqual({
      kind: "source-control",
      view: "pull-requests",
    });
  });
});
