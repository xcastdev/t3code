import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsWorkingTreeDiffInput,
  VcsWorkingTreePageInput,
  VcsWorkingTreePageResult,
  VcsStatusResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeWorkingTreeDiffInput = Schema.decodeUnknownSync(VcsWorkingTreeDiffInput);
const decodeWorkingTreePageInput = Schema.decodeUnknownSync(VcsWorkingTreePageInput);
const decodeWorkingTreePageResult = Schema.decodeUnknownSync(VcsWorkingTreePageResult);
const decodeStatus = Schema.decodeUnknownSync(VcsStatusResult);

describe("bounded working-tree status", () => {
  it("keeps legacy status payloads decodable while accepting bounded metadata", () => {
    const legacy = decodeStatus({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    expect(legacy.workingTree.totalCount).toBeUndefined();

    const page = decodeWorkingTreePageResult({
      snapshotId: "snapshot-1",
      files: [],
      nextCursor: null,
      totalCount: 0,
      stagedCount: 0,
      hasStagedChanges: false,
    });
    expect(page.snapshotId).toBe("snapshot-1");
  });

  it("requires a snapshot identity and nullable numeric cursor for page requests", () => {
    const page = decodeWorkingTreePageInput({
      cwd: "/repo",
      snapshotId: "snapshot-1",
      cursor: null,
      pageSize: 24,
    });
    expect(page.cursor).toBeNull();
    expect(() =>
      decodeWorkingTreePageInput({ cwd: "/repo", snapshotId: "snapshot-1", cursor: -1 }),
    ).toThrow();
  });
});

describe("VcsWorkingTreeDiffInput", () => {
  it("accepts an explicit working-tree-versus-index comparison", () => {
    expect(
      decodeWorkingTreeDiffInput({
        cwd: "/repo",
        path: "src/file.ts",
        comparison: "worktree-index",
      }),
    ).toMatchObject({ comparison: "worktree-index" });
  });

  it("accepts a repository-wide index review for a pending merge", () => {
    expect(
      decodeWorkingTreeDiffInput({
        cwd: "/repo",
        comparison: "index",
        reviewedState: { headCommit: "a".repeat(40), indexTree: "b".repeat(40) },
      }),
    ).toMatchObject({ comparison: "index" });
  });
});

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

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });

  it("preserves an explicit stale pull request checkout result", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
      isOnPullRequestHead: false,
    });

    expect(parsed.isOnPullRequestHead).toBe(false);
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
