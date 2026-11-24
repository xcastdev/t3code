import { describe, expect, it } from "@effect/vitest";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";

import {
  selectWorkRepository,
  type WorkRepositorySelection,
} from "./ProjectWorkRepositorySelection.ts";

const plain = { projectIsRepository: false, trackedRepositories: ["/shop/api", "/shop/web"] };

describe("selectWorkRepository", () => {
  it.effect.each<
    [
      string,
      Parameters<typeof selectWorkRepository>[1]["plan"],
      string | undefined,
      WorkRepositorySelection,
    ]
  >([
    ["a single-folder project works in its folder", null, undefined, { _tag: "selected" }],
    [
      "a repository project folder is the default over its tracked repositories",
      { ...plain, projectIsRepository: true },
      undefined,
      { _tag: "selected" },
    ],
    [
      "a plain project folder falls back to its only repository",
      { projectIsRepository: false, trackedRepositories: ["/shop/api"] },
      undefined,
      { _tag: "selected", repository: "/shop/api" },
    ],
    [
      "a plain project folder with several repositories must name one",
      plain,
      undefined,
      { _tag: "refused", reason: "repository-required" },
    ],
    [
      "a named tracked repository is selected",
      plain,
      "/shop/web/",
      { _tag: "selected", repository: "/shop/web" },
    ],
    [
      "naming a repository project folder selects the folder",
      { ...plain, projectIsRepository: true },
      "/shop",
      { _tag: "selected" },
    ],
    [
      "naming a plain project folder is refused",
      plain,
      "/shop",
      { _tag: "refused", reason: "repository-unavailable" },
    ],
    [
      "an untracked folder is refused",
      plain,
      "/elsewhere",
      { _tag: "refused", reason: "repository-unavailable" },
    ],
    [
      "a relative path is refused",
      plain,
      "api",
      { _tag: "refused", reason: "repository-unavailable" },
    ],
  ])("%s", ([, plan, requested, expected]) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(selectWorkRepository(path, { projectRoot: "/shop", plan, requested })).toEqual(
        expected,
      );
    }).pipe(Effect.provide(Path.layer)),
  );
});
