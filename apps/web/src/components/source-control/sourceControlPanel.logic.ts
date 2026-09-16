import * as Cause from "effect/Cause";
import type {
  GitCommitGraphCommit,
  GitCommitIndexInput,
  ModelSelection,
  ServerProvider,
  VcsIndexStatus,
  VcsMutationRejectionCode,
  VcsWorkingTreeFile,
} from "@t3tools/contracts";

export type SourceControlPanelView = "changes" | "graph" | "pull-requests";

export type SourceControlFileView = {
  readonly tree: boolean;
  readonly sort: "path" | "name" | "status";
};

export function nextSourceControlView(
  current: SourceControlFileView,
  action:
    | "view-tree"
    | "view-list"
    | "view-sort"
    | "view-sort-path"
    | "view-sort-name"
    | "view-sort-status",
): SourceControlFileView {
  if (action === "view-tree") return { ...current, tree: true };
  if (action === "view-list") return { ...current, tree: false };
  if (action === "view-sort-path") return { ...current, sort: "path" };
  if (action === "view-sort-name") return { ...current, sort: "name" };
  if (action === "view-sort-status") return { ...current, sort: "status" };
  return {
    ...current,
    sort: current.sort === "path" ? "name" : current.sort === "name" ? "status" : "path",
  };
}

export function formatCompoundActionFailure(
  completed: readonly string[],
  failedStep: string,
): string {
  return `${completed.join(" then ")} completed, but ${failedStep} failed. Review the repository before retrying.`;
}

/** Precise, ordered copy for the composer confirmation boundary. */
export function sourceControlConfirmationDescription(input: {
  readonly action:
    | "pull"
    | "push"
    | "sync"
    | "publish"
    | "publish-repository"
    | "commit_push"
    | "commit_sync"
    | "commit_publish";
  readonly repositoryRoot: string;
  readonly branch: string;
  /** The destination for publishing local commits. */
  readonly remoteName?: string;
  readonly remoteRefName?: string;
  /** The upstream source used by Pull and the pull half of Sync. */
  readonly pullRemoteName?: string;
  readonly pullRefName?: string;
}): string {
  const publicationTarget = input.remoteName
    ? `${input.remoteName}${input.remoteRefName ? `/${input.remoteRefName}` : ""}`
    : "the selected remote";
  const pullTarget = input.pullRemoteName
    ? `${input.pullRemoteName}${input.pullRefName ? `/${input.pullRefName}` : ""}`
    : publicationTarget;
  const scope = `Repository ${input.repositoryRoot}, branch ${input.branch}`;
  switch (input.action) {
    case "pull":
      return `${scope}: pull from remote ${pullTarget}.`;
    case "commit_push":
      return `${scope}: commit the reviewed staged changes, then push to remote ${publicationTarget}.`;
    case "commit_sync":
      return `${scope}: commit the reviewed staged changes, pull from remote ${pullTarget}, then push to remote ${publicationTarget}.`;
    case "commit_publish":
      return `${scope}: commit the reviewed staged changes, then publish this branch to remote ${publicationTarget}.`;
    case "sync":
      return `${scope}: pull from remote ${pullTarget}, then push to remote ${publicationTarget}.`;
    case "publish":
      return `${scope}: publish this branch to remote ${publicationTarget}.`;
    case "publish-repository":
      return `Repository ${input.repositoryRoot}: create and connect a remote before publishing.`;
    case "push":
      return `${scope}: push local commits to remote ${publicationTarget}.`;
  }
}

export interface SourceControlWriterAvailability {
  readonly ready: boolean;
  readonly reason: string | null;
}

/** Resolve the actual selected writer, not merely whether any provider exists. */
export function resolveSourceControlWriterAvailability(input: {
  readonly textGenerationModelSelection: ModelSelection | null | undefined;
  readonly sourceControlWriterModelSelection: ModelSelection | null | undefined;
  readonly providers: readonly ServerProvider[];
}): SourceControlWriterAvailability {
  // Keep this resolution in lock-step with ServerSettings.resolveSourceControlWriterModelSelection:
  // a disabled or unavailable source-control override must not hide a healthy
  // general text-generation writer.
  const override = input.sourceControlWriterModelSelection;
  const overrideProvider = override
    ? input.providers.find((candidate) => candidate.instanceId === override.instanceId)
    : undefined;
  const selection =
    override === undefined ||
    override === null ||
    overrideProvider === undefined ||
    !overrideProvider.enabled ||
    overrideProvider.availability === "unavailable" ||
    overrideProvider.status === "disabled"
      ? input.textGenerationModelSelection
      : override;
  if (!selection)
    return { ready: false, reason: "Choose a text-generation writer model before generating." };
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (!provider)
    return { ready: false, reason: "The selected commit-message writer is unavailable." };
  if (provider.supportsTextGeneration === false)
    return { ready: false, reason: "The selected provider cannot generate commit messages." };
  if (
    !provider.enabled ||
    provider.availability === "unavailable" ||
    provider.status === "disabled"
  )
    return { ready: false, reason: "Enable the selected commit-message writer before generating." };
  if (provider.auth.status === "unauthenticated")
    return {
      ready: false,
      reason: "Authenticate the selected commit-message writer before generating.",
    };
  if (provider.status !== "ready")
    return {
      ready: false,
      reason: provider.message ?? "The selected commit-message writer is not ready.",
    };
  if (!provider.models.some((model) => model.slug === selection.model))
    return { ready: false, reason: "The selected commit-message model is unavailable." };
  return { ready: true, reason: null };
}

export function sourceControlGenerateDisabledReason(input: {
  readonly stagedCount: number;
  readonly generating: boolean;
  readonly writer: SourceControlWriterAvailability;
  readonly instructionsRequired?: boolean;
  readonly hasInstructions?: boolean;
}): string | null {
  if (input.stagedCount === 0)
    return "Stage at least one change before generating a commit message.";
  if (!input.writer.ready)
    return input.writer.reason ?? "The commit-message writer is unavailable.";
  if (input.instructionsRequired && !input.hasInstructions)
    return "Add instructions before generating with custom guidance.";
  if (input.generating) return "Generating a commit message.";
  return null;
}

export type SourceControlPrimaryAction =
  | "commit"
  | "amend"
  | "commit-push"
  | "commit-sync"
  | "commit-publish"
  | "push"
  | "publish"
  | "publish-repository";

export function derivePrimarySourceControlAction(input: {
  readonly selectedAction: "commit" | "amend" | "commit-push" | "commit-sync";
  readonly stagedCount: number;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly hasPrimaryRemote: boolean;
  readonly hasUpstream: boolean;
  readonly commitIdentityReady?: boolean;
  /** Read from the selected remote's hosting-provider credential probe. */
  readonly remoteCredentialReady?: boolean;
  readonly remoteCredentialReason?: string;
  readonly refName: string | null | undefined;
  readonly activeConflictOperation: "merge" | "rebase" | "cherry-pick" | "revert" | undefined;
  readonly statusFresh: boolean;
  /** Exact shared reviewed-snapshot reason, when the status cannot be mutated safely. */
  readonly statusFreshReason?: string;
  readonly busy: boolean;
}): {
  readonly action: SourceControlPrimaryAction;
  readonly enabled: boolean;
  readonly reason: string | null;
} {
  // An explicit amend is a message/ref replacement and must never be displaced
  // by an incidental ahead count.
  const selected = input.selectedAction;
  const publication =
    input.stagedCount === 0 && input.aheadCount > 0 && selected === "commit"
      ? input.hasUpstream
        ? "push"
        : input.hasPrimaryRemote
          ? "publish"
          : "publish-repository"
      : selected === "commit-push" && input.hasPrimaryRemote && !input.hasUpstream
        ? "commit-publish"
        : selected;
  if (input.busy)
    return {
      action: publication,
      enabled: false,
      reason: "Another source-control operation is running.",
    };
  if (!input.statusFresh)
    return {
      action: publication,
      enabled: false,
      reason: input.statusFreshReason ?? "Refresh repository status before publishing.",
    };
  if (input.activeConflictOperation)
    return {
      action: publication,
      enabled: false,
      reason: `Resolve the active ${input.activeConflictOperation} before publishing.`,
    };
  if (input.refName == null && publication !== "publish-repository")
    return { action: publication, enabled: false, reason: "Check out a branch before publishing." };
  if (
    input.commitIdentityReady === false &&
    (publication === "commit" ||
      publication === "amend" ||
      publication === "commit-push" ||
      publication === "commit-sync" ||
      publication === "commit-publish")
  )
    return {
      action: publication,
      enabled: false,
      reason: "Configure Git user.name and user.email before committing.",
    };
  if (publication === "commit-push" && !input.hasPrimaryRemote)
    return {
      action: publication,
      enabled: false,
      reason: "Add or publish a remote before pushing.",
    };
  if (publication === "commit-sync" && !input.hasPrimaryRemote)
    return {
      action: publication,
      enabled: false,
      reason: "Add a remote before committing and syncing.",
    };
  if (publication === "commit-sync" && !input.hasUpstream)
    return {
      action: publication,
      enabled: false,
      reason: "Set an upstream branch before committing and syncing.",
    };
  if (
    input.remoteCredentialReady === false &&
    (publication === "push" ||
      publication === "publish" ||
      publication === "commit-push" ||
      publication === "commit-publish" ||
      publication === "commit-sync")
  )
    return {
      action: publication,
      enabled: false,
      reason: input.remoteCredentialReason ?? "Authenticate the selected remote before publishing.",
    };
  if (publication === "push" && !input.hasUpstream)
    return { action: publication, enabled: false, reason: "Publish this branch before pushing." };
  if (
    publication === "push" ||
    publication === "publish" ||
    publication === "commit-push" ||
    publication === "commit-publish" ||
    publication === "commit-sync"
  ) {
    if (input.behindCount > 0 && input.aheadCount > 0)
      return {
        action: publication,
        enabled: false,
        reason: "Sync this diverged branch before publishing.",
      };
    if (input.behindCount > 0)
      return {
        action: publication,
        enabled: false,
        reason: "Pull or Sync before publishing this branch.",
      };
  }
  return { action: publication, enabled: true, reason: null };
}

export function sourceControlComposerDraftKey(
  environmentId: string,
  threadId: string,
  repositoryRoot: string,
): string {
  return `${environmentId}\0${threadId}\0${repositoryRoot}`;
}

export function graphCommitRowLabel(
  commit: Pick<GitCommitGraphCommit, "subject" | "refs">,
): string {
  return commit.refs.length > 0
    ? `${commit.subject} · ${commit.refs.map((ref) => ref.name).join(", ")}`
    : commit.subject;
}

/**
 * Keeps refresh reconciliation proportional to the rendered graph window.
 *
 * A refresh may need to read to EOF to prove that a previously selected row
 * disappeared.  Do not keep that history just to make that determination:
 * the HEAD prefix, a rolling tail, and one protected candidate are enough to
 * select the eventual contiguous window.
 */
export function createBoundedGraphRefreshWindow<T extends { readonly sha: string }>(input: {
  readonly limit: number;
  /**
   * The normal replay size. Storage remains capped by `limit`, but a graph
   * that has only loaded one page should not grow to the full cap just because
   * it is being refreshed.
   */
  readonly windowLimit?: number;
  readonly selectedSha: string | null;
  readonly anchorSha: string | null;
}) {
  const windowLimit = Math.max(1, Math.min(input.windowLimit ?? input.limit, input.limit));
  const head: T[] = [];
  const rolling: Array<T | undefined> = Array.from({ length: input.limit });
  const headShas = new Set<string>();
  const rollingShas = new Set<string>();
  let candidate: { readonly start: number; readonly commits: readonly T[] } | null = null;
  let rollingStartIndex = 0;
  let rollingCount = 0;
  let selectedIndex = -1;
  let anchorIndex = -1;
  let count = 0;
  let maxRetainedCommitCount = 0;

  const selectedTarget = () => {
    if (selectedIndex < 0) return null;
    if (selectedIndex < windowLimit) return { start: 0, end: windowLimit };
    const start = Math.max(0, selectedIndex - windowLimit + 1);
    return { start, end: start + windowLimit };
  };
  const target = () => {
    if (selectedIndex >= 0 && anchorIndex >= 0) {
      const start = Math.min(selectedIndex, anchorIndex);
      const end = Math.max(selectedIndex, anchorIndex) + 1;
      // Keep the ordinary loaded HEAD prefix when it already contains both
      // protections. Replaying a one-page graph must not turn into extra
      // pages merely because a user has scrolled within that page.
      if (end <= windowLimit) return { start: 0, end: windowLimit };
      // The rendered graph is allowed to grow up to its storage cap while it
      // reconciles a pair. Only make selection win when their actual span no
      // longer fits, rather than treating the old loaded-page size as a cap.
      if (end - start <= input.limit) return { start, end };
      // Keep this identical to the selected-only target. A later,
      // incompatible anchor must not discard an already retained selection
      // in favor of a range which has fallen out of bounded storage.
      return selectedTarget()!;
    }
    const selected = selectedTarget();
    if (selected) return selected;
    if (anchorIndex >= 0) {
      if (anchorIndex < windowLimit) return { start: 0, end: windowLimit };
      const start = Math.max(0, anchorIndex - windowLimit + 1);
      return { start, end: start + windowLimit };
    }
    return { start: 0, end: windowLimit };
  };
  const fromRetained = (start: number, end: number) => {
    const rollingStart = count - rollingCount;
    if (start >= rollingStart) {
      const commits: T[] = [];
      for (let index = start; index < Math.min(end, count); index += 1) {
        const commit = rolling[(rollingStartIndex + index - rollingStart) % input.limit];
        if (commit) commits.push(commit);
      }
      return commits;
    }
    if (start >= 0 && end <= head.length) return head.slice(start, end);
    return null;
  };
  const rememberCandidate = () => {
    const desired = target();
    const desiredLength = desired.end - desired.start;
    if (candidate?.start === desired.start && candidate.commits.length === desiredLength) return;
    if (count < desired.end) return;
    const commits = fromRetained(desired.start, desired.end);
    if (commits) candidate = { start: desired.start, commits };
  };
  const recordSize = () => {
    maxRetainedCommitCount = Math.max(
      maxRetainedCommitCount,
      head.length + rollingCount + (candidate?.commits.length ?? 0),
    );
  };

  return {
    push(commit: T) {
      // Cursor paging can overlap at a page boundary.  These sets stay
      // bounded, unlike a full-history refresh map.
      if (headShas.has(commit.sha) || rollingShas.has(commit.sha)) return false;
      const index = count;
      count += 1;
      if (head.length < input.limit) {
        head.push(commit);
        headShas.add(commit.sha);
      }
      if (rollingCount < input.limit) {
        rolling[(rollingStartIndex + rollingCount) % input.limit] = commit;
        rollingCount += 1;
      } else {
        const removed = rolling[rollingStartIndex];
        if (removed) rollingShas.delete(removed.sha);
        rolling[rollingStartIndex] = commit;
        rollingStartIndex = (rollingStartIndex + 1) % input.limit;
      }
      rollingShas.add(commit.sha);
      if (commit.sha === input.selectedSha) selectedIndex = index;
      if (commit.sha === input.anchorSha) anchorIndex = index;
      // A lone protection needs a durable snapshot because the other one may
      // be absent and require an EOF scan.  Once both arrive, target() swaps
      // this to their exact shared window when enough rows have been seen.
      rememberCandidate();
      recordSize();
      return true;
    },
    target,
    get count() {
      return count;
    },
    get selectedFound() {
      return selectedIndex >= 0;
    },
    get anchorFound() {
      return anchorIndex >= 0;
    },
    get head() {
      return head;
    },
    finish() {
      const desired = target();
      const commits =
        candidate?.start === desired.start
          ? candidate.commits
          : (fromRetained(desired.start, desired.end) ?? head);
      return {
        commits,
        start: desired.start,
        end: Math.min(desired.end, count),
        maxRetainedCommitCount,
      };
    },
  };
}

export function sourceControlPanelTabs(
  providerName?: string,
  changeRequestLabel = "Pull Requests",
): ReadonlyArray<{
  readonly id: SourceControlPanelView;
  readonly label: string;
}> {
  return [
    { id: "changes", label: "Changes" },
    { id: "graph", label: "Graph" },
    {
      id: "pull-requests",
      label: providerName ? `${providerName} ${changeRequestLabel}` : changeRequestLabel,
    },
  ];
}

export function moveSourceControlTab(
  current: SourceControlPanelView,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): SourceControlPanelView {
  const tabs: readonly SourceControlPanelView[] = ["changes", "graph", "pull-requests"];
  const index = tabs.indexOf(current);
  if (key === "Home") return tabs[0]!;
  if (key === "End") return tabs[tabs.length - 1]!;
  return tabs[(index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
}

export function gitIndexWorkflowAvailability(
  capabilityKnown: boolean,
  supported: boolean,
): "loading" | "unsupported" | "available" {
  if (!capabilityKnown) return "loading";
  return supported ? "available" : "unsupported";
}

/** Amend is always an explicit mutation confirmation, including feature refs. */
export function requiresAmendConfirmation(amend: boolean): boolean {
  return amend;
}

export function fileAction(
  indexStatus: VcsIndexStatus | undefined,
): ReadonlyArray<"stage" | "unstage"> | null {
  if (indexStatus === "staged") return ["unstage"];
  if (indexStatus === "both") return ["unstage", "stage"];
  if (indexStatus === "unstaged" || indexStatus === "untracked") return ["stage"];
  // Staging a conflicted path is how Git records a manual resolution. This panel does not
  // implement conflict resolution, so it deliberately offers neither index mutation.
  if (indexStatus === "conflicted") return [];
  return null;
}

export function sourceControlFileStatusLabel(indexStatus: VcsIndexStatus | undefined): string {
  switch (indexStatus) {
    case "staged":
      return "Staged";
    case "both":
      return "Staged + modified";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflict";
    case "unstaged":
      return "Modified";
    default:
      return "Index state unavailable";
  }
}

export interface SourceControlFileGroup {
  readonly id: "staged" | "unstaged" | "conflicts";
  readonly label: string;
  readonly files: readonly VcsWorkingTreeFile[];
}

export type SourceControlFileTreeNode =
  | { readonly kind: "directory"; readonly path: string; readonly depth: number }
  | { readonly kind: "file"; readonly path: string; readonly depth: number };

/**
 * Directory rows are data, rather than whitespace baked into filenames, so
 * tree mode has stable structure and works with every sort order.
 */
export function buildSourceControlFileTree<T extends { readonly path: string }>(
  files: readonly T[],
  compareFiles: (left: T, right: T) => number = (left, right) =>
    left.path.localeCompare(right.path),
): readonly SourceControlFileTreeNode[] {
  type Directory = {
    readonly path: string;
    readonly directories: Map<string, Directory>;
    readonly files: T[];
  };
  const root: Directory = { path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let directory = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      const childPath = directory.path ? `${directory.path}/${name}` : name;
      let child = directory.directories.get(name);
      if (!child) {
        child = { path: childPath, directories: new Map(), files: [] };
        directory.directories.set(name, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  const firstFile = (directory: Directory): T | undefined => {
    const own = [...directory.files].toSorted(compareFiles)[0];
    const nested = Array.from(directory.directories.values())
      .map(firstFile)
      .filter((file): file is T => file !== undefined)
      .toSorted(compareFiles)[0];
    if (!own) return nested;
    if (!nested) return own;
    return compareFiles(own, nested) <= 0 ? own : nested;
  };
  const nodes: SourceControlFileTreeNode[] = [];
  const flatten = (directory: Directory, depth: number) => {
    const children: Array<
      | { readonly kind: "directory"; readonly value: Directory }
      | { readonly kind: "file"; readonly value: T }
    > = [
      ...Array.from(directory.directories.values(), (value) => ({
        kind: "directory" as const,
        value,
      })),
      ...directory.files.map((value) => ({ kind: "file" as const, value })),
    ];
    children.sort((left, right) => {
      const leftFile = left.kind === "file" ? left.value : firstFile(left.value);
      const rightFile = right.kind === "file" ? right.value : firstFile(right.value);
      if (!leftFile || !rightFile) return 0;
      return compareFiles(leftFile, rightFile);
    });
    for (const child of children) {
      if (child.kind === "file") {
        nodes.push({ kind: "file", path: child.value.path, depth });
      } else {
        nodes.push({ kind: "directory", path: child.value.path, depth });
        flatten(child.value, depth + 1);
      }
    }
  };
  flatten(root, 0);
  return nodes;
}

/** Render mixed-index files in both groups so staged and unstaged hunks stay independently actionable. */
export function groupWorkingTreeFiles(
  files: readonly VcsWorkingTreeFile[],
): readonly SourceControlFileGroup[] {
  const staged = files.filter(
    (file) => file.indexStatus === "staged" || file.indexStatus === "both",
  );
  const conflicts = files.filter((file) => file.indexStatus === "conflicted");
  const unstaged = files.filter(
    (file) =>
      file.indexStatus === "unstaged" ||
      file.indexStatus === "untracked" ||
      file.indexStatus === "both",
  );
  const groups: SourceControlFileGroup[] = [
    { id: "staged", label: "Staged Changes", files: staged },
    { id: "unstaged", label: "Unstaged Changes", files: unstaged },
    { id: "conflicts", label: "Conflicts", files: conflicts },
  ];
  return groups.filter((group) => group.files.length > 0);
}

export function buildSourceControlCommitInput(input: {
  readonly cwd: string;
  readonly message: string;
  readonly headCommit: string | null | undefined;
  readonly indexTree: string | undefined;
  readonly refName: string | null | undefined;
  readonly pendingMergeHeads: readonly string[] | undefined;
  readonly confirmDefaultRef: boolean;
  readonly amend?: boolean;
}): GitCommitIndexInput {
  return {
    cwd: input.cwd,
    message: input.message.trim(),
    ...(input.headCommit !== undefined &&
    input.indexTree !== undefined &&
    input.refName !== undefined
      ? {
          precondition: {
            expectedHeadCommit: input.headCommit,
            expectedIndexTree: input.indexTree,
            expectedRefName: input.refName,
            ...(input.pendingMergeHeads === undefined
              ? {}
              : { expectedMergeHeads: input.pendingMergeHeads }),
          },
        }
      : {}),
    ...(input.confirmDefaultRef ? { confirmDefaultRef: true } : {}),
    ...(input.amend ? { amend: true } : {}),
  };
}

export function gitMutationRejectionCode<E>(
  cause: Cause.Cause<E>,
): VcsMutationRejectionCode | undefined {
  const error = Cause.squash(cause);
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return code === "dirty_worktree_confirmation_required" ||
    code === "default_ref_confirmation_required" ||
    code === "stale_git_state"
    ? code
    : undefined;
}

export const SOURCE_CONTROL_STALE_STATE_MESSAGE =
  "Repository changed; review the staged changes and try again.";

export function canSubmitSourceControlCommit(input: {
  readonly workflowAvailable: boolean;
  readonly stagedCount: number;
  readonly message: string;
  readonly reviewedStateAvailable: boolean;
  readonly hasReviewedBranch: boolean;
  readonly hasReviewedMerge?: boolean;
}): boolean {
  return (
    input.workflowAvailable &&
    (input.stagedCount > 0 || !!input.hasReviewedMerge) &&
    input.message.trim().length > 0 &&
    input.reviewedStateAvailable &&
    input.hasReviewedBranch
  );
}

export async function handleSourceControlCommitFailure<E>(
  result: { readonly cause: Cause.Cause<E> },
  callbacks: {
    readonly refreshStatus: () => void | Promise<void>;
    readonly setError: (message: string) => void;
  },
): Promise<boolean> {
  if (gitMutationRejectionCode(result.cause) !== "stale_git_state") return false;
  await callbacks.refreshStatus();
  callbacks.setError(SOURCE_CONTROL_STALE_STATE_MESSAGE);
  return true;
}
