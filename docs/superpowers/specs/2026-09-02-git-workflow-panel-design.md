# Git workflow panel

## Goal

Give a user one project-local Source Control panel for inspecting changes, reviewing diffs and pull requests, staging and unstaging whole files, committing staged work, and switching or creating branches.

## Problem

T3 Code has VCS status streaming, branch commands, a diff panel, a pull-request panel, and `GitActionsControl` in the chat header. The controls are scattered and spend too much rail and header space. They do not offer the ordinary file-by-file staging workflow that users expect.

## Scope

Add a Source Control entry to the existing right-panel rail. It replaces the separate Diff and Pull Requests rail entries. The panel is bound to the active thread's working directory. It has Changes and Pull requests views. Changes shows repository state, current branch, ahead and behind counts, and the working-tree file list from the VCS status stream. Pull requests reuses the existing pull-request query and detail components inside the panel.

Each file row opens a read-only diff. A user can stage or unstage the complete file. The panel never stages individual hunks in this release. The commit form commits the staged index only. It requires a non-empty message and stays disabled until at least one file is staged. The Changes view also exposes the current branch selector using the existing ref list, switch-ref, and create-ref RPCs. The bottom-left pull-request shortcut remains as quick access to the same Source Control panel with Pull requests selected.

The server adds explicit file-index operations and a bounded working-tree diff API. It does not reuse `GitRunStackedActionInput.filePaths`, because that field stages files as part of a commit action and cannot express unstage or a separate staging lifecycle.

## Non-goals

- Partial staging, amend, discard, conflict resolution, rebase, merge, stash, tags, remote management, and worktree deletion.
- A standalone Diff or Pull Requests rail entry.
- The `GitActionsControl` header control, including its "Commit & Push" selector. Source Control replaces it.
- New source-control behavior in the mobile client.
- Replacing the pull-request route or the bottom-left pull-request shortcut.

## Data and RPC contracts

Add an optional `indexStatus` field to `workingTree.files`. It is optional so clients still decode status events from older servers. The panel treats a missing value as unavailable and disables staging controls until the connected server supplies it.

```ts
{
  path: string;
  insertions: number;
  deletions: number;
  indexStatus?: "staged" | "unstaged" | "both" | "untracked" | "conflicted";
}
```

Expose these typed operations:

```ts
vcs.stageFiles({ cwd, paths });
vcs.unstageFiles({ cwd, paths });
vcs.getWorkingTreeDiff({ cwd, path, comparison: "index" | "head" });
git.commitIndex({ cwd, message });
```

`stageFiles` stages only complete paths under the repository root. `unstageFiles` removes those paths from the index without changing their working-tree contents. `getWorkingTreeDiff` returns a capped unified diff and a `truncated` flag. `commitIndex` commits exactly the current index and never runs `git add`. The server rejects paths outside the repository and empty path lists.

The existing status broadcaster refreshes local status after each index mutation. The panel uses its stream rather than periodic status polling.

## UI behavior

When the active directory is not a Git repository, the panel explains that source control is unavailable and offers the existing initialization action when allowed. When another client changes the index, the status stream updates the rows without losing an open diff or commit message. Removing a rail entry must not remove the pull-request route or the bottom-left quick-access button.

Staging, unstaging, committing, branch creation, and branch switching are destructive. Each action uses the existing command authorization and pending-action conventions. A confirmation is required before switching branches with uncommitted changes, including a newly created branch that immediately switches. A confirmation is required before committing on the default branch. Show server errors in the panel and preserve the user's commit message.

## Acceptance criteria

- The rail has one Source Control entry instead of separate Diff and Pull Requests entries. File, terminal, and preview entries remain unchanged.
- The Source Control panel opens both change diffs and pull requests. The bottom-left pull-request shortcut opens its Pull requests view.
- A user can stage an unstaged file, unstage a staged file, and see the list update through the VCS status stream.
- A user can read a bounded diff for a selected file before changing the index.
- A commit includes only the staged index and respects the existing default-branch confirmation.
- A branch switch does not run when the user cancels the dirty-tree confirmation.
- A non-Git project remains usable and offers no broken controls.
- An index-only commit excludes an unstaged or untracked sibling file.

## Risks and decisions

Index state needs a real server contract. Deriving it from an aggregate numstat would lie when a file has both staged and unstaged edits. Keep staging whole-file only until the VCS layer has a deliberate hunk model. The driver must handle initial repositories, untracked files, conflicts, deletions, nested working directories, worktrees, and literal path names. Source Control is the home for Git and pull-request work. The header no longer needs a Git action control.
