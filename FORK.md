# Custom fork Git workflow

This repository is the `xcastdev/t3code` fork of
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). It is a custom T3
Code distribution for features and behavior that fit xcastdev's use cases.
Changes do not need to become pull requests against the original repository.

The Git setup keeps the custom version on the default branch while preserving
a clean copy of the original repository's history. This makes upstream updates
explicit and keeps custom work separate from the upstream mirror.

## Branches and remotes

The long-lived branches have different jobs:

- `main` is the custom version. Create custom feature branches from `main`, and
  merge completed work back into `main`.
- `upstream-main` mirrors `pingdotgg/t3code` without custom commits. Update it
  only by fast-forwarding it from `upstream/main`.

The remotes are:

- `origin`: `git@github.com:xcastdev/t3code.git`
- `upstream`: `git@github.com:pingdotgg/t3code.git`

Updates move in one direction:

```text
pingdotgg/t3code main
        |
        v
upstream/main
        |
        v
upstream-main
        |
        v
main
```

Never merge `main` into `upstream-main`. Custom commits belong on `main` or on
feature branches created from `main`.

## Add custom work

Start each change from the current custom branch:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/my-custom-change
```

After the change is ready, merge it into `main` through the normal review
process. Push `main` to `origin`, not to `upstream`.

## Check for upstream updates

Fetch both repositories before comparing branches:

```bash
git fetch origin --prune
git fetch upstream --prune
git log --oneline main..upstream/main
```

The log command lists upstream commits that `main` does not contain. No output
means that `main` already contains the fetched upstream history.

## Update the upstream mirror

Fast-forward the mirror to the latest upstream commit:

```bash
git fetch upstream --prune
git switch upstream-main
git merge --ff-only upstream/main
git push origin upstream-main
```

The `--ff-only` option stops the command if `upstream-main` contains commits
that are not in `upstream/main`. Treat that failure as a sign that the mirror
has changed unexpectedly. Do not resolve it by creating a merge commit on
`upstream-main`.

## Merge upstream updates into the custom version

Update `upstream-main` first. Then merge the mirror into `main`:

```bash
git switch main
git pull --ff-only origin main
git merge upstream-main
```

Resolve conflicts on `main`, then run checks for the affected packages. Push
the result after the checks pass:

```bash
git push origin main
```

Use a regular merge instead of rebasing the published `main` branch. Merge
commits record each upstream integration and avoid rewriting custom history.

## Bring an active feature branch up to date

After updating `main`, merge it into an active custom feature branch:

```bash
git switch feature/my-custom-change
git merge main
```

Resolve conflicts and rerun the checks for that feature before pushing it.

## Verify the branch state

Run these commands after an upstream update:

```bash
git status --short --branch
git branch -vv
git rev-parse main upstream-main origin/main origin/upstream-main upstream/main
```

Immediately after a complete upstream sync, all five revisions match. After
custom commits land on `main`, `upstream-main`, `origin/upstream-main`, and
`upstream/main` still match, while `main` and `origin/main` point to the custom
history.

Do not use GitHub's **Sync fork** action for routine updates. It targets the
fork's default branch, which is the custom `main` branch, and bypasses the
`upstream-main` mirror used by this workflow.
