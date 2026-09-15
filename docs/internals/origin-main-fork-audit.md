# `origin/main` fork audit

This report records the fork-only work on `origin/main` relative to the local
`upstream-main` mirror. The refs were fetched on 2026-09-14. The implementation
claims below come from the current code, contracts, tests, and user and internal
documentation at `origin/main`, not from commit subjects alone.

## Bottom line

The fork contains seven substantial product changes:

1. Home Assistant external notifications.
2. OpenCode command, subagent, request, stop, and recovery parity.
3. A three-area web/desktop workspace with independent file-editor and tool panes.
4. A Source Control panel with whole-file index operations and guarded index commits.
5. Project-local and scoped MCP catalogs, secure credentials, OAuth, proxying, and
   external OpenCode MCP management.
6. Desktop attachment to an already-running loopback `t3 serve` backend.
7. Per-turn model, effort, work counts, changed-file counts, and improved activity
   presentation in chat.

The fork also adds a separate database migration sequence, two MCP SDK patches,
the fork synchronization guide, and several design and research records.

The main maintenance problem is not a failing fork test. It is the size of the
unsynchronized history. `origin/main` has 182 fork-only commits, while the requested
`upstream-main` has 1,074 upstream-only commits. A synthetic merge reports 137
conflicted paths. The published `origin/upstream-main` branch is still at the common
ancestor, and the local `upstream-main` is one commit behind the fetched
`upstream/main`.

## Scope and comparison method

The feature inventory uses the three-dot range:

```text
git diff upstream-main...origin/main
git log upstream-main..origin/main
```

The three-dot diff compares `origin/main` with the merge base. It isolates what the
fork added. A direct tip-to-tip diff would mix the fork's work with 1,074 unrelated
upstream commits and would not answer which features belong to the fork.

This report does not audit the behavior introduced by the 1,074 upstream-only
commits. It does measure their integration impact with `git merge-tree`, which does
not modify the working tree.

The audit covered:

- the complete fork-only commit graph;
- all 380 fork-changed paths and their directory distribution;
- the contracts, server services, provider adapters, clients, migrations, and
  focused tests for each feature family;
- the current user and internal documentation; and
- the current merge result against `upstream-main`.

No browser or mobile simulator was launched. The repository instructions require
explicit approval for computer-use verification.

## Branch topology and drift

| Ref                              | Revision                                   | State at audit time                                                                                           |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| merge base                       | `bba79cc254b65969bde6b6bfc3032c3b5b9316ae` | Last commit shared by the fork and requested mirror: `fix(web): hide invalid slash skill completions (#8904)` |
| `origin/main`                    | `dccea637fb2ff4190417891a7a9e86fee118b504` | Fork tip: `fix(server): honor T3CODE_HOME in migrate-dev-db`                                                  |
| local `upstream-main`            | `a62e7d670c67bf221a5699b5a988367781fead74` | Requested comparison tip: `refactor(server): align title generation with Effect conventions (#11847)`         |
| fetched `upstream/main`          | `5623089aea68ca62811f51321686c259fa4c810f` | One commit ahead of local `upstream-main`                                                                     |
| published `origin/upstream-main` | `bba79cc254b65969bde6b6bfc3032c3b5b9316ae` | Still at the merge base; 1,074 commits behind local `upstream-main`                                           |

The graph is effectively:

```text
                                      1 commit
                                     ----------> upstream/main
                                    /
merge base ------------------------+-----------> upstream-main
    \                                1,074 commits
     \-- 182 fork commits --------------------> origin/main

origin/upstream-main remains at the merge base.
```

The fork-only work was authored between 2026-08-31 and 2026-09-09. All 182 commits
have the same author identity, `xcastdev <xcastdev0619@gmail.com>`. There are 174
non-merge commits and eight merge commits. No merge brings newer upstream history
into `origin/main`; the eight merges integrate fork feature branches.

The documented workflow in [`FORK.md`](../../FORK.md) says the local mirror,
published mirror, and fetched upstream ref should match after synchronization. The
current refs do not satisfy that invariant:

- `origin/upstream-main` is 1,074 commits behind local `upstream-main`.
- local `upstream-main` is one commit behind `upstream/main`.

A synthetic merge of `origin/main` and the requested local `upstream-main` reports
137 conflicted paths. The conflicts span every high-change boundary: desktop
startup, mobile thread state, server orchestration, every provider adapter, MCP,
Git/VCS, web chat and workspace layout, contracts, shared utilities, documentation,
and the lockfile. This is a porting project, not a routine update merge.

## Size and composition

Relative to the merge base, the fork changes 380 files with 85,330 insertions and
8,092 deletions. Rename detection is not needed for these counts.

| Area                       | Files | Insertions | Deletions | Main reason                                                                                          |
| -------------------------- | ----: | ---------: | --------: | ---------------------------------------------------------------------------------------------------- |
| `apps/`                    |   285 |     70,883 |     7,998 | Server MCP/provider/VCS work, web workspace and timeline, desktop attachment, mobile timeline counts |
| `packages/`                |    47 |      5,852 |        59 | Wire contracts, client runtime state, shared count and Git helpers                                   |
| `docs/`                    |    43 |      8,154 |        10 | User docs, architecture notes, plans, specifications, ledgers, and research                          |
| `patches/`                 |     2 |        192 |         0 | MCP client/server SDK fixes                                                                          |
| root and lock/config files |     3 |        249 |        25 | Fork guide, exact MCP dependencies, patch registration                                               |

The path statuses are 143 added files and 237 modified files. There are no deleted
paths in the fork-only diff.

Test work is unusually large: 131 test files changed, of which 54 are new and 77
are modified. Test files account for 42,123 insertions and 4,445 deletions, almost
half of all fork insertions. This is strong evidence density, although it does not
replace integrated client testing.

The commit subjects break down as follows:

| Subject class             | Count |
| ------------------------- | ----: |
| `fix`                     |   108 |
| `feat`                    |    29 |
| `docs`                    |    12 |
| `checkpoint`              |    11 |
| `chore`                   |     7 |
| `test`                    |     5 |
| `refactor`                |     1 |
| unstructured `added docs` |     1 |
| merge commits             |     8 |

The history is implementation-heavy and corrective. The many follow-up `fix` and
`checkpoint` commits show that concurrency and lifecycle edge cases were found and
addressed after the initial feature commits. They also make the history harder to
review than the final tree.

## Feature and surface matrix

| Feature                      | Server/contracts              | Web                                               | Desktop                   | Mobile                    | Provider impact                                                    |
| ---------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------ |
| External notifications       | Full                          | Settings editor                                   | Uses web editor           | No editor                 | Uses provider-neutral awareness state                              |
| OpenCode parity and recovery | Full                          | Shared thread UI benefits                         | Shared thread UI benefits | Shared thread UI benefits | OpenCode-specific, with provider-service fencing                   |
| Workspace pane redesign      | Client state only             | Full                                              | Full through web shell    | Not implemented           | None                                                               |
| Source Control panel         | Full                          | Full                                              | Full through web shell    | Not implemented           | None                                                               |
| Project-local MCP editor     | Full                          | Full                                              | Full through web shell    | Consume only              | Codex, Claude, Cursor, Grok, OpenCode                              |
| Scoped MCP catalogs          | Full RPC/backend              | No editor                                         | No editor                 | No editor                 | All current adapters require restart; external OpenCode can opt in |
| Attached primary backend     | Server CLI plus IPC contracts | Recovery/settings surface inside desktop renderer | Full                      | Not applicable            | Provider-neutral once attached                                     |
| Per-turn activity visibility | Full                          | Full                                              | Full through web shell    | Work-count subset         | Provenance from all adapters; effort varies by provider            |

## 1. External notifications

### What was added

The server can publish agent-awareness snapshots to configured external
destinations. The only implemented destination is a Home Assistant webhook. The
web/desktop Integrations page can add, label, enable, disable, test, update, and
delete destinations and can choose the application deep-link scheme.

The payload is versioned (`schemaVersion: 1`) and carries the environment, thread,
project title, thread title, model title, phase, headline, optional detail, relative
route, and application deep link. A deletion or unavailable project/thread emits a
payload whose `state` is `null`.

### Data and delivery path

The relevant path is:

```text
orchestration change
  -> AgentAwarenessRelay snapshot and sanitization
  -> ExternalNotificationDispatcher
  -> HomeAssistantWebhookAdapter
  -> HTTP POST with JSON body
```

The dispatcher deduplicates unchanged meaningful state per destination and thread.
It excludes `updatedAt` from the deduplication identity. One dispatch batch is
serialized, then up to four destinations are sent concurrently. Each Home Assistant
request has a ten-second timeout. Delivery failures are logged and swallowed so a
notification outage cannot fail orchestration or relay publication.

Webhook URLs are write-only across the RPC boundary. The server stores each URL in
`ServerSecretStore`, sends only a `configured` marker to clients, removes the secret
when a destination is deleted, and restores the previous secret snapshot if the
settings write fails. The test operation uses the same adapter and returns a typed
error for malformed URLs, timeout, transport failure, non-2xx status, or missing
configuration.

The feature works without T3 Connect activity publishing. T3 Connect Cloud does not
deliver these external notifications; the local environment sends them directly.

### Limits and risks

- Delivery is best-effort. There is no durable queue, retry policy, backoff, or
  delivery history.
- The deduplication map is in memory. A server restart can republish the current
  active snapshot.
- Only Home Assistant is implemented, despite the destination contract being a
  closed union designed for more adapters.
- The destination URL accepts any `http:` or `https:` URL. This is an intentional
  administrator-controlled outbound request surface and should remain protected by
  the server-settings authorization boundary.
- Configuration exists only in the web surface, which desktop shares. Mobile has no
  editor.

See [`external-notifications.md`](../user/external-notifications.md),
[`ExternalNotificationDispatcher.ts`](../../apps/server/src/notifications/ExternalNotificationDispatcher.ts),
and [`HomeAssistantWebhookAdapter.ts`](../../apps/server/src/notifications/HomeAssistantWebhookAdapter.ts).

## 2. OpenCode parity, stop semantics, and recovery

### What was added

The first OpenCode series closes behavior gaps between OpenCode's native event model
and T3 Code's orchestration model:

- pending questions and approvals survive until they are resolved or the correct
  teardown path settles them;
- plan tasks and child task lifecycle events are projected;
- native slash commands are loaded from inventory and invoked through OpenCode's
  command endpoint, with typed argument expansion;
- out-of-order text events are preserved;
- child requests enter waiting state and remain cancellable;
- top-level subagents and child tool calls receive the correct ownership and
  attribution;
- approval request kinds are preserved;
- missing session-error IDs do not corrupt routing;
- deleted parent sessions release child bookkeeping; and
- idle child tasks complete instead of remaining active forever.

The shared server path was also changed so aborted turns settle only when the
provider confirms the abort. Requests belonging to an aborted turn are cancelled.

### External-server ownership model

The second OpenCode series separates detaching from terminating. T3 Code treats an
external OpenCode server as independently owned:

- server restart, client reconnect, adapter shutdown, and `stopAll` detach T3 Code
  without aborting work on the external server;
- reconnecting the same saved session reuses the upstream work and preserves pending
  questions and approvals;
- replacing a session with a different upstream target terminates the old target;
- explicit stop calls OpenCode abort and waits for a matching abort event or a valid
  idle status;
- an unconfirmed abort fails after a ten-second window and leaves the session active
  for another attempt; and
- per-thread barriers and generation checks prevent a late recovery, send, or MCP
  handoff from publishing after a stop has won.

Managed OpenCode process replacement drains old instance generations while active
sessions still own them. Failed handoffs restore permissions and MCP configuration
where ownership is unambiguous. Hidden sessions still receive explicit termination
during cleanup.

### Limits and risks

OpenCode now has the most specialized adapter in the fork: roughly 2,915 net-new or
rewritten implementation lines and 10,350 changed test lines in
`OpenCodeAdapter.ts` and `OpenCodeAdapter.test.ts` alone. The tests are extensive,
but this concentration makes future upstream adapter changes expensive to merge.

External OpenCode MCP management, described under the MCP feature, is disabled by
default. Its lease protects only one T3 server process; it cannot coordinate another
T3 process or a native OpenCode client.

See [`providers-opencode.md`](../user/providers-opencode.md) and
[`providers.md`](providers.md).

## 3. Workspace panes and combined header actions

### What was added

The web workspace, and therefore the desktop renderer, now has three independent
areas:

- the navigation sidebar for projects, threads, and application navigation;
- the main workspace containing chat and an optional secondary file pane; and
- the right sidebar for project tools.

The right sidebar collapses to an icon rail. Opening a surface turns it into a
tabbed panel, and the plus menu can add another tool without replacing existing
tabs. Project Explorer remains in the right sidebar, while files opened from the
explorer, chat links, search, diffs, or the file picker open in the separate
secondary pane.

Secondary file tabs are persisted per environment/thread key. The persisted state
is sanitized on hydration, normalizes path separators and line numbers, removes
invalid records, and never leaves an active tab pointing at a missing surface. Tabs
support close, close others, close to the right, and close all. Only the active file
editor is mounted. The pane can be maximized when laid out inline.

The layout switches from side-by-side to stacked when the measured workspace is 760
pixels wide or less. Chat, secondary pane, and right sidebar widths are managed
independently. Narrow layouts use a sheet for the right sidebar.

A smaller companion change combines the project script action and its menu in the
chat header. It preserves the selected script when valid, falls back to the primary
script, and exposes the add-script editor as a distinct menu intent.

### Limits

- This is a web/desktop feature. Mobile keeps its separate React Native navigation.
- Only file surfaces currently inhabit the secondary pane. The state model is named
  generically, but its union contains only `kind: "file"`.
- The redesign touches the large `ChatView.tsx` integration point, which is also a
  major source of the 137 upstream merge conflicts.

See [`workspace-panes.md`](../user/workspace-panes.md) and
[`secondaryPaneStore.ts`](../../apps/web/src/secondaryPaneStore.ts).

## 4. Source Control panel and guarded Git mutations

### What was added

The fork replaces separate Diff and Pull Requests rail actions and the header's
Commit & Push control with one Source Control surface. It has Changes and Pull
requests views. The existing bottom-left Pull Requests shortcut opens the latter.

The Changes view provides:

- current branch and ahead/behind state;
- staged, unstaged, untracked, both-staged-and-modified, and conflicted file states;
- staged-versus-`HEAD` and working-tree-versus-index diff selection;
- whole-file stage and unstage operations;
- index-only commit with a message;
- branch switching and branch creation; and
- live status refresh when another client or process changes the repository.

### Safety model

The server routes operations through the detected VCS driver and rejects non-Git
repositories. Mutations are serialized by repository root, not by client or input
working directory. Paths are normalized relative to the resolved repository and
passed through Git's literal pathspec mode. Rename pairs, submodules, merge heads,
unborn branches, cherry-pick state, and revert state receive explicit handling.

Before an index commit, the client submits the reviewed branch/ref, `HEAD`, index
tree, and merge heads. The server re-reads those values and rejects stale state.
Publication uses guarded ref updates and verifies postconditions. If commit hooks or
publication fail, the implementation attempts to restore the ref and preserve or
clean the relevant merge state rather than reporting success after a partial
mutation.

Default-branch commits and dirty branch switches require confirmation. The server
enforces the same gates, so a stale or malicious client cannot bypass the prompt by
calling the RPC directly. Capability flags keep older servers on the pre-existing
status, branch, initialization, and pull-request paths while hiding unsupported
index operations.

### Limits

- Staging is whole-file only; there is no hunk staging.
- Conflict resolution is not implemented.
- The panel is web/desktop only.
- The safe commit path is much more complex than a direct `git commit`: it performs
  reviewed-state checks, commit-tree construction, ref publication, hook handling,
  and cleanup. Future Git behavior changes need the same edge-case test depth.

See [`source-control.md`](../user/source-control.md),
[`SourceControlPanel.tsx`](../../apps/web/src/components/source-control/SourceControlPanel.tsx),
and [`GitVcsDriverCore.ts`](../../apps/server/src/vcs/GitVcsDriverCore.ts).

## 5. Project MCP servers and scoped catalogs

This is the largest and least uniform feature family. It has two client generations
and several server layers.

### Project-local editor

The visible Settings -> Integrations -> MCP servers editor manages project-local
definitions. It supports:

- Streamable HTTP;
- legacy HTTP plus SSE;
- local stdio commands with ordered arguments, working directory, and environment;
- provider assignment and enablement;
- write-only HTTP headers and stdio environment credentials;
- OAuth with automatic registration or pre-registered clients; and
- connect, open authorization, disconnect, and credential replacement actions.

HTTP URLs must use HTTPS or loopback HTTP and may not embed userinfo or query
strings. The stdio process inherits the host environment. Its stderr is discarded at
the OS boundary so arbitrary server diagnostics, including secrets, cannot block a
pipe or enter logs.

Secrets, OAuth tokens, PKCE verifiers, client details, and authorization state live
in `ProjectMcpSecretStore`; they do not enter orchestration events, projections, or
RPC responses. Providers receive authenticated, server-specific T3 proxy URLs, not
the upstream command, URL headers, working directory, environment, or credentials.
Credentials are leased so an existing session can retain its exact definition after
the saved definition rotates.

Streamable HTTP falls back to legacy SSE only when initialization returns 400, 404,
or 405. Authentication, rate-limit, timeout, network, and other server failures stay
visible instead of being masked by fallback.

### Scoped catalog backend

The later catalog work adds durable global definitions, project overrides,
project-local definitions, logical-session baselines, session overrides, and
session-local definitions. Resolution order is:

```text
global definitions
  -> project overrides
  -> project-local definitions
  -> captured session baseline
  -> session overrides
  -> session-local definitions
  -> enabled/provider filtering
  -> name and 50-entry-limit validation
```

Logical server IDs survive overrides. Definition IDs change when transport,
credential references, ordered fields, or credential values change. Metadata-only
edits retain the definition ID. The server tracks desired and applied revisions and
persists the applied catalog for recovery.

The gateway can atomically replace a live catalog and publish MCP list-change
notifications. It reversibly rewrites tool names and resource URIs to avoid
cross-server collisions. The gateway contract is tested with one client connection
across add, update, and remove operations.

However, no current provider adapter advertises live session-catalog application.
Codex, Claude, Cursor, Grok, and managed or opted-in OpenCode all declare
`sessionMcpCatalog: "restart-required"`. External OpenCode without explicit MCP
management declares it unsupported. The live gateway is infrastructure for a future
provider capability, not a currently exposed live-reload feature.

The scoped global, project-override, and session editors are also not exposed in web,
desktop, or mobile. They exist as capability-gated RPCs. The visible editor remains
the legacy project-local editor. Mobile can consume configured catalogs but cannot
edit them.

### External OpenCode MCP management

An external OpenCode server can opt in to T3-managed preview, project, and session
MCP entries. T3 Code rebases issued proxy endpoints onto a configured HTTPS public
origin when the two servers are on different machines. Loopback HTTP is allowed only
for same-machine operation.

Names and headers carry ownership and generation markers. The coordinator checks
configuration and connection state before and after mutation, disconnects stale
entries owned by this environment, rejects foreign name collisions, and requires a
connected result. One process permits one MCP-enabled session for a canonical
external URL plus exact directory. OpenCode 1.15.13 has no dynamic remove endpoint,
so cleanup leaves disabled entries in its configuration.

### SDK patches and maintenance cost

The fork pins `@modelcontextprotocol/client`, `core`, and `server` at `2.0.0`. It
patches the client and server bundles for two protocol defects:

- cancellation of JSON-RPC request ID zero; and
- progress delivered synchronously immediately before a response.

Both ESM and CommonJS bundles are patched. Public-transport and stdio regression
tests cover the behavior. An SDK upgrade must prove those cases before the patches
can be removed.

This subsystem accounts for most of the large corrective/checkpoint commits. It
crosses contracts, event sourcing, projections, migrations, secrets, OAuth HTTP,
stdio child processes, proxy HTTP servers, provider lifecycle, and external
OpenCode. It should be treated as the fork's highest regression-risk area.

See [`project-mcp-servers.md`](../user/project-mcp-servers.md),
[`mcp-catalog-scopes.md`](mcp-catalog-scopes.md), and
[`mcp-sdk-patches.md`](mcp-sdk-patches.md).

## 6. Desktop attachment to an existing primary backend

### What was added

The Electron app can use an already-running local `t3 serve` process as its primary
environment instead of launching and owning another backend. `t3 serve` and
`t3 pair --owner` can print a `t3code://attach-primary` deep link containing a
one-time owner pairing URL.

The attachment service accepts only `http:` loopback endpoints (`localhost`,
`127.0.0.0/8`, or `::1`). It rejects URL userinfo, unsupported parameters,
non-administrative credentials, and endpoints already owned by the desktop backend
pool. It exchanges the one-time owner credential for an administrative bearer,
checks the environment descriptor, encrypts the bearer with Electron safe storage,
and persists only the ciphertext, environment identity, endpoint, label, and expiry.

In attached mode:

- the environment still occupies the special `primary` bootstrap slot;
- Electron serves its bundled web client and proxies API/WebSocket traffic to the
  attached server;
- the desktop does not allocate a backend port or start, stop, restart, expose, or
  reconcile WSL for the attached process;
- local editor and file actions assume the same filesystem namespace; and
- quitting the desktop leaves the CLI server running.

Expired credentials can be refreshed with a new owner token. Stored identity is
checked before and after renewal. Invalid persisted state and failed launch-intent
transactions go through explicit native recovery instead of silently starting a
managed backend. Selection, attachment, credential renewal, and protocol
registration are serialized and use generation/claim checks to prevent late startup
work from winning a newer choice.

### Limits

- This feature intentionally supports only same-machine loopback HTTP. It is not a
  general remote-backend attachment mechanism.
- Desktop-native operations assume the attached server sees the same filesystem.
- Owner pairing URLs and printed attach deep links are secrets until exchanged.
- Process-owned controls such as WSL selection, Tailscale Serve, desktop exposure,
  and server restart are unavailable while attached.

See the accepted behavior in
[`2026-09-08-attached-primary-backend.md`](../superpowers/plans/2026-09-08-attached-primary-backend.md)
and the implementation in
[`DesktopAttachedBackend.ts`](../../apps/desktop/src/backend/DesktopAttachedBackend.ts).

## 7. Per-turn activity visibility

### What was added

Each turn can persist the model and reasoning effort that actually started it.
Finished and stopped turns can also persist counts for commands, tool calls,
subagents, and changed files. The web/desktop timeline renders a compact fold such
as:

```text
Worked for 1m 12s | 5 Commands | 7 Tool Calls | 2 Subagents | 3 Changed Files +42/-11
```

The assistant footer displays per-turn model, effort, duration, and clock time.
Individual work rows show a normalized command/tool label, description, and duration.
The live row describes the current activity rather than displaying a generic status.

Provenance is stamped at turn start because thread-level model selection is mutable.
Effort is resolved in the adapter so historical turns do not depend on today's model
catalog. Counts are stamped once when the turn settles, with a late changed-file
restamp only after a completed diff. Shared classification deduplicates tool
lifecycle rows, separates commands from tools and subagents, excludes hidden rows,
and keeps server and client counts aligned.

The snapshot names turns whose activity rows were cut by the 500-row retention
window. The client suppresses counts it cannot prove rather than presenting an
undercount. Older hosts receive a conservative fallback: once the activity window is
full, derived historical counts are hidden. Turn snapshots themselves are capped at
500 per thread.

The web timeline now follows streaming output from the first token until the user
scrolls away. The previous reserved-space anchoring mode was removed. Mobile uses
the same work-count rules and changed-file segment, but keeps its own scroll model.

### Surface and data limits

- Mobile shows the aggregate fold counts but not the model/effort footer or per-tool
  duration column.
- Per-turn token and cost accounting is not implemented.
- Cursor and Grok report model but not effort. OpenCode maps its variant to effort.
- A mid-turn steer that changes models does not restamp provenance.
- Historical turns from before these fields shipped correctly show less data; there
  is no speculative backfill.

See [`chat-timeline.md`](../user/chat-timeline.md) and
[`turn-provenance.md`](turn-provenance.md).

## 8. Fork migration sequence and maintenance tooling

The server now runs upstream and fork migrations independently:

| Sequence | Tracking table          | Directory                                      |
| -------- | ----------------------- | ---------------------------------------------- |
| upstream | `effect_sql_migrations` | `apps/server/src/persistence/Migrations/`      |
| fork     | `t3_fork_migrations`    | `apps/server/src/persistence/Migrations/fork/` |

This prevents upstream and fork migrations from assigning the same numeric ID to
different schema changes. Upstream runs first; fork migrations may depend on the
upstream schema, but upstream migrations must not depend on fork tables.

The six current fork migrations add:

1. turn provenance and work-count columns;
2. projected project MCP servers;
3. project MCP transport data;
4. scoped MCP catalog state;
5. catalog revision tracking; and
6. persisted applied catalog state.

`migrate-dev-db` now checks both migration sequences and respects the effective
`T3CODE_HOME` when locating data. See
[`database-migrations.md`](database-migrations.md).

## Documentation and proposals that are not shipped features

The fork commits 24 files under `docs/plans`, `docs/superpowers`, and
`docs/research`. They preserve specifications, ledgers, remediation plans, and one
research proposal. They are useful historical evidence, but they should not be read
as additional shipped behavior.

In particular:

- [`agent-workspace-ideas.md`](../agent-workspace-ideas.md) proposes durable project
  knowledge, tasks, skills, commands, agents, snippets, terminal MCP tools, durable
  chat forks/reverts, usage monitoring, and subagent controls. Most of that list is
  direction, not implementation in this fork range.
- [`2026-09-08-durable-project-knowledge-mcp.md`](../research/2026-09-08-durable-project-knowledge-mcp.md)
  is research, not a delivered project-knowledge service.
- The scoped MCP editor is explicitly absent even though its server RPCs and design
  records exist.

The current repository instructions say not to commit implementation plans or agent
scratch records. The 24 committed plan/research files predate or conflict with that
current policy and will also add avoidable upstream merge work.

## Audit findings

### 1. Upstream integration is the immediate blocker

Severity: high.

The fork and requested mirror have 1,256 unique commits between them, and a synthetic
merge produces 137 conflicted paths. The conflict set overlaps all major fork
features. A single bulk merge would combine feature preservation, upstream
architecture migration, schema reconciliation, dependency updates, and UI redesign
in one review.

Recommended treatment: port and validate feature families against current upstream
in dependency order. Start with fork migration semantics and contracts, then MCP and
provider lifecycle, then client surfaces. Preserve the old fork branch as the
behavioral reference until the port is complete.

### 2. The published mirror does not match the documented workflow

Severity: medium.

`origin/upstream-main` remains at the merge base while local `upstream-main` is 1,074
commits newer. The local mirror is also one commit behind fetched `upstream/main`.
Anyone cloning only `origin` cannot reproduce the comparison used by this report
without fetching the separate upstream remote.

Recommended treatment: after deciding the integration baseline, fast-forward the
local mirror from `upstream/main` and publish that exact mirror to origin. Do not do
this as part of a feature commit.

### 3. Scoped MCP is backend-complete but product-incomplete

Severity: medium.

Global, project-override, and session catalog mutations exist as durable RPCs, but no
client editor exposes them. Every current provider adapter is restart-required, so
the live gateway has no provider consumer advertising live application. The visible
MCP editor covers only project-local definitions.

Recommended treatment: describe this as infrastructure until one provider has a
tested live capability and the intended scope editors ship. Keep capability-gating
strict so older clients and unsupported providers do not imply otherwise.

### 4. MCP and provider lifecycle carry most of the complexity

Severity: medium.

The MCP catalog branch contains 66 commits before its merge, followed by more
provider and cleanup fixes. Several individual checkpoint commits change thousands
of lines. The server typecheck succeeds, but it reports 13 Effect guidance
suggestions for `Effect.runPromise` calls made inside Effects in
`ProjectMcpOAuth.ts` and `ProjectMcpProxyRegistry.ts`. Those calls deserve review
when the subsystem is next changed because they can separate child work from the
surrounding service context.

Recommended treatment: retain the focused protocol, stdio, OAuth, lifecycle, and
external OpenCode fixtures during any port. Remove the typecheck suggestions only
with behavior-preserving tests around interruption and scope ownership.

### 5. History quality is weaker than final-tree test quality

Severity: low to medium.

The final tree has broad tests, but the history contains opaque subjects such as
`checkpoint(mcp): ...`, `chore(mcp): checkpoint ...`, and `added docs`. The largest
commit changes 7,429 lines; five commits change more than 3,000 lines. This makes
review, cherry-picking, and regression bisection harder. The merge topology also
includes a merge of `main` into the MCP feature after the chat feature was already
integrated.

Recommended treatment: use the feature boundaries in this audit rather than raw
commit boundaries for an upstream port. For future fork work, keep one behavioral
change per commit and reserve `checkpoint` for local, unpublished history.

### 6. Product coverage is intentionally uneven across clients

Severity: low.

Workspace panes, Source Control, external notification settings, the MCP editor,
desktop attachment controls, model/effort footers, and tool durations are absent
from mobile. Mobile does receive per-turn work counts and can consume configured MCP
catalogs. These are explicit surface decisions, not hidden parity.

Recommended treatment: keep the surface matrix in release notes and compatibility
tests so a server capability is not mistaken for a mobile control.

### 7. External notification delivery has no durability

Severity: low for awareness notifications; higher if used as automation triggers.

Failures are logged and discarded, and deduplication is process-local. This is
appropriate for informational awareness updates. It is not an at-least-once event
delivery system.

Recommended treatment: document the best-effort contract wherever integrations are
marketed. Add persistence and retry only if these webhooks become workflow-critical.

### 8. `git diff --check` is not clean because of vendored patch text

Severity: low.

`git diff --check upstream-main...origin/main` reports space-before-tab and trailing
whitespace only inside the two MCP SDK patch files. The whitespace is part of the
patched generated bundle text, not ordinary TypeScript or Markdown. No other fork
path is reported.

Recommended treatment: do not normalize the patches blindly. Recreate and retest
them when upgrading the SDK, then check whether the replacement patch can avoid the
whitespace warnings.

## Verification performed

The following focused test set passed at the audited fork tip:

```text
20 test files passed
722 tests passed
```

It covered notification contracts and dispatch, Home Assistant transport, Git
contracts and driver behavior, MCP contracts/resolution/OAuth/broker/gateway,
OpenCode adapter behavior, fork migration sequencing, desktop attachment and launch
intents, web timeline logic, Source Control logic, secondary-pane persistence, and
mobile turn activity.

Targeted typechecks also passed with no errors for:

- `apps/server`
- `apps/web`
- `apps/desktop`
- `apps/mobile`
- `packages/contracts`
- `packages/client-runtime`
- `packages/shared`

The server, desktop, and client-runtime checks emitted non-failing Effect style and
service-context suggestions. The MCP suggestions called out above are the ones most
relevant to fork-added code.

No integrated browser, Electron, iOS, or Android pass was run. No repository-wide
test or typecheck command was run.

## Recommended preservation order

If the fork is moved onto current upstream, preserve behavior in this order:

1. Establish the new upstream baseline and the independent fork migration table.
2. Port MCP contracts, secret storage, project-local definitions, OAuth, and proxy
   behavior.
3. Port scoped catalog events/projections and provider lifecycle fencing.
4. Port OpenCode parity and external-server detach/termination semantics.
5. Port per-turn provenance and counts, including migration and retention rules.
6. Port external notifications from the awareness snapshot boundary.
7. Port Source Control contracts and guarded server mutations before its UI.
8. Port workspace pane state and Source Control/workspace UI against current web
   architecture.
9. Port desktop attachment against current Electron startup and IPC code.
10. Reapply the mobile work-count subset and run one integrated pass per applicable
    client.

This order follows dependencies rather than commit dates. It avoids building client
controls on contracts or lifecycle rules that may change during the upstream port.

## Complete fork-only commit inventory

This appendix lists every commit in `upstream-main..origin/main`, oldest first in
topological order. Short hashes are unambiguous within the audited repository.

### 2026-08-31

- `d94577e5c` `docs: document custom fork workflow`

### 2026-09-01

- `458a6f583` `feat(contracts): add external notification contracts`
- `96f8b4da7` `feat(server): deliver external notifications`
- `f2b735ff3` `feat(web): configure external notifications`
- `c3e17e31a` `docs(external-notifications): document setup and lifecycle`
- `b67eefdc4` `feat(notifications): refine destination settings and validation`
- `53d151085` `fix(notifications): enforce exhaustive adapter compilation`
- `2692fc518` `docs(external-notifications): refresh candidate evidence`
- `fb36613b9` `docs(plans): archive external notifications plan`
- `453f74a4d` `fix(opencode): settle pending requests on teardown`
- `3ba6cbaec` `fix(opencode): preserve plans tasks and lifecycle events`
- `54e3039a0` `fix(opencode): load and invoke native commands`
- `2aad3617a` `fix(opencode): preserve out of order text events`
- `26a6bbcf5` `fix(opencode): keep inventory commands typed`
- `7a7ae9fe5` `fix(opencode): mark child requests as waiting`
- `9d466463e` `fix(opencode): classify top-level subagents correctly`
- `7367a6173` `fix(opencode): preserve approval request types`
- `fc83ea156` `fix(opencode): attribute child tool lifecycle`
- `8b5ab1c4e` `fix(opencode): handle missing session error ids`
- `519ca2b40` `fix(opencode): release deleted parent sessions`
- `d73927db1` `fix(opencode): load project-scoped catalog capabilities`
- `eabe7b6c8` `fix(opencode): keep waiting commands cancellable`
- `ce5c35de3` `fix(opencode): retain turns waiting for input`

### 2026-09-02

- `84d15e468` `fix(opencode): complete idle child tasks`
- `c07edc45e` `fix(web): refine combined action menu behavior`
- `4be371eb3` `fix(web): handle split action menu edge cases`
- `89f4aae55` `Merge branch 't3code/combine-header-pill-buttons'`
- `c15e2dba5` `fix(server): settle aborted provider turns`
- `489a50e30` `fix(server): cancel requests with aborted turns`
- `8dfa99365` `fix(opencode): admit commands from lifecycle events`
- `72fb1e349` `feat(web): add secondary workspace pane state`
- `8cb6ba3d9` `fix(web): sanitize secondary pane persistence`
- `4d717dfff` `feat(web): split workspace editor from right sidebar`
- `979db8558` `added docs`
- `a86702865` `feat(opencode): complete parity follow-ups`
- `526dbef96` `merge: complete OpenCode parity follow-ups`
- `02844fda7` `feat(web): redesign workspace panes and sidebar`
- `8860fcbab` `Merge branch 't3code/redesign-right-sidebar'`
- `8f7b05edb` `docs: add MCP and source control plans`
- `6be007ecc` `feat(contracts): add Git index operations`
- `bed880412` `feat(contracts): add project MCP catalog schema`
- `fc647d7e6` `fix(contracts): expose project MCP application modes`
- `455df1a2c` `feat(server): manage Git index files`
- `58ac0f5f4` `feat(web): expose Git index actions`
- `24b234c0f` `feat(server): persist project MCP servers`
- `28e06a3a2` `fix(server): restrict project MCP mutations`
- `f15063c90` `feat(web): add Git workflow panel`
- `59a8a53ae` `docs: explain the source control panel`
- `4cfa77987` `feat(server): attach project MCP servers to sessions`
- `2f5de3481` `fix(server): expose managed preview MCP catalog entry`
- `a0fdfede2` `feat(web): manage project MCP servers`
- `6d3c7c1e3` `fix(web): guard project MCP settings`
- `886c496f5` `fix(server): normalize Git workflow paths`
- `aeb6384cd` `fix(web): validate project MCP settings`
- `02bc3cb30` `fix(client): cancel stale Git diff requests`
- `6c1bc1749` `docs: explain project MCP servers`
- `206a24dac` `fix(client): type Git diff cancellation tests`
- `d57945ec5` `docs: clarify project MCP server behavior`
- `c6eba3969` `docs: align project MCP application labels`
- `090a55dc5` `docs: correct project MCP labels`
- `db10e8eb3` `fix: harden Git workflow safety boundaries`
- `45b73ae18` `fix(web): refresh pull requests after actions`
- `6a11e6ca7` `fix(server): preserve unusual Git workflow paths`
- `9d5ae88bc` `fix(project-mcp): harden catalog errors and provider state`
- `28a27703c` `fix: gate Git workflow RPCs by capability`
- `0617f2680` `fix(project-mcp): clean up Effect and schema diagnostics`
- `ac6e1df7a` `test(opencode): use local fixture for stop cancellation`
- `97224afe1` `fix: expose staged Git file state`
- `eab9656ca` `fix(server): refresh divergence after index commits`
- `a31aa44fe` `test(web): remove static source control assertions`
- `a2e5fb646` `fix(client-runtime): refresh diffs after index mutations`
- `4f9fdeb4c` `fix(contracts): add git workflow preconditions`
- `0c5f922e8` `fix(contracts): preserve git input validation`
- `07c220653` `fix(server): guard git workflow mutations`
- `fce7d8636` `fix(server): guard create-and-switch`
- `64a3eb24b` `fix(vcs): refresh diffs across git revisions`
- `3522ddeb6` `fix(vcs): refresh diffs across repository revisions`
- `3812c29a7` `fix(client): refresh staged diffs for current Git state`

### 2026-09-03

- `d018cda6a` `fix(web): finish git workflow safety remediation`
- `00019d52b` `fix(server): compose project MCP with provider runtime`

### 2026-09-04

- `accdcf0ae` `feat(project-mcp): add transport descriptors`
- `b12bfe3d6` `feat(project-mcp): add transport connection fallback`
- `f2eb1b7da` `test(server): restore router harness type safety`
- `8fb82ec59` `fix(project-mcp): restore explicit transports after restart`
- `a651037f5` `feat(contracts): separate MCP credentials from catalog metadata`
- `4890ca9a4` `feat(project-mcp): store credentials outside catalog events`
- `6af9344ab` `feat(project-mcp): negotiate current and legacy MCP eras`
- `e8ab9ca0e` `fix(project-mcp): protect active sessions and concurrent mutations`
- `0d2309908` `fix(project-mcp): make secret handoff interruption safe`
- `3126905ae` `feat(project-mcp): add OAuth authorization core`
- `38dd35832` `feat(web): support project MCP transports and OAuth`
- `43eaa4a21` `feat(project-mcp): broker current and legacy MCP eras`
- `71a4b3990` `feat(project-mcp): complete standards-compatible proxy support`

### 2026-09-07

- `3ee1f4372` `fix(mcp): keep active sessions and stdio servers alive`
- `1c9a19a60` `fix(web): preserve MCP authentication edits`
- `d8f0ba0db` `fix(mcp): make oauth grants generation-safe`
- `cd49ff962` `fix(mcp): separate project servers from preview access`
- `0ed79d9bf` `fix(mcp): bridge legacy server input requests`
- `bf545344b` `fix(mcp): persist OAuth step-up authorization`
- `1c5cd21ba` `fix(mcp): unblock standards-compatible proxy sessions`
- `42f87f56f` `chore(mcp): checkpoint validated protocol and lifecycle work`
- `15080d6e0` `fix(mcp): checkpoint catalog settings remediation`
- `b9d3082f3` `fix(mcp): checkpoint OAuth secret and response fixes`
- `8ebe9cc70` `fix(mcp): checkpoint OAuth Basic credential encoding`
- `9bb1a8a36` `chore(mcp): checkpoint standards fixes`

### 2026-09-08

- `fb2a5132b` `chore(mcp): checkpoint validated findings fixes`
- `0ecabc68b` `feat(opencode): separate detach from termination`
- `cccd12152` `chore(mcp): checkpoint legacy bridge fixes`
- `5838492fa` `chore(mcp): checkpoint roots rollback fix`
- `5619c30a5` `fix(web): close git workflow remediation races`
- `cdb4b944d` `chore(mcp): checkpoint bounded roots history`
- `a6632e069` `fix(opencode): preserve lifecycle state during teardown`
- `f8cbb2490` `docs: checkpoint git workflow remediation plans`
- `752da1d62` `fix(mcp): bound roots history and cancel disposed calls`
- `976a81728` `fix(vcs): close git workflow panel race gaps`
- `9f4f3763c` `fix(mcp): preserve roots fallback and cancel active calls`
- `cab024480` `fix(mcp): restore roots fallback after owner release`
- `7330e6561` `fix(vcs): preserve guarded Git workflow semantics`
- `ecacf34ac` `fix(mcp): forward same-era extension notifications`
- `314428d73` `fix(vcs): handle merge and submodule edge cases`
- `ab1dc7060` `fix(vcs): reject guarded revert completion`
- `e3d1121a7` `fix(mcp): complete notification and session cleanup paths`
- `e256fef7e` `fix(mcp): preserve modern notifications and bound OAuth callbacks`
- `712d1c74e` `fix(opencode): harden session replacement recovery`
- `9c9062206` `fix(mcp): retain OAuth state for active sessions`
- `a06d2076d` `fix(opencode): preserve active work during recovery handoff`
- `f6b9f7fe3` `fix(mcp): harden OAuth and catalog recovery`
- `8050d045a` `fix(mcp): bound OAuth authorization URLs`
- `c6e5dd29a` `fix(opencode): keep managed recovery on existing process`
- `2b4eae005` `fix(opencode): roll back permissions after recovery failure`
- `79929d777` `checkpoint(mcp): add scoped catalog backend`
- `c41e0342f` `fix(opencode): protect replacement lifecycle state`
- `a5d7c4773` `fix(mcp): serialize provider session replacements`
- `4393b7fd6` `checkpoint(mcp): repair durable catalog mutations`
- `03fad1784` `fix(provider): fence stop races with recovery`
- `fe92d88b5` `checkpoint(mcp): harden catalog lifecycle`
- `5c4fc10af` `checkpoint(mcp): harden catalog mutation lifecycle`
- `3d97e08b6` `fix(opencode): restore rejected replacement state`
- `feeb791cd` `checkpoint(mcp): harden scoped catalog recovery`
- `ed9a1d86d` `feat(desktop): attach an existing primary backend`
- `357679ae5` `fix(desktop): harden attached primary recovery`
- `5544d3bb4` `fix(desktop): recover failed primary attachments`
- `b28e1ce45` `fix(provider): terminate hidden sessions during cleanup`
- `ea94be620` `fix(desktop): harden attached backend handoff`
- `ecbad6969` `checkpoint(mcp): repair scoped OAuth ownership`
- `f4567d39c` `Merge branch 't3code/opencode-detach-termination'`

### 2026-09-09

- `f96125e5f` `checkpoint(mcp): persist applied catalog state`
- `bf84b6cbf` `fix(desktop): serialize attached backend handoff`
- `55dab30ba` `checkpoint(mcp): preserve catalog identity semantics`
- `c74337860` `feat(chat): report per-turn model, effort, and work in the timeline`
- `4744b0805` `fix(chat): correct per-turn provenance stamping and live turn records`
- `dc4c990a7` `fix(desktop): close attached startup races`
- `2608cca60` `fix(chat): count per-turn work the way the timeline shows it`
- `c1989595b` `fix(desktop): harden attachment transaction retries`
- `dfee978a2` `Merge branch 't3code/opt-into-serve-backend'`
- `b28c22799` `fix(chat): stamp turn work counts on the diff-settled path`
- `5a1b112de` `checkpoint(opencode): manage MCP on external servers`
- `5da1ad0c0` `fix(chat): fold id-less work rows by run, not by content`
- `08468cb3f` `checkpoint(opencode): drain external MCP generations`
- `fda20b06a` `checkpoint(opencode): harden MCP cleanup races`
- `48fe74544` `merge: integrate global session catalogs`
- `157650ced` `fix(chat): stop placeholder diffs orphaning a turn's assistant message`
- `a37b61d7d` `fix(provider): make session replacement transactional`
- `be9347f5d` `fix(chat): drop the per-run breakdown from turn folds`
- `52b158f47` `fix(chat): name the turns the activity window cut`
- `724b33c2a` `fix(chat): read the cut turn from the window, not the discarded row`
- `e873b9384` `fix(chat): count the rows a turn kept instead of inferring from position`
- `26c2e4c1e` `test(chat): cover the older-host fallback for cut turns`
- `bdddc58e0` `fix(chat): stop turn folds reporting counts they cannot back up`
- `7bd93e19a` `feat(mobile): show per-turn work counts in the chat timeline`
- `aa6309535` `Merge branch 't3code/improve-chat-activity-visibility'`
- `c6799727d` `Merge branch 'main' into t3code/integrate-project-mcp-catalog`
- `b332f9022` `fix(provider): make MCP replacement transactional`
- `ec3dd505b` `fix(provider): harden replacement lifecycle`
- `7dd4544dc` `chore(mobile): ignore Gradle caches under native modules`
- `f71812025` `docs: add attached primary backend plan and project knowledge MCP research`
- `542fe7f0a` `test(provider): wire provider credential revoke in external MCP fixture`
- `43becd7d8` `fix(mcp): drop project overrides when their global definition is removed`
- `1d165b573` `fix(opencode): clean up external MCP entries on stopAll`
- `1c32b5f4d` `refactor(db): give fork migrations their own sequence and table`
- `c00aedeb2` `fix(server): check fork migration slots in migrate-dev-db`
- `dccea637f` `fix(server): honor T3CODE_HOME in migrate-dev-db`
