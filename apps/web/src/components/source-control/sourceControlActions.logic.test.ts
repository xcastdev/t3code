import type {
  GitActionOperation,
  GitRepositoryCapabilities,
  VcsStatusResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";
import {
  destructiveWorkflowCopy,
  buildGitCommitFilePaths,
  workingTreeSnapshotScope,
  buildGitActionProgressStages,
  buildMenuItems,
  buildWorkflowMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  reviewedGitSnapshotAvailability,
  workflowApprovalDescription,
  workflowInputFieldVisibility,
  workflowInputFields,
  workflowRequiredFields,
  isWorkflowViewChecked,
} from "./sourceControlActions.logic";

describe("repository workflow menu", () => {
  it("describes distinct reviewed pull and publication targets for rebase and sync", () => {
    const description = workflowApprovalDescription({
      label: "Commit & Sync",
      environmentId: "env" as never,
      repositoryRoot: "/repo",
      sourceRef: "feature/reviewed",
      sourceHead: "reviewed-head",
      refName: "",
      sourceRefInput: "",
      targetRef: "",
      oldRefName: "",
      newRefName: "",
      remoteName: "publication",
      pullRemoteName: "upstream",
      pullRefName: "pull-target",
      publicationRemoteName: "publication",
      publicationRefName: "publish-target",
      compoundOperation: "commit-sync",
    });
    assert.include(description, "pull upstream/pull-target");
    assert.include(description, "publish publication/publish-target");
    assert.include(description, "commit, pull, then push");
  });

  it("requires source and old ref fields for create-from and rename", () => {
    assert.deepEqual(workflowInputFieldVisibility("branch", "create"), {
      sourceRef: true,
      oldRefName: false,
    });
    assert.deepEqual(workflowInputFieldVisibility("branch", "rename"), {
      sourceRef: false,
      oldRefName: true,
    });
  });

  it("makes fixed leaves name their non-negotiable inputs", () => {
    assert.deepEqual(workflowRequiredFields("branch-create-from"), ["refName", "sourceRef"]);
    assert.deepEqual(workflowRequiredFields("pull-from"), ["remoteName", "refName"]);
    assert.deepEqual(workflowRequiredFields("push-to"), ["remoteName", "refName"]);
    assert.deepEqual(workflowRequiredFields("stash-apply-latest"), []);
    assert.deepEqual(workflowRequiredFields("stash-pop-latest"), []);
  });

  it("renders a ref input for a typed checkout", () => {
    assert.isTrue(workflowInputFields("checkout").has("refName"));
    assert.deepEqual(workflowRequiredFields("checkout"), ["refName"]);
  });

  it("gives the retained Commit submenu a message field and keeps empty plain commits disabled", () => {
    assert.isTrue(workflowInputFields("commit").has("message"));
    assert.isTrue(workflowInputFields("amend").has("message"));
    assert.deepEqual(workflowRequiredFields("commit"), ["message"]);
    assert.deepEqual(workflowRequiredFields("amend"), []);
  });

  it("disables PR mutations that have no repository-scoped reference", () => {
    const items = buildWorkflowMenuItems(status(), capabilities([]), false, {
      providerAvailable: true,
      authenticated: true,
      hasPullRequest: true,
      hasReference: false,
    });
    assert.include(
      items.find((item) => item.id === "pr-merge")?.disabledReason ?? "",
      "repository identity",
    );
    assert.include(
      items.find((item) => item.id === "pr-refresh")?.disabledReason ?? "",
      "repository identity",
    );
  });

  it("fails closed for mutations until the reviewed ref, HEAD, and index snapshot is complete", () => {
    const unavailable = reviewedGitSnapshotAvailability({
      status: incompleteStatus("indexTree"),
      isPending: false,
      hasError: false,
    });
    assert.isFalse(unavailable.available);
    if (unavailable.available) throw new Error("expected an unavailable reviewed snapshot");
    assert.include(unavailable.reason, "index");

    const items = buildWorkflowMenuItems(
      incompleteStatus("indexTree"),
      capabilities(["commit", "fetch", "pull", "push", "sync", "publish", "branch"]),
      false,
      undefined,
      unavailable,
    );
    assert.include(items.find((item) => item.id === "push")?.disabledReason ?? "", "index");
    assert.include(items.find((item) => item.id === "checkout")?.disabledReason ?? "", "index");
    assert.include(items.find((item) => item.id === "pr-create")?.disabledReason ?? "", "index");
    assert.isUndefined(items.find((item) => item.id === "view-tree")?.disabledReason);
  });

  it("names pending, failed, ref, HEAD, and index snapshot failures", () => {
    const cases = [
      [{ status: status(), isPending: true, hasError: false }, "loading"],
      [{ status: status(), isPending: false, hasError: true }, "failed"],
      [{ status: incompleteStatus("refName"), isPending: false, hasError: false }, "ref"],
      [{ status: incompleteStatus("headCommit"), isPending: false, hasError: false }, "HEAD"],
      [{ status: incompleteStatus("indexTree"), isPending: false, hasError: false }, "index"],
    ] as const;

    for (const [input, reason] of cases) {
      const availability = reviewedGitSnapshotAvailability(input);
      assert.isFalse(availability.available);
      if (availability.available) throw new Error("expected an unavailable reviewed snapshot");
      assert.include(availability.reason, reason);
    }
  });

  it("keeps presentation and sort checks independent", () => {
    assert.isTrue(isWorkflowViewChecked("view-tree", "view-tree", "view-sort-name"));
    assert.isTrue(isWorkflowViewChecked("view-sort-name", "view-tree", "view-sort-name"));
    assert.isFalse(isWorkflowViewChecked("view-list", "view-tree", "view-sort-name"));
    assert.isFalse(isWorkflowViewChecked("view-sort-path", "view-tree", "view-sort-name"));
  });

  it("exposes the full typed matrix with capability-gated reasons", () => {
    const items = buildWorkflowMenuItems(
      status({
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 0, deletions: 0, stagedCount: 1 },
      }),
      capabilities(["commit", "amend", "fetch", "pull", "push", "sync", "publish", "branch"]),
      false,
    );
    assert.deepEqual(
      [
        "View as Tree",
        "Sort by Path",
        "Commit & Push",
        "Undo Last Commit",
        "Stage All",
        "Unstage All",
        "Discard All",
        "Pull From...",
        "Force Push",
        "Fetch Prune",
        "Create Branch From...",
        "Delete Remote Branch",
        "Add Remote",
        "Remove Remote",
        "Stash Staged",
        "Drop All",
        "Push All Tags",
        "Create Pull Request",
        "Close Pull Request",
      ].every((label) => items.some((item) => item.label === label)),
      true,
    );
    assert.include(items.find((item) => item.id === "merge")?.disabledReason ?? "", "unavailable");
    assert.isFalse(items.find((item) => item.id === "commit")?.requiresConfirmation);
    assert.isTrue(items.find((item) => item.id === "push")?.requiresConfirmation);
  });

  it("derives direct sync and conflict availability from real repository preconditions", () => {
    const items = buildWorkflowMenuItems(
      status({
        refName: null,
        hasPrimaryRemote: false,
        hasUpstream: false,
        aheadCount: 0,
        pendingMergeHeads: [],
      }),
      capabilities(["fetch", "pull", "push", "sync", "publish", "conflict"]),
      false,
    );
    assert.include(items.find((item) => item.id === "fetch")?.disabledReason ?? "", "remote");
    assert.include(items.find((item) => item.id === "pull")?.disabledReason ?? "", "Detached HEAD");
    assert.include(items.find((item) => item.id === "push")?.disabledReason ?? "", "Detached HEAD");
    assert.include(items.find((item) => item.id === "sync")?.disabledReason ?? "", "Detached HEAD");
    assert.include(
      items.find((item) => item.id === "publish")?.disabledReason ?? "",
      "Detached HEAD",
    );
    assert.include(
      items.find((item) => item.id === "conflict-continue")?.disabledReason ?? "",
      "No active conflict",
    );
    assert.include(
      items.find((item) => item.id === "conflict-abort")?.disabledReason ?? "",
      "No active conflict",
    );
  });

  it("enables conflict continuation from the server-reported cherry-pick state", () => {
    const activeStatus = status() as VcsStatusResult & {
      readonly activeConflictOperation: "cherry-pick";
    };
    const items = buildWorkflowMenuItems(
      { ...activeStatus, activeConflictOperation: "cherry-pick" },
      capabilities(["conflict"]),
      false,
    );
    assert.isFalse(items.find((item) => item.id === "conflict-continue")?.disabled ?? true);
    assert.isFalse(items.find((item) => item.id === "conflict-abort")?.disabled ?? true);
  });

  it("gates every remote and index-specific variant on its real prerequisite", () => {
    const items = buildWorkflowMenuItems(
      status({
        hasPrimaryRemote: false,
        hasUpstream: false,
        workingTree: { files: [], insertions: 0, deletions: 0, stagedCount: 0 },
      }),
      capabilities(["fetch", "pull", "push", "branch", "stash", "tag"]),
      false,
    );
    for (const id of [
      "fetch-all",
      "fetch-prune",
      "push-to",
      "force-push",
      "branch-publish",
      "branch-delete-remote",
      "tag-push",
      "tag-push-all",
    ] as const) {
      assert.include(items.find((item) => item.id === id)?.disabledReason ?? "", "remote");
    }
    assert.include(
      items.find((item) => item.id === "pull-rebase")?.disabledReason ?? "",
      "upstream",
    );
    assert.include(
      items.find((item) => item.id === "stash-staged")?.disabledReason ?? "",
      "Stage changes",
    );
  });

  it("disables undo on a root commit because HEAD~1 does not exist", () => {
    const items = buildWorkflowMenuItems(
      status({ headCommit: "root", headHasParent: false }),
      capabilities(["reset"]),
      false,
    );
    assert.include(items.find((item) => item.id === "undo-commit")?.disabledReason ?? "", "parent");
  });

  it("does not offer Stash Staged to an installed Git that cannot execute it", () => {
    const items = buildWorkflowMenuItems(
      status({
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 0, deletions: 0, stagedCount: 1 },
      }),
      { actions: ["stash"], supportsIndexWorkflow: true, supportsStashStaged: false },
      false,
    );
    assert.include(
      items.find((item) => item.id === "stash-staged")?.disabledReason ?? "",
      "Git 2.35",
    );
  });

  it("uses provider capabilities and viewer permissions for PR mutation reasons", () => {
    const items = buildWorkflowMenuItems(status(), capabilities([]), false, {
      providerAvailable: true,
      authenticated: true,
      hasPullRequest: true,
      hasReference: true,
      detailStatus: "ready",
      actions: new Set(["close"]),
      viewerActions: new Set(),
    });
    assert.include(
      items.find((item) => item.id === "pr-merge")?.disabledReason ?? "",
      "provider cannot merge",
    );
    assert.include(
      items.find((item) => item.id === "pr-close")?.disabledReason ?? "",
      "signed-in account cannot close",
    );
  });

  it("fails closed for pull-request mutations until typed detail has loaded", () => {
    const items = buildWorkflowMenuItems(status(), capabilities([]), false, {
      providerAvailable: true,
      authenticated: true,
      hasPullRequest: true,
      hasReference: true,
    });

    for (const id of ["pr-merge", "pr-close"] as const) {
      assert.include(items.find((item) => item.id === id)?.disabledReason ?? "", "Loading");
    }
    for (const id of ["pr-open", "pr-checkout", "pr-refresh"] as const) {
      assert.isUndefined(items.find((item) => item.id === id)?.disabledReason);
    }
  });

  it("keeps mutations fail-closed but leaves reference-based recovery actions available when typed detail failed", () => {
    const items = buildWorkflowMenuItems(status(), capabilities([]), false, {
      providerAvailable: true,
      authenticated: true,
      hasPullRequest: true,
      hasReference: true,
      detailStatus: "failed",
    });

    assert.include(
      items.find((item) => item.id === "pr-merge")?.disabledReason ?? "",
      "failed to load",
    );
    assert.include(
      items.find((item) => item.id === "pr-close")?.disabledReason ?? "",
      "failed to load",
    );
    assert.isUndefined(items.find((item) => item.id === "pr-refresh")?.disabledReason);
    assert.isUndefined(items.find((item) => item.id === "pr-open")?.disabledReason);
  });
});

function capabilities(actions: readonly GitActionOperation[]): GitRepositoryCapabilities {
  return { actions, supportsIndexWorkflow: true, supportsStashStaged: true };
}

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    headCommit: "head",
    indexTree: "index",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function incompleteStatus(field: "refName" | "headCommit" | "indexTree"): VcsStatusResult {
  const incomplete = { ...status() } as Record<string, unknown>;
  delete incomplete[field];
  return incomplete as VcsStatusResult;
}

describe("when: ref is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        pr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "View PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and enables open PR", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions", () => {
    const items = buildMenuItems(status(), true);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });

  it("buildMenuItems enables push and keeps open PR available", () => {
    const items = buildMenuItems(
      status({
        aheadCount: 2,
        pr: {
          number: 12,
          title: "Existing PR",
          url: "https://example.com/pr/12",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: ref is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes and creates a PR", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
    });
  });

  it("buildMenuItems enables push and create PR, with commit disabled", () => {
    const items = buildMenuItems(status({ aheadCount: 2, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: source control provider uses merge requests", () => {
  it("uses GitLab MR terminology in quick actions and menu items", () => {
    const gitlabStatus = status({
      aheadCount: 2,
      sourceControlProvider: {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      },
    });

    const quick = resolveQuickAction(gitlabStatus, false);
    const items = buildMenuItems(gitlabStatus, false);

    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create MR",
    });
    assert.deepInclude(items[2], {
      id: "pr",
      label: "Create MR",
    });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);
  });

  it("resolveQuickAction returns disabled no-action state", () => {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems disables commit, push, and create PR", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });

  it("buildMenuItems disables push and create PR", () => {
    const items = buildMenuItems(status({ behindCount: 1, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref has diverged from upstream", () => {
  it("resolveQuickAction returns a disabled sync hint", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false);
    assert.deepEqual(quick, {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction keeps commit and push on the staged workflow", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("resolveQuickAction falls back to commit when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit",
      label: "Commit",
      disabled: false,
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and disables push and PR", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems enables push for ahead commits while local changes remain uncommitted", () => {
    const items = buildMenuItems(
      status({
        refName: "feature/test",
        hasWorkingTreeChanges: true,
        aheadCount: 1,
        workingTree: {
          files: [{ path: ".vercel/project.json", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("resolveQuickAction returns push when ref is ahead", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", aheadCount: 2, pr: null }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });
});

describe("when: working tree has local changes and ref is behind upstream", () => {
  it("resolveQuickAction still prefers the staged commit and push workflow", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, behindCount: 1 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and keeps push and PR disabled", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, behindCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ refName: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems keeps commit, push, and PR disabled", () => {
    const items = buildMenuItems(status({ refName: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems disables push and create PR when no commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 0 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });

  it("buildMenuItems enables create PR when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems hides push and create PR when no origin remote exists", () => {
    const items = buildMenuItems(
      status({ hasUpstream: false, pr: null, aheadCount: 2 }),
      false,
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
    ]);
  });

  it("resolveQuickAction is disabled on default ref when no upstream exists and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        refName: "main",
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction uses push-only on default ref when no upstream exists and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        refName: "main",
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems still disables push and create PR when ref is behind", () => {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("identifies the selected repository in the default-ref confirmation", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      repositoryRoot: "/workspace/api",
    });

    assert.include(copy.description, 'repository "/workspace/api"');
  });

  it("uses push-only copy when pushing without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push to default ref?",
      description:
        'This action will push local commits on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push & create PR from default ref?",
      description:
        'This action will push local commits and create a pull request on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });

  it("keeps commit copy when the action includes a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: true,
    });

    assert.deepEqual(copy, {
      title: "Commit, push & create PR from default ref?",
      description:
        'This action will commit, push, and create a pull request on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
  });
});

describe("buildGitActionProgressStages", () => {
  it("shows only push progress for explicit push actions", () => {
    const stages = buildGitActionProgressStages({
      action: "push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("shows push and PR progress for create-pr actions that still need a push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
      shouldPushBeforePr: true,
    });
    assert.deepEqual(stages, [
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });

  it("shows only PR progress when create-pr can skip the push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      shouldPushBeforePr: false,
    });
    assert.deepEqual(stages, [
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });

  it("includes granular PR stages for commit+push+PR actions", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push_pr",
      hasCustomCommitMessage: true,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Committing...",
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push_pr",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });

  it("returns null when the action stayed on the existing branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "skipped_not_requested",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.equal(update, null);
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when live git status is unavailable", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: null,
    });

    assert.equal(update, null);
  });

  it("returns null when the stored thread ref already matches git status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.equal(update, null);
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });

  it("allows a temporary worktree ref to reconcile to a semantic branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/a9628676",
      gitStatus: status({ refName: "feature/diff-panel-toggle" }),
    });

    assert.deepEqual(update, { branch: "feature/diff-panel-toggle" });
  });
});

describe("resolveThreadBranchMetadataPatch", () => {
  it("does not overwrite worktree metadata while reconciling a branch", () => {
    assert.deepEqual(
      resolveThreadBranchMetadataPatch("feature/current-ref", "feature/previous-ref"),
      {
        branch: "feature/current-ref",
        expectedBranch: "feature/previous-ref",
      },
    );
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred ref names when available", () => {
    const ref = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(ref, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a ref namespace", () => {
    const ref = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(ref, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const ref = resolveAutoFeatureBranchName(["main"]);
    assert.equal(ref, "feature/update");
  });
});

describe("buildGitCommitFilePaths", () => {
  it("keeps whole-tree commits pathless and retains explicit off-page selections", () => {
    assert.equal(buildGitCommitFilePaths({ mode: "all" }), undefined);
    assert.deepEqual(
      buildGitCommitFilePaths({
        mode: "paths",
        paths: new Set(["preview-file.ts", "off-page-file.ts"]),
      }),
      ["preview-file.ts", "off-page-file.ts"],
    );
  });
});

describe("workingTreeSnapshotScope", () => {
  it("does not let same-named snapshots collide across environment repositories", () => {
    assert.notEqual(
      workingTreeSnapshotScope("environment-a", "/repo-a", "wt-1"),
      workingTreeSnapshotScope("environment-b", "/repo-b", "wt-1"),
    );
  });
});

describe("destructive workflow confirmation", () => {
  it("names the ref at risk and uses destructive action copy", () => {
    assert.deepEqual(destructiveWorkflowCopy({ id: "force-push", remoteName: "upstream" }), {
      description:
        "force-pushing the selected ref to upstream can overwrite that remote branch's history.",
      confirmLabel: "Force push",
    });
    assert.deepEqual(destructiveWorkflowCopy({ id: "stash-drop", refName: "stash@{2}" }), {
      description: "dropping stash stash@{2} permanently removes its saved changes.",
      confirmLabel: "Drop stash",
    });
    assert.deepEqual(destructiveWorkflowCopy({ id: "tag-delete", refName: "v2.0.0" }), {
      description: "deleting tag v2.0.0 removes that local tag ref.",
      confirmLabel: "Delete tag",
    });
  });
});
