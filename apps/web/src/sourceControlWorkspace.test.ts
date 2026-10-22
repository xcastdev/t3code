import {
  EnvironmentId,
  type GitHistoryResult,
  type GitIndexStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHistoryGraph,
  commitOutcomePresentation,
  indexMutationPaths,
  repositoryDisplayName,
  resolveSelectedRepositoryRoot,
  type SourceControlHistoryPageResult,
  stagedCommitBlocker,
  useSourceControlWorkspaceStore,
  workspaceRelativeRepositoryPath,
} from "./sourceControlWorkspace";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-b");
const ROOT = "/work/app";

function setup() {
  useSourceControlWorkspaceStore.setState({
    selectedRootByWorkspace: {},
    historyByRepository: {},
    historyGenerationByRepository: {},
  });
}

function commit(sha: string, parents: ReadonlyArray<string> = []) {
  return {
    sha,
    parents: [...parents],
    subject: sha,
    author: "A",
    authoredAt: "2026-10-21T00:00:00Z",
  };
}

function page(
  commits: GitHistoryResult["commits"],
  nextCursor: string | null,
  stale = false,
): SourceControlHistoryPageResult {
  return { _tag: "Page", page: { commits, nextCursor, stale } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function historyOf(environmentId = ENVIRONMENT, rootPath = ROOT) {
  return useSourceControlWorkspaceStore.getState().historyByRepository[
    JSON.stringify([environmentId, rootPath])
  ];
}

const status = (overrides: Partial<GitIndexStatusResult> = {}): GitIndexStatusResult => ({
  fingerprint: {
    rootPath: ROOT,
    headCommit: "abc",
    headRef: "refs/heads/main",
    index: "index-1",
    worktree: "worktree-1",
  },
  staged: [{ path: "src/a.ts", status: "M" }],
  unstaged: [],
  ...overrides,
});

describe("source control history store", () => {
  it("pages through history and stops at the cursor end", async () => {
    setup();
    const load = useSourceControlWorkspaceStore.getState().loadHistory;
    const target = { environmentId: ENVIRONMENT, rootPath: ROOT };
    const cursors: Array<string | undefined> = [];
    const fetchPage = async (cursor: string | undefined) => {
      cursors.push(cursor);
      return cursor === undefined
        ? page([commit("c3", ["c2"]), commit("c2", ["c1"])], "after-c2")
        : page([commit("c2", ["c1"]), commit("c1")], null);
    };

    await load(target, "reset", fetchPage);
    await load(target, "more", fetchPage);
    await load(target, "more", fetchPage);

    expect(cursors).toEqual([undefined, "after-c2"]);
    expect(historyOf()?.history.commits.map((entry) => entry.sha)).toEqual(["c3", "c2", "c1"]);
    expect(historyOf()?.history.nextCursor).toBeNull();
  });

  it("drops a page that lands after a reload started a new chain", async () => {
    setup();
    const load = useSourceControlWorkspaceStore.getState().loadHistory;
    const target = { environmentId: ENVIRONMENT, rootPath: ROOT };
    const slow = deferred<SourceControlHistoryPageResult>();

    const first = load(target, "reset", () => slow.promise);
    await load(target, "reset", async () => page([commit("new")], null));
    slow.resolve(page([commit("old")], "old-cursor"));
    await first;

    expect(historyOf()?.history.commits.map((entry) => entry.sha)).toEqual(["new"]);
    expect(historyOf()?.history.nextCursor).toBeNull();
  });

  it("marks a stale cursor chain unusable until the first page is reloaded", async () => {
    setup();
    const load = useSourceControlWorkspaceStore.getState().loadHistory;
    const target = { environmentId: ENVIRONMENT, rootPath: ROOT };
    await load(target, "reset", async () => page([commit("c2", ["c1"])], "after-c2"));
    await load(target, "more", async () => page([], null, true));

    expect(historyOf()?.history.stale).toBe(true);
    let requested = false;
    await load(target, "more", async () => {
      requested = true;
      return page([], null);
    });
    expect(requested).toBe(false);

    await load(target, "reset", async () => page([commit("c9")], null));
    expect(historyOf()?.history).toMatchObject({ stale: false, loading: false });
    expect(historyOf()?.history.commits.map((entry) => entry.sha)).toEqual(["c9"]);
  });

  it("keeps a failed load recoverable and scopes history per environment", async () => {
    setup();
    const load = useSourceControlWorkspaceStore.getState().loadHistory;
    await load({ environmentId: ENVIRONMENT, rootPath: ROOT }, "reset", async () => ({
      _tag: "Failed",
      message: "Disconnected",
    }));
    await load({ environmentId: OTHER_ENVIRONMENT, rootPath: ROOT }, "reset", async () =>
      page([commit("remote")], null),
    );

    expect(historyOf()).toMatchObject({ error: "Disconnected" });
    expect(historyOf()?.history).toMatchObject({ stale: true, nextCursor: null, loading: false });
    expect(historyOf(OTHER_ENVIRONMENT)?.history.commits.map((entry) => entry.sha)).toEqual([
      "remote",
    ]);
  });

  it("drops a page from a lost connection and keeps the old chain marked stale", async () => {
    setup();
    const store = useSourceControlWorkspaceStore.getState();
    const target = { environmentId: ENVIRONMENT, rootPath: ROOT };
    await store.loadHistory(target, "reset", async () => page([commit("c2", ["c1"])], "after-c2"));
    const slow = deferred<SourceControlHistoryPageResult>();
    const more = store.loadHistory(target, "more", () => slow.promise);

    store.disconnectHistory(target);
    slow.resolve(page([commit("c1")], "after-c1"));
    await more;

    expect(historyOf()?.history).toMatchObject({ stale: true, loading: false, nextCursor: null });
    expect(historyOf()?.history.commits.map((entry) => entry.sha)).toEqual(["c2"]);
    expect(historyOf()?.error).toMatch(/Disconnected/);

    await store.loadHistory(target, "reset", async () => page([commit("c3", ["c2"])], null));
    expect(historyOf()).toMatchObject({ error: null });
    expect(historyOf()?.history.commits.map((entry) => entry.sha)).toEqual(["c3"]);
  });
});

describe("repository selection", () => {
  const discovered = {
    repositories: [{ rootPath: "/work/app/vendor/lib" }, { rootPath: "/work/app" }],
    truncated: false,
  };

  it("defaults to the outermost repository and honors a still-discovered choice", () => {
    expect(resolveSelectedRepositoryRoot(discovered, undefined)).toBe("/work/app");
    expect(resolveSelectedRepositoryRoot(discovered, "/work/app/vendor/lib")).toBe(
      "/work/app/vendor/lib",
    );
    expect(resolveSelectedRepositoryRoot(discovered, "/work/removed")).toBe("/work/app");
    expect(resolveSelectedRepositoryRoot({ repositories: [], truncated: false }, undefined)).toBe(
      null,
    );
  });

  it("names nested repositories relative to the workspace repository", () => {
    expect(repositoryDisplayName("/work/app/vendor/lib", "/work/app")).toBe("vendor/lib");
    expect(repositoryDisplayName("/work/app", "/work/app")).toBe("app");
  });

  it("maps repository files to workspace tabs only inside the workspace", () => {
    expect(workspaceRelativeRepositoryPath("/work/app", "/work/app", "src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativeRepositoryPath("/work/app/", "/work/app/vendor/lib", "x.ts")).toBe(
      "vendor/lib/x.ts",
    );
    expect(workspaceRelativeRepositoryPath("/work/app", "/work/application", "x.ts")).toBeNull();
  });
});

describe("index actions", () => {
  it("caps a bulk stage at the backend's per-request path limit", () => {
    const unstaged = Array.from({ length: 501 }, (_, index) => ({
      path: `file-${index}.ts`,
      status: "M",
    }));
    expect(indexMutationPaths(status({ unstaged }), "unstaged")).toHaveLength(500);
  });

  it("only offers a staged commit for a settled, attached, permitted repository", () => {
    const ready = {
      status: status(),
      statusStale: false,
      message: "fix",
      busy: false,
      allowed: true,
    };
    expect(stagedCommitBlocker(ready)).toBeNull();
    expect(stagedCommitBlocker({ ...ready, statusStale: true })).toBe("stale");
    expect(stagedCommitBlocker({ ...ready, allowed: false })).toBe("no-permission");
    expect(stagedCommitBlocker({ ...ready, busy: true })).toBe("busy");
    expect(stagedCommitBlocker({ ...ready, message: "  " })).toBe("no-message");
    expect(stagedCommitBlocker({ ...ready, status: status({ staged: [] }) })).toBe(
      "nothing-staged",
    );
    expect(
      stagedCommitBlocker({
        ...ready,
        status: status({ fingerprint: { ...status().fingerprint, headRef: null } }),
      }),
    ).toBe("detached");
  });
});

describe("staged commit outcome", () => {
  const committed = {
    commitSha: "abcdef1234",
    branchRef: "refs/heads/main",
    headChanged: false,
    push: "failed" as const,
    recovery: "push" as const,
  };

  it("keeps a commit whose push failed and offers pushing that branch again", () => {
    expect(commitOutcomePresentation(committed)).toEqual({
      pushed: false,
      pushFailed: true,
      checkoutMoved: false,
      canRetryPush: true,
    });
  });

  it("still offers the reviewed retry after the checkout moved, and none once pushed", () => {
    expect(commitOutcomePresentation({ ...committed, headChanged: true })).toMatchObject({
      checkoutMoved: true,
      canRetryPush: true,
    });
    expect(
      commitOutcomePresentation({ ...committed, push: "succeeded", recovery: null }),
    ).toMatchObject({ pushed: true, pushFailed: false, canRetryPush: false });
  });
});

describe("history graph", () => {
  it("draws a merge as two parent lanes that rejoin", () => {
    const graph = buildHistoryGraph([
      commit("m", ["a", "b"]),
      commit("b", ["base"]),
      commit("a", ["base"]),
      commit("base"),
    ]);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(graph.laneCount).toBe(2);
    expect(graph.rows[0]!.segments).toEqual([
      { from: null, to: 0 },
      { from: null, to: 1 },
    ]);
    // Both branches expect the base commit; the second lane closes into the first.
    expect(graph.rows[3]!.segments).toEqual([
      { from: 0, to: null },
      { from: 1, to: null },
    ]);
  });

  it("keeps passing lanes straight and ends a root commit's line", () => {
    const graph = buildHistoryGraph([commit("x", ["y"]), commit("z"), commit("y")]);
    expect(graph.rows[1]).toEqual({
      sha: "z",
      lane: 1,
      segments: [{ from: 0, to: 0 }],
    });
    expect(graph.rows[2]!.segments).toEqual([{ from: 0, to: null }]);
  });
});
