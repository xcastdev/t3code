# Upstream integration

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

**Last merged upstream commit:** `40dcbc5f6a8c4039f5f8f0dceb1bfa17ad0e3961`
(`fix(web): a stopped run no longer shows the green Done badge in the sidebar (#37475)`, 2026-11-15).
The next integration starts from this commit. Update this line and the table below
in every integration.

| Integration date | Previous upstream baseline                 | Updated upstream baseline                  | Fork before integration                    |
| ---------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 2026-10-27       | `e07595714a467e18c750107137d2c2e50f0c3530` | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `890e89f2e7b92c5524b47278da37ffd8fefc01dc` |
| 2026-11-02       | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `47f2c8d29e981c7723467efe137ee19e91df924e` | `63e994493a87319bfd31bcd0c71d6bcfcd123ab7` |
| 2026-11-11       | `47f2c8d29e981c7723467efe137ee19e91df924e` | `31eea883c7f7849ada6eb49265cb11fc64d2ecbd` | `bec7f5fad7167ed8e897b3d91468779216a79123` |
| 2026-11-15       | `31eea883c7f7849ada6eb49265cb11fc64d2ecbd` | `40dcbc5f6a8c4039f5f8f0dceb1bfa17ad0e3961` | `393439fae83cb791c847f060d59d4d3c65f10f7d` |

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
   - Take upstream's `.github/workflows/` and run `.github/fork/use-github-runners.sh`.
     The fork runs CI on GitHub-hosted runners, because Blacksmith needs a GitHub
     organization and this fork belongs to a personal account.
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
vp exec node scripts/upstream-preservation-check.ts BASE UP FORK HEAD --json /path/outside/repo/preservation.json
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

- Native provider resume, recovery and steering fixes, fairer queued-run and wake
  processing, and concurrent effects that do not stall unrelated threads.
- Faster thread opening, history paging, delegation and Git reads; SQLite writes
  move to a worker. Core migrations 082–096 add indexes, projection repairs and
  Connect device authorization.
- Web and mobile localization, agent theme editing, the native iOS image viewer,
  improved project search, and spreadsheet preview resizing.
- Pi session and worktree handoff repairs, live Cursor subagents and usage,
  Antigravity goals, OpenCode server usage limits, and managed provider updates.
- Terminal history persistence, batching, binary input and query-reply ownership;
  checkpoint, submodule, selected-file commit and worktree cleanup fixes.
- New Connect device approval, secret-reference validation, deferred MCP tool
  discovery and stricter advertised arguments, remote connection recovery,
  Windows services and keep-awake while agents work.

The [upstream comparison](https://github.com/pingdotgg/t3code/compare/31eea883c7f7849ada6eb49265cb11fc64d2ecbd...40dcbc5f6a8c4039f5f8f0dceb1bfa17ad0e3961)
contains 1,788 commits since the previous integration.

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
when either core or feature migrations are pending. Unsupported core migration
histories remain refused before commands; read-only CLI commands do not bypass
this guard.

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

The MCP tool list grows from 88 tools and 93,634 bytes to 91 tools and 95,214 bytes.
No fork tools are removed. Upstream adds `send_to_user`, `t3_theme_read` and
`t3_theme_set`. Existing changes add PR pagination and filters, scheduled-task
filtering, terminal binary/reply fields and bounded thread reads. Upstream's Gemini
schema compactor removes non-string advertised enums; full runtime unions still
validate Work inputs. Claude's system append is 5,930 bytes; Codex context is 7,324.

Queued-run promotion follows upstream's recovery retry: an accepted promotion receipt
no longer ends promotion, so a run that recovery returned to the queue is promoted again
under a new receipt id. A rejected receipt still refuses, and only runs still queued can
be promoted.

Thread details pages long server lists four at a time, as upstream does, inside the
fork's Processes section. When a tool's output is only images, such as a screenshot,
they lead the tool details on web and mobile, as upstream shows them; images that come
with text stay beside that text in the output. Without a known threshold, the
compaction note no longer names the model, because upstream's shared message dropped
that parameter.

Assistant chats keep their `"chat"` lineage relationship next to upstream's
`sideChat` flag; the two are separate features. Direct subagents of an assistant Home
follow their own project's idle and merge settlement settings while Home stays open.
Idle-compaction modes use upstream's `idleCompaction` field and still read the legacy
`compactIdleThreads` field.

Pi memory extraction requires the exact selected thinking level, preserving
provenance. Other background text generation uses upstream's fallback when that
level is unavailable. Cursor native resume keeps the previously delivered managed
instruction snapshot; a changed snapshot requires a fresh prompt. Reopened Cursor
sessions recover delivery proof from persisted receipts only when that run's
checkpoint is still the checkpoint Cursor resumes from. Missing or stale proof
requires a fresh prompt. This does not synchronize writes by another Cursor process
between the checkpoint check and resume.

No project scratch folders hide the source-control launcher and its shortcuts,
while linked pull-request details remain available. Real projects retain the
fork's source-control workspace and guarded publication.

Unreadable ordinary outbox effects fail and release later work, as upstream does.
Unreadable `workflow-owner-control:` effects remain retained so managed workflow
controls can recover when their decoder is available again.

OpenCode 2 reports completed when a timed-out Stop is followed by confirmed native
success. It reports interrupted only for a confirmed interruption. Either outcome
keeps subsequent turns blocked until the original native turn ends.

Force stop bridges delayed promotion only on the thread's active provider session,
when every unheld queued run is non-fresh and bound to that session. Same-instance
model changes remain eligible; mixed queues and older sessions use the existing
release-and-reopen path. A retained session is checked again after ten seconds and
released unless a follow-up has started on it. A slower promotion reopens the
session. Already-started follow-ups keep their session and normal idle lifecycle;
pending background work can extend that lifecycle beyond the default idle timeout. The
delayed pass repeats shared-thread protection and detaches the stopped thread
instead of releasing a process another thread is using.

## Validation

### Initial integration (2026-11-15)

Workspace packages, apps and evals typecheck without errors. Formatting and knip
pass; lint reports warnings but no errors.

Web unit tests pass (396 files, 5,796 tests), as do all four browser shards
(1,336 tests). Desktop, client-runtime, contracts and shared suites pass. Mobile
passes apart from the two Work/Assistants import-cycle checks reproduced on the
pre-merge fork.

All twelve provider packages typecheck. Their eleven test-bearing packages run
1,573 tests: 1,572 pass; the OpenCode upgrade HTTP test fails identically before
and after the merge. The provider-testing package has no tests.

The server suites ran in the prescribed two halves. Failures identified during
that run were fixed and the affected files rerun; the full halves were not rerun
on the final merge tree. The recorded baseline failures reproduce in
the detached fork checkout: six Codex private-listener cases, the legacy cutover
ledger fixture, OpenCode replay and pending-snapshot evidence, the queued provider
switch fixture, and the background-fetch test under inherited GIT_SSH_COMMAND.
The new upstream background-wake fixture reaches its output assertions but shares
the existing replay cleanup remainder; importing its data into the fork also
reproduces the five unconsumed cleanup frames.

Plugin panels retain their no-frame CSP even though generic MCP apps support
upstream blob frames.

Regression checks cover atomic launch receipts and legacy recovery, retained
admission during native resume, revoked and expired same-attempt recovery, rejected
fork admission rollback, shared-terminal binary input and query reply ownership,
and plugin CSP isolation alongside upstream MCP blob frames. Fork fixture schemas
were brought forward without weakening provenance or permission guards.

The per-tool MCP inventory preserves every fork tool. Registration review covers
routes, settings, RPC schemas/groups/handlers, providers and both migration ledgers;
the two changed layer expressions are upstream API ports. The preservation check
reviewed 111 files at merge commit `9e97eee3ca`: 259 upstream lines and 364 fork
lines. Classifications are
380 ported, 10 decision, 58 superseded and 175 noise, with no unexplained losses.

An isolated worktree server ran migrations and recovery, served the web client
(HTTP 200), and enforced authentication (HTTP 302); it was then stopped. No native
device or Electron UI verification, real provider turn or paid-model eval was run.
MCP eval unit tests and ten credential-free request constructions pass.

### Final-branch review (2026-11-16, `b5b23afa45`)

The full server halves ran again: 6,950 tests outside orchestration (6,930 pass,
7 fail, 13 skipped) and 3,214 orchestration tests (3,202 pass, 12 fail). Eighteen
failures match the recorded baselines; one additional failure exposed a Force stop
race that closes a promoted queued follow-up's session. All provider packages ran
1,573 tests: 1,571 pass and 2 fail. Besides the recorded OpenCode failure, ACP
Registry's readiness-version test times out at both this tree and pure upstream;
the environment-sensitive cause is unknown.

The preservation check at this tree reports 113 files, 261 upstream lines and 367
fork lines. The five lines added to the historical report are ported: the extended
InstructionDelivery service return and the Cursor test runner/session refactor.
No additional functionality loss was found.

### Review fixes (2026-11-16, working tree based on `b5b23afa45`)

The deterministic Force stop regression fails before the retention fix and passes
after it. Cursor's real local SDK store test rejects a stale proof when the agent
checkpoint advances before its run record is patched, while still allowing an
uncheckpointed newer run and preserving historical checkpoint queries. Adapter
tests reject stale proof and assert the specific refusal reasons. Server tests
cover lazy proof forwarding, typed lookup failure, missing receipt rows and newer
unnamed turns. These are local tests, not a real provider turn or a reproduction of
the hypothesized crash plus instruction-revert sequence.

Focused server checks pass: five files / 290 tests, followed by queue/session,
admission and Force stop checks (four files / 137 tests, with overlap). All 161
Cursor package tests pass. Server and Cursor typechecks, scoped formatting/lint,
knip and diff checks pass. No full client or server suites were repeated for these
follow-up fixes; the full-branch results above remain the latest broad run.

The audited code tree `331b228083b55d340fc721fdfbe4559c4e544d8c` reports
117 files, 278 upstream lines and 367 fork lines. Compared with `b5b23afa45`,
17 additional reported lines are accounted for: 13 ported (expanded session
retention, checkpoint API and test harnesses) and 4 noise (rewritten comments and
an unchanged typed-error fallback appearing at another count). Including the
previous follow-up, totals are 398 ported, 10 decision, 58 superseded and 179 noise;
no unexplained loss remained at that stage. Subsequent Force stop refinements are
verified separately below.

### Force stop refinement (2026-11-16, working tree based on `b5b23afa45`)

Additional regressions cover explicit and follow-current model changes, mixed
queues with a shared continuation key, already-ended targets, a reordered fresh
context with a busy older session, and refused promotion. Five cases fail on the
preceding implementation and pass with the refined rule; forcing the ended-target
guard true also fails its regression case. All 57 ThreadStop and 35
ThreadManagementService tests pass, as does server typecheck. The ten-second grace
is tested with TestClock, including retention of a started follow-up. Background
work is simulated; no real provider turn was run.

An additional 206 queue/session/admission and managed-start tests pass (298 server
tests across seven files, without overlap). Scoped formatting/lint, knip and the
server typecheck pass. The gated positive cases delay promotion until Force stop
returns, start the follow-up nine seconds later, and keep its session through the
cleanup deadline.

The audited code tree `c3e6bfd0fc969323fe7a5d8ce28efd3df0388b75` still reports
117 files, 278 upstream lines and 367 fork lines. Three previously reported
predicate lines are now present again; three table/capability lines are ported
into the expanded regression harness instead. The classification totals remain
398 ported, 10 decision, 58 superseded and 179 noise, with no unexplained loss.
At that stage, only validation text changed after the audit.

### Shared-session review follow-up (2026-11-16)

The Opus review found a missing shared-thread check in delayed cleanup. A new
regression attaches a second thread during the grace period, completes its turn,
and persists background work in the projection. The old delayed pass kills that
shared process; repeating `otherWorkingThreads` and detaching instead preserves
it. All 58 ThreadStop and 35 ThreadManagementService tests pass, as do server
typecheck and scoped formatting/lint. No further delegated review was run for
this small safeguard.

The incremental audit at code tree `574ad7ca72a2fa1fbb27974a8493620af7483621`
rechecks the three files changed since the full audit, retaining the unchanged
files' results. It reports 117 files, 279 upstream lines and 367 fork lines. The
additional native-thread fixture line is ported into per-thread identifiers;
totals are 399 ported, 10 decision, 58 superseded and 179 noise. Only this
validation text changed after the incremental audit.

Main has not been advanced; no deployment or live database write was performed.
