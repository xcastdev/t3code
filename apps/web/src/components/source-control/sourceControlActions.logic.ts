import type {
  GitActionOperation,
  GitRepositoryCapabilities,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../../sourceControlPresentation";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitWorkflowMenuItem {
  readonly id: GitWorkflowMenuId;
  readonly label: string;
  readonly group:
    | "view"
    | "commit"
    | "changes"
    | "sync"
    | "branch"
    | "remote"
    | "stash"
    | "tags"
    | "pull-request"
    | "conflict";
  /** The wire action and its fixed leaf operation, never inferred from a label. */
  readonly action?: GitActionOperation;
  readonly operation?: string;
  readonly requiresConfirmation: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export type GitWorkflowMenuId =
  | GitActionOperation
  | "view-tree"
  | "view-sort"
  | "checkout"
  | "worktree"
  | "view-list"
  | "view-sort-path"
  | "view-sort-name"
  | "view-sort-status"
  | "commit-push"
  | "commit-sync"
  | "commit-publish"
  | "undo-commit"
  | "stage-all"
  | "unstage-all"
  | "discard-all"
  | "pull-from"
  | "pull-rebase"
  | "push-to"
  | "force-push"
  | "fetch-all"
  | "fetch-prune"
  | "branch-create"
  | "branch-create-from"
  | "branch-rename"
  | "branch-delete"
  | "branch-delete-remote"
  | "branch-publish"
  | "remote-add"
  | "remote-remove"
  | "stash-untracked"
  | "stash-staged"
  | "stash-view"
  | "stash-apply"
  | "stash-pop"
  | "stash-apply-latest"
  | "stash-pop-latest"
  | "stash-drop"
  | "stash-drop-all"
  | "tag-create"
  | "tag-delete"
  | "tag-push"
  | "tag-push-all"
  | "pr-create"
  | "pr-open"
  | "pr-checkout"
  | "pr-refresh"
  | "pr-merge"
  | "pr-close"
  | "conflict-continue"
  | "conflict-abort";

export function destructiveWorkflowCopy(input: {
  readonly id: GitWorkflowMenuId;
  readonly refName?: string;
  readonly remoteName?: string;
  readonly paths?: string;
  readonly repositoryRoot?: string;
  readonly branch?: string | null;
}): { readonly description: string; readonly confirmLabel: string } | null {
  const ref = input.refName?.trim() || "the selected ref";
  const remote = input.remoteName?.trim() || "the selected remote";
  const repository = input.repositoryRoot ? `Repository ${input.repositoryRoot}: ` : "";
  switch (input.id) {
    case "force-push":
      return {
        description: `${repository}force-pushing ${input.branch ?? ref} to ${remote} can overwrite that remote branch's history.`,
        confirmLabel: "Force push",
      };
    case "discard-all":
      return {
        description: `${repository}discarding permanently removes local changes${input.paths?.trim() ? ` in ${input.paths.trim()}` : ""}.`,
        confirmLabel: "Discard changes",
      };
    case "branch-delete":
      return {
        description: `${repository}deleting branch ${ref} removes its local ref.`,
        confirmLabel: "Delete branch",
      };
    case "branch-delete-remote":
      return {
        description: `${repository}deleting ${remote}/${ref} removes the remote branch ref.`,
        confirmLabel: "Delete remote branch",
      };
    case "stash-drop":
      return {
        description: `${repository}dropping stash ${ref} permanently removes its saved changes.`,
        confirmLabel: "Drop stash",
      };
    case "stash-drop-all":
      return {
        description: `${repository}dropping all stashes permanently removes every saved change set.`,
        confirmLabel: "Drop all stashes",
      };
    case "tag-delete":
      return {
        description: `${repository}deleting tag ${ref} removes that local tag ref.`,
        confirmLabel: "Delete tag",
      };
    default:
      return null;
  }
}

/**
 * Every typed workflow dialog is an approval, even when the leaf is not
 * destructive. Keep its reviewed checkout and supplied targets visible so a
 * user never has to infer which repository the confirmation will mutate.
 */
export function workflowApprovalDescription(input: {
  readonly label: string;
  readonly environmentId: string;
  readonly repositoryRoot: string;
  readonly sourceRef: string | null;
  readonly sourceHead: string | null;
  readonly sourceIndexTree?: string | null;
  readonly refName: string;
  readonly sourceRefInput: string;
  readonly targetRef: string;
  readonly oldRefName: string;
  readonly newRefName: string;
  readonly remoteName: string;
  /** Pull and publication can deliberately target different remotes. */
  readonly pullRemoteName?: string | null;
  readonly pullRefName?: string | null;
  readonly publicationRemoteName?: string | null;
  readonly publicationRefName?: string | null;
  readonly compoundOperation?: string;
}): string {
  const source = input.sourceRef ?? "detached HEAD";
  const revision = input.sourceHead ? ` at ${input.sourceHead}` : " (no commit yet)";
  const targets = [
    input.refName.trim() ? `ref ${input.refName.trim()}` : null,
    input.sourceRefInput.trim() ? `source ${input.sourceRefInput.trim()}` : null,
    input.targetRef.trim() ? `target ${input.targetRef.trim()}` : null,
    input.oldRefName.trim() ? `from ${input.oldRefName.trim()}` : null,
    input.newRefName.trim() ? `to ${input.newRefName.trim()}` : null,
    input.remoteName.trim() && !input.publicationRemoteName
      ? `remote ${input.remoteName.trim()}`
      : null,
    input.pullRemoteName
      ? `pull ${input.pullRemoteName}${input.pullRefName ? `/${input.pullRefName}` : ""}`
      : null,
    input.publicationRemoteName
      ? `publish ${input.publicationRemoteName}${input.publicationRefName ? `/${input.publicationRefName}` : ""}`
      : null,
  ].filter((target): target is string => target !== null);
  const compoundSteps =
    input.compoundOperation === "commit-sync"
      ? " It will commit, pull, then push."
      : input.compoundOperation === "commit-push" || input.compoundOperation === "commit-publish"
        ? " It will commit, then push."
        : "";
  return `Environment ${input.environmentId}. Repository ${input.repositoryRoot}. ${input.label} will run from ${source}${revision}${
    targets.length > 0 ? ` using ${targets.join(", ")}` : ""
  }.${compoundSteps} If this source changes, review the action again.`;
}

export function workflowInputFieldVisibility(
  action: GitWorkflowMenuId,
  operation: string,
): { readonly sourceRef: boolean; readonly oldRefName: boolean } {
  return {
    sourceRef: action === "branch" && (operation === "create" || operation === "create-from"),
    oldRefName: action === "branch" && operation === "rename",
  };
}

/** The dialog only exposes inputs its selected, fixed leaf can consume. */
export function workflowInputFields(
  id: GitWorkflowMenuId,
): ReadonlySet<
  | "refName"
  | "sourceRef"
  | "targetRef"
  | "oldRefName"
  | "newRefName"
  | "remoteName"
  | "message"
  | "paths"
  | "strategy"
> {
  switch (id) {
    case "checkout":
      return new Set(["refName"]);
    case "branch-create":
      return new Set(["refName"]);
    case "branch-create-from":
      return new Set(["refName", "sourceRef"]);
    case "branch-rename":
      return new Set(["oldRefName", "newRefName"]);
    case "branch-delete":
      return new Set(["refName"]);
    case "branch-delete-remote":
      return new Set(["remoteName", "refName"]);
    case "branch-publish":
      return new Set(["remoteName"]);
    case "remote-add":
      return new Set(["remoteName", "targetRef"]);
    case "remote-remove":
      return new Set(["remoteName"]);
    case "stash":
    case "stash-untracked":
      return new Set(["message", "paths"]);
    case "stash-staged":
    case "stash-view":
    case "stash-apply-latest":
    case "stash-pop-latest":
    case "stash-drop-all":
      return new Set();
    case "stash-apply":
    case "stash-pop":
    case "stash-drop":
      return new Set(["refName"]);
    case "tag-create":
      return new Set(["refName", "targetRef", "message"]);
    case "tag-delete":
      return new Set(["refName"]);
    case "tag-push":
      return new Set(["remoteName", "refName"]);
    case "tag-push-all":
      return new Set(["remoteName"]);
    case "pull-from":
    case "push-to":
      return new Set(["remoteName", "refName"]);
    case "pull-rebase":
      return new Set();
    case "force-push":
      return new Set(["remoteName"]);
    case "merge":
    case "rebase":
      return new Set(["targetRef", "strategy"]);
    case "cherry-pick":
    case "revert":
      return new Set(["targetRef"]);
    case "reset":
      return new Set(["targetRef", "strategy"]);
    case "commit-push":
    case "commit-sync":
    case "commit-publish":
      return new Set(["message", "remoteName"]);
    case "commit":
    case "amend":
      return new Set(["message"]);
    default:
      return new Set();
  }
}

/** Fixed leaves cannot fall back to a generic Git default when their target is blank. */
export function workflowRequiredFields(
  id: GitWorkflowMenuId,
): readonly ("refName" | "sourceRef" | "remoteName" | "message")[] {
  switch (id) {
    case "commit":
      return ["message"];
    case "checkout":
      return ["refName"];
    case "branch-create-from":
      return ["refName", "sourceRef"];
    case "pull-from":
    case "push-to":
      return ["remoteName", "refName"];
    default:
      return [];
  }
}

export type ReviewedGitSnapshotAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * Mutations only run against the ref, HEAD, and index snapshot the user
 * reviewed. Keep query state here so every entry point explains the same
 * unavailable condition instead of opening an approval it cannot execute.
 */
export function reviewedGitSnapshotAvailability(input: {
  readonly status: VcsStatusResult | null | undefined;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ReviewedGitSnapshotAvailability {
  if (input.isPending) {
    return { available: false, reason: "Repository status is loading. Refresh and try again." };
  }
  if (input.hasError) {
    return { available: false, reason: "Repository status failed to load. Refresh and try again." };
  }
  if (!input.status) {
    return { available: false, reason: "Repository status is unavailable. Refresh and try again." };
  }
  if (input.status.refName === undefined) {
    return {
      available: false,
      reason: "Repository ref status is incomplete. Refresh and try again.",
    };
  }
  if (input.status.headCommit === undefined) {
    return { available: false, reason: "Repository HEAD is unavailable. Refresh and try again." };
  }
  if (input.status.indexTree === undefined) {
    return {
      available: false,
      reason: "Repository index status is incomplete. Refresh and try again.",
    };
  }
  return { available: true };
}

/** Read-only presentation and recovery paths do not submit a reviewed mutation. */
export function workflowActionRequiresReviewedSnapshot(id: GitWorkflowMenuId): boolean {
  return ![
    "view-tree",
    "view-list",
    "view-sort",
    "view-sort-path",
    "view-sort-name",
    "view-sort-status",
    "fetch",
    "fetch-all",
    "fetch-prune",
    "stash-view",
    "pr-open",
    "pr-refresh",
  ].includes(id);
}

export function isWorkflowViewChecked(
  id: GitWorkflowMenuId,
  presentation: "view-tree" | "view-list",
  sort: "view-sort-path" | "view-sort-name" | "view-sort-status",
): boolean {
  return id === presentation || id === sort;
}

type WorkflowMenuDefinition = Omit<GitWorkflowMenuItem, "disabled" | "disabledReason"> & {
  readonly capability?: GitActionOperation;
};

const WORKFLOW_MENU_DEFINITIONS: ReadonlyArray<WorkflowMenuDefinition> = [
  { id: "view-tree", label: "View as Tree", group: "view", requiresConfirmation: false },
  { id: "view-list", label: "View as List", group: "view", requiresConfirmation: false },
  { id: "view-sort-path", label: "Sort by Path", group: "view", requiresConfirmation: false },
  { id: "view-sort-name", label: "Sort by Name", group: "view", requiresConfirmation: false },
  {
    id: "view-sort-status",
    label: "Sort by Change State",
    group: "view",
    requiresConfirmation: false,
  },
  { id: "commit", label: "Commit", group: "commit", action: "commit", requiresConfirmation: false },
  {
    id: "amend",
    label: "Commit (Amend)",
    group: "commit",
    action: "amend",
    requiresConfirmation: true,
  },
  {
    id: "commit-push",
    label: "Commit & Push",
    group: "commit",
    action: "commit",
    operation: "commit-push",
    requiresConfirmation: true,
  },
  {
    id: "commit-sync",
    label: "Commit & Sync",
    group: "commit",
    action: "commit",
    operation: "commit-sync",
    requiresConfirmation: true,
  },
  {
    id: "commit-publish",
    label: "Commit & Publish Branch",
    group: "commit",
    action: "commit",
    operation: "commit-publish",
    requiresConfirmation: true,
  },
  {
    id: "undo-commit",
    label: "Undo Last Commit",
    group: "commit",
    action: "reset",
    requiresConfirmation: true,
  },
  {
    id: "stage-all",
    label: "Stage All",
    group: "changes",
    action: "discard",
    operation: "stage",
    requiresConfirmation: false,
  },
  {
    id: "unstage-all",
    label: "Unstage All",
    group: "changes",
    action: "discard",
    operation: "unstage",
    requiresConfirmation: false,
  },
  {
    id: "discard-all",
    label: "Discard All",
    group: "changes",
    action: "discard",
    operation: "discard",
    requiresConfirmation: true,
  },
  { id: "fetch", label: "Fetch", group: "sync", requiresConfirmation: false },
  { id: "pull", label: "Pull", group: "sync", requiresConfirmation: true },
  { id: "push", label: "Push", group: "sync", requiresConfirmation: true },
  { id: "sync", label: "Pull, Push", group: "sync", requiresConfirmation: true },
  { id: "publish", label: "Publish Branch", group: "sync", requiresConfirmation: true },
  {
    id: "pull-from",
    label: "Pull From...",
    group: "sync",
    action: "pull",
    requiresConfirmation: true,
  },
  {
    id: "pull-rebase",
    label: "Pull with Rebase",
    group: "sync",
    action: "pull",
    operation: "rebase",
    requiresConfirmation: true,
  },
  { id: "push-to", label: "Push To...", group: "sync", action: "push", requiresConfirmation: true },
  {
    id: "force-push",
    label: "Force Push",
    group: "sync",
    action: "push",
    operation: "force",
    requiresConfirmation: true,
  },
  {
    id: "fetch-all",
    label: "Fetch From All Remotes",
    group: "sync",
    action: "fetch",
    requiresConfirmation: false,
  },
  {
    id: "fetch-prune",
    label: "Fetch Prune",
    group: "sync",
    action: "fetch",
    operation: "prune",
    requiresConfirmation: false,
  },
  {
    id: "checkout",
    label: "Checkout",
    group: "branch",
    requiresConfirmation: true,
    capability: "branch",
  },
  { id: "branch", label: "Branch", group: "branch", requiresConfirmation: true },
  {
    id: "branch-create",
    label: "Create Branch",
    group: "branch",
    action: "branch",
    operation: "create",
    requiresConfirmation: true,
  },
  {
    id: "branch-create-from",
    label: "Create Branch From...",
    group: "branch",
    action: "branch",
    operation: "create",
    requiresConfirmation: true,
  },
  {
    id: "branch-rename",
    label: "Rename Branch",
    group: "branch",
    action: "branch",
    operation: "rename",
    requiresConfirmation: true,
  },
  {
    id: "branch-delete",
    label: "Delete Branch",
    group: "branch",
    action: "branch",
    operation: "delete",
    requiresConfirmation: true,
  },
  {
    id: "branch-delete-remote",
    label: "Delete Remote Branch",
    group: "branch",
    action: "branch",
    operation: "delete-remote",
    requiresConfirmation: true,
  },
  {
    id: "branch-publish",
    label: "Publish Branch",
    group: "branch",
    action: "branch",
    operation: "publish",
    requiresConfirmation: true,
  },
  { id: "merge", label: "Merge", group: "branch", requiresConfirmation: true },
  { id: "rebase", label: "Rebase", group: "branch", requiresConfirmation: true },
  { id: "cherry-pick", label: "Cherry-pick", group: "branch", requiresConfirmation: true },
  { id: "revert", label: "Revert", group: "branch", requiresConfirmation: true },
  { id: "reset", label: "Reset", group: "branch", requiresConfirmation: true },
  { id: "remote", label: "Remote", group: "remote", requiresConfirmation: true },
  {
    id: "remote-add",
    label: "Add Remote",
    group: "remote",
    action: "remote",
    operation: "add",
    requiresConfirmation: true,
  },
  {
    id: "remote-remove",
    label: "Remove Remote",
    group: "remote",
    action: "remote",
    operation: "remove",
    requiresConfirmation: true,
  },
  { id: "stash", label: "Stash", group: "stash", requiresConfirmation: true },
  {
    id: "stash-untracked",
    label: "Stash Including Untracked",
    group: "stash",
    action: "stash",
    operation: "include-untracked",
    requiresConfirmation: true,
  },
  {
    id: "stash-staged",
    label: "Stash Staged",
    group: "stash",
    action: "stash",
    operation: "staged",
    requiresConfirmation: true,
  },
  {
    id: "stash-view",
    label: "View Stash",
    group: "stash",
    action: "stash",
    operation: "view",
    requiresConfirmation: false,
  },
  {
    id: "stash-apply",
    label: "Apply",
    group: "stash",
    action: "stash",
    operation: "apply",
    requiresConfirmation: true,
  },
  {
    id: "stash-pop",
    label: "Pop",
    group: "stash",
    action: "stash",
    operation: "pop",
    requiresConfirmation: true,
  },
  {
    id: "stash-apply-latest",
    label: "Apply Latest",
    group: "stash",
    action: "stash",
    operation: "apply",
    requiresConfirmation: true,
  },
  {
    id: "stash-pop-latest",
    label: "Pop Latest",
    group: "stash",
    action: "stash",
    operation: "pop",
    requiresConfirmation: true,
  },
  {
    id: "stash-drop",
    label: "Drop",
    group: "stash",
    action: "stash",
    operation: "drop",
    requiresConfirmation: true,
  },
  {
    id: "stash-drop-all",
    label: "Drop All",
    group: "stash",
    action: "stash",
    operation: "drop-all",
    requiresConfirmation: true,
  },
  { id: "tag", label: "Tags", group: "tags", requiresConfirmation: true },
  {
    id: "tag-create",
    label: "Create Tag",
    group: "tags",
    action: "tag",
    operation: "create",
    requiresConfirmation: true,
  },
  {
    id: "tag-delete",
    label: "Delete Tag",
    group: "tags",
    action: "tag",
    operation: "delete",
    requiresConfirmation: true,
  },
  {
    id: "tag-push",
    label: "Push Tag",
    group: "tags",
    action: "tag",
    operation: "push",
    requiresConfirmation: true,
  },
  {
    id: "tag-push-all",
    label: "Push All Tags",
    group: "tags",
    action: "tag",
    operation: "push-all",
    requiresConfirmation: true,
  },
  {
    id: "pr-create",
    label: "Create Pull Request",
    group: "pull-request",
    requiresConfirmation: true,
  },
  { id: "pr-open", label: "Open Pull Request", group: "pull-request", requiresConfirmation: false },
  {
    id: "pr-checkout",
    label: "Check Out Pull Request",
    group: "pull-request",
    requiresConfirmation: true,
  },
  {
    id: "pr-refresh",
    label: "Refresh Pull Request",
    group: "pull-request",
    requiresConfirmation: false,
  },
  {
    id: "pr-merge",
    label: "Merge Pull Request",
    group: "pull-request",
    requiresConfirmation: true,
  },
  {
    id: "pr-close",
    label: "Close Pull Request",
    group: "pull-request",
    requiresConfirmation: true,
  },
  {
    id: "conflict-continue",
    label: "Continue Conflict",
    group: "conflict",
    action: "conflict",
    operation: "continue",
    requiresConfirmation: true,
  },
  {
    id: "conflict-abort",
    label: "Abort Conflict",
    group: "conflict",
    action: "conflict",
    operation: "abort",
    requiresConfirmation: true,
  },
  {
    id: "worktree",
    label: "Worktree",
    group: "branch",
    requiresConfirmation: true,
    capability: "branch",
  },
];

/**
 * One capability-gated menu model shared by the panel, command entry points,
 * and the header portal. Unsupported operations stay visible with a reason so
 * an older server never produces a dead click.
 */
export function buildWorkflowMenuItems(
  gitStatus: VcsStatusResult | null,
  capabilities: GitRepositoryCapabilities | undefined,
  isBusy: boolean,
  pullRequest?: {
    readonly providerAvailable: boolean;
    readonly authenticated: boolean;
    readonly hasPullRequest: boolean;
    readonly hasReference: boolean;
    /** Detail-derived host and viewer actions. Provider leaves fail closed until it is ready. */
    readonly detailStatus?: "loading" | "failed" | "ready";
    readonly actions?: ReadonlySet<string>;
    readonly viewerActions?: ReadonlySet<string>;
  },
  reviewedSnapshot = reviewedGitSnapshotAvailability({
    status: gitStatus,
    isPending: false,
    hasError: false,
  }),
): GitWorkflowMenuItem[] {
  const supported = new Set<GitActionOperation>(capabilities?.actions ?? []);
  const hasChanges = gitStatus?.hasWorkingTreeChanges === true;
  const hasStaged = (gitStatus?.workingTree.stagedCount ?? 0) > 0;
  const hasBranch = gitStatus?.refName !== null && gitStatus?.refName !== undefined;
  const hasRemote = gitStatus?.hasPrimaryRemote === true;
  const hasUpstream = gitStatus?.hasUpstream === true;
  const hasActiveConflict = gitStatus?.activeConflictOperation !== undefined;
  return WORKFLOW_MENU_DEFINITIONS.map((item) => {
    const capability = item.capability ?? item.action ?? (item.id as GitActionOperation);
    const action = item.action ?? (item.id as GitActionOperation);
    const hasHead = gitStatus?.headCommit !== null && gitStatus?.headCommit !== undefined;
    const unavailableReason = isBusy
      ? "A Git action is already running."
      : workflowActionRequiresReviewedSnapshot(item.id) && !reviewedSnapshot.available
        ? reviewedSnapshot.reason
        : item.id.startsWith("pr-") && !pullRequest?.providerAvailable
          ? "No pull request provider is available for this repository."
          : item.id.startsWith("pr-") && pullRequest?.authenticated !== true
            ? "Authenticate the repository's pull request provider before using this action."
            : item.id !== "pr-create" &&
                item.id.startsWith("pr-") &&
                pullRequest?.hasReference !== true
              ? "The selected repository has no pull request repository identity."
              : item.id !== "pr-create" &&
                  item.id.startsWith("pr-") &&
                  pullRequest?.hasPullRequest !== true
                ? "No pull request is open for the checked-out branch."
                : (item.id === "pr-merge" || item.id === "pr-close") &&
                    pullRequest?.detailStatus === "failed"
                  ? "Pull request details failed to load. Refresh and try again."
                  : (item.id === "pr-merge" || item.id === "pr-close") &&
                      pullRequest?.detailStatus !== "ready"
                    ? "Loading pull request permissions and capabilities."
                    : item.id === "stash-staged" && capabilities?.supportsStashStaged !== true
                      ? "Stash Staged requires Git 2.35 or later on the connected server."
                      : item.id === "pr-merge" &&
                          pullRequest?.actions !== undefined &&
                          !pullRequest.actions.has("merge")
                        ? "This pull request provider cannot merge change requests."
                        : item.id === "pr-close" &&
                            pullRequest?.actions !== undefined &&
                            !pullRequest.actions.has("close")
                          ? "This pull request provider cannot close change requests."
                          : (item.id === "pr-merge" || item.id === "pr-close") &&
                              pullRequest?.viewerActions !== undefined &&
                              !pullRequest.viewerActions.has(
                                item.id === "pr-merge" ? "merge" : "close",
                              )
                            ? `The signed-in account cannot ${item.id === "pr-merge" ? "merge" : "close"} this pull request.`
                            : !item.id.startsWith("pr-") &&
                                item.id !== "view-tree" &&
                                item.id !== "view-list" &&
                                item.id !== "view-sort-path" &&
                                item.id !== "view-sort-name" &&
                                item.id !== "view-sort-status" &&
                                !supported.has(capability)
                              ? "This Git action is unavailable on the connected server."
                              : item.id === "commit" && !hasStaged
                                ? "Stage changes before committing."
                                : (item.id === "commit-push" ||
                                      item.id === "commit-sync" ||
                                      item.id === "commit-publish") &&
                                    !hasStaged
                                  ? "Stage changes before committing."
                                  : (item.id === "commit-push" ||
                                        item.id === "commit-sync" ||
                                        item.id === "commit-publish") &&
                                      !hasBranch
                                    ? "Detached HEAD: check out a branch before committing and publishing."
                                    : (item.id === "commit-push" ||
                                          item.id === "commit-sync" ||
                                          item.id === "commit-publish") &&
                                        !hasRemote
                                      ? "Add a remote before committing and publishing."
                                      : item.id === "commit-sync" && !hasUpstream
                                        ? "Set an upstream branch before committing and syncing."
                                        : item.id === "amend" &&
                                            (!hasBranch ||
                                              gitStatus?.headCommit === null ||
                                              gitStatus?.headCommit === undefined)
                                          ? "A previous commit and a checked-out branch are required to amend."
                                          : item.id === "undo-commit" &&
                                              gitStatus?.headHasParent === false
                                            ? "A parent commit is required to undo the last commit."
                                            : (item.id === "undo-commit" ||
                                                  action === "merge" ||
                                                  action === "rebase" ||
                                                  action === "cherry-pick" ||
                                                  action === "revert" ||
                                                  action === "reset") &&
                                                !hasHead
                                              ? "A committed HEAD is required for this operation."
                                              : (action === "branch" || item.id === "checkout") &&
                                                  !hasBranch &&
                                                  item.id !== "branch-create" &&
                                                  item.id !== "branch-create-from"
                                                ? "Detached HEAD: create a branch before changing branch state."
                                                : (item.id === "discard" ||
                                                      item.id === "discard-all" ||
                                                      item.id === "stage-all") &&
                                                    !hasChanges
                                                  ? "The working tree is clean."
                                                  : item.id === "unstage-all" && !hasStaged
                                                    ? "There are no staged changes to unstage."
                                                    : action === "stash" &&
                                                        (item.id === "stash" ||
                                                          item.id === "stash-untracked") &&
                                                        !hasChanges
                                                      ? "The working tree is clean."
                                                      : action === "stash" &&
                                                          (item.id === "stash" ||
                                                            item.id === "stash-untracked") &&
                                                          !hasHead
                                                        ? "A committed HEAD is required to create a stash."
                                                        : item.id === "stash-staged" && !hasStaged
                                                          ? "Stage changes before stashing the index."
                                                          : item.id === "stash-staged" && !hasHead
                                                            ? "A committed HEAD is required to create a stash."
                                                            : item.id === "tag-create" && !hasHead
                                                              ? "A committed HEAD is required to create a tag."
                                                              : (item.id === "fetch" ||
                                                                    item.id === "fetch-all" ||
                                                                    item.id === "fetch-prune") &&
                                                                  !hasRemote
                                                                ? "Add a remote before fetching."
                                                                : (item.id === "pull" ||
                                                                      item.id === "push" ||
                                                                      item.id === "sync" ||
                                                                      item.id === "publish" ||
                                                                      item.id === "pull-from" ||
                                                                      item.id === "pull-rebase" ||
                                                                      item.id === "push-to" ||
                                                                      item.id === "force-push" ||
                                                                      item.id ===
                                                                        "branch-publish") &&
                                                                    !hasBranch
                                                                  ? "Detached HEAD: check out a branch before this operation."
                                                                  : (item.id === "pull" ||
                                                                        item.id === "sync" ||
                                                                        item.id ===
                                                                          "pull-rebase") &&
                                                                      !hasUpstream
                                                                    ? "Set an upstream branch before pulling or syncing."
                                                                    : (item.id === "push" ||
                                                                          item.id === "publish" ||
                                                                          item.id === "push-to" ||
                                                                          item.id ===
                                                                            "force-push" ||
                                                                          item.id ===
                                                                            "branch-publish" ||
                                                                          item.id ===
                                                                            "branch-delete-remote" ||
                                                                          item.id === "tag-push" ||
                                                                          item.id ===
                                                                            "tag-push-all") &&
                                                                        !hasRemote
                                                                      ? "Add a remote before pushing or publishing."
                                                                      : (item.id ===
                                                                            "conflict-continue" ||
                                                                            item.id ===
                                                                              "conflict-abort") &&
                                                                          !hasActiveConflict
                                                                        ? "No active conflict operation to continue or abort."
                                                                        : null;
    return {
      ...item,
      disabled: unavailableReason !== null,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    };
  });
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

/** `all` deliberately omits paths so Git retains whole-tree semantics. */
export type GitCommitFileSelection =
  | { readonly mode: "all" }
  | { readonly mode: "paths"; readonly paths: ReadonlySet<string> };

export function buildGitCommitFilePaths(selection: GitCommitFileSelection): string[] | undefined {
  return selection.mode === "all" ? undefined : [...selection.paths];
}

/** Snapshot sequence IDs are scoped to one environment repository. */
export function workingTreeSnapshotScope(
  environmentId: string | null,
  cwd: string | null,
  snapshotId: string | null,
): string {
  return `${environmentId ?? ""}\0${cwd ?? ""}\0${snapshotId ?? ""}`;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
  terminology?: ChangeRequestTerminology;
}): string[] {
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  const branchStages = input.featureBranch ? ["Preparing feature ref..."] : [];
  const pushStage = input.pushTarget ? `Pushing to ${input.pushTarget}...` : "Pushing...";
  const prStages = [
    `Preparing ${terminology.shortLabel}...`,
    `Generating ${terminology.shortLabel} content...`,
    `Creating ${terminology.singular}...`,
  ];

  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages = input.action === "commit" || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["Committing..."]
      : ["Generating commit message...", "Committing..."];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  return [
    commitItem,
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: `View ${terminology.shortLabel}`,
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: `Create ${terminology.shortLabel}`,
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  reviewedSnapshot = reviewedGitSnapshotAvailability({
    status: gitStatus,
    isPending: false,
    hasError: false,
  }),
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  if (!reviewedSnapshot.available) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: reviewedSnapshot.reason };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    // Opening a PR is a separate provider operation. Keeping it out of the
    // commit primary action prevents the legacy auto-staging stack from
    // reappearing here; users commit/push the reviewed index, then create the
    // PR from its explicit action.
    return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  repositoryRoot?: string;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const repositoryLabel = input.repositoryRoot ? ` in repository "${input.repositoryRoot}"` : "";
  const suffix = ` on "${branchLabel}"${repositoryLabel}. You can continue on this ref or create a feature ref and run the same action there.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default ref?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: "Push to default ref?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
