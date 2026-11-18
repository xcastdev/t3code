import { describe, expect, it } from "vite-plus/test";

import { resolveThreadWorkspacePresentation } from "./threadComposerFooter";

const local = { worktreePath: null, threadBranch: null, liveBranch: null, isRepo: true } as const;

describe("resolveThreadWorkspacePresentation", () => {
  it.each([
    [
      "the live branch over the recorded one",
      { threadBranch: "old", liveBranch: "main" },
      "Local · main",
    ],
    ["the recorded branch before status arrives", { threadBranch: "main" }, "Local · main"],
    ["no branch when none is known", { threadBranch: "  " }, "Local"],
    ["no branch outside a repository", { threadBranch: "main", isRepo: false }, "Local"],
  ])("labels a local checkout with %s", (_name, overrides, label) => {
    expect(resolveThreadWorkspacePresentation({ ...local, ...overrides })).toEqual({
      kind: "local",
      label,
    });
  });

  it.each([
    ["its branch", { threadBranch: "feat/x", liveBranch: "feat/y" }, "feat/y"],
    ["its folder without a branch", {}, "wt-123"],
  ])("labels a worktree with %s", (_name, overrides, label) => {
    expect(
      resolveThreadWorkspacePresentation({
        ...local,
        worktreePath: "/home/me/.t3/worktrees/repo/wt-123/",
        ...overrides,
      }),
    ).toEqual({ kind: "worktree", label });
  });
});
