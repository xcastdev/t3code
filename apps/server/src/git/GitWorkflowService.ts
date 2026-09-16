import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  GitManagerError,
  GitCommandError,
  type GitActionRequest,
  type GitActionResult,
  type GitMutationPrecondition,
  type GitGenerateCommitMessageInput,
  type GitGenerateCommitMessageResult,
  type GitCommitFilesInput,
  type GitCommitFilesResult,
  type GitCommitGraphPageInput,
  type GitCommitGraphPageResult,
  type GitRepositoryComparisonInput,
  type GitRepositoryComparisonResult,
  type GitRepositoryDiscoveryInput,
  type GitRepositoryDiscoveryResult,
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

export function pullStrategyArgs(strategy: "merge" | "rebase" | "ff-only" | undefined): string[] {
  if (strategy === "rebase") return ["pull", "--rebase"];
  if (strategy === "ff-only") return ["pull", "--ff-only"];
  if (strategy === "merge") return ["pull", "--no-rebase"];
  // Let Git apply pull.rebase/pull.ff when no UI override was selected.
  return ["pull"];
}

/** Reset intentionally has no pull-style fast-forward mode. */
export function resetStrategyArgs(strategy: "merge" | "hard" | undefined): string[] {
  return strategy === "hard" ? ["--hard"] : ["--merge"];
}

/** Reject incomplete fixed leaves before Git can silently choose an unrelated default. */
export function validateGitActionInput(input: GitActionRequest): string | null {
  if (input.action === "branch" && input.branchOperation === "create-from" && !input.sourceRef) {
    return "Create Branch From requires a source ref.";
  }
  if (
    input.action === "pull" &&
    input.pullOperation === "from" &&
    (!input.remoteName || !input.refName)
  ) {
    return "Pull From requires both a remote and a ref.";
  }
  if (
    input.action === "push" &&
    input.pushOperation === "to" &&
    (!input.remoteName || !input.refName)
  ) {
    return "Push To requires both a remote and a destination ref.";
  }
  return null;
}

export function resolveConflictContinuationOperation(input: {
  readonly conflictOperation: "continue" | "abort";
  readonly cherryPickHeadPresent: boolean;
  readonly revertHeadPresent: boolean;
  readonly strategy?: "merge" | "rebase" | "ff-only";
}): "cherry-pick" | "revert" | "merge" | "rebase" {
  if (input.cherryPickHeadPresent) return "cherry-pick";
  if (input.revertHeadPresent) return "revert";
  return input.strategy === "rebase" ? "rebase" : "merge";
}

/** Confirmation is determined by the typed leaf, never by a UI-provided boolean alone. */
export function requiresGitActionConfirmation(
  input: Pick<
    GitActionRequest,
    "action" | "changeOperation" | "stashOperation" | "compoundOperation"
  >,
): boolean {
  return !(
    input.action === "fetch" ||
    (input.action === "discard" &&
      (input.changeOperation === "stage" || input.changeOperation === "unstage")) ||
    (input.action === "stash" && input.stashOperation === "view") ||
    (input.action === "commit" && input.compoundOperation === undefined)
  );
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly discoverRepositories: (
      input: GitRepositoryDiscoveryInput,
    ) => Effect.Effect<GitRepositoryDiscoveryResult, GitCommandError>;
    readonly commitGraphPage: (
      input: GitCommitGraphPageInput,
    ) => Effect.Effect<GitCommitGraphPageResult, GitCommandError>;
    readonly commitFiles: (
      input: GitCommitFilesInput,
    ) => Effect.Effect<GitCommitFilesResult, GitCommandError>;
    readonly compareRepositoryFile: (
      input: GitRepositoryComparisonInput,
    ) => Effect.Effect<GitRepositoryComparisonResult, GitCommandError>;
    readonly runAction: (
      input: GitActionRequest,
    ) => Effect.Effect<GitActionResult, GitCommandError>;
    readonly generateCommitMessage: (
      input: GitGenerateCommitMessageInput,
    ) => Effect.Effect<GitGenerateCommitMessageResult, GitManagerServiceError>;
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
    /** Caller must already hold the repository permit when this guards a mutation. */
    readonly validateMutationPrecondition: (input: {
      readonly cwd: string;
      readonly precondition: GitMutationPrecondition;
    }) => Effect.Effect<void, GitCommandError>;
    readonly stageFiles: (input: VcsStageFilesInput) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: VcsStageFilesInput) => Effect.Effect<void, GitCommandError>;
    readonly getWorkingTreeDiff: (
      input: VcsWorkingTreeDiffInput,
    ) => Effect.Effect<VcsWorkingTreeDiffResult, GitCommandError>;
    readonly commitIndex: (
      input: GitCommitIndexInput,
    ) => Effect.Effect<GitCommitIndexResult, GitCommandError>;
    readonly pullCurrentBranch: (
      cwd: string,
      strategy?: "merge" | "rebase" | "ff-only",
    ) => Effect.Effect<VcsPullResult, GitCommandError>;
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

  const validateMutationPrecondition = Effect.fn("GitWorkflowService.validateMutationPrecondition")(
    function* (input: { readonly cwd: string; readonly precondition: GitMutationPrecondition }) {
      const status = yield* git.statusDetails(input.cwd);
      const expected = input.precondition;
      if (
        status.headCommit !== expected.expectedHeadCommit ||
        status.indexTree !== expected.expectedIndexTree ||
        (expected.expectedRefName !== undefined && status.branch !== expected.expectedRefName) ||
        (expected.expectedMergeHeads !== undefined &&
          (status.pendingMergeHeads ?? []).join("\0") !== expected.expectedMergeHeads.join("\0"))
      ) {
        return yield* new GitCommandError({
          operation: "GitWorkflowService.validateMutationPrecondition",
          command: "git",
          cwd: input.cwd,
          detail: "Repository changed after the action was reviewed.",
          code: "stale_git_state",
        });
      }
    },
  );

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
    // Discovery intentionally runs from non-repository project roots too: a project can contain
    // unrelated nested repositories even when its own root has no .git directory.
    discoverRepositories: (input) => git.discoverRepositories(input),
    commitGraphPage: (input) =>
      ensureGitCommand("GitWorkflowService.commitGraphPage", input.cwd).pipe(
        Effect.andThen(git.commitGraphPage(input)),
      ),
    commitFiles: (input) =>
      ensureGitCommand("GitWorkflowService.commitFiles", input.cwd).pipe(
        Effect.andThen(git.commitFiles(input)),
      ),
    compareRepositoryFile: (input) =>
      ensureGitCommand("GitWorkflowService.compareRepositoryFile", input.cwd).pipe(
        Effect.andThen(git.compareRepositoryFile(input)),
      ),
    runAction: (input) =>
      serializedMutation(
        "GitWorkflowService.runAction",
        input.cwd,
        Effect.gen(function* () {
          const runCommand = (args: ReadonlyArray<string>) =>
            git
              .execute({
                operation: `GitWorkflowService.runAction.${input.action}`,
                cwd: input.cwd,
                args,
              })
              .pipe(Effect.asVoid);
          // Keep the confirmation policy at the execution boundary.  A client must never
          // turn a destructive leaf (notably discard and remote deletion) into a silent
          // mutation by omitting its dialog.
          const requiresConfirmation = requiresGitActionConfirmation(input);
          if (requiresConfirmation && !input.confirm) {
            return yield* new GitCommandError({
              operation: "GitWorkflowService.runAction",
              command: "git",
              cwd: input.cwd,
              detail: `Confirmation is required before ${input.action}.`,
            });
          }
          const inputError = validateGitActionInput(input);
          if (inputError) {
            return yield* new GitCommandError({
              operation: "GitWorkflowService.runAction",
              command: "git",
              cwd: input.cwd,
              detail: inputError,
            });
          }
          if (input.precondition !== undefined) {
            const status = yield* git.statusDetails(input.cwd);
            const expected = input.precondition;
            if (
              status.headCommit !== expected.expectedHeadCommit ||
              status.indexTree !== expected.expectedIndexTree ||
              (expected.expectedRefName !== undefined &&
                status.branch !== expected.expectedRefName) ||
              (expected.expectedMergeHeads !== undefined &&
                (status.pendingMergeHeads ?? []).join("\0") !==
                  expected.expectedMergeHeads.join("\0"))
            ) {
              return yield* new GitCommandError({
                operation: "GitWorkflowService.runAction.precondition",
                command: "git",
                cwd: input.cwd,
                detail: "Repository changed after the action was reviewed.",
                code: "stale_git_state",
              });
            }
          }
          const verifyCapturedSource = Effect.fn(
            "GitWorkflowService.runAction.verifyCapturedSource",
          )(function* () {
            if (!input.sourceRef || (input.action !== "push" && input.action !== "sync")) return;
            const status = yield* git.statusDetails(input.cwd);
            if (status.branch === input.sourceRef) return;
            return yield* new GitCommandError({
              operation: "GitWorkflowService.runAction.continuation",
              command: "git",
              cwd: input.cwd,
              detail: "The branch changed after the remaining action was reviewed.",
              code: "stale_git_state",
            });
          });
          switch (input.action) {
            case "commit":
            case "amend": {
              const result = yield* git.commitIndex({
                cwd: input.cwd,
                message: input.message ?? "",
                ...(input.action === "amend" ? { amend: true } : {}),
                ...(input.precondition ? { precondition: input.precondition } : {}),
                ...(input.confirm ? { confirmDefaultRef: true } : {}),
              });
              if (input.action === "commit" && input.compoundOperation !== undefined) {
                const statusRead = yield* Effect.exit(git.statusDetails(input.cwd));
                if (Exit.isFailure(statusRead)) {
                  const cause = Cause.squash(statusRead.cause);
                  return {
                    action: input.action,
                    completed: ["commit"],
                    commitSha: result.commitSha,
                    failedStep: "status",
                    failureMessage:
                      cause instanceof Error
                        ? cause.message
                        : "Could not refresh repository status after committing.",
                    continuation: {
                      action:
                        input.compoundOperation === "commit-sync"
                          ? ("sync" as const)
                          : ("push" as const),
                      ...(input.precondition?.expectedRefName
                        ? { sourceRef: input.precondition.expectedRefName }
                        : {}),
                      ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                      ...(input.refName ? { refName: input.refName } : {}),
                      ...(input.pullRemoteName ? { pullRemoteName: input.pullRemoteName } : {}),
                      ...(input.pullRefName ? { pullRefName: input.pullRefName } : {}),
                      ...(input.strategy && input.strategy !== "hard"
                        ? { strategy: input.strategy }
                        : {}),
                    },
                  };
                }
                const status = statusRead.value;
                if (input.compoundOperation === "commit-sync") {
                  const pulled = yield* Effect.exit(
                    input.pullRemoteName && input.pullRefName
                      ? runCommand([
                          "pull",
                          ...(input.strategy === "rebase"
                            ? ["--rebase"]
                            : input.strategy === "ff-only"
                              ? ["--ff-only"]
                              : input.strategy === "merge"
                                ? ["--no-rebase"]
                                : []),
                          input.pullRemoteName,
                          input.pullRefName,
                        ])
                      : git.pullCurrentBranch(
                          input.cwd,
                          input.strategy === "hard" ? undefined : input.strategy,
                        ),
                  );
                  if (Exit.isFailure(pulled)) {
                    const cause = Cause.squash(pulled.cause);
                    return {
                      action: input.action,
                      completed: ["commit"],
                      commitSha: result.commitSha,
                      failedStep: "pull",
                      failureMessage: cause instanceof Error ? cause.message : "Pull failed.",
                      continuation: {
                        action: "sync" as const,
                        ...(status.branch ? { sourceRef: status.branch } : {}),
                        ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                        ...(input.refName ? { refName: input.refName } : {}),
                        ...(input.pullRemoteName ? { pullRemoteName: input.pullRemoteName } : {}),
                        ...(input.pullRefName ? { pullRefName: input.pullRefName } : {}),
                        ...(input.strategy && input.strategy !== "hard"
                          ? { strategy: input.strategy }
                          : {}),
                      },
                    };
                  }
                }
                const pushed = yield* Effect.exit(
                  git.pushCurrentBranch(input.cwd, status.branch, {
                    ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                    ...(input.refName ? { refName: input.refName } : {}),
                  }),
                );
                const completed = [
                  "commit",
                  ...(input.compoundOperation === "commit-sync" ? ["pull"] : []),
                ];
                if (Exit.isFailure(pushed)) {
                  const cause = Cause.squash(pushed.cause);
                  return {
                    action: input.action,
                    completed,
                    commitSha: result.commitSha,
                    failedStep: "push",
                    failureMessage: cause instanceof Error ? cause.message : "Push failed.",
                    continuation: {
                      action: "push" as const,
                      ...(status.branch ? { sourceRef: status.branch } : {}),
                      ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                      ...(input.refName ? { refName: input.refName } : {}),
                      ...(input.pullRemoteName ? { pullRemoteName: input.pullRemoteName } : {}),
                      ...(input.pullRefName ? { pullRefName: input.pullRefName } : {}),
                      ...(input.strategy && input.strategy !== "hard"
                        ? { strategy: input.strategy }
                        : {}),
                    },
                  };
                }
                return {
                  action: input.action,
                  completed: [...completed, "push"],
                  commitSha: result.commitSha,
                };
              }
              return {
                action: input.action,
                completed: [input.action],
                commitSha: result.commitSha,
              };
            }
            case "fetch": {
              if (input.fetchOperation === "all") {
                yield* runCommand(["fetch", "--all"]);
              } else {
                const remoteName =
                  input.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
                yield* runCommand([
                  "fetch",
                  ...(input.fetchOperation === "prune" ? ["--prune"] : []),
                  remoteName,
                ]);
              }
              return {
                action: input.action,
                completed: [
                  input.fetchOperation === "all"
                    ? "fetch-all"
                    : input.fetchOperation === "prune"
                      ? "fetch-prune"
                      : "fetch",
                ],
              };
            }
            case "pull": {
              // Pull From deliberately carries its selected destination in the
              // public remote/ref fields. Ordinary Pull keeps Git's configured
              // upstream semantics, while sync continuations use their separate
              // pull destination fields.
              const pullRemoteName =
                input.pullOperation === "from" ? input.remoteName : input.pullRemoteName;
              const pullRefName =
                input.pullOperation === "from" ? input.refName : input.pullRefName;
              if (pullRemoteName && pullRefName) {
                yield* runCommand([
                  "pull",
                  ...(input.strategy === "rebase"
                    ? ["--rebase"]
                    : input.strategy === "ff-only"
                      ? ["--ff-only"]
                      : input.strategy === "merge"
                        ? ["--no-rebase"]
                        : []),
                  pullRemoteName,
                  pullRefName,
                ]);
              } else {
                yield* git.pullCurrentBranch(
                  input.cwd,
                  input.strategy === "hard" ? undefined : input.strategy,
                );
              }
              return { action: input.action, completed: ["pull"] };
            }
            case "push": {
              yield* verifyCapturedSource();
              const status = yield* git.statusDetails(input.cwd);
              if (input.pushOperation === "to" && input.remoteName && input.refName) {
                yield* runCommand([
                  "push",
                  ...(input.force ? ["--force"] : []),
                  input.remoteName,
                  `HEAD:${input.refName}`,
                ]);
              } else if (input.force) {
                const remote = input.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
                if (status.branch === null) {
                  return yield* new GitCommandError({
                    operation: "GitWorkflowService.runAction.push",
                    command: "git",
                    cwd: input.cwd,
                    detail: "Cannot force-push from detached HEAD.",
                  });
                }
                yield* runCommand(["push", "--force", remote, status.branch]);
              } else {
                yield* git.pushCurrentBranch(input.cwd, status.branch, {
                  ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                  ...(input.refName ? { refName: input.refName } : {}),
                });
              }
              return { action: input.action, completed: ["push"] };
            }
            case "sync": {
              yield* verifyCapturedSource();
              if (input.pullRemoteName && input.pullRefName) {
                yield* runCommand([
                  "pull",
                  ...(input.strategy === "rebase"
                    ? ["--rebase"]
                    : input.strategy === "ff-only"
                      ? ["--ff-only"]
                      : input.strategy === "merge"
                        ? ["--no-rebase"]
                        : []),
                  input.pullRemoteName,
                  input.pullRefName,
                ]);
              } else {
                yield* git.pullCurrentBranch(
                  input.cwd,
                  input.strategy === "hard" ? undefined : input.strategy,
                );
              }
              const status = yield* git.statusDetails(input.cwd);
              const push = yield* Effect.exit(
                git.pushCurrentBranch(input.cwd, status.branch, {
                  ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                  ...(input.refName ? { refName: input.refName } : {}),
                }),
              );
              if (Exit.isFailure(push)) {
                // Pull already settled and must not be replayed if the caller
                // retries after a network failure. Return a receipt that names
                // the completed step so the UI can offer a safe continuation.
                const cause = Cause.squash(push.cause);
                return {
                  action: input.action,
                  completed: ["pull"],
                  failedStep: "push",
                  failureMessage: cause instanceof Error ? cause.message : "Push failed.",
                  continuation: {
                    action: "push" as const,
                    ...(status.branch ? { sourceRef: status.branch } : {}),
                    ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                    ...(input.refName ? { refName: input.refName } : {}),
                    ...(input.pullRemoteName ? { pullRemoteName: input.pullRemoteName } : {}),
                    ...(input.pullRefName ? { pullRefName: input.pullRefName } : {}),
                    ...(input.strategy && input.strategy !== "hard"
                      ? { strategy: input.strategy }
                      : {}),
                  },
                };
              }
              return { action: input.action, completed: ["pull", "push"] };
            }
            case "publish": {
              const status = yield* git.statusDetails(input.cwd);
              yield* git.pushCurrentBranch(input.cwd, status.branch, {
                ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                ...(input.refName ? { refName: input.refName } : {}),
              });
              return { action: input.action, completed: ["publish"] };
            }
            case "branch": {
              switch (input.branchOperation) {
                case "checkout":
                  if (!input.refName) break;
                  yield* git.switchRef({ cwd: input.cwd, refName: input.refName });
                  return { action: input.action, completed: ["checkout"] };
                case "create":
                case "create-from":
                  if (!input.refName) break;
                  yield* runCommand([
                    "branch",
                    input.refName,
                    ...(input.branchOperation === "create-from"
                      ? [input.sourceRef!]
                      : input.sourceRef
                        ? [input.sourceRef]
                        : []),
                  ]);
                  return { action: input.action, completed: ["create-branch"] };
                case "rename":
                  if (!input.oldRefName || !input.newRefName) break;
                  yield* git.renameBranch({
                    cwd: input.cwd,
                    oldBranch: input.oldRefName,
                    newBranch: input.newRefName,
                  });
                  return { action: input.action, completed: ["rename-branch"] };
                case "delete":
                  if (!input.refName) break;
                  yield* runCommand(["branch", input.force ? "-D" : "-d", input.refName]);
                  return { action: input.action, completed: ["delete-branch"] };
                case "delete-remote": {
                  if (!input.refName) break;
                  const remote =
                    input.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
                  yield* runCommand(["push", remote, "--delete", input.refName]);
                  return { action: input.action, completed: ["delete-remote-branch"] };
                }
                case "publish": {
                  const status = yield* git.statusDetails(input.cwd);
                  yield* git.pushCurrentBranch(input.cwd, status.branch, {
                    ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                  });
                  return { action: input.action, completed: ["publish-branch"] };
                }
              }
              break;
            }
            case "remote": {
              if (input.remoteOperation === "add" && input.remoteName && input.targetRef) {
                yield* runCommand(["remote", "add", input.remoteName, input.targetRef]);
                return { action: input.action, completed: ["add-remote"] };
              }
              if (input.remoteOperation === "remove" && input.remoteName) {
                yield* runCommand(["remote", "remove", input.remoteName]);
                return { action: input.action, completed: ["remove-remote"] };
              }
              if (input.remoteOperation === "rename" && input.remoteName && input.newRefName) {
                yield* runCommand(["remote", "rename", input.remoteName, input.newRefName]);
                return { action: input.action, completed: ["rename-remote"] };
              }
              break;
            }
            case "stash": {
              const paths = input.paths ?? [];
              if (input.stashOperation === "push" || input.stashOperation === "include-untracked") {
                yield* runCommand([
                  "stash",
                  "push",
                  ...(input.stashOperation === "include-untracked" ? ["--include-untracked"] : []),
                  ...(input.message ? ["-m", input.message] : []),
                  ...(paths.length > 0 ? ["--", ...paths] : []),
                ]);
                return { action: input.action, completed: ["stash"] };
              }
              if (input.stashOperation === "staged") {
                yield* runCommand(["stash", "push", "--staged"]);
                return { action: input.action, completed: ["stash-staged"] };
              }
              if (input.stashOperation === "view") {
                const result = yield* git.execute({
                  operation: "GitWorkflowService.runAction.stash-view",
                  cwd: input.cwd,
                  args: ["stash", "list"],
                });
                return { action: input.action, completed: ["stash-view"], output: result.stdout };
              }
              if (
                input.stashOperation === "apply" ||
                input.stashOperation === "pop" ||
                input.stashOperation === "apply-latest" ||
                input.stashOperation === "pop-latest"
              ) {
                const operation =
                  input.stashOperation === "apply-latest"
                    ? "apply"
                    : input.stashOperation === "pop-latest"
                      ? "pop"
                      : input.stashOperation;
                const fixedLatest =
                  input.stashOperation === "apply-latest" || input.stashOperation === "pop-latest";
                yield* runCommand([
                  "stash",
                  operation,
                  ...(fixedLatest ? ["stash@{0}"] : input.refName ? [input.refName] : []),
                ]);
                return { action: input.action, completed: [`stash-${input.stashOperation}`] };
              }
              if (input.stashOperation === "drop") {
                yield* runCommand(["stash", "drop", ...(input.refName ? [input.refName] : [])]);
                return { action: input.action, completed: ["stash-drop"] };
              }
              if (input.stashOperation === "drop-all") {
                yield* runCommand(["stash", "clear"]);
                return { action: input.action, completed: ["stash-drop-all"] };
              }
              break;
            }
            case "tag": {
              if (input.tagOperation === "create") {
                if (!input.refName) break;
                yield* runCommand([
                  "tag",
                  ...(input.message ? ["-m", input.message] : []),
                  input.refName,
                  ...(input.targetRef ? [input.targetRef] : []),
                ]);
                return { action: input.action, completed: ["create-tag"] };
              }
              if (input.tagOperation === "delete") {
                if (!input.refName) break;
                yield* runCommand(["tag", "-d", input.refName]);
                return { action: input.action, completed: ["delete-tag"] };
              }
              if (input.tagOperation === "push") {
                if (!input.refName) break;
                const remote = input.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
                yield* runCommand(["push", remote, input.refName]);
                return { action: input.action, completed: ["push-tag"] };
              }
              if (input.tagOperation === "push-all") {
                const remote = input.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
                yield* runCommand(["push", remote, "--tags"]);
                return { action: input.action, completed: ["push-all-tags"] };
              }
              break;
            }
            case "merge":
            case "rebase":
            case "cherry-pick":
            case "revert":
            case "reset": {
              if (input.action === "reset" && input.resetOperation === "undo-last-commit") {
                yield* runCommand(["reset", "--soft", "HEAD~1"]);
                return { action: input.action, completed: ["undo-last-commit"] };
              }
              const target = input.targetRef ?? input.refName;
              if (!target) break;
              const args =
                input.action === "merge"
                  ? ["merge", ...(input.strategy === "ff-only" ? ["--ff-only"] : []), target]
                  : input.action === "rebase"
                    ? [
                        "rebase",
                        ...(input.strategy === "ff-only" ? ["--rebase-merges"] : []),
                        target,
                      ]
                    : input.action === "cherry-pick"
                      ? ["cherry-pick", target]
                      : input.action === "revert"
                        ? ["revert", target]
                        : // The workflow UI defaults Reset to Merge. Keep an omitted strategy safe
                          // too: an older client must never turn that default into a hard reset.
                          [
                            "reset",
                            ...resetStrategyArgs(input.strategy === "hard" ? "hard" : "merge"),
                            target,
                          ];
              yield* runCommand(args);
              return { action: input.action, completed: [input.action] };
            }
            case "discard": {
              const paths = input.paths ?? [];
              if (input.changeOperation === "stage") {
                yield* runCommand(["add", ...(paths.length ? ["--", ...paths] : ["-A"])]);
                return { action: input.action, completed: ["stage"] };
              }
              if (input.changeOperation === "unstage") {
                // Deliberately no --worktree: this is the non-destructive inverse of stage.
                const hasHead = (yield* git.statusDetails(input.cwd)).headCommit !== null;
                yield* runCommand(
                  hasHead
                    ? ["restore", "--staged", ...(paths.length ? ["--", ...paths] : [":/"])]
                    : ["reset", "--", ...(paths.length ? paths : ["."])],
                );
                return { action: input.action, completed: ["unstage"] };
              }
              if (input.changeOperation === "discard") {
                yield* runCommand([
                  "restore",
                  "--worktree",
                  "--staged",
                  ...(paths.length ? ["--", ...paths] : [":/"]),
                ]);
                return { action: input.action, completed: ["discard"] };
              }
              break;
            }
            case "conflict": {
              if (!input.conflictOperation) break;
              const continuation = (yield* git.statusDetails(input.cwd)).activeConflictOperation;
              if (!continuation) {
                return yield* new GitCommandError({
                  operation: "GitWorkflowService.runAction.conflict",
                  command: "git",
                  cwd: input.cwd,
                  detail: "No active Git operation can be continued or aborted.",
                });
              }
              yield* runCommand([continuation, `--${input.conflictOperation}`]);
              return { action: input.action, completed: [`conflict-${input.conflictOperation}`] };
            }
            default:
              break;
          }
          return yield* new GitCommandError({
            operation: "GitWorkflowService.runAction",
            command: "git",
            cwd: input.cwd,
            detail: `${input.action} requires operation-specific input.`,
          });
        }),
      ),
    generateCommitMessage: (input) =>
      ensureGitCommand("GitWorkflowService.generateCommitMessage", input.cwd).pipe(
        Effect.andThen(gitManager.generateCommitMessage(input)),
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
    validateMutationPrecondition,
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
    pullCurrentBranch: (cwd, strategy) =>
      serializedMutation(
        "GitWorkflowService.pullCurrentBranch",
        cwd,
        git.pullCurrentBranch(cwd, strategy),
      ),
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
      serializedMutation(
        "GitWorkflowService.createWorktree",
        input.cwd,
        ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // A confirmed worktree is a mutation of the reviewed repository,
              // so validate its captured state only after entering its queue.
              // The optional field intentionally keeps older clients compatible.
              if (input.precondition !== undefined) {
                const status = yield* git.statusDetails(input.cwd);
                const expected = input.precondition;
                if (
                  status.headCommit !== expected.expectedHeadCommit ||
                  status.indexTree !== expected.expectedIndexTree ||
                  (expected.expectedRefName !== undefined &&
                    status.branch !== expected.expectedRefName) ||
                  (expected.expectedMergeHeads !== undefined &&
                    (status.pendingMergeHeads ?? []).join("\0") !==
                      expected.expectedMergeHeads.join("\0"))
                ) {
                  return yield* new GitCommandError({
                    operation: "GitWorkflowService.createWorktree.precondition",
                    command: "git",
                    cwd: input.cwd,
                    detail: "Repository changed after the action was reviewed.",
                    code: "stale_git_state",
                  });
                }
              }
              return yield* git.createWorktree(input, options);
            }),
          ),
        ),
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
