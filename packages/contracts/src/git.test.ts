import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsStageFilesInput,
  VcsWorkingTreeDiffInput,
  VcsWorkingTreeDiffResult,
  GitCommitIndexInput,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeVcsStatus = Schema.decodeUnknownSync(VcsStatusResult);
const decodeVcsStatusStreamEvent = Schema.decodeUnknownSync(VcsStatusStreamEvent);
const decodeVcsStageFilesInput = Schema.decodeUnknownSync(VcsStageFilesInput);
const decodeVcsWorkingTreeDiffInput = Schema.decodeUnknownSync(VcsWorkingTreeDiffInput);
const decodeVcsWorkingTreeDiffResult = Schema.decodeUnknownSync(VcsWorkingTreeDiffResult);
const decodeGitCommitIndexInput = Schema.decodeUnknownSync(GitCommitIndexInput);

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});

describe("Git index and diff contracts", () => {
  it("preserves whitespace in Git path values", () => {
    const path = " report.txt ";
    const status = decodeVcsStatus({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: "main",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path, insertions: 1, deletions: 0, indexStatus: "unstaged" }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    });

    expect(status.workingTree.files[0]?.path).toBe(path);
    expect(decodeVcsStageFilesInput({ cwd: "/repo", paths: [path] }).paths).toEqual([path]);
    expect(decodeVcsWorkingTreeDiffInput({ cwd: "/repo", path, comparison: "head" }).path).toBe(
      path,
    );
  });

  it("rejects empty and NUL-containing Git path values", () => {
    expect(() => decodeVcsStageFilesInput({ cwd: "/repo", paths: [""] })).toThrow();
    expect(() =>
      decodeVcsWorkingTreeDiffInput({
        cwd: "/repo",
        path: "bad\u0000path.txt",
        comparison: "head",
      }),
    ).toThrow();
  });

  it("decodes a file with staged and unstaged changes", () => {
    const parsed = decodeVcsStatus({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: "feature/index",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "src/a.ts",
            insertions: 2,
            deletions: 1,
            indexStatus: "both",
          },
        ],
        insertions: 2,
        deletions: 1,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    });

    expect(parsed.workingTree.files[0]?.indexStatus).toBe("both");
  });

  it("decodes a legacy status event without index state", () => {
    const parsed = decodeVcsStatusStreamEvent({
      _tag: "localUpdated",
      local: {
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "README.md", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
      },
    });

    expect(parsed._tag).toBe("localUpdated");
    if (parsed._tag === "localUpdated") {
      expect(parsed.local.workingTree.files[0]?.indexStatus).toBeUndefined();
    }
  });

  it("requires at least one literal path for index mutations", () => {
    expect(() =>
      decodeVcsStageFilesInput({
        cwd: "/repo",
        paths: [],
      }),
    ).toThrow();
    expect(() =>
      decodeVcsStageFilesInput({
        cwd: "/repo",
        paths: ["src/a.ts"],
      }),
    ).not.toThrow();
  });

  it("decodes a bounded working-tree diff request and result", () => {
    const input = decodeVcsWorkingTreeDiffInput({
      cwd: "/repo",
      path: "src/a.ts",
      comparison: "index",
    });
    const result = decodeVcsWorkingTreeDiffResult({ diff: "@@ -1 +1 @@", truncated: false });

    expect(input.comparison).toBe("index");
    expect(result.truncated).toBe(false);
  });

  it("decodes an index-only commit request", () => {
    const parsed = decodeGitCommitIndexInput({ cwd: "/repo", message: "fix: stage it" });

    expect(parsed.message).toBe("fix: stage it");
  });
});
