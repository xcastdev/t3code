// @effect-diagnostics-next-line nodeBuiltinImport:off -- Incremental hashing bounds memory while reviewing many changed files; Effect Crypto only hashes complete buffers.
import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  GitCommandError,
  type GitIndexFingerprint,
  type GitIndexStatusInput,
  type GitIndexStatusResult,
  type GitMutateIndexInput,
  type GitCommitStagedInput,
  type GitCommitStagedResult,
  type GitDiscoverRepositoriesInput,
  type GitDiscoverRepositoriesResult,
  type GitHistoryInput,
  type GitHistoryResult,
  type GitHistoryDiffInput,
  type GitHistoryDiffResult,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 2_000;
const MAX_REPOSITORIES = 100;
const MAX_DEPTH = 6;
const OMIT_DIRECTORIES = new Set([".git", "node_modules", ".t3", "dist", "build", ".cache"]);
const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const failure = (cwd: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "GitIndexOperations",
    command: "git",
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** Built inside GitWorkflowService so all Git workflows use the same driver and checkout lease. */
export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const nodePath = yield* Path.Path;
  const inside = (root: string, path: string) => {
    const relative = nodePath.relative(root, path);
    return (
      relative === "" ||
      (!relative.startsWith(`..${nodePath.sep}`) &&
        relative !== ".." &&
        !nodePath.isAbsolute(relative))
    );
  };
  const run = Effect.fn("GitIndexOperations.execute")(function* (
    cwd: string,
    args: readonly string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      stdin?: string;
      allowNonZeroExit?: boolean;
      maxOutputBytes?: number;
      allowTruncated?: boolean;
    },
  ) {
    const result = yield* git.execute({
      operation: "GitIndexOperations",
      cwd,
      args,
      maxOutputBytes: 4 * 1024 * 1024,
      ...options,
    });
    if (result.stdoutTruncated && !options?.allowTruncated)
      return yield* failure(cwd, "Repository output exceeds the review limit.");
    return result;
  });
  const rootFor = Effect.fn("GitIndexOperations.root")(function* (cwd: string) {
    const root = (yield* run(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    return yield* fs
      .realPath(root)
      .pipe(Effect.mapError((cause) => failure(cwd, "Cannot resolve repository root.", cause)));
  });
  const indexPathFor = Effect.fn("GitIndexOperations.indexPath")(function* (cwd: string) {
    const path = (yield* run(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])).stdout.trim();
    return path;
  });
  const headFor = Effect.fn("GitIndexOperations.head")(function* (cwd: string) {
    const result = yield* run(cwd, ["rev-parse", "--verify", "HEAD"], { allowNonZeroExit: true });
    if (result.exitCode === 0) return result.stdout.trim();
    // Only an unborn symbolic branch has no HEAD; an invalid detached HEAD is an error.
    const symbolic = yield* run(cwd, ["symbolic-ref", "-q", "HEAD"], { allowNonZeroExit: true });
    if (symbolic.exitCode !== 0) return yield* failure(cwd, "Cannot resolve HEAD.");
    return null;
  });
  const indexDigest = Effect.fn("GitIndexOperations.indexFingerprint")(function* (cwd: string) {
    const path = yield* indexPathFor(cwd);
    if (!(yield* fs.exists(path))) return digest("missing-index");
    const stat = yield* fs.stat(path);
    if (Number(stat.size) > MAX_TOTAL_BYTES)
      return yield* failure(cwd, "Repository index exceeds the review limit.");
    return digest(yield* fs.readFile(path));
  });
  const statusAtRoot = Effect.fn("GitIndexOperations.statusAtRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<
    GitIndexStatusResult,
    GitCommandError | import("effect/PlatformError").PlatformError
  > {
    const headCommit = yield* headFor(cwd);
    const symbolic = yield* run(cwd, ["symbolic-ref", "-q", "HEAD"], { allowNonZeroExit: true });
    const headRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    const index = yield* indexDigest(cwd);
    const status = yield* run(
      cwd,
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ],
      { env: { GIT_OPTIONAL_LOCKS: "0" } },
    );
    const entries = status.stdout.split("\0").filter(Boolean);
    if (entries.length > MAX_FILES)
      return yield* failure(cwd, "Repository changes exceed the review limit.");
    const staged: Array<{ path: string; status: string }> = [];
    const unstaged: Array<{ path: string; status: string }> = [];
    const hash = NodeCrypto.createHash("sha256").update(status.stdout);
    let bytes = 0;
    for (const entry of entries) {
      const x = entry[0]!;
      const y = entry[1]!;
      const path = entry.slice(3);
      if (x !== " " && x !== "?") staged.push({ path, status: x });
      if (y !== " " || x === "?") unstaged.push({ path, status: x === "?" ? "?" : y });
      const absolute = nodePath.resolve(cwd, path);
      if (!inside(cwd, absolute))
        return yield* failure(cwd, "Changed file is outside the repository.");
      const link = yield* fs.readLink(absolute).pipe(Effect.option);
      if (link._tag === "Some") {
        hash.update(path).update("\0link\0").update(digest(link.value));
        continue;
      }
      if (!(yield* fs.exists(absolute))) continue;
      const real = yield* fs.realPath(absolute);
      if (!inside(cwd, real))
        return yield* failure(cwd, "Changed file resolves outside the repository.");
      const stat = yield* fs.stat(absolute);
      if (stat.type === "Directory") continue; // Submodule contents are never added by staging their gitlink.
      bytes += Number(stat.size);
      if (Number(stat.size) > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES)
        return yield* failure(cwd, "Changed files exceed the review size limit.");
      hash
        .update(path)
        .update(`\0${stat.mode}\0`)
        .update(digest(yield* fs.readFile(absolute)));
    }
    const finalSymbolic = yield* run(cwd, ["symbolic-ref", "-q", "HEAD"], {
      allowNonZeroExit: true,
    });
    const finalHeadRef = finalSymbolic.exitCode === 0 ? finalSymbolic.stdout.trim() : null;
    if (
      finalHeadRef !== headRef ||
      (yield* headFor(cwd)) !== headCommit ||
      (yield* indexDigest(cwd)) !== index
    ) {
      return yield* failure(cwd, "Repository changed during review. Refresh and try again.");
    }
    return {
      fingerprint: { rootPath: cwd, headCommit, headRef, index, worktree: hash.digest("hex") },
      staged,
      unstaged,
    };
  });
  const guarded = Effect.fn("GitIndexOperations.checkReview")(function* (
    cwd: string,
    expected: GitIndexFingerprint,
  ) {
    const status = yield* statusAtRoot(cwd);
    if (
      Object.keys(status.fingerprint).some(
        (key) =>
          status.fingerprint[key as keyof GitIndexFingerprint] !==
          expected[key as keyof GitIndexFingerprint],
      )
    ) {
      return yield* failure(cwd, "Repository changed since review. Refresh and try again.");
    }
    return status;
  });
  const mapIo = <A, R>(
    cwd: string,
    effect: Effect.Effect<A, GitCommandError | import("effect/PlatformError").PlatformError, R>,
  ) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause._tag === "GitCommandError"
          ? cause
          : failure(cwd, "Repository filesystem operation failed.", cause),
      ),
    );
  const indexStatus = Effect.fn("GitIndexOperations.status")(function* (
    input: GitIndexStatusInput,
  ) {
    const root = yield* rootFor(input.cwd);
    return yield* mapIo(root, withWorkspaceLease(root, statusAtRoot(root)));
  });
  const withLockedIndex = Effect.fn("GitIndexOperations.lockIndex")(function* <A, E, R>(
    cwd: string,
    body: (
      indexPath: string,
      lockPath: string,
      install: Effect.Effect<void, import("effect/PlatformError").PlatformError>,
    ) => Effect.Effect<A, E, R>,
  ) {
    const indexPath = yield* indexPathFor(cwd);
    const lockPath = `${indexPath}.lock`;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs
          .open(lockPath, { flag: "wx" })
          .pipe(
            Effect.mapError((cause) =>
              failure(
                cwd,
                "Git's index is locked. Wait for other Git operations to finish, then try again.",
                cause,
              ),
            ),
          );
        let installed = false;
        yield* Effect.addFinalizer(() =>
          installed ? Effect.void : fs.remove(lockPath).pipe(Effect.ignore),
        );
        const install = Effect.uninterruptible(
          fs.rename(lockPath, indexPath).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                installed = true;
              }),
            ),
          ),
        );
        return yield* body(indexPath, lockPath, install);
      }),
    );
  });
  const validatePaths = Effect.fn("GitIndexOperations.validatePaths")(function* (
    cwd: string,
    paths: readonly string[],
  ) {
    if (paths.length === 0 || paths.length > 500)
      return yield* failure(cwd, "Select between 1 and 500 files.");
    for (const path of paths) {
      if (
        !path ||
        path.includes("\0") ||
        nodePath.isAbsolute(path) ||
        !inside(cwd, nodePath.resolve(cwd, path))
      )
        return yield* failure(cwd, "Invalid repository file path.");
      // A deleted file may not exist, but all surviving ancestors must stay within the checkout.
      let absolute = nodePath.resolve(cwd, path);
      // Git stores a symlink's target text; validating its parent avoids following that target.
      if ((yield* fs.readLink(absolute).pipe(Effect.option))._tag === "Some")
        absolute = nodePath.dirname(absolute);
      while (!(yield* fs.exists(absolute)) && absolute !== cwd)
        absolute = nodePath.dirname(absolute);
      const real = yield* fs.realPath(absolute);
      if (!inside(cwd, real))
        return yield* failure(cwd, "File path resolves outside the repository.");
    }
  });
  const mutateIndex = Effect.fn("GitIndexOperations.mutateIndex")(function* (
    input: GitMutateIndexInput,
  ) {
    const cwd = yield* rootFor(input.cwd);
    return yield* mapIo(
      cwd,
      withWorkspaceLease(
        cwd,
        withLockedIndex(cwd, (indexPath, lockPath, install) =>
          Effect.scoped(
            Effect.gen(function* () {
              const status = yield* guarded(cwd, input.expected);
              yield* validatePaths(cwd, input.paths);
              const allowed = new Set(
                (input.action === "stage" ? status.unstaged : status.staged).map(
                  (file) => file.path,
                ),
              );
              if (input.paths.some((path) => !allowed.has(path)))
                return yield* failure(cwd, "Select changed files from the current review.");
              const temp = yield* fs.makeTempDirectoryScoped({
                directory: nodePath.dirname(indexPath),
                prefix: "t3-index-",
              });
              const temporaryIndex = nodePath.join(temp, "index");
              const originalIndex = (yield* fs.exists(indexPath))
                ? yield* fs.stat(indexPath)
                : null;
              if (originalIndex !== null) {
                yield* fs.copyFile(indexPath, temporaryIndex);
                // Git compares entry mtimes to the index mtime to detect same-size racy edits.
                // copyFile gives the copy a newer timestamp and can make those edits look clean.
                if (originalIndex.mtime._tag === "Some")
                  yield* fs.utimes(
                    temporaryIndex,
                    originalIndex.mtime.value,
                    originalIndex.mtime.value,
                  );
              }
              const env = { GIT_INDEX_FILE: temporaryIndex, GIT_LITERAL_PATHSPECS: "1" };
              if (input.action === "stage") {
                yield* run(cwd, ["add", "--", ...input.paths], { env });
              } else if (input.expected.headCommit === null) {
                yield* run(cwd, ["rm", "--cached", "-f", "--", ...input.paths], { env });
              } else {
                yield* run(cwd, ["reset", input.expected.headCommit, "--", ...input.paths], {
                  env,
                });
              }
              yield* guarded(cwd, input.expected);
              yield* fs.copyFile(temporaryIndex, lockPath);
              if (originalIndex?.mtime._tag === "Some")
                yield* fs.utimes(lockPath, originalIndex.mtime.value, originalIndex.mtime.value);
              // A Git writer obeying index.lock cannot race this atomic installation.
              yield* install;
              return yield* statusAtRoot(cwd);
            }),
          ),
        ),
      ),
    );
  });
  const commitStaged = Effect.fn("GitIndexOperations.commitStaged")(function* (
    input: GitCommitStagedInput,
  ): Effect.fn.Return<GitCommitStagedResult, GitCommandError> {
    const cwd = yield* rootFor(input.cwd);
    return yield* mapIo(
      cwd,
      withWorkspaceLease(
        cwd,
        Effect.gen(function* () {
          const { commitSha, headRef } = yield* withLockedIndex(cwd, (indexPath) =>
            Effect.scoped(
              Effect.gen(function* () {
                const status = yield* guarded(cwd, input.expected);
                if (status.staged.length === 0)
                  return yield* failure(cwd, "There are no staged changes to commit.");
                if (status.staged.some((file) => file.status === "U"))
                  return yield* failure(cwd, "Resolve index conflicts before committing.");
                const temp = yield* fs.makeTempDirectoryScoped({
                  directory: nodePath.dirname(indexPath),
                  prefix: "t3-commit-",
                });
                const temporaryIndex = nodePath.join(temp, "index");
                yield* fs.copyFile(indexPath, temporaryIndex);
                const env = { GIT_INDEX_FILE: temporaryIndex };
                const tree = (yield* run(cwd, ["write-tree"], { env })).stdout.trim();
                const parent = input.expected.headCommit;
                const headRef = input.expected.headRef;
                if (headRef === null)
                  return yield* failure(
                    cwd,
                    "Check out a branch before committing staged changes.",
                  );
                for (const marker of [
                  "MERGE_HEAD",
                  "CHERRY_PICK_HEAD",
                  "REVERT_HEAD",
                  "rebase-merge",
                  "rebase-apply",
                ]) {
                  const path = (yield* run(cwd, [
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    marker,
                  ])).stdout.trim();
                  if (yield* fs.exists(path))
                    return yield* failure(
                      cwd,
                      "Finish the current Git operation before committing staged changes.",
                    );
                }
                // Plumbing commits the reviewed tree exactly; hooks cannot stage additional content.
                // HEAD's compare-and-swap rejects an external commit made after the review check.
                const signing = yield* run(cwd, ["config", "--bool", "--get", "commit.gpgSign"], {
                  allowNonZeroExit: true,
                });
                if (signing.exitCode !== 0 && signing.exitCode !== 1)
                  return yield* failure(cwd, "Cannot read commit signing configuration.");
                const commitSha = (yield* run(
                  cwd,
                  [
                    "commit-tree",
                    ...(signing.stdout.trim() === "true" ? ["-S"] : []),
                    tree,
                    ...(parent === null ? [] : ["-p", parent]),
                  ],
                  { env, stdin: `${input.message.trim()}\n` },
                )).stdout.trim();
                yield* guarded(cwd, input.expected);
                yield* run(cwd, [
                  "-c",
                  `core.hooksPath=${temp}`,
                  "update-ref",
                  "-m",
                  "commit: staged changes",
                  headRef,
                  commitSha,
                  parent ?? "0".repeat(commitSha.length),
                ]);
                return { commitSha, headRef };
              }),
            ),
          );
          const headMatches = Effect.fn("GitIndexOperations.committedHeadMatches")(
            function* () {
              const currentRef = yield* run(cwd, ["symbolic-ref", "-q", "HEAD"], {
                allowNonZeroExit: true,
              });
              return (
                currentRef.exitCode === 0 &&
                currentRef.stdout.trim() === headRef &&
                (yield* headFor(cwd)) === commitSha
              );
            },
            Effect.orElseSucceed(() => false),
          );
          let headChanged = !(yield* headMatches());
          let push: GitCommitStagedResult["push"] = "not_requested";
          if (input.push && !headChanged) {
            const result = yield* git
              .pushCurrentBranch(cwd, null, { reviewed: { branchRef: headRef, commitSha } })
              .pipe(Effect.result);
            push = result._tag === "Success" ? "succeeded" : "failed";
          } else if (input.push) push = "failed";
          headChanged = headChanged || !(yield* headMatches());
          return {
            commitSha,
            branchRef: headRef,
            headChanged,
            push,
            recovery: push === "failed" ? ("push" as const) : null,
          };
        }),
      ),
    );
  });
  const discoverRepositories = Effect.fn("GitIndexOperations.discoverRepositories")(function* (
    input: GitDiscoverRepositoriesInput,
  ): Effect.fn.Return<GitDiscoverRepositoriesResult, GitCommandError> {
    return yield* mapIo(
      input.cwd,
      Effect.gen(function* () {
        const base = yield* fs.realPath(input.cwd);
        const queue = [{ path: base, depth: 0 }];
        const roots = new Set<string>();
        let scanned = 0;
        let entries = 0;
        let truncated = false;
        // Include the containing checkout when a project points to one of its subdirectories.
        const containing = yield* rootFor(base).pipe(Effect.option);
        if (containing._tag === "Some") roots.add(containing.value);
        while (queue.length > 0) {
          if (scanned++ >= MAX_DISCOVERY_DIRECTORIES || roots.size >= MAX_REPOSITORIES) {
            truncated = true;
            break;
          }
          const item = queue.shift()!;
          const allNames = yield* fs.readDirectory(item.path);
          if (allNames.length > 10_000 - entries) truncated = true;
          const names = allNames.slice(0, Math.max(0, 10_000 - entries)).sort();
          if (names.includes(".git")) {
            const root = yield* rootFor(item.path).pipe(Effect.option);
            if (root._tag === "Some" && inside(base, root.value)) roots.add(root.value);
          }
          for (const name of names) {
            entries++;
            if (OMIT_DIRECTORIES.has(name)) continue;
            const path = nodePath.join(item.path, name);
            const link = yield* fs.readLink(path).pipe(Effect.option);
            if (link._tag === "Some") continue;
            const real = yield* fs.realPath(path);
            if (!inside(base, real) || real !== path) continue;
            if ((yield* fs.stat(path)).type !== "Directory") continue;
            if (item.depth >= MAX_DEPTH || queue.length >= MAX_DISCOVERY_DIRECTORIES) {
              truncated = true;
              continue;
            }
            queue.push({ path, depth: item.depth + 1 });
          }
        }
        return { repositories: [...roots].sort().map((rootPath) => ({ rootPath })), truncated };
      }),
    );
  });
  const historySnapshot = Effect.fn("GitIndexOperations.historySnapshot")(function* (cwd: string) {
    const head = yield* headFor(cwd);
    const refs = (yield* run(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ])).stdout;
    return { head, fingerprint: digest(`${cwd}\0${head}\0${refs}`) };
  });
  const history = Effect.fn("GitIndexOperations.history")(function* (
    input: GitHistoryInput,
  ): Effect.fn.Return<GitHistoryResult, GitCommandError> {
    const cwd = yield* rootFor(input.cwd);
    const snapshot = yield* historySnapshot(cwd);
    let offset = 0;
    if (input.cursor !== undefined) {
      const match = /^([a-f0-9]{64}):(\d{1,6})$/.exec(input.cursor);
      if (!match || match[1] !== snapshot.fingerprint)
        return { commits: [], nextCursor: null, stale: true };
      offset = Number(match[2]);
      if (offset > 10_000) return { commits: [], nextCursor: null, stale: true };
    }
    if (snapshot.head === null) return { commits: [], nextCursor: null, stale: false };
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const raw = (yield* run(cwd, [
      "log",
      "--branches",
      "--remotes",
      "--tags",
      "HEAD",
      "--topo-order",
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00",
    ])).stdout;
    const parts = raw.split("\0");
    const commits: GitHistoryResult["commits"][number][] = [];
    for (let i = 0; i + 4 < parts.length; i += 5) {
      commits.push({
        sha: parts[i]!.trim(),
        parents: parts[i + 1]!.split(" ").filter(Boolean),
        author: parts[i + 2]!,
        authoredAt: parts[i + 3]!,
        subject: parts[i + 4]!,
      });
    }
    if ((yield* historySnapshot(cwd)).fingerprint !== snapshot.fingerprint)
      return { commits: [], nextCursor: null, stale: true };
    return {
      commits: commits.slice(0, limit),
      nextCursor:
        commits.length > limit && offset + limit < 10_000
          ? `${snapshot.fingerprint}:${offset + limit}`
          : null,
      stale: false,
    };
  });
  const historyDiff = Effect.fn("GitIndexOperations.historyDiff")(function* (
    input: GitHistoryDiffInput,
  ): Effect.fn.Return<GitHistoryDiffResult, GitCommandError> {
    const cwd = yield* rootFor(input.cwd);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commitSha))
      return yield* failure(cwd, "Select a full commit object id.");
    if (input.path !== undefined) yield* mapIo(cwd, validatePaths(cwd, [input.path]));
    const result = yield* run(
      cwd,
      [
        "show",
        "--format=",
        "--first-parent",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        input.commitSha,
        "--",
        ...(input.path === undefined ? [] : [input.path]),
      ],
      { env: { GIT_LITERAL_PATHSPECS: "1" }, maxOutputBytes: 120_000, allowTruncated: true },
    );
    return { patch: result.stdout, truncated: result.stdoutTruncated };
  });
  return { indexStatus, mutateIndex, commitStaged, discoverRepositories, history, historyDiff };
});
