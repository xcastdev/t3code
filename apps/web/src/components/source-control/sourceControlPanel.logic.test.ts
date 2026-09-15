import { describe, expect, it } from "vite-plus/test";
import {
  buildSourceControlCommitInput,
  fileAction,
  gitIndexWorkflowAvailability,
  sourceControlFileStatusLabel,
} from "./sourceControlPanel.logic.ts";

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
