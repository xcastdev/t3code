import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Whether Git's `--show-toplevel` answer names the stored worktree. Git resolves symlinks
 * and prints forward slashes on Windows, so the worktree's parent folders compare by their
 * real location. The worktree itself must not be a link: one to another repository would
 * otherwise pass as that repository's top level.
 */
export const isRepositoryTopLevel = Effect.fn("ProjectWorkRepositoryRoot.isRepositoryTopLevel")(
  function* (gitTopLevel: string, worktree: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = (target: string) =>
      fs.realPath(target).pipe(
        Effect.map((resolved) => path.resolve(resolved)),
        Effect.orElseSucceed(() => path.resolve(target)),
      );
    const isLink = yield* fs.readLink(worktree).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isLink) return false;
    const resolvedWorktree = path.resolve(worktree);
    const worktreeReal = path.join(
      yield* real(path.dirname(resolvedWorktree)),
      path.basename(resolvedWorktree),
    );
    return (yield* real(gitTopLevel)) === worktreeReal;
  },
);
