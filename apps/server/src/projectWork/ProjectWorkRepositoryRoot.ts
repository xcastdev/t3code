import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Whether Git's `--show-toplevel` answer names the stored worktree. Git resolves symlinks
 * and prints forward slashes on Windows, so both sides compare by their real location.
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
    return (yield* real(gitTopLevel)) === (yield* real(worktree));
  },
);
