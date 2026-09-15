import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  GitManagerError,
  GitCommandError,
  type GitCommitIndexInput,
  type GitCommitIndexResult,
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
  type VcsWorkingTreePageInput,
  type VcsWorkingTreePageResult,
  type VcsStageFilesInput,
  type VcsWorkingTreeDiffInput,
  type VcsWorkingTreeDiffResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
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
    readonly workingTreePage: (
      input: VcsWorkingTreePageInput,
    ) => Effect.Effect<VcsWorkingTreePageResult, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** Serialize mutations by resolved repository root, not by an arbitrary subdirectory. */
    readonly withRepositoryPermit: <A, E, R>(
      operation: string,
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitCommandError, R>;
    readonly stageFiles: (input: VcsStageFilesInput) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: VcsStageFilesInput) => Effect.Effect<void, GitCommandError>;
    readonly getWorkingTreeDiff: (
      input: VcsWorkingTreeDiffInput,
    ) => Effect.Effect<VcsWorkingTreeDiffResult, GitCommandError>;
    readonly commitIndex: (
      input: GitCommitIndexInput,
    ) => Effect.Effect<GitCommitIndexResult, GitCommandError>;
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
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
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
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const mutationSemaphores = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

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

  const mutationKey = (handle: VcsDriverRegistry.VcsDriverHandle) =>
    `${handle.kind}\0${handle.repository.rootPath}`;

  const getMutationSemaphore = Effect.fn("GitWorkflowService.getMutationSemaphore")(function* (
    key: string,
  ) {
    const existing = (yield* Ref.get(mutationSemaphores)).get(key);
    if (existing) return existing;
    const candidate = yield* Semaphore.make(1);
    return yield* Ref.modify(mutationSemaphores, (semaphores) => {
      const current = semaphores.get(key);
      if (current) return [current, semaphores] as const;
      const next = new Map(semaphores);
      next.set(key, candidate);
      return [candidate, next] as const;
    });
  });

  const serializedMutation = <A, E, R>(
    operation: string,
    cwd: string,
    mutation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | GitCommandError, R> =>
    ensureGitCommand(operation, cwd).pipe(
      Effect.flatMap((handle) =>
        getMutationSemaphore(mutationKey(handle)).pipe(
          Effect.flatMap((semaphore) => semaphore.withPermit(mutation)),
        ),
      ),
    );

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

  return GitWorkflowService.of({
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
    workingTreePage: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.workingTreePage", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.workingTreePage(input)
            : Effect.fail(
                new GitManagerError({
                  operation: "GitWorkflowService.workingTreePage",
                  cwd: input.cwd,
                  detail:
                    "Working tree pages require a Git repository. Refresh repository status and try again.",
                }),
              ),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    withRepositoryPermit: serializedMutation,
    stageFiles: (input) =>
      serializedMutation("GitWorkflowService.stageFiles", input.cwd, git.stageFiles(input)),
    unstageFiles: (input) =>
      serializedMutation("GitWorkflowService.unstageFiles", input.cwd, git.unstageFiles(input)),
    getWorkingTreeDiff: (input) =>
      ensureGitCommand("GitWorkflowService.getWorkingTreeDiff", input.cwd).pipe(
        Effect.andThen(git.getWorkingTreeDiff(input)),
      ),
    commitIndex: (input) =>
      serializedMutation("GitWorkflowService.commitIndex", input.cwd, git.commitIndex(input)),
    pullCurrentBranch: (cwd) =>
      serializedMutation("GitWorkflowService.pullCurrentBranch", cwd, git.pullCurrentBranch(cwd)),
    runStackedAction: (input, options) =>
      serializedMutation(
        "GitWorkflowService.runStackedAction",
        input.cwd,
        ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
          Effect.andThen(gitManager.runStackedAction(input, options)),
        ),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input, options) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input, options)),
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
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    pruneWorktrees: (input) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      ),
    createRef: (input) =>
      serializedMutation("GitWorkflowService.createRef", input.cwd, git.createRef(input)),
    switchRef: (input) =>
      serializedMutation(
        "GitWorkflowService.switchRef",
        input.cwd,
        Effect.scoped(git.switchRef(input)),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
