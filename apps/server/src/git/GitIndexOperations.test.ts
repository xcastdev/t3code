import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as GitIndexOperations from "./GitIndexOperations.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-index-tests-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const index = yield* GitIndexOperations.make;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-" });
  const run = (args: readonly string[], path = cwd) =>
    git.execute({ operation: "test.index", cwd: path, args });
  yield* fs.makeDirectory(`${cwd}/hooks`);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "core.hooksPath", `${cwd}/hooks`],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Index test"],
  ])
    yield* run(args);
  yield* fs.writeFileString(`${cwd}/a.txt`, "original\n");
  yield* fs.writeFileString(`${cwd}/b.txt`, "original\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  return { fs, git, index, cwd, run };
});

it.live("stages and unstages only reviewed paths while preserving the worktree", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "staged\n");
    yield* fs.writeFileString(`${cwd}/b.txt`, "unstaged\n");
    const reviewed = yield* index.indexStatus({ cwd });
    assert.equal(reviewed.staged.length, 0);
    const staged = yield* index.mutateIndex({
      cwd,
      expected: reviewed.fingerprint,
      action: "stage",
      paths: ["a.txt"],
    });
    assert.deepEqual(staged.staged, [{ path: "a.txt", status: "M" }]);
    assert.deepEqual(staged.unstaged, [{ path: "b.txt", status: "M" }]);
    const unstaged = yield* index.mutateIndex({
      cwd,
      expected: staged.fingerprint,
      action: "unstage",
      paths: ["a.txt"],
    });
    assert.equal(unstaged.staged.length, 0);
    assert.equal((yield* run(["show", "HEAD:a.txt"])).stdout, "original\n");
    assert.equal(yield* fs.readFileString(`${cwd}/a.txt`), "staged\n");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("rejects external index and same-size worktree edits without changing either", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "first\n");
    const beforeIndexEdit = yield* index.indexStatus({ cwd });
    yield* run(["add", "a.txt"]);
    const staleIndex = yield* index
      .mutateIndex({
        cwd,
        expected: beforeIndexEdit.fingerprint,
        action: "stage",
        paths: ["a.txt"],
      })
      .pipe(Effect.flip);
    assert.include(staleIndex.detail, "changed since review");
    const beforeFileEdit = yield* index.indexStatus({ cwd });
    yield* fs.writeFileString(`${cwd}/a.txt`, "other\n");
    const staleWorktree = yield* index
      .commitStaged({ cwd, expected: beforeFileEdit.fingerprint, message: "must reject" })
      .pipe(Effect.flip);
    assert.include(staleWorktree.detail, "changed since review");
    assert.equal((yield* run(["show", ":a.txt"])).stdout, "first\n");
    assert.equal(yield* fs.readFileString(`${cwd}/a.txt`), "other\n");
    assert.equal((yield* run(["log", "-1", "--format=%s"])).stdout.trim(), "initial");
    assert.isFalse(yield* fs.exists(`${cwd}/.git/index.lock`));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("commits exactly the staged tree and returns a recoverable failed push", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "staged\n");
    yield* run(["add", "a.txt"]);
    yield* fs.writeFileString(`${cwd}/a.txt`, "later worktree\n");
    yield* fs.writeFileString(`${cwd}/b.txt`, "not staged\n");
    const reviewed = yield* index.indexStatus({ cwd });
    const result = yield* index.commitStaged({
      cwd,
      expected: reviewed.fingerprint,
      message: "reviewed only",
      push: true,
    });
    assert.equal(result.push, "failed");
    assert.equal(result.recovery, "push");
    assert.equal((yield* run(["rev-parse", "HEAD"])).stdout.trim(), result.commitSha);
    assert.equal((yield* run(["show", "HEAD:a.txt"])).stdout, "staged\n");
    assert.equal((yield* run(["show", "HEAD:b.txt"])).stdout, "original\n");
    assert.equal(yield* fs.readFileString(`${cwd}/a.txt`), "later worktree\n");
    const after = yield* index.indexStatus({ cwd });
    assert.equal(after.staged.length, 0);
    assert.deepEqual(
      after.unstaged.map((file) => file.path),
      ["a.txt", "b.txt"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("discovers nested roots and skips symlink escapes", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.makeDirectory(`${cwd}/nested`);
    yield* run(["init", "-b", "main"], `${cwd}/nested`);
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-outside-" });
    yield* run(["init", "-b", "main"], outside);
    yield* fs.symlink(outside, `${cwd}/outside-link`);
    yield* fs.symlink(cwd, `${cwd}/loop`);
    const discovered = yield* index.discoverRepositories({ cwd });
    assert.deepEqual(
      discovered.repositories.map((repo) => repo.rootPath),
      [cwd, `${cwd}/nested`],
    );
    assert.isFalse(discovered.truncated);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("returns parent edges, bounded history, file diffs and stale cursors", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "second\n");
    yield* run(["add", "a.txt"]);
    yield* run(["commit", "-m", "second"]);
    const page = yield* index.history({ cwd, limit: 1 });
    assert.equal(page.commits.length, 1);
    assert.equal(page.commits[0]!.subject, "second");
    assert.equal(page.commits[0]!.parents.length, 1);
    assert.isNotNull(page.nextCursor);
    const second = yield* index.history({ cwd, limit: 1, cursor: page.nextCursor! });
    assert.equal(second.commits[0]!.subject, "initial");
    assert.isNull(second.nextCursor);
    const diff = yield* index.historyDiff({ cwd, commitSha: page.commits[0]!.sha, path: "a.txt" });
    assert.include(diff.patch, "+second");
    yield* run(["commit", "--allow-empty", "-m", "external"]);
    const stale = yield* index.history({ cwd, cursor: page.nextCursor! });
    assert.isTrue(stale.stale);
    assert.deepEqual(stale.commits, []);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("handles an unborn index and stages literal pathspec characters", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    const nested = `${cwd}/unborn`;
    yield* fs.makeDirectory(nested);
    yield* run(["init", "-b", "main"], nested);
    yield* fs.writeFileString(`${nested}/[a].txt`, "literal\n");
    yield* fs.writeFileString(`${nested}/a.txt`, "other\n");
    const initial = yield* index.indexStatus({ cwd: nested });
    const staged = yield* index.mutateIndex({
      cwd: nested,
      expected: initial.fingerprint,
      action: "stage",
      paths: ["[a].txt"],
    });
    assert.deepEqual(
      staged.staged.map((file) => file.path),
      ["[a].txt"],
    );
    const unstaged = yield* index.mutateIndex({
      cwd: nested,
      expected: staged.fingerprint,
      action: "unstage",
      paths: ["[a].txt"],
    });
    assert.equal(unstaged.staged.length, 0);
    assert.equal(unstaged.unstaged.length, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("serializes index edits through canonical roots including path aliases", () =>
  Effect.gen(function* () {
    const { fs, index, cwd } = yield* fixture;
    const aliasDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-alias-" });
    const alias = `${aliasDirectory}/checkout`;
    yield* fs.symlink(cwd, alias);
    yield* fs.writeFileString(`${cwd}/a.txt`, "a\n");
    yield* fs.writeFileString(`${cwd}/b.txt`, "b\n");
    const reviewed = yield* index.indexStatus({ cwd });
    const results = yield* Effect.all(
      [
        index
          .mutateIndex({ cwd, expected: reviewed.fingerprint, action: "stage", paths: ["a.txt"] })
          .pipe(Effect.result),
        index
          .mutateIndex({
            cwd: alias,
            expected: reviewed.fingerprint,
            action: "stage",
            paths: ["b.txt"],
          })
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(results.filter((result) => result._tag === "Success").length, 1);
    const failed = results.find((result) => result._tag === "Failure");
    assert.isDefined(failed);
    if (failed?._tag === "Failure") assert.include(failed.failure.detail, "changed since review");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("rejects a branch moved between review verification and ref installation", () =>
  Effect.gen(function* () {
    const { fs, git, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "reviewed\n");
    yield* run(["add", "a.txt"]);
    const tree = (yield* run(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const parent = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
    const external = (yield* git.execute({
      operation: "test.externalCommit",
      cwd,
      args: ["commit-tree", tree, "-p", parent],
      stdin: "external\n",
    })).stdout.trim();
    const wrapper = {
      ...git,
      execute: (input: GitVcsDriver.ExecuteGitInput) =>
        Effect.gen(function* () {
          if (input.args.includes("update-ref"))
            yield* run(["update-ref", "refs/heads/main", external, parent]);
          return yield* git.execute(input);
        }),
    };
    const index = yield* GitIndexOperations.make.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, wrapper),
    );
    const reviewed = yield* index.indexStatus({ cwd });
    const error = yield* index
      .commitStaged({ cwd, expected: reviewed.fingerprint, message: "must not move branch" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "GitCommandError");
    assert.equal((yield* run(["rev-parse", "HEAD"])).stdout.trim(), external);
    assert.equal((yield* run(["show", ":a.txt"])).stdout, "reviewed\n");
    assert.equal(yield* fs.readFileString(`${cwd}/a.txt`), "reviewed\n");
    assert.isFalse(yield* fs.exists(`${cwd}/.git/index.lock`));
    assert.isFalse(yield* fs.exists(`${cwd}/.git/HEAD.lock`));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("rejects same-commit branch switches and in-progress merges", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "reviewed\n");
    yield* run(["add", "a.txt"]);
    const reviewed = yield* index.indexStatus({ cwd });
    yield* run(["branch", "other"]);
    yield* run(["symbolic-ref", "HEAD", "refs/heads/other"]);
    const switched = yield* index
      .commitStaged({ cwd, expected: reviewed.fingerprint, message: "must reject" })
      .pipe(Effect.flip);
    assert.include(switched.detail, "changed since review");
    const current = yield* index.indexStatus({ cwd });
    yield* fs.writeFileString(`${cwd}/.git/MERGE_HEAD`, `${current.fingerprint.headCommit}\n`);
    const merge = yield* index
      .commitStaged({ cwd, expected: current.fingerprint, message: "must reject" })
      .pipe(Effect.flip);
    assert.include(merge.detail, "Finish the current Git operation");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("keeps an external HEAD switch while committing only to the reviewed branch", () =>
  Effect.gen(function* () {
    const { fs, git, cwd, run } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/a.txt`, "reviewed\n");
    yield* run(["add", "a.txt"]);
    yield* run(["branch", "external"]);
    const externalHead = (yield* run(["rev-parse", "refs/heads/external"])).stdout.trim();
    const index = yield* GitIndexOperations.make.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            if (input.args.includes("update-ref"))
              yield* run(["symbolic-ref", "HEAD", "refs/heads/external"]);
            return yield* git.execute(input);
          }),
      }),
    );
    const before = yield* index.indexStatus({ cwd });
    const result = yield* index.commitStaged({
      cwd,
      expected: before.fingerprint,
      message: "reviewed branch",
      push: true,
    });
    assert.equal(result.branchRef, "refs/heads/main");
    assert.isTrue(result.headChanged);
    assert.equal(result.push, "failed");
    assert.equal(result.recovery, "push");
    assert.equal((yield* run(["symbolic-ref", "HEAD"])).stdout.trim(), "refs/heads/external");
    assert.equal((yield* run(["rev-parse", "HEAD"])).stdout.trim(), externalHead);
    assert.equal((yield* run(["rev-parse", "refs/heads/main"])).stdout.trim(), result.commitSha);
    assert.equal((yield* run(["show", `${result.commitSha}:a.txt`])).stdout, "reviewed\n");
    assert.equal((yield* run(["show", ":a.txt"])).stdout, "reviewed\n");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("bounds nested discovery by depth and reports truncation", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    const deep = `${cwd}/one/two/three/four/five/six/seven/eight`;
    yield* fs.makeDirectory(deep, { recursive: true });
    yield* run(["init", "-b", "main"], deep);
    const result = yield* index.discoverRepositories({ cwd });
    assert.deepEqual(result.repositories, [{ rootPath: cwd }]);
    assert.isTrue(result.truncated);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("keeps the reviewed staged tree when repository hooks would reject or change it", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    for (const hook of ["pre-commit", "commit-msg", "reference-transaction"]) {
      yield* fs.writeFileString(`${cwd}/hooks/${hook}`, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(`${cwd}/hooks/${hook}`, 0o755);
    }
    yield* fs.writeFileString(`${cwd}/a.txt`, "reviewed\n");
    yield* run(["add", "a.txt"]);
    const before = yield* index.indexStatus({ cwd });
    const result = yield* index.commitStaged({
      cwd,
      expected: before.fingerprint,
      message: "exact tree",
    });
    assert.equal(result.branchRef, "refs/heads/main");
    assert.isFalse(result.headChanged);
    assert.equal((yield* run(["show", "HEAD:a.txt"])).stdout, "reviewed\n");
    assert.equal((yield* run(["show", "HEAD:b.txt"])).stdout, "original\n");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("stages an external symlink's target text without reading its destination", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* fs.symlink("/does-not-exist/outside-checkout", `${cwd}/external-link`);
    const before = yield* index.indexStatus({ cwd });
    const staged = yield* index.mutateIndex({
      cwd,
      expected: before.fingerprint,
      action: "stage",
      paths: ["external-link"],
    });
    assert.deepEqual(
      staged.staged.map((file) => file.path),
      ["external-link"],
    );
    assert.equal(
      (yield* run(["show", ":external-link"])).stdout,
      "/does-not-exist/outside-checkout",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("preserves Git's racy timestamp detection when copying the index", () =>
  Effect.gen(function* () {
    const { fs, index, cwd, run } = yield* fixture;
    yield* run(["config", "core.trustctime", "false"]);
    const timestamp = 978_307_200;
    yield* fs.utimes(`${cwd}/b.txt`, timestamp, timestamp);
    yield* run(["update-index", "--refresh"]);
    yield* fs.utimes(`${cwd}/.git/index`, timestamp, timestamp);
    yield* fs.writeFileString(`${cwd}/b.txt`, "unstaged\n");
    yield* fs.utimes(`${cwd}/b.txt`, timestamp, timestamp);
    yield* fs.writeFileString(`${cwd}/a.txt`, "staged\n");
    const before = yield* index.indexStatus({ cwd });
    assert.deepEqual(
      before.unstaged.map((file) => file.path),
      ["a.txt", "b.txt"],
    );
    const after = yield* index.mutateIndex({
      cwd,
      expected: before.fingerprint,
      action: "stage",
      paths: ["a.txt"],
    });
    assert.deepEqual(
      after.staged.map((file) => file.path),
      ["a.txt"],
    );
    assert.deepEqual(
      after.unstaged.map((file) => file.path),
      ["b.txt"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live.each(["succeeded", "rejected", "diverged"] as const)(
  "pushes the reviewed branch and immutable commit even when HEAD switches at push entry (%s)",
  (outcome) =>
    Effect.gen(function* () {
      const { fs, git, cwd, run } = yield* fixture;
      const base = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
      yield* run(["branch", "external"]);
      for (const [branch, remote] of [
        ["main", "origin"],
        ["external", "other"],
      ]) {
        yield* run(["remote", "add", remote!, `https://example.invalid/${remote}.git`]);
        yield* run(["config", `branch.${branch}.remote`, remote!]);
        yield* run(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
        yield* run(["update-ref", `refs/remotes/${remote}/${branch}`, base]);
      }
      yield* run(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/mapped/*"]);
      yield* run(["update-ref", "refs/remotes/origin/mapped/main", base]);
      yield* run(["update-ref", "-d", "refs/remotes/origin/main"]);
      if (outcome === "diverged") {
        const tree = (yield* run(["rev-parse", "HEAD^{tree}"])).stdout.trim();
        const diverged = (yield* git.execute({
          operation: "test.remoteDivergence",
          cwd,
          args: ["commit-tree", tree, "-p", base],
          stdin: "diverged remote\n",
        })).stdout.trim();
        yield* run(["update-ref", "refs/remotes/origin/mapped/main", diverged]);
      }
      yield* fs.writeFileString(`${cwd}/a.txt`, "reviewed\n");
      yield* run(["add", "a.txt"]);
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pushes: Array<readonly string[]> = [];
      const guardedSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.some((arg) => ["push", "fetch", "ls-remote"].includes(arg))
          )
            return yield* nativeSpawner.spawn(command);
          if (command.args.includes("push")) pushes.push(command.args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(outcome === "rejected" ? 1 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const adapter = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
      );
      const index = yield* GitIndexOperations.make.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...git,
          pushCurrentBranch: (pushCwd, fallbackBranch, options) =>
            Effect.gen(function* () {
              yield* run(["symbolic-ref", "HEAD", "refs/heads/external"]);
              assert.isFalse(yield* fs.exists(`${cwd}/.git/index.lock`));
              return yield* adapter.pushCurrentBranch(pushCwd, fallbackBranch, options);
            }),
        }),
      );
      const before = yield* index.indexStatus({ cwd });
      const result = yield* index.commitStaged({
        cwd,
        expected: before.fingerprint,
        message: "reviewed push",
        push: true,
      });
      assert.equal(result.push, outcome === "succeeded" ? "succeeded" : "failed");
      assert.equal(result.recovery, outcome === "succeeded" ? null : "push");
      assert.equal(pushes.length, outcome === "diverged" ? 0 : 1);
      if (outcome !== "diverged") {
        assert.include(pushes[0]!, `${result.commitSha}:refs/heads/main`);
        assert.include(pushes[0]!, "origin");
        assert.include(pushes[0]!, `--force-with-lease=refs/heads/main:${base}`);
      }
      assert.isTrue(result.headChanged);
      assert.equal((yield* run(["symbolic-ref", "HEAD"])).stdout.trim(), "refs/heads/external");
      assert.equal((yield* run(["rev-parse", "HEAD"])).stdout.trim(), base);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
