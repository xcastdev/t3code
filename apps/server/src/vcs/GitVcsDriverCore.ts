import * as Arr from "effect/Array";
// @effect-diagnostics nodeBuiltinImport:off -- opendir reads only the remaining discovery budget instead of allocating a whole wide directory.
import * as NodeFSP from "node:fs/promises";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  type GitCommitFilesInput,
  type GitCommitFilesResult,
  type GitCommitGraphPageInput,
  type GitCommitGraphPageResult,
  type GitRepositoryComparisonInput,
  type GitRepositoryComparisonResult,
  type GitRepositoryDiscoveryInput,
  type GitRepositoryDiscoveryResult,
  type GitRepositoryDescriptor,
  type GitCommitIndexInput,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  type VcsRef,
  type VcsStageFilesInput,
  type VcsWorkingTreeDiffInput,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches, normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerConfig } from "../config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function pullStrategyArgs(strategy: "merge" | "rebase" | "ff-only" | undefined): string[] {
  if (strategy === "rebase") return ["pull", "--rebase"];
  if (strategy === "ff-only") return ["pull", "--ff-only"];
  if (strategy === "merge") return ["pull", "--no-rebase"];
  return ["pull"];
}
// `git worktree add` checks out the full tree, so on large repositories it can
// take well beyond the default 30s (e.g. a 375k-file repo takes ~40s on an idle
// machine). Give it generous headroom while still bounding a genuinely hung git.
const WORKTREE_ADD_TIMEOUT_MS = 300_000;
const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKING_TREE_DIFF_BYTES = 256 * 1024;
const MAX_WORKING_TREE_DIFF_LINES = 8_000;
const GUARDED_COMMIT_HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
] as const;
// Patches the clients render are parsed against git's default a/ and b/ path
// prefixes. A repository or global diff.noprefix or diff.mnemonicPrefix would
// otherwise leak into the patch and leave every parsed file unnamed.
export const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 120_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

const GRAPH_RECORD_SEPARATOR = "\x1e";
const GRAPH_FIELD_SEPARATOR = "\0";
const GRAPH_SHA = /^[0-9a-f]{40}$/iu;

/** Parse the machine format directly: Git may put a newline before every row after the first. */
export function parseCommitGraphLog(
  stdout: string,
  remoteNames: ReadonlySet<string>,
  options: { readonly upstreamRef?: string } = {},
): GitCommitGraphPageResult["commits"] {
  return stdout.split(GRAPH_RECORD_SEPARATOR).flatMap((record) => {
    const fields = record.split(GRAPH_FIELD_SEPARATOR);
    const [rawSha, rawParents, rawTimestamp] = fields;
    const modern = fields.length >= 8;
    const [rawAuthorName, rawAuthorEmail, subject, message, decorationAndSummary] = modern
      ? fields.slice(3)
      : [undefined, undefined, fields[3], undefined, fields[4]];
    const sha = rawSha?.trim();
    if (!sha || !GRAPH_SHA.test(sha) || subject === undefined) return [];
    const parents = (rawParents ?? "").split(" ").filter((parent) => GRAPH_SHA.test(parent));
    const timestamp = Number(rawTimestamp);
    if (!Number.isFinite(timestamp)) return [];
    const [decoration, ...summaryLines] = (decorationAndSummary ?? "").split(/\r?\n/u);
    const changeSummary = summaryLines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    const refs = new Map<string, GitCommitGraphPageResult["commits"][number]["refs"][number]>();
    for (const rawDecoration of (decoration ?? "").split(",")) {
      const rawValue = rawDecoration.trim();
      const current = rawValue.match(/^HEAD -> (.+)$/u);
      if (rawValue === "HEAD") {
        refs.set("head\0HEAD", { kind: "head", name: "HEAD" });
        continue;
      }
      if (current) refs.set("head\0HEAD", { kind: "head", name: "HEAD" });
      let value = current?.[1] ?? rawValue;
      if (!value || /^(?:refs\/)?t3\/checkpoints\//u.test(value)) continue;
      const tag = value.startsWith("tag: ");
      if (tag) value = value.slice("tag: ".length);
      const explicitRemote = value.startsWith("refs/remotes/");
      const explicitLocal = value.startsWith("refs/heads/");
      const explicitTag = value.startsWith("refs/tags/");
      if (explicitRemote) value = value.slice("refs/remotes/".length);
      if (explicitLocal) value = value.slice("refs/heads/".length);
      if (explicitTag) value = value.slice("refs/tags/".length);
      const firstSegment = value.split("/", 1)[0];
      const fullRef = explicitRemote
        ? `refs/remotes/${value}`
        : explicitLocal
          ? `refs/heads/${value}`
          : undefined;
      const kind =
        tag || explicitTag
          ? "tag"
          : current
            ? "current"
            : fullRef === options.upstreamRef
              ? "upstream"
              : explicitRemote || (!explicitLocal && remoteNames.has(firstSegment ?? ""))
                ? "remote"
                : "local";
      refs.set(`${kind}\0${value}`, { kind, name: value });
    }
    return [
      {
        sha,
        parents,
        authorTimestamp: timestamp,
        ...(rawAuthorName ? { authorName: rawAuthorName } : {}),
        ...(rawAuthorEmail ? { authorEmail: rawAuthorEmail } : {}),
        subject,
        ...(message ? { message } : {}),
        ...(modern && changeSummary ? { changeSummary } : {}),
        refs: [...refs.values()],
      },
    ];
  });
}

export function applyCommitGraphTopology(
  commits: GitCommitGraphPageResult["commits"],
  initialLanes: readonly string[] = [],
): { readonly commits: GitCommitGraphPageResult["commits"]; readonly lanes: readonly string[] } {
  const active = [...initialLanes];
  const rows = commits.map((commit) => {
    let lane = active.indexOf(commit.sha);
    if (lane < 0) {
      lane = 0;
      active.unshift(commit.sha);
    }
    const before = [...active];
    active.splice(lane, 1);
    const parentTargets = new Map<string, number>();
    for (const [index, parent] of [...new Set(commit.parents)].entries()) {
      let target = active.indexOf(parent);
      if (target < 0) {
        target = Math.min(lane + index, active.length);
        active.splice(target, 0, parent);
      }
      parentTargets.set(parent, target);
    }
    // Every unresolved lane has a segment in this row. Without carry edges,
    // adjacent page rows draw disconnected branches after a split or merge.
    const edges = before.flatMap((sha, from) => {
      if (from === lane) {
        return [...parentTargets.values()].map((to) => ({ from, to }));
      }
      const to = active.indexOf(sha);
      return to < 0 ? [] : [{ from, to }];
    });
    return { ...commit, lane, lanes: active.map((_sha, index) => index), edges };
  });
  return { commits: rows, lanes: active };
}

/**
 * Read no more than the scan still permits. `opendir` with a one-entry buffer
 * deliberately avoids `readdir`'s full-directory allocation and sorting cost
 * for workspaces containing generated trees.
 */
const readDirectoryEntriesBounded = (directory: string, limit: number) =>
  Effect.tryPromise(async () => {
    const handle = await NodeFSP.opendir(directory, { bufferSize: 1 });
    try {
      const entries: string[] = [];
      while (entries.length < limit) {
        const entry = await handle.read();
        if (entry === null) break;
        entries.push(entry.name);
      }
      // One extra read distinguishes EOF from a budget-limited enumeration.
      // Without it a wide leaf directory silently looked complete and could
      // hide a repository after the scan budget.
      const next = entries.length === limit ? await handle.read() : null;
      return { entries, truncated: next !== null };
    } finally {
      await handle.close();
    }
  });

const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

/** `stash push --staged` first shipped in Git 2.35. Keep this parser deliberately
 * conservative: a vendor string we do not understand means the destructive leaf
 * stays disabled instead of discovering support by trying a mutation. */
export function supportsStashStagedFromGitVersion(versionOutput: string): boolean {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/iu.exec(versionOutput);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 35);
}
const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);
const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);
const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);
const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);
const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);
const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  defaultBranch: null,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

function statusUpstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

class GitRefsSnapshotCacheKey extends Data.Class<{
  gitCommonDir: string;
  epoch: number;
}> {}

class GitRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  generation: number;
}> {}

interface GitRepositoryPaths {
  readonly gitCommonDir: string;
  readonly worktreeRoot: string | null;
  readonly currentBranch: string | null;
}

interface GitRefsSnapshot {
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | null | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{
    path: string;
    insertions: number;
    deletions: number;
  }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    if (line.startsWith("2 ")) {
      // Porcelain v2 writes a rename as metadata + new path, then a tab and
      // the old path. The path before the tab is the status entry's key.
      const newPath = line.slice(0, tabIndex).trim().split(/\s+/g).at(-1) ?? "";
      return newPath.length > 0 ? newPath : null;
    }
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function parsePorcelainIndexStatus(
  line: string,
): "staged" | "unstaged" | "both" | "untracked" | "conflicted" | undefined {
  if (line.startsWith("? ")) return "untracked";
  if (line.startsWith("u ")) return "conflicted";
  if (!(line.startsWith("1 ") || line.startsWith("2 "))) return undefined;
  const index = line[2] ?? ".";
  const worktree = line[3] ?? ".";
  if (index === "U" || worktree === "U") return "conflicted";
  if (index !== "." && worktree !== ".") return "both";
  if (index !== ".") return "staged";
  if (worktree !== ".") return "unstaged";
  return undefined;
}

type PorcelainPathSides = {
  readonly oldPath?: string | null;
  readonly newPath?: string | null;
  readonly indexOldPath?: string | null;
  readonly indexNewPath?: string | null;
  readonly worktreeOldPath?: string | null;
  readonly worktreeNewPath?: string | null;
};

function sidesForStatus(
  status: string,
  path: string,
): Pick<PorcelainPathSides, "indexOldPath" | "indexNewPath"> {
  return status === "A"
    ? { indexOldPath: null, indexNewPath: path }
    : status === "D"
      ? { indexOldPath: path, indexNewPath: null }
      : { indexOldPath: path, indexNewPath: path };
}

function parsePorcelainPathSides(line: string, path: string): PorcelainPathSides {
  if (line.startsWith("? ")) {
    return { oldPath: null, newPath: path };
  }
  if (!(line.startsWith("1 ") || line.startsWith("2 "))) return {};
  const index = line[2] ?? ".";
  const worktree = line[3] ?? ".";
  if (line.startsWith("2 ")) {
    const tabIndex = line.indexOf("\t");
    const oldPath = tabIndex >= 0 ? line.slice(tabIndex + 1).trim() : undefined;
    const renameOldPath = oldPath || path;
    const comparisonSides =
      index !== "." && worktree !== "."
        ? {
            ...(index === "R" || index === "C"
              ? { indexOldPath: renameOldPath, indexNewPath: path }
              : sidesForStatus(index, path)),
            // An unstaged edit after a staged rename is at the renamed path on
            // both sides. Git's rename metadata belongs to the index comparison.
            ...(worktree === "D"
              ? { worktreeOldPath: path, worktreeNewPath: null }
              : worktree === "A"
                ? { worktreeOldPath: null, worktreeNewPath: path }
                : { worktreeOldPath: path, worktreeNewPath: path }),
          }
        : {};
    return {
      oldPath: renameOldPath,
      newPath: path,
      ...comparisonSides,
    };
  }
  const indexSides = index === "." ? {} : sidesForStatus(index, path);
  const worktreeSides =
    worktree === "."
      ? {}
      : worktree === "A"
        ? { worktreeOldPath: null, worktreeNewPath: path }
        : worktree === "D"
          ? { worktreeOldPath: path, worktreeNewPath: null }
          : { worktreeOldPath: path, worktreeNewPath: path };
  const comparisonSides =
    index !== "." && worktree !== "." ? { ...indexSides, ...worktreeSides } : {};
  if (index === "A" || worktree === "A") {
    return { oldPath: null, newPath: path, ...comparisonSides };
  }
  if (index === "D" || worktree === "D") {
    return { oldPath: path, newPath: null, ...comparisonSides };
  }
  // Omit unchanged-side metadata to retain the compact status shape for the
  // overwhelmingly common modified-file case; consumers fall back to `path`.
  return comparisonSides;
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function truncateWorkingTreeDiff(
  diff: string,
  inputTruncated: boolean,
): { readonly diff: string; readonly truncated: boolean } {
  let bytes = 0;
  let lines = 0;
  let end = 0;
  const encoder = new TextEncoder();
  while (end < diff.length) {
    const nextNewline = diff.indexOf("\n", end);
    if (nextNewline === -1 && inputTruncated) break;
    const nextEnd = nextNewline === -1 ? diff.length : nextNewline + 1;
    const lineBytes = encoder.encode(diff.slice(end, nextEnd)).byteLength;
    if (lines >= MAX_WORKING_TREE_DIFF_LINES || bytes + lineBytes > MAX_WORKING_TREE_DIFF_BYTES) {
      break;
    }
    bytes += lineBytes;
    lines += 1;
    end = nextEnd;
  }
  return {
    diff: diff.slice(0, end),
    truncated: inputTruncated || end < diff.length,
  };
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
  return {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.cause.reason;
  if (reason._tag === "NotFound") {
    return reason.pathOrDescriptor === error.cwd;
  }

  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}
function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
}

// Matches `git worktree remove` on a path git no longer tracks: "is not a
// working tree" when the registration is gone, "cannot remove working tree"
// when older gits fail validation on a registered-but-deleted directory.
function isMissingWorktreeStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  );
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.void,
    }),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);
const decodeTrace2Record = decodeJsonResult(Trace2Record);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeTrace2Record(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, {
        hookName,
        startedAtMs: DateTime.toEpochMillis(now),
      });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const GIT_CHECKOUT_PROGRESS_LINE = /Updating files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/;

/** Parses `Updating files:  78% (2104/2700)` from git's stderr progress output. */
export function parseGitCheckoutProgressLine(
  line: string,
): { percent: number; completed: number; total: number } | null {
  const match = GIT_CHECKOUT_PROGRESS_LINE.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  const completed = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(percent) || !Number.isFinite(completed) || !Number.isFinite(total)) {
    return null;
  }
  return { percent: Math.max(0, Math.min(100, percent)), completed, total };
}

const OUTPUT_LINE_SEPARATOR = /\r\n|\r|\n/;

const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
  keepLineCallbacksAfterTruncation = false,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  // With callbacks continuing past the cap, lines are decoded by their own
  // decoder from the first byte so no character is ever split at the cap.
  const lineDecoder = keepLineCallbacksAfterTruncation && onLine ? new TextDecoder() : null;
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;
  // A separator-free stream past the cap must not grow the line buffer
  // without bound; a line longer than this is not one the callbacks want.
  const maxPendingLineBytes = 64 * 1024;

  // Git redraws progress with a bare `\r` between updates and only ends the
  // line once the step is done, so `\r` has to count as a line break here.
  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    while (separator) {
      const line = lineBuffer.slice(0, separator.index);
      lineBuffer = lineBuffer.slice(separator.index + separator[0].length);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    }

    if (flush) {
      const trailing = lineBuffer;
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      if (lineDecoder) {
        lineBuffer += lineDecoder.decode(chunk, { stream: true });
        yield* emitCompleteLines(false);
        if (lineBuffer.length > maxPendingLineBytes) lineBuffer = "";
      }
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        ...gitCommandContext(input),
        detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
        outputLength: nextBytes,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += lineDecoder ? lineDecoder.decode(chunk, { stream: true }) : decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new GitCommandError({
          ...gitCommandContext(input),
          detail: "Failed to read Git process output.",
          cause,
        }),
    }),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  if (lineDecoder) lineBuffer += lineDecoder.decode();
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { worktreesDir } = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to create Git trace monitor.",
                cause,
              }),
          ),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make("git", commandInput.args, {
              cwd: commandInput.cwd,
              env: {
                ...process.env,
                ...input.env,
                ...trace2Monitor.env,
              },
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to spawn Git process.",
                  cause,
                }),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStdoutLine,
              input.keepLineCallbacksAfterTruncation,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
              input.keepLineCallbacksAfterTruncation,
            ),
            child.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to read Git process exit code.",
                    cause,
                  }),
              ),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        ...gitCommandContext(commandInput),
                        detail: "Failed to write Git process input.",
                        cause,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          return yield* new GitCommandError({
            ...gitCommandContext(commandInput),
            detail: "Git command exited with a non-zero status.",
            exitCode,
            stdoutLength: stdout.text.length,
            stderrLength: stderr.text.length,
          });
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      const execution = runGitCommand().pipe(Effect.scoped);
      if (timeoutMs === null) {
        return yield* execution;
      }

      return yield* execution.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Git command timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  );

  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        return Effect.fail(
          new GitCommandError({
            ...gitCommandContext({ operation, cwd, args }),
            detail: options.fallbackErrorDetail ?? "Git command exited with a non-zero status.",
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
        );
      }),
    );

  const executeGitWithStableDiagnostics = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    executeGit(operation, cwd, args, {
      ...options,
      env: {
        ...options.env,
        LC_ALL: "C",
      },
    });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.renameBranch",
        cwd,
        args: ["branch", "-m", "--", desiredBranch],
      }),
      detail: `Could not find an available branch name for '${desiredBranch}'.`,
    });
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitVcsDriver.fetchRemoteForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
      {
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
    cwd: string,
  ) {
    const commonDirResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.resolveRepositoryPaths.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    );
    if (commonDirResult.exitCode !== 0) {
      const stderr = commonDirResult.stderr.trim();
      if (isNonRepositoryGitStderr(stderr)) {
        return null;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        }),
        detail: "Failed to resolve the Git common directory.",
        exitCode: commonDirResult.exitCode,
        stdoutLength: commonDirResult.stdout.length,
        stderrLength: commonDirResult.stderr.length,
      });
    }

    const commonDirOutput = commonDirResult.stdout.trim();
    const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
      ? path.normalize(commonDirOutput)
      : path.resolve(cwd, commonDirOutput);
    const gitCommonDir = yield* fileSystem
      .realPath(resolvedGitCommonDir)
      .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));
    const [worktreeRootResult, currentBranchResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
          cwd,
          ["rev-parse", "--show-toplevel"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.currentBranch",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
      ],
      { concurrency: 2 },
    );
    const worktreeRootOutput = worktreeRootResult.stdout.trim();
    const worktreeRoot =
      worktreeRootResult.exitCode === 0 && worktreeRootOutput.length > 0
        ? path.normalize(
            path.isAbsolute(worktreeRootOutput)
              ? worktreeRootOutput
              : path.resolve(cwd, worktreeRootOutput),
          )
        : null;
    const currentBranchOutput = currentBranchResult.stdout.trim();
    const currentBranch =
      currentBranchResult.exitCode === 0 && currentBranchOutput.length > 0
        ? currentBranchOutput
        : null;

    return {
      gitCommonDir,
      worktreeRoot,
      currentBranch,
    } satisfies GitRepositoryPaths;
  });

  const repositoryPathsCache = yield* Cache.makeWith(
    (cwd: string) => resolveRepositoryPathsUncached(cwd),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const repositoryPathsRefreshCache = yield* Cache.makeWith(
    (cwd: string) =>
      Cache.invalidate(repositoryPathsCache, cwd).pipe(
        Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
      ),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null
            ? NON_REPOSITORY_PATHS_CACHE_TTL
            : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));
  const resolveRepositoryPaths = (cwd: string, refresh = false) => {
    const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
    return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
  };

  const defaultBranchCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.defaultBranch",
          fetchCwd,
          ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) return null;
            return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
          }),
        );
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const originExistsCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.originExists",
          fetchCwd,
          ["--git-dir", gitCommonDir, "remote", "get-url", "origin"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.exitCode === 0));
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const invalidateStatusStaticCaches = (cwd: string) =>
    Effect.gen(function* () {
      const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
        Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
      );
      const cacheKey = repositoryPaths?.gitCommonDir ?? normalizeRepositoryPathsCacheKey(cwd);
      yield* Cache.invalidate(defaultBranchCache, cacheKey);
      yield* Cache.invalidate(originExistsCache, cacheKey);
    });

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const repositoryPaths = yield* resolveRepositoryPaths(cwd);
    if (repositoryPaths !== null) {
      return repositoryPaths.gitCommonDir;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      }),
      detail: "Cannot resolve a Git common directory outside a repository.",
    });
  });

  const statusRemoteRefreshFailureCounts = new Map<string, number>();
  const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
    `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;
  const recordStatusRemoteRefreshFailure = (cacheKey: StatusRemoteRefreshCacheKey) => {
    const key = statusRemoteRefreshFailureKey(cacheKey);
    const nextCount = (statusRemoteRefreshFailureCounts.get(key) ?? 0) + 1;
    statusRemoteRefreshFailureCounts.delete(key);
    statusRemoteRefreshFailureCounts.set(key, nextCount);
    if (statusRemoteRefreshFailureCounts.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
      const oldestKey = statusRemoteRefreshFailureCounts.keys().next().value;
      if (oldestKey !== undefined) {
        statusRemoteRefreshFailureCounts.delete(oldestKey);
      }
    }
  };
  const clearStatusRemoteRefreshFailures = (cacheKey: StatusRemoteRefreshCacheKey) => {
    statusRemoteRefreshFailureCounts.delete(statusRemoteRefreshFailureKey(cacheKey));
  };
  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
      Effect.tap(() => Effect.sync(() => clearStatusRemoteRefreshFailures(cacheKey))),
      Effect.tapError(() => Effect.sync(() => recordStatusRemoteRefreshFailure(cacheKey))),
      Effect.as(true as const),
    );
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // A failed background fetch is intentionally cached and exponentially
    // backed off. Status reads swallow this failure and use the last fetched
    // refs, so repeated thread mounts cannot turn a slow or unavailable remote
    // into a repository-wide Git subprocess storm.
    timeToLive: (exit, cacheKey) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : statusUpstreamRefreshFailureCooldown(
            statusRemoteRefreshFailureCounts.get(statusRemoteRefreshFailureKey(cacheKey)) ?? 1,
          ),
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
      }),
    );
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists: GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"] = (input) =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      input.cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${input.remoteName}/${input.refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
    executeGit("GitVcsDriver.remoteExists", input.cwd, ["remote", "get-url", input.remoteName], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    remoteExists({ cwd, remoteName: "origin" });

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolvePrimaryRemoteName",
        cwd,
        args: ["remote"],
      }),
      detail: "No git remote is configured for this repository.",
    });
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const resolvePublicationTarget: GitVcsDriver.GitVcsDriver["Service"]["resolvePublicationTarget"] =
    Effect.fn("resolvePublicationTarget")(function* (cwd, branch) {
      if (branch === null) return { remoteName: null, refName: null };
      const remoteName = yield* resolvePushRemoteName(cwd, branch);
      const refName = yield* resolvePublishBranchName(cwd, branch);
      return { remoteName, refName };
    });

  const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "ensureRemote",
  )(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeGitRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout(
      "GitVcsDriver.ensureRemote.listRemoteUrls",
      input.cwd,
      ["remote", "-v"],
    ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeGitRemoteUrl(remoteUrl) === normalizedTargetUrl) {
        return remoteName;
      }
    }

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
      "remote",
      "add",
      remoteName,
      input.url,
    ]);
    return remoteName;
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
        continue;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists({
          cwd,
          remoteName: primaryRemoteName,
          refName: normalizedCandidate,
        }))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    refName: string,
  ) {
    const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);
    if (!baseRef) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    let branch: string | null;
    if (branchResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(branchResult.stderr)) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }
      if (!isUnbornHeadStderr(branchResult.stderr)) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.statusDetailsRemote.branch",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
          }),
          detail: "Git branch lookup failed.",
          exitCode: branchResult.exitCode,
          stdoutLength: branchResult.stdout.length,
          stderrLength: branchResult.stderr.length,
        });
      }

      const branchValue = yield* runGitStdout(
        "GitVcsDriver.statusDetailsRemote.unbornBranch",
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
      );
      branch = branchValue.trim() || null;
    } else {
      const branchValue = branchResult.stdout.trim();
      branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
    }
    const upstream = yield* resolveCurrentUpstream(cwd);
    const upstreamRef = upstream?.upstreamRef ?? null;
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.orElseSucceed(() => 0),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
        : 0;

    return {
      isRepo: true,
      defaultBranch,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const indexResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.indexPath",
      cwd,
      ["rev-parse", "--git-path", "index"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (indexResult === null) return NON_REPOSITORY_STATUS_DETAILS;
    if (indexResult.exitCode === 0) {
      const lockPath = `${path.resolve(cwd, indexResult.stdout.trim())}.lock`;
      const lockError = new GitCommandError({
        operation: "GitVcsDriver.statusDetails.indexPath",
        command: "git",
        cwd,
        detail: "Git index is locked. Status will resume when the index lock is removed.",
      });
      // Status can succeed while locked, repeatedly running LFS clean filters without caching.
      if (
        yield* fileSystem.exists(lockPath).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...lockError,
                detail: "Failed to check the Git index lock.",
                cause,
              }),
          ),
        )
      ) {
        return yield* lockError;
      }
    }
    const statusResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["-c", "status.relativePaths=false", "status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(statusResult.stderr)) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetails.status",
          cwd,
          args: ["-c", "status.relativePaths=false", "status", "--porcelain=2", "--branch"],
        }),
        detail: "Git status failed.",
        exitCode: statusResult.exitCode,
        stdoutLength: statusResult.stdout.length,
        stderrLength: statusResult.stderr.length,
      });
    }

    const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
      Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
    );
    const statusCacheKey = repositoryPaths?.gitCommonDir;
    const [numstatStdout, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.statusDetails.numstat",
          cwd,
          ["diff", "HEAD", "--numstat", "--"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(result.stdout);
            if (isUnbornHeadStderr(result.stderr)) {
              return Effect.map(
                Effect.all([
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn", cwd, [
                    "diff",
                    "--numstat",
                  ]),
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn.staged", cwd, [
                    "diff",
                    "--cached",
                    "--numstat",
                  ]),
                ]),
                ([unstagedStdout, stagedStdout]) => {
                  const staged = parseNumstatEntries(stagedStdout);
                  const unstaged = parseNumstatEntries(unstagedStdout);
                  const map = new Map<string, { insertions: number; deletions: number }>();
                  for (const entry of [...staged, ...unstaged]) {
                    const existing = map.get(entry.path) ?? {
                      insertions: 0,
                      deletions: 0,
                    };
                    existing.insertions += entry.insertions;
                    existing.deletions += entry.deletions;
                    map.set(entry.path, existing);
                  }
                  return Array.from(map.entries())
                    .map(([p, s]) => `${s.insertions}\t${s.deletions}\t${p}`)
                    .join("\n");
                },
              );
            }
            return Effect.fail(
              new GitCommandError({
                ...gitCommandContext({
                  operation: "GitVcsDriver.statusDetails.numstat",
                  cwd,
                  args: ["diff", "HEAD", "--numstat", "--"],
                }),
                detail: "git diff HEAD --numstat failed.",
                exitCode: result.exitCode,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            );
          }),
        ),
        statusCacheKey
          ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
          : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
        statusCacheKey
          ? Cache.get(originExistsCache, statusCacheKey).pipe(Effect.orElseSucceed(() => false))
          : originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
      ],
      { concurrency: "unbounded" },
    );
    const statusStdout = statusResult.stdout;

    let refName: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();
    const indexStatuses = new Map<
      string,
      "staged" | "unstaged" | "both" | "untracked" | "conflicted"
    >();
    const pathSides = new Map<string, PorcelainPathSides>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) {
          changedFilesWithoutNumstat.add(pathValue);
          const indexStatus = parsePorcelainIndexStatus(line);
          if (indexStatus) indexStatuses.set(pathValue, indexStatus);
          pathSides.set(pathValue, parsePorcelainPathSides(line, pathValue));
        }
      }
    }

    const fallbackAheadCount =
      !upstreamRef && refName
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0))
        : null;

    if (fallbackAheadCount !== null) {
      aheadCount = fallbackAheadCount;
      behindCount = 0;
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    if (refName && !isDefaultBranch) {
      aheadOfDefaultCount =
        fallbackAheadCount !== null
          ? fallbackAheadCount
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0));
    }

    const numstatEntries = parseNumstatEntries(numstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of numstatEntries) {
      fileStatMap.set(entry.path, {
        insertions: entry.insertions,
        deletions: entry.deletions,
      });
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return {
          path: filePath,
          insertions: stat.insertions,
          deletions: stat.deletions,
          ...(indexStatuses.has(filePath) ? { indexStatus: indexStatuses.get(filePath)! } : {}),
          ...(pathSides.has(filePath) ? pathSides.get(filePath) : {}),
        };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({
        path: filePath,
        insertions: 0,
        deletions: 0,
        ...(indexStatuses.has(filePath) ? { indexStatus: indexStatuses.get(filePath)! } : {}),
        ...(pathSides.has(filePath) ? pathSides.get(filePath) : {}),
      });
    }
    // Git paths are bytes. Locale ordering would make cursor pages disagree
    // between hosts, so retain a stable binary order.
    files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

    const [headResult, headParentResult, indexTreeResult, authorIdentityResult] = yield* Effect.all(
      [
        executeGit("GitVcsDriver.statusDetails.head", cwd, ["rev-parse", "--verify", "HEAD"], {
          allowNonZeroExit: true,
        }),
        executeGit(
          "GitVcsDriver.statusDetails.headParent",
          cwd,
          ["rev-parse", "--verify", "HEAD^"],
          {
            allowNonZeroExit: true,
          },
        ),
        executeGit("GitVcsDriver.statusDetails.indexTree", cwd, ["write-tree"], {
          allowNonZeroExit: true,
        }),
        executeGit("GitVcsDriver.statusDetails.authorIdentity", cwd, ["var", "GIT_AUTHOR_IDENT"], {
          allowNonZeroExit: true,
        }),
      ],
    );
    const mergePath = yield* runGitStdout("GitVcsDriver.statusDetails.mergePath", cwd, [
      "rev-parse",
      "--git-path",
      "MERGE_HEAD",
    ]).pipe(Effect.orElseSucceed(() => ""));
    const mergeFile = path.isAbsolute(mergePath.trim())
      ? mergePath.trim()
      : path.resolve(cwd, mergePath.trim());
    const pendingMergeHeads = mergePath.trim().length
      ? (yield* fileSystem.readFileString(mergeFile).pipe(Effect.orElseSucceed(() => "")))
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];
    const gitDirectoryPath = yield* runGitStdout("GitVcsDriver.statusDetails.gitDir", cwd, [
      "rev-parse",
      "--git-dir",
    ]).pipe(Effect.orElseSucceed(() => ""));
    const gitDirectory = gitDirectoryPath.trim();
    const activeConflictOperation = yield* (
      gitDirectory.length === 0
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const resolveGitStatePath = (name: string) =>
              path.isAbsolute(gitDirectory)
                ? path.join(gitDirectory, name)
                : path.resolve(cwd, gitDirectory, name);
            if (yield* fileSystem.exists(resolveGitStatePath("CHERRY_PICK_HEAD")))
              return "cherry-pick" as const;
            if (yield* fileSystem.exists(resolveGitStatePath("REVERT_HEAD")))
              return "revert" as const;
            if (
              (yield* fileSystem.exists(resolveGitStatePath("rebase-merge"))) ||
              (yield* fileSystem.exists(resolveGitStatePath("rebase-apply")))
            )
              return "rebase" as const;
            return pendingMergeHeads.length > 0 ? ("merge" as const) : undefined;
          })
    ).pipe(Effect.orElseSucceed(() => undefined));

    return {
      isRepo: true,
      ...(repositoryPaths?.worktreeRoot ? { repositoryRoot: repositoryPaths.worktreeRoot } : {}),
      hasOriginRemote: hasPrimaryRemote,
      commitIdentityReady:
        authorIdentityResult.exitCode === 0 && authorIdentityResult.stdout.trim().length > 0,
      isDefaultBranch,
      branch: refName,
      localRevision: `${headResult.stdout.trim()}\0${indexTreeResult.stdout.trim()}`,
      headCommit: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
      ...(headResult.exitCode === 0 ? { headHasParent: headParentResult.exitCode === 0 } : {}),
      ...(indexTreeResult.exitCode === 0 ? { indexTree: indexTreeResult.stdout.trim() } : {}),
      ...(pendingMergeHeads.length > 0 ? { pendingMergeHeads } : {}),
      ...(activeConflictOperation ? { activeConflictOperation } : {}),
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
    "statusDetails",
  )(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
      }),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
    Effect.fn("statusDetailsRemote")(function* (cwd, options) {
      if (options?.refreshUpstream !== false) {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
          }),
          Effect.ignoreCause({ log: true }),
        );
      }
      return yield* readStatusDetailsRemote(cwd);
    });

  const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        ...(details.commitIdentityReady !== undefined
          ? { commitIdentityReady: details.commitIdentityReady }
          : {}),
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
    Effect.fn("prepareCommitContext")(function* (cwd, filePaths) {
      // Generation is a read-only review of the index. In particular, do not
      // reset or add here: doing so destroys a user's partial staging while
      // they are only asking for a message. `--cached` also makes this work
      // for unborn HEAD without manufacturing an empty-tree ref.
      const pathArgs = filePaths && filePaths.length > 0 ? ["--", ...filePaths] : [];
      const trackedDiff = yield* executeGit(
        "GitVcsDriver.prepareCommitContext.trackedDiff",
        cwd,
        ["diff", "--cached", "--no-ext-diff", "--name-status", ...pathArgs],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.orElseSucceed(() => ({
          stdout: "",
          stderr: "",
          exitCode: 1 as const,
          stdoutTruncated: false,
          stderrTruncated: false,
        })),
      );
      const stagedSummary = trackedDiff.stdout.trim();
      if (stagedSummary.length === 0) {
        return null;
      }

      const trackedPatch = yield* executeGit(
        "GitVcsDriver.prepareCommitContext.trackedPatch",
        cwd,
        ["diff", "--cached", "--no-ext-diff", "--patch", "--minimal", ...pathArgs],
        {
          allowNonZeroExit: true,
          maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      ).pipe(
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => ""),
      );

      return {
        stagedSummary,
        stagedPatch: trackedPatch,
      };
    });

  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({
                stream: "stdout",
                text: line,
              }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({
                stream: "stderr",
                text: line,
              }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push from detached HEAD.",
      });
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch =
        options?.refName?.trim() || (yield* resolvePublishBranchName(cwd, branch));
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
        cwd,
        ["push", "-u", requestedRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists({
          cwd,
          remoteName: publishRemoteName,
          refName: branch,
        }).pipe(Effect.orElseSucceed(() => false));
        if (hasRemoteBranch) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
      if (!publishRemoteName) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pushCurrentBranch",
            cwd,
            args: ["push"],
          }),
          detail: "Cannot push because no git remote is configured for this repository.",
        });
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithUpstream",
        cwd,
        ["push", "-u", publishRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (currentUpstream) {
      // A branch tracking a differently named ref was cut from it, the way
      // `git checkout -b feature origin/dev` and our own worktree flow leave
      // it. That upstream is the branch's base, not its publish target, and
      // pushing HEAD onto it would write feature commits to a shared branch
      // (bare `git push` refuses this under push.default=simple). The one
      // same-repo tracking setup that legitimately differs is a git-mangled
      // alias such as local `upstream/effect-atom` for my-org/upstream's
      // `effect-atom`: the branch name ends in the upstream head while the
      // upstream ref ends in the branch name.
      const isAliasOfUpstreamHead =
        branch === currentUpstream.branchName ||
        (branch.endsWith(`/${currentUpstream.branchName}`) &&
          currentUpstream.upstreamRef.endsWith(`/${branch}`));
      if (!isAliasOfUpstreamHead) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        const remoteName = publishRemoteName ?? currentUpstream.remoteName;
        const publishBranch = yield* resolvePublishBranchName(cwd, branch);
        // `-u` retargets the upstream to the published branch, so keep the
        // base recorded first; base resolution reads gh-merge-base before the
        // upstream ref.
        const configuredMergeBase = yield* runGitStdout(
          "GitVcsDriver.pushCurrentBranch.readMergeBase",
          cwd,
          ["config", "--get", `branch.${branch}.gh-merge-base`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (configuredMergeBase.length === 0) {
          yield* runGit("GitVcsDriver.pushCurrentBranch.recordMergeBase", cwd, [
            "config",
            `branch.${branch}.gh-merge-base`,
            currentUpstream.branchName,
          ]);
        }
        yield* runGit(
          "GitVcsDriver.pushCurrentBranch.pushOwnBranch",
          cwd,
          ["push", "-u", remoteName, `HEAD:refs/heads/${publishBranch}`],
          { timeoutMs: null },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${remoteName}/${publishBranch}`,
          setUpstream: true,
        };
      }

      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushUpstream",
        cwd,
        ["push", currentUpstream.remoteName, `HEAD:refs/heads/${currentUpstream.branchName}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"], {
      timeoutMs: null,
    });
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd, strategy) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: pullStrategyArgs(strategy),
        }),
        detail: "Cannot pull from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: pullStrategyArgs(strategy),
        }),
        detail: "Current branch has no upstream configured. Push with upstream first.",
      });
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, pullStrategyArgs(strategy), {
      timeoutMs: 30_000,
      fallbackErrorDetail: "git pull failed",
    });
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* statusDetails(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const range = `${baseRef}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", range],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", range],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-ext-diff", "--patch", "--minimal", range],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  const readUntrackedReviewDiffs = Effect.fn("readUntrackedReviewDiffs")(function* (cwd: string) {
    const untrackedResult = yield* executeGit(
      "GitVcsDriver.readUntrackedReviewDiffs.list",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult);
    if (untrackedPaths.length === 0) {
      return { diff: "", truncated: untrackedResult.stdoutTruncated };
    }

    const diffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        executeGit(
          "GitVcsDriver.readUntrackedReviewDiffs.diff",
          cwd,
          [
            "diff",
            "--no-index",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            ...PATCH_RENDER_PREFIX_ARGS,
            "--",
            "/dev/null",
            relativePath,
          ],
          {
            allowNonZeroExit: true,
            maxOutputBytes: REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      { concurrency: 4 },
    );

    return {
      diff: Arr.filterMap(diffs, (result) =>
        result.stdout.trim().length > 0 ? Result.succeed(result.stdout) : Result.failVoid,
      ).join("\n"),
      truncated: untrackedResult.stdoutTruncated || diffs.some((result) => result.stdoutTruncated),
    };
  });

  const readTrackedReviewDiff = Effect.fn("readTrackedReviewDiff")(function* (
    cwd: string,
    ignoreWhitespace: boolean | undefined,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.readTrackedReviewDiff",
      cwd,
      [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...PATCH_RENDER_PREFIX_ARGS,
        "--find-renames",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
        "--",
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    return { diff: result.stdout, truncated: result.stdoutTruncated };
  });

  const readUnifiedWorkingTreeReviewDiff = Effect.fn("readUnifiedWorkingTreeReviewDiff")(function* (
    cwd: string,
    untrackedPaths: ReadonlyArray<string>,
    pathsTruncated: boolean,
    ignoreWhitespace: boolean | undefined,
  ) {
    const [stagedDeletionsStdout, indexValue] = yield* Effect.all(
      [
        runGitStdout("GitVcsDriver.readUnifiedWorkingTreeReviewDiff.stagedDeletions", cwd, [
          "diff",
          "--cached",
          "--name-only",
          "--diff-filter=D",
          "-z",
          "HEAD",
          "--",
        ]),
        runGitStdout("GitVcsDriver.readUnifiedWorkingTreeReviewDiff.indexPath", cwd, [
          "rev-parse",
          "--git-path",
          "index",
        ]),
      ],
      { concurrency: 2 },
    );
    const stagedDeletions = new Set(stagedDeletionsStdout.split("\0").filter(Boolean));
    const pathsToAdd = untrackedPaths.filter((relativePath) => !stagedDeletions.has(relativePath));
    if (pathsToAdd.length === 0) {
      const tracked = yield* readTrackedReviewDiff(cwd, ignoreWhitespace);
      return { ...tracked, truncated: pathsTruncated || tracked.truncated };
    }

    const indexPath = path.isAbsolute(indexValue.trim())
      ? indexValue.trim()
      : path.resolve(cwd, indexValue.trim());
    const tempIndexPath = yield* fileSystem.makeTempFileScoped({
      prefix: `t3code-review-index-${process.pid}-`,
    });
    yield* fileSystem.copyFile(indexPath, tempIndexPath);
    const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
    const tempIndexConfig = [
      "-c",
      "core.splitIndex=false",
      "-c",
      "splitIndex.sharedIndexExpire=never",
    ];
    yield* executeGit(
      "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.expandSplitIndex",
      cwd,
      [...tempIndexConfig, "update-index", "--no-split-index"],
      { env },
    );
    yield* executeGit(
      "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.addUntracked",
      cwd,
      [
        ...tempIndexConfig,
        "--literal-pathspecs",
        "add",
        "--intent-to-add",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { env, stdin: `${pathsToAdd.join("\0")}\0` },
    );
    const result = yield* executeGit(
      "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.diff",
      cwd,
      [
        ...tempIndexConfig,
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...PATCH_RENDER_PREFIX_ARGS,
        "--find-renames",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
        "--",
      ],
      {
        env,
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    return {
      diff: result.stdout,
      truncated: pathsTruncated || result.stdoutTruncated,
    };
  });

  const readWorkingTreeReviewDiff = Effect.fn("readWorkingTreeReviewDiff")(function* (
    cwd: string,
    ignoreWhitespace: boolean | undefined,
  ) {
    const untrackedResult = yield* executeGit(
      "GitVcsDriver.readWorkingTreeReviewDiff.listUntracked",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(Effect.option);
    if (untrackedResult._tag === "None") {
      return yield* readTrackedReviewDiff(cwd, ignoreWhitespace);
    }
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult.value);
    if (untrackedPaths.length === 0) {
      const tracked = yield* readTrackedReviewDiff(cwd, ignoreWhitespace);
      return {
        ...tracked,
        truncated: untrackedResult.value.stdoutTruncated || tracked.truncated,
      };
    }

    return yield* readUnifiedWorkingTreeReviewDiff(
      cwd,
      untrackedPaths,
      untrackedResult.value.stdoutTruncated,
      ignoreWhitespace,
    ).pipe(
      Effect.scoped,
      Effect.catch(() =>
        Effect.all([
          readTrackedReviewDiff(cwd, ignoreWhitespace).pipe(
            Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
          ),
          readUntrackedReviewDiffs(cwd).pipe(
            Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
          ),
        ]).pipe(
          Effect.map(([tracked, untracked]) => ({
            diff: [tracked.diff.trimEnd(), untracked.diff.trimEnd()]
              .filter((diff) => diff.length > 0)
              .join("\n"),
            truncated: tracked.truncated || untracked.truncated,
          })),
        ),
      ),
    );
  });

  const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const details = yield* statusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const branch = details.branch;
    const baseRef =
      input.baseRef ??
      (branch
        ? yield* resolveBaseBranchForNoUpstream(input.cwd, branch).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null);

    const dirtyResult = yield* readWorkingTreeReviewDiff(input.cwd, input.ignoreWhitespace).pipe(
      Effect.orElseSucceed(() => ({
        diff: "",
        truncated: false,
      })),
    );
    const dirtyDiff = dirtyResult.diff;

    // Resolve both refs in one Git invocation before producing the patch. A
    // ref may move while a status refresh is in flight; using the captured
    // object ids for merge-base and diff keeps the preview and descriptor one
    // immutable comparison rather than a patch from one branch tip labelled
    // with another.
    const capturedBranchRevisions =
      baseRef && branch
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.captureRevisions",
            input.cwd,
            ["rev-parse", `${baseRef}^{commit}`, "HEAD^{commit}"],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? result.stdout
                    .split(/\r?\n/g)
                    .map((line) => line.trim())
                    .filter(Boolean)
                : [],
            ),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          )
        : [];
    const capturedBaseRevision = capturedBranchRevisions[0] ?? null;
    const capturedHeadRevision = capturedBranchRevisions[1] ?? null;
    const branchBaseRevision =
      capturedBaseRevision && capturedHeadRevision
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.mergeBase",
            input.cwd,
            ["merge-base", capturedBaseRevision, capturedHeadRevision],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
            Effect.orElseSucceed(() => null),
          )
        : null;
    const baseResult =
      branchBaseRevision && capturedHeadRevision
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.base",
            input.cwd,
            [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--minimal",
              ...PATCH_RENDER_PREFIX_ARGS,
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              `${branchBaseRevision}..${capturedHeadRevision}`,
            ],
            {
              maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
              appendTruncationMarker: true,
            },
          ).pipe(
            Effect.orElseSucceed(() => ({
              exitCode: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          )
        : null;
    const baseDiff = baseResult?.stdout ?? "";
    // `base...HEAD` means merge-base(base, HEAD), not the base ref tip. Keep
    // that exact pair with the rendered aggregate so a file tab has identical
    // semantics even when either branch moves afterwards.
    const branchHeadRevision = capturedHeadRevision;
    const hashDiff = (diff: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd: input.cwd,
              detail: "Failed to hash review diff.",
              cause,
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirtyDiff),
      hashDiff(baseDiff),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: dirtyDiff,
        diffHash: dirtyDiffHash,
        truncated: dirtyResult.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef: branch ?? "HEAD",
        ...(branchBaseRevision ? { baseRevision: branchBaseRevision } : {}),
        ...(branchHeadRevision ? { headRevision: branchHeadRevision } : {}),
        diff: baseDiff,
        diffHash: baseDiffHash,
        truncated: baseResult?.stdoutTruncated ?? false,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    };
  });

  const reviewDiffFileError = (
    input: ReviewDiffFileContentsInput,
    detail: string,
    cause?: unknown,
  ) =>
    new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffFileContents",
      command: "git",
      cwd: input.cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const readReviewFileAtRevision = Effect.fn("readReviewFileAtRevision")(function* (
    input: ReviewDiffFileContentsInput,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffFileContents.revision",
      input.cwd,
      ["show", `${revision}:${relativePath}`],
      { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.stdout.includes("\0")) {
      return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
    }
    return result.stdout;
  });

  const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
  ) {
    const fileError = (stage: string, detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: `GitVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
        command: stage,
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const requestedPath = path.resolve(repositoryRoot, input.newPath);
    if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
      return yield* fileError(
        "path.resolve",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const [realRepositoryRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(requestedPath),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
      ),
    );
    if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
      return yield* fileError(
        "fs.realPath",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
    }
    if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
      return yield* fileError(
        "fs.stat",
        `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
      );
    }

    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
    }
    return new TextDecoder("utf-8").decode(bytes);
  });

  const getReviewDiffFileContents = Effect.fn("getReviewDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
  ) {
    if (input.sourceKind === "working-tree") {
      const repositoryRoot = yield* runGitStdout(
        "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
        input.cwd,
        ["rev-parse", "--show-toplevel"],
      ).pipe(Effect.map((value) => value.trim()));
      if (repositoryRoot.length === 0) {
        return yield* reviewDiffFileError(input, "Could not resolve the Git repository root.");
      }
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readReviewFileAtRevision(input, input.baseRef ?? "HEAD", input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readWorkingTreeReviewFile(input, repositoryRoot),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }

    if (!input.baseRef || !input.headRef) {
      return yield* reviewDiffFileError(
        input,
        "Branch diff file expansion requires both base and head refs.",
      );
    }
    const mergeBase = yield* runGitStdout(
      "GitVcsDriver.getReviewDiffFileContents.mergeBase",
      input.cwd,
      ["merge-base", input.baseRef, input.headRef],
    ).pipe(Effect.map((value) => value.trim()));
    if (mergeBase.length === 0) {
      return yield* reviewDiffFileError(input, "Could not resolve the branch comparison base.");
    }
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, mergeBase, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, input.headRef, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const gitDirArgs = ["--git-dir", gitCommonDir] as const;
    const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.listRefs.snapshotRefs",
          fetchCwd,
          [
            ...gitDirArgs,
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 30_000,
            maxOutputBytes: 16 * 1024 * 1024,
            fallbackErrorDetail: "Git ref snapshot enumeration failed.",
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.defaultRef",
          fetchCwd,
          [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.worktreeList",
          fetchCwd,
          [...gitDirArgs, "worktree", "list", "--porcelain", "-z"],
          {
            timeoutMs: 30_000,
            allowNonZeroExit: true,
            maxOutputBytes: 16 * 1024 * 1024,
          },
        ),
        executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: 2 },
    );

    const remoteNames =
      remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;
    const parsedWorktreeEntries =
      worktreeListResult.exitCode === 0
        ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
            ([branchName, worktreePath]) =>
              [branchName, path.normalize(path.resolve(worktreePath))] as const,
          )
        : [];
    const existingWorktreeEntries = yield* Effect.filter(
      parsedWorktreeEntries,
      ([, worktreePath]) =>
        fileSystem.stat(worktreePath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: 16 },
    );
    const worktreeMap = new Map(existingWorktreeEntries);
    const localBranches: Array<{
      readonly ref: VcsRef;
      readonly lastCommit: number;
    }> = [];
    const remoteBranches: Array<{
      readonly ref: VcsRef;
      readonly lastCommit: number;
    }> = [];

    for (const line of refsResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");
      if (!fullRefName || symbolicTarget) continue;
      const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

      if (fullRefName.startsWith("refs/heads/")) {
        const name = fullRefName.slice("refs/heads/".length);
        localBranches.push({
          ref: {
            name,
            current: false,
            isRemote: false,
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          },
          lastCommit,
        });
        continue;
      }
      if (!fullRefName.startsWith("refs/remotes/")) continue;

      const name = fullRefName.slice("refs/remotes/".length);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
      const remoteBranch: VcsRef = {
        name,
        current: false,
        isRemote: true,
        isDefault:
          defaultBranch !== null &&
          parsedRemoteRef?.remoteName === "origin" &&
          parsedRemoteRef.branchName === defaultBranch,
        worktreePath: null,
        ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
      };
      remoteBranches.push({ ref: remoteBranch, lastCommit });
    }

    const byRecencyThenName = (
      left: { readonly ref: VcsRef; readonly lastCommit: number },
      right: { readonly ref: VcsRef; readonly lastCommit: number },
    ) =>
      left.lastCommit !== right.lastCommit
        ? right.lastCommit - left.lastCommit
        : left.ref.name.localeCompare(right.ref.name);

    return {
      localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      hasPrimaryRemote: remoteNames.includes("origin"),
    } satisfies GitRefsSnapshot;
  });

  const listRefsEpochByCommonDir = new Map<string, number>();
  let listRefsEpochSequence = 0;
  const bumpListRefsEpoch = (gitCommonDir: string): number => {
    const nextEpoch = ++listRefsEpochSequence;
    listRefsEpochByCommonDir.delete(gitCommonDir);
    listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);
    if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsEpochByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsEpochByCommonDir.delete(oldestKey);
      }
    }
    return nextEpoch;
  };
  const listRefsGenerationByCommonDir = new Map<string, number>();
  let listRefsGenerationSequence = 0;
  const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
    listRefsGenerationByCommonDir.delete(gitCommonDir);
    listRefsGenerationByCommonDir.set(gitCommonDir, generation);
    if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsGenerationByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsGenerationByCommonDir.delete(oldestKey);
      }
    }
    return generation;
  };
  const currentListRefsGeneration = (gitCommonDir: string): number => {
    const current = listRefsGenerationByCommonDir.get(gitCommonDir);
    return current === undefined
      ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
      : setListRefsGeneration(gitCommonDir, current);
  };
  const bumpListRefsGeneration = (gitCommonDir: string): number =>
    setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);
  const listRefsSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsRefreshCacheKey) =>
      Effect.suspend(() => {
        const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);
        return Cache.get(
          listRefsSnapshotCache,
          new GitRefsSnapshotCacheKey({
            gitCommonDir: cacheKey.gitCommonDir,
            epoch,
          }),
        );
      }),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
    },
  );
  const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
    gitCommonDir: string,
    refresh: boolean,
  ) {
    while (true) {
      const generation = currentListRefsGeneration(gitCommonDir);
      const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
      const snapshot =
        refresh || currentEpoch === undefined
          ? // The refresh cache owns the complete snapshot read, rather than only the
            // epoch bump. Slow repositories therefore remain singleflight for the
            // entire Git scan even when more refresh requests arrive after the
            // coalescing TTL would otherwise have elapsed.
            yield* Cache.get(
              listRefsRefreshSnapshotCache,
              new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
            )
          : yield* Cache.get(
              listRefsSnapshotCache,
              new GitRefsSnapshotCacheKey({
                gitCommonDir,
                epoch: currentEpoch,
              }),
            );
      if (currentListRefsGeneration(gitCommonDir) === generation) {
        return snapshot;
      }
    }
  });
  const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
    cwd: string,
  ) {
    const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
    const repositoryPaths = yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey);
    if (repositoryPaths === null) return;
    const previousGeneration = currentListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsEpoch(repositoryPaths.gitCommonDir);
    yield* Cache.invalidate(
      listRefsRefreshSnapshotCache,
      new GitRefsRefreshCacheKey({
        gitCommonDir: repositoryPaths.gitCommonDir,
        generation: previousGeneration,
      }),
    );
    yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
    yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
  });

  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const repositoryPaths = yield* resolveRepositoryPaths(input.cwd, input.refresh === true).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (repositoryPaths === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }

      const snapshot = yield* resolveListRefsSnapshot(
        repositoryPaths.gitCommonDir,
        input.refresh === true,
      );
      const hasCurrentWorktreeBranch =
        repositoryPaths.worktreeRoot !== null &&
        snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);
      const localBranches = snapshot.localBranches.map((ref) => ({
        ...ref,
        current: hasCurrentWorktreeBranch
          ? ref.worktreePath === repositoryPaths.worktreeRoot
          : ref.name === repositoryPaths.currentBranch,
      }));
      const combinedBranches = input.includeMatchingRemoteRefs
        ? [...localBranches, ...snapshot.remoteBranches]
        : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);
      // Keep current/default refs on the first page even when the default
      // only exists as origin/<default> (remote refs sort after all locals).
      const allBranches = combinedBranches.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const branchesForKind =
        input.refKind === "local"
          ? allBranches.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allBranches.filter((ref) => ref.isRemote)
            : allBranches;
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(branchesForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input, options) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    const args = input.newRefName
      ? ["worktree", "add", "-b", input.newRefName, worktreePath, input.refName]
      : ["worktree", "add", worktreePath, input.refName];
    const progress = options?.progress;
    const onCheckoutProgress = progress?.onCheckoutProgress;

    yield* executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
      fallbackErrorDetail: "git worktree add failed",
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      ...(onCheckoutProgress
        ? {
            // Git only prints checkout progress when stderr is a tty or the
            // delay elapsed. GIT_PROGRESS_DELAY=0 forces it through the pipe.
            env: { GIT_PROGRESS_DELAY: "0", LC_ALL: "C" },
            progress: {
              onStderrLine: (line) => {
                const parsed = parseGitCheckoutProgressLine(line);
                return parsed ? onCheckoutProgress(parsed) : Effect.void;
              },
            },
          }
        : {}),
    });

    if (progress?.onWorktreeClaimed) {
      yield* progress.onWorktreeClaimed(worktreePath);
    }

    // `git worktree add` leaves submodules empty, so a repo that keeps agent
    // skills, tooling or source in one gets a worktree that is quietly missing
    // them. Best-effort: the objects are usually already in the parent's
    // `.git/modules`, but a first-ever clone needs the network, and failing to
    // populate a submodule must not roll back the caller's thread.
    const hasSubmodules = yield* fileSystem
      .exists(path.join(worktreePath, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasSubmodules) {
      if (progress?.onSubmodulesStarted) {
        yield* progress.onSubmodulesStarted();
      }
      const onSubmoduleLine = progress?.onSubmoduleLine;
      yield* runGit(
        "GitVcsDriver.createWorktree.updateSubmodules",
        worktreePath,
        ["submodule", "update", "--init", "--recursive"],
        onSubmoduleLine
          ? {
              env: { LC_ALL: "C" },
              progress: {
                onStdoutLine: onSubmoduleLine,
                onStderrLine: onSubmoduleLine,
              },
            }
          : {},
      ).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning("worktree submodule checkout failed; submodule paths are empty", {
              worktreePath,
              cause,
            }).pipe(
              Effect.andThen(
                progress?.onSubmodulesFinished
                  ? progress.onSubmodulesFinished({
                      ok: false,
                      detail: cause.message,
                    })
                  : Effect.void,
              ),
            ),
          onSuccess: () =>
            progress?.onSubmodulesFinished
              ? progress.onSubmodulesFinished({ ok: true, detail: null })
              : Effect.void,
        }),
      );
    }

    if (input.newRefName && input.baseRefName) {
      const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));
      const parsedBaseRef = parseRemoteRefWithRemoteNames(
        input.baseRefName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
      yield* runGit("GitVcsDriver.createWorktree.configureBaseRef", input.cwd, [
        "config",
        `branch.${input.newRefName}.gh-merge-base`,
        baseBranch,
      ]);
    }

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorDetail: "git fetch pull request branch failed",
        },
      );
    });

  const resolveCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveCommit"] = Effect.fn(
    "resolveCommit",
  )(function* (input) {
    const commitSha = yield* runGitStdout("GitVcsDriver.resolveCommit", input.cwd, [
      "rev-parse",
      "--verify",
      `${input.revision}^{commit}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const fetchPullRequestHeadCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestHeadCommit"] =
    Effect.fn("fetchPullRequestHeadCommit")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      // No refspec destination: the pull head lands in FETCH_HEAD (per worktree) instead of a
      // branch, which is the only way to read it while that branch is checked out somewhere.
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestHeadCommit",
        input.cwd,
        ["fetch", "--quiet", "--no-tags", remoteName, `refs/pull/${input.prNumber}/head`],
        {
          fallbackErrorDetail: "git fetch pull request head failed",
        },
      );

      return yield* resolveCommit({ cwd: input.cwd, revision: "FETCH_HEAD" });
    });

  const refreshCheckedOutBranch: GitVcsDriver.GitVcsDriver["Service"]["refreshCheckedOutBranch"] =
    Effect.fn("refreshCheckedOutBranch")(function* (input) {
      const { commitSha: headCommit } = yield* resolveCommit({
        cwd: input.cwd,
        revision: "HEAD",
      });
      if (headCommit === input.targetCommit) {
        return { headCommit, moved: false, onTarget: true };
      }

      const worktreeChanges = yield* runGitStdout(
        "GitVcsDriver.refreshCheckedOutBranch.status",
        input.cwd,
        ["status", "--porcelain"],
      );
      if (worktreeChanges.trim().length > 0) {
        return { headCommit, moved: false, onTarget: false };
      }

      const isAncestor = yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.isAncestor",
        input.cwd,
        ["merge-base", "--is-ancestor", headCommit, input.targetCommit],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      // A rewritten head (rebase, squash, amend) does not descend from the checkout, so it can
      // only be taken by resetting. That is lossless exactly when the tree is clean and HEAD
      // never left the commit the upstream held before the fetch.
      if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
        return { headCommit, moved: false, onTarget: false };
      }

      if (!isAncestor) {
        // The commit being reset away is about to be reachable from nothing. It is only ever a
        // commit the remote already held, but "the remote held it" stops being a way back once
        // the head it belonged to has been rewritten, so a ref keeps it findable.
        yield* executeGit(
          "GitVcsDriver.refreshCheckedOutBranch.keepPrevious",
          input.cwd,
          ["update-ref", "refs/t3code/pre-refresh", headCommit],
          {
            fallbackErrorDetail: "git failed to record the previous checkout commit",
          },
        );
      }

      yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.move",
        input.cwd,
        // `--merge` rather than `--hard`: the cleanliness check above is a snapshot, and another
        // thread may edit a tracked file between it and this move. Git itself refuses a `--merge`
        // reset that would overwrite such an edit — the same guarantee `--ff-only` gives the
        // other branch — so a race loses nothing; the refresh fails and is reported instead.
        isAncestor
          ? ["merge", "--ff-only", input.targetCommit]
          : ["reset", "--merge", input.targetCommit],
        {
          timeoutMs: 30_000,
          fallbackErrorDetail: "git failed to move the checkout onto the pull request head",
        },
      );

      return { headCommit: input.targetCommit, moved: true, onTarget: true };
    });

  const fetchRemote: GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"] = Effect.fn("fetchRemote")(
    function* (input) {
      yield* executeGit(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        ["fetch", "--quiet", input.remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
        },
      );
    },
  );

  const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
    Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
      const remoteNames = yield* listRemoteNames(input.cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(
        input.refName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const remoteRefName =
        parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
      const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remoteRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha, remoteRefName };
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    const result = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.removeWorktree",
      input.cwd,
      args,
      {
        // Removing dependency-heavy worktrees is filesystem-bound and can take
        // minutes, especially on Windows. Keep it bounded without interrupting
        // git midway through cleanup.
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
        allowNonZeroExit: true,
      },
    );
    if (result.exitCode === 0) {
      return;
    }
    // Threads can share a worktree path, and worktrees get removed or pruned
    // outside the app, so a worktree that is already gone is a no-op rather
    // than an error. Prune so no stale registration lingers to block a later
    // `worktree add` at the same path.
    const alreadyGone =
      isMissingWorktreeStderr(result.stderr) &&
      !(yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => false)));
    if (alreadyGone) {
      yield* pruneWorktrees({ cwd: input.cwd });
      return;
    }
    // Raw stderr stays out of both the wire error and the log (it can carry
    // secrets); log bounded diagnostics so a genuine failure is visible
    // server-side.
    yield* Effect.logWarning(
      `GitVcsDriver.removeWorktree: git worktree remove exited with code ${result.exitCode} for ${input.path} (stderr length ${result.stderr.length}).`,
    );
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.removeWorktree",
        cwd: input.cwd,
        args,
      }),
      detail: "git worktree remove failed",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });
  });

  const pruneWorktrees: GitVcsDriver.GitVcsDriver["Service"]["pruneWorktrees"] = Effect.fn(
    "pruneWorktrees",
  )(function* (input) {
    yield* executeGit("GitVcsDriver.pruneWorktrees", input.cwd, ["worktree", "prune"], {
      timeoutMs: 15_000,
      fallbackErrorDetail: "git worktree prune failed",
    });
  });

  const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
    "renameBranch",
  )(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitVcsDriver.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const mutationRejection = (
    operation: string,
    cwd: string,
    code:
      | "dirty_worktree_confirmation_required"
      | "default_ref_confirmation_required"
      | "stale_git_state",
    detail: string,
  ) =>
    new GitCommandError({
      ...gitCommandContext({ operation, cwd, args: [] }),
      code,
      detail,
    });

  const indexPathError = (operation: string, cwd: string, pathValue: string, detail: string) =>
    new GitCommandError({
      ...gitCommandContext({ operation, cwd, args: [pathValue] }),
      detail,
    });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  // Resolve the nearest existing ancestor before checking containment. A lexical
  // check alone accepts `link/outside.txt` when `link` is a symlink that leaves
  // the worktree.
  const resolveExistingIndexPathAncestor = Effect.fn(
    "GitVcsDriver.resolveExistingIndexPathAncestor",
  )(function* (requestedPath: string, repositoryRoot: string) {
    let candidate = requestedPath;
    while (true) {
      const realPath = yield* fileSystem.realPath(candidate).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        }),
      );
      if (realPath !== null) return realPath;
      if (candidate === repositoryRoot) return yield* fileSystem.realPath(candidate);
      candidate = path.dirname(candidate);
    }
  });

  const validateIndexPaths = Effect.fn("GitVcsDriver.validateIndexPaths")(function* (
    operation: string,
    cwd: string,
    paths: readonly string[],
  ) {
    const repository = yield* resolveRepositoryPaths(cwd);
    if (repository?.worktreeRoot === null || repository === null) {
      return yield* new GitCommandError({
        ...gitCommandContext({ operation, cwd, args: [] }),
        detail: "Index operations require a non-bare Git worktree.",
      });
    }
    const root = repository.worktreeRoot;
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() =>
          indexPathError(operation, cwd, root, "Could not resolve the Git worktree root."),
        ),
      );
    const validated: string[] = [];
    for (const candidate of paths) {
      if (candidate.length === 0 || path.isAbsolute(candidate)) {
        return yield* indexPathError(
          operation,
          cwd,
          candidate,
          "Git index paths must be non-empty root-relative paths.",
        );
      }
      const resolved = path.resolve(root, candidate);
      const relative = path.relative(root, resolved);
      if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return yield* indexPathError(
          operation,
          cwd,
          candidate,
          `Git index path '${candidate}' resolves outside the repository root.`,
        );
      }
      const realAncestor = yield* resolveExistingIndexPathAncestor(resolved, root).pipe(
        Effect.mapError(() =>
          indexPathError(
            operation,
            cwd,
            candidate,
            `Could not resolve Git index path '${candidate}'.`,
          ),
        ),
      );
      if (!isPathWithinRoot(realRoot, realAncestor)) {
        return yield* indexPathError(
          operation,
          cwd,
          candidate,
          `Git index path '${candidate}' resolves outside the repository root.`,
        );
      }
      if (!validated.includes(relative)) validated.push(relative);
    }
    return { root, paths: validated };
  });

  const readMutationState = Effect.fn("GitVcsDriver.readMutationState")(function* (cwd: string) {
    const [head, indexTree, refName, mergePath] = yield* Effect.all([
      runGitStdout("GitVcsDriver.mutationState.head", cwd, ["rev-parse", "--verify", "HEAD"], true),
      runGitStdout("GitVcsDriver.mutationState.index", cwd, ["write-tree"]),
      runGitStdout(
        "GitVcsDriver.mutationState.ref",
        cwd,
        ["symbolic-ref", "--short", "-q", "HEAD"],
        true,
      ),
      runGitStdout("GitVcsDriver.mutationState.mergePath", cwd, [
        "rev-parse",
        "--git-path",
        "MERGE_HEAD",
      ]),
    ]);
    const mergeFile = path.isAbsolute(mergePath.trim())
      ? mergePath.trim()
      : path.resolve(cwd, mergePath.trim());
    const mergeHeads = (yield* fileSystem
      .readFileString(mergeFile)
      .pipe(Effect.orElseSucceed(() => "")))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return {
      headCommit: head.trim() || null,
      indexTree: indexTree.trim(),
      refName: refName.trim() || null,
      mergeHeads,
    };
  });

  const mergeHeadsEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
    left.length === right.length && left.every((head, index) => head === right[index]);

  const guardedCommitHookNames = Effect.fn("GitVcsDriver.guardedCommitHookNames")(function* (
    cwd: string,
  ) {
    const hooksPath = yield* runGitStdout("GitVcsDriver.guardedCommitHooksPath", cwd, [
      "rev-parse",
      "--git-path",
      "hooks",
    ]).pipe(Effect.map((value) => value.trim()));
    const hooksDirectory = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(cwd, hooksPath);
    const configuredHooks = yield* Effect.forEach(
      GUARDED_COMMIT_HOOK_NAMES,
      (hookName) =>
        fileSystem.stat(path.join(hooksDirectory, hookName)).pipe(
          Effect.map((info) =>
            info.type === "File" && (info.mode & 0o111) !== 0 ? hookName : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: "unbounded" },
    );
    return configuredHooks.filter(
      (hookName): hookName is (typeof GUARDED_COMMIT_HOOK_NAMES)[number] => hookName !== null,
    );
  });

  const guardedCommitSigningArgs = Effect.fn("GitVcsDriver.guardedCommitSigningArgs")(function* (
    cwd: string,
  ) {
    const signingEnabled = yield* runGitStdout(
      "GitVcsDriver.guardedCommitSigningConfig",
      cwd,
      ["config", "--bool", "--get", "commit.gpgSign"],
      true,
    );
    return signingEnabled.trim() === "true" ? (["-S"] as const) : ([] as const);
  });

  const guardDirtyWorkingTree = Effect.fn("GitVcsDriver.guardDirtyWorkingTree")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly confirmDirtyWorkingTree?: boolean | undefined;
    },
  ) {
    // Old clients do not send the field. New clients send false first, then true only after a dialog.
    if (input.confirmDirtyWorkingTree === undefined || input.confirmDirtyWorkingTree === true)
      return;
    const status = yield* runGitStdout(`${operation}.status`, input.cwd, ["status", "--porcelain"]);
    if (status.length > 0) {
      return yield* mutationRejection(
        `${operation}.dirtyWorktree`,
        input.cwd,
        "dirty_worktree_confirmation_required",
        "Switching refs with working tree changes requires confirmation.",
      );
    }
  });

  const hasGitOperationState = Effect.fn("GitVcsDriver.hasGitOperationState")(function* (
    cwd: string,
    stateFile: "CHERRY_PICK_HEAD" | "REVERT_HEAD",
  ) {
    const statePath = yield* runGitStdout("GitVcsDriver.operationStatePath", cwd, [
      "rev-parse",
      "--git-path",
      stateFile,
    ]).pipe(Effect.map((value) => value.trim()));
    return yield* fileSystem
      .exists(path.isAbsolute(statePath) ? statePath : path.resolve(cwd, statePath))
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              ...gitCommandContext({
                operation: "GitVcsDriver.operationStateExists",
                cwd,
                args: [],
              }),
              detail: `Could not inspect ${stateFile}.`,
              cause,
            }),
        ),
      );
  });

  const stageFiles: GitVcsDriver.GitVcsDriver["Service"]["stageFiles"] = Effect.fn("stageFiles")(
    function* (input) {
      const validated = yield* validateIndexPaths(
        "GitVcsDriver.stageFiles",
        input.cwd,
        input.paths,
      );
      const fileStates = yield* Effect.forEach(
        validated.paths,
        (relativePath) =>
          fileSystem.stat(path.join(validated.root, relativePath)).pipe(
            Effect.catchTags({
              PlatformError: (cause) =>
                cause.reason._tag === "NotFound"
                  ? Effect.succeed(null)
                  : Effect.fail(
                      new GitCommandError({
                        ...gitCommandContext({
                          operation: "GitVcsDriver.stageFiles.inspectPath",
                          cwd: input.cwd,
                          args: [relativePath],
                        }),
                        detail: `Could not inspect Git index path '${relativePath}'.`,
                        cause,
                      }),
                    ),
            }),
          ),
        { concurrency: "unbounded" },
      );
      const missingPaths = validated.paths.filter((_, index) => fileStates[index] === null);
      const trackedMissingPaths =
        missingPaths.length === 0
          ? new Set<string>()
          : new Set(
              (yield* runGitStdout("GitVcsDriver.stageFiles.trackedPaths", validated.root, [
                "--literal-pathspecs",
                "ls-files",
                "--cached",
                "-z",
                "--",
                ...missingPaths,
              ]))
                .split("\0")
                .filter((pathValue) => pathValue.length > 0),
            );
      const paths = validated.paths.filter(
        (pathValue, index) => fileStates[index] !== null || trackedMissingPaths.has(pathValue),
      );
      if (paths.length === 0) return;
      yield* runGit("GitVcsDriver.stageFiles", validated.root, [
        "--literal-pathspecs",
        "add",
        "--",
        ...paths,
      ]);
    },
  );

  const unstageFiles: GitVcsDriver.GitVcsDriver["Service"]["unstageFiles"] = Effect.fn(
    "unstageFiles",
  )(function* (input) {
    const validated = yield* validateIndexPaths(
      "GitVcsDriver.unstageFiles",
      input.cwd,
      input.paths,
    );
    const head = yield* executeGit(
      "GitVcsDriver.unstageFiles.head",
      validated.root,
      ["rev-parse", "--verify", "HEAD"],
      { allowNonZeroExit: true },
    );
    yield* runGit(
      "GitVcsDriver.unstageFiles",
      validated.root,
      head.exitCode === 0
        ? ["--literal-pathspecs", "restore", "--staged", "--", ...validated.paths]
        : ["--literal-pathspecs", "reset", "--", ...validated.paths],
    );
  });

  const getWorkingTreeDiff: GitVcsDriver.GitVcsDriver["Service"]["getWorkingTreeDiff"] = Effect.fn(
    "getWorkingTreeDiff",
  )(function* (input) {
    if (
      input.path === undefined &&
      (input.comparison !== "index" || input.reviewedState === undefined)
    ) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.getWorkingTreeDiff",
          cwd: input.cwd,
          args: [],
        }),
        detail: "A repository-wide diff is only available for a guarded index review.",
      });
    }
    const validated =
      input.path === undefined
        ? null
        : yield* validateIndexPaths("GitVcsDriver.getWorkingTreeDiff", input.cwd, [input.path]);
    let root: string;
    if (validated) {
      root = validated.root;
    } else {
      const repository = yield* resolveRepositoryPaths(input.cwd);
      if (repository?.worktreeRoot === null || repository === null) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.getWorkingTreeDiff",
            cwd: input.cwd,
            args: [],
          }),
          detail: "Index operations require a non-bare Git worktree.",
        });
      }
      root = repository.worktreeRoot;
    }
    const relativePath = validated?.paths[0];
    if (input.comparison === "index" && input.reviewedState !== undefined) {
      const reviewed = input.reviewedState;
      const indexTree = yield* runGitStdout("GitVcsDriver.getWorkingTreeDiff.reviewedIndex", root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${reviewed.indexTree}^{tree}`,
      ]).pipe(Effect.map((value) => value.trim()));
      const baseTree =
        reviewed.headCommit === null
          ? yield* runGitStdoutWithOptions(
              "GitVcsDriver.getWorkingTreeDiff.emptyTree",
              root,
              ["hash-object", "-t", "tree", "--stdin"],
              { stdin: "" },
            ).pipe(Effect.map((value) => value.trim()))
          : yield* runGitStdout("GitVcsDriver.getWorkingTreeDiff.reviewedHead", root, [
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${reviewed.headCommit}^{tree}`,
            ]).pipe(Effect.map((value) => value.trim()));
      const args = [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--patch",
        "--minimal",
        baseTree,
        indexTree,
        ...(relativePath ? ["--", relativePath] : []),
      ];
      const result = yield* executeGit(
        "GitVcsDriver.getWorkingTreeDiff.reviewedState",
        root,
        args,
        {
          allowNonZeroExit: true,
          maxOutputBytes: MAX_WORKING_TREE_DIFF_BYTES,
          appendTruncationMarker: true,
        },
      );
      if (result.exitCode !== 0) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.getWorkingTreeDiff",
            cwd: input.cwd,
            args,
          }),
          detail: "Git reviewed staged diff failed.",
          exitCode: result.exitCode,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        });
      }
      return truncateWorkingTreeDiff(result.stdout, result.stdoutTruncated);
    }
    if (relativePath === undefined) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.getWorkingTreeDiff",
          cwd: input.cwd,
          args: [],
        }),
        detail: "A file path is required for this working-tree diff comparison.",
      });
    }
    const untracked = yield* runGitStdout("GitVcsDriver.getWorkingTreeDiff.untracked", root, [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      relativePath,
    ]);
    const isUntracked = untracked.split("\0").includes(relativePath);
    const args =
      input.comparison !== "index" && isUntracked
        ? ["diff", "--no-index", "--patch", "--no-color", "--", "/dev/null", relativePath]
        : [
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--patch",
            ...(input.comparison === "index"
              ? ["--cached"]
              : input.comparison === "head"
                ? ["HEAD"]
                : []),
            "--",
            relativePath,
          ];
    const result = yield* executeGit("GitVcsDriver.getWorkingTreeDiff", root, args, {
      allowNonZeroExit: true,
      maxOutputBytes: MAX_WORKING_TREE_DIFF_BYTES,
      appendTruncationMarker: true,
    });
    if (result.exitCode !== 0 && !(isUntracked && result.exitCode === 1)) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.getWorkingTreeDiff",
          cwd: input.cwd,
          args,
        }),
        detail: "Git working-tree diff failed.",
        exitCode: result.exitCode,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    return truncateWorkingTreeDiff(result.stdout, result.stdoutTruncated);
  });

  const commitIndex: GitVcsDriver.GitVcsDriver["Service"]["commitIndex"] = Effect.fn("commitIndex")(
    function* (input) {
      const state = yield* readMutationState(input.cwd);
      const amend = input.amend === true;
      const message = input.message.trim();
      if (!amend && message.length === 0) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.commitIndex.message",
            cwd: input.cwd,
            args: ["commit"],
          }),
          detail: "A plain commit requires a non-empty message.",
        });
      }
      if (amend && state.headCommit === null) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.commitIndex.amend",
            cwd: input.cwd,
            args: ["commit", "--amend"],
          }),
          detail: "Cannot amend because this repository has no previous commit.",
        });
      }
      if (input.precondition !== undefined) {
        const expected = input.precondition;
        if (
          expected.expectedRefName === undefined ||
          expected.expectedRefName === null ||
          state.refName !== expected.expectedRefName ||
          state.headCommit !== expected.expectedHeadCommit ||
          state.indexTree !== expected.expectedIndexTree ||
          (expected.expectedMergeHeads !== undefined &&
            expected.expectedMergeHeads.join("\0") !== state.mergeHeads.join("\0"))
        ) {
          return yield* mutationRejection(
            "GitVcsDriver.commitIndex.precondition",
            input.cwd,
            "stale_git_state",
            "Repository state changed after the staged changes were reviewed.",
          );
        }
        if (expected.expectedMergeHeads === undefined && state.mergeHeads.length > 0) {
          return yield* mutationRejection(
            "GitVcsDriver.commitIndex.mergePrecondition",
            input.cwd,
            "stale_git_state",
            "Pending merge state was not reviewed by this client.",
          );
        }
        const [hasCherryPick, hasRevert] = yield* Effect.all([
          hasGitOperationState(input.cwd, "CHERRY_PICK_HEAD"),
          hasGitOperationState(input.cwd, "REVERT_HEAD"),
        ]);
        if (hasCherryPick || hasRevert) {
          return yield* new GitCommandError({
            ...gitCommandContext({
              operation: "GitVcsDriver.commitIndex.operation",
              cwd: input.cwd,
              args: [],
            }),
            detail: `Guarded commits cannot finish an active ${hasCherryPick ? "cherry-pick" : "revert"}. Continue or abort it with Git.`,
          });
        }
      }
      if (amend && input.confirmDefaultRef !== true) {
        return yield* mutationRejection(
          "GitVcsDriver.commitIndex.defaultRef",
          input.cwd,
          "default_ref_confirmation_required",
          "Committing on the default ref requires confirmation.",
        );
      }

      // Older clients lack a reviewed-state precondition. Preserve Git's
      // native commit behavior (including hooks) for that compatibility path.
      if (input.precondition === undefined) {
        yield* runGit(
          "GitVcsDriver.commitIndex",
          input.cwd,
          amend
            ? ["commit", "--amend", ...(message.length > 0 ? ["-m", message] : ["--no-edit"])]
            : ["commit", "-m", message],
        );
        const commitSha = yield* runGitStdout("GitVcsDriver.commitIndex.head", input.cwd, [
          "rev-parse",
          "HEAD",
        ]);
        return { commitSha: commitSha.trim() };
      }

      const hooks = yield* guardedCommitHookNames(input.cwd);
      if (hooks.length > 0) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.commitIndex.hooks",
            cwd: input.cwd,
            args: ["commit-tree"],
          }),
          detail: `Guarded commits cannot run configured Git hooks (${hooks.join(", ")}). Disable those hooks or use the regular Git commit flow.`,
        });
      }

      const fullRefName = yield* runGitStdout(
        "GitVcsDriver.commitIndex.currentRef",
        input.cwd,
        ["symbolic-ref", "-q", "HEAD"],
        true,
      ).pipe(Effect.map((value) => value.trim()));
      if (state.refName === null || fullRefName !== `refs/heads/${state.refName}`) {
        return yield* mutationRejection(
          "GitVcsDriver.commitIndex.currentRef",
          input.cwd,
          "stale_git_state",
          "Guarded commits require the reviewed local branch to remain checked out.",
        );
      }

      if (amend) {
        yield* runGit("GitVcsDriver.commitIndex.amend", input.cwd, [
          "commit",
          "--amend",
          ...(message.length > 0 ? ["-m", message] : ["--no-edit"]),
        ]);
        const commitSha = yield* runGitStdout("GitVcsDriver.commitIndex.head", input.cwd, [
          "rev-parse",
          "HEAD",
        ]);
        return { commitSha: commitSha.trim() };
      }

      const headTree =
        state.headCommit === null
          ? yield* executeGit(
              "GitVcsDriver.commitIndex.emptyTree",
              input.cwd,
              ["hash-object", "-t", "tree", "--stdin"],
              { stdin: "" },
            ).pipe(Effect.map((result) => result.stdout.trim()))
          : yield* runGitStdout("GitVcsDriver.commitIndex.headTree", input.cwd, [
              "rev-parse",
              `${state.headCommit}^{tree}`,
            ]).pipe(Effect.map((value) => value.trim()));
      if (headTree === state.indexTree && state.mergeHeads.length === 0) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.commitIndex.empty",
            cwd: input.cwd,
            args: ["commit-tree"],
          }),
          detail: "There is nothing staged to commit.",
        });
      }

      const commitTreeArgs = [
        "commit-tree",
        state.indexTree,
        ...(state.headCommit === null ? [] : ["-p", state.headCommit]),
        ...state.mergeHeads.flatMap((mergeHead) => ["-p", mergeHead]),
        ...(yield* guardedCommitSigningArgs(input.cwd)),
        "-m",
        message,
      ];
      const commitSha = yield* runGitStdout(
        "GitVcsDriver.commitIndex.commitTree",
        input.cwd,
        commitTreeArgs,
      ).pipe(Effect.map((value) => value.trim()));
      if (commitSha.length === 0) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.commitIndex.commitTree",
            cwd: input.cwd,
            args: commitTreeArgs,
          }),
          detail: "git commit-tree returned an empty commit oid.",
        });
      }

      const beforePublication = yield* readMutationState(input.cwd);
      if (
        beforePublication.refName !== state.refName ||
        beforePublication.headCommit !== state.headCommit ||
        beforePublication.indexTree !== state.indexTree ||
        !mergeHeadsEqual(beforePublication.mergeHeads, state.mergeHeads) ||
        (yield* hasGitOperationState(input.cwd, "CHERRY_PICK_HEAD")) ||
        (yield* hasGitOperationState(input.cwd, "REVERT_HEAD"))
      ) {
        return yield* mutationRejection(
          "GitVcsDriver.commitIndex.publicationPrecondition",
          input.cwd,
          "stale_git_state",
          "Repository state changed while creating the reviewed commit.",
        );
      }

      const oldCommit = state.headCommit ?? "0".repeat(state.indexTree.length);
      const transaction = [
        "start",
        `update ${fullRefName} ${commitSha} ${oldCommit}`,
        "prepare",
        "commit",
        "",
      ].join("\n");
      const updateResult = yield* executeGit(
        "GitVcsDriver.commitIndex.updateRef",
        input.cwd,
        ["update-ref", "--stdin"],
        { stdin: transaction, allowNonZeroExit: true },
      );
      if (updateResult.exitCode !== 0) {
        return yield* mutationRejection(
          "GitVcsDriver.commitIndex.updateRef",
          input.cwd,
          "stale_git_state",
          "Repository state changed while publishing the reviewed commit.",
        );
      }

      const afterPublication = yield* readMutationState(input.cwd);
      if (afterPublication.refName !== state.refName || afterPublication.headCommit !== commitSha) {
        // Never overwrite an external winner: rollback only if our commit is
        // still the branch tip, then surface the partial-publication race.
        yield* executeGit(
          "GitVcsDriver.commitIndex.rollbackRef",
          input.cwd,
          ["update-ref", fullRefName, oldCommit, commitSha],
          { allowNonZeroExit: true },
        ).pipe(Effect.asVoid);
        return yield* mutationRejection(
          "GitVcsDriver.commitIndex.publicationPostcondition",
          input.cwd,
          "stale_git_state",
          "The checked-out branch changed while publishing the reviewed commit.",
        );
      }

      // Unlike `git commit`, commit-tree does not clear MERGE_HEAD. Only
      // remove that state after proving the reviewed merge is still the one
      // we published; a changed merge state remains recoverable for Git.
      if (state.mergeHeads.length > 0) {
        const beforeMergeCleanup = yield* readMutationState(input.cwd);
        if (!mergeHeadsEqual(beforeMergeCleanup.mergeHeads, state.mergeHeads)) {
          return yield* new GitCommandError({
            ...gitCommandContext({
              operation: "GitVcsDriver.commitIndex.mergeCleanup",
              cwd: input.cwd,
              args: ["merge", "--quit"],
            }),
            detail: `Guarded commit ${commitSha} was published, but the reviewed merge state changed before cleanup.`,
          });
        }
        const quitResult = yield* executeGit(
          "GitVcsDriver.commitIndex.mergeQuit",
          input.cwd,
          ["merge", "--quit"],
          { allowNonZeroExit: true },
        );
        if (quitResult.exitCode !== 0) {
          return yield* new GitCommandError({
            ...gitCommandContext({
              operation: "GitVcsDriver.commitIndex.mergeQuit",
              cwd: input.cwd,
              args: ["merge", "--quit"],
            }),
            detail: `Guarded commit ${commitSha} was published, but merge cleanup failed.`,
            ...(quitResult.exitCode === null ? {} : { exitCode: quitResult.exitCode }),
            stdoutLength: quitResult.stdout.length,
            stderrLength: quitResult.stderr.length,
          });
        }
        const afterMergeCleanup = yield* readMutationState(input.cwd);
        if (afterMergeCleanup.mergeHeads.length > 0) {
          return yield* new GitCommandError({
            ...gitCommandContext({
              operation: "GitVcsDriver.commitIndex.mergeCleanup",
              cwd: input.cwd,
              args: ["merge", "--quit"],
            }),
            detail: `Guarded commit ${commitSha} was published, but MERGE_HEAD cleanup could not be verified.`,
          });
        }
      }

      return { commitSha };
    },
  );

  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      yield* guardDirtyWorkingTree("GitVcsDriver.switchRef", input);
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* guardDirtyWorkingTree("GitVcsDriver.switchRef.final", input);
      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
    function* (input) {
      if (input.switchRef) yield* guardDirtyWorkingTree("GitVcsDriver.createRef", input);
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
    cwd,
  ) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) => {
        const branchNames: Array<string> = [];
        for (const line of stdout.split("\n")) {
          const branchName = line.trim();
          if (branchName.length > 0) {
            branchNames.push(branchName);
          }
        }
        return branchNames;
      }),
    );

  const discoverRepositories: GitVcsDriver.GitVcsDriver["Service"]["discoverRepositories"] =
    Effect.fn("GitVcsDriver.discoverRepositories")(function* (input) {
      const maxRepositories = Math.max(1, input.maxRepositories ?? 64);
      const resolved = yield* resolveRepositoryPaths(input.cwd);
      const projectRoot = resolved?.worktreeRoot ?? path.resolve(input.cwd);
      const found = new Map<string, GitRepositoryDescriptor>();
      const queue: string[] = [projectRoot];
      let truncated = false;
      let scannedDirectories = 0;
      let examinedEntries = 0;
      let gitProbes = 0;
      const maxScannedDirectories = 4_096;
      const maxExaminedEntries = 8_192;
      const maxGitProbes = 4_096;
      const submoduleRoots = new Set<string>();
      const gitVersion = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.discoverRepositories.version",
        projectRoot,
        ["--version"],
        { allowNonZeroExit: true },
      ).pipe(Effect.orElseSucceed(() => null));
      const supportsStashStaged =
        gitVersion?.exitCode === 0 && supportsStashStagedFromGitVersion(gitVersion.stdout);
      const skippedDirectoryNames = new Set([
        ".git",
        ".t3",
        ".turbo",
        ".next",
        "build",
        "dist",
        "node_modules",
        "target",
        "vendor",
      ]);

      const addRepository = (repository: GitRepositoryPaths, isSubmodule: boolean) => {
        if (!repository.worktreeRoot) return;
        const existing = found.get(repository.worktreeRoot);
        if (existing && existing.unavailableReason === undefined) return;
        if (!existing && found.size >= maxRepositories) {
          truncated = true;
          return;
        }
        found.set(repository.worktreeRoot, {
          rootPath: repository.worktreeRoot,
          worktreePath: repository.worktreeRoot,
          commonDir: repository.gitCommonDir,
          isSubmodule,
          provider: null,
          capabilities: {
            actions: [
              "commit",
              "amend",
              "fetch",
              "pull",
              "push",
              "sync",
              "publish",
              "branch",
              "remote",
              "stash",
              "tag",
              "merge",
              "rebase",
              "cherry-pick",
              "revert",
              "reset",
              "discard",
              "conflict",
            ],
            supportsIndexWorkflow: true,
            supportsStashStaged,
          },
        });
      };

      const addUnavailableSubmodule = (submoduleRoot: string) => {
        submoduleRoots.add(submoduleRoot);
        if (found.has(submoduleRoot)) return;
        if (found.size >= maxRepositories) {
          truncated = true;
          return;
        }
        found.set(submoduleRoot, {
          rootPath: submoduleRoot,
          worktreePath: submoduleRoot,
          commonDir: path.join(submoduleRoot, ".git"),
          isSubmodule: true,
          provider: null,
          capabilities: { actions: [], supportsIndexWorkflow: false, supportsStashStaged: false },
          unavailableReason: "Submodule is unavailable or has not been initialized.",
        });
      };

      const readConfiguredSubmodules = (repositoryRoot: string) =>
        Effect.gen(function* () {
          if (gitProbes >= maxGitProbes) {
            truncated = true;
            return;
          }
          gitProbes += 1;
          // The .gitmodules file remains authoritative when a declared gitlink
          // has not been checked out. Reading it for every initialized module
          // is what makes nested submodules discoverable without initialization.
          const configuredSubmodules = yield* executeGitWithStableDiagnostics(
            "GitVcsDriver.discoverRepositories.configuredSubmodules",
            repositoryRoot,
            [
              "config",
              "--file",
              path.join(repositoryRoot, ".gitmodules"),
              "--get-regexp",
              "^submodule\\..*\\.path$",
            ],
            { allowNonZeroExit: true },
          ).pipe(Effect.orElseSucceed(() => null));
          if (configuredSubmodules?.exitCode !== 0) return;
          for (const line of configuredSubmodules.stdout.split("\n")) {
            const relativePath = line.trim().split(/\s+/).slice(1).join(" ");
            if (relativePath) addUnavailableSubmodule(path.resolve(repositoryRoot, relativePath));
          }
        });

      if (resolved) addRepository(resolved, false);
      if (resolved) yield* readConfiguredSubmodules(projectRoot);

      // Probe declared paths directly. They can live under an ignored or
      // dot-prefixed parent, so regular directory walking is not sufficient.
      // Only retained descriptors are probed after the result cap is reached;
      // a placeholder must still be allowed to become an available repository.
      let nextSubmoduleRoot = 0;
      while (nextSubmoduleRoot < submoduleRoots.size && gitProbes < maxGitProbes) {
        const submoduleRoot = [...submoduleRoots][nextSubmoduleRoot++];
        if (submoduleRoot === undefined) break;
        if (!found.has(submoduleRoot)) continue;
        gitProbes += 1;
        const candidateRepository = yield* resolveRepositoryPaths(submoduleRoot).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (candidateRepository?.worktreeRoot === submoduleRoot) {
          addRepository(candidateRepository, true);
          yield* readConfiguredSubmodules(submoduleRoot);
        }
      }
      if (nextSubmoduleRoot < submoduleRoots.size) truncated = true;

      // A descriptor cap means no ordinary nested repository can be retained.
      // Declared submodules above were already probed directly, so continuing
      // to walk directories would only spend unbounded work on discarded data.
      if (found.size >= maxRepositories) truncated = true;

      while (queue.length > 0 && found.size < maxRepositories) {
        if (examinedEntries >= maxExaminedEntries || gitProbes >= maxGitProbes) {
          truncated = true;
          break;
        }
        scannedDirectories += 1;
        if (scannedDirectories > maxScannedDirectories) {
          truncated = true;
          break;
        }
        const directory = queue.shift()!;
        const enumerated = yield* readDirectoryEntriesBounded(
          directory,
          maxExaminedEntries - examinedEntries,
        ).pipe(
          Effect.orElseSucceed(() => ({ entries: [] as ReadonlyArray<string>, truncated: false })),
        );
        const entries = enumerated.entries;
        if (enumerated.truncated) truncated = true;
        for (const entry of entries) {
          if (examinedEntries >= maxExaminedEntries || gitProbes >= maxGitProbes) {
            truncated = true;
            break;
          }
          examinedEntries += 1;
          const candidate = path.join(directory, entry);
          const containsConfiguredSubmodule = [...submoduleRoots].some(
            (root) => root === candidate || root.startsWith(`${candidate}${path.sep}`),
          );
          if (
            (skippedDirectoryNames.has(entry) && !containsConfiguredSubmodule) ||
            (entry.startsWith(".") && !containsConfiguredSubmodule)
          )
            continue;
          // Most directory entries are files. Stat before asking Git whether a
          // path is ignored so a wide source directory cannot spawn one Git
          // process per file.
          const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
          if (Option.isNone(info) || info.value.type !== "Directory") continue;
          gitProbes += 1;
          const ignored = yield* executeGitWithStableDiagnostics(
            "GitVcsDriver.discoverRepositories.checkIgnore",
            projectRoot,
            ["check-ignore", "-q", "--", candidate],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.orElseSucceed(() => false),
          );
          if (ignored && !containsConfiguredSubmodule) continue;
          if (gitProbes >= maxGitProbes) {
            truncated = true;
            break;
          }
          gitProbes += 1;
          const candidateRepository = yield* resolveRepositoryPaths(candidate);
          if (candidateRepository?.worktreeRoot === candidate) {
            addRepository(candidateRepository, submoduleRoots.has(candidate));
            yield* readConfiguredSubmodules(candidate);
            queue.push(candidate);
            continue;
          }
          queue.push(candidate);
        }
      }

      if (queue.length > 0 && found.size >= maxRepositories) truncated = true;

      return {
        projectRoot,
        repositories: [...found.values()].toSorted((left, right) =>
          left.rootPath.localeCompare(right.rootPath),
        ),
        truncated,
      } satisfies GitRepositoryDiscoveryResult;
    });

  const commitGraphPage: GitVcsDriver.GitVcsDriver["Service"]["commitGraphPage"] = Effect.fn(
    "GitVcsDriver.commitGraphPage",
  )(function* (input) {
    const cursor = input.cursor;
    const offset = typeof cursor === "number" ? cursor : (cursor?.offset ?? 0);
    const carriedLanes = typeof cursor === "object" && cursor !== null ? cursor.lanes : null;
    const limit = Math.min(input.limit ?? 50, 200);
    // A carried cursor lets Git skip the prefix entirely. Numeric cursors are
    // retained for compatibility, and reconstruct their lane state below.
    const fetchCount = carriedLanes === null ? offset + limit + 1 : limit + 1;
    const result = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.commitGraphPage",
      input.cwd,
      [
        "log",
        "--exclude=refs/t3/checkpoints/*",
        "--all",
        "--decorate=full",
        "--date-order",
        "--diff-merges=first-parent",
        "--shortstat",
        ...(carriedLanes === null || offset === 0 ? [] : [`--skip=${offset}`]),
        `--max-count=${fetchCount}`,
        "--pretty=format:%x1e%H%x00%P%x00%at%x00%an%x00%ae%x00%s%x00%B%x00%D",
      ],
      { timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 },
    );
    const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));
    const upstreamRef = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.commitGraphPage.upstream",
      input.cwd,
      ["rev-parse", "--symbolic-full-name", "@{upstream}"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((upstream) => (upstream.exitCode === 0 ? upstream.stdout.trim() : undefined)),
    );
    const parsedCommits = parseCommitGraphLog(
      result.stdout,
      new Set(remoteNames),
      upstreamRef ? { upstreamRef } : {},
    );
    const prefix = carriedLanes === null ? applyCommitGraphTopology(parsedCommits) : null;
    const pageCommits =
      carriedLanes === null
        ? prefix!.commits.slice(offset, offset + limit)
        : parsedCommits.slice(0, limit);
    const topology =
      carriedLanes === null
        ? applyCommitGraphTopology(prefix!.commits.slice(0, offset + limit))
        : applyCommitGraphTopology(pageCommits, carriedLanes);
    const hasMore = parsedCommits.length > (carriedLanes === null ? offset + limit : limit);
    const commits = carriedLanes === null ? topology.commits.slice(offset) : topology.commits;
    return {
      commits,
      nextCursor: hasMore ? { offset: offset + commits.length, lanes: topology.lanes } : null,
      hasMore,
    } satisfies GitCommitGraphPageResult;
  });

  const commitFiles: GitVcsDriver.GitVcsDriver["Service"]["commitFiles"] = Effect.fn(
    "GitVcsDriver.commitFiles",
  )(function* (input) {
    const output = yield* runGitStdout("GitVcsDriver.commitFiles", input.cwd, [
      "diff-tree",
      ...(input.parentSha ? [] : ["--root"]),
      "--no-commit-id",
      "--name-status",
      "-z",
      "-r",
      "-M",
      "--format=",
      ...(input.parentSha ? [input.parentSha, input.commitSha] : [input.commitSha]),
    ]);
    const fields = output.split("\0").filter(Boolean);
    const files: Array<GitCommitFilesResult["files"][number]> = [];
    for (let index = 0; index < fields.length;) {
      const statusField = fields[index++];
      if (!statusField) continue;
      const statusCode = statusField[0];
      const status =
        statusCode === "A"
          ? "added"
          : statusCode === "D"
            ? "deleted"
            : statusCode === "R"
              ? "renamed"
              : statusCode === "C"
                ? "copied"
                : "modified";
      if (status === "renamed" || status === "copied") {
        const oldPath = fields[index++];
        const newPath = fields[index++];
        if (oldPath && newPath) files.push({ oldPath, newPath, status });
      } else {
        const filePath = fields[index++];
        if (filePath) {
          files.push({
            oldPath: status === "added" ? null : filePath,
            newPath: status === "deleted" ? null : filePath,
            status,
          });
        }
      }
    }
    return { commitSha: input.commitSha, files } satisfies GitCommitFilesResult;
  });

  const compareRepositoryFile: GitVcsDriver.GitVcsDriver["Service"]["compareRepositoryFile"] =
    Effect.fn("GitVcsDriver.compareRepositoryFile")(function* (input) {
      const repository = yield* resolveRepositoryPaths(input.cwd);
      if (!repository?.worktreeRoot) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.compareRepositoryFile",
            cwd: input.cwd,
            args: [],
          }),
          detail: "File comparisons require a Git worktree.",
        });
      }
      const root = repository.worktreeRoot;
      // The descriptor, when supplied, is the tab's authority.  Do not infer
      // its repository, paths, or revisions from the currently selected UI
      // route: an old tab must keep comparing the thing it was opened for.
      const requested = input.descriptor;
      const comparison =
        requested?.kind === "pull-request" && input.commitSha !== undefined
          ? "commit"
          : requested?.kind === "pull-request"
            ? "branch"
            : requested?.kind === "turn" || requested?.kind === "checkpoint"
              ? "commit"
              : (requested?.kind ?? input.comparison);
      // A descriptor has complete path-side identity. In particular `null`
      // means an added/deleted side and must not fall back to a legacy input.
      const oldPath = requested ? requested.oldPath : input.oldPath;
      const newPath = requested ? requested.newPath : input.newPath;
      type RevisionContents = {
        readonly contents: string;
        readonly binary: boolean;
        readonly available: boolean;
      };
      const readRevision = (
        revision: string,
        filePath: string | null,
      ): Effect.Effect<RevisionContents, never> =>
        filePath === null
          ? Effect.succeed({ contents: "", binary: false, available: true })
          : executeGit(
              "GitVcsDriver.compareRepositoryFile.revision",
              root,
              ["show", `${revision}:${filePath}`],
              { allowNonZeroExit: true, maxOutputBytes: 8 * 1024 * 1024 },
            ).pipe(
              Effect.map((result) => ({
                contents: result.exitCode === 0 ? result.stdout : "",
                binary: result.exitCode === 0 && result.stdout.includes("\0"),
                available: result.exitCode === 0,
              })),
              Effect.orElseSucceed(() => ({ contents: "", binary: false, available: false })),
            );
      const readWorkingTree = (filePath: string | null): Effect.Effect<RevisionContents, never> =>
        filePath === null
          ? Effect.succeed({ contents: "", binary: false, available: true })
          : fileSystem.readFile(path.resolve(root, filePath)).pipe(
              Effect.map((bytes) => ({
                contents: new TextDecoder().decode(bytes),
                binary: bytes.includes(0),
                available: true,
              })),
              Effect.orElseSucceed(() => ({ contents: "", binary: false, available: false })),
            );
      const resolveRevision = (reference: string | null | undefined) =>
        reference
          ? executeGit(
              "GitVcsDriver.compareRepositoryFile.resolveRevision",
              root,
              ["rev-parse", "--verify", `${reference}^{commit}`],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
              Effect.orElseSucceed(() => null),
            )
          : Effect.succeed(null);
      // GitHub's detail OIDs are authoritative even when this checkout has
      // never fetched a fork.  Fetching the PR head is deliberately limited
      // to that one advertised ref (and lands in FETCH_HEAD), rather than
      // updating a branch or using a date/local-ref heuristic.
      const pullRequestNumber =
        requested?.kind === "pull-request"
          ? Number.parseInt(requested.pullRequestId?.match(/#(\d+)$/u)?.[1] ?? "", 10)
          : Number.NaN;
      const pullRequestTarget = requested?.pullRequestId?.match(/^([^:]*):(.+)#\d+$/u);
      const pullRequestRemote =
        pullRequestTarget === null || pullRequestTarget === undefined
          ? resolvePrimaryRemoteName(root)
          : executeGit(
              "GitVcsDriver.compareRepositoryFile.pullRequestRemote",
              root,
              ["remote", "-v"],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.flatMap((result) => {
                const targetHost = (pullRequestTarget[1] || "github.com").toLowerCase();
                const targetRepository = pullRequestTarget[2]!.toLowerCase();
                const remotes = parseRemoteFetchUrls(result.stdout);
                const matched = [...remotes].find(([, remoteUrl]) => {
                  const ssh = /^[^@/:]+@([^:]+):(.+)$/u.exec(remoteUrl);
                  const parsed =
                    ssh === null
                      ? (() => {
                          try {
                            return new URL(remoteUrl);
                          } catch {
                            return null;
                          }
                        })()
                      : null;
                  const host = (ssh?.[1] ?? parsed?.hostname ?? "").toLowerCase();
                  const repository = (ssh?.[2] ?? parsed?.pathname ?? "")
                    .replace(/^\/+|\.git$/gu, "")
                    .toLowerCase();
                  return host === targetHost && repository === targetRepository;
                })?.[0];
                // A PR descriptor is host/repository scoped. Falling back to
                // origin here can fetch an unrelated fork and make a pinned
                // tab silently read the wrong repository.
                // A lone remote is the checkout's only possible PR authority
                // (and keeps local/file-remote integrations usable). With
                // several remotes, require an identity match rather than
                // accidentally selecting a fork origin.
                return Effect.succeed(
                  matched ?? (remotes.size === 1 ? (remotes.keys().next().value ?? null) : null),
                );
              }),
            );
      const fetchPullRequestObjects = Number.isSafeInteger(pullRequestNumber)
        ? pullRequestRemote.pipe(
            Effect.flatMap((remoteName) =>
              remoteName === null
                ? Effect.void
                : executeGit(
                    "GitVcsDriver.compareRepositoryFile.fetchPullRequestObjects",
                    root,
                    [
                      "fetch",
                      "--quiet",
                      "--no-tags",
                      remoteName,
                      `refs/pull/${pullRequestNumber}/head`,
                      // The rendered aggregate can outlive a force-push. Ask for
                      // the actual immutable head as well as today's advertised
                      // PR ref, always into FETCH_HEAD and never a local branch.
                      ...(requested?.headRevision ? [requested.headRevision] : []),
                      // Git hosts advertise the base tip through the PR. Asking
                      // for that immutable object is still a FETCH_HEAD-only
                      // read; when a host rejects unadvertised SHA wants the
                      // advertised base branch below is the safe fallback.
                      ...(requested?.baseRevision ? [requested.baseRevision] : []),
                      ...(input.baseRef ? [`refs/heads/${input.baseRef}`] : []),
                    ],
                    { allowNonZeroExit: true },
                  ),
            ),
            Effect.asVoid,
            // Content reads remain non-mutating from the reader's point of
            // view: a host that cannot supply the object becomes the normal
            // actionable unavailable state below.
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.void;
      const ensureRevision = (reference: string | null | undefined) =>
        resolveRevision(reference).pipe(
          Effect.flatMap((resolved) =>
            resolved !== null || !Number.isSafeInteger(pullRequestNumber)
              ? Effect.succeed(resolved)
              : fetchPullRequestObjects.pipe(Effect.andThen(resolveRevision(reference))),
          ),
        );
      const resolveMergeBase = (base: string, head: string) =>
        executeGit(
          "GitVcsDriver.compareRepositoryFile.mergeBase",
          root,
          ["merge-base", base, head],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
          Effect.orElseSucceed(() => null),
        );
      let oldRevision: RevisionContents;
      let newRevision: RevisionContents;
      let resolvedBaseRevision: string | null = requested?.baseRevision ?? null;
      let resolvedHeadRevision: string | null = requested?.headRevision ?? null;
      if (comparison === "working-tree") {
        resolvedBaseRevision ??= yield* resolveRevision(input.baseRef ?? "HEAD");
        oldRevision = yield* readRevision(resolvedBaseRevision ?? "HEAD", oldPath);
        newRevision = yield* readWorkingTree(newPath);
      } else if (comparison === "index") {
        resolvedBaseRevision ??= yield* resolveRevision(input.baseRef ?? "HEAD");
        // An index snapshot is a tree object, not a commit, so `^{commit}`
        // would discard an otherwise valid pinned index tree.
        resolvedHeadRevision ??= input.indexTree ?? null;
        oldRevision = yield* readRevision(resolvedBaseRevision ?? "HEAD", oldPath);
        newRevision = resolvedHeadRevision
          ? yield* readRevision(resolvedHeadRevision, newPath)
          : { contents: "", binary: false, available: false };
      } else if (comparison === "branch") {
        resolvedHeadRevision = yield* ensureRevision(
          resolvedHeadRevision ?? input.headRef ?? "HEAD",
        );
        if (requested?.kind === "pull-request") {
          // A host detail's base OID is the base branch tip. The aggregate PR
          // patch is base *merge-base* -> head, so never compare that tip
          // directly when it has advanced independently.
          const baseTip = yield* ensureRevision(requested.baseRevision ?? input.baseRef);
          resolvedBaseRevision =
            baseTip && resolvedHeadRevision
              ? yield* resolveMergeBase(baseTip, resolvedHeadRevision)
              : null;
        } else {
          resolvedBaseRevision ??= yield* ensureRevision(input.baseRef ?? "HEAD");
        }
        oldRevision = resolvedBaseRevision
          ? yield* readRevision(resolvedBaseRevision, oldPath)
          : { contents: "", binary: false, available: false };
        newRevision = resolvedHeadRevision
          ? yield* readRevision(resolvedHeadRevision, newPath)
          : { contents: "", binary: false, available: false };
      } else {
        const historicalReference = requested?.checkpointId ?? input.commitSha ?? "HEAD";
        resolvedHeadRevision = yield* ensureRevision(resolvedHeadRevision ?? historicalReference);
        // Checkpoints are tree commits created without Git parents. A turn
        // comparison therefore supplies its actual previous checkpoint as
        // `baseRef`; only ordinary commits fall back to their Git parent.
        // A descriptor's revision is the identity selected when the tab was
        // opened.  It must win over a parentless checkpoint's Git topology:
        // checkpoint commits are deliberately created without parents.
        const explicitBase = requested?.baseRevision ?? requested?.mergeParent ?? input.baseRef;
        const hasExplicitBase = explicitBase !== null && explicitBase !== undefined;
        if (hasExplicitBase) {
          resolvedBaseRevision = yield* ensureRevision(explicitBase);
        } else if (resolvedHeadRevision) {
          const parents = yield* executeGit(
            "GitVcsDriver.compareRepositoryFile.commitParents",
            root,
            // `show --format=%P` honours shallow boundaries and therefore
            // prints no parent for a non-root shallow commit. Read the raw
            // object instead so only an actual parentless commit gets an
            // intentional empty old side.
            ["cat-file", "-p", resolvedHeadRevision],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? result.stdout
                    .split("\n")
                    .flatMap((line) =>
                      line.startsWith("parent ") ? [line.slice("parent ".length)] : [],
                    )
                : null,
            ),
            Effect.orElseSucceed(() => null),
          );
          // A genuinely parentless commit is an empty old side. A commit
          // whose parent cannot be acquired is not a root commit and must be
          // surfaced as unavailable instead of inventing a misleading diff.
          resolvedBaseRevision = parents?.[0] ?? null;
          if (parents === null) {
            oldRevision = { contents: "", binary: false, available: false };
            newRevision = { contents: "", binary: false, available: false };
            const binary = oldRevision.binary || newRevision.binary;
            const available = false;
            return {
              repositoryRoot: root,
              comparison,
              oldPath,
              newPath,
              oldContents: oldRevision.contents,
              newContents: newRevision.contents,
              binary,
              available,
              unavailableReason: "The selected file revision is unavailable.",
              ...(requested
                ? {
                    descriptor: {
                      ...requested,
                      repositoryRoot: root,
                      oldPath,
                      newPath,
                      baseRevision: null,
                      headRevision: resolvedHeadRevision,
                    },
                  }
                : {}),
            } satisfies GitRepositoryComparisonResult;
          }
        } else {
          resolvedBaseRevision = null;
        }
        oldRevision = resolvedBaseRevision
          ? yield* readRevision(resolvedBaseRevision, oldPath)
          : {
              contents: "",
              binary: false,
              // An explicitly requested base which could not be resolved is
              // unavailable, not an all-added root comparison.
              available: resolvedHeadRevision !== null && !hasExplicitBase,
            };
        newRevision = resolvedHeadRevision
          ? yield* readRevision(resolvedHeadRevision, newPath)
          : { contents: "", binary: false, available: false };
      }
      const binary = oldRevision.binary || newRevision.binary;
      const available = oldRevision.available && newRevision.available && !binary;
      return {
        repositoryRoot: root,
        comparison,
        oldPath,
        newPath,
        oldContents: oldRevision.contents,
        newContents: newRevision.contents,
        binary,
        available,
        ...(!available
          ? {
              unavailableReason: binary
                ? "Binary files cannot be rendered as text."
                : "The selected file revision is unavailable.",
            }
          : {}),
        ...(requested
          ? {
              descriptor: {
                ...requested,
                repositoryRoot: root,
                kind: requested.kind,
                oldPath,
                newPath,
                baseRevision: resolvedBaseRevision,
                headRevision: resolvedHeadRevision,
              },
            }
          : {}),
      } satisfies GitRepositoryComparisonResult;
    });

  const withListRefsInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.ensuring(
        Effect.all([
          invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
          invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
        ]),
      ),
    );
  const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
    input,
  ) =>
    initRepo(input).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
          yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
          yield* Cache.invalidate(repositoryPathsCache, cacheKey);
          yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
        }),
      ),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    discoverRepositories,
    commitGraphPage,
    commitFiles,
    compareRepositoryFile,
    stageFiles,
    unstageFiles,
    getWorkingTreeDiff,
    prepareCommitContext,
    commit: (cwd, subject, body, options) =>
      withListRefsInvalidation(cwd, commit(cwd, subject, body, options)),
    commitIndex: (input) => withListRefsInvalidation(input.cwd, commitIndex(input)),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options)),
    pullCurrentBranch: (cwd, strategy) =>
      withListRefsInvalidation(cwd, pullCurrentBranch(cwd, strategy)),
    readRangeContext,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    readConfigValue,
    listRefs,
    createWorktree: (input, options) =>
      withListRefsInvalidation(input.cwd, createWorktree(input, options)),
    fetchPullRequestBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchPullRequestBranch(input)),
    fetchPullRequestHeadCommit,
    resolveCommit,
    refreshCheckedOutBranch: (input) =>
      withListRefsInvalidation(input.cwd, refreshCheckedOutBranch(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    resolvePublicationTarget,
    resolveDefaultBranchName,
    fetchRemote: (input) => withListRefsInvalidation(input.cwd, fetchRemote(input)),
    remoteExists,
    remoteBranchExists,
    resolveRemoteTrackingCommit,
    fetchRemoteBranch: (input) => withListRefsInvalidation(input.cwd, fetchRemoteBranch(input)),
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    setBranchUpstream: (input) => withListRefsInvalidation(input.cwd, setBranchUpstream(input)),
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    pruneWorktrees: (input) => withListRefsInvalidation(input.cwd, pruneWorktrees(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    initRepo: initRepoWithListRefsInvalidation,
    listLocalBranchNames,
  });
});
