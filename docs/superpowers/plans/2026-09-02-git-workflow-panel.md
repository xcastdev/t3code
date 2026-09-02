# Git workflow panel implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add one right-panel Source Control workflow for changes, diffs, pull requests, staging, commits, and branch changes.

**Architecture:** Extend the existing Git VCS driver with explicit index and working-tree diff operations, expose them through current WebSocket and Effect Atom paths, and consolidate changes and pull requests in one source-control surface. Status remains stream-driven through `VcsStatusBroadcaster`; the panel does not poll. Remove the header Git action control and the redundant Diff and Pull Requests rail actions.

**Tech Stack:** TypeScript, Effect, Effect Schema, Git CLI, React, Effect Atom, Base UI.

**Spec:** `docs/superpowers/specs/2026-09-02-git-workflow-panel-design.md`

## Global constraints

- Support Git repositories only.
- Stage and unstage complete files only. Do not add hunk staging.
- Remove `GitActionsControl` from the chat header, including the "Commit & Push" selector.
- Replace the Diff and Pull Requests rail actions with one Source Control action.
- Keep the bottom-left pull-request shortcut. It opens Source Control's Pull requests view.
- Use the VCS status stream after index changes. Do not add polling.
- Confirm dirty-tree branch switches and default-branch commits.
- Do not add mobile UI.
- Run focused tests only. Do not run repository-wide checks.

## File structure

- `packages/contracts/src/git.ts` defines index state, index mutation, and diff RPC types.
- `apps/server/src/vcs/GitVcsDriver.ts` declares VCS index and diff methods.
- `apps/server/src/vcs/GitVcsDriverCore.ts` executes bounded Git commands and validates paths.
- `apps/server/src/git/GitWorkflowService.ts` exposes operations to the WebSocket layer.
- `apps/server/src/ws.ts` routes operations and refreshes local status.
- `packages/client-runtime/src/state/vcs.ts` creates typed VCS atoms; `apps/web/src/state/vcs.ts` remains its web wrapper.
- `apps/web/src/components/source-control/SourceControlPanel.tsx` renders the panel.
- `apps/web/src/components/pullRequest/` supplies existing list and detail content for its Pull requests view.
- `apps/web/src/components/right-panel/rightPanelSurfaceActions.tsx` adds the rail action.
- `apps/web/src/rightPanelStore.ts` registers the persisted panel kind.
- `apps/web/src/components/RightPanelTabs.tsx` renders the new panel kind.

### Task 1: Add index-state and diff contracts

**Files:**

- Modify: `packages/contracts/src/git.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Test: `packages/contracts/src/git.test.ts`

**Produces:** optional `VcsWorkingTreeFile.indexStatus`, index mutation and diff inputs, plus `GitCommitIndexInput`.

- [ ] **Step 1: Write failing schema tests**

```ts
it("decodes a file with staged and unstaged changes", () => {
  expect(
    decodeVcsStatus({
      workingTree: {
        files: [
          {
            path: "src/a.ts",
            insertions: 2,
            deletions: 1,
            indexStatus: "both",
          },
        ],
        insertions: 2,
        deletions: 1,
      },
    }),
  ).toBeDefined();
});
```

- [ ] **Step 2: Run the focused test**

Run: `vp test run packages/contracts/src/git.test.ts`

Expected: FAIL because index state is absent.

- [ ] **Step 3: Add contracts and RPC methods**

```ts
export const VcsIndexStatus = Schema.Literals([
  "staged",
  "unstaged",
  "both",
  "untracked",
  "conflicted",
]);
export const VcsStageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  paths: NonEmptyPaths,
});
export const VcsWorkingTreeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  comparison: Schema.Literals(["index", "head"]),
});
```

Define `vcs.stageFiles`, `vcs.unstageFiles`, `vcs.getWorkingTreeDiff`, and `git.commitIndex`. Make `indexStatus` optional and add a legacy-event decode test. Return `{ diff, truncated }` for a diff.

- [ ] **Step 4: Run the focused test**

Run: `vp test run packages/contracts/src/git.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/git.ts packages/contracts/src/git.test.ts packages/contracts/src/rpc.ts
git commit -m "feat(contracts): add Git index operations"
```

### Task 2: Implement safe Git index and diff commands

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriver.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.test.ts`
- Modify: `apps/server/src/git/GitWorkflowService.ts`
- Modify: `apps/server/src/git/GitWorkflowService.test.ts`

**Consumes:** Task 1 inputs.

**Produces:** `stageFiles`, `unstageFiles`, `getWorkingTreeDiff`, and `commitIndex` through `GitWorkflowService`.

- [ ] **Step 1: Write failing driver tests with a temporary Git repository**

```ts
it.effect("unstages a file without changing its working tree", () =>
  Effect.gen(function* () {
    yield* driver.stageFiles({ cwd, paths: ["a.txt"] });
    yield* driver.unstageFiles({ cwd, paths: ["a.txt"] });
    assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
    assert.equal(yield* readFile(`${cwd}/a.txt`), "changed\n");
  }).pipe(Effect.provide(testLayer)),
);
```

- [ ] **Step 2: Run the focused driver test**

Run: `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts`

Expected: FAIL because the driver has no index methods.

- [ ] **Step 3: Implement guarded commands**

Resolve the selected working directory to the Git root. Validate each literal root-relative path, reject escape and symlink escapes, and then use `git add -- <paths>` to stage. Use `git restore --staged -- <paths>` when HEAD exists and the safe initial-repository equivalent when it does not. Diff untracked files by reading their bounded contents or return a clear no-diff result. For tracked diffs, use `git diff --no-ext-diff --patch --minimal` with `--cached` for `index` and `HEAD` for `head`. Cap returned bytes and set `truncated` when the cap is reached. Implement `commitIndex` with `git commit -m <message>` only. It must never call `git add`.

- [ ] **Step 4: Extend status parsing**

Derive `indexStatus` from separate staged and unstaged results. Mark a path `both` when it appears in both, preserve untracked files, and report conflicts distinctly. Test initial repositories, untracked files, conflicts, rename and delete records, nested working directories, worktrees, glob-like paths, and symlink escapes.

- [ ] **Step 5: Run focused server tests**

Run: `vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/git/GitWorkflowService.test.ts`

Expected: PASS, including outside-root rejection and bounded diff output.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/vcs apps/server/src/git
git commit -m "feat(server): manage Git index files"
```

### Task 3: Route mutations and refresh the status stream

**Files:**

- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts`
- Modify: `packages/client-runtime/src/state/vcs.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Test: the matching client-runtime VCS state test

**Consumes:** Task 2 workflow methods.

**Produces:** Client atoms for stage, unstage, and diff. Each successful index mutation triggers a background local status refresh.

- [ ] **Step 1: Write a failing WebSocket test**

```ts
it.effect("refreshes local VCS status after staging files", () =>
  Effect.gen(function* () {
    yield* callRpc("vcs.stageFiles", { cwd, paths: ["a.ts"] });
    expect(refreshLocalStatusCalls).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);
```

- [ ] **Step 2: Run the focused test**

Run: `vp test run apps/server/src/server.test.ts`

Expected: FAIL because the RPC is not registered.

- [ ] **Step 3: Add handlers and atoms**

Register the RPCs in the WebSocket RPC group and choose their exact authorization scopes in `RpcAuthorization.ts`. Use existing VCS error mapping in `ws.ts`. After a successful stage or unstage call, fork only `VcsStatusBroadcaster.refreshLocalStatus(cwd)`. Add matching `vcsEnvironment.stageFiles`, `unstageFiles`, `getWorkingTreeDiff`, and `commitIndex` atoms in client runtime.

- [ ] **Step 4: Run focused tests**

Run: `vp test run apps/server/src/server.test.ts packages/client-runtime/src/state/vcs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/server.test.ts apps/server/src/auth/RpcAuthorization.ts packages/client-runtime/src/state/vcs.ts packages/client-runtime/src/state/vcs.test.ts
git commit -m "feat(web): expose Git index actions"
```

### Task 4: Build the right-panel source-control UI

**Files:**

- Create: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Create: `apps/web/src/components/source-control/SourceControlPanel.test.tsx`
- Create: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Create: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`
- Modify: `apps/web/src/components/right-panel/rightPanelSurfaceActions.tsx`
- Modify: `apps/web/src/rightPanelStore.ts`
- Modify: `apps/web/src/rightPanelStore.test.ts`
- Modify: `apps/web/src/components/RightPanelTabs.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/sidebar/SidebarChrome.tsx`
- Modify: the existing Diff and Pull Requests rail-action tests

**Consumes:** Task 3 atoms and existing branch selector commands.

**Produces:** One right-panel Source Control surface with Changes and Pull requests views.

- [ ] **Step 1: Write failing presentation tests**

```ts
it("shows unstage for a staged file", () => {
  expect(fileAction({ indexStatus: "staged" })).toMatchObject({ label: "Unstage" });
});
it("requires confirmation before switching a dirty tree", () => {
  expect(needsDirtyBranchConfirmation(true)).toBe(true);
});
it("opens Source Control on Pull requests from the bottom-left shortcut", () => {
  expect(pullRequestShortcutTarget()).toEqual({ kind: "source-control", view: "pull-requests" });
});
```

- [ ] **Step 2: Run focused UI tests**

Run: `vp test run apps/web/src/components/source-control/sourceControlPanel.logic.test.ts apps/web/src/components/source-control/SourceControlPanel.test.tsx`

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement the panel**

Subscribe through the existing status atom. Render a Changes view with repository state, branch, ahead and behind counts, file rows, and a selected-file diff. Reuse the current pull-request list and detail components inside a Pull requests view. Call Task 3 atoms for whole-file staging actions. Keep the commit message in local state. Submit `commitIndex`, not `useGitStackedAction`. Assert that an unstaged sibling remains uncommitted. When the stream removes or renames a selected path, close its diff. Cancel an in-flight diff request when the selection changes. A non-Git panel offers the existing initialization action.

- [ ] **Step 4: Add confirmations**

Use the dialog components, but add panel-specific default-branch commit confirmation because `GitActionsControl.logic.ts` excludes commits. If the tree is dirty, require confirmation before `vcsEnvironment.switchRef` and before creating a branch with `switchRef: true`. Preserve the commit message and selected diff when a command fails or a cross-client status update arrives.

- [ ] **Step 5: Register the rail action**

Add the `source-control` kind to the right-panel store's union, singleton rules, persistence decoder, and tests. Add its title, icon, and exhaustive renderer to `RightPanelTabs.tsx`. Replace the separate Diff and Pull Requests actions in `rightPanelSurfaceActions.tsx` with one Source Control action. Delete the header `GitActionsControl` use from `ChatHeader.tsx`. Keep the bottom-left pull-request button in `SidebarChrome.tsx`, but make it open Source Control with the Pull requests view selected. Keep terminal and preview surfaces unchanged.

- [ ] **Step 6: Run focused UI tests**

Run: `vp test run apps/web/src/components/source-control/sourceControlPanel.logic.test.ts apps/web/src/components/source-control/SourceControlPanel.test.tsx apps/web/src/components/right-panel/rightPanelSurfaceActions.test.ts apps/web/src/components/RightPanelTabs.test.tsx apps/web/src/components/sidebar/SidebarChrome.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/source-control apps/web/src/components/right-panel/rightPanelSurfaceActions.tsx apps/web/src/components/RightPanelTabs.tsx apps/web/src/rightPanelStore.ts apps/web/src/rightPanelStore.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/chat/ChatHeader.tsx apps/web/src/components/sidebar/SidebarChrome.tsx
git commit -m "feat(web): add Git workflow panel"
```

### Task 5: Document the panel

**Files:**

- Create: `docs/user/source-control.md`
- Modify: the applicable user-doc navigation file

- [ ] **Step 1: Write the user guide**

Explain the Changes and Pull requests views, whole-file staging, index-only commits, and the confirmation before changing a dirty branch. State that the panel replaces the Diff and Pull Requests rail buttons and the header "Commit & Push" control. State that the bottom-left pull-request shortcut remains. State that partial staging and conflict resolution are not available.

- [ ] **Step 2: Commit the documentation**

Commit the two user documentation files with `docs: explain the source control panel`.

## Plan review

The tasks cover truthful index state, bounded diffs, complete-file staging, status refresh, index-only commits, branch safeguards, the consolidated Changes and Pull requests panel, removal of redundant rail and header controls, and user docs. They leave partial staging, discard, and conflict handling untouched. The feature plans share `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts`; use separate worktrees, but rebase the second branch before integration and expect a small hotspot conflict.
