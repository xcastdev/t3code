import { EnvironmentId, type GitHistoryResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applySourceControlHistoryPage,
  beginSourceControlHistoryLoad,
  createSourceControlHistoryState,
  disconnectSourceControlHistory,
  sameIndexFingerprint,
  sourceControlRepositoryKey,
  type SourceControlHistoryState,
  type SourceControlRepositoryTarget,
} from "./sourceControlWorkspace.ts";

const target = { environmentId: EnvironmentId.make("environment"), rootPath: "/canonical/repo" };
const commit = (sha: string) => ({
  sha,
  parents: [],
  subject: sha,
  author: "A",
  authoredAt: "2026-10-21",
});
const page = (shas: string[], nextCursor: string | null = null): GitHistoryResult => ({
  commits: shas.map(commit),
  nextCursor,
  stale: false,
});

const applyPage = (
  state: SourceControlHistoryState,
  target: SourceControlRepositoryTarget,
  page: GitHistoryResult,
) => applySourceControlHistoryPage(state, target, page, state.requestVersion);

describe("source control workspace history", () => {
  it("isolates environment and repository selection while an old response arrives", () => {
    const state = beginSourceControlHistoryLoad(createSourceControlHistoryState(target));
    for (const other of [
      { ...target, environmentId: EnvironmentId.make("other") },
      { ...target, rootPath: "/other" },
    ]) {
      expect(sourceControlRepositoryKey(target)).not.toBe(sourceControlRepositoryKey(other));
      expect(applyPage(state, other, page(["old"]))).toBe(state);
    }
    expect(applyPage(state, target, page(["new"])).commits).toEqual([commit("new")]);
  });

  it("deduplicates overlapping pages and stops requesting history at the bound", () => {
    let state = beginSourceControlHistoryLoad(createSourceControlHistoryState(target));
    state = applyPage(state, target, page(["a", "b"], "cursor"));
    state = applyPage(beginSourceControlHistoryLoad(state), target, page(["b", "c"], "next"));
    expect(state.commits.map((entry) => entry.sha)).toEqual(["a", "b", "c"]);
    state = applyPage(
      beginSourceControlHistoryLoad(state),
      target,
      page(
        Array.from({ length: 600 }, (_, i) => String(i)),
        "more",
      ),
    );
    expect(state.commits).toHaveLength(500);
    expect(state.nextCursor).toBeNull();
    state = applyPage(beginSourceControlHistoryLoad(state), target, page(["overflow"], "more"));
    expect(state.commits).toHaveLength(500);
    expect(state.nextCursor).toBeNull();
  });

  it("invalidates a stale cursor and replaces the old chain on reload", () => {
    let state = applyPage(
      beginSourceControlHistoryLoad(createSourceControlHistoryState(target)),
      target,
      page(["old"], "cursor"),
    );
    state = applyPage(beginSourceControlHistoryLoad(state), target, {
      commits: [],
      nextCursor: null,
      stale: true,
    });
    expect(state).toMatchObject({ stale: true, loading: false, nextCursor: null });
    state = applyPage(beginSourceControlHistoryLoad(state), target, page(["new"]));
    expect(state.commits).toEqual([commit("new")]);
    expect(state.stale).toBe(false);
  });

  it("rejects a response after disconnect and reloads from a new chain", () => {
    const pending = beginSourceControlHistoryLoad(createSourceControlHistoryState(target));
    const disconnected = disconnectSourceControlHistory(pending);
    expect(applyPage(disconnected, target, page(["late"]))).toBe(disconnected);
    expect(disconnected).toMatchObject({ stale: true, loading: false, nextCursor: null });
  });

  it("rejects a response from before disconnect after a replacement load starts", () => {
    const pending = beginSourceControlHistoryLoad(createSourceControlHistoryState(target));
    const replacement = beginSourceControlHistoryLoad(disconnectSourceControlHistory(pending));
    expect(
      applySourceControlHistoryPage(replacement, target, page(["late"]), pending.requestVersion),
    ).toBe(replacement);
    expect(
      applySourceControlHistoryPage(replacement, target, page(["new"]), replacement.requestVersion)
        .commits,
    ).toEqual([commit("new")]);
  });

  it("compares every part of the exact reviewed index fingerprint", () => {
    const fingerprint = {
      rootPath: target.rootPath,
      headCommit: "head",
      headRef: "refs/heads/main",
      index: "index",
      worktree: "worktree",
    };
    expect(sameIndexFingerprint(fingerprint, { ...fingerprint })).toBe(true);
    for (const changed of [
      { ...fingerprint, rootPath: "/other" },
      { ...fingerprint, headCommit: null },
      { ...fingerprint, headRef: "refs/heads/other" },
      { ...fingerprint, index: "changed" },
      { ...fingerprint, worktree: "changed" },
    ])
      expect(sameIndexFingerprint(fingerprint, changed)).toBe(false);
  });
});
