import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitIndexOperations from "./GitIndexOperations.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

type GitIndexOperationsService = Effect.Success<typeof GitIndexOperations.make>;

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly discoverRepositories: GitIndexOperationsService["discoverRepositories"];
    readonly indexStatus: GitIndexOperationsService["indexStatus"];
    readonly mutateIndex: GitIndexOperationsService["mutateIndex"];
    readonly commitStaged: GitIndexOperationsService["commitStaged"];
    readonly history: GitIndexOperationsService["history"];
    readonly historyDiff: GitIndexOperationsService["historyDiff"];
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const index = yield* GitIndexOperations.make;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      if (handle.kind !== "git") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
        });
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  const runReviewedPush = Effect.fn("GitWorkflowService.runReviewedPush")(function* (
    input: GitRunStackedActionInput,
    options?: GitManager.GitRunStackedActionOptions,
  ): Effect.fn.Return<GitRunStackedActionResult, GitCommandError> {
    const reviewed = input.reviewedPush;
    if (
      reviewed === undefined ||
      input.action !== "push" ||
      input.featureBranch ||
      input.commitMessage !== undefined ||
      input.filePaths !== undefined
    ) {
      return yield* new GitCommandError({
        operation: "GitWorkflowService.runReviewedPush",
        command: "git",
        cwd: input.cwd,
        detail: "Reviewed push recovery cannot be combined with another Git action.",
      });
    }
    const base = {
      actionId: options?.actionId ?? input.actionId,
      cwd: input.cwd,
      action: input.action,
    };
    yield* (
      options?.progressReporter?.publish({ ...base, kind: "action_started", phases: ["push"] }) ??
        Effect.void
    );
    yield* (
      options?.progressReporter?.publish({
        ...base,
        kind: "phase_started",
        phase: "push",
        label: "Pushing reviewed commit...",
      }) ?? Effect.void
    );
    const push = yield* git.pushCurrentBranch(input.cwd, null, { reviewed }).pipe(
      Effect.tapError(
        () =>
          options?.progressReporter?.publish({
            ...base,
            kind: "action_failed",
            phase: "push",
            message: "Reviewed push failed. The completed commit is available to retry.",
          }) ?? Effect.void,
      ),
    );
    const result: GitRunStackedActionResult = {
      action: "push",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_not_requested" },
      push,
      pr: { status: "skipped_not_requested" },
      toast: { title: `Pushed ${push.branch}`, cta: { kind: "none" } },
    };
    yield* (
      options?.progressReporter?.publish({ ...base, kind: "action_finished", result }) ??
        Effect.void
    );
    return result;
  });

  return GitWorkflowService.of({
    discoverRepositories: index.discoverRepositories,
    indexStatus: Effect.fn("GitWorkflowService.indexStatus")((input) =>
      ensureGitCommand("indexStatus", input.cwd).pipe(Effect.andThen(index.indexStatus(input))),
    ),
    history: Effect.fn("GitWorkflowService.history")((input) =>
      ensureGitCommand("history", input.cwd).pipe(Effect.andThen(index.history(input))),
    ),
    historyDiff: Effect.fn("GitWorkflowService.historyDiff")((input) =>
      ensureGitCommand("historyDiff", input.cwd).pipe(Effect.andThen(index.historyDiff(input))),
    ),
    mutateIndex: Effect.fn("GitWorkflowService.mutateIndex")((input) =>
      ensureGitCommand("mutateIndex", input.cwd).pipe(
        Effect.andThen(index.mutateIndex(input)),
        Effect.tap((result) => gitManager.invalidateLocalStatus(result.fingerprint.rootPath)),
        Effect.tap(() => gitManager.invalidateLocalStatus(input.cwd)),
      ),
    ),
    commitStaged: Effect.fn("GitWorkflowService.commitStaged")((input) =>
      ensureGitCommand("commitStaged", input.cwd).pipe(
        Effect.andThen(index.commitStaged(input)),
        Effect.tap(() => gitManager.invalidateStatus(input.expected.rootPath)),
        Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
      ),
    ),
    isRepository: (cwd) =>
      registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      ),
    hasCommit: (input) =>
      ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      ),
    hasRefNamed: (input) =>
      // No ref name holds a pattern character, and one here would widen the match.
      /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          ),
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, git.pullCurrentBranch(cwd)),
        ),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            input.reviewedPush === undefined
              ? gitManager.runStackedAction(input, options)
              : runReviewedPush(input, options).pipe(
                  Effect.ensuring(
                    gitManager
                      .invalidateStatus(handle.repository.rootPath)
                      .pipe(Effect.andThen(gitManager.invalidateStatus(input.cwd))),
                  ),
                ),
          ),
        ),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: (input) =>
      ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.mode === "local"
            ? withCheckoutLease(
                handle.repository.rootPath,
                gitManager.preparePullRequestThread(input),
              )
            : gitManager.preparePullRequestThread(input),
        ),
      ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input, options) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(gitManager.createWorktree(input, options)),
      ),
    listLocalBranchNames: (cwd) =>
      ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      ),
    fetchRemote: (input) =>
      ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    remoteExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      ),
    remoteBranchExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    resolveWorktreeBaseRemote: (input) =>
      ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
        Effect.andThen(git.resolveWorktreeBaseRemote(input)),
      ),
    fetchWorktreeBaseCommit: (input) =>
      ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
        Effect.andThen(git.fetchWorktreeBaseCommit(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    pruneWorktrees: (input) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      ),
    deleteLocalBranch: (input) =>
      ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, git.renameBranch(input)),
        ),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
