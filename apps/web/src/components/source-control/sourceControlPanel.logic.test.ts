import { describe, expect, it } from "vite-plus/test";
import {
  buildSourceControlCommitInput,
  buildSourceControlFileTree,
  canSubmitSourceControlCommit,
  createBoundedGraphRefreshWindow,
  fileAction,
  groupWorkingTreeFiles,
  gitIndexWorkflowAvailability,
  requiresAmendConfirmation,
  graphCommitRowLabel,
  sourceControlComposerDraftKey,
  moveSourceControlTab,
  sourceControlFileStatusLabel,
  sourceControlPanelTabs,
  nextSourceControlView,
  formatCompoundActionFailure,
  derivePrimarySourceControlAction,
  sourceControlConfirmationDescription,
  sourceControlGenerateDisabledReason,
  resolveSourceControlWriterAvailability,
} from "./sourceControlPanel.logic.ts";

describe("working tree groups", () => {
  it("keeps the completed commit visible when the network step fails", () => {
    expect(formatCompoundActionFailure(["commit"], "push")).toBe(
      "commit completed, but push failed. Review the repository before retrying.",
    );
  });

  it("cycles real tree and sort views instead of treating them as no-op menu items", () => {
    expect(nextSourceControlView({ tree: false, sort: "path" }, "view-tree")).toEqual({
      tree: true,
      sort: "path",
    });
    expect(nextSourceControlView({ tree: true, sort: "path" }, "view-sort")).toEqual({
      tree: true,
      sort: "name",
    });
    expect(nextSourceControlView({ tree: true, sort: "name" }, "view-sort").sort).toBe("status");
  });

  it("builds directory nodes for tree presentation rather than formatting file indentation", () => {
    expect(
      buildSourceControlFileTree([
        { path: "src/app.ts", indexStatus: "unstaged", insertions: 1, deletions: 0 },
        { path: "src/components/button.ts", indexStatus: "staged", insertions: 1, deletions: 0 },
      ]),
    ).toEqual([
      { kind: "directory", path: "src", depth: 0 },
      { kind: "file", path: "src/app.ts", depth: 1 },
      { kind: "directory", path: "src/components", depth: 1 },
      { kind: "file", path: "src/components/button.ts", depth: 2 },
    ]);
  });

  it("keeps selected name and status sorting for sibling files in tree mode", () => {
    const files = [
      { path: "src/zebra.ts", indexStatus: "staged" },
      { path: "src/alpha.ts", indexStatus: "unstaged" },
      { path: "docs/readme.md", indexStatus: "staged" },
    ];
    const byStatus = (left: (typeof files)[number], right: (typeof files)[number]) =>
      left.indexStatus.localeCompare(right.indexStatus) || left.path.localeCompare(right.path);
    expect(
      buildSourceControlFileTree(files, byStatus)
        .filter((node) => node.kind === "file")
        .map((node) => node.path),
    ).toEqual(["docs/readme.md", "src/zebra.ts", "src/alpha.ts"]);
  });

  it("keeps files owned by their directory when a global comparator interleaves branches", () => {
    const files = [
      { path: "src/a.ts", indexStatus: "staged" },
      { path: "docs/b.ts", indexStatus: "unstaged" },
      { path: "src/z.ts", indexStatus: "unstaged" },
    ];
    const byName = (left: (typeof files)[number], right: (typeof files)[number]) =>
      left.path.split("/").at(-1)!.localeCompare(right.path.split("/").at(-1)!);

    expect(buildSourceControlFileTree(files, byName)).toEqual([
      { kind: "directory", path: "src", depth: 0 },
      { kind: "file", path: "src/a.ts", depth: 1 },
      { kind: "file", path: "src/z.ts", depth: 1 },
      { kind: "directory", path: "docs", depth: 0 },
      { kind: "file", path: "docs/b.ts", depth: 1 },
    ]);
  });

  it("separates staged and unstaged sides of mixed files", () => {
    const groups = groupWorkingTreeFiles([
      { path: "staged.ts", indexStatus: "staged", insertions: 1, deletions: 0 },
      { path: "mixed.ts", indexStatus: "both", insertions: 2, deletions: 1 },
      { path: "untracked.ts", indexStatus: "untracked", insertions: 1, deletions: 0 },
      { path: "conflict.ts", indexStatus: "conflicted", insertions: 0, deletions: 0 },
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Staged Changes",
      "Unstaged Changes",
      "Conflicts",
    ]);
    expect(groups[0]?.files.map((file) => file.path)).toEqual(["staged.ts", "mixed.ts"]);
    expect(groups[1]?.files.map((file) => file.path)).toEqual(["mixed.ts", "untracked.ts"]);
    expect(groups[2]?.files.map((file) => file.path)).toEqual(["conflict.ts"]);
  });
});

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
  it("names separate pull and publication targets for composer and header Sync confirmations", () => {
    expect(
      sourceControlConfirmationDescription({
        action: "sync",
        repositoryRoot: "/repo/.worktrees/feature",
        branch: "feature/retry",
        remoteName: "fork",
        remoteRefName: "feature/retry",
        pullRemoteName: "origin",
        pullRefName: "main",
      }),
    ).toBe(
      "Repository /repo/.worktrees/feature, branch feature/retry: pull from remote origin/main, then push to remote fork/feature/retry.",
    );
    expect(
      sourceControlConfirmationDescription({
        action: "pull",
        repositoryRoot: "/repo/.worktrees/feature",
        branch: "feature/retry",
        remoteName: "fork",
        remoteRefName: "feature/retry",
        pullRemoteName: "origin",
        pullRefName: "main",
      }),
    ).toBe(
      "Repository /repo/.worktrees/feature, branch feature/retry: pull from remote origin/main.",
    );
    expect(
      sourceControlConfirmationDescription({
        action: "commit_sync",
        repositoryRoot: "/repo/.worktrees/feature",
        branch: "feature/retry",
        remoteName: "fork",
        remoteRefName: "feature/retry",
        pullRemoteName: "origin",
        pullRefName: "main",
      }),
    ).toBe(
      "Repository /repo/.worktrees/feature, branch feature/retry: commit the reviewed staged changes, pull from remote origin/main, then push to remote fork/feature/retry.",
    );
  });
  it("explains why both Generate entry points are disabled", () => {
    expect(
      sourceControlGenerateDisabledReason({
        stagedCount: 1,
        generating: false,
        writer: {
          ready: false,
          reason: "Authenticate the selected commit-message writer before generating.",
        },
      }),
    ).toBe("Authenticate the selected commit-message writer before generating.");
    expect(
      sourceControlGenerateDisabledReason({
        stagedCount: 1,
        generating: false,
        writer: { ready: true, reason: null },
        instructionsRequired: true,
        hasInstructions: false,
      }),
    ).toBe("Add instructions before generating with custom guidance.");
  });
  it("falls back from a disabled source-control writer override to the healthy text writer", () => {
    expect(
      resolveSourceControlWriterAvailability({
        sourceControlWriterModelSelection: { instanceId: "disabled" as never, model: "old" },
        textGenerationModelSelection: { instanceId: "healthy" as never, model: "new" },
        providers: [
          {
            instanceId: "disabled",
            enabled: false,
            availability: "unavailable",
            status: "disabled",
            supportsTextGeneration: true,
            auth: { status: "unauthenticated" },
            models: [],
          },
          {
            instanceId: "healthy",
            enabled: true,
            availability: "available",
            status: "ready",
            supportsTextGeneration: true,
            auth: { status: "authenticated" },
            models: [{ slug: "new" }],
          },
        ] as never,
      }),
    ).toEqual({ ready: true, reason: null });
  });
  it("blocks a remote mutation before commit when selected remote credentials are unavailable", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit-push",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: true,
        remoteCredentialReady: false,
        remoteCredentialReason: "Authenticate GitHub for remote upstream before publishing.",
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
      }),
    ).toMatchObject({
      enabled: false,
      reason: "Authenticate GitHub for remote upstream before publishing.",
    });
  });
  it.each([
    ["diverged", { behindCount: 1, aheadCount: 1 }, "Sync this diverged branch before publishing."],
    [
      "conflict",
      { activeConflictOperation: "rebase" as const },
      "Resolve the active rebase before publishing.",
    ],
    ["stale", { statusFresh: false }, "Refresh repository status before publishing."],
    ["busy", { busy: true }, "Another source-control operation is running."],
  ])("blocks publication when %s", (_name, override, reason) => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit",
        stagedCount: 0,
        aheadCount: 1,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: true,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
        ...override,
      }),
    ).toMatchObject({ action: "push", enabled: false, reason });
  });

  it("keeps the shared reviewed-snapshot reason on the primary control", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit",
        stagedCount: 0,
        aheadCount: 1,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: true,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: false,
        statusFreshReason: "Repository index status is incomplete. Refresh and try again.",
        busy: false,
      }),
    ).toMatchObject({
      action: "push",
      enabled: false,
      reason: "Repository index status is incomplete. Refresh and try again.",
    });
  });

  it("blocks a compound publication while the branch is behind", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit-push",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 1,
        hasPrimaryRemote: true,
        hasUpstream: true,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
      }),
    ).toEqual({
      action: "commit-push",
      enabled: false,
      reason: "Pull or Sync before publishing this branch.",
    });
  });

  it("does not start a compound commit when its remote is missing", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit-push",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: false,
        hasUpstream: false,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
      }),
    ).toEqual({
      action: "commit-push",
      enabled: false,
      reason: "Add or publish a remote before pushing.",
    });
  });

  it("keeps an explicitly selected Amend primary ahead of publication and permits a message-only amend", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "amend",
        stagedCount: 0,
        aheadCount: 2,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: true,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
      }),
    ).toEqual({ action: "amend", enabled: true, reason: null });
  });

  it("uses Commit & Publish Branch where a remote exists but the branch has no upstream", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit-push",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: false,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
      }),
    ).toEqual({ action: "commit-publish", enabled: true, reason: null });
  });
  it("supports arrow and Home/End movement across Source Control tabs", () => {
    expect(moveSourceControlTab("changes", "ArrowRight")).toBe("graph");
    expect(moveSourceControlTab("changes", "ArrowLeft")).toBe("pull-requests");
    expect(moveSourceControlTab("graph", "Home")).toBe("changes");
    expect(moveSourceControlTab("graph", "End")).toBe("pull-requests");
  });
  it("keys composer drafts by thread environment and repository", () => {
    expect(sourceControlComposerDraftKey("env", "thread", "/repo/a")).toBe("env\0thread\0/repo/a");
  });
  it("renders graph rows without exposing commit SHA", () => {
    expect(
      graphCommitRowLabel({
        subject: "Fix graph",
        refs: [{ kind: "local", name: "main" }],
      }),
    ).toBe("Fix graph · main");
  });
  it("bounds a missing-protection refresh while preserving the HEAD prefix", () => {
    const refresh = createBoundedGraphRefreshWindow({
      limit: 500,
      selectedSha: "missing",
      anchorSha: null,
    });
    for (let index = 0; index < 100_000; index += 1) {
      refresh.push({ sha: index.toString(16).padStart(40, "0") });
    }

    const retained = refresh.finish();
    expect(retained.commits).toHaveLength(500);
    expect(retained.commits[0]?.sha).toBe("0".repeat(40));
    expect(retained.commits.at(-1)?.sha).toBe((499).toString(16).padStart(40, "0"));
    // HEAD prefix + rolling tail + one protected candidate: constant space,
    // independent of the 100k rows read to establish EOF.
    expect(retained.maxRetainedCommitCount).toBeLessThanOrEqual(1_500);
  });
  it("keeps shallow selected and visible protections in the loaded HEAD page", () => {
    const refresh = createBoundedGraphRefreshWindow({
      limit: 500,
      windowLimit: 50,
      selectedSha: "selected",
      anchorSha: "anchor",
    });
    for (let index = 0; index < 100; index += 1) {
      refresh.push({
        sha:
          index === 20
            ? "anchor"
            : index === 30
              ? "selected"
              : index.toString(16).padStart(40, "0"),
      });
    }

    expect(refresh.finish()).toMatchObject({ start: 0, end: 50 });
  });
  it("enlarges a protected refresh window up to the graph cap before evicting the anchor", () => {
    const refresh = createBoundedGraphRefreshWindow({
      limit: 500,
      windowLimit: 50,
      selectedSha: "selected",
      anchorSha: "anchor",
    });
    for (let index = 0; index < 100; index += 1) {
      refresh.push({
        sha:
          index === 20
            ? "anchor"
            : index === 70
              ? "selected"
              : index.toString(16).padStart(40, "0"),
      });
    }

    const retained = refresh.finish();
    expect(retained).toMatchObject({ start: 20, end: 71 });
    expect(retained.commits.map((commit) => commit.sha)).toContain("anchor");
    expect(retained.commits.map((commit) => commit.sha)).toContain("selected");
  });
  it.each([
    ["selection before a later distant anchor", 700, 1_500],
    ["anchor before a later selection", 1_500, 700],
  ])(
    "keeps selection in a bounded contiguous refresh window when %s",
    (_scenario, selectedIndex, anchorIndex) => {
      const refresh = createBoundedGraphRefreshWindow({
        limit: 500,
        windowLimit: 50,
        selectedSha: "selected",
        anchorSha: "anchor",
      });
      const rows = Array.from({ length: 2_000 }, (_, index) => ({
        sha:
          index === selectedIndex ? "selected" : index === anchorIndex ? "anchor" : `row-${index}`,
      }));
      for (const row of rows) refresh.push(row);

      const retained = refresh.finish();
      const expectedStart = selectedIndex - 49;
      expect(retained).toMatchObject({ start: expectedStart, end: selectedIndex + 1 });
      expect(retained.commits).toHaveLength(50);
      expect(retained.commits.map((commit) => commit.sha)).toEqual(
        rows.slice(expectedStart, selectedIndex + 1).map((row) => row.sha),
      );
      expect(retained.commits.map((commit) => commit.sha)).toContain("selected");
      expect(retained.commits.map((commit) => commit.sha)).not.toContain("anchor");
    },
  );
  it("requires exactly one confirmation for amend on every ref", () => {
    expect(requiresAmendConfirmation(true)).toBe(true);
    expect(requiresAmendConfirmation(false)).toBe(false);
  });
  it("keeps Changes, Graph, and provider-aware pull request tabs interactive", () => {
    expect(sourceControlPanelTabs("GitHub")).toEqual([
      { id: "changes", label: "Changes" },
      { id: "graph", label: "Graph" },
      { id: "pull-requests", label: "GitHub Pull Requests" },
    ]);
    expect(sourceControlPanelTabs("GitLab", "Merge Requests")[2]).toEqual({
      id: "pull-requests",
      label: "GitLab Merge Requests",
    });
  });
  it.each([
    ["remote", { hasPrimaryRemote: false }, "Add a remote before committing and syncing."],
    ["upstream", { hasUpstream: false }, "Set an upstream branch before committing and syncing."],
  ])("does not let Commit & Sync commit without a %s", (_prerequisite, override, reason) => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit-sync",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: true,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
        ...override,
      }),
    ).toEqual({ action: "commit-sync", enabled: false, reason });
  });
  it("does not let a commit start without a configured Git identity", () => {
    expect(
      derivePrimarySourceControlAction({
        selectedAction: "commit",
        stagedCount: 1,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: false,
        hasUpstream: false,
        refName: "feature/test",
        activeConflictOperation: undefined,
        statusFresh: true,
        busy: false,
        commitIdentityReady: false,
      }),
    ).toEqual({
      action: "commit",
      enabled: false,
      reason: "Configure Git user.name and user.email before committing.",
    });
  });
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

  it("keeps a blank amend message so Git can reuse the previous subject", () => {
    expect(
      buildSourceControlCommitInput({
        cwd: "/repo",
        message: "",
        amend: true,
        headCommit: "head",
        indexTree: "tree",
        refName: "feature/index",
        pendingMergeHeads: [],
        confirmDefaultRef: true,
      }),
    ).toMatchObject({ cwd: "/repo", message: "", amend: true, confirmDefaultRef: true });
  });
});
