# Git workflow panel completion remediation implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task, and `superpowers:test-driven-development` for every behavior change.

**Goal:** Close the remaining correctness and performance gaps in the Git workflow panel under concurrent clients, external Git mutations, server version skew, and adversarial diff input.

**Architecture:** Make safety decisions at the server boundary from repository state read in the same serialized repository operation as the mutation. Publish a monotonic local Git revision with status snapshots so every client can invalidate an open diff even when the visible status classification is unchanged. Keep the old-server fallback explicit, and bound both diff bytes and rendered line count.

**Tech stack:** TypeScript, Effect Schema, Effect, Effect Atom, React, Git CLI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-git-workflow-panel-design.md`

## Constraints

- Keep this feature web/desktop only; do not add mobile UI.
- Preserve whole-file stage/unstage, literal path handling, symlink containment, NUL parsing, textconv, bounded output, and no-fetch post-commit refresh.
- Keep status stream-driven. Do not poll.
- A stale precondition must fail closed and must never silently broaden a commit.
- Existing callers that do not use the new guarded workflow must retain their current behavior.
- Add behavior tests, not static markup or callback-wiring assertions.
- Run focused checks only. Do not commit this plan.

## Validated findings

1. **High — confirmations use stale client state.** Dirty-tree branch confirmation and default-branch commit confirmation read the latest streamed snapshot. A filesystem edit or ref switch can occur before the RPC reaches the server, allowing the operation without the required confirmation.
2. **High — an index commit has no reviewed-state precondition.** Another client or process can change HEAD, the current ref, or the index after review; `git commit` then records content or a branch the user did not approve.
3. **High — open diffs can remain stale.** A successful commit changes the meaning of `comparison: "head"` without changing its query key. Mutations from another client can also change index content while leaving `indexStatus` unchanged, so command-local invalidation is insufficient.
4. **Medium — old-server diff fallback lies.** When the workflow capability is unavailable, selecting a file passes `null` to the preview and renders “No changes for this file” instead of saying that diff review is unavailable.
5. **Medium — the byte bound does not bound React work.** A 120 KB patch containing very short lines can create tens of thousands of `<span>` nodes and stall the panel.
6. **Low — branch confirmation lacks a behavior test.** The current helper test survives deletion of the actual confirmation call.

Rejected after validation: mobile parity is outside the approved scope; the legacy `diff` surface remains the supported thread-review panel; preserving draft state across Changes/Pull requests was not specified; and the extra status commands still have no measured regression that justifies replacing their unusual-path-safe implementation.

---

## Task 1: Add repository-state preconditions to the contracts

**Files:**

- Modify: `packages/contracts/src/vcs.ts`
- Modify: `packages/contracts/src/git.ts`
- Modify: `packages/contracts/src/vcs.test.ts`
- Modify: `packages/contracts/src/git.test.ts`

- [ ] Write failing schema tests for a status snapshot containing `localRevision`, `headCommit`, and `indexTree`, all optional for compatibility when decoding older servers.
- [ ] Write failing schema tests for guarded mutations. Extend the inputs as follows:

```ts
export const GitMutationPrecondition = Schema.Struct({
  expectedHeadCommit: Schema.NullOr(Schema.String),
  expectedIndexTree: Schema.String,
});

export const GitCommitIndexInput = Schema.Struct({
  cwd: Schema.String,
  message: Schema.String,
  precondition: Schema.optional(GitMutationPrecondition),
  confirmDefaultRef: Schema.optional(Schema.Boolean),
});

export const VcsSwitchRefInput = Schema.Struct({
  cwd: Schema.String,
  refName: Schema.String,
  confirmDirtyWorkingTree: Schema.optional(Schema.Boolean),
});
```

- [ ] Add typed mutation rejection codes to the existing Git/VCS RPC error schema: `dirty_worktree_confirmation_required`, `default_ref_confirmation_required`, and `stale_git_state`.
- [ ] Run `vp test run packages/contracts/src/vcs.test.ts packages/contracts/src/git.test.ts` and confirm the new tests pass.
- [ ] Run the contracts package typecheck used by this repository.

## Task 2: Enforce the checks in one serialized server operation

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriver.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Modify: `apps/server/src/git/GitWorkflowService.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.test.ts`
- Modify: `apps/server/src/git/GitWorkflowService.test.ts`
- Modify: `apps/server/src/server.test.ts`

- [ ] Add failing driver tests proving a dirty checkout returns `dirty_worktree_confirmation_required` before `switchRef` unless `confirmDirtyWorkingTree: true` is supplied.
- [ ] Add failing commit tests proving the command rejects when HEAD or `git write-tree` differs from the supplied precondition, and rejects a default-ref commit unless `confirmDefaultRef: true` is supplied.
- [ ] Add a repository-keyed Effect semaphore in `GitWorkflowService`; resolve the canonical repository identity first, then hold its permit across preflight and mutation. Stage, unstage, switch, and commit for the same repository must share this permit.
- [ ] In the permit, read `rev-parse --verify HEAD`, `symbolic-ref --short -q HEAD`, `write-tree`, and porcelain status. Compare exact values and return the typed rejection before invoking checkout or commit.
- [ ] Preserve compatibility by applying guarded behavior only when a precondition/confirmation field is present. Existing non-panel callers without these fields keep their current behavior.
- [ ] Ensure the WebSocket handler forwards typed rejections unchanged and refreshes status after both success and stale-state rejection.
- [ ] Run the three focused server test files and the server typecheck.

## Task 3: Publish a monotonic local Git revision

**Files:**

- Modify: `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- Modify: `apps/server/src/vcs/VcsStatusBroadcaster.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `packages/client-runtime/src/state/vcs.ts`
- Modify: `packages/client-runtime/src/state/vcs.test.ts`

- [ ] Write a broadcaster test proving every accepted local refresh increments `localRevision`, including two snapshots whose paths and `indexStatus` values are equal.
- [ ] Store the revision per canonical repository in the broadcaster and include it in every local status snapshot/event. Do not use wall-clock time.
- [ ] Write a client-runtime test that mounts a working-tree diff query, applies a status event with a newer `localRevision`, and observes a second diff RPC for the same cwd/path/comparison.
- [ ] Track mounted diff queries by environment and cwd in `vcs.ts`. On a newer streamed local revision, refresh only mounted queries for that repository; do not prefetch unmounted paths.
- [ ] Remove mutation-specific refresh code only if the revision test proves same-client stage, unstage, and commit all publish before command completion. Otherwise retain it as an immediate refresh and use the revision as the cross-client backstop.
- [ ] Run `vp test run apps/server/src/vcs/VcsStatusBroadcaster.test.ts packages/client-runtime/src/state/vcs.test.ts` and the two scoped typechecks.

## Task 4: Send reviewed state and handle server rejections in the web client

**Files:**

- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `apps/web/src/components/BranchToolbarBranchSelector.tsx`
- Add: `apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx`
- Add: `apps/web/src/components/BranchToolbarBranchSelector.interaction.test.tsx`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

- [ ] Add an interaction test that reviews a staged file, changes the mocked streamed HEAD/index token, clicks Commit, and proves no commit RPC is sent until the panel refreshes.
- [ ] Send `expectedHeadCommit` and `expectedIndexTree` from the rendered status snapshot. Set `confirmDefaultRef` only after the user confirms. On `stale_git_state`, retain the message, refresh status/diff, and show “Repository changed; review the staged changes and try again.”
- [ ] Add interaction tests proving Cancel prevents both checkout and create-and-checkout, and proving a server `dirty_worktree_confirmation_required` response opens confirmation then retries once with `confirmDirtyWorkingTree: true`.
- [ ] Treat the server rejection as authoritative. The streamed status may decide whether to show the first confirmation proactively, but must not bypass the server retry protocol.
- [ ] Delete the identity-only dirty-confirmation helper/test if it has no remaining production use.
- [ ] Run both interaction tests plus `sourceControlPanel.logic.test.ts`, then the web typecheck.

## Task 5: Make unsupported and empty diff states distinct

**Files:**

- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

- [ ] Add a failing state-model test distinguishing `loading`, `unsupported`, `error`, `empty`, and `ready`.
- [ ] Change `DiffPreview` to accept that explicit state rather than interpreting `null` as an empty successful response.
- [ ] For unsupported servers render: “Diff review requires a newer T3 Code server.” Disable comparison controls and do not construct the RPC query.
- [ ] Keep “No changes for this file” only for a successful response whose `diff` is empty.
- [ ] Run the focused logic and interaction tests and the web typecheck.

## Task 6: Bound diff rendering by lines as well as bytes

**Files:**

- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Modify: `apps/server/src/vcs/GitVcsDriverCore.test.ts`
- Modify: `apps/web/src/components/source-control/SourceControlPanel.tsx`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.ts`
- Modify: `apps/web/src/components/source-control/sourceControlPanel.logic.test.ts`

- [ ] Add a server test with more than 4,000 one-character diff lines and assert the response stops at the last complete line at or before both the byte and line limits, with `truncated: true`.
- [ ] Implement one shared truncation function with `MAX_WORKING_TREE_DIFF_BYTES = 120_000` and `MAX_WORKING_TREE_DIFF_LINES = 4_000`. Never split a UTF-8 code point or return a partial line.
- [ ] Add a UI logic test proving a 4,000-line payload creates a bounded render model. Render contiguous same-tone lines as one text run rather than one React element per line; preserve addition, deletion, hunk, and context colors.
- [ ] Keep the truncation notice visible for either server-side bound.
- [ ] Run the focused driver and web tests and their scoped typechecks.

## Task 7: Final focused verification

- [ ] Run `git diff --check`.
- [ ] Run all test files changed by Tasks 1–6 in one focused `vp test run` invocation.
- [ ] Run scoped typechecks for contracts, server, client-runtime, and web.
- [ ] Re-run the mixed-file Git reproductions: stage/unstage both directions, commit after an unstaged edit, external index mutation with unchanged classification, dirty switch, and default-ref commit.
- [ ] Request permission before any browser/computer-use pass. If granted, verify Source Control in the real web client, including an old-server capability fixture and two connected clients. Desktop inherits the web surface; mobile remains out of scope.
- [ ] Record command output and any known unrelated failure separately. Do not claim completion from historical test output.

## Self-review checklist

- [ ] Confirm server checks and mutation occur under the same repository permit.
- [ ] Confirm stale-state errors preserve the commit draft and force re-review.
- [ ] Confirm same-client and cross-client mutations refresh an already-open diff.
- [ ] Confirm an older server never receives a new workflow RPC and never displays “No changes” for unavailable data.
- [ ] Confirm worst-case diff rendering creates a bounded number of React nodes.
- [ ] Confirm no mobile UI, polling, fetch-on-commit, or planning artifact was added to a commit.
