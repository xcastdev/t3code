import {
  applySourceControlHistoryPage,
  beginSourceControlHistoryLoad,
  createSourceControlHistoryState,
  disconnectSourceControlHistory,
  sourceControlRepositoryKey,
  type SourceControlHistoryState,
  type SourceControlRepositoryTarget,
} from "@t3tools/client-runtime/state/source-control-workspace";
import type {
  EnvironmentId,
  GitCommitStagedResult,
  GitDiscoverRepositoriesResult,
  GitHistoryResult,
  GitIndexStatusResult,
} from "@t3tools/contracts";
import { create } from "zustand";

/** Rows rendered per index group; the rest are summarized so huge worktrees stay cheap. */
export const SOURCE_CONTROL_VISIBLE_FILE_LIMIT = 300;
/** The backend accepts at most this many paths per stage/unstage request. */
export const SOURCE_CONTROL_MUTATION_PATH_LIMIT = 500;
export const SOURCE_CONTROL_HISTORY_PAGE_SIZE = 50;

export type SourceControlHistoryPageResult =
  | { readonly _tag: "Page"; readonly page: GitHistoryResult }
  | { readonly _tag: "Failed"; readonly message: string };

export interface SourceControlHistoryEntry {
  readonly history: SourceControlHistoryState;
  readonly error: string | null;
}

interface SourceControlWorkspaceStore {
  /** Repository root the user chose, keyed by environment and workspace root. */
  readonly selectedRootByWorkspace: Record<string, string>;
  readonly historyByRepository: Record<string, SourceControlHistoryEntry>;
  /** Bumped by an explicit refresh so a settled history reloads even when HEAD stayed put. */
  readonly historyGenerationByRepository: Record<string, number>;
  readonly selectRoot: (workspace: SourceControlWorkspaceScope, rootPath: string) => void;
  readonly loadHistory: (
    target: SourceControlRepositoryTarget,
    mode: "reset" | "more",
    fetchPage: (cursor: string | undefined) => Promise<SourceControlHistoryPageResult>,
  ) => Promise<void>;
  readonly refreshHistory: (target: SourceControlRepositoryTarget) => void;
  /** Marks loaded history stale and drops any page still in flight from the lost connection. */
  readonly disconnectHistory: (target: SourceControlRepositoryTarget) => void;
}

export interface SourceControlWorkspaceScope {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export function sourceControlWorkspaceKey(scope: SourceControlWorkspaceScope): string {
  return JSON.stringify([scope.environmentId, scope.workspaceRoot]);
}

// Not persisted: a selected root or loaded history is only trustworthy for the
// connection that produced it, and both are cheap to rebuild.
export const useSourceControlWorkspaceStore = create<SourceControlWorkspaceStore>()((set, get) => ({
  selectedRootByWorkspace: {},
  historyByRepository: {},
  historyGenerationByRepository: {},
  selectRoot: (workspace, rootPath) =>
    set((state) => ({
      selectedRootByWorkspace: {
        ...state.selectedRootByWorkspace,
        [sourceControlWorkspaceKey(workspace)]: rootPath,
      },
    })),
  loadHistory: async (target, mode, fetchPage) => {
    const key = sourceControlRepositoryKey(target);
    const current =
      get().historyByRepository[key]?.history ?? createSourceControlHistoryState(target);
    if (mode === "more" && (current.loading || current.stale || current.nextCursor === null)) {
      return;
    }
    const cursor = mode === "more" ? (current.nextCursor ?? undefined) : undefined;
    // A reset starts a new chain, but keeps counting versions so any page still in
    // flight from the old chain is rejected when it lands.
    const base =
      mode === "reset"
        ? { ...createSourceControlHistoryState(target), requestVersion: current.requestVersion }
        : current;
    const begun = beginSourceControlHistoryLoad(base);
    const requestVersion = begun.requestVersion;
    set((state) => ({
      historyByRepository: {
        ...state.historyByRepository,
        [key]: { history: begun, error: null },
      },
    }));
    const result = await fetchPage(cursor);
    set((state) => {
      const latest = state.historyByRepository[key];
      if (latest === undefined || latest.history.requestVersion !== requestVersion) return state;
      const next: SourceControlHistoryEntry =
        result._tag === "Page"
          ? {
              history: applySourceControlHistoryPage(
                latest.history,
                target,
                result.page,
                requestVersion,
              ),
              error: null,
            }
          : { history: disconnectSourceControlHistory(latest.history), error: result.message };
      return { historyByRepository: { ...state.historyByRepository, [key]: next } };
    });
  },
  refreshHistory: (target) => {
    const key = sourceControlRepositoryKey(target);
    set((state) => ({
      historyGenerationByRepository: {
        ...state.historyGenerationByRepository,
        [key]: (state.historyGenerationByRepository[key] ?? 0) + 1,
      },
    }));
  },
  disconnectHistory: (target) => {
    const key = sourceControlRepositoryKey(target);
    set((state) => {
      const current = state.historyByRepository[key];
      if (current === undefined) return state;
      return {
        historyByRepository: {
          ...state.historyByRepository,
          [key]: {
            history: disconnectSourceControlHistory(current.history),
            error: "Disconnected from this environment. History reloads when it reconnects.",
          },
        },
      };
    });
  },
}));

/**
 * The repository to show: the user's choice while discovery still reports it, otherwise
 * the outermost discovered root, which is the workspace's own repository when it has one.
 */
export function resolveSelectedRepositoryRoot(
  discovered: GitDiscoverRepositoriesResult | null,
  selected: string | undefined,
): string | null {
  if (discovered === null || discovered.repositories.length === 0) return null;
  if (
    selected !== undefined &&
    discovered.repositories.some((repository) => repository.rootPath === selected)
  ) {
    return selected;
  }
  let outermost = discovered.repositories[0]!.rootPath;
  for (const repository of discovered.repositories) {
    if (repository.rootPath.length < outermost.length) outermost = repository.rootPath;
  }
  return outermost;
}

/** The label for a nested repository, relative to the outermost discovered root. */
export function repositoryDisplayName(rootPath: string, outermostRoot: string | null): string {
  if (outermostRoot !== null && rootPath !== outermostRoot) {
    const prefix = outermostRoot.endsWith("/") ? outermostRoot : `${outermostRoot}/`;
    if (rootPath.startsWith(prefix)) return rootPath.slice(prefix.length);
  }
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * The workspace-relative path for a repository file, so it opens in the file tabs.
 * Null when the repository is outside the workspace the panel belongs to.
 */
export function workspaceRelativeRepositoryPath(
  workspaceRoot: string,
  rootPath: string,
  filePath: string,
): string | null {
  const workspace = workspaceRoot.replace(/[\\/]+$/, "");
  if (rootPath === workspace) return filePath;
  const prefix = `${workspace}/`;
  if (!rootPath.startsWith(prefix)) return null;
  return `${rootPath.slice(prefix.length)}/${filePath}`;
}

export function joinRepositoryPath(rootPath: string, filePath: string): string {
  return `${rootPath.replace(/[\\/]+$/, "")}/${filePath}`;
}

export type SourceControlIndexGroup = "staged" | "unstaged";

/** Paths for one stage/unstage request; the backend caps a request at 500 paths. */
export function indexMutationPaths(
  status: GitIndexStatusResult,
  group: SourceControlIndexGroup,
): ReadonlyArray<string> {
  return (group === "staged" ? status.staged : status.unstaged)
    .slice(0, SOURCE_CONTROL_MUTATION_PATH_LIMIT)
    .map((file) => file.path);
}

export type SourceControlCommitBlocker =
  | "loading"
  | "stale"
  | "nothing-staged"
  | "no-message"
  | "busy"
  | "no-permission"
  | "detached";

/**
 * Why a staged-only commit can't start. The server re-checks every one of these; the
 * client only avoids offering a commit it already knows will be refused.
 */
export function stagedCommitBlocker(input: {
  readonly status: GitIndexStatusResult | null;
  readonly statusStale: boolean;
  readonly message: string;
  readonly busy: boolean;
  readonly allowed: boolean;
}): SourceControlCommitBlocker | null {
  if (!input.allowed) return "no-permission";
  if (input.status === null) return "loading";
  if (input.statusStale) return "stale";
  if (input.busy) return "busy";
  if (input.status.fingerprint.headRef === null) return "detached";
  if (input.status.staged.length === 0) return "nothing-staged";
  if (input.message.trim().length === 0) return "no-message";
  return null;
}

export const COMMIT_BLOCKER_LABELS: Record<SourceControlCommitBlocker, string> = {
  loading: "Loading repository status…",
  stale: "Refreshing changes…",
  "nothing-staged": "Stage changes to commit them.",
  "no-message": "Write a commit message.",
  busy: "Another change to this repository is running.",
  "no-permission": "This connection can't change source control.",
  detached: "Check out a branch to commit. Detached HEAD commits aren't supported here.",
};

export interface CommitOutcomePresentation {
  readonly pushed: boolean;
  readonly pushFailed: boolean;
  /** The checkout left the committed branch while the commit ran. */
  readonly checkoutMoved: boolean;
  readonly canRetryPush: boolean;
}

/**
 * How a finished staged commit reads. A failed push is retried as a reviewed push of the
 * retained branch and commit, which the server checks at execution, so the retry stays
 * available whatever is checked out now.
 */
export function commitOutcomePresentation(
  result: GitCommitStagedResult,
): CommitOutcomePresentation {
  const pushFailed = result.push === "failed" || result.recovery === "push";
  return {
    pushed: result.push === "succeeded",
    pushFailed,
    checkoutMoved: result.headChanged,
    canRetryPush: pushFailed,
  };
}

export function shortBranchName(headRef: string | null): string | null {
  if (headRef === null) return null;
  return headRef.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : headRef;
}

export interface HistoryGraphSegment {
  /** Lane at the top edge, or null when the segment starts at this row's node. */
  readonly from: number | null;
  /** Lane at the bottom edge, or null when the segment ends at this row's node. */
  readonly to: number | null;
}

export interface HistoryGraphRow {
  readonly sha: string;
  readonly lane: number;
  readonly segments: ReadonlyArray<HistoryGraphSegment>;
}

export interface HistoryGraph {
  readonly rows: ReadonlyArray<HistoryGraphRow>;
  readonly laneCount: number;
}

/**
 * Lane layout from parent edges, in the page order the server returned. Lanes are
 * never compacted, so a line that passes a row stays in its column; freed lanes are
 * reused by the next branch that needs one.
 */
export function buildHistoryGraph(
  commits: ReadonlyArray<{ readonly sha: string; readonly parents: ReadonlyArray<string> }>,
): HistoryGraph {
  const lanes: Array<string | null> = [];
  const rows: HistoryGraphRow[] = [];
  let laneCount = 0;
  const claimLane = (sha: string) => {
    const free = lanes.indexOf(null);
    if (free === -1) {
      lanes.push(sha);
      return lanes.length - 1;
    }
    lanes[free] = sha;
    return free;
  };

  for (const commit of commits) {
    const segments: HistoryGraphSegment[] = [];
    let lane = lanes.indexOf(commit.sha);
    for (let index = 0; index < lanes.length; index += 1) {
      const expected = lanes[index];
      if (expected === null || expected === undefined) continue;
      if (expected === commit.sha) {
        segments.push({ from: index, to: null });
        if (index !== lane) lanes[index] = null;
      } else {
        segments.push({ from: index, to: index });
      }
    }
    if (lane === -1) lane = claimLane(commit.sha);

    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;
    if (firstParent !== undefined) segments.push({ from: null, to: lane });
    for (const parent of otherParents) {
      const existing = lanes.indexOf(parent);
      segments.push({ from: null, to: existing === -1 ? claimLane(parent) : existing });
    }
    laneCount = Math.max(laneCount, lanes.length);
    rows.push({ sha: commit.sha, lane, segments });
  }
  return { rows, laneCount };
}
