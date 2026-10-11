import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { GitCommandError } from "@t3tools/contracts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { canonicalGitMutationKey } from "./ManagedGitExecution.ts";

const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const mutationSemaphores = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const ensureGitCommand = Effect.fn("GitRepositoryPermits.ensureGitCommand")(function* (
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

  const mutationKey = (handle: VcsDriverRegistry.VcsDriverHandle, cwd: string) =>
    handle.repository.metadataPath
      ? canonicalGitMutationKey(handle.repository.metadataPath, cwd)
      : Effect.succeed(`${handle.kind}\0${handle.repository.rootPath}`);

  const getMutationSemaphore = Effect.fn("GitRepositoryPermits.getMutationSemaphore")(function* (
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
        mutationKey(handle, cwd).pipe(
          Effect.flatMap(getMutationSemaphore),
          Effect.flatMap((semaphore) => semaphore.withPermit(mutation)),
        ),
      ),
    );

  return { getMutationSemaphore, withRepositoryPermit: serializedMutation };
});

// Verification preparation needs the same lock as mutations, before provider instances exist.
export class GitRepositoryPermits extends Context.Service<
  GitRepositoryPermits,
  Effect.Success<typeof make>
>()("t3/git/GitRepositoryPermits") {}

export const layer = Layer.effect(GitRepositoryPermits, make);
