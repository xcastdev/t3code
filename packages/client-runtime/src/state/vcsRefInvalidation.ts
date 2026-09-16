import type { EnvironmentId, GitRepositoryDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export interface VcsRefsInvalidationTarget {
  readonly environmentId: EnvironmentId;
  /** Canonical repository root. Ref snapshots are never shared by nested repositories. */
  readonly cwd: string;
}

export type CachedVcsRefsInvalidationTarget = VcsRefsInvalidationTarget;

export interface VcsRefsCacheState {
  readonly revision: number;
  readonly persistedCacheReadable: boolean;
}

export function normalizeVcsRepositoryRoot(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/");
  const withoutTrailingSeparators = normalized.replace(/\/+$/, "");
  if (withoutTrailingSeparators === "") return "/";
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators) && /^[A-Za-z]:\/+$/.test(normalized)) {
    return `${withoutTrailingSeparators}/`;
  }
  if (/^\/\/[^/]+\/[^/]+$/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators}/`;
  }
  return withoutTrailingSeparators;
}

export function withCanonicalVcsRepository<Input extends { readonly cwd: string }, A>(
  query: (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => A,
) {
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) =>
    query({
      ...target,
      input: { ...target.input, cwd: normalizeVcsRepositoryRoot(target.input.cwd) },
    });
}

function vcsRefsScopeKey(target: VcsRefsInvalidationTarget): string {
  const root = normalizeVcsRepositoryRoot(target.cwd);
  return `${target.environmentId}:${root}`;
}

const stateByRepository = Atom.family((scope: string) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-state:${scope}`)),
);
const persistenceLock = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });
interface SubmoduleParentRelationship {
  readonly parentRoot: string;
  readonly discoveredFrom: string;
}

const parentsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ReadonlyMap<string, SubmoduleParentRelationship>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel(`vcs:submodule-parents:${environmentId}`),
  ),
);

/** Discovery's isSubmodule flag is authoritative; path nesting alone never links repositories. */
export function registerVcsRepositories(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  discoveryRoot: string,
  repositories: readonly GitRepositoryDescriptor[],
) {
  const canonicalDiscoveryRoot = normalizeVcsRepositoryRoot(discoveryRoot);
  const normalized = repositories.map((repository) => ({
    ...repository,
    rootPath: normalizeVcsRepositoryRoot(repository.rootPath),
  }));
  registry.update(parentsByEnvironment(environmentId), (current) => {
    const parents = new Map(current);
    for (const [childRoot, relationship] of parents) {
      if (relationship.discoveredFrom === canonicalDiscoveryRoot) parents.delete(childRoot);
    }
    for (const repository of normalized) {
      if (!repository.isSubmodule) continue;
      const parent = normalized
        .filter(
          (candidate) =>
            candidate.rootPath !== repository.rootPath &&
            repository.rootPath.startsWith(
              candidate.rootPath.endsWith("/") ? candidate.rootPath : `${candidate.rootPath}/`,
            ),
        )
        .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
      if (parent) {
        parents.set(repository.rootPath, {
          parentRoot: parent.rootPath,
          discoveredFrom: canonicalDiscoveryRoot,
        });
      }
    }
    return parents;
  });
}

export function vcsInvalidationTargets(
  registry: AtomRegistry.AtomRegistry,
  target: VcsRefsInvalidationTarget,
) {
  const parents = registry.get(parentsByEnvironment(target.environmentId));
  const targets: VcsRefsInvalidationTarget[] = [];
  let cwd: string | undefined = normalizeVcsRepositoryRoot(target.cwd);
  while (cwd !== undefined) {
    targets.push({ environmentId: target.environmentId, cwd });
    cwd = parents.get(cwd)?.parentRoot;
  }
  return targets;
}

export function vcsRefsCacheStateAtom(target: VcsRefsInvalidationTarget) {
  return stateByRepository(vcsRefsScopeKey(target));
}

export function invalidateVcsRefs(
  registry: AtomRegistry.AtomRegistry,
  target: VcsRefsInvalidationTarget,
  persistedCacheReadable?: boolean,
): void {
  registry.update(vcsRefsCacheStateAtom(target), (state) => ({
    revision: state.revision + 1,
    persistedCacheReadable: persistedCacheReadable ?? state.persistedCacheReadable,
  }));
}

export function withVcsRefsPersistenceLock<A, E, R>(
  target: VcsRefsInvalidationTarget,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return persistenceLock.withPermit(vcsRefsScopeKey(target))(effect);
}

/**
 * Removes the affected persisted snapshot and then restarts its live ref stream while holding
 * the same lock used by generation-checked refresh writes. Clearing first
 * prevents the restarted stream from rehydrating the invalidated snapshot. A
 * refresh that wins the lock is cleared afterward; one that loses observes the
 * new revision and cannot repersist its pre-mutation result.
 */
export const invalidateCachedVcsRefs = Effect.fn("VcsRefsState.invalidateCached")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
) {
  const cache = yield* EnvironmentCacheStore;
  for (const affected of vcsInvalidationTargets(registry, target)) {
    yield* withVcsRefsPersistenceLock(
      affected,
      Effect.gen(function* () {
        const repositoryRoot = affected.cwd;
        const persistedCacheReadable = yield* cache
          .removeVcsRefs(target.environmentId, repositoryRoot)
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Could not remove invalidated cached Git refs.").pipe(
                Effect.annotateLogs({
                  environmentId: target.environmentId,
                  cwd: repositoryRoot,
                  ...safeErrorLogAttributes(error),
                }),
                Effect.as(false),
              ),
            ),
          );
        invalidateVcsRefs(registry, affected, persistedCacheReadable);
      }),
    );
  }
});
