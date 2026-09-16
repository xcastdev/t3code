import type {
  ExecutionEnvironmentCapabilities,
  GitActionOperation,
  GitActionContinuation,
  GitActionResult,
  GitCommitFilesInput,
  GitCommitGraphPageInput,
  GitRepositoryComparisonInput,
  GitRepositoryDiscoveryInput,
  GitRepositoryDescriptor,
  VcsStatusInput,
  VcsStatusResult,
} from "@t3tools/contracts";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  request,
  subscribe,
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
} from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  type AtomCommandResult,
  type AtomCommandFailure,
  type EnvironmentSubscriptionSnapshot,
} from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import {
  invalidateCachedVcsRefs,
  normalizeVcsRepositoryRoot,
  registerVcsRepositories,
  vcsInvalidationTargets,
  vcsRefsCacheStateAtom,
  withCanonicalVcsRepository,
} from "./vcsRefInvalidation.ts";

function invalidateSourceControlWorkspaceState(
  target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
  registry: AtomRegistry.AtomRegistry,
) {
  invalidateSourceControlWorkspace(registry, {
    environmentId: target.environmentId,
    repositoryRoot: target.input.cwd,
  });
  return invalidateCachedVcsRefs(registry, {
    environmentId: target.environmentId,
    cwd: target.input.cwd,
  });
}

/** Broadcasts and local commands invalidate the same revision consumers. */
export function publishSourceControlStatus(
  target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
  registry: AtomRegistry.AtomRegistry,
) {
  invalidateSourceControlWorkspace(
    registry,
    { environmentId: target.environmentId, repositoryRoot: target.input.cwd },
    false,
  );
  return invalidateCachedVcsRefs(registry, {
    environmentId: target.environmentId,
    cwd: target.input.cwd,
  });
}

export type SourceControlRepository = GitRepositoryDescriptor;

export type SourceControlAction =
  | GitActionOperation
  | "stage"
  | "unstage"
  | "refresh"
  | "generate"
  | "view"
  | "sort";

export interface SourceControlWorkspaceScope {
  readonly environmentId: EnvironmentId;
  readonly repositoryRoot: string;
}

export function isSourceControlWorkspaceSupported(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "sourceControlWorkspace"> | null | undefined,
): boolean {
  return capabilities?.sourceControlWorkspace === true;
}

export type SourceControlWorkspaceUnavailableReason = "source-control-workspace-not-advertised";

export class SourceControlWorkspaceUnavailableError extends Schema.TaggedError<SourceControlWorkspaceUnavailableError>()(
  "SourceControlWorkspaceUnavailableError",
  {
    environmentId: EnvironmentId,
    repositoryRoot: Schema.String,
    reason: Schema.Literal("source-control-workspace-not-advertised"),
  },
) {
  override get message(): string {
    return "This environment has not advertised Source Control workspace support.";
  }
}

/** Additive workspace RPCs must not probe older or not-yet-negotiated servers. */
export function getSourceControlWorkspaceUnavailableReason(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "sourceControlWorkspace"> | null | undefined,
): SourceControlWorkspaceUnavailableReason | null {
  return isSourceControlWorkspaceSupported(capabilities)
    ? null
    : "source-control-workspace-not-advertised";
}

export function buildRepositoryScopeKey(
  environmentId: EnvironmentId | string,
  repository: Pick<SourceControlRepository, "rootPath">,
): string {
  const root = normalizeVcsRepositoryRoot(repository.rootPath);
  return `${environmentId}:${root}`;
}

export function chooseActiveRepository(
  repositories: readonly SourceControlRepository[],
  selectedRoot: string | null | undefined,
  projectRoot: string,
): SourceControlRepository | null {
  const selected = selectedRoot
    ? repositories.find((repository) => repository.rootPath === selectedRoot)
    : undefined;
  if (selected) return selected;
  return (
    repositories.find((repository) => repository.rootPath === projectRoot) ??
    repositories[0] ??
    null
  );
}

const NON_CONFIRMING_ACTIONS = new Set<SourceControlAction>([
  "commit",
  "stage",
  "unstage",
  "fetch",
  "refresh",
  "generate",
  "view",
  "sort",
]);

const workspaceRevisionByScope = Atom.family((scope: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`source-control-workspace:revision:${scope}`)),
);
const statusRefreshByScope = Atom.family((scope: string) =>
  Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel(`source-control-workspace:status-refresh:${scope}`),
  ),
);
const statusSubscriptionStateByScope = Atom.family((scope: string) =>
  Atom.make<EnvironmentSubscriptionSnapshot<VcsStatusResult>>({
    generation: 0,
    snapshotGeneration: null,
    value: null,
  }).pipe(Atom.keepAlive, Atom.withLabel(`source-control-workspace:status-subscription:${scope}`)),
);

export function sourceControlWorkspaceStatusRefreshAtom(scope: SourceControlWorkspaceScope) {
  return statusRefreshByScope(
    buildRepositoryScopeKey(scope.environmentId, { rootPath: scope.repositoryRoot }),
  );
}

/** The reviewed status value from the currently connected subscription generation. */
export function sourceControlWorkspaceStatusSubscriptionStateAtom(
  scope: SourceControlWorkspaceScope,
) {
  return statusSubscriptionStateByScope(
    buildRepositoryScopeKey(scope.environmentId, { rootPath: scope.repositoryRoot }),
  );
}

export function sourceControlWorkspaceRevisionAtom(scope: SourceControlWorkspaceScope) {
  return workspaceRevisionByScope(
    buildRepositoryScopeKey(scope.environmentId, { rootPath: scope.repositoryRoot }),
  );
}

export function invalidateSourceControlWorkspace(
  registry: AtomRegistry.AtomRegistry,
  scope: SourceControlWorkspaceScope,
  refreshStatus = true,
): void {
  for (const target of vcsInvalidationTargets(registry, {
    environmentId: scope.environmentId,
    cwd: scope.repositoryRoot,
  })) {
    const affected = { environmentId: target.environmentId, repositoryRoot: target.cwd };
    registry.update(sourceControlWorkspaceRevisionAtom(affected), (revision) => revision + 1);
    if (refreshStatus) {
      registry.update(
        sourceControlWorkspaceStatusRefreshAtom(affected),
        (revision) => revision + 1,
      );
    }
  }
}

export function isSourceControlActionConfirmRequired(action: SourceControlAction): boolean {
  return !NON_CONFIRMING_ACTIONS.has(action);
}

export function isCurrentSourceControlRequest(
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId;
}

/**
 * Composer-only choices intentionally live for the application session, not
 * in Settings or local storage. A commit message is separately recoverable by
 * the host UI, but temporary writing guidance must never leak into a later
 * session.
 */
export type SourceControlComposerSessionAction = "commit" | "amend" | "commit-push" | "commit-sync";

export interface SourceControlComposerSessionDraft {
  readonly message: string;
  readonly instructions: string;
  readonly action: SourceControlComposerSessionAction;
}

const composerSessionDrafts = new Map<string, SourceControlComposerSessionDraft>();

export function readSourceControlComposerSessionDraft(
  scope: string,
): SourceControlComposerSessionDraft | undefined {
  return composerSessionDrafts.get(scope);
}

export function updateSourceControlComposerSessionDraft(
  scope: string,
  draft: SourceControlComposerSessionDraft,
): void {
  composerSessionDrafts.set(scope, draft);
}

/** Clears process-local session state when an application session ends. */
export function clearSourceControlComposerSessionDrafts(): void {
  composerSessionDrafts.clear();
}

export interface SourceControlCompoundResult {
  readonly completed: readonly string[];
  readonly commitSha?: string;
  readonly failedStep?: string;
  readonly error?: unknown;
  readonly continuation?: GitActionContinuation;
  /** The durable server receipt is retained by repository scope for a safe retry. */
  readonly receipt?: GitActionResult;
}

const mutationTags = {
  runAction: WS_METHODS.gitRunAction,
  commitIndex: WS_METHODS.gitCommitIndex,
  stageFiles: WS_METHODS.vcsStageFiles,
  unstageFiles: WS_METHODS.vcsUnstageFiles,
  refreshStatus: WS_METHODS.vcsRefreshStatus,
  init: WS_METHODS.vcsInit,
  createWorktree: WS_METHODS.vcsCreateWorktree,
} as const;
type MutationCommand = keyof typeof mutationTags;
export type SourceControlMutationStep = {
  [K in MutationCommand]: {
    readonly command: K;
    readonly input: Omit<EnvironmentRpcInput<(typeof mutationTags)[K]>, "cwd" | "confirm">;
  };
}[MutationCommand];

function mutationAction(step: SourceControlMutationStep): SourceControlAction {
  switch (step.command) {
    case "runAction":
      return step.input.action;
    case "commitIndex":
      return step.input.amend === true ? "amend" : "commit";
    case "stageFiles":
      return "stage";
    case "unstageFiles":
      return "unstage";
    case "refreshStatus":
      return "refresh";
    case "init":
    case "createWorktree":
      return "branch";
  }
}

/**
 * `git.runAction` carries more safety information than its broad action name.
 * Keep that leaf intact here: stage/unstage and stash view are deliberately
 * non-confirming, while a compound commit is still an approved mutation.
 */
export function isSourceControlMutationStepConfirmRequired(
  step: SourceControlMutationStep,
): boolean {
  if (step.command !== "runAction")
    return isSourceControlActionConfirmRequired(mutationAction(step));
  const input = step.input;
  return !(
    input.action === "fetch" ||
    (input.action === "discard" &&
      (input.changeOperation === "stage" || input.changeOperation === "unstage")) ||
    (input.action === "stash" && input.stashOperation === "view") ||
    (input.action === "commit" && input.compoundOperation === undefined)
  );
}

export interface SourceControlMutationInput {
  readonly cwd: string;
  readonly confirmation?: "approved" | "cancelled";
  readonly steps: readonly SourceControlMutationStep[];
}

export interface SourceControlMutationResult extends SourceControlCompoundResult {
  readonly status: "confirmation-required" | "cancelled" | "executed";
  readonly results: readonly unknown[];
}

export interface SourceControlWorkspaceProgress extends SourceControlCompoundResult {
  readonly isRunning: boolean;
  readonly currentStep: string | null;
}

const progressByScope = Atom.family((key: string) =>
  Atom.make<SourceControlWorkspaceProgress>({
    isRunning: false,
    currentStep: null,
    completed: [],
  }).pipe(Atom.keepAlive, Atom.withLabel(`source-control-workspace:progress:${key}`)),
);

export function sourceControlWorkspaceProgressAtom(scope: SourceControlWorkspaceScope) {
  return progressByScope(
    buildRepositoryScopeKey(scope.environmentId, { rootPath: scope.repositoryRoot }),
  );
}

function continuationMatchesAction(
  continuation: GitActionContinuation | undefined,
  input: Extract<SourceControlMutationStep, { readonly command: "runAction" }>["input"],
): boolean {
  if (!continuation || continuation.action !== input.action) return false;
  return (
    continuation.remoteName === input.remoteName &&
    continuation.refName === input.refName &&
    continuation.sourceRef === input.sourceRef &&
    continuation.pullRemoteName === input.pullRemoteName &&
    continuation.pullRefName === input.pullRefName &&
    continuation.strategy === input.strategy
  );
}

function mergeCompleted(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

export class SourceControlMutationNotExecutedError extends Schema.TaggedError<SourceControlMutationNotExecutedError>()(
  "SourceControlMutationNotExecutedError",
  { status: Schema.Literals(["confirmation-required", "cancelled"]) },
) {}

export class SourceControlMutationExecutionError extends Schema.TaggedError<SourceControlMutationExecutionError>()(
  "SourceControlMutationExecutionError",
  { failedStep: Schema.String, completed: Schema.Array(Schema.String), cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : `${this.failedStep} failed.`;
  }
}

/** Shared repository-scoped commands used by web and desktop clients. */
export function createSourceControlWorkspaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  options?: {
    readonly capabilities?: (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
    ) => Pick<ExecutionEnvironmentCapabilities, "sourceControlWorkspace"> | null | undefined;
  },
) {
  const guardWorkspaceCapability = <T extends { readonly cwd: string }>(
    target: { readonly environmentId: EnvironmentId; readonly input: T },
    registry: AtomRegistry.AtomRegistry,
  ) => {
    const capabilities = options?.capabilities?.(registry, target.environmentId);
    return isSourceControlWorkspaceSupported(capabilities)
      ? Effect.void
      : Effect.fail(
          new SourceControlWorkspaceUnavailableError({
            environmentId: target.environmentId,
            repositoryRoot: target.input.cwd,
            reason: "source-control-workspace-not-advertised",
          }),
        );
  };
  const executeMutation = createEnvironmentCommand(runtime, {
    label: "environment-data:source-control:execute-mutation",
    scheduler: vcsCommandScheduler,
    concurrency: vcsCommandConcurrency,
    execute: (input: SourceControlMutationInput, registry, environmentId) =>
      Effect.gen(function* () {
        yield* guardWorkspaceCapability({ environmentId, input }, registry);
        const requiresConfirmation = input.steps.some(isSourceControlMutationStepConfirmRequired);
        if (input.confirmation === "cancelled") {
          return {
            status: "cancelled",
            completed: [],
            results: [],
          } satisfies SourceControlMutationResult;
        }
        if (requiresConfirmation && input.confirmation !== "approved") {
          return {
            status: "confirmation-required",
            completed: [],
            results: [],
          } satisfies SourceControlMutationResult;
        }
        const completed: string[] = [];
        const results: unknown[] = [];
        let continuation: GitActionContinuation | undefined;
        let receipt: GitActionResult | undefined;
        let commitSha: string | undefined;
        const progress = sourceControlWorkspaceProgressAtom({
          environmentId,
          repositoryRoot: input.cwd,
        });
        const existingProgress = registry.get(progress);
        const resolvesContinuation =
          input.steps.length === 1 &&
          input.steps[0]?.command === "runAction" &&
          continuationMatchesAction(existingProgress.continuation, input.steps[0].input);
        return yield* Effect.gen(function* () {
          for (const step of input.steps) {
            const action = mutationAction(step);
            const prior = registry.get(progress);
            const { failedStep: _failedStep, error: _error, ...retryingPrior } = prior;
            registry.set(progress, {
              ...(resolvesContinuation ? retryingPrior : prior),
              isRunning: true,
              currentStep: action,
              // A repository can have a safe deferred compound receipt while
              // unrelated mutations run. Keep that durable history separate
              // from the current operation's temporary completed list.
              completed:
                !resolvesContinuation && prior.continuation !== undefined
                  ? prior.completed
                  : resolvesContinuation
                    ? prior.completed
                    : [...completed],
            });
            const exit = yield* request(mutationTags[step.command], {
              ...step.input,
              cwd: normalizeVcsRepositoryRoot(input.cwd),
              ...(step.command === "runAction"
                ? {
                    confirm:
                      isSourceControlMutationStepConfirmRequired(step) &&
                      input.confirmation === "approved",
                  }
                : {}),
            }).pipe(Effect.exit);
            if (Exit.isFailure(exit)) {
              const failure = { failedStep: action, error: Cause.squash(exit.cause) };
              if (!resolvesContinuation && prior.continuation !== undefined) {
                registry.set(progress, {
                  ...prior,
                  isRunning: false,
                  currentStep: null,
                });
                return {
                  status: "executed",
                  completed,
                  results,
                  ...failure,
                } satisfies SourceControlMutationResult;
              }
              registry.set(progress, {
                ...prior,
                isRunning: false,
                currentStep: null,
                completed: resolvesContinuation ? prior.completed : completed,
                ...failure,
              });
              return {
                status: "executed",
                completed: resolvesContinuation ? prior.completed : completed,
                results,
                ...(prior.commitSha ? { commitSha: prior.commitSha } : {}),
                ...(prior.continuation ? { continuation: prior.continuation } : {}),
                ...(prior.receipt ? { receipt: prior.receipt } : {}),
                ...failure,
              } satisfies SourceControlMutationResult;
            }
            const actionResult =
              step.command === "runAction" ? (exit.value as GitActionResult) : undefined;
            completed.push(...(actionResult ? actionResult.completed : [action]));
            results.push(exit.value);
            if (actionResult !== undefined) {
              receipt = actionResult;
              if (actionResult.commitSha !== undefined) commitSha = actionResult.commitSha;
              if (actionResult.continuation !== undefined) continuation = actionResult.continuation;
            }
            if (actionResult?.failedStep !== undefined) {
              if (!resolvesContinuation && prior.continuation !== undefined) {
                registry.set(progress, {
                  ...prior,
                  isRunning: false,
                  currentStep: null,
                });
                return {
                  status: "executed",
                  completed: actionResult.completed,
                  results,
                  failedStep: actionResult.failedStep,
                } satisfies SourceControlMutationResult;
              }
              const failedStep = actionResult.failedStep;
              const mergedCompleted = resolvesContinuation
                ? mergeCompleted(prior.completed, completed)
                : completed;
              const commitShaToKeep = commitSha ?? prior.commitSha;
              const receiptToKeep = prior.receipt ?? receipt;
              registry.set(progress, {
                isRunning: false,
                currentStep: null,
                completed: mergedCompleted,
                failedStep,
                ...(commitShaToKeep ? { commitSha: commitShaToKeep } : {}),
                ...(continuation ? { continuation } : {}),
                ...(receiptToKeep ? { receipt: receiptToKeep } : {}),
              });
              return {
                status: "executed",
                completed: mergedCompleted,
                results,
                ...(commitShaToKeep ? { commitSha: commitShaToKeep } : {}),
                ...(continuation ? { continuation } : {}),
                ...(receiptToKeep ? { receipt: receiptToKeep } : {}),
                failedStep,
              } satisfies SourceControlMutationResult;
            }
          }
          return { status: "executed", completed, results } satisfies SourceControlMutationResult;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              registry.update(progress, (state) => ({
                ...(resolvesContinuation && state.failedStep === undefined
                  ? (() => {
                      const {
                        commitSha: _commitSha,
                        failedStep: _failedStep,
                        error: _error,
                        continuation: _continuation,
                        receipt: _receipt,
                        ...cleared
                      } = state;
                      return { ...cleared, completed: [] };
                    })()
                  : state),
                isRunning: false,
                currentStep: null,
              }));
              yield* invalidateSourceControlWorkspaceState({ environmentId, input }, registry);
            }),
          ),
        );
      }),
  });
  // Compatibility adapters preserve legacy success values. All policy and RPC execution
  // still belongs to executeMutation; new callers consume its two-phase result directly.
  const mutationCommand = <K extends MutationCommand>(command: K) => ({
    label: `environment-data:source-control:${command}`,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: {
        readonly environmentId: EnvironmentId;
        readonly input: EnvironmentRpcInput<(typeof mutationTags)[K]> & {
          readonly confirmation?: "approved" | "cancelled";
        };
      },
    ): Promise<
      AtomCommandResult<
        EnvironmentRpcSuccess<(typeof mutationTags)[K]>,
        | AtomCommandFailure<Awaited<ReturnType<typeof executeMutation.run>>>
        | SourceControlMutationNotExecutedError
        | SourceControlMutationExecutionError
      >
    > => {
      const { cwd, confirmation, ...input } = target.input;
      const approval =
        confirmation ?? ("confirm" in input && input.confirm === true ? "approved" : undefined);
      const result = await executeMutation.run(registry, {
        environmentId: target.environmentId,
        input: {
          cwd,
          ...(approval ? { confirmation: approval } : {}),
          steps: [{ command, input } as SourceControlMutationStep],
        },
      });
      if (AsyncResult.isFailure(result)) return AsyncResult.failure(result.cause);
      if (result.value.status !== "executed") {
        return AsyncResult.failure(
          Cause.fail(new SourceControlMutationNotExecutedError({ status: result.value.status })),
        );
      }
      if ("error" in result.value)
        return AsyncResult.failure(
          Cause.fail(
            new SourceControlMutationExecutionError({
              failedStep: command,
              completed: result.value.completed,
              cause: result.value.error,
            }),
          ),
        );
      return AsyncResult.success(
        result.value.results[0] as EnvironmentRpcSuccess<(typeof mutationTags)[K]>,
      );
    },
  });
  const dismissProgress = createEnvironmentCommand(runtime, {
    label: "environment-data:source-control:dismiss-progress",
    execute: (input: { readonly cwd: string }, registry, environmentId) =>
      Effect.sync(() => {
        registry.set(
          sourceControlWorkspaceProgressAtom({ environmentId, repositoryRoot: input.cwd }),
          { isRunning: false, currentStep: null, completed: [] },
        );
      }),
  });
  return {
    executeMutation,
    /** Every Source Control caller reads status through this scoped surface. */
    status: withCanonicalVcsRepository(
      createEnvironmentSubscriptionAtomFamily(runtime, {
        label: "environment-data:source-control:status",
        idleTtlMs: 10_000,
        snapshotState: ({ environmentId, input }) =>
          sourceControlWorkspaceStatusSubscriptionStateAtom({
            environmentId,
            repositoryRoot: input.cwd,
          }),
        onValue: (target, _value, registry) => publishSourceControlStatus(target, registry),
        refreshTrigger: ({ environmentId, input }) =>
          sourceControlWorkspaceStatusRefreshAtom({ environmentId, repositoryRoot: input.cwd }),
        subscribe: (input: VcsStatusInput) =>
          subscribe(WS_METHODS.subscribeVcsStatus, input).pipe(
            Stream.mapAccum(
              () => null as VcsStatusResult | null,
              (current, event) => {
                const next = applyGitStatusStreamEvent(current, event);
                return [next, [next]] as const;
              },
            ),
          ),
      }),
    ),
    refreshStatus: mutationCommand("refreshStatus"),
    workingTreePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:working-tree-page",
      tag: WS_METHODS.vcsWorkingTreePage,
      execute: (input) =>
        request(WS_METHODS.vcsWorkingTreePage, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      guard: guardWorkspaceCapability,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    stageFiles: mutationCommand("stageFiles"),
    unstageFiles: mutationCommand("unstageFiles"),
    getWorkingTreeDiff: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:working-tree-diff",
      tag: WS_METHODS.vcsGetWorkingTreeDiff,
      execute: (input) =>
        request(WS_METHODS.vcsGetWorkingTreeDiff, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      guard: guardWorkspaceCapability,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    commitIndex: mutationCommand("commitIndex"),
    init: mutationCommand("init"),
    createWorktree: mutationCommand("createWorktree"),
    listRefs: withCanonicalVcsRepository(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:source-control:list-refs",
        tag: WS_METHODS.vcsListRefs,
        refreshTrigger: ({ environmentId, input }) =>
          vcsRefsCacheStateAtom({ environmentId, cwd: input.cwd }),
      }),
    ),
    discoverRepositories: createEnvironmentCommand(runtime, {
      label: "environment-data:source-control:discover-repositories",
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      execute: (input: GitRepositoryDiscoveryInput, registry, environmentId) =>
        guardWorkspaceCapability({ environmentId, input }, registry).pipe(
          Effect.andThen(
            request(WS_METHODS.gitDiscoverRepositories, {
              ...input,
              cwd: normalizeVcsRepositoryRoot(input.cwd),
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() =>
              registerVcsRepositories(
                registry,
                environmentId,
                result.projectRoot,
                result.repositories,
              ),
            ),
          ),
        ),
    }),
    commitGraphPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:commit-graph-page",
      tag: WS_METHODS.gitCommitGraphPage,
      execute: (input) =>
        request(WS_METHODS.gitCommitGraphPage, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      guard: guardWorkspaceCapability,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    commitFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:commit-files",
      tag: WS_METHODS.gitCommitFiles,
      execute: (input) =>
        request(WS_METHODS.gitCommitFiles, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      guard: guardWorkspaceCapability,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    compareRepositoryFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:compare-repository-file",
      tag: WS_METHODS.gitCompareRepositoryFile,
      execute: (input) =>
        request(WS_METHODS.gitCompareRepositoryFile, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      guard: guardWorkspaceCapability,
    }),
    runAction: mutationCommand("runAction"),
    dismissProgress,
    generateCommitMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:generate-commit-message",
      tag: WS_METHODS.gitGenerateCommitMessage,
      execute: (input) =>
        request(WS_METHODS.gitGenerateCommitMessage, {
          ...input,
          cwd: normalizeVcsRepositoryRoot(input.cwd),
        }),
      guard: guardWorkspaceCapability,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}

export type SourceControlWorkspaceDiscoveryInput = GitRepositoryDiscoveryInput;
export type SourceControlWorkspaceGraphInput = GitCommitGraphPageInput;
export type SourceControlWorkspaceFilesInput = GitCommitFilesInput;
export type SourceControlWorkspaceComparisonInput = GitRepositoryComparisonInput;
