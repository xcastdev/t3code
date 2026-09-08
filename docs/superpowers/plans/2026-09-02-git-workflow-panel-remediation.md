# Git workflow panel remediation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Correct Git workflow panel path handling, untracked-file diffs, deleted-file staging, and stale diff-query cancellation.

**Architecture:** The VCS driver treats status, index-mutation, and diff paths as literal paths relative to the repository root. Status detail commands run from that root so every command reports the same basis. Selected-file diff queries use a zero idle TTL, which disposes an in-flight RPC when React stops observing it.

**Tech Stack:** TypeScript, Effect, Effect Atom, Git CLI, Vitest.

**Spec:** docs/superpowers/specs/2026-09-02-git-workflow-panel-design.md

## Global constraints

- Support Git repositories only.
- Stage and unstage complete files only.
- Preserve literal-path and symlink-escape protections.
- Keep status stream-driven. Do not add polling.
- Cancel a selected-file diff when selection changes.
- Do not add mobile UI.
- Run focused tests only. Do not run repository-wide checks.
- Do not commit this plan or other planning artifacts.

## Adversarial verdict

Validated defects:

1. getWorkingTreeDiff runs git ls-files without -z, then parses its output as NUL-separated. An untracked filename such as new.txt followed by a newline is misclassified and has an empty diff.
2. Status assembly combines porcelain paths relative to cwd with diff paths relative to the repository root. In a nested cwd it can emit a.txt and src/a.txt for one change. Index validation then resolves the latter from cwd and targets the wrong file.
3. Missing paths are validated only through their immediate parent. Staging a tracked deletion fails when the deleted file was the last item in a removed directory.
4. The selected-file diff atom keeps the generic five-minute idle TTL. The approved plan requires cancellation on selection change, but the old request remains alive after React unsubscribes.

Rejected claims:

- envLocked locks thread context. Server-side authorization governs Git mutations, so disabling panel actions on that flag would change intended behavior.
- View switching remounts content, but the specification requires preservation after command failures and status-stream updates. Those do not remount the panel.
- Separate status queries are required by the approved plan. No measured regression makes them a defect.

## File structure

- apps/server/src/vcs/GitVcsDriverCore.ts: canonical root-relative paths, missing-deletion validation, and NUL-delimited untracked detection.
- apps/server/src/vcs/GitVcsDriverCore.test.ts: real temporary-repository regression tests.
- packages/client-runtime/src/state/vcs.ts: zero-TTL selected-file diff query.
- packages/client-runtime/src/state/runtime.test.ts and packages/client-runtime/src/state/vcs.test.ts: query cancellation tests.

### Task 1: Normalize driver paths and untracked diffs

**Files:**

- Modify: apps/server/src/vcs/GitVcsDriverCore.ts:1540-1815
- Modify: apps/server/src/vcs/GitVcsDriverCore.ts:2440-2665
- Test: apps/server/src/vcs/GitVcsDriverCore.test.ts:930-1320
- Test: apps/server/src/vcs/GitVcsDriverCore.test.ts:1660-1745

**Interfaces:**

- Consumes: statusDetailsLocal(cwd), stageFiles({ cwd, paths }), unstageFiles({ cwd, paths }), and getWorkingTreeDiff({ cwd, path, comparison }).
- Produces: status rows and RPC paths that are literal paths relative to resolveRepositoryPaths(cwd).worktreeRoot.

- [ ] **Step 1: Write failing nested-cwd and untracked-diff tests**

```ts
it.effect("reports and stages nested-cwd changes with one root-relative path", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const pathService = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "src/a.txt", "changed\n");

    const status = yield* driver.statusDetailsLocal(pathService.join(cwd, "src"));
    assert.deepStrictEqual(
      status.workingTree.files.map((file) => file.path),
      ["src/a.txt"],
    );
    yield* driver.stageFiles({ cwd: pathService.join(cwd, "src"), paths: ["src/a.txt"] });
    assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "src/a.txt");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns a patch for an untracked file", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "new.txt", "new contents\n");

    const result = yield* driver.getWorkingTreeDiff({
      cwd,
      path: "new.txt",
      comparison: "head",
    });
    assert.include(result.diff, "+new contents");
  }).pipe(Effect.provide(TestLayer)),
);
```

- [ ] **Step 2: Run the test to verify the defect**

Run: vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts

Expected: the status contract test exposes mixed paths or incorrect staging, and the untracked diff lacks +new contents.

- [ ] **Step 3: Resolve the worktree root before the status detail fan-out**

In readStatusDetailsLocal, resolve repository paths before the status detail commands. Retain the existing non-repository result when no worktree root exists. With a root, run porcelain status, numstat, staged, unstaged, untracked, and conflicted commands using the root as their cwd.

```ts
const repositoryPaths =
  yield *
  resolveRepositoryPaths(cwd).pipe(
    Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
  );
const commandCwd = repositoryPaths?.worktreeRoot ?? cwd;
// Every path collected into workingTree.files is relative to commandCwd.
```

Keep the current separate index-state queries. Do not add a second path conversion after parsing.

- [ ] **Step 4: Validate supplied paths from the repository root**

Replace cwd-relative path resolution in validateIndexPaths:

```ts
const requestedPath = path.resolve(repositoryRoot, pathValue);
const relativePath = path.relative(repositoryRoot, requestedPath);
```

Keep rejection of empty, absolute, and outside-root paths. Continue passing relativePath to Git commands.

- [ ] **Step 5: Support deleted paths in removed directories**

Add a helper beside validateIndexPaths that walks from a missing requestedPath toward repositoryRoot until it finds an existing filesystem ancestor. Resolve that ancestor with fileSystem.realPath. For an existing target, resolve the target. Reject if the resolved target or ancestor escapes realRepositoryRoot.

Use this helper before fileSystem.stat. A missing tracked file then reaches git add -- relativePath and stages the deletion. A missing untracked file remains a no-op.

- [ ] **Step 6: Pair untracked parsing with NUL-delimited output**

Change the untracked command in getWorkingTreeDiff to:

```ts
["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", relativePath];
```

Keep splitNullSeparatedGitStdoutPaths.

- [ ] **Step 7: Add a removed-directory regression test**

```ts
it.effect("stages a deleted file after its parent directory is removed", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "obsolete/file.txt", "tracked\n");
    yield* git(cwd, ["add", "obsolete/file.txt"]);
    yield* git(cwd, ["commit", "-m", "add obsolete file"]);
    yield* fileSystem.remove(pathService.join(cwd, "obsolete"), { recursive: true });

    yield* driver.stageFiles({ cwd, paths: ["obsolete/file.txt"] });
    assert.include(yield* git(cwd, ["diff", "--cached", "--name-status"]), "D\tobsolete/file.txt");
  }).pipe(Effect.provide(TestLayer)),
);
```

Retain the existing literal-path and symlink-escape test unchanged.

- [ ] **Step 8: Run focused driver verification**

Run: vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts

Expected: PASS, including nested cwd, untracked diff, deleted directory, literal filenames, and symlink-escape rejection.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "fix(server): normalize Git workflow paths"
```

### Task 2: Cancel stale selected-file diff requests

**Files:**

- Modify: packages/client-runtime/src/state/vcs.ts:325-328
- Test: packages/client-runtime/src/state/runtime.test.ts
- Test: packages/client-runtime/src/state/vcs.test.ts

**Interfaces:**

- Consumes: createEnvironmentRpcQueryAtomFamily(..., { idleTtlMs }).
- Produces: getWorkingTreeDiffQuery atoms that dispose when the selected path is no longer observed.

- [ ] **Step 1: Write a runtime cancellation test**

Use the existing runtime test harness, AtomRegistry, Deferred, and TestClock. Mock the query RPC as an effect that never succeeds but completes a deferred in its finalizer.

```ts
const cancelled = yield * Deferred.make<void>();
const request = Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
const unsubscribe = registry.subscribe(query(TARGET), () => undefined);
yield * started.await;
unsubscribe();
yield * cancelled.await;
```

The assertion must succeed without advancing a five-minute clock.

- [ ] **Step 2: Run the new test**

Run: vp test run packages/client-runtime/src/state/runtime.test.ts

Expected: a generic zero-TTL query cancels on unsubscribe. An equivalent production diff-query assertion remains red until the option is added.

- [ ] **Step 3: Give only the selected-file query a zero idle TTL**

```ts
getWorkingTreeDiffQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
  label: "environment-data:vcs:working-tree-diff-query",
  tag: WS_METHODS.vcsGetWorkingTreeDiff,
  idleTtlMs: 0,
}),
```

Do not change the shared five-minute default.

- [ ] **Step 4: Add a VCS-facing regression test**

In packages/client-runtime/src/state/vcs.test.ts, subscribe to a diff query for a.txt, replace it with b.txt, and assert the a.txt mocked RPC finalizer runs before b.txt completes. This proves the exact atom used by SourceControlPanel.

- [ ] **Step 5: Run focused client-runtime tests**

Run: vp test run packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcs.test.ts

Expected: PASS without a wall-clock sleep or five-minute clock advance.

- [ ] **Step 6: Commit**

```bash
git add packages/client-runtime/src/state/vcs.ts packages/client-runtime/src/state/vcs.test.ts packages/client-runtime/src/state/runtime.test.ts
git commit -m "fix(client): cancel stale Git diff requests"
```

### Task 3: Verify the correction at the feature boundary

**Files:**

- Test: apps/web/src/components/source-control/SourceControlPanel.test.tsx

**Interfaces:**

- Consumes: root-relative status rows and transient diff queries.
- Produces: focused evidence that the panel forwards src/a.txt unchanged.

- [ ] **Step 1: Add a panel test only if the current harness observes queries**

If the panel harness can observe VCS query targets, assert that selecting a src/a.txt row sends exactly src/a.txt to the diff query. Do not add a static-render assertion that only mirrors props. If the harness cannot observe behavior, keep the proof in the driver and client-runtime tests.

- [ ] **Step 2: Run the focused remediation suite**

Run:

```bash
vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/source-control/SourceControlPanel.test.tsx
vp run --filter t3 typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/web typecheck
git diff --check
```

Expected: all focused checks pass. If the existing SSH-fixture test still fails, report its missing fixture separately and do not describe the suite as fully green.

- [ ] **Step 3: Inspect the final feature diff**

Run:

```bash
git diff --check 8f7b05edb30e2620bfacf5a6c4b31c8ec7576845...HEAD
git status --short
```

Expected: no whitespace errors and only remediation source and test files changed.

### Task 4: Harden Git path and branch-safety boundaries found in final review

**Files:**

- Modify: `packages/contracts/src/git.ts`
- Test: `packages/contracts/src/git.test.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`
- Modify: `apps/web/src/components/BranchToolbarBranchSelector.tsx`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Test: the existing branch-toolbar logic test if it can observe the confirmation decision
- Test: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

**Interfaces:**

- Consumes: Git path values from status and the stage, unstage, and diff RPC inputs.
- Produces: lossless non-empty Git path values, literal pathspec behavior for every index/diff command, no textconv execution for read-scoped diffs, and fail-closed dirty-branch switching while status is unknown.

- [ ] **Step 1: Add failing contract tests for whitespace-preserving Git paths**

Use a filename with leading and trailing spaces and assert that decoding preserves the exact value for a status file, stage input, and diff input. Also assert that an empty path and a path containing NUL are rejected.

```ts
it("preserves whitespace in Git path values", () => {
  const path = " report.txt ";
  const status = decodeVcsStatus({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path, insertions: 1, deletions: 0, indexStatus: "unstaged" }],
      insertions: 1,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  });
  expect(status.workingTree.files[0]?.path).toBe(path);
  expect(decodeVcsStageFilesInput({ cwd: "/repo", paths: [path] }).paths).toEqual([path]);
  expect(
    decodeVcsWorkingTreeDiffInput({
      cwd: "/repo",
      path,
      comparison: "head",
    }).path,
  ).toBe(path);
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `vp test run packages/contracts/src/git.test.ts`

Expected: the new test fails because the current Git path fields use the trimming schema.

- [ ] **Step 3: Introduce a lossless Git path schema**

Define one local schema for Git paths using `Schema.String.check(Schema.isNonEmpty())` plus a NUL rejection check. Use it for `VcsWorkingTreeFile.path`, `VcsStageFilesInput.paths`, and `VcsWorkingTreeDiffInput.path`. Keep cwd and commit-message schemas trimmed. Do not trim Git paths during status parsing; preserve the exact path bytes representable by the string protocol.

- [ ] **Step 4: Add failing server tests for pathspec magic and textconv**

Create a real temporary repository containing a literal filename such as `:(glob)*.txt` and a second tracked file. Stage both, unstage only the literal file, and assert the second file remains staged. Request a diff for the literal filename and assert the response contains only that file.

Configure a temporary Git textconv driver whose command writes a marker file, then request a tracked diff. Assert the marker is absent and the normal file diff is returned.

- [ ] **Step 5: Run the server regressions and verify they fail**

Run: `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`

Expected: the pathspec test can affect the wrong path and the textconv test records helper execution before the command fix.

- [ ] **Step 6: Make every relevant Git command literal and non-converting**

Add `--literal-pathspecs` before `restore`, `reset`, and every tracked `diff` invocation in the new workflow. Keep `--no-ext-diff` and add `--no-textconv` to the tracked diff branch. The existing `git add` and untracked `ls-files` commands already use literal pathspecs.

- [ ] **Step 7: Run the server regressions**

Run: `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`

Expected: the new pathspec and textconv tests pass. The known unrelated SSH fixture failure may remain and must be reported separately.

- [ ] **Step 8: Add a fail-closed branch-confirmation test**

Add this pure decision helper to `apps/web/src/components/source-control/sourceControlPanel.logic.ts` and test it:

```ts
export function canAttemptDirtyBranchSwitch(hasWorkingTreeChanges: boolean | undefined): boolean {
  return hasWorkingTreeChanges !== undefined;
}

it("blocks branch switching until status is known", () => {
  expect(canAttemptDirtyBranchSwitch(undefined)).toBe(false);
  expect(canAttemptDirtyBranchSwitch(false)).toBe(true);
  expect(canAttemptDirtyBranchSwitch(true)).toBe(true);
});
```

The helper must be used by the branch selector so unknown status cannot authorize a branch switch.

- [ ] **Step 9: Implement the unknown-status guard**

In `confirmDirtyBranchSwitch`, call `canAttemptDirtyBranchSwitch(branchStatusQuery.data?.hasWorkingTreeChanges)`. When it returns false, show the existing error toast with the text `"Branch status is unavailable. Refresh before switching branches."` and return false. Only skip confirmation when `hasWorkingTreeChanges === false`; require the existing confirmation when it is true.

- [ ] **Step 10: Run focused contract and web checks**

Run:

```bash
vp test run packages/contracts/src/git.test.ts apps/web/src/components/source-control/sourceControlPanel.logic.test.ts
vp run --filter @t3tools/web typecheck
```

Expected: all selected tests pass and the web typecheck exits 0.

- [ ] **Step 11: Commit the hardening changes**

```bash
git add packages/contracts/src/git.ts packages/contracts/src/git.test.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/web/src/components/BranchToolbarBranchSelector.tsx
git commit -m "fix: harden Git workflow safety boundaries"
```

### Task 5: Preserve unusual status paths and whole-file renames

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

**Interfaces:**

- Consumes: NUL-delimited porcelain-v2 status and numstat output.
- Produces: one actionable status row per logical path, with rename metadata retained for complete-file unstage operations.

- [ ] **Step 1: Add failing real-repository tests**

Cover a staged rename followed by unstage of the displayed destination, a tracked filename containing a tab or newline, and staging a missing untracked path as a no-op. Assert that no duplicate quoted status row appears, the rename source is no longer staged, and the missing untracked operation succeeds without changing the index.

- [ ] **Step 2: Parse status and numstat as NUL-delimited records**

Run porcelain status and all relevant numstat commands with `-z`. Preserve exact path strings, consume the second path field of rename records, and associate stats with the destination path. Do not reintroduce C-quoted line parsing for actionable paths.

- [ ] **Step 3: Expand selected renames during unstage**

Before `restore --staged`/`reset`, resolve cached rename pairs from the repository root and include both source and destination when either matches a requested path. Keep literal pathspecs and root/symlink validation for every path.

- [ ] **Step 4: Make missing untracked staging idempotent**

After validation, distinguish a missing path with no corresponding index entry from a tracked deletion. Skip `git add` for the former while continuing to stage tracked deletions.

- [ ] **Step 5: Run focused server tests and typecheck**

Run `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts` and `vp run --filter t3 typecheck`. Report the known SSH fixture failure separately if it remains.

### Task 6: Refresh the source-control pull-request list after actions

**Files:**

- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Test: an existing pull-request presentation/logic test if the harness can observe the detail action callback; otherwise verify through the focused web typecheck and review the prop boundary.

- [ ] **Step 1: Pass the list refresh callback to the embedded detail**

Provide `onActed={listQuery.refresh}` to `PullRequestDetailPanel` so merge, close, reopen, and other host mutations invalidate the open-PR list rendered above the detail.

- [ ] **Step 2: Run focused web checks**

Run the existing source-control and pull-request tests plus `vp run --filter @t3tools/web typecheck`.

## Plan review

Task 1 fixes the original Git path, untracked-diff, and deletion defects while preserving the approved status-query approach. Task 2 meets the explicit cancellation requirement without changing global query caching. Task 3 limits verification to affected server, client-runtime, and panel paths. Task 4 addresses the additional final-review findings without changing mobile UI or the approved source-control scope.
Task 5 closes the remaining Git protocol and whole-file rename gaps found by adversarial review. Task 6 keeps the embedded pull-request list synchronized after detail actions.
