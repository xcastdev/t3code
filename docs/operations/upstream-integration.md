# Upstream integration

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

**Last merged upstream commit:** `31eea883c7f7849ada6eb49265cb11fc64d2ecbd`
(`fix(rewind): allow conversation-only rewind in non-git workspaces (#18379)`, 2026-11-11).
The next integration starts from this commit. Update this line and the table below
in every integration.

| Integration date | Previous upstream baseline                 | Updated upstream baseline                  | Fork before integration                    |
| ---------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 2026-10-27       | `e07595714a467e18c750107137d2c2e50f0c3530` | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `890e89f2e7b92c5524b47278da37ffd8fefc01dc` |
| 2026-11-02       | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `47f2c8d29e981c7723467efe137ee19e91df924e` | `63e994493a87319bfd31bcd0c71d6bcfcd123ab7` |
| 2026-11-11       | `47f2c8d29e981c7723467efe137ee19e91df924e` | `31eea883c7f7849ada6eb49265cb11fc64d2ecbd` | `bec7f5fad7167ed8e897b3d91468779216a79123` |

## Rule: nothing changes without a decision

An integration must not unintentionally or unknowingly change the intended behavior of
either side. Every upstream change since the previous baseline and every fork change
since that baseline must be present in the merged tree, unless a maintainer decided
otherwise and the decision is written under "Fork integration decisions". "It merged
cleanly" is not evidence: Git can silently drop a change in a region it does not mark
as conflicting, and a clean textual merge can still break behavior at runtime.

When in doubt, keep both behaviors and ask. A feature collision (both sides changed
the same feature in incompatible ways) is a maintainer decision, never a resolver
default.

## Procedure

Use `BASE` for the previous upstream baseline (the last merged commit above), `UP` for
the upstream commit being merged, and `FORK` for the fork's `main` before the merge.

1. **Survey.** `git fetch upstream`, pin `UP` to an exact SHA, and list
   `git log --no-merges BASE..UP`. Group the features, new migrations, dependency
   changes and refactors.
2. **Scope the conflicts without touching any branch.**
   `git merge-tree --write-tree --name-only FORK UP` lists the conflicted files. For
   each fork feature, look for upstream changes to the same feature. Bring every
   collision to the maintainer before resolving.
3. **Isolate.** Create a sibling worktree on `integration/upstream-<date>` from `main`,
   never in `/tmp` and never in the main checkout. Enable `rerere.enabled` and
   `merge.conflictStyle zdiff3`. Merge with `git merge --no-ff --no-commit UP`.
4. **Resolve.**
   - Compare each side against the base (`git diff BASE FORK -- <file>`,
     `git diff BASE UP -- <file>`), and keep both changes.
   - Port fork code to upstream's replacement APIs instead of reintroducing the old
     ones.
   - For a modify/delete conflict, port the fork's change onto upstream's replacement
     file.
   - Take upstream's `pnpm-lock.yaml` and regenerate it with `vp i`. Regenerate
     `apps/web/src/routeTree.gen.ts`; never hand-merge generated files.
5. **Find what Git did not mark.** After the markers are gone, look for:
   - fork code that still uses a removed dependency or API;
   - fork code that breaks a renamed or new lint rule or Effect diagnostic;
   - files upstream moved or split, such as CLI entry points;
   - test mocks missing new interface members;
   - schema columns that upstream fixtures now write.
6. **Run the preservation checks** below. Fix every unexplained difference.
7. **Run the verification checks** below. Classify every failure.
8. **Commit.**
   - Use one merge commit, `chore: integrate upstream updates through <short UP>`,
     with the decisions in its body.
   - Run the pre-commit hook; do not use `--no-verify`.
   - Put unrelated fixes the maintainer asks for in separate commits.
   - Update this document in the merge commit.
   - Fast-forward `main` only after the maintainer approves.

### Preservation checks

**Both sides, per line.** Commit the merge locally first, or pass the merged tree's
revision, then run:

```sh
vp run upstream:preservation -- BASE UP FORK HEAD --json /path/outside/repo/preservation.json
```

For each file either side changed since `BASE`, the script compares the merged tree's
line counts with `base + (upstream - base) + (fork - base)`. It reports lines that are:

- **missing:** a side added the line, but the merged tree lost it;
- **not-removed:** a side removed the line, but the merged tree kept it;
- **whole files** either side changed that are missing from the merged tree.

Review every reported line and classify it:

- **ported:** the behavior survives in a rewrite, such as moved code or code adapted
  to the other side's replacement API. Name where it lives now.
- **decision:** covered by a recorded decision below.
- **superseded:** the other side deliberately replaced the behavior.
- **noise:** a comment, or a count artifact with no behavioral meaning.
- **lost:** fix it, with a test where the loss was behavioral.

Record the counts per category in Validation. The count check cannot see behavior
that changes without changing lines, which is why the verification checks below still
matter.

For a small range, `git show <commit> --format= | git apply -R --check --cached` per
upstream commit is a quicker exact check. Don't use it across a large range: once a
later commit touches the same lines, an earlier patch can't reverse-apply, so the
results are false positives.

Also confirm that every fork route, setting, RPC method, MCP tool, migration ledger
and provider is still registered.

**Measured surfaces.** Compare the MCP tool list per tool between `FORK` and the merge
(tool names, descriptions and input schemas), not only the total in
`agentContextBudget.json`. Explain every size change.

### Verification checks

Run each of these in the integration worktree:

- `vp run typecheck` in every workspace package and app, and in `evals`.
- `vp fmt --check`, `vp lint --report-unused-disable-directives` and `vp run knip:check`.
  These run across the whole repo. `vp run check:changed` would treat the whole merge
  as changed.
- **Web:** run `vp test run --project unit`. For `--project browser`, run four
  `--shard=<i>/4` runs. A single run on a cold Vite cache reloads tests mid-run.
  Re-run a shard if Vite reports newly optimized dependencies.
- **Other clients and packages:** run `vp test run` in `apps/mobile`, `apps/desktop`,
  `packages/client-runtime`, `packages/shared`, `packages/contracts` and every
  `packages/provider-*`.
- **Server:** run `vp test run` in `apps/server` in two halves:
  `--exclude 'src/orchestration-v2/**'` and `src/orchestration-v2`. Add
  `--reporter=json --outputFile.json=<file>`, because server test files run one at a
  time and the default reporter prints nothing until the end. A test that hits the
  120-second timeout is a hang to debug, not a slow test.
- **Classify every failure.**
  - Run the failing files at `FORK` in a detached sibling worktree
    (`git worktree add --detach ../t3code-fork-check FORK`, then `vp i`).
  - Failures that also fail there are pre-existing; record them below.
  - Anything that passes at `FORK` but fails after the merge is a regression to fix
    before committing.

The web `renders` project needs `T3CODE_RENDER_REPORT_DIR` and runs in its own CI
perf job, so leave it out. Remove the fork-check worktree when done.

## Included upstream changes

- T3 Code as an MCP server for other apps, agent sign-in approval through T3 Connect,
  `request_secret` with secret-provider references, and managed policy templates.
- `/clear` and fresh-session sends, scheduled-task thread modes and moving tasks between
  threads, and auto-settling inactive threads.
- Text generators for titles, commits and transcript cleanup, cloud and environment
  dictation, @-mentioned models, and suggested next prompts.
- Kiro and Cursor Origin, Claude Fable 5.2, Ultracode at any effort, and OpenCode goals,
  todos and native job tracking.
- The mobile navigation rework (route presets, one AppBar or SheetHeader per screen),
  the single Welcome page, and the Labs cleanup that removed plan mode.
- `effect/crypto` and `effect/jose` in place of `effect/Crypto` and `jose`,
  `Schema.TaggedError` throughout, and stricter Effect diagnostics.
- Conversation-only rewind in non-git workspaces.
- Upstream migrations 078–081 and broad server, streaming and mobile performance work.

The [upstream comparison](https://github.com/pingdotgg/t3code/compare/47f2c8d29e981c7723467efe137ee19e91df924e...31eea883c7f7849ada6eb49265cb11fc64d2ecbd)
holds the complete history: 1,078 commits since November 2, with desktop and server
moving from 0.1.6 to 0.1.9.

## Fork integration decisions

Work, teams, knowledge, guided approvals, guarded publication, assistants, private
memory, managed resources, shared project terminals, Home Assistant notifications,
plugins, the native OMP provider and attachment to an independently owned desktop
backend remain part of the fork. Their clients use the updated upstream navigation,
settings and mobile route structure.

The context-window meter was removed with upstream's Labs cleanup. The fork's
"Latest turn" work summary it carried now sits in the Thread details Context section.

Upstream's tool-call visibility setting and the fork's timeline settings (live
activity, turn-end folding, thoughts, pinned last message) coexist. When tool calls
are hidden, the timeline drops those rows before the fork's live-step and folding
logic runs; otherwise the fork's settings apply unchanged.

Scheduled tasks take upstream's thread modes and moves. Assistant routines stay bound
to their assistant's thread: a move or `new_thread` mode is refused, while
fresh-session runs stay in that thread.

Feature migrations retain their independent ledger and run inside upstream's shared
database setup, after the core migrations. The CLI takes the server's ownership lock
when either core or feature migrations are pending.

Image description and web search can't run on an upstream text generator; like
review guides, they fall back to a capable coding agent. Memory extraction may run on
a text generator.

Mobile thread-history operations persist through `expo-sqlite/kv-store`, since
upstream dropped `@react-native-async-storage/async-storage`. Pending operations
stored before the update are not carried over.

`@modelcontextprotocol/sdk` remains a fork-owned server dependency for the catalog
gateway and connections to users' own MCP servers. `pnpm-workspace.yaml` relaxes the
`@opentelemetry/api` peer range only for the OpenTelemetry SDKs that
`@oh-my-pi/pi-coding-agent`, a `provider-omp` dev dependency, brings in.

The MCP tool-list budget fell from 114,100 to 93,634 bytes with the same 88 tools:
the advertised-schema compactor now also collapses `t3_project_work_write`'s
intent union into one object. Inputs still decode against the full union.

Queued-run promotion follows upstream's recovery retry: an accepted promotion receipt
no longer ends promotion, so a run that recovery returned to the queue is promoted again
under a new receipt id. A rejected receipt still refuses, and only runs still queued can
be promoted.

Thread details pages long server lists four at a time, as upstream does, inside the
fork's Processes section. The tool inspector keeps output images inside the fork's
Output pane rather than above the input. Without a known threshold, the compaction note
no longer names the model, because upstream's shared message dropped that parameter.

Assistant chats keep their `"chat"` lineage relationship next to upstream's
`sideChat` flag; the two are separate features. Idle-compaction modes use upstream's
`idleCompaction` field and still read the legacy `compactIdleThreads` field.

## Validation

Every workspace package, app and the evals typecheck clean; lint reports no errors and
formatting is clean.

The web unit suite passes, and the web browser suite passes when run in shards (a cold
Vite dependency cache reloads browser tests mid-run on a single full run). Mobile,
desktop, client-runtime, contracts and the provider packages pass.

The server suite passes except tests that fail the same way on the fork before this
merge: six Codex account tests in `CodexChatGptAuth.test.ts` and
`CodexManagedRuntime.test.ts`, one storage-cleanup worktree case, the legacy v1 cutover
ledger case, the provider-switch and OpenCode replay fixtures (including upstream's new
OpenCode 2 pending-snapshot evidence), and a background-fetch case that fails only when
`GIT_SSH_COMMAND` is set.

The mobile dependency-graph test reports import cycles among the fork's Work task and
Assistants screens; those files are unchanged by this merge.

The preservation check flagged 208 files: 241 upstream lines and 926 fork lines, plus 18
whole files that were moved, deleted or dropped by decision. Review classified them as
794 ported, 174 decision, 25 superseded, 144 noise and 26 lost. All 26 lost lines were
upstream's server-list paging in Thread details, which is restored with its test.

Two fork paths needed changes to stay correct on the merged runtime. Project Work run
admission read the database while holding the event publish lane, which deadlocked
under upstream's concurrent PR-watch sweep; the read now happens inside the commit
transaction. Commits wake the effect worker only when they enqueue work, as upstream
does.

These checks do not replace full CI or browser, Electron, native-device and
real-provider verification. No installation switch, deployment or live database write
was performed.
