# Git workflow panel final remediation implementation plan

Execute this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Git workflow panel by making new RPCs safe under client/server version skew, exposing both sides of mixed index state, refreshing divergence after commits, and replacing a prohibited static-render test.

**Architecture:** The environment descriptor advertises one optional capability for the per-file Git workflow RPCs. The panel remains available on older servers for status, branches, initialization, and pull requests, but it never calls unsupported diff, stage, unstage, or index-commit methods. File rows derive explicit index actions and diff comparisons from `indexStatus`. The server keeps diff failures truthful and refreshes local plus remote-derived status after an index commit without fetching the Git remote or expiring the pull-request lookup cache.

**Tech Stack:** TypeScript, Effect Schema, Effect, Effect Atom, React, Git CLI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-git-workflow-panel-design.md`

## Global constraints

- Support Git repositories only.
- Stage and unstage complete files only. A `both` file must offer both operations.
- Keep the Source Control panel and Pull requests view usable against older servers.
- Never send `vcs.stageFiles`, `vcs.unstageFiles`, `vcs.getWorkingTreeDiff`, or `git.commitIndex` unless the environment advertises support.
- Keep status stream-driven. Do not add polling.
- Recompute ahead and behind after an index commit without forcing a network fetch.
- Keep the pull-request lookup cache warm during the post-commit no-fetch refresh.
- Preserve literal-path, symlink-escape, NUL-delimited parsing, textconv, and bounded-output protections.
- Do not add mobile UI.
- Do not add static-markup tests that assert props, attributes, or callback wiring.
- Run focused checks only. The known SSH fixture failure in `GitVcsDriverCore.test.ts` must be reported separately if it remains.
- Do not commit this plan or other planning artifacts.

---

## Validated findings

1. **High:** The current client exposes Source Control before it knows whether a connected server implements the four new workflow RPCs. An older server receives an unknown `vcs.getWorkingTreeDiff` method when the user selects a file.
2. **High:** A file with `indexStatus: "both"` always requests the HEAD comparison. Staged content can therefore be invisible when later working-tree edits cancel it, even though Commit will commit that content.
3. **Medium:** A `both` file exposes only Stage, so the panel has no reverse operation for removing its existing staged change.
4. **High:** `git diff --no-index` exit code 1 is accepted unconditionally. In an unborn repository, a staged file deleted from the working tree produces an access error that the API returns as an empty diff.
5. **Medium:** `git.commitIndex` refreshes only the local status part. The broadcaster retains stale ahead and behind counts until the next remote refresh.
6. **Low:** `SourceControlPanel.test.tsx` uses static markup to assert text and an attribute. The test does not invoke the tab callbacks, so it cannot detect broken tab interaction and violates the repository test rules.

The validation used both source inspection and direct Git reproductions:

- A committed file was changed, staged, and then restored in the working tree to its committed content. `git status --porcelain=v2` reported `MM`, `git diff HEAD` returned zero bytes, and `git diff --cached` returned the staged patch. This proves that the current hard-coded HEAD comparison can hide content that Commit will record.
- A new file was staged in an unborn repository and then removed from the working tree. `git diff --no-index -- /dev/null new.txt` exited 1, wrote no stdout, and wrote `error: Could not access 'new.txt'` to stderr. The current exit-code branch accepts that command as a successful empty diff.
- `refreshLocalStatus` replaces only the broadcaster's local cache value. Ahead and behind belong to the retained remote value, so a commit leaves them stale.
- The client has no capability check before it constructs `getWorkingTreeDiffQuery`. Existing optional capabilities establish the compatibility pattern for RPCs added after older servers shipped.

Rejected finding: the separate staged, unstaged, untracked, and conflicted Git queries remain intentional. The approved design requires these sets, and the review supplied no benchmark or timeout reproduction showing a performance regression.

## File structure

- `packages/contracts/src/environment.ts` defines the optional `gitIndexWorkflow` capability.
- `apps/server/src/environment/ServerEnvironment.ts` advertises that capability from new servers.
- `apps/web/src/components/ChatView.tsx` reads the active environment capability and passes it to Source Control.
- `apps/web/src/components/source-control/sourceControlPanel.logic.ts` derives allowed index actions, diff comparisons, and capability state.
- `apps/web/src/components/source-control/SourceControlPanel.tsx` renders the old-server fallback, mixed-state actions, and diff selector.
- `apps/server/src/vcs/GitVcsDriverCore.ts` rejects failed no-index diff commands instead of returning an empty patch.
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` supports a full status refresh that can skip an upstream fetch.
- `apps/server/src/ws.ts` uses that refresh after `git.commitIndex`.
- `docs/user/source-control.md` explains mixed staged/working-tree views and server-version fallback.

### Task 1: Gate per-file Git workflow RPCs under version skew

**Files:**

- Modify: `packages/contracts/src/environment.ts`
- Modify: `packages/contracts/src/environment.test.ts`
- Modify: `apps/server/src/environment/ServerEnvironment.ts`
- Modify: `apps/server/src/environment/ServerEnvironment.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

**Interfaces:**

- Produces: `ExecutionEnvironmentCapabilities.gitIndexWorkflow?: boolean`.
- Produces: `gitIndexWorkflowAvailability(capabilityKnown, supported): "loading" | "unsupported" | "available"`.
- Changes: `SourceControlPanelProps` gains `gitIndexWorkflowCapabilityKnown` and `supportsGitIndexWorkflow`.

- [ ] **Step 1: Write failing capability contract tests**

Add these assertions to `packages/contracts/src/environment.test.ts`:

```ts
it("treats a missing Git index workflow capability as unsupported", () => {
  expect(decodeDescriptor(descriptor).capabilities.gitIndexWorkflow).toBeUndefined();
});

it("preserves an advertised Git index workflow capability", () => {
  expect(
    decodeDescriptor({
      ...descriptor,
      capabilities: { ...descriptor.capabilities, gitIndexWorkflow: true },
    }).capabilities.gitIndexWorkflow,
  ).toBe(true);
});
```

Add `expect(second.capabilities.gitIndexWorkflow).toBe(true)` to the descriptor assertions in `apps/server/src/environment/ServerEnvironment.test.ts`.

- [ ] **Step 2: Run the capability tests and verify red**

Run:

```bash
vp test run packages/contracts/src/environment.test.ts apps/server/src/environment/ServerEnvironment.test.ts
```

Expected: both new assertions fail because the schema and server descriptor do not contain `gitIndexWorkflow`.

- [ ] **Step 3: Add and advertise the optional capability**

Add this field to `ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts`:

```ts
/** Server exposes per-file stage, unstage, bounded diff, and index-only commit RPCs. */
gitIndexWorkflow: Schema.optionalKey(Schema.Boolean),
```

Add `gitIndexWorkflow: true` beside `pullRequests: true` in `ServerEnvironment.ts`.

- [ ] **Step 4: Write failing web decision tests**

Add to `sourceControlPanel.logic.test.ts`:

```ts
it("does not use Git index workflow RPCs until support is advertised", () => {
  expect(gitIndexWorkflowAvailability(false, false)).toBe("loading");
  expect(gitIndexWorkflowAvailability(true, false)).toBe("unsupported");
  expect(gitIndexWorkflowAvailability(true, true)).toBe("available");
});
```

Expected production signature in `sourceControlPanel.logic.ts`:

```ts
export function gitIndexWorkflowAvailability(
  capabilityKnown: boolean,
  supported: boolean,
): "loading" | "unsupported" | "available" {
  if (!capabilityKnown) return "loading";
  return supported ? "available" : "unsupported";
}
```

- [ ] **Step 5: Run the web logic test and verify red**

Run: `vp test run apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

Expected: FAIL because `gitIndexWorkflowAvailability` does not exist.

- [ ] **Step 6: Thread capability state into Source Control**

In `ChatView.tsx`, derive capability state beside the pull-request capability:

```ts
const gitIndexWorkflowCapabilityKnown = serverConfig !== null;
const supportsGitIndexWorkflow = serverConfig?.environment.capabilities.gitIndexWorkflow === true;
```

Pass both values to `SourceControlPanel`. Keep `sourceControlAvailable={activeProject !== null}` because an older server can still provide status, branch controls, initialization, and the Pull requests view.

In `SourceControlPanel.tsx`, pass the values through to `ChangesView`. Apply these gates:

```ts
const workflowAvailability = gitIndexWorkflowAvailability(
  gitIndexWorkflowCapabilityKnown,
  supportsGitIndexWorkflow,
);
const workflowAvailable = workflowAvailability === "available";

const diffQuery = useEnvironmentQuery(
  workflowAvailable && selectedFile !== null && cwd !== null
    ? vcsEnvironment.getWorkingTreeDiffQuery({
        environmentId,
        input: { cwd, path: selectedFile.path, comparison: "head" },
      })
    : null,
);
```

`runIndexAction` and `submitCommit` must return before invoking a command when `workflowAvailable` is false. Include `workflowAvailable` in `canCommit`. Disable file mutation buttons while support is loading or unsupported. Show one inline message:

- loading: `Checking this server's Source Control capabilities...`
- unsupported: `Update this environment's T3 Code server to review diffs, stage files, or commit from this panel.`

Do not block the branch selector, initialization action, repository status, or Pull requests view.

- [ ] **Step 7: Run focused capability verification**

Run:

```bash
vp test run packages/contracts/src/environment.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/web/src/components/source-control/sourceControlPanel.logic.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
```

Expected: tests pass and all three typechecks exit 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts apps/server/src/environment/ServerEnvironment.ts apps/server/src/environment/ServerEnvironment.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/source-control/SourceControlPanel.tsx apps/web/src/components/source-control/sourceControlPanel.logic.ts apps/web/src/components/source-control/sourceControlPanel.logic.test.ts
git commit -m "fix: gate Git workflow RPCs by capability"
```

### Task 2: Expose staged and working-tree state without hiding errors

**Files:**

- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`
- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

**Interfaces:**

- Replaces: `fileAction(input)` with `fileActions(input): ReadonlyArray<SourceControlFileAction>`.
- Produces: `sourceControlDiffComparisons(input): ReadonlyArray<"index" | "head">`.
- Produces: `defaultSourceControlDiffComparison(input): "index" | "head"`.

- [ ] **Step 1: Write failing mixed-state presentation tests**

Replace the current single-action assertions in `sourceControlPanel.logic.test.ts` with:

```ts
it("offers both reverse operations for staged and modified files", () => {
  expect(fileActions({ indexStatus: "unstaged" }).map((action) => action.kind)).toEqual(["stage"]);
  expect(fileActions({ indexStatus: "staged" }).map((action) => action.kind)).toEqual(["unstage"]);
  expect(fileActions({ indexStatus: "both" }).map((action) => action.kind)).toEqual([
    "unstage",
    "stage",
  ]);
});

it("defaults commit-ready files to the index diff", () => {
  expect(defaultSourceControlDiffComparison({ indexStatus: "staged" })).toBe("index");
  expect(defaultSourceControlDiffComparison({ indexStatus: "both" })).toBe("index");
  expect(defaultSourceControlDiffComparison({ indexStatus: "unstaged" })).toBe("head");
  expect(defaultSourceControlDiffComparison({ indexStatus: "untracked" })).toBe("head");
  expect(sourceControlDiffComparisons({ indexStatus: "both" })).toEqual(["index", "head"]);
});
```

Define action objects with `kind: "stage" | "unstage" | "unavailable"`, their current labels, disabled state, and reason. Conflicted rows and rows without `indexStatus` return one disabled `Unavailable` action whose kind is `"unavailable"`. The component-level capability gate disables all actions when the server does not advertise the workflow RPCs.

- [ ] **Step 2: Run the presentation tests and verify red**

Run: `vp test run apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

Expected: FAIL because mixed rows have one Stage action and no comparison decision functions.

- [ ] **Step 3: Write failing driver tests for the masked no-index error**

Add this real-repository test in the existing working-tree diff group:

```ts
it.effect("does not turn a missing unborn worktree path into an empty diff", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* driver.initRepo({ cwd });
    yield* writeTextFile(cwd, "new.txt", "staged contents\n");
    yield* driver.stageFiles({ cwd, paths: ["new.txt"] });
    yield* fileSystem.remove(pathService.join(cwd, "new.txt"));

    const error = yield* driver
      .getWorkingTreeDiff({ cwd, path: "new.txt", comparison: "head" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "GitCommandError");

    const indexDiff = yield* driver.getWorkingTreeDiff({
      cwd,
      path: "new.txt",
      comparison: "index",
    });
    assert.include(indexDiff.diff, "+staged contents");
  }).pipe(Effect.provide(TestLayer)),
);
```

- [ ] **Step 4: Run the driver regression and verify red**

Run:

```bash
vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts -t "does not turn a missing unborn worktree path into an empty diff"
```

Expected: FAIL because the HEAD comparison succeeds with an empty `diff`.

- [ ] **Step 5: Implement explicit actions and comparisons in the panel**

Replace the single-action helper with these decisions in `sourceControlPanel.logic.ts`:

```ts
export interface SourceControlFileAction {
  readonly kind: "stage" | "unstage" | "unavailable";
  readonly label: "Stage" | "Unstage" | "Unavailable";
  readonly disabled: boolean;
  readonly reason: string;
}

const STAGE_ACTION = {
  kind: "stage",
  label: "Stage",
  disabled: false,
  reason: "Stage the complete file.",
} as const;
const UNSTAGE_ACTION = {
  kind: "unstage",
  label: "Unstage",
  disabled: false,
  reason: "Remove this file from the index.",
} as const;

export function fileActions(input: FileIndexState): ReadonlyArray<SourceControlFileAction> {
  switch (input.indexStatus) {
    case "staged":
      return [UNSTAGE_ACTION];
    case "unstaged":
    case "untracked":
      return [STAGE_ACTION];
    case "both":
      return [UNSTAGE_ACTION, STAGE_ACTION];
    case "conflicted":
      return [
        {
          kind: "unavailable",
          label: "Unavailable",
          disabled: true,
          reason: "Conflict resolution is not available in Source Control yet.",
        },
      ];
    case undefined:
      return [
        {
          kind: "unavailable",
          label: "Unavailable",
          disabled: true,
          reason: "This server does not report index state. Update T3 Code to enable staging.",
        },
      ];
  }
}

export function sourceControlDiffComparisons(
  input: FileIndexState,
): ReadonlyArray<"index" | "head"> {
  if (input.indexStatus === "both") return ["index", "head"];
  return input.indexStatus === "staged" ? ["index"] : ["head"];
}

export function defaultSourceControlDiffComparison(input: FileIndexState): "index" | "head" {
  return sourceControlDiffComparisons(input)[0] ?? "head";
}
```

Use `fileActions(file)` when rendering a row and pass the selected action kind to the command:

```ts
const runIndexAction = useCallback(
  async (file: VcsWorkingTreeFile, kind: "stage" | "unstage") => {
    if (cwd === null || !workflowAvailable) return;
    setPendingPath(file.path);
    setActionError(null);
    const result = await (kind === "unstage" ? unstage : stage)({
      environmentId,
      input: { cwd, paths: [file.path] },
    });
    setPendingPath(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(commandError(result));
    }
  },
  [cwd, environmentId, stage, unstage, workflowAvailable],
);
```

Render an unavailable action without calling `runIndexAction`. Call the function only when `action.kind` is `"stage"` or `"unstage"`; do not use a cast to narrow the kind.

Store the selected path and requested comparison. When the user selects a row, choose `defaultSourceControlDiffComparison(file)`. If a status update changes the selected file's `indexStatus`, fall back to the first allowed comparison when the current one is no longer valid.

For a `both` file, render two small comparison controls above the diff:

- `Staged` sends `comparison: "index"`.
- `Working tree` sends `comparison: "head"`.

For a staged-only file, request `index`. For unstaged, untracked, and conflicted files, request `head`. Replace the hard-coded `HEAD` label with `Staged vs HEAD` or `Working tree vs HEAD`.

- [ ] **Step 6: Reject no-index access failures**

In `GitVcsDriverCore.ts`, accept exit code 1 only when Git produced a patch:

```ts
const isExpectedNoIndexDifference =
  useUntrackedDiff && result.exitCode === 1 && result.stdout.length > 0;
if (result.exitCode !== 0 && !isExpectedNoIndexDifference) {
  return (
    yield *
    new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.getWorkingTreeDiff",
        cwd: input.cwd,
        args: diffArgs,
      }),
      detail: "Git working-tree diff failed.",
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    })
  );
}
```

Keep the existing output cap, truncation marker, `--literal-pathspecs`, `--no-ext-diff`, and `--no-textconv` arguments.

- [ ] **Step 7: Run focused diff and presentation verification**

Run:

```bash
vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts -t "working-tree diff|missing unborn|pathspec|textconv"
vp test run apps/web/src/components/source-control/sourceControlPanel.logic.test.ts packages/client-runtime/src/state/vcs.test.ts
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
```

Expected: the new regressions pass. If the broad driver pattern selects the known SSH fixture and it fails, rerun the named diff tests and report the fixture separately.

- [ ] **Step 8: Commit Task 2**

```bash
git add apps/web/src/components/source-control/sourceControlPanel.logic.ts apps/web/src/components/source-control/sourceControlPanel.logic.test.ts apps/web/src/components/source-control/SourceControlPanel.tsx apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "fix: expose staged Git file state"
```

### Task 3: Refresh divergence after an index commit

**Files:**

- Modify: `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- Modify: `apps/server/src/vcs/VcsStatusBroadcaster.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts`

**Interfaces:**

- Changes: `refreshStatus(cwd, options?: { refreshUpstream?: boolean })`.
- Consumes: `workflow.remoteStatus({ cwd }, { refreshUpstream: false })`.

- [ ] **Step 1: Write a failing broadcaster option-forwarding test**

In `VcsStatusBroadcaster.test.ts`, use the existing workflow mock and call:

```ts
yield * broadcaster.refreshStatus("/repo", { refreshUpstream: false });

assert.deepEqual(remoteStatus.mock.calls.at(-1), [{ cwd: "/repo" }, { refreshUpstream: false }]);
```

Keep the existing assertion that `refreshStatus` publishes one snapshot containing fresh local and remote values. Also assert that the no-fetch path increments `localInvalidationCalls` but leaves `remoteInvalidationCalls` unchanged. This proves that the path does not call `invalidateStatus`, which also expires the pull-request lookup cache.

- [ ] **Step 2: Write a failing WebSocket commit-refresh test**

In the existing `routes websocket rpc git methods` test in `server.test.ts`, track full refreshes separately:

```ts
const indexCommitRefresh = yield* Deferred.make<void>();
let fullRefreshCalls = 0;
const fullStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
} as const;

// In the VcsStatusBroadcaster mock:
refreshStatus: (_cwd, options) =>
  Effect.sync(() => {
    fullRefreshCalls += 1;
    return options;
  }).pipe(
    Effect.tap((options) =>
      options?.refreshUpstream === false
        ? Deferred.succeed(indexCommitRefresh, undefined)
        : Effect.void,
    ),
    Effect.as(fullStatus),
  ),
```

After calling `git.commitIndex`, await `indexCommitRefresh`, assert `localRefreshCalls === 2`, and assert that the first full refresh received `{ refreshUpstream: false }`.

- [ ] **Step 3: Run the two tests and verify red**

Run:

```bash
vp test run apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/server/src/server.test.ts -t "refreshStatus|routes websocket rpc git methods"
```

Expected: FAIL because `refreshStatus` has no options parameter and `git.commitIndex` calls `refreshLocalStatus`.

- [ ] **Step 4: Add the no-fetch full refresh option**

Change the service interface and implementation in `VcsStatusBroadcaster.ts`:

```ts
readonly refreshStatus: (
  cwd: string,
  options?: { readonly refreshUpstream?: boolean },
) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
```

Pass `options` to `workflow.remoteStatus({ cwd }, options)` inside `refreshStatus`. Select the invalidation by mode:

```ts
if (options?.refreshUpstream === false) {
  yield * workflow.invalidateLocalStatus(cwd);
} else {
  yield * workflow.invalidateStatus(cwd);
}
```

Keep the concurrent local and remote reads. `remoteStatus({ cwd }, { refreshUpstream: false })` bypasses the remote status result cache and recomputes ahead and behind against the existing upstream ref. It also reuses the pull-request lookup cache. The default path retains `invalidateStatus(cwd)` so explicit full refreshes keep their current behavior.

- [ ] **Step 5: Use the full no-fetch refresh after commit**

Add a WebSocket helper beside the existing refresh helpers:

```ts
const refreshGitStatusWithoutFetch = (cwd: string) =>
  vcsStatusBroadcaster
    .refreshStatus(cwd, { refreshUpstream: false })
    .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
```

Use it only after `gitWorkflow.commitIndex(input)`. Keep stage and unstage on `refreshLocalGitStatus`; they do not move HEAD.

- [ ] **Step 6: Run focused status verification**

Run:

```bash
vp test run apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/server/src/server.test.ts -t "refreshStatus|routes websocket rpc git methods"
vp run --filter t3 typecheck
```

Expected: tests pass and the server typecheck exits 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/server/src/vcs/VcsStatusBroadcaster.ts apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/server/src/ws.ts apps/server/src/server.test.ts
git commit -m "fix(server): refresh divergence after index commits"
```

### Task 4: Remove the static shell test and document the finished behavior

**Files:**

- Delete: `apps/web/src/components/source-control/SourceControlPanel.test.tsx`
- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `docs/user/source-control.md`

**Interfaces:**

- Removes: test-only exports `SourceControlPanelContentProps` and `SourceControlPanelContent` if no production caller imports them.
- Documents: mixed-state actions, staged/working-tree diff choices, and old-server behavior.

- [ ] **Step 1: Delete the prohibited test and narrow the component export**

Delete `SourceControlPanel.test.tsx`. If `rg -n "SourceControlPanelContent" apps/web/src` finds no production import, make the props interface and component local to `SourceControlPanel.tsx`:

```ts
interface SourceControlPanelContentProps {
  readonly view: SourceControlPanelView;
  readonly onViewChange: (view: SourceControlPanelView) => void;
  readonly changes: ReactNode;
  readonly pullRequests: ReactNode;
}
```

Remove the `export` keyword from the existing `SourceControlPanelContent` function declaration and leave its body unchanged.

Do not replace it with another static render or callback-wiring test. Task 2's pure decision tests cover action and comparison rules; the existing runtime tests cover exact diff query cancellation.

- [ ] **Step 2: Update user documentation**

Replace the file-action paragraph in `docs/user/source-control.md` with:

```md
Click **Stage** or **Unstage** to change a complete file in the Git index. A file that is both
staged and modified offers both actions. Its diff can switch between **Staged** and **Working
tree**, so you can inspect what Commit will record and what remains outside the index. Source
Control does not support partial staging by hunk.

When the connected environment runs an older T3 Code server, repository status, branches, Git
initialization, and pull requests remain available. Update that server before using per-file diffs,
staging, unstaging, or index-only commits from Source Control.
```

- [ ] **Step 3: Run final focused automated verification**

Run:

```bash
vp test run packages/contracts/src/environment.test.ts packages/contracts/src/git.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/server/src/server.test.ts packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/source-control/sourceControlPanel.logic.test.ts apps/web/src/rightPanelStore.test.ts apps/web/src/components/right-panel/rightPanelSurfaceActions.test.ts apps/web/src/components/RightPanelTabs.test.tsx
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/web typecheck
git diff --check 8f7b05edb30e2620bfacf5a6c4b31c8ec7576845...HEAD
git status --short
```

Expected: all affected tests except the documented pre-existing SSH fixture pass; all typechecks exit 0; no whitespace errors appear; the implementation plan remains untracked.

- [ ] **Step 4: Request permission for one integrated web pass**

Before using a browser, ask the user for approval as required by `AGENTS.md`. If approved, use `test-t3-app` once against an isolated seeded environment and verify:

1. A `both` file shows Stage and Unstage.
2. Staged and Working tree diff controls send the expected comparison and cancel the previous request.
3. Committing clears the staged list and updates ahead count without waiting for the remote poll interval.
4. Pull requests remain reachable from the Source Control view.

If browser use is not approved, report this integrated pass as not run rather than implying coverage.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/web/src/components/source-control/SourceControlPanel.tsx apps/web/src/components/source-control/SourceControlPanel.test.tsx docs/user/source-control.md
git commit -m "test(web): remove static source control assertions"
```

### Final review follow-up: refresh selected diffs after index mutations

Post-implementation validation found that a selected mixed file could retain a stale cached
`index` diff after **Stage** or **Unstage**. The query key is stable across those mutations, so
the affected mounted diff queries must be refreshed after a successful index operation.

- [x] Add an `onSuccess` refresh to the stage and unstage client-runtime commands for affected
      paths and both diff comparisons.
- [x] Add a client-runtime regression that mounts an `index` diff, stages a file, and requires a
      second diff RPC.
- [x] Run the focused VCS test and client-runtime typecheck.

## Plan review

- Spec coverage: every validated finding maps to Tasks 1 through 4, with the final review follow-up
  covering cache invalidation after index mutations. Version skew preserves the Pull requests view
  and existing branch/status behavior.
- Type consistency: `gitIndexWorkflow` is optional in the wire contract, advertised as `true` by new servers, and consumed as strict `=== true` in the web client. Diff comparison values remain the existing `"index" | "head"` contract.
- Scope: no mobile UI, polling, hunk staging, discard, conflict resolution, or remote-management behavior is added.
- Test quality: static markup is removed. New automated tests exercise schema compatibility, pure state decisions, real Git repositories, broadcaster events, and WebSocket routing. The post-commit test also proves that the no-fetch refresh does not expire the pull-request lookup cache.
- Placeholder scan: the plan contains no deferred implementation steps. Browser verification is explicitly permission-gated by repository policy.
