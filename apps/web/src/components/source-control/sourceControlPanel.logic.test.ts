import { describe, expect, it } from "vite-plus/test";

import {
  canAttemptDirtyBranchSwitch,
  fileAction,
  gitIndexWorkflowAvailability,
  isFileStaged,
  needsDirtyBranchConfirmation,
  pullRequestShortcutTarget,
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

  it("shows stage and unstage actions from the index state", () => {
    expect(fileAction({ indexStatus: "unstaged" })).toMatchObject({ label: "Stage" });
    expect(fileAction({ indexStatus: "staged" })).toMatchObject({ label: "Unstage" });
    expect(fileAction({ indexStatus: "both" })).toMatchObject({ label: "Stage" });
  });

  it("does not offer index mutations for conflicts or legacy status events", () => {
    expect(fileAction({ indexStatus: "conflicted" })).toMatchObject({ disabled: true });
    expect(fileAction({})).toMatchObject({ disabled: true });
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
