import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isRepositoryTopLevel } from "./ProjectWorkRepositoryRoot.ts";

it.effect("a repository top level matches its worktree only through real parent folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-repository-root-" });
    const realParent = path.join(dir, "worktrees");
    const linkedParent = path.join(dir, "worktrees-link");
    const other = path.join(dir, "other-repository");
    yield* fs.makeDirectory(path.join(realParent, "task"), { recursive: true });
    yield* fs.makeDirectory(other);
    yield* fs.symlink(realParent, linkedParent);
    yield* fs.symlink(other, path.join(realParent, "swapped"));
    const gitAnswer = (target: string) => fs.realPath(target).pipe(Effect.orDie);

    // A worktrees folder reached through a link is still the same worktree.
    const task = path.join(linkedParent, "task");
    assert.isTrue(yield* isRepositoryTopLevel(yield* gitAnswer(task), task));
    // A worktree replaced by a link to another repository is not that repository's top level.
    const swapped = path.join(realParent, "swapped");
    assert.isFalse(yield* isRepositoryTopLevel(yield* gitAnswer(swapped), swapped));
    // A plain folder inside a repository: Git answers for the enclosing one.
    assert.isFalse(yield* isRepositoryTopLevel(dir, path.join(realParent, "task")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
