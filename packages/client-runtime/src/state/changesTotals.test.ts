import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { resolveChangesTotals } from "./changesTotals.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveChangesTotals", () => {
  it("does not let an empty branchChanges hide a dirty working tree", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          hasWorkingTreeChanges: true,
          branchChanges: { baseRef: "main", insertions: 0, deletions: 0 },
          workingTree: {
            files: [
              { path: "a.ts", insertions: 4, deletions: 1 },
              { path: "README.md", insertions: 1, deletions: 0 },
            ],
            insertions: 5,
            deletions: 1,
          },
        }),
      ),
      {
        insertions: 5,
        deletions: 1,
        breakdown: {
          code: { additions: 4, deletions: 1 },
          tests: { additions: 0, deletions: 0 },
          mocks: { additions: 0, deletions: 0 },
          generated: { additions: 0, deletions: 0 },
          docs: { additions: 1, deletions: 0 },
        },
      },
    );
  });

  it("keeps non-zero branchChanges over the working tree", () => {
    assert.deepEqual(
      resolveChangesTotals(
        status({
          branchChanges: { baseRef: "origin/master", insertions: 20, deletions: 3 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
        }),
      ),
      { insertions: 20, deletions: 3, baseRef: "origin/master", breakdown: null },
    );
  });

  it("uses the panel's branch comparison when it has file stats", () => {
    const dirty = status({
      branchChanges: { baseRef: "main", insertions: 20, deletions: 3 },
    });
    const source = {
      id: "branch-range",
      kind: "branch-range",
      title: "Changes vs release",
      baseRef: "release",
      headRef: "feature/test",
      diff: "",
      diffHash: "hash",
      truncated: false,
    } as const;
    assert.deepEqual(
      resolveChangesTotals(dirty, {
        ...source,
        files: [
          { path: "a.ts", previousPath: null, additions: 4, deletions: 1 },
          { path: "a.test.ts", previousPath: null, additions: 2, deletions: 0 },
        ],
      }),
      {
        insertions: 6,
        deletions: 1,
        baseRef: "release",
        breakdown: {
          code: { additions: 4, deletions: 1 },
          tests: { additions: 2, deletions: 0 },
          mocks: { additions: 0, deletions: 0 },
          generated: { additions: 0, deletions: 0 },
          docs: { additions: 0, deletions: 0 },
        },
      },
    );
    assert.deepEqual(resolveChangesTotals(dirty, source), {
      insertions: 20,
      deletions: 3,
      baseRef: "main",
      breakdown: null,
    });
  });

  it("falls back to the working tree when branchChanges is omitted", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          workingTree: {
            files: [{ path: "a.ts", insertions: 2, deletions: 0 }],
            insertions: 2,
            deletions: 0,
          },
        }),
      ),
      { insertions: 2, deletions: 0 },
    );
  });
});
