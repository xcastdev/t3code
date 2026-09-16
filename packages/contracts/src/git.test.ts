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
  GitRepositoryDiscoveryInput,
  GitRepositoryDiscoveryResult,
  GitCommitGraphPageInput,
  GitCommitGraphPageResult,
  GitCommitFilesInput,
  GitCommitFilesResult,
  GitRepositoryComparisonInput,
  GitRepositoryComparisonResult,
  GitRepositoryComparisonDescriptor,
  GitActionRequest,
  GitCommitIndexInput,
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
const decodeRepositoryDiscoveryInput = Schema.decodeUnknownSync(GitRepositoryDiscoveryInput);
const decodeRepositoryDiscoveryResult = Schema.decodeUnknownSync(GitRepositoryDiscoveryResult);
const decodeCommitGraphPageInput = Schema.decodeUnknownSync(GitCommitGraphPageInput);
const decodeCommitGraphPageResult = Schema.decodeUnknownSync(GitCommitGraphPageResult);
const decodeCommitFilesInput = Schema.decodeUnknownSync(GitCommitFilesInput);
const decodeCommitFilesResult = Schema.decodeUnknownSync(GitCommitFilesResult);
const decodeRepositoryComparisonInput = Schema.decodeUnknownSync(GitRepositoryComparisonInput);
const decodeRepositoryComparisonResult = Schema.decodeUnknownSync(GitRepositoryComparisonResult);
const decodeRepositoryComparisonDescriptor = Schema.decodeUnknownSync(
  GitRepositoryComparisonDescriptor,
);
const decodeActionRequest = Schema.decodeUnknownSync(GitActionRequest);
const decodeCommitIndexInput = Schema.decodeUnknownSync(GitCommitIndexInput);

describe("repository-scoped Git contracts", () => {
  it("decodes bounded repository discovery metadata", () => {
    const input = decodeRepositoryDiscoveryInput({
      cwd: "/workspace",
      maxRepositories: 8,
    });
    expect(input.maxRepositories).toBe(8);

    const result = decodeRepositoryDiscoveryResult({
      projectRoot: "/workspace",
      repositories: [
        {
          rootPath: "/workspace",
          worktreePath: "/workspace",
          commonDir: "/workspace/.git",
          isSubmodule: false,
          provider: null,
        },
      ],
      truncated: false,
    });
    expect(result.repositories[0]?.rootPath).toBe("/workspace");
  });

  it("keeps graph cursors and commit-file loading additive", () => {
    const input = decodeCommitGraphPageInput({
      cwd: "/repo",
      cursor: null,
      limit: 25,
    });
    expect(input.cursor).toBeNull();
    const page = decodeCommitGraphPageResult({
      commits: [
        {
          sha: "a".repeat(40),
          parents: ["b".repeat(40)],
          authorTimestamp: 1,
          subject: "initial",
          refs: [{ kind: "local", name: "main" }],
        },
      ],
      nextCursor: 1,
      hasMore: true,
    });
    expect(page.commits[0]?.parents).toEqual(["b".repeat(40)]);

    const filesInput = decodeCommitFilesInput({ cwd: "/repo", commitSha: "a".repeat(40) });
    expect(filesInput.commitSha).toBe("a".repeat(40));
    const files = decodeCommitFilesResult({
      commitSha: "a".repeat(40),
      files: [{ oldPath: null, newPath: "README.md", status: "added" }],
    });
    expect(files.files[0]?.status).toBe("added");
  });

  it("accepts only full Git object ids in graph rows", () => {
    expect(() =>
      decodeCommitGraphPageResult({
        commits: [
          {
            sha: "not-a-sha",
            parents: [],
            authorTimestamp: 1,
            subject: "bad row",
            refs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    ).toThrow();
  });

  it("carries hover metadata and distinct graph-ref decorations without eager file lists", () => {
    const sha = "a".repeat(40);
    const page = decodeCommitGraphPageResult({
      commits: [
        {
          sha,
          parents: ["b".repeat(40)],
          authorTimestamp: 1,
          authorName: "Ada Lovelace",
          authorEmail: "ada@example.test",
          subject: "Short summary",
          message: "Short summary\n\nComplete message.",
          changeSummary: "1 file changed, 2 insertions(+)",
          refs: [
            { kind: "head", name: "HEAD" },
            { kind: "current", name: "main" },
            { kind: "upstream", name: "origin/main" },
          ],
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(page.commits[0]).toMatchObject({
      authorName: "Ada Lovelace",
      message: "Short summary\n\nComplete message.",
    });
  });

  it("identifies repository comparisons independently from route state", () => {
    const input = decodeRepositoryComparisonInput({
      cwd: "/repo",
      comparison: "working-tree",
      oldPath: "README.md",
      newPath: "README.md",
    });
    expect(input.comparison).toBe("working-tree");
    const result = decodeRepositoryComparisonResult({
      repositoryRoot: "/repo",
      comparison: "working-tree",
      oldPath: "README.md",
      newPath: "README.md",
      oldContents: "before\n",
      newContents: "after\n",
      binary: false,
      available: true,
    });
    expect(result.available).toBe(true);
  });

  it("keeps a complete versioned comparison identity when a live branch moves", () => {
    const descriptor = decodeRepositoryComparisonDescriptor({
      version: 1,
      environmentId: "environment-a",
      repositoryRoot: "/repo-a",
      kind: "branch",
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      liveSnapshotId: null,
      turnId: null,
      checkpointId: null,
      pullRequestId: null,
      mergeParent: "c".repeat(40),
    });
    expect(descriptor).toMatchObject({
      repositoryRoot: "/repo-a",
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      headRevision: "b".repeat(40),
      mergeParent: "c".repeat(40),
    });
  });

  it("makes action confirmation explicit at the typed seam", () => {
    const action = decodeActionRequest({
      cwd: "/repo",
      action: "commit",
      confirm: false,
      precondition: { expectedHeadCommit: null, expectedIndexTree: "tree" },
    });
    expect(action.confirm).toBe(false);
  });

  it("carries typed inputs for every repository workflow family", () => {
    const action = decodeActionRequest({
      cwd: "/repo",
      action: "branch",
      confirm: true,
      refName: "feature/new",
      sourceRef: "main",
      newRefName: "feature/renamed",
      paths: ["src/index.ts"],
      strategy: "rebase",
    });
    expect(action).toMatchObject({
      action: "branch",
      refName: "feature/new",
      sourceRef: "main",
      newRefName: "feature/renamed",
      paths: ["src/index.ts"],
      strategy: "rebase",
    });
  });

  it("accepts an empty message for an explicit amend request", () => {
    const input = decodeCommitIndexInput({ cwd: "/repo", message: "", amend: true });
    expect(input.message).toBe("");
    expect(input.amend).toBe(true);
  });
});

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

  it("carries an additive reviewed-state guard for confirmed worktree creation", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "main",
      path: "/tmp/worktree",
      precondition: {
        expectedHeadCommit: "a".repeat(40),
        expectedIndexTree: "b".repeat(40),
        expectedRefName: "main",
      },
    });
    expect(parsed.precondition).toMatchObject({ expectedRefName: "main" });
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

  it("accepts an additive reviewed-state guard for approved stacked actions", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "push",
      precondition: {
        expectedHeadCommit: "a".repeat(40),
        expectedIndexTree: "b".repeat(40),
        expectedRefName: "main",
      },
    });
    expect(parsed.precondition).toMatchObject({ expectedRefName: "main" });
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
