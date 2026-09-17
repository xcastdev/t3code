Github Tracked: false
Status: in_progress
Github Issue: none

# Provider-aware Source Control workspace

## Goal

Make Source Control a provider-aware, repository-scoped workspace that owns Git workflows,
working-tree review, commit generation, history graph navigation, and Git menus while preserving
the right sidebar as the aggregate view and the secondary pane as the single-file editor/diff view.

## Scope

- In: Web and desktop Source Control, Git contracts and server implementation, shared
  client-runtime Source Control state/actions, right rail and command entry points, aggregate
  Diff routing, secondary-pane file/diff surfaces, Source Control settings, focused docs and tests.
- Out: Mobile UI redesign, Clone, Git Output, automatic Git initialization, changes to the
  existing terminal-bottom-dock migration, provider-specific Git hosting APIs beyond the current
  pull-request integration.

## Decisions

- The active repository is one discovered repository within the active project/worktree. Its
  canonical repository root plus environment identify all status, actions, labels, and diffs.
  The selector persists per thread and falls back to the project/worktree root when its selection
  disappears.
- Discovery includes the project/worktree repository, initialized submodules, and unrelated nested
  Git repositories. It never initializes repositories. It follows Git's reported submodule paths,
  scans bounded project directories while skipping `.git`, dependency, build, and ignored folders,
  reports truncation, and offers Refresh.
- The shared Source Control controller lives in `packages/client-runtime`; it owns scoped queries,
  mutations, confirmation policy, stale-request guards, action progress, and invalidation. Web
  components only render it. Server-side Git logic remains behind typed contracts.
- The right sidebar Diff surface is aggregate-only for the active repository and selected scope
  (branch/base, working tree, or existing turn/checkpoint). It never becomes a one-file view.
  Selecting a file anywhere opens a repository- and comparison-scoped secondary-pane diff tab.
- Secondary-pane minimize means hidden with tabs retained. Minimize and Maximize/Restore are
  icon-only controls immediately left of the bottom-dock icon; restore returns the pre-minimize
  normal or maximized state.
- Plain Commit is the sole commit action without a confirmation dialog. Stage, unstage, fetch,
  refresh, generate, view, and sort also require no dialog. Every other mutation confirms once
  before it starts. Compound actions report the completed step on failure and never replay a
  completed commit during retry.
- Commit (Amend) uses normal Git amend behavior. With an empty message it reuses the previous
  commit message. A plain empty Commit remains disabled. Commit & Sync performs commit, pull using
  the configured strategy, then push. Commit & Publish Branch is used for unpushed local commits
  on a branch without an upstream.
- Graph v1 is read-only. It pages in timestamp/topological order, preserves lane continuity by
  retaining graph state across cursors, renders only lanes, subjects, and local/remote/tag
  decorations, lazily loads commit files on expansion, and excludes T3 checkpoint refs.

## Global constraints

- Preserve unrelated user changes in `apps/web/src/components/settings/IntegrationsSettings.tsx`,
  `apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx`, and untracked
  `apps/mobile/**/.gradle/` directories.
- Mobile UI redesign remains out of scope, but shared contracts must remain additive and decodable
  by clients that do not advertise the Source Control workspace capability.
- Every changed behavior starts with a focused failing test that demonstrates the user-visible or
  contract-level failure. Each task must pass its focused gate and receive a task-scoped review
  before dependent work starts.
- Git mutations use the selected environment plus canonical repository root. No command may derive
  its target from the project root after repository selection has been resolved.
- Plain Commit, stage, unstage, fetch, refresh, generation, view, and sort do not confirm. Every
  other mutation confirms exactly once. No UI caller may bypass the shared policy.
- Aggregate Diff retains its own repository/comparison scope. A one-file selection always opens a
  secondary-pane diff with an immutable or explicitly live comparison descriptor.
- No repository-wide test, typecheck, or lint command. Use the exact focused commands below and
  package-scoped typechecks.
- Do not start a server or browser until all automated and source-review gates pass.

## Acceptance criteria

### Provider identity

- [ ] AC-1: The icon rail, Source Control surface tab, panel heading, close tooltip, and accessible labels display the active repository's configured provider name.
- [ ] AC-2: These locations fall back to `Source Control` when provider identity is unavailable.
- [ ] AC-3: Switching the active repository updates the name and provider icon without reopening the surface.
- [ ] AC-4: Provider names also update when repository status or provider configuration changes.

### Repository workspace and tabs

- [ ] AC-5: The panel presents a visible tab strip ordered `Changes`, `Graph`, `Pull Requests`.
- [ ] AC-6: Hover, keyboard focus, and selected states make the tabs and active view unmistakable.
- [ ] AC-7: The tabs expose correct tab-list semantics and keyboard navigation.
- [ ] AC-8: The former Commit/Push/Create PR header control is removed.
- [ ] AC-9: Each repository has a clean header showing its name, relative path when needed, active branch, sync state, refresh control, and More Actions menu.
- [ ] AC-10: In a single-repository project, redundant repository chrome may collapse, but the More Actions menu remains available.
- [ ] AC-11: In a multi-repository project, each repository is a collapsible group with its own header and menu.
- [ ] AC-12: Selecting or interacting with a repository makes it active. Graph and Pull Requests operate on that active repository.

### Commit message and generation

- [ ] AC-13: Each repository owns an independent commit-message draft.
- [ ] AC-14: A Generate split button appears to the left of the execution split button.
- [ ] AC-15: The Generate split button offers `Generate` and `Generate with instructions`.
- [ ] AC-16: Generate uses the effective Source Control writer model, falling back to the environment text-generation model when the dedicated model is off.
- [ ] AC-17: Generate uses the existing effective Source Control writing policy. No duplicate commit-prompt setting is introduced.
- [ ] AC-18: Generation receives the active repository's staged diff and relevant repository conventions. It excludes unstaged content and other repositories.
- [ ] AC-19: Successful generation replaces the commit-message field but does not commit.
- [ ] AC-20: Generation is unavailable without staged changes or an available writer model, with a specific disabled reason.
- [ ] AC-21: Generation progress prevents duplicate requests.
- [ ] AC-22: Generation failure preserves the current message and shows a concrete error.
- [ ] AC-23: `Generate with instructions` opens a compact popover containing an instruction field, a `Replace prompt` control, its tooltip, and a Generate button.
- [ ] AC-24: With Replace prompt off, transient instructions append to the effective configured writing instructions.
- [ ] AC-25: With Replace prompt on, transient instructions replace configurable writing instructions but never replace the core output format, safety rules, or staged-diff context.
- [ ] AC-26: Empty transient instructions cannot be submitted.
- [ ] AC-27: Closing the popover without generating preserves its text. Reopening it for that repository restores the draft.
- [ ] AC-28: Instruction drafts are session-scoped per repository and are never written into Settings.

### Execution split button

- [ ] AC-29: The execution menu offers `Commit`, `Commit (Amend)`, `Commit & Push`, and `Commit & Sync`.
- [ ] AC-30: Selecting an option changes the primary segment's label and behavior.
- [ ] AC-31: The selected commit action is remembered per repository for the current application session.
- [ ] AC-32: Commit variants use only staged changes.
- [ ] AC-33: Plain Commit requires a non-empty message and runs without confirmation.
- [ ] AC-34: Commit (Amend) uses normal Git amend semantics and requires confirmation.
- [ ] AC-35: When the amend message field is empty, the amended commit reuses the previous commit message.
- [ ] AC-36: When the amend message field is non-empty, it replaces the previous commit message.
- [ ] AC-37: Commit & Push commits first and pushes only after a successful commit.
- [ ] AC-38: If Commit & Push targets a branch without an upstream, the action becomes `Commit & Publish Branch`.
- [ ] AC-39: Commit & Sync runs commit, pull with the repository's configured pull strategy, then push. A conflict or failed step prevents remaining steps.
- [ ] AC-40: Commit & Push, Commit & Publish Branch, and Commit & Sync require confirmation showing the repository, branch, remote, and ordered steps.
- [ ] AC-41: When nothing is staged and the branch has outgoing commits with an upstream, the primary action becomes `Push`.
- [ ] AC-42: When nothing is staged, local commits exist, and the branch has no upstream but has a remote, the primary action becomes `Publish Branch`.
- [ ] AC-43: When the repository has no remote, the primary publication action becomes `Publish Repository`.
- [ ] AC-44: Unstaged changes do not prevent pushing previously created commits unless Git reports an incompatible operation.
- [ ] AC-45: A behind or diverged branch does not perform an unsafe push. The UI explains whether Pull or Sync is required.
- [ ] AC-46: Detached HEAD, conflicts, stale status, missing identity, unavailable credentials, and busy repositories expose specific disabled reasons.

### Repository More Actions menu

- [ ] AC-47: The menu follows the supplied VS Code reference structure with grouped commands, separators, nested submenus, keyboard access, and checked state where applicable.
- [ ] AC-48: The menu includes `View as Tree` and a `View & Sort` submenu.
- [ ] AC-49: View & Sort supports list/tree presentation and sorting by path, name, or change state.
- [ ] AC-50: The menu includes direct `Pull`, `Push`, and `Fetch` actions.
- [ ] AC-51: The Commit submenu includes Commit, Amend, Commit & Push, Commit & Sync, Commit & Publish Branch when applicable, and Undo Last Commit.
- [ ] AC-52: The Changes submenu includes Stage All, Unstage All, and Discard All.
- [ ] AC-53: The Pull/Push submenu includes Sync, Pull, Pull From, Pull with Rebase, Push, Push To, Force Push, Fetch, Fetch From All Remotes, and Fetch Prune where supported.
- [ ] AC-54: The Branch submenu includes Checkout, Merge, Rebase, Create Branch, Create Branch From, Rename Branch, Delete Branch, Delete Remote Branch, and Publish Branch.
- [ ] AC-55: The Remote submenu includes Add Remote and Remove Remote.
- [ ] AC-56: The Stash submenu includes Stash, Stash Including Untracked, Stash Staged, View Stash, Apply, Pop, Apply Latest, Pop Latest, Drop, and Drop All where supported by the installed Git version.
- [ ] AC-57: The Tags submenu includes Create Tag, Delete Tag, Push Tag, and Push All Tags.
- [ ] AC-58: A Pull Request submenu provides available provider actions such as create, open/view, check out, refresh, merge, or close.
- [ ] AC-59: Unsupported commands are hidden or disabled with a specific reason based on repository, Git version, provider, authentication, and server capabilities.
- [ ] AC-60: Clone and Git Output do not appear.
- [ ] AC-61: Menu actions use the same Source Control interface as the primary controls and command palette.

### Confirmation policy

- [ ] AC-62: Plain Commit never asks for confirmation.
- [ ] AC-63: Stage, Unstage, Refresh, Fetch, Generate, View, and Sort never ask for confirmation.
- [ ] AC-64: Amend, Undo Last Commit, Pull, Push, Publish, Sync, Commit & Push, Commit & Publish Branch, and Commit & Sync require confirmation.
- [ ] AC-65: Checkout, branch creation, rename, merge, rebase, local or remote branch deletion, and force-push require confirmation.
- [ ] AC-66: Adding or removing remotes requires confirmation.
- [ ] AC-67: Creating, applying, popping, or dropping stashes requires confirmation.
- [ ] AC-68: Creating, deleting, or pushing tags requires confirmation.
- [ ] AC-69: Discarding changes and provider-side pull-request mutations require confirmation.
- [ ] AC-70: Confirmations identify the active repository and summarize the exact mutation.
- [ ] AC-71: Destructive confirmations state what data or ref may be lost. Force-push, discard, branch deletion, stash drop, and tag deletion use stronger destructive styling.
- [ ] AC-72: Cancelling confirmation performs no mutation and preserves all drafts and selections.

### Graph

- [ ] AC-73: Graph displays an infinite-scrolling commit tree backed by bounded page requests.
- [ ] AC-74: Reaching the loading threshold fetches the next page without a manual Load More control.
- [ ] AC-75: Duplicate or overlapping page responses do not duplicate commits or reorder existing rows.
- [ ] AC-76: Each collapsed graph row shows only graph lanes, commit subject, and local branch, remote branch, and tag decorations.
- [ ] AC-77: Hovering a commit displays a non-editable popover with its full hash, complete message, author, timestamp, parent information, and change summary.
- [ ] AC-78: Moving away closes the hover popover without changing selection.
- [ ] AC-79: Clicking a commit expands it inline and loads its changed-file list.
- [ ] AC-80: Clicking an expanded commit again collapses it.
- [ ] AC-81: Clicking a changed file opens the diff for that file at the selected commit.
- [ ] AC-82: Binary or unavailable diffs show an explicit non-text state rather than a blank editor.
- [ ] AC-83: HEAD, the current branch, upstream, local branches, remote branches, and tags use distinct decorations.
- [ ] AC-84: Graph supplies loading, fetching-more, empty-repository, end-of-history, refresh, and failure states.
- [ ] AC-85: Refresh preserves the selected commit and scroll position when that commit still exists.
- [ ] AC-86: Repository mutations invalidate the relevant graph data without clearing unrelated repositories.

### Multiple repositories and submodules

- [ ] AC-87: Repository discovery includes the project root, recursively initialized Git submodules, and unrelated nested Git repositories inside the project.
- [ ] AC-88: Discovery does not initialize, clone, or fetch repositories.
- [ ] AC-89: Uninitialized, missing, or inaccessible submodules appear as unavailable entries with a reason.
- [ ] AC-90: Repositories are identified by name and project-relative path.
- [ ] AC-91: Repository identity is stable across status refreshes and does not depend on display order.
- [ ] AC-92: Each repository has independent status, branch, remotes, staged changes, commit message, generation instructions, graph state, action selection, and progress.
- [ ] AC-93: Committing within a submodule changes only that submodule.
- [ ] AC-94: After a submodule commit, the parent repository reports the updated gitlink as a parent change.
- [ ] AC-95: Parent gitlink changes require explicit staging and committing in the parent.
- [ ] AC-96: Removing or changing nested repositories clears stale state for only the affected repository.
- [ ] AC-97: Multi-repository discovery and status work remain bounded and do not continuously scan the full workspace.
- [ ] AC-98: A mutation in one repository does not block read operations or safe independent work in another repository.
- [ ] AC-99: The active repository's provider controls the Source Control rail, tab, heading, terminology, and provider actions.

### Reuse and compatibility

- [ ] AC-100: Panel actions, menus, command-palette commands, and keybindings resolve availability and execute through the same Source Control interface.
- [ ] AC-101: Web and desktop receive identical normalized status, action availability, progress, confirmation descriptions, and failures.
- [ ] AC-102: Older servers expose unsupported capabilities rather than producing malformed commands or dead controls.
- [ ] AC-103: Existing remote, relay, tunnel, and multi-environment authorization rules apply to every new query and mutation.
- [ ] AC-104: Source Control documentation describes generation, Graph, repository menus, confirmations, and multi-repository behavior without documenting layout details that are visually obvious.

### Secondary pane ownership and lifecycle

- [ ] AC-105: Secondary-pane file tabs never render `FileBrowserPanel` or the Show/Hide File Explorer action.
- [ ] AC-106: The right-sidebar Files surface retains its existing file tree and navigation behavior. Because `FilePreviewPanel` is shared, hiding the explorer applies only in secondary-pane mode.
- [ ] AC-107: Selecting a file in the right-sidebar tree opens or activates its secondary-pane tab without creating another file tree.
- [ ] AC-108: Secondary-pane Minimize and Maximize/Restore are icon-only controls in the global panel-control group, immediately left of the bottom-dock icon button. They do not appear in the secondary-pane tab bar.
- [ ] AC-109: Minimizing removes the secondary pane's content footprint from both inline and stacked layouts, returning that space to the primary workspace.
- [ ] AC-110: Minimizing preserves all surfaces, their order, the active surface, reveal position, unsaved editor state, and other recoverable view state.
- [ ] AC-111: When the secondary pane is minimized, its restore icon remains in the same global panel-control location. The controls appear only when retained secondary-pane tabs exist.
- [ ] AC-112: Restoring returns the pane to its pre-minimize state—normal or maximized—with the same active tab and tab order.
- [ ] AC-113: Opening or revealing a file while the pane is minimized automatically restores the pane and activates that file.
- [ ] AC-114: Close retains its existing meaning: closing a tab removes that tab, while closing the last tab clears the pane. Minimize never removes tabs.
- [ ] AC-115: Minimized state is thread-scoped and persisted with the existing secondary-pane state.
- [ ] AC-116: Persisted secondary-pane state migrates without losing tabs; existing sessions default to expanded.
- [ ] AC-117: Minimize and restore controls are keyboard accessible and expose accurate accessible names, tooltips, and expanded/minimized state.
- [ ] AC-118: Removing the secondary tree does not affect attachment previews, file breadcrumbs, Open With, rendered/source toggles, editing, or file-diff navigation.
- [ ] AC-119: Secondary-pane tests cover minimized-state persistence, restoration, opening a file while minimized, closing tabs while minimized, and the absence of the embedded explorer.
- [ ] AC-120: Right-sidebar tests demonstrate that its Files tree remains available after the shared `FilePreviewPanel` changes.

### Aggregate and single-file diff ownership

- [ ] AC-121: The right-sidebar Diff surface is always an aggregate view. It shows every diff in the currently selected scope for the active repository, project, branch, or worktree.
- [ ] AC-122: Existing aggregate scopes remain distinct. For example, Branch Changes and Unstaged Changes are not silently combined.
- [ ] AC-123: The aggregate view updates when the active repository, worktree, branch, base reference, or diff scope changes.
- [ ] AC-124: Selecting a file from an aggregate diff opens or activates a single-file diff tab in the secondary pane. The sidebar remains on the aggregate view.
- [ ] AC-125: Every action that opens a single-file diff uses the secondary pane, including files selected from Source Control Changes, Graph commit details, pull-request file lists, and the aggregate Diff surface.
- [ ] AC-126: Multiple single-file diffs can remain open as separate secondary-pane tabs.
- [ ] AC-127: A diff tab's identity includes its repository and comparison context as well as its path. Diffs for the same path from different repositories, commits, branches, or scopes cannot collide.
- [ ] AC-128: Switching the active repository does not rewrite an already-open diff tab's repository or comparison context.
- [ ] AC-129: Current-change diff tabs refresh after relevant workspace mutations while preserving the selected file and usable scroll position.
- [ ] AC-130: Historical and pull-request diff tabs remain pinned to their original base/head revisions rather than changing with the working tree.
- [ ] AC-131: If a file, repository, or revision becomes unavailable, the secondary tab shows an actionable unavailable-state message and can still be closed normally.
- [ ] AC-132: Opening a single-file diff while the secondary pane is minimized restores the pane and activates that diff tab.
- [ ] AC-133: Single-file diff tabs use the same secondary-pane lifecycle as ordinary file tabs: activate, minimize, maximize, restore, close, close others, close right, and close all.
- [ ] AC-134: Aggregate and single-file diff consumers use the shared Source Control interface and cache. Opening a file diff must not trigger duplicate repository-wide Git queries.

## Plan

### Task 1: Lock shared repository scope, capability boundary, and invalidation (P1)

**Acceptance criteria:** AC-59, AC-61, AC-92, AC-98, AC-100 through AC-103, and AC-134.

**Files:**

- Modify `packages/contracts/src/environment.ts`, `packages/contracts/src/git.ts`, and
  `packages/contracts/src/rpc.ts` only if the existing additive capability or receipt schemas cannot
  express the required behavior.
- Modify `packages/client-runtime/src/state/sourceControlWorkspace.ts` and
  `packages/client-runtime/src/state/vcs.ts` so repository scope, confirmation policy, mutation
  progress, compound sequencing, capability gating, and settled invalidation have one production
  owner. Modify `packages/client-runtime/src/state/vcsRefInvalidation.ts` so ref and cache
  invalidation are keyed by environment plus canonical repository root rather than environment only.
- Modify only the adapter layer in `apps/web/src/state/sourceControl.ts` and
  `apps/web/src/state/sourceControlActions.ts`; UI migration stays in P2-P7. Create
  `apps/web/src/state/sourceControlActions.test.ts` for adapter capability, scope, confirmation, and
  settled-invalidation behavior.
- Test `packages/contracts/src/environment.test.ts`, `packages/contracts/src/git.test.ts`,
  `packages/client-runtime/src/state/sourceControlWorkspace.test.ts`, and focused web state tests.

**Interfaces produced:**

- A canonical `{ environmentId, repositoryRoot }` scope key used by every query and mutation.
- A negotiated `sourceControlWorkspace === true` gate that fails closed when unknown or absent.
- A single action runner that applies the confirmation matrix, tracks action progress, returns all
  completed and failed steps, and invalidates status, refs, graph, aggregate diff, and live
  comparisons after every settled outcome.
- A repository revision signal incremented by both workspace and legacy entry points until legacy
  entry points are removed.

**Steps:**

- [ ] Add failing tests showing unknown capability never invokes discovery/comparison/amend RPCs,
      Fetch does not confirm, a branch mutation does confirm on a clean tree, and two repositories in
      one environment do not share progress or invalidation.
- [ ] Add failing cache-isolation tests showing ref/status invalidation for one nested repository
      does not clear another repository, while a committed submodule refreshes the parent repository's
      gitlink status.
- [ ] Run the focused tests and record the expected failures before changing production code.
- [ ] Move confirmation and compound execution into the shared controller; make legacy mutations
      delegate to it or publish the same scoped settled event.
- [ ] Gate the shared adapters on negotiated support with a typed unavailable reason. P2-P7 migrate
      and gate their respective UI entry points against these adapters.
- [ ] Connect status/snapshot broadcasts and external Git/file changes to the same scoped revision
      signal used by Graph, aggregate Diff, and live single-file comparisons.
- [ ] Re-run focused tests, then run package-scoped typechecks for contracts and client-runtime.
- [ ] Review gate: trace contracts and shared/web state adapters, proving every exported mutation
      reaches the shared action runner and every read-only adapter is explicitly identified. P8 owns the
      final all-UI-caller trace after P2-P7 migrate their entry points.

### Task 2: Make active-repository selection authoritative everywhere (P2)

**Acceptance criteria:** AC-1 through AC-12, AC-90 through AC-92, and AC-99.

**Files:**

- Modify `apps/web/src/components/BranchToolbarBranchSelector.tsx`,
  `apps/web/src/components/BranchToolbar.logic.ts`, `apps/web/src/components/BranchToolbar.tsx`,
  `apps/web/src/components/ChatView.tsx`, and
  `apps/web/src/components/source-control/SourceControlPanel.tsx`.
- Modify `apps/web/src/components/source-control/SourceControlActions.tsx` only as needed to
  mount the existing menu under each repository header; P3 continues to own menu contents and
  operation availability. Cover repository-group behavior in
  `apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx` and header
  target routing in `apps/web/src/components/source-control/SourceControlActions.target.test.tsx`.
- Add the canonical repository root to `packages/contracts/src/pullRequest.ts` as an optional,
  additive selection field. Route and authorize it through
  `apps/server/src/pullRequest/PullRequestService.ts` and the relevant RPC handler, include it in
  client-runtime query/cache keys and provider mutations, and clear stale PR selection when the
  repository changes. An absent field retains older project-root behavior.
- Test `apps/web/src/components/BranchToolbar.logic.test.ts`, create
  `apps/web/src/components/BranchToolbarBranchSelector.test.tsx`, test
  `apps/server/src/pullRequest/PullRequestService.test.ts`, the applicable pull-request contract
  test, and `SourceControlPanel.interaction.test.tsx`.

**Interfaces consumed:** P1 canonical repository scope and shared action runner.

**Dependency:** P1 must pass before P2 begins.

**Steps:**

- [ ] Add failing single- and multi-repository Changes tests. Multiple repositories render
      independently collapsible groups, each with name, relative path when needed, branch, sync state,
      refresh, and More Actions. Collapsing a group preserves its drafts and selection. Interacting
      with a group makes that repository active, while each header action retains its own canonical
      target. A single-repository layout may omit redundant chrome but keeps More Actions. Verify
      Graph and Pull Requests follow the active group.
- [ ] Run those tests red, then implement repository groups and their scoped headers using P1's
      shared controller. Keep operation contents and availability in P3 and composer behavior in P4;
      each group must retain independent state when collapsed or inactive.
- [ ] Add a failing nested-repository branch-selection test proving both ref query and checkout use
      the selected nested root rather than `activeProjectCwd` or `activeWorktreePath`.
- [ ] Add a failing repository-switch test proving rail label, sidebar title, tab label, branch
      picker, Graph, Changes, PR query, and aggregate Diff all switch together and stale PR selection is
      cleared.
- [ ] Add a failing end-to-end PR scope test with nested and outer repositories using different
      remotes, proving list, detail, checkout, refresh, merge, and close operations target the selected
      repository and older clients retain project-root behavior when the additive field is absent.
- [ ] Run these focused tests red; then thread the selected repository scope through the affected callers and
      remove fallback derivations after selection is known.
- [ ] Make provider terminology a presentation property of the selected repository, with
      `Source Control` and generic change-request fallbacks when provider/status is absent.
- [ ] Re-run focused tests and web typecheck.
- [ ] Review gate: inspect every project-root use in Source Control and classify it as discovery
      root, selected repository root, or defect; no mutation may use the discovery root.

### Task 3: Finish discovery and operation availability before exposing actions (P3)

**Acceptance criteria:** AC-47 through AC-61, AC-65 through AC-69, and AC-87 through AC-98.

**Files:**

- Modify `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/vcs/GitVcsDriver.ts`,
  `apps/server/src/git/GitWorkflowService.ts`, and `apps/server/src/ws.ts`.
- Modify `apps/web/src/components/source-control/SourceControlActions.tsx`,
  `sourceControlActions.logic.ts`, and `SourceControlPanel.tsx`.
- Test `apps/server/src/vcs/GitVcsDriverCore.test.ts`,
  `apps/server/src/git/GitWorkflowService.test.ts`,
  `apps/web/src/components/source-control/sourceControlActions.logic.test.ts`, and
  `SourceControlActions.target.test.tsx`.

**Interfaces produced:** repository descriptors with actionable capability/unavailable reasons, and
operation descriptors that contain their required fields and preconditions.

**Dependency:** P1 and P2 must pass before P3 begins.

**Steps:**

- [ ] Add failing disposable-repository tests for recursive initialized submodules, configured
      dot-prefixed submodule paths, ignored nested repositories, bounded/truncated scanning, and no
      automatic initialization.
- [ ] Add a failing submodule workflow fixture proving a submodule commit changes only that
      repository, refreshes the parent gitlink as an unstaged parent change, and never stages or commits
      the parent until the user explicitly does so.
- [ ] Add failing operation-matrix tests for create-from/rename inputs, unborn HEAD, detached HEAD,
      missing upstream/remote, no active conflict, busy state, and cherry-pick/revert continuation.
- [ ] Run the tests red; then make discovery recursively upgrade initialized submodules and make
      operation availability derive from real repository preconditions.
- [ ] Replace cosmetic “View as Tree” indentation with actual directory nodes; keep View & Sort as
      real state that changes grouping/order without a Git mutation.
- [ ] Ensure Clone and Git Output remain absent and the terminal remains bottom-dock-only.
- [ ] Re-run focused tests plus server/web package typechecks.
- [ ] Review gate: invoke every visible menu item through its typed operation and verify unavailable
      items are disabled with a reason instead of silently doing nothing.

### Task 4: Complete composer drafts, primary actions, and durable compound results (P4)

**Acceptance criteria:** AC-13 through AC-46 and AC-62 through AC-72.

**Files:**

- Modify `apps/web/src/components/source-control/SourceControlPanel.tsx` and
  `sourceControlPanel.logic.ts`.
- Modify `packages/client-runtime/src/state/sourceControlWorkspace.ts` and server workflow files only
  where needed for one durable compound result/continuation model.
- Modify the read-only generation context in `apps/server/src/vcs/GitVcsDriverCore.ts` and its
  caller in `apps/server/src/git/GitManager.ts` so the writer receives the staged diff only while
  the index remains byte-for-byte unchanged, including partially staged and unborn-HEAD cases.
- Test `SourceControlPanel.interaction.test.tsx`, `sourceControlPanel.logic.test.ts`,
  `packages/client-runtime/src/state/sourceControlWorkspace.test.ts`,
  `apps/server/src/git/GitWorkflowService.test.ts`, and
  `apps/server/src/vcs/GitVcsDriverCore.test.ts`.

**Interfaces consumed:** P1 shared action runner; P2 selected repository scope; P3 operation reasons.

**Dependency:** P1-P3 must pass before P4 begins.

**Steps:**

- [ ] Add failing tests for repository-scoped message/action/instruction drafts, late generation
      results, partial staging preservation, blank amend message reuse, unborn HEAD, and selected Amend
      not being overridden by ahead-state Push.
- [ ] Add a disposable-repository generation test with distinct staged, unstaged, and untracked
      sentinel contents. Assert only staged content and repository conventions reach the writer, model
      fallback and append/replace prompt policy remain correct, and the index bytes do not change.
- [ ] Add same-session reopen/switch and fresh-session tests: message, transient instructions, and
      selected action survive repository switching within the application session, but instructions and
      selected action are never restored from localStorage or Settings after a fresh session.
- [ ] Add failing tests for Push, Publish Branch, Publish Repository, Commit & Push, Commit & Sync,
      and Commit & Publish Branch availability with detached/no-remote/no-upstream/busy combinations,
      behind/diverged protection, unstaged changes, unavailable credentials, and visible reasons.
- [ ] Add a failing compound test where commit succeeds and push fails, asserting the receipt
      retains the commit plus pull/push steps and exposes a safe continuation that cannot recommit.
- [ ] Run tests red; then centralize draft state by scope and make primary action derivation explicit
      rather than overriding the user's selected commit action. Remove legacy persisted
      instruction/action restoration while preserving message drafts and stale-generation guards.
- [ ] Return one compound receipt from the shared runner and surface partial failure consistently in
      the composer and header menu. Honor the configured pull strategy.
- [ ] Re-run focused suites, server/web/client-runtime typechecks, and the existing generation index
      preservation and feature-branch amend confirmation tests.
- [ ] Review gate: walk every primary-button state and confirmation path; plain Commit is the only
      unconfirmed commit action and each compound confirms once. Cancellation sends zero RPCs and
      preserves every message, instruction, action, and repository selection. Destructive operations
      use stronger styling and explicitly name the data or ref at risk.

### Task 5: Replace graph parser and renderer with cursor-carried topology state (P5)

**Acceptance criteria:** AC-73 through AC-86.

**Files:**

- Modify graph contracts in `packages/contracts/src/git.ts` only if cursor state needs an additive
  schema field.
- Modify `apps/server/src/vcs/GitVcsDriverCore.ts` and its tests for parsing, ref classification,
  checkpoint exclusion, lane topology, cursors, roots, and merges.
- Prefer a focused component under `apps/web/src/components/source-control/` for graph rendering;
  keep `SourceControlPanel.tsx` as orchestration.
- Test contracts, driver graph tests, source-control logic tests, and interaction tests.

**Interfaces produced:** graph rows with validated 40-hex SHAs, lane/edge positions that continue
across cursors, accurately typed refs, and explicit merge-parent metadata.

**Dependency:** P1-P4 must pass before P5 begins. P5 produces graph and parent metadata; P6 owns
the changed-file-to-diff integration for AC-81 and AC-82.

**Steps:**

- [ ] Add failing multi-row parser tests that reject/trim record separators, a literal topology
      fixture covering branch/merge/root commits across two pages, and ref fixtures for slash-containing
      local branches versus remotes/tags.
- [ ] Add failing UI tests asserting rows show only lanes, subject, and refs; lanes occupy distinct
      columns with connecting edges; SHA is absent; observer-driven paging, overlapping-page
      deduplication, retry/loading/retention bounds, hover close, and expand/collapse work.
- [ ] Run tests red; then implement a parser independent of line-leading whitespace and a cursor
      that carries unresolved lane state across pages.
- [ ] Make repository revision/ref changes invalidate graph pages without eagerly loading file lists.
- [ ] Implement hover details and merge-parent selection so the selected parent loads the correct
      changed-file list. Preserve selected commit and usable scroll position across refresh when the
      commit remains; isolate invalidation to the affected repository.
- [ ] Re-run focused tests and contracts/server/web typechecks.
- [ ] Review gate: run a disposable Git topology fixture through two pages and compare every emitted
      SHA, lane, edge, and ref decoration with hand-derived expected values.

### Task 6: Give every single-file diff a complete comparison descriptor (P6)

**Acceptance criteria:** AC-81, AC-82, and AC-121 through AC-134.

**Files:**

- Modify `packages/contracts/src/git.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, and server RPC
  plumbing as required for additive pinned comparison inputs.
- Modify `apps/web/src/secondaryPaneStore.ts`, `diffFileActions.ts`, `diffPanelStore.ts`,
  `components/DiffPanel.tsx`, `components/workspace/SecondaryPaneDiffPanel.tsx`,
  `components/source-control/SourceControlPanel.tsx`, and the PR/turn file-selection callers.
- Test `packages/contracts/src/git.test.ts`, driver comparison tests,
  `secondaryPaneStore.test.ts`, `diffFileActions.test.ts`, `diffPanelStore.test.ts`, and focused
  PR/turn/Changes routing interactions, including a new
  `apps/web/src/components/pullRequest/PullRequestCodeTab.interaction.test.tsx`.

**Interfaces produced:** a versioned comparison descriptor containing environment, repository root,
comparison kind, nullable old/new paths, immutable base/head or explicit live snapshot identity,
turn/checkpoint or PR identity, and merge parent where applicable.

**Dependency:** P1-P5 must pass before P6 begins. P6 consumes P2's repository-scoped PR identity
and P5's selected merge-parent metadata.

**Steps:**

- [ ] Add failing identity tests for same path in two repositories, same branch before/after ref
      movement, turn/checkpoint tabs, PR revisions, nullable add/delete sides, renames, root commits, and
      two parents of a merge commit.
- [ ] Add failing routing tests proving Graph, Changes, PR, turn/checkpoint, and aggregate Diff open
      secondary tabs while aggregate Diff retains its repository and scope.
- [ ] Add failing content tests for working-tree-versus-index, index-versus-pinned-HEAD, binary and
      missing files, and live refresh after both application mutations and external Git/file changes
      without losing tab selection or usable scroll state.
- [ ] Add a failing unavailable-state interaction test with Retry/Refresh and Close actions, plus a
      request-count test proving opening one file reuses aggregate repository data/cache instead of
      starting another repository-wide status or diff-list query.
- [ ] Run tests red; then preserve explicit null path sides, resolve immutable revisions at open
      time, and route every caller through one `openRepositoryComparison` action.
- [ ] Make restored live tabs capability-gated and subscribe them to the scoped mutation revision;
      status/snapshot broadcasts and external changes invalidate them, while historical tabs remain
      pinned and do not refresh into different content.
- [ ] Re-run focused tests plus contracts/server/web typechecks.
- [ ] Review gate: inspect every `openDiff`/file-selection caller and prove it either opens a normal
      file or supplies the complete comparison descriptor—no inference from the current route/status.
      Verify diff tabs support activate, minimize, maximize, restore, close, close others, close right,
      and close all.

### Task 7: Finish secondary-pane presentation and shared controls (P7)

**Acceptance criteria:** AC-105 through AC-120, AC-132, and AC-133.

**Files:**

- Modify `apps/web/src/secondaryPaneStore.ts`, `workspacePaneLayout.ts`,
  `components/chat/PanelLayoutControls.tsx`, `components/ChatView.tsx`,
  `components/preview/PreviewPanelShell.tsx`, `components/workspace/SecondaryPaneShell.tsx`,
  `components/workspace/SecondaryPaneTabs.tsx`, and `components/files/FilePreviewPanel.tsx`.
- Test store, layout, preview shell, tabs, and file-preview behavior.

**Dependency:** P1 and P6 must pass before P7 begins.

**Steps:**

- [ ] Add failing layout tests proving inline and stacked panes both expose accessible Minimize and
      Maximize/Restore icon controls immediately before the bottom-dock control without conflicting
      Electron titlebar ownership.
- [ ] Add failing state tests for expanded → maximized → minimized → restored, opening a file while
      minimized, closing tabs while minimized including the last tab, persistence/migration, tab order,
      active tab, reveal location, unsaved editor state, and diff identity.
- [ ] Add a failing file-preview test proving neither the explorer nor its Show/Hide control exists
      in the secondary pane while the right-sidebar Files surface still opens tabs. Cover attachment
      previews, breadcrumbs, Open With, rendered/source toggles, editing, and file-diff navigation.
- [ ] Run tests red; then separate control ownership from layout stacking and preserve the saved
      pre-minimize presentation in every open path.
- [ ] Re-run focused suites and web typecheck.
- [ ] Review gate: verify the control group’s DOM order and keyboard/tooltip labels in both layouts.

### Task 8: Integrate, document verified behavior, and run the acceptance matrix (P8)

**Acceptance criteria:** AC-1 through AC-134.

**Files:**

- Update `docs/user/source-control.md` and `docs/user/workspace-panes.md` only after corresponding
  behavior has passed its task gate.
- Update this work record once with exact results, deviations, and residual risks.
- A single bounded integrated-review repair wave may modify implementation or test files named by
  P1-P7, but only for findings returned by that review. It receives one focused gate and one scoped
  re-review; there is no second integrated repair wave.

**Steps:**

- [ ] Run every focused command in Validation from a clean process and record exact file/test counts.
- [ ] Run package-scoped typechecks for contracts, client-runtime, server, and web; run
      `git diff --check`.
- [ ] Dispatch one fresh whole-candidate reviewer with the full AC-1…AC-134 matrix and current diff;
      fix at most one integrated-review wave, then re-review that wave once.
- [ ] Before that review, trace every panel, menu, command-palette, keybinding, header, Graph, PR,
      aggregate Diff, and restored-secondary-tab caller and prove it uses the shared Source Control
      adapter or an explicitly documented read-only presentation path.
- [ ] If and only if automated and source-review gates pass, run `vp run dev --share`, use the T3
      preview browser for an integrated web/desktop pass, and leave the server running for user review.
- [ ] Verify repository switching, action confirmations, all primary-button states, graph paging and
      merge expansion, every diff origin, inline/stacked pane controls, right-rail preservation, and
      older-server disabled states in the integrated pass.
- [ ] Rewrite docs to match the verified UI and remove any promise not demonstrated by validation.

## Validation

- [ ] V1 — shared contracts, scope, capability, cache, and pull-request routing:

  ```bash
  vp test run \
    packages/contracts/src/environment.test.ts \
    packages/contracts/src/git.test.ts \
    packages/contracts/src/pullRequest.test.ts \
    packages/client-runtime/src/state/vcs.test.ts \
    packages/client-runtime/src/state/sourceControlWorkspace.test.ts \
    packages/client-runtime/src/state/pullRequests.test.ts \
    apps/server/src/pullRequest/PullRequestService.test.ts \
    apps/web/src/state/sourceControlActions.test.ts
  ```

- [ ] V2 — Git workflow, discovery, generation, operation matrix, compounds, and graph:

  ```bash
  vp test run \
    apps/server/src/vcs/GitVcsDriverCore.test.ts \
    apps/server/src/git/GitManager.test.ts \
    apps/server/src/git/GitWorkflowService.test.ts
  ```

- [ ] V3 — repository selection, Source Control presentation, menus, composer, and graph UI:

  ```bash
  vp test run \
    apps/web/src/components/BranchToolbar.logic.test.ts \
    apps/web/src/components/BranchToolbarBranchSelector.test.tsx \
    apps/web/src/components/source-control/sourceControlPanel.logic.test.ts \
    apps/web/src/components/source-control/sourceControlActions.logic.test.ts \
    apps/web/src/components/source-control/SourceControlActions.target.test.tsx \
    apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx \
    apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx
  ```

- [ ] V4 — aggregate and single-file diff identity, content, routing, recovery, and caching:

  ```bash
  vp test run \
    apps/web/src/diffPanelStore.test.ts \
    apps/web/src/diffFileActions.test.ts \
    apps/web/src/components/pullRequest/PullRequestCodeTab.interaction.test.tsx \
    apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx \
    apps/web/src/components/chat/MessagesTimeline.interaction.test.tsx
  ```

- [ ] V5 — secondary-pane lifecycle, controls, right-sidebar preservation, and command entry points:

  ```bash
  vp test run \
    apps/web/src/secondaryPaneStore.test.ts \
    apps/web/src/workspacePaneLayout.test.ts \
    apps/web/src/components/preview/PreviewPanelShell.test.ts \
    apps/web/src/components/workspace/SecondaryPaneTabs.test.tsx \
    apps/web/src/components/chat/PanelLayoutControls.test.tsx \
    apps/web/src/components/files/FilePreviewPanel.test.ts \
    apps/web/src/components/ChatView.logic.test.ts \
    apps/web/src/components/right-panel/rightPanelSurfaceActions.test.ts \
    apps/web/src/components/right-panel/rightPanelCommands.test.ts \
    apps/web/src/components/right-panel/rightPanelOpenCommands.test.ts
  ```

- [ ] V6 — exact package and structural checks:

  ```bash
  vp run --filter @t3tools/contracts typecheck
  vp run --filter @t3tools/client-runtime typecheck
  vp run --filter t3 typecheck
  vp run --filter @t3tools/web typecheck
  vp run --filter @t3tools/desktop typecheck
  git diff --check
  ```

- [ ] V7 — after V1-V6 and the independent source review pass, run `vp run dev --share` using this
      worktree's `.t3` state, inspect the web/desktop client with the T3 preview tools against an outer
      repository plus nested repository fixture, and leave the server running for user review. Mobile UI
      remains outside this pass.

## Outcome

Previous candidate history: two repair rounds and independent reviews were completed against an
incomplete 29-criterion derivative plan. That candidate passed 8 criteria, had 8 partial, and failed 13. The source-backed failures are carried into P1-P7 above; the repaired read-only Generate/index
behavior, unconditional amend confirmation, configured pull strategy, selected-root labels,
checkpoint exclusion, pane state preservation, explorer removal, and right-rail/terminal behavior
remain regression gates.

Current plan state: the user authorized a new structured implementation of the recovered original
AC-1 through AC-134 specification. No task in this new plan is complete yet. The prior automatic
repair limit does not describe this newly approved implementation cycle. Protected Integration and
mobile Gradle changes remain outside this work, and server/browser validation remains gated on V1-V6
plus independent source review.
