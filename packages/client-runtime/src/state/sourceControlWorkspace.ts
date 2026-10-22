import {
  WS_METHODS,
  type EnvironmentId,
  type GitIndexFingerprint,
  type GitHistoryResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { requestGuarded } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import { vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export interface SourceControlRepositoryTarget {
  readonly environmentId: EnvironmentId;
  readonly rootPath: string;
}

export function sourceControlRepositoryKey(target: SourceControlRepositoryTarget): string {
  return JSON.stringify([target.environmentId, target.rootPath]);
}

export function sameIndexFingerprint(
  left: GitIndexFingerprint,
  right: GitIndexFingerprint,
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.headCommit === right.headCommit &&
    left.headRef === right.headRef &&
    left.index === right.index &&
    left.worktree === right.worktree
  );
}

export interface SourceControlHistoryState {
  readonly target: SourceControlRepositoryTarget;
  readonly commits: GitHistoryResult["commits"];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly requestVersion: number;
  readonly stale: boolean;
}

export function createSourceControlHistoryState(
  target: SourceControlRepositoryTarget,
): SourceControlHistoryState {
  return { target, commits: [], nextCursor: null, loading: false, requestVersion: 0, stale: false };
}

export function beginSourceControlHistoryLoad(
  state: SourceControlHistoryState,
): SourceControlHistoryState {
  return {
    ...state,
    commits: state.stale ? [] : state.commits,
    loading: true,
    stale: false,
    requestVersion: state.requestVersion + 1,
  };
}

export function applySourceControlHistoryPage(
  state: SourceControlHistoryState,
  target: SourceControlRepositoryTarget,
  page: GitHistoryResult,
  requestVersion: number,
): SourceControlHistoryState {
  if (requestVersion !== state.requestVersion || !state.loading) return state;
  if (sourceControlRepositoryKey(state.target) !== sourceControlRepositoryKey(target)) return state;
  if (page.stale) return { ...state, loading: false, stale: true, nextCursor: null };
  const seen = new Set(state.commits.map((commit) => commit.sha));
  const commits = [...state.commits].slice(0, 500);
  for (const commit of page.commits) {
    if (commits.length >= 500) break;
    if (!seen.has(commit.sha)) {
      seen.add(commit.sha);
      commits.push(commit);
    }
  }
  return {
    ...state,
    commits,
    loading: false,
    stale: false,
    nextCursor: commits.length >= 500 ? null : page.nextCursor,
  };
}

export function disconnectSourceControlHistory(
  state: SourceControlHistoryState,
): SourceControlHistoryState {
  return {
    ...state,
    loading: false,
    stale: true,
    nextCursor: null,
    requestVersion: state.requestVersion + 1,
  };
}

const revisions = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.withLabel(`source-control:revision:${key}`)),
);

export function createSourceControlWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const refresh = (target: SourceControlRepositoryTarget, registry: AtomRegistry.AtomRegistry) => {
    registry.update(revisions(sourceControlRepositoryKey(target)), (revision) => revision + 1);
  };
  const refreshTrigger = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string };
  }) =>
    revisions(
      sourceControlRepositoryKey({
        environmentId: target.environmentId,
        rootPath: target.input.cwd,
      }),
    );
  const onSettled = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly expected: GitIndexFingerprint };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      refresh(
        { environmentId: target.environmentId, rootPath: target.input.expected.rootPath },
        registry,
      ),
    ).pipe(
      Effect.andThen(
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.expected.rootPath,
        }),
      ),
    );
  const concurrency = {
    mode: "serial" as const,
    key: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly expected: GitIndexFingerprint };
    }) =>
      sourceControlRepositoryKey({
        environmentId: target.environmentId,
        rootPath: target.input.expected.rootPath,
      }),
  };
  return {
    refresh,
    discoverRepositories: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repositories",
      tag: WS_METHODS.gitDiscoverRepositories,
    }),
    indexStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:index-status",
      tag: WS_METHODS.gitIndexStatus,
      refreshTrigger,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:history",
      tag: WS_METHODS.gitHistory,
      refreshTrigger,
    }),
    historyDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:history-diff",
      tag: WS_METHODS.gitHistoryDiff,
      refreshTrigger,
    }),
    mutateIndex: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:mutate-index",
      tag: WS_METHODS.gitMutateIndex,
      execute: (input) =>
        requestGuarded(WS_METHODS.gitMutateIndex, { ...input, cwd: input.expected.rootPath }),
      scheduler: vcsCommandScheduler,
      concurrency,
      onSettled,
    }),
    commitStaged: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:commit-staged",
      tag: WS_METHODS.gitCommitStaged,
      execute: (input) =>
        requestGuarded(WS_METHODS.gitCommitStaged, { ...input, cwd: input.expected.rootPath }),
      scheduler: vcsCommandScheduler,
      concurrency,
      onSettled,
    }),
  };
}
