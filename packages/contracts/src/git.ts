import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind, VcsMutationRejectionCode } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GitPath = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.makeFilter((path) => !path.includes("\u0000") || "Git paths must not contain NUL."),
);
const GitObjectId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^[0-9a-f]{40}$/iu.test(value) || "Git object ids must be 40 hexadecimal characters.",
  ),
);
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);

export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

export const VcsIndexStatus = Schema.Literals([
  "staged",
  "unstaged",
  "both",
  "untracked",
  "conflicted",
]);
export type VcsIndexStatus = typeof VcsIndexStatus.Type;

export const VcsWorkingTreeFile = Schema.Struct({
  path: GitPath,
  /** Git's two path sides, kept for adds, deletes, and renames. */
  oldPath: Schema.optional(Schema.NullOr(GitPath)),
  newPath: Schema.optional(Schema.NullOr(GitPath)),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Omitted by older servers that predate index operations. */
  indexStatus: Schema.optional(VcsIndexStatus),
  /** Per-comparison path sides. A file may be staged and then changed again. */
  indexOldPath: Schema.optional(Schema.NullOr(GitPath)),
  indexNewPath: Schema.optional(Schema.NullOr(GitPath)),
  worktreeOldPath: Schema.optional(Schema.NullOr(GitPath)),
  worktreeNewPath: Schema.optional(Schema.NullOr(GitPath)),
});
export type VcsWorkingTreeFile = typeof VcsWorkingTreeFile.Type;

export const GitMutationPrecondition = Schema.Struct({
  expectedHeadCommit: Schema.NullOr(Schema.String),
  expectedIndexTree: Schema.String,
  expectedRefName: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  expectedMergeHeads: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type GitMutationPrecondition = typeof GitMutationPrecondition.Type;

/**
 * Repository-scoped Source Control additions. They are intentionally additive
 * so older clients can continue to use the status and stacked-action RPCs.
 */
export const GitRepositoryDiscoveryInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  maxRepositories: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(256))),
});
export type GitRepositoryDiscoveryInput = typeof GitRepositoryDiscoveryInput.Type;

export const GitActionOperation = Schema.Literals([
  "commit",
  "amend",
  "push",
  "pull",
  "fetch",
  "sync",
  "publish",
  "branch",
  "remote",
  "stash",
  "tag",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "discard",
  "conflict",
]);
export type GitActionOperation = typeof GitActionOperation.Type;

export const GitRepositoryCapabilities = Schema.Struct({
  actions: Schema.Array(GitActionOperation),
  supportsIndexWorkflow: Schema.Boolean,
  /** `git stash push --staged` was added in Git 2.35. Older Git installs must not offer it. */
  supportsStashStaged: Schema.optionalKey(Schema.Boolean),
});
export type GitRepositoryCapabilities = typeof GitRepositoryCapabilities.Type;

export const GitRepositoryDescriptor = Schema.Struct({
  rootPath: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema,
  commonDir: TrimmedNonEmptyStringSchema,
  isSubmodule: Schema.Boolean,
  provider: Schema.NullOr(SourceControlProviderInfo),
  capabilities: Schema.optional(GitRepositoryCapabilities),
  /** Present when Git reports a repository path that cannot currently be opened. */
  unavailableReason: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitRepositoryDescriptor = typeof GitRepositoryDescriptor.Type;

export const GitRepositoryDiscoveryResult = Schema.Struct({
  projectRoot: TrimmedNonEmptyStringSchema,
  repositories: Schema.Array(GitRepositoryDescriptor),
  truncated: Schema.Boolean,
});
export type GitRepositoryDiscoveryResult = typeof GitRepositoryDiscoveryResult.Type;

export const GitCommitGraphCursor = Schema.Struct({
  offset: NonNegativeInt,
  /** Unresolved commit lanes after the preceding page. */
  lanes: Schema.Array(GitObjectId),
});
export type GitCommitGraphCursor = typeof GitCommitGraphCursor.Type;

const GitCommitGraphCursorInput = Schema.Union([NonNegativeInt, GitCommitGraphCursor]);

export const GitCommitGraphPageInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** Numeric cursors remain decodable for older callers; new pages carry lane state. */
  cursor: Schema.NullOr(GitCommitGraphCursorInput),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
});
export type GitCommitGraphPageInput = typeof GitCommitGraphPageInput.Type;

export const GitCommitGraphRef = Schema.Struct({
  /** The ref's role is preserved so clients can decorate HEAD/current/upstream separately. */
  kind: Schema.Literals(["head", "current", "upstream", "local", "remote", "tag"]),
  name: TrimmedNonEmptyStringSchema,
});
export type GitCommitGraphRef = typeof GitCommitGraphRef.Type;

export const GitCommitGraphCommit = Schema.Struct({
  sha: GitObjectId,
  parents: Schema.Array(GitObjectId),
  authorTimestamp: Schema.Number,
  /** Hover metadata is intentionally part of the graph row; changed files remain lazy. */
  authorName: Schema.optional(Schema.String),
  authorEmail: Schema.optional(Schema.String),
  subject: Schema.String,
  message: Schema.optional(Schema.String),
  changeSummary: Schema.optional(Schema.String),
  refs: Schema.Array(GitCommitGraphRef),
  /** Stable lane positions for rendering continuity across page boundaries. */
  lanes: Schema.optional(Schema.Array(NonNegativeInt)),
  /** The column containing this commit dot. */
  lane: Schema.optional(NonNegativeInt),
  /** Connections from this row's dot to its parent lanes in the following row. */
  edges: Schema.optional(Schema.Array(Schema.Struct({ from: NonNegativeInt, to: NonNegativeInt }))),
});
export type GitCommitGraphCommit = typeof GitCommitGraphCommit.Type;

export const GitCommitGraphPageResult = Schema.Struct({
  commits: Schema.Array(GitCommitGraphCommit),
  nextCursor: Schema.NullOr(GitCommitGraphCursorInput),
  hasMore: Schema.Boolean,
});
export type GitCommitGraphPageResult = typeof GitCommitGraphPageResult.Type;

export const GitCommitFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  commitSha: TrimmedNonEmptyStringSchema,
  /** Merge commits need an explicit parent to make the file list meaningful. */
  parentSha: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitCommitFilesInput = typeof GitCommitFilesInput.Type;

export const GitCommitFile = Schema.Struct({
  oldPath: Schema.NullOr(GitPath),
  newPath: Schema.NullOr(GitPath),
  status: Schema.Literals(["added", "modified", "deleted", "renamed", "copied"]),
});
export type GitCommitFile = typeof GitCommitFile.Type;

export const GitCommitFilesResult = Schema.Struct({
  commitSha: TrimmedNonEmptyStringSchema,
  files: Schema.Array(GitCommitFile),
});
export type GitCommitFilesResult = typeof GitCommitFilesResult.Type;

/**
 * A self-contained identity for one file comparison.  It deliberately carries
 * revisions rather than ref names so a restored historical tab never silently
 * changes when a branch moves.  Live comparisons identify the snapshot they
 * were opened from instead.
 */
export const GitRepositoryComparisonDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: TrimmedNonEmptyStringSchema,
  repositoryRoot: TrimmedNonEmptyStringSchema,
  kind: Schema.Literals([
    "working-tree",
    "index",
    "branch",
    "commit",
    "pull-request",
    "turn",
    "checkpoint",
  ]),
  oldPath: Schema.NullOr(GitPath),
  newPath: Schema.NullOr(GitPath),
  /** Pinned Git object ids for historical/index comparisons. */
  baseRevision: Schema.NullOr(GitObjectId),
  headRevision: Schema.NullOr(GitObjectId),
  /** Non-null only for comparisons that intentionally follow live files. */
  liveSnapshotId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Which changing repository snapshot supplies the old side of a live tab. */
  liveBase: Schema.optional(Schema.NullOr(Schema.Literals(["head", "index"]))),
  turnId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  checkpointId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  pullRequestId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Explicit parent used for a merge-commit file comparison. */
  mergeParent: Schema.NullOr(GitObjectId),
});
export type GitRepositoryComparisonDescriptor = typeof GitRepositoryComparisonDescriptor.Type;

export const GitRepositoryComparisonInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  comparison: Schema.Literals(["working-tree", "index", "branch", "commit"]),
  oldPath: Schema.NullOr(GitPath),
  newPath: Schema.NullOr(GitPath),
  baseRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  headRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  indexTree: Schema.optional(TrimmedNonEmptyStringSchema),
  commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Additive so pre-descriptor clients remain compatible with new servers. */
  descriptor: Schema.optional(GitRepositoryComparisonDescriptor),
});
export type GitRepositoryComparisonInput = typeof GitRepositoryComparisonInput.Type;

export const GitRepositoryComparisonResult = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyStringSchema,
  comparison: Schema.Literals(["working-tree", "index", "branch", "commit"]),
  oldPath: Schema.NullOr(GitPath),
  newPath: Schema.NullOr(GitPath),
  oldContents: Schema.String,
  newContents: Schema.String,
  binary: Schema.Boolean,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Echoes the normalized descriptor that was actually compared. */
  descriptor: Schema.optional(GitRepositoryComparisonDescriptor),
});
export type GitRepositoryComparisonResult = typeof GitRepositoryComparisonResult.Type;

export const GitActionRequest = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  action: GitActionOperation,
  confirm: Schema.Boolean,
  /** Used by commit/amend actions; omitted for operations that do not commit. */
  message: Schema.optional(Schema.String),
  /** Operation-specific values stay typed and optional for old clients. */
  paths: Schema.optional(Schema.Array(GitPath)),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  refName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Sync has distinct fetch and publication destinations. */
  pullRemoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  pullRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  sourceRef: Schema.optional(TrimmedNonEmptyStringSchema),
  targetRef: Schema.optional(TrimmedNonEmptyStringSchema),
  oldRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Pull, merge, rebase, and reset each interpret this only for their own named modes. */
  strategy: Schema.optional(Schema.Literals(["merge", "rebase", "ff-only", "hard"])),
  conflictOperation: Schema.optional(Schema.Literals(["continue", "abort"])),
  /** Compound commits are one durable server-side mutation, not a client-side sequence. */
  compoundOperation: Schema.optional(
    Schema.Literals(["commit-push", "commit-sync", "commit-publish"]),
  ),
  fetchOperation: Schema.optional(Schema.Literals(["default", "all", "prune"])),
  resetOperation: Schema.optional(Schema.Literal("undo-last-commit")),
  branchOperation: Schema.optional(
    Schema.Literals([
      "checkout",
      "create",
      "create-from",
      "rename",
      "delete",
      "delete-remote",
      "publish",
    ]),
  ),
  remoteOperation: Schema.optional(Schema.Literals(["add", "remove", "rename"])),
  stashOperation: Schema.optional(
    Schema.Literals([
      "push",
      "include-untracked",
      "staged",
      "view",
      "apply",
      "pop",
      "apply-latest",
      "pop-latest",
      "drop",
      "drop-all",
    ]),
  ),
  /** A destination is mandatory for Push To; ordinary and force push retain their own semantics. */
  pushOperation: Schema.optional(Schema.Literal("to")),
  /** An explicit source is mandatory for Pull From; ordinary pull uses its upstream. */
  pullOperation: Schema.optional(Schema.Literal("from")),
  tagOperation: Schema.optional(Schema.Literals(["create", "delete", "push", "push-all"])),
  changeOperation: Schema.optional(Schema.Literals(["stage", "unstage", "discard"])),
  force: Schema.optional(Schema.Boolean),
  precondition: Schema.optional(GitMutationPrecondition),
});
export type GitActionRequest = typeof GitActionRequest.Type;

/** A partial compound result may be safely resumed without replaying its commit. */
export const GitActionContinuation = Schema.Struct({
  action: Schema.Literals(["push", "sync"]),
  /** Local branch that was reviewed before the remaining action was deferred. */
  sourceRef: Schema.optional(TrimmedNonEmptyStringSchema),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  refName: Schema.optional(TrimmedNonEmptyStringSchema),
  pullRemoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  pullRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  strategy: Schema.optional(Schema.Literals(["merge", "rebase", "ff-only"])),
});
export type GitActionContinuation = typeof GitActionContinuation.Type;

export const GitActionResult = Schema.Struct({
  action: GitActionOperation,
  completed: Schema.Array(Schema.String),
  commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
  failedStep: Schema.optional(Schema.String),
  /** Original failure text when a compound action has already crossed a durable milestone. */
  failureMessage: Schema.optional(Schema.String),
  continuation: Schema.optional(GitActionContinuation),
  /** Read-only actions may return a compact command result for the caller to present. */
  output: Schema.optional(Schema.String),
});
export type GitActionResult = typeof GitActionResult.Type;

export const GitGenerateCommitMessageInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  paths: Schema.optional(Schema.Array(GitPath)),
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
  replacePrompt: Schema.optional(Schema.Boolean),
});
export type GitGenerateCommitMessageInput = typeof GitGenerateCommitMessageInput.Type;

export const GitGenerateCommitMessageResult = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
});
export type GitGenerateCommitMessageResult = typeof GitGenerateCommitMessageResult.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

/** A snapshot cursor is deliberately independent of the Git commit precondition.
 * It names one immutable, bounded working-tree listing and becomes stale after a
 * status invalidation. */
export const VcsWorkingTreePageInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  snapshotId: TrimmedNonEmptyStringSchema,
  cursor: Schema.NullOr(NonNegativeInt),
  pageSize: Schema.optional(NonNegativeInt),
});
export type VcsWorkingTreePageInput = typeof VcsWorkingTreePageInput.Type;

const NonEmptyPaths = Schema.Array(GitPath).check(Schema.isMinLength(1));

export const VcsStageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  paths: NonEmptyPaths,
});
export type VcsStageFilesInput = typeof VcsStageFilesInput.Type;

export const VcsWorkingTreeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** Omit for a guarded repository-wide index review, such as a pending merge. */
  path: Schema.optional(GitPath),
  comparison: Schema.Literals(["index", "head", "worktree-index"]),
  reviewedState: Schema.optional(
    Schema.Struct({
      headCommit: Schema.NullOr(Schema.String),
      indexTree: Schema.String,
    }),
  ),
});
export type VcsWorkingTreeDiffInput = typeof VcsWorkingTreeDiffInput.Type;

export const GitCommitIndexInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  // Amend accepts an empty message to request Git's existing commit message.
  // Plain commits still reject it in the driver so older callers retain the
  // disabled-empty-commit behavior without making the wire contract non-additive.
  message: Schema.String.check(Schema.isMaxLength(10_000)),
  amend: Schema.optional(Schema.Boolean),
  precondition: Schema.optional(GitMutationPrecondition),
  confirmDefaultRef: Schema.optional(Schema.Boolean),
});
export type GitCommitIndexInput = typeof GitCommitIndexInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** Optional override; omission lets Git honor pull.rebase/pull.ff configuration. */
  strategy: Schema.optional(Schema.Literals(["merge", "rebase", "ff-only"])),
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
  /** The thread the action runs beside; a pull request it creates is linked to it. */
  threadId: Schema.optional(ThreadId),
  /** Captured state for a user-approved legacy stacked mutation. */
  precondition: Schema.optional(GitMutationPrecondition),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Additive reviewed-state guard for a confirmed worktree creation. */
  precondition: Schema.optional(GitMutationPrecondition),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
  confirmDirtyWorkingTree: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  confirmDirtyWorkingTree: Schema.optional(Schema.Boolean),
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

// RPC Results

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
  /** Optional for compatibility with older servers and providers. */
  isDraft: Schema.optional(Schema.Boolean),
  /**
   * Last provider-side activity (ISO), including comments and metadata edits.
   * This is not the time a change request closed or merged. Optional for old
   * servers and providers whose lookups do not report it.
   */
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  repositoryRoot: Schema.optional(TrimmedNonEmptyStringSchema),
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  /** Actual publication remote selected by Git's branch push policy. */
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Actual publication ref selected by Git's branch push policy. */
  remoteRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** The separately resolved upstream used by Pull/Sync. */
  pullRemoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  pullRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Hosting-provider credentials for the selected remote, when that probe is authoritative. */
  remoteCredentialReady: Schema.optional(Schema.Boolean),
  remoteCredentialReason: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Whether this repository can create commits without Git prompting for an author. */
  commitIdentityReady: Schema.optional(Schema.Boolean),
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** Revision fields are optional so clients remain compatible with older servers. */
  localRevision: Schema.optional(Schema.String),
  headCommit: Schema.optional(Schema.NullOr(Schema.String)),
  /** False for a root commit, so Undo Last Commit never offers an invalid HEAD~1. */
  headHasParent: Schema.optional(Schema.Boolean),
  indexTree: Schema.optional(Schema.String),
  pendingMergeHeads: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  /** The operation Git expects a continue or abort command for, when one is active. */
  activeConflictOperation: Schema.optional(
    Schema.Literals(["merge", "rebase", "cherry-pick", "revert"]),
  ),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(VcsWorkingTreeFile),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
    /** Additive so clients connected to an older server can still use files. */
    totalCount: Schema.optional(NonNegativeInt),
    stagedCount: Schema.optional(NonNegativeInt),
    hasStagedChanges: Schema.optional(Schema.Boolean),
    snapshotId: Schema.optional(TrimmedNonEmptyStringSchema),
    nextCursor: Schema.optional(Schema.NullOr(NonNegativeInt)),
    truncated: Schema.optional(Schema.Boolean),
  }),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsWorkingTreePageResult = Schema.Struct({
  snapshotId: TrimmedNonEmptyStringSchema,
  files: Schema.Array(VcsWorkingTreeFile),
  nextCursor: Schema.NullOr(NonNegativeInt),
  totalCount: NonNegativeInt,
  stagedCount: NonNegativeInt,
  hasStagedChanges: Schema.Boolean,
});
export type VcsWorkingTreePageResult = typeof VcsWorkingTreePageResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /**
   * False when the checkout could not be brought to the pull request head — a reused worktree
   * holding local commits or uncommitted changes keeps its own state, so the code being handed
   * over is older than the pull request.
   */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const VcsWorkingTreeDiffResult = Schema.Struct({
  diff: Schema.String,
  truncated: Schema.Boolean,
});
export type VcsWorkingTreeDiffResult = typeof VcsWorkingTreeDiffResult.Type;

export const GitCommitIndexResult = Schema.Struct({
  commitSha: TrimmedNonEmptyStringSchema,
});
export type GitCommitIndexResult = typeof GitCommitIndexResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// RPC / domain errors
export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  detail: Schema.String,
  code: Schema.optional(VcsMutationRejectionCode),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: TrimmedNonEmptyStringSchema,
    localBranch: TrimmedNonEmptyStringSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
