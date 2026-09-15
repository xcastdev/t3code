# `upstream-main` change audit

This report records the upstream-only work on the local `upstream-main` branch
relative to its merge base with `origin/main`. The refs were inspected on
2026-09-14. Feature claims come from the implementation, contracts, migrations,
focused tests, and shipped documentation at the upstream tip—not from commit
subjects alone.

## Bottom line

The requested upstream range is a two-week product expansion containing 1,074
linear commits. Its main shipped programs are:

1. A typed, inline message-context system covering citations, attachments,
   terminal excerpts, review comments, preview annotations, clipboard transfer,
   and provider projection.
2. First-class iOS Simulator and Android Emulator viewing and agent control,
   including SSH-hosted devices.
3. Cross-platform desktop SnapShots with app metadata and optional accessibility
   context on macOS, Windows, and several Wayland desktops.
4. Multi-pull-request threads, GitHub stack operations, account routing, and
   Forgejo/Gitea support.
5. Provider usage measurement, custom prices, pooled subscription limits, reset
   credits, and mobile home-screen widgets.
6. Google Antigravity support plus substantial Codex, Claude, Cursor, Grok, and
   OpenCode parity and recovery work.
7. A multi-computer welcome wizard, imported provider history, background project
   cloning, environment load balancing, and project-scoped settings inheritance.
8. Manual thread ordering, richer settlement/snooze behavior, rewind while
   preserving workspace files, prompt history, notifications, and extensive
   composer/panel refinement.
9. Self-contained CLI archives, stable/nightly/preview release trains, SSH and WSL
   runtimes managed as release archives, and CLI update/uninstall/service commands.
10. A broad performance and reliability campaign across streaming, message sync,
    server queries, terminal history, media, mobile lists, and animation.

The range is much larger than the fork range audited separately. Excluding
vendored reference repositories, it changes 2,948 paths with 385,696 insertions
and 72,986 deletions. The `.repos` refresh adds another 12,647 paths to the raw
diff and must not be mistaken for product implementation.

One visible experiment did not survive the range: the compact sidebar/thread-list
mode was introduced and then removed by `d81278aa6`. The final contracts explicitly
drop its retired settings keys, so it is not listed as a shipped feature.

## Audit findings

The review used two independent axes. No external product specification was
provided, so the intent axis was reconstructed from upstream PR descriptions,
commit subjects, shipped user documentation, and tests.

### Intent/spec axis

#### High: a restart can strand a background clone and bypass the send gate

Background clone intent says that thread creation waits for the repository and
that failed clones remain cancellable or retryable. The implementation creates a
durable project pointing at the empty destination before cloning begins, but its
clone snapshots and fibers exist only in memory. After a mid-clone server restart,
the project survives while the tracker forgets that it is incomplete. The command
guard treats a missing tracker entry as ready, so an agent can start in an empty or
partial checkout and the client loses the Cancel/Retry/Remove recovery state.

Evidence:

- [`ProjectCloneTracker.ts` lines 38–43](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/server/src/project/ProjectCloneTracker.ts#L38-L43)
  declares snapshots memory-only and the empty project durable.
- [`ProjectCloneTracker.ts` lines 122–124](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/server/src/project/ProjectCloneTracker.ts#L122-L124)
  scopes clone fibers to the server process.
- [`ProjectCloneTracker.ts` lines 315–325](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/server/src/project/ProjectCloneTracker.ts#L315-L325)
  creates the project before launching the clone.
- [`ProjectCloneTracker.ts` lines 444–463](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/server/src/project/ProjectCloneTracker.ts#L444-L463)
  allows dispatch when `tracker.get()` returns `null`.
- [`source-control.md` lines 78–82](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/docs/user/source-control.md#L78-L82)
  promises that sending waits and failed clones remain retryable.

The durable project record needs an incomplete-clone state that startup can
recover, fail, or remove. The dispatch guard must consult that durable state rather
than treating absence from the in-memory tracker as success.

### Repository-standards axis

#### High: the welcome wizard is also a workflow controller

`WelcomeWizard.tsx` is 1,563 lines and directly coordinates PTY creation, ordered
setup/teardown, retries, project creation across environments, transcript import,
interruption generations, and error recovery. That puts effect-heavy workflow
ownership in the rendering component, contrary to the repository rule that UI
remain dumb and complexity stay at adapter/runtime boundaries. The terminal and
import workflows should move behind focused controllers or client-runtime modules;
the component should present state and issue user intent.

Evidence: [`WelcomeWizard.tsx` lines 805–896](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/web/src/components/onboarding/WelcomeWizard.tsx#L805-L896)
owns the terminal lifecycle, while
[`lines 1036–1158`](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/apps/web/src/components/onboarding/WelcomeWizard.tsx#L1036-L1158)
own the multi-environment import transaction.

#### Medium: the context-reference internal guide became an implementation ledger

`docs/internals/composer-context-references.md` records fields, concrete classes
and functions, editor behavior, send/read flow, clipboard mechanics, persistence,
and later-PR accretion. That conflicts with the documentation policy added in this
same range: internal docs should preserve cross-boundary decisions, constraints,
and traps, not enumerate implementation. The durable wire-format and compatibility
decisions are valuable; mechanics already evident from types and tests should be
removed.

Evidence: [`composer-context-references.md` lines 5–25](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/docs/internals/composer-context-references.md#L5-L25)
announces and begins the implementation inventory; the new policy is in
[`AGENTS.md` lines 123–135](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/AGENTS.md#L123-L135).

#### Low: the device contract comment contradicts the implemented SSH host model

The contract says only the local host exists and other host kinds are future work,
then immediately defines SSH hosts that the shipped server and clients use. Update
or remove the stale comment so it does not mislead future contract changes.

Evidence: [`packages/contracts/src/device.ts` lines 9–29](https://github.com/pingdotgg/t3code/blob/a62e7d670c67bf221a5699b5a988367781fead74/packages/contracts/src/device.ts#L9-L29).

## Scope and comparison method

The audited range is:

```text
merge base..upstream-main
bba79cc254b65969bde6b6bfc3032c3b5b9316ae..a62e7d670c67bf221a5699b5a988367781fead74
```

Because the merge base is an ancestor of `upstream-main`, the two-dot diff and a
three-dot diff against `origin/main` isolate the same upstream-side tree changes.
The audit covered:

- every one of the 1,074 upstream-only commits;
- all changed paths, with `.repos` counted separately;
- the upstream-tip contracts, server, clients, native helpers, migrations, tests,
  operations, and user documentation in a detached read-only worktree;
- stable and nightly tags inside the range; and
- feature attempts later reverted before the tip.

This is a static code and history audit. No browser, simulator, provider process,
or test suite was launched, and no upstream code was modified.

## Branch topology and ref freshness

| Ref                              | Revision                                   | State at audit time                                                                              |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| merge base                       | `bba79cc254b65969bde6b6bfc3032c3b5b9316ae` | Last commit shared with `origin/main`: `fix(web): hide invalid slash skill completions (#8904)`  |
| `origin/main`                    | `dccea637fb2ff4190417891a7a9e86fee118b504` | Fork tip, 182 fork-only commits from the base                                                    |
| local `upstream-main`            | `a62e7d670c67bf221a5699b5a988367781fead74` | Requested audit tip: `refactor(server): align title generation with Effect conventions (#11847)` |
| fetched `upstream/main`          | `5623089aea68ca62811f51321686c259fa4c810f` | One commit ahead of the requested local branch                                                   |
| published `origin/upstream-main` | `bba79cc254b65969bde6b6bfc3032c3b5b9316ae` | Still at the merge base                                                                          |

```text
                                      1 commit
                                     ----------> upstream/main
                                    /
merge base ------------------------+-----------> upstream-main
    \                                1,074 commits
     \-- 182 fork commits --------------------> origin/main

origin/upstream-main remains at the merge base.
```

The report intentionally stops at local `upstream-main`, as requested. The one
newer fetched upstream commit is outside the feature counts and inventory.

All 1,074 upstream commits are non-merge commits. The history is consistent with
GitHub squash merging: 1,048 subjects contain a pull-request number. It spans 85
author email identities and author dates from 2026-08-31 through 2026-09-15; the
two September 15 author dates reflect author time zones relative to the audit's
America/Chicago date.

## Size and composition

### Product tree, excluding `.repos`

| Area                    |     Files |  Insertions |  Deletions | Main concentration                                    |
| ----------------------- | --------: | ----------: | ---------: | ----------------------------------------------------- |
| `apps/`                 |     2,353 |     315,704 |     58,152 | Web, server, mobile, desktop, marketing               |
| `packages/`             |       351 |      39,792 |      4,512 | Contracts, client runtime, shared codecs, ACP and SSH |
| `docs/`                 |        61 |       3,904 |      4,860 | User guides, internal decisions, operations           |
| `infra/`                |        54 |       5,120 |        493 | Relay notifications, activity, auth, persistence      |
| `scripts/`              |        40 |       5,976 |      1,100 | Release packaging, licenses, icons, development       |
| `native/`               |        27 |       5,712 |         23 | Linux SnapShot helpers and resource monitor           |
| `patches/`              |        17 |       2,467 |        807 | Effect, Clerk, Expo, React Native, diff/list fixes    |
| `.github/`              |        15 |       2,277 |        843 | Release, Windows, preview, and review automation      |
| `oxlint-plugin-t3code/` |        10 |         203 |        123 | Static rules and tests                                |
| root/configuration      |        20 |       4,541 |      2,073 | Lockfile, workspace, devcontainer, notices, policy    |
| **Total**               | **2,948** | **385,696** | **72,986** | Product and repository changes                        |

Path statuses are 1,094 additions, 1,729 modifications, and 125 deletions. Paths
related to tests account for 907 of those changes: 355 added, 525 modified, and 27
deleted, with 171,191 insertions and 17,576 deletions. This is unusually high
evidence density, though it is not equivalent to running the tests at this tip.

### Vendored reference repositories

`.repos` contributes 12,647 more changed paths, 743,361 insertions, and 131,373
deletions: 8,551 paths under `alchemy-effect` and 4,096 under `effect-smol`. These
are read-only reference snapshots for maintainers. They dominate the raw diff but
do not represent T3 Code features.

Including them, the raw range is 15,595 files, 1,129,057 insertions, and 204,359
deletions.

## Commit and release profile

| Subject class |   Commits |
| ------------- | --------: |
| `fix`         |       591 |
| `feat`        |       172 |
| `refactor`    |       103 |
| `perf`        |        70 |
| `test`        |        57 |
| `chore`       |        34 |
| unstructured  |        24 |
| `ci`          |        13 |
| `docs`        |         5 |
| `style`       |         2 |
| `build`       |         2 |
| `revert`      |         1 |
| **Total**     | **1,074** |

The apparent single `revert` count reflects strict Conventional Commit parsing.
Five other subjects contain “Revert” or “revert,” including explicit reversions of
the first cross-provider context-compaction attempt, a live-activity row reuse,
Android markdown icon alignment, and continuous marketing motion.

The largest scopes by subject are `web` (397), `server` (160), `mobile` (130), and
`desktop` (56). The top authors by commit count are Julius Marminge (447), maria
(182), Theo Browne (163), Bilal Bakr (21), and Wout Stiens (18).

| Release point                   | Revision    | Commits since prior point | Meaning                                                   |
| ------------------------------- | ----------- | ------------------------: | --------------------------------------------------------- |
| `v0.0.38`                       | `c0995d2ea` |                        53 | Stable release after the merge base                       |
| `v0.0.39`                       | `6abdf37a5` |                       684 | Large stable train through pooled usage/reset-credit work |
| `v0.0.40`                       | `09e8de9c6` |                        43 | Stable train through stop-thread keybinding work          |
| `v0.0.41-nightly.20260910.1507` | `3836890e4` |                        93 | Latest local `0.0.41` nightly tag                         |
| `upstream-main`                 | `a62e7d670` |                       201 | Untagged commits after that nightly                       |

No stable `v0.0.41` tag is reachable at the requested tip.

## Feature and surface matrix

| Program                        | Server/contracts                             | Web                                 | Desktop                                          | Mobile                               | Provider impact                                  |
| ------------------------------ | -------------------------------------------- | ----------------------------------- | ------------------------------------------------ | ------------------------------------ | ------------------------------------------------ |
| Inline context and attachments | Full                                         | Author, render, copy/paste, preview | Web surface plus native file/browser integration | Render, attach, preview, share       | Provider-neutral projection; adapter limits vary |
| Devices                        | Full local/SSH host, proxy, MCP tools        | Full interactive panel              | Full through web shell                           | Activity visibility, not full viewer | Device tools injected for eligible sessions      |
| SnapShots                      | Attachment metadata                          | Composer and details UI             | Native capture and setup                         | Displays attachments                 | Provider-neutral attachment/context path         |
| Pull requests and stacks       | Full sync/routing/providers                  | Full author/review/stack UI         | Full through web shell                           | Linked PR overview                   | Agent PR linking tool; provider selector in UI   |
| Usage and limits               | Full ingestion and aggregation               | Full                                | Full through web shell                           | Full page and native widgets         | Codex, Claude, Grok; hub aggregation             |
| Antigravity                    | Full adapter, auth, runtime, text generation | Provider setup and threads          | Same as web                                      | Consume existing setup               | New provider                                     |
| Onboarding/settings            | Multi-environment RPC and persistence        | Full                                | Full through web shell                           | Existing environment flow            | Installs/configures Codex and Claude             |
| Thread organization            | Event model and persistence                  | Full                                | Full through web shell                           | Manual order, drafts, lifecycle      | Async questions and compaction vary              |
| Self-contained distribution    | CLI/runtime/release services                 | Update status and actions           | Bundled host and remote updates                  | Store/OTA path                       | Provider installers remain environment-local     |

## 1. Inline message context, citations, and attachments

### Durable context model

Messages now carry typed context records separately from their textual occurrence.
The text contains canonical `t3-context://v1/<kind>/<contextId>` links, while the
record holds the payload or binds to an existing attachment. One record can be
referenced more than once, and unknown future kinds are preserved or degraded to
an unresolved chip instead of breaking the whole message.

The supported context family covers images, files, terminal excerpts, selected
page elements, preview annotations, review comments, file mentions, skills, and
assistant citations. The server persists message context, normalizes attachment
IDs, and projects a provider-facing marker plus a bounded XML envelope only when
dispatching. This keeps stored messages portable while making untrusted captured
text unable to forge context records. Legacy trailing context blocks and terminal
placeholders are upgraded in memory without rewriting event history.

### Composer and clipboard behavior

Web and desktop render every occurrence as an inline Lexical chip at its actual
caret position. Panel-originated context inserts at the current or last-known
caret; deleting the last file chip releases that file, while image thumbnails
remain an explicit inventory. Stashes preserve records, and removing or restoring
context shares the same importer used by paste.

Copy operations emit readable Markdown as plain text and a structured T3 fragment
when supported. Pasting across threads or projects reuses records; across
environments it re-fetches image/file bytes through the source environment and
remints attachment IDs. Missing sources remain visible as unresolved chips rather
than silently disappearing. Mobile renders and inspects the same references even
where authoring controls remain web/desktop-only.

### Citations, files, and media

Users can select text in an assistant response, add an optional comment, and cite
it in the composer. Source navigation fetches and unfolds virtualized rows, while
the copied quote remains usable if the source later changes or disappears.

File and media handling expanded across clients:

- code and JSON get highlighted previews;
- Markdown, HTML, CSV, and TSV offer rendered/raw views;
- PDFs, images, audio, and video use suitable native or browser viewers;
- files outside the workspace open read-only;
- image dimensions arrive with signed asset URLs to prevent layout shifts;
- image galleries support navigation, pan, and zoom; and
- mobile can save/share media and queue attachment messages while offline.

Pastes of 32 KiB or more become text attachments by default, preventing a large
clipboard payload from consuming the model context. Question-answer prompts can
also carry up to eight attachments with independent drafts and cleanup semantics.

Key commits: `e7deb2aaf` (assistant citations), `922bd6922` (shared media model),
`7220dfe2c` (question attachments), `4fed6cfb3` (inline attachment chips and
previews), and `68c2277f5` (large-paste attachments).

## 2. Simulator and emulator devices

The server now owns iOS Simulator and Android Emulator discovery, streaming, and
agent access. `expo-device-hub` runs as a supervised child on the device host;
`agent-device` supplies semantic automation to provider sessions. A four-tool MCP
surface lists, opens, screenshots, and closes devices, then returns version-matched
CLI instructions only after a device is opened.

The web/desktop Device panel can boot and watch several devices, keep only the
visible tab streaming, float a stream over chat, send pointer/keyboard input, and
control platform-specific settings. The tools drawer exposes foreground app,
appearance, text size, accessibility overlays and toggles, location, permissions,
orientation, network, VoiceOver, and test-push capabilities where supported.

Remote readiness is built into the seam:

- the environment server proxies the device hub over authenticated HTTP and
  WebSocket routes rather than exposing its unsafe execution endpoints;
- short-lived tickets cover browser transports that cannot attach headers;
- iOS uses WebCodecs with MJPEG fallback, while Android uses its multiplexed H.264
  protocol;
- device identity includes a host ID so duplicate simulator IDs do not collide;
- SSH hosts forward both hub and agent-driver endpoints; and
- concurrent provider sessions remain scoped to the correct host and target.

Setup and agent control are separate consent steps. Turning off agent access hides
tools from subsequently started sessions without disabling the user's viewer.
Mobile surfaces device activity in the timeline but does not implement the full
interactive device panel.

Key commits: `dca7b59be` (device platform), `e022fa430` (host-scoped targets),
`7734c6d71` (concurrent sessions), `d2eeacd8c` (SSH hosts), and `8bbe2bf66`
(floating viewer).

## 3. Cross-platform SnapShots

Desktop SnapShots grew from platform-specific capture into a shared feature for
macOS, Windows, and Wayland Linux. A capture attaches the active-window image,
application name, title, icon where resolvable, and optional accessibility tree so
the agent can reason about both pixels and UI structure.

The setup flow covers permissions, shortcut registration, and capture feedback.
Pending captures are staged on disk until the draft saves them, and slow
accessibility extraction falls back to the screenshot instead of blocking capture.
Users can independently disable accessibility text, sound, flash, and the
fly-to-composer animation.

Linux support is deliberately desktop-specific:

- GNOME ships a per-user extension;
- KDE Plasma 6 and Hyprland use bundled native helpers;
- Niri and Hyprland show and validate the exact compositor binding before writing
  it, with backups;
- other Wayland desktops use the screenshot portal where possible; and
- X11 sessions remain unsupported.

The 32,013-line-change commit `299404a75` is the largest non-`.repos` commit in the
range because it adds the native helpers, desktop orchestration, web UI, assets,
tests, and documentation together.

## 4. Pull requests and source control

### Multi-PR threads and stack operations

A thread can now retain multiple linked pull requests, including cross-repository
links on the same host. The server refreshes open links even without a connected
client, persists explicit unlink decisions, and settles a thread only when every
linked PR is terminal. The web/desktop surface links and unlinks reviews from the
command palette, thread, PR page, or linked-PR panel; mobile shows linked reviews
and stack membership.

GitHub stack support discovers layer position, navigates the stack, merges a
selected PR plus lower unmerged layers through GitHub's stack/queue behavior, and
rebases remote branches bottom-up without changing the local checkout. PR work
also gained list filters, label mutation, link previews, author profile links,
merge defaults, a floating comment composer, provider selection, file-tree
navigation, and search by linked PR.

### Routing and hosting providers

GitHub read/action requests can route through another connected environment that
has a matching verified account and explicit per-environment permission. Reads may
fall back; actions with uncertain outcomes do not retry elsewhere. Credentials
stay on their owning machines, and route permissions are cleared when a saved
endpoint changes.

Forgejo and Gitea join GitHub, GitLab, Bitbucket, and Azure DevOps through a new
source-control provider using `fj` where possible and `tea` as fallback. It handles
multiple hosts, URL subpaths, clone/publish operations, pull-request reads, and
account selection without collapsing provider-specific behavior into orchestration.

Repository cloning became asynchronous: the palette closes, a draft can be
prepared immediately, and progress/cancel/retry state appears globally. The audit
finding above identifies the restart hole in that otherwise coherent design.

Key commits: `afb84898b` (multi-PR threads), `de37964db` (GitHub stacks),
`db6e0531e` (cross-environment GitHub routing), `6fd68f5c3` (Forgejo/Gitea), and
`8d7c700c1`/`549d182aa` (background clone UX).

## 5. Provider usage, limits, and model catalogs

The server now reads Codex, Claude, and Grok histories across configured provider
instances, respecting account-specific homes and deduplicating shared history
directories. It measures turn token usage, cache reads/writes, model breakdowns,
and estimated API-equivalent cost. Web/desktop can filter environments and apply
custom per-model input, output, cache-read, and cache-write rates across selected
servers with per-destination retry reporting.

The Limits surface pools subscription windows across accounts, environments, and
optional CLIProxyAPI hubs. It preserves account identity across duplicate reports,
shows remaining rather than consumed quota, reset timing and contribution, and
Codex reset-credit inventory. `/usage-limits` opens the current snapshot in the
composer without running the agent. Native iOS and Android widgets expose selected
Codex and Claude windows outside the app.

Model handling also changed materially:

- a remotely refreshed, schema-validated manifest can update model metadata while
  an offline bundled manifest remains the fallback;
- Claude model discovery and Fable 5.1 support were added;
- custom model names and provider-supported option descriptors are editable;
- web settings can bulk-toggle provider models; and
- defaults retain provider, model, reasoning, and service-tier behavior without
  forcing an automatic per-project model.

Key commits: `1587f248d` (turn usage), `19d8ab2ae` (Limits), `394e8470c` and
`84b99f3fb` (custom prices), `b273d1cfe` (pooled accounts), `1641b4aba` (reset
credits), `17f8e2a8a` (widgets), and `035428368` (remote Claude manifest).

## 6. Provider capabilities and Antigravity

Google Antigravity was added as a sixth provider through the official ACP agent.
The implementation includes managed runtime installation, Google and enterprise
authentication flows, remote callback completion, multiple instances/accounts,
model catalogs, text generation, attachments, skill discovery, subagent batch
presentation, permission mapping, usage/error translation, logout, and cleanup.
Managed binaries cover macOS ARM64, Linux x64/ARM64, and Windows x64/ARM64; manual
ACP binaries remain supported.

Provider-wide work includes:

- context compaction through native or adapter-declared slash-command mechanisms;
- Codex async questions, file-change approval details, reset-credit handling, and
  recovery tolerance for rate-limit/policy responses;
- Claude model/skill inventory, usage-limit pauses, launch-argument precedence,
  attachments with slash commands, and shared result/error mapping;
- Cursor model and transport recovery fixes;
- Grok background task and shell lifecycle reporting; and
- OpenCode compaction, approval semantics, transcript trimming, session lookup
  bounds, and tool-history memory reductions.

Compaction's first cross-provider implementation (`535557b3f`) was reverted by
`63f334baf`; the capability later returned behind adapter-declared support in
`c5ba51d62` and `5fa35d211`. The final tree therefore contains compaction without
retaining the rejected first design.

## 7. Onboarding, projects, environments, and settings

### Welcome and import

First-run web/desktop setup can select several connected computers, verify Codex
and Claude installation/authentication on each, open a prefilled setup terminal,
discover recent provider workspaces, and import project/thread history. Repository
clones are grouped by remote; recent active histories are selected by default;
bounded scanners skip oversized or malformed data and allow later continuation.
Imported conversations preserve a bounded set of user and assistant messages but
omit tool activity and attachments.

### Environment identity and placement

Environments are shown as the machines that run them and are selectable throughout
project pickers, settings, and command search. The connections page became one
environment list: a saved endpoint can be switched off without deletion, and the
desktop's own local environment can be disabled so the app operates only as a
remote client.

Optional web/desktop load balancing selects an eligible environment for a new
thread using current CPU/memory headroom and per-machine `Prefer`, `Normal`, `Less
often`, or `Manual only` weights. The choice freezes once the draft selects a
branch, worktree, or explicit machine; existing threads never migrate. Mobile
keeps manual selection.

### Scoped settings and project lifecycle

Settings now have explicit environment and project selectors. Scopable values can
inherit built-in, environment, and project layers, show mixed multi-environment
states, fan out bulk writes, retry failures, and reset overrides. Project settings
cover model/workspace defaults, actions, automatic pulls, icons, checkouts, and
removal. Clean default branches can fast-forward automatically, while any local
change, untracked file, divergent commit, or missing upstream blocks the pull.

Worktree setup became observable and cancellable step by step. Project clones run
in the background on web and mobile, and both clients gate draft submission while
the clone is known incomplete. Reusable dev authentication lets worktrees share a
fixed local credential; headless T3 Connect login moved to Clerk's device
authorization grant, avoiding callback-port forwarding.

## 8. Threads, composer, panels, and notifications

Thread settlement moved server-side and gained restart repair, PR-aware terminal
timestamps, multi-PR rules, unanswered-question handling, and client-independent
linking. Users can manually reorder active threads, drag across pinned/active/
settled sections, perform bulk moves, preserve ordering across clients, wake or
un-settle work, and choose custom snooze date-times or minute/hour/day durations.
Mobile mirrors active ordering and supports several new-task drafts per project,
pending-task rows, existing-branch starts, outbox indicators, and immediate
navigation while creation finishes.

Conversation controls gained:

- Edit from here with separate “keep workspace changes” and “restore files” paths;
- provider-history restoration for supported rewinds;
- prompt recall with Up/Down and retained multiline caret behavior;
- async-question dismissal and attachments in custom answers;
- subagent-spawn rows and improved work summaries;
- PageUp/PageDown and previous/next-turn minimap navigation;
- configurable default diff file state and a diff/PR file tree; and
- composer and PR-number shortcuts.

Panels remember per-thread choices, can open proactively, use a compact surface
menu, optionally animate up to 400 ms, and return floating previews to
picture-in-picture when closed. The composer was heavily refined around focus, collapse,
selection, scrolling, menu placement, responsive controls, IME input, and drafts.
The volume of follow-up fixes shows this was an active stabilization area, not a
single isolated feature.

Web/desktop gained opt-in in-app notifications, sounds for completion or input,
and badges for background threads. Android gained ordinary notifications and an
ongoing agent-activity card; iOS/Android already share activity publishing, while
mobile subscription widgets were added separately. Screen-reader work exposes
chat messages as headings and labels drag targets, disclosures, menus, and project
actions more consistently.

## 9. Desktop, browser, terminal, and external files

Desktop preview browsing now supports named browser profiles and one-time cookie
imports. Chrome, Edge, Brave, Vivaldi, Opera, Arc, Firefox, and Safari are covered
where platform encryption permits; Safari guides Full Disk Access and Linux can
resolve Chromium keyring secrets. Imported credentials stay copied into the T3
profile rather than remaining linked to the source browser.

Links can open in the operating-system browser or T3 Code's preview browser. The
desktop can resolve local media referenced by remote threads, capture windows on
all supported desktop platforms, update a remote Mac desktop host, and respond to
`npx t3 app [path]` by opening a project in the already-running app. WSL runtimes
are now staged from Linux CLI archives.

Terminal behavior gained truecolor advertisement, Linux middle-click paste, phone
clipboard paste, bounded server history (5,000 lines and 8 MiB), cheaper output
transport, and extensive focus/snapshot/replay fixes. External Markdown, HTML, and
PDF paths open read-only; HTML is sandboxed from neighboring resources and session
credentials.

## 10. Self-contained CLI, services, and releases

The distribution model moved away from running the server from npm contents.
Release automation builds a JavaScript bundle once, creates signed self-contained
CLI archives for macOS ARM64, Linux x64/ARM64, and Windows x64/ARM64, and publishes
small per-platform npm packages behind `npx t3`. The same archives supply preview
runtimes, SSH remotes, and WSL backends, reducing runtime drift between surfaces.

The standalone CLI now supports:

- installer scripts for Unix and Windows;
- stable, nightly, preview, and exact-version selection;
- `t3 update`, with channel changes, downgrade protection, validation, and eager
  background-service repointing;
- `t3 uninstall`, preserving userdata unless the user removes it separately;
- `t3 service restart` plus archive-backed install/update/status/uninstall; and
- a Node single-executable-compatible server bundle.

Release CI separates bundle construction from five platform/architecture jobs,
signs artifacts, promotes stable releases from the latest nightly commit, and can
publish signed macOS preview builds for fork PRs without exposing signing secrets.
Desktop packaging now bundles the Electron main process and stages only native
externals. Open-source license notices are generated and exposed in settings.

## 11. Performance program

Seventy commits are explicitly labeled `perf`, with many related fixes. The work
targets the repository's known hot paths rather than one benchmark:

| Area             | Changes                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web streaming    | Reuse completed Markdown/code prefixes and DOM rows, resume syntax highlighting, avoid full remounts, keep huge-thread switching visible     |
| Client sync      | Incremental projections, stable turn/checkpoint references, lower message-sync and remote-request overhead, visibility-leased sidebar status |
| Server reads     | Avoid full thread/message/workspace scans, batch projector cursors, select only buffered events, bound provider session lookup               |
| Provider traffic | Cut tool-update frames by about 90%, scan only appended transcript bytes, drop repeated OpenCode progress/tool history                       |
| Terminal         | Bound history by bytes, avoid per-chunk rebuilds and repeated metadata scans, skip hidden terminal rendering and rollover replay             |
| Media/diffs      | Defer image URLs, highlighters, diff workers, and PR line stats until visible; pre-size images from server metadata                          |
| Mobile           | Reuse chat/diff/code rows, bound review caches and syntax work, skip legacy list work                                                        |
| Startup/assets   | Split Clerk and cold routes, cache/stream static web assets, serve local fonts and correctly sized marketing images                          |
| Motion           | Remove continuous status and homepage animations; keep optional panel motion user-controlled and reduced-motion aware                        |

This campaign matters to fork integration because it frequently changes data flow,
subscription lifetime, and caching—not only micro-optimizations. Porting an older
forked UI or server service without these companions can reintroduce CPU, memory,
or network regressions even when the feature still compiles.

## 12. Reliability, migrations, and engineering infrastructure

The 591 `fix` commits concentrate on real lifecycle boundaries: provider resume and
abort, server restart recovery, thread settlement, stale PR data, connection-token
refresh, multi-environment state, drafts and uploads, preview focus, mobile startup
and Hermes compatibility, accessible interaction, and race-free async UI. The 103
refactors are dominated by removing unused runtime exports, enforcing public API
boundaries, and testing behavior through live modules instead of static snapshots.

New migration numbers 044–052 cover:

- clearing automatic project model defaults;
- project automatic-pull state;
- automatic-settlement timestamp repair;
- explicit project icons;
- branch pull-request compatibility;
- active-thread manual order;
- multi-pull-request projections;
- persisted message context; and
- thread title-generation state.

Knip now rejects unused files/dependencies and progressively enforces runtime
exports in shared packages, web, desktop, and server. The range adds an on-demand
Windows test workflow, release smoke tests, native static checks, license syncing,
Android icon export, tighter package boundaries, and focused fixtures for provider,
relay, device, clone, and release behavior.

Major dependency/toolchain changes include Effect `4.0.0-rc.112`, Effect tsgo
`0.41.0`, TypeScript `7.0.2`, Vite+ `0.3.0`, Tailwind `4.3.3`, Electron `44.1.0`,
new Clerk releases, and patches for Effect, Clerk Expo, Expo widgets/sharing,
React Native Reanimated, gesture/screens, diff rendering, Legend List, DBus, and
native support libraries.

Documentation was reorganized by audience. New or substantially expanded user
guides cover appearance, browser imports, devices, notifications, licenses,
question attachments, SnapShots, terminal limits, telemetry, usage, onboarding,
source control, and provider setup. Operations gained development, Connect, Android
notification, observability, and release procedures. Several old catalogs and
work-artifact documents were deleted in favor of the stricter decision-oriented
documentation policy—although the context-reference guide currently violates that
new policy, as noted above.

## Chronological change narrative

This timeline groups the most consequential work by author date. Commit order
within a date is preserved in the complete inventory below.

### 2026-08-31 to 2026-09-01

Mobile gained attachment upload, native image/PDF preview, and native iOS video.
GitHub references became linkable from Markdown. Assistant citations, host-file
and video preview, HTML/PDF rendering, files outside the workspace, viewed-image
work logs, Claude remote model discovery, desktop remote-Mac updates, and the
desktop activation CLI landed. Server streaming became incremental and bounded,
with large reductions in tool-update traffic, message reads, idle CPU, and snapshot
memory.

### 2026-09-02

The file/diff tree, proactive and animated panels, browser profiles, automatic
default-branch pulls, environment-as-machine presentation, restart continuation,
custom provider/model UI, document previews, and shared media architecture landed.
The first cross-provider compaction implementation was reverted for redesign.

### 2026-09-03

Antigravity, Codex async questions, subscription Limits, reset credits, browser
cookie import, settings reorganization, project icons, and composer-collapse
controls arrived. Follow-up work integrated provider attachments, subagents,
authentication, model state, and error recovery.

### 2026-09-04 to 2026-09-05

This was the main performance and cleanup wave: incremental rendering and replay,
bounded caches/history, lazy media and workers, static asset caching, dead export
removal, Knip enforcement, and behavioral-test replacement of brittle snapshots.
Custom usage prices, provider token measurement, prompt recall, mobile terminal
paste/selectable text, image dimensions, the multi-step welcome wizard, license
and docs restructuring, and the Windows 95 marketing page also landed.

### 2026-09-06 to 2026-09-07

Manual thread ordering, cross-section drag/drop, mobile pending drafts/outbox,
pooled usage, remaining-quota display, load balancing, shared/scoped project
defaults, multi-computer onboarding, stable/nightly promotion, async-question
dismissal, existing-branch mobile starts, and server-side background PR linking
became available. `v0.0.39` and `v0.0.40` were cut in this interval.

### 2026-09-08 to 2026-09-10

Material You colors/layout, Android activity notifications, question attachments,
project favicons, PR merge defaults, multi-PR threads, GitHub stack merge/rebase,
linked-PR search, image galleries/zoom, bulk model toggles, the first-class Device
panel, SSH device hosts, and the compact right-panel menu landed. Streaming
Markdown/code rendering received another concentrated performance pass.

### 2026-09-11 to 2026-09-12

Per-project settings overrides, environment/project selectors, floating device
streams, rewind while keeping files, open-source notices, inline file/attachment
chips, large-paste handling, desktop/web notifications, screen-reader headings,
default diff-file state, and mobile crash diagnostics landed. Client synchronization
and large-thread performance were further tightened.

### 2026-09-13 to 2026-09-15

Forgejo/Gitea, cross-environment GitHub account routing, grouped environment
connections, optional remote-only desktop operation, custom snooze, worktree setup
progress/cancel, background cloning, headless device-grant Connect login, and the
mobile Connect profile shipped. The CLI/runtime system moved to signed release
archives with self-update, uninstall, service restart, WSL/SSH staging, and
parallel multi-platform CI. The compact sidebar experiment was removed before the
tip.

## Integration implications for the fork

The upstream work crosses nearly every conflict-heavy boundary identified in the
companion fork audit: orchestration events, provider services/adapters, thread
projections, settings contracts, client-runtime state, web chat/layout, desktop
startup, mobile thread state, source control, MCP toolkits, migrations, docs, and
the lockfile. A synthetic merge reports 137 conflicted paths.

The highest-value upstream foundations to preserve before replaying fork features
are:

1. migrations 044–052 and the current contracts;
2. incremental orchestration/message synchronization and settlement semantics;
3. typed composer context and attachment normalization;
4. provider adapter boundaries, including Antigravity and compaction capability;
5. multi-environment settings/auth/routing primitives;
6. PR link projections and source-control registry changes;
7. self-contained runtime/release assumptions; and
8. performance companions for every ported chat, terminal, and sidebar component.

Treat the fork's MCP, workspace-pane, Source Control, desktop-attachment, and
timeline changes as ports onto this upstream model, not as conflict resolutions
that preserve old files wholesale.

## Verification performed

The audit used read-only Git and source inspection:

```text
git merge-base origin/main upstream-main
git rev-list --count origin/main..upstream-main
git log --no-merges bba79cc2..upstream-main
git diff --no-renames --name-status bba79cc2..upstream-main
git diff --no-renames --numstat bba79cc2..upstream-main
git tag --contains / git describe / tagged range counts
```

Counts were recomputed both with and without `.repos`. The final tree was inspected
in a detached worktree at exactly `a62e7d670c67bf221a5699b5a988367781fead74`.
The complete commit inventory below is generated from the same pinned range and is
intended to make omissions detectable.

## Complete upstream-only commit inventory

The list is chronological by author date. Each bullet contains the abbreviated
commit ID and exact subject from the audited range.

### 2026-08-31

- `746c932e1` `fix(mobile): defer draft navigation until submission completes (#8914)`
- `4e8e64fc0` `chore: disable CodeRabbit review status (#8933)`
- `038bf3739` `Delete app.json (#8934)`
- `5ce92c2f1` `fix(mobile): shimmer active tool rows (#8932)`
- `4a9d2d0ce` `chore(deps): bump Electron to 43.4.1 (#8626)`
- `ef84bc987` `fix(chat): smooth worktree setup status (#8922)`
- `31c1c5996` `feat(mobile): add video playback with native iOS controls (#8919)`
- `f47e74004` `fix(web): prevent chat metadata overlap (#8851)`
- `f8e4accf2` `feat(mobile): add native image and PDF previews (#8959)`
- `0df043fd4` `Add auto_review configuration to coderabbit.yaml`
- `85b656ff3` `style: format CodeRabbit configuration`
- `9bc7a5684` `feat(mobile): upload attachments while composing (#8978)`
- `9ecfc07a8` `fix(chat): keep agent activity visible between actions (#8984)`
- `42a8fd510` `feat(pull-requests): link GitHub references in markdown (#8812)`
- `b17cc3d1b` `perf(server): reduce frequency of full tool call output being loaded into memory from db (#8988)`
- `0947c30e6` `fix(client): use package import for markdown image helpers (#9010)`

### 2026-09-01

- `35da58133` `fix(web): show scrollbar for wide markdown tables (#8868)`
- `6d15c5bbc` `fix(server): preserve usage cache outside walked roots (#8540)`
- `41adccc83` `fix(server): allow long thread IDs in HTTP routes (#8898)`
- `929f7e647` `fix(shared): preserve Windows shell PATH priority (#8748)`
- `c50b0b4ef` `fix(web): make WSL settings searchable (#8881)`
- `17f00f602` `feat(web): add expand/collapse all control to the files surface (#8889)`
- `c78ae50a5` `fix(server): isolate remote web session cookies (#8085)`
- `d35c71d1b` `feat(web): add pull request list filters (#8809)`
- `ff93aba61` `feat(web): search individual settings by detail (#8831)`
- `ce71c04f0` `feat(client): render viewed images in work logs (#8936)`
- `73776d4e5` `test: remove static presentation snapshots (#9008)`
- `a9ffb8279` `perf(server): bound snapshot activity payload memory (#9000)`
- `0bfb6df34` `perf(server): cut idle CPU use and stop provider event leaks (#8187)`
- `8f1ef8b9e` `perf(server): scan only appended transcript bytes for usage summaries (#9024)`
- `7e4ce3bbb` `perf(server): cut chatty tool-update frames by 90% (#8368)`
- `f32f9a2f4` `fix(server): settle threads server-side (#8600)`
- `8b033de48` `fix(clients): dedupe skills in composer menus (#8043)`
- `62d39bf00` `fix(server): stop OpenCode child sessions (#9005)`
- `3c73fa7ce` `perf(web): defer pull request line stats until visible (#6471)`
- `e86604d33` `perf(server): skip full-message reads while streaming (#9032)`
- `b883fc066` `perf(client-runtime): halve server config bootstrap traffic (#8367)`
- `9dbdcece5` `fix(web): align un-settle banner action (#9033)`
- `b5b6abb11` `fix(web): block type-to-focus behind open dialogs (#8139)`
- `2d156a83b` `feat(shortcuts): copy active thread reference (#8994)`
- `261380f91` `fix(mobile): keep thread scroll bounds current after animations (#9013)`
- `643b21eda` `fix(server): cache project favicon resolution (#9080)`
- `c17d02cff` `feat(claude): add Claude Fable 5.1 model (#9078)`
- `ef7014d85` `fix(preview): restore recording and macOS rendering after Electron 43 (#9001)`
- `9d1879b14` `feat(desktop): add configurable quit shortcut confirmation (#9076)`
- `cb0074691` `feat(web): open project settings from thread menus (#8925)`
- `a924fbe08` `fix(chat): reuse one row for live activity (#9062)`
- `035428368` `feat(models): discover Claude models from remote manifest (#9084)`
- `163d50846` `Revert "fix(chat): reuse one row for live activity" (#9096)`
- `692eb1a57` `fix(web): sync sidebar PR state from open panel (#9092)`
- `d0b4acbd1` `fix(web): keep theme placeholder text dimmer than entered text (#9104)`
- `c0995d2ea` `fix(web): keep the selected environment when changing projects (#9102)`
- `590a579f2` `fix(chat): keep latest command live between messages (#9098)`
- `60cef47ec` `chore(release): prepare v0.0.38`
- `beae2147a` `fix(media): preview host files and stream videos across clients (#9023)`
- `04efa7907` `feat(cli): open projects in the running desktop app (#8824)`
- `b21d87243` `chore: vouch six repeat contributors (#9131)`
- `08aad594f` `chore: delete dead code, unused deps, and duplicate helpers (#9129)`
- `98725df00` `fix(web): mute routine notices and update actions (#9063)`
- `ea71a19d4` `fix(claude): skills picked from the composer now run (#9128)`
- `feb3ea7eb` `fix(web): stop highlighter freezes and worker spin by using the Oniguruma WASM engine (#8360)`
- `c2283ce14` `perf: make streaming projection and activity appends incremental (#9152)`
- `7e460f429` `fix(server): bound orchestration replay payloads (#8992)`
- `6866fd6b5` `perf(client-runtime): keep turn and checkpoint refs stable while streaming (#9145)`
- `5014e5fcd` `fix(desktop): show newest changes in nightly previews (#9138)`
- `8efd4e95f` `fix(settings): sync auto-settle and other shared preferences across environments (#9147)`
- `0e77fbd3d` `fix(server): prevent accidental service downgrades (#5302)`
- `716069f40` `fix(server): keep attachments until the command commits (#7941)`
- `d0b19b32e` `fix(claude): preview images read from the workspace (#9119)`
- `cdbf324aa` `fix(web): keep generated muted foreground dimmer than entered text (#9113)`
- `083d4de5b` `fix(clients): stop repeating expanded commands (#9120)`
- `a434677ec` `fix(grok): health check, model selection, and stop all work against the real CLI (#9154)`
- `b2f25d390` `feat(desktop): update the desktop app on remote Macs from the Update button (#6554)`
- `c37fd136e` `test(server): measure shell, second client, and reconnect transfer (#9157)`
- `0e1570bde` `fix(web): project default model works on the hosted app (#9142)`
- `8401f4d85` `fix(web): darken neutral control surfaces (#9064)`
- `f2a914b85` `fix(web): preserve panel state across workspace refreshes (#8968)`
- `f46a709ee` `feat(files): open markdown, HTML, and PDF files outside the workspace (#9140)`
- `d937e3075` `feat(web): render HTML and PDF files in the file viewer (#9143)`
- `fea1af81f` `fix(web): compact project settings actions (#9160)`
- `9fdafdf11` `feat(pull-requests): copy provider checkout commands (#9086)`
- `2ab7973fe` `fix(web): hide build pill in narrow sidebars (#9159)`
- `e7deb2aaf` `feat(web): cite assistant responses with inline citations (#9146)`
- `cde12790d` `fix(contracts): accept legacy pull request checkout results (#8238)`
- `db4bf9497` `chore: remove unused code and brittle tests (#9150)`
- `b520120cf` `fix(chat): improve tool group summaries and scrolling (#9106)`
- `082358f9e` `fix(desktop): check artifact build prerequisites (#8975)`

### 2026-09-02

- `3b3465f2a` `fix(web): changing projects no longer creates a draft (#9097)`
- `0222aa255` `fix(web): preserve theme when toggling advanced colors (#8500)`
- `9a7b1e21e` `perf(provider): bound persisted session lookups (#8909)`
- `fc53b2730` `perf(clients): lease sidebar status by visibility (#9052)`
- `80c708a1f` `perf(web): halve the cold-start bundle by splitting Clerk and cold routes (#9058)`
- `47a95332a` `fix(web): browse folders from file breadcrumbs (#8910)`
- `941acb4f9` `fix(provider): drop removed custom models from the model picker (#9075)`
- `e9db39ce0` `fix(web): align composer notices and stash (#8890)`
- `a1a2bb1cd` `fix(web): label keybinding condition removal actions (#8664)`
- `b8262b412` `fix(desktop): hold-to-quit no longer gets stuck (#9141)`
- `133db22fa` `feat(web): copy the full error report from the error page (#9166)`
- `c15735dd8` `fix(chat): replace failed tools with thinking (#9165)`
- `8339508f5` `fix(chat): align failed task progress test (#9172)`
- `43bafd467` `fix(web): open PR toast actions in app (#9006)`
- `80a14b658` `fix(server): discover project skills for Codex and OpenCode (#8778)`
- `0681d8549` `fix(pull-requests): expand code tab diffs by default (#9174)`
- `f9d1c65d4` `chore: bump vendored GhosttyKit and update terminal integration (#9155)`
- `535c83dea` `fix(web): copying a code block no longer copies triple backticks (#8448)`
- `5392c9bb9` `fix(models): restore sticky new-thread selections (#9164)`
- `827345a07` `fix(web): model info button opens its details on click (#9177)`
- `7a8df3338` `fix(desktop): skip cached monitor compiler check (#9184)`
- `d2042d288` `fix(web): avoid stale file writes on close (#8630)`
- `4116db980` `fix(server): bound OpenCode version probes (#8750)`
- `a56b0cd71` `fix(server): allow large Azure DevOps PR lists (#8572)`
- `a81a52afb` `fix(server): allow local-only worktree bases (#8751)`
- `6ff537f03` `fix(web): remove projects with archived threads (#8798)`
- `a19f01fc1` `feat(web): make context window indicator opt-in (#9190)`
- `9e646ad84` `fix(connect): refresh relay credentials before expiry (#9178)`
- `dd6879ffe` `fix(pull-requests): reuse github api reads (#9176)`
- `14f15cfed` `fix(server): stop titling linked PR threads from local git history (#9191)`
- `5b7d72aad` `feat(updates): continue active threads across server restarts (#9167)`
- `7e9d5a7ef` `fix(mobile): prevent message and composer overlap (#9195)`
- `f14f41b89` `fix(web): preserve composer draft during worktree setup (#9197)`
- `70cd258d8` `fix(web): prevent two-digit list markers from being clipped (#9101)`
- `bc918e74a` `fix(server): discover project skills for Claude (#9210)`
- `6effe0a2f` `feat(web): redesign provider editor and models list (#8508)`
- `6e3bac372` `fix(web): prevent connection rows from wrapping during removal (#8706)`
- `57a66608b` `fix(pull-requests): align checkout control with author (#9196)`
- `b5a09e13f` `fix(release): pin patched expo-sharing version (#9250)`
- `aab404964` `fix(ci): keep Expo Sharing patch applied (#9248)`
- `2a7a449cc` `fix(web): hide deleted providers with prototype keys (#8337)`
- `9159b808d` `feat(mobile): long-press file references for path and open actions (#9258)`
- `8d5b712de` `fix(desktop): exclude opposite macOS pty prebuilds (#9240)`
- `b57726ca8` `feat(web): add copy path button to diff headers (#2403)`
- `f90e2f2bd` `fix(server): subscribe before provider settings watcher (#9271)`
- `46b5c6640` `fix(chat): show single tool calls without summaries (#9267)`
- `28ddaf759` `fix(web): confirm closing agent-controlled browsers (#9272)`
- `134d51096` `feat(desktop): browser profiles for the preview browser (#7254)`
- `ca63d42d6` `refactor(shared): move the node:sqlite Effect SQL client into shared (#7272)`
- `91c8d4771` `feat(web): add opt-in panel animations (#8830)`
- `ba3cb0773` `feat(projects): automatically pull clean default branches (#9277)`
- `1eb36b45e` `fix(web): show pull request state icons in tabs (#9112)`
- `535557b3f` `feat(providers): add context compaction across harnesses (#8808)`
- `fb93902ee` `feat(web): add proactive panels (#9276)`
- `b59b7d0af` `fix(web): unify control sizing across settings pages (#9281)`
- `064392ffc` `fix(web): offer browser profiles from the empty-panel launcher (#9279)`
- `63f334baf` `Revert "feat(providers): add context compaction across harnesses" (#9284)`
- `c742edd46` `fix(web): show scroll-to-end as soon as the last message slips under the composer (#9280)`
- `994bd7373` `fix(cursor): honor auto and full access modes (#9283)`
- `4ba39a6f4` `fix(desktop): detect installed Spectre libs for Windows builds`
- `443b4ebfe` `fix(pull-requests): missing features & better behaviour (#9188)`
- `15fea6c5f` `fix(providers): discover workspace skills everywhere (#9180)`
- `2971ec320` `fix(server): preserve automatic settlement timestamps (#9254)`
- `dbc7bfa3f` `fix(opencode): show Reasoning selector for OpenCode models (#9287)`
- `775129984` `feat(web): preview document attachments in the file viewer (#9292)`
- `e94603adf` `chore(ci): narrow the UI consistency check-run agent (#9297)`
- `ef6cc0b36` `chore(ci): only run check-run agents on vouched contributors (#9298)`
- `355fbd96d` `fix(web): stop remounting markdown on every activity delta (#9306)`
- `d897641d7` `fix(pull-requests): keep cached PR chrome on reopen (#9294)`
- `0fbb94248` `feat(environments): draw each environment as the machine it runs on (#9299)`
- `9ebbeda5a` `feat(web): apply and remove labels from the pull request tab (#9313)`
- `31eeb4433` `fix(sidebar): collapse settled and snoozed shelves by default (#9314)`
- `922bd6922` `refactor(media): unify file and media previews across clients (#9253)`
- `ec44bc56f` `fix(chat): keep live tool labels in present tense (#9316)`
- `194f838e7` `chore: audit lint directives and move plugin allowlists into config (#9300)`
- `b9b1b8fdd` `chore(ci): narrow the Effect conventions check-run agent (#9321)`
- `85f2479ff` `refactor(mobile): style plain views with Uniwind classes instead of the theme bridge (#9322)`
- `66419a1d1` `fix(dev): share dev servers on the loopback Vite actually binds (#9324)`
- `9409dd20a` `fix(web): make the diff layout toggle a persisted setting (#9326)`
- `3b2de9da1` `chore: dedupe lightningcss and tailwind node bindings (#9331)`
- `f5fbb1bcb` `chore: upgrade vite-plus to 0.3.0 (#9327)`
- `1aa44a071` `feat(web): add a file tree to the diff panel and pull request code tab (#9330)`
- `5f84efa1e` `feat(web): add PageUp/PageDown chat navigation (#9315)`
- `d42254dfb` `fix(web): resolve Vite sourcemap and supports warnings (#9343)`
- `18062da94` `feat(web): choose whether links open in the default browser or in T3 Code (#9339)`
- `0bc59bbae` `fix(web): let the pull request list use wide screens (#9351)`
- `9f9359bd8` `fix(web): stop usage summary requests reporting slow RPCs (#9358)`
- `b5f4e8137` `feat(web): suggest ssh hosts in a dropdown under the host field (#9171)`
- `d4bd8923a` `feat(web): mod+w closes the active right panel tab before the window (#9363)`
- `829c3db94` `fix(environments): draw the machine icon everywhere an environment is named (#9365)`
- `c89e3e12a` `fix(web): settled sidebar rows use the project fallback icon (#9366)`
- `1f7a3c11c` `fix(mobile): pressed and disabled styles no longer apply unconditionally (#9355)`
- `24799de4f` `fix(mobile): size expanded tool groups correctly (#9359)`

### 2026-09-03

- `62c68dc41` `fix(mobile): show filled filter icon on Android when filters are active (#9217)`
- `5a9b56291` `fix(web): warn when shared settings have no target environment (#9207)`
- `12f1fc427` `fix(web): line up the titlebar wordmark label and version pill (#9255)`
- `2a3cfe456` `fix(web): collapse PR header actions to icons when narrow (#9334)`
- `6a5a18cb1` `fix(web): add press feedback to buttons (#9349)`
- `f6c04c552` `feat(web): add customizable project icons (#9137)`
- `1575ada30` `fix(mobile): stop indented code overflowing Android chat bubbles (#9347)`
- `6cf0c6ea5` `feat: display native app and browser icons in work logs (#9093)`
- `48ba76bc2` `fix(web): collapse oldest pull request comments (#9323)`
- `854541a04` `fix(pull-requests): shared state + not settling? (#9332)`
- `5eb4f452e` `test(web): remove static markup-only component tests (#9364)`
- `cf0bb4c35` `fix(web): match project icon chooser button sizes (#9368)`
- `5b8445b7a` `fix(web): collapse the resting composer (#7855)`
- `4b26132d2` `fix(web): keep trailing tool groups out of "Worked for" accordion (#9384)`
- `5d1b02cde` `feat(marketing): put named-developer quotes on the landing page (#9385)`
- `18573d60a` `fix(claude): expand slash commands when a message has attachments (#9122)`
- `044ea8e34` `fix(web): stop the resting composer layout loop (#9393)`
- `652515a34` `fix(web): render assistant images inline in chat (#9126)`
- `06336460c` `feat(providers): add Google Antigravity via the official ACP agent (#9348)`
- `2aa907b19` `fix(mobile): show an error instead of an endless preview spinner (#9123)`
- `2b745efe5` `fix(usage): price new models without waiting a day for the rate table (#9202)`
- `19c97ea56` `fix(web): unlock the composer when preview capture fails (#9127)`
- `1e0518730` `fix(antigravity): refresh the model manifest so older Gemini models fold as legacy (#9397)`
- `fff33f9e8` `perf(ci): reuse dependency checks in release builds (#9399)`
- `77e35c561` `fix(web): send cited messages with Cmd+Enter (#9307)`
- `57626eb6e` `fix(web): prevent loading ssh environments from overriding navigation (#9168)`
- `cfddb4201` `fix(mobile): skip unsupported shared settings targets (#9381)`
- `2120fbc18` `fix(web): avoid duplicate Antigravity install status (#9419)`
- `d4ba2a1f1` `fix(composer): mute fast icon when collapsed (#9451)`
- `21b9dda5a` `fix(web): unify skeleton loading animations on one pulse (#9448)`
- `645d58547` `fix(web): prioritize authored pull requests (#9453)`
- `4e89d7443` `fix(web): make project icons the default (#9457)`
- `c78f05a45` `fix(server): reuse pr state when settling threads (#9459)`
- `8bd544cdf` `fix(web): keep agent images collapsed (#9460)`
- `126afb56f` `fix(web): banner buttons no longer expand the resting composer (#9452)`
- `d5825e1d2` `fix(web): stop clipping the traits chevron on long Codex effort labels (#9433)`
- `46e8b1a23` `fix(web): make right panel tabs easier to scroll (#9461)`
- `de025aa69` `fix(mobile): show loading and syncing in the working pill (#9466)`
- `36c4e9cf5` `fix(server): keep a/ and b/ prefixes in rendered git patches (#9438)`
- `493fbb588` `fix(web): reuse pull request list data while loading (#9467)`
- `03728361a` `feat(web): let users turn off composer collapse on blur and scroll (#9469)`
- `373be93e6` `fix(web): move workflow approval beside checks (#9465)`
- `4b8b5d9e0` `fix(desktop): refresh generated annotation styles (#9488)`
- `0869ad648` `fix(web): let the PR reviewer and label search boxes take keystrokes (#9479)`
- `678f23a69` `fix(desktop): restore second-press quit fallback (#9485)`
- `c726c30a1` `fix(web): keep opencode icon hollow in collapsed composer (#9492)`
- `12e8997e5` `fix(web): keep agent browser preview visible (#9484)`
- `409bc4fa6` `fix(mobile): keep the machine glyph next to the environment label (#9486)`
- `80b53730d` `fix(mobile): let back swipe pop from horizontal scroll edges (#9493)`
- `e01c153c1` `fix(antigravity): forward Google sign-in URLs from browser helper (#9425)`
- `39449e53e` `feat(desktop): import browser cookies into a profile (#7255)`
- `ff5843410` `feat(desktop): import from Chrome, Edge, Brave, Vivaldi, Opera, Arc and Firefox (#7260)`
- `498ab9c39` `feat(desktop): resolve Chromium cookie keys on Linux (#7261)`
- `f25e44289` `fix(antigravity): allow slow runtime startup during setup (#9510)`
- `baf67b6e3` `fix(antigravity): keep model choices up to date (#9511)`
- `eb334ca57` `fix(antigravity): handle native sign-in URLs on stderr (#9514)`
- `8ea52c8f2` `fix(antigravity): update managed runtime to 1.1.1 (#9509)`
- `3653cb22f` `fix(desktop): address the browser import review left over from the stack (#9516)`
- `f8a14b28f` `feat(antigravity): show subagent calls and results (#9515)`
- `638226832` `fix(web): let paste expand a resting composer (#9498)`
- `522ebe65a` `fix(web): keep the composer open while selecting timeline text (#9499)`
- `c0ebc882b` `fix(web): return focus to the composer after closing a media preview (#9513)`
- `9c9ae3dc0` `fix(server): keep events during thread subscription startup (#9521)`
- `44701efd6` `chore: forward issue/PR/discussion events to Cursor hygiene (#9518)`
- `9d28c21a2` `fix(auth): keep pairing credentials out of access read models (#9523)`
- `e3723e06b` `chore: drop comment events from Cursor hygiene forwarder (#9527)`
- `d76b24dd1` `feat(codex): support async questions (#9512)`
- `0a0b6be96` `fix(web): keep right panel controls clickable (#9517)`
- `19d8ab2ae` `feat(usage): show Codex and Claude subscription limits on a Limits tab (#9507)`
- `343db2c32` `feat(web): reorganize settings pages (#9354)`
- `2b96220f0` `fix(server): settle branch threads immediately on pull request merge (#9528)`
- `b90898077` `fix(server): back off relay client restarts after rapid exits (#8788)`
- `6319a9714` `fix(desktop): preview CDP sessions no longer hard-crash the app (#9068)`
- `f54ab901f` `Fix worktree removal timing out on large install trees (#3902)`
- `07c4ab507` `fix(web): keep automatic project icons consistent (#9535)`
- `dddc0bdcb` `fix(server): include SQLite conditions in persistence errors`
- `6f405370c` `fix(dev): keep shared dev reloads and hot updates working (#9543)`
- `c5ba51d62` `feat(providers): add context compaction command (#9293)`
- `5989de44a` `fix(mobile): keep store screenshots free of system banners and show dictation (#9548)`
- `54aef6fbe` `fix(web): restore composer controls as space becomes available (#9539)`
- `3c3e05ccf` `fix(web): measure collapsed model labels at their visible width (#9540)`
- `f239b77df` `fix(web): close composer menus when their controls hide (#9541)`
- `3e2c1a66f` `fix(web): thread error banner no longer shifts the chat (#9473)`
- `617edab65` `fix(server): reveal normalized paths in File Explorer (#9551)`
- `232de5e8a` `feat(marketing): fresh screenshot and floating marks on the homepage (#9547)`
- `1641b4aba` `feat(usage): redeem Codex reset credits from the Limits tab (#9534)`
- `4e547318b` `fix(server): find newly opened pull requests after agent turns (#9125)`
- `f96a220b5` `ci: add on-demand Windows test workflow (#9538)`
- `710f6dc41` `fix(web): simplify expanded tool details (#9549)`
- `9e1bc36a0` `fix(web): keep the last message visible when the resting composer expands (#9553)`
- `fee2e0ff8` `test(web): fix flaky startup and Tailwind tests (#9558)`
- `65f1839ae` `fix(web): keep codex restart responses continuous (#9560)`
- `d7884ce90` `fix(web): make settings sidebar sub-section buttons full width (#9562)`
- `2b10398cc` `fix(web): render settings sidebar immediately (#9563)`
- `95390ed78` `chore: vouch august contributors (#9557)`
- `42bdea1c9` `fix(web): stabilize right panel transitions (#9554)`
- `0cb02abf5` `fix: better shell syntax handling for labels (#9371)`
- `bf40fa786` `fix(web): align the sidebar wordmark by baseline (#9578)`
- `2675e3c70` `fix(antigravity): keep subagent batches active after launch (#9579)`
- `b34ff8f56` `fix(usage): deduplicate CLI proxy subscription accounts (#9584)`
- `f1e90e388` `refactor(web): move usage provider controls to settings (#9599)`
- `2152d44de` `fix(server): load OpenCode workspace skills via SDK to avoid 64KB CLI pipe truncation (#9585)`

### 2026-09-04

- `098bf5329` `fix(web): preserve explicit preview navigation URLs (#8902)`
- `db8d60f48` `fix(web): render transparent previews on white (#9463)`
- `d2b6f3b92` `fix(server): full-access OpenCode threads no longer ask for approvals (#9282)`
- `77138cf33` `fix(web): dont collapse composer when interacting with bottom row (#9490)`
- `0aae1e2ad` `fix(antigravity): discover legacy workspace skills (#9410)`
- `ef4cc6085` `fix(mobile): resolve Antigravity provider icon and normalize driver matching (#9495)`
- `75ab5ab3f` `fix(codex): accept rate limit errors on thread resume (#8897)`
- `0ba06a122` `fix(web): settle the resting composer layout with a pixel of slack (#9482)`
- `09b81a349` `fix(mobile): render workspace images in markdown file previews (#8769)`
- `07891e956` `fix(web): bound disconnected send toasts (#9592)`
- `57832803e` `fix(desktop): restore panel titlebar interactions (#9591)`
- `39abb9d1d` `fix(connect): refresh authorization without disconnecting (#9582)`
- `f559fe0ba` `fix(web): show context meter in compact composer (#9430)`
- `5cc369b7e` `fix(pull-requests): refresh data after thread turns (#9496)`
- `caab2fdba` `fix(web): render draft PRs in gray (#9537)`
- `00f8b7c28` `fix: show idle subagent batches without completion marks (#9616)`
- `61a91b6ef` `fix(web): group image views like other tool calls (#9597)`
- `c3b8825bf` `fix: preserve tool icons on failed calls (#9606)`
- `99e3b721c` `fix(connect): diagnose incomplete headless server setup (#9602)`
- `4cc800c75` `fix(web): keep command palette above composer menus (#9613)`
- `93c3ab4ff` `fix(web): snooze menu no longer overlaps thread details (#9601)`
- `706231535` `fix(web): match composer pull request state icons (#9375)`
- `ec3ec6f0b` `fix(web): mute sidebar branch name to match worktree icon (#9622)`
- `5f878d2a8` `fix(web,mobile): fold context compaction under settled turn folds (#9623)`
- `09d13de43` `feat(mobile): make chat text selectable on Android (#8779)`
- `14bf3f6d1` `fix(web): toggle a single stashed prompt with Cmd+S (#9644)`
- `eb77683e5` `fix(server): prevent duplicate desktop clients after restart`
- `d487dfbf4` `fix(web): resume Antigravity threads without repeated sign-in (#9647)`
- `d5b941008` `feat(mobile): paste the phone clipboard into the terminal (#9199)`
- `f03473224` `feat(web): show which sidebar threads hold an unsent draft (#9658)`
- `01f3e50ec` `fix(server): unblock OpenCode approvals and stop (#9653)`
- `caa8a0db9` `fix(desktop): quit immediately on a second shortcut press (#9657)`
- `560afffde` `fix(server): update Claude Agent SDK to 0.3.260 (#9135)`
- `8ac546292` `perf(server): stop loading message bodies for thread summaries (#9662)`
- `cccd7e3c8` `perf(web): speed up terminal snapshots (#9663)`
- `082cab224` `fix(web): show machine icons in the environment picker (#9668)`
- `3b6be3ef4` `perf(mobile): bound diff syntax highlighting work (#9673)`
- `887ece307` `perf(web): keep Markdown mounted during streaming (#9677)`
- `7cf5b284e` `perf(mobile): skip unused legacy list work (#9679)`
- `8e3aa324b` `perf(marketing): serve images at their display size (#9682)`
- `27e6cc27f` `perf(server): cache and stream static web assets (#9669)`
- `2263e13fd` `perf(server): batch projector cursor writes (#9671)`
- `f2e3764c2` `perf(server): stop retaining unused OpenCode tool history (#9684)`
- `44dc8ae25` `perf(mobile): reuse chat feed rows during streaming (#9688)`
- `ec8b2119c` `perf(server): omit repeated OpenCode progress logs (#9689)`
- `246064993` `perf(clients): avoid waiting to read cached relay tokens (#9691)`
- `777f5bb2e` `perf(mobile): reuse diff rows during comment edits (#9693)`
- `dab5f6e6e` `perf(web): defer composer draft serialization (#9695)`
- `1587f248d` `feat(server): measure provider turn token usage (#9132)`
- `4ee2a9d04` `perf(marketing): stop continuous homepage motion (#9697)`
- `c163d502d` `perf(server): avoid full patches for checkpoint summaries (#9694)`
- `b3e1d8859` `perf(web): defer diff workers until a code view opens (#9692)`
- `010d6bb1b` `perf(marketing): serve website fonts locally (#9701)`
- `3bbbc1d9f` `perf(server): stop rebuilding terminal history per chunk (#9703)`
- `dffb4cd3b` `perf(server): use one query for buffered provider events (#9706)`
- `c75299ee2` `perf(relay): avoid repeated activity decoding (#9708)`
- `c7c1dfe4d` `perf(web): stop continuous chat status animations (#9709)`
- `7839140e5` `fix(mobile): preserve saved work after storage read failures (#9710)`
- `da7e46d08` `perf(web): stop replaying terminal buffers on rollover (#9707)`
- `95103905f` `feat(web): preview pull request links (#9631)`
- `c66f15f39` `perf(client): reduce thread-list update work (#9716)`
- `d536b0580` `fix(server): settle inactive threads with open PRs (#9610)`
- `108f295cc` `fix(server): bound slow-client event buffers (#9715)`
- `8ccb933a8` `test(server): allow either valid file-search match (#9720)`
- `8357eef14` `fix(web): match provider settings layout for disconnected devices (#9619)`
- `120fab18d` `fix(web): keep the slash menu above the composer when vertical space is short (#9625)`
- `9eb4d7168` `fix(mobile): remove provider setup (#9721)`
- `5eab021a5` `perf(web): stop rendering hidden terminals (#9718)`
- `c4353bc6b` `fix(mobile): read file-backed image drafts before enabling them (#9713)`
- `50bfca43d` `perf(server): replay only the selected thread (#9726)`
- `7d5dc66c1` `fix(web): mute composer helper text (#9654)`
- `c7bf3115f` `feat(web): unpin threads from the sidebar multi-select menu (#9651)`
- `19c1710a8` `perf(web): reuse timeline rows while text streams (#9725)`
- `088cc3f95` `fix(relay): bound stalled push requests (#9734)`
- `c8f77e0d4` `perf(server): stop caching unused OpenCode tool parts (#9738)`
- `cfc9bf341` `fix(web): fold single trailing activity (#9739)`
- `cbe93e8df` `fix(web): show project settings for new threads (#9743)`
- `d6e29dc9d` `perf(mobile): bound the parsed review cache (#9749)`
- `fec606f9a` `perf(web): avoid repeated terminal metadata scans (#9747)`
- `cf9729d5e` `perf(server): bound terminal history by bytes (#9748)`
- `a76b898b3` `feat(web): link pull request authors to profiles (#9627)`
- `0de956ed2` `fix(web): refine server update notice (#9744)`
- `d7cf8aaa8` `perf(client): stop thread streams when unused (#9740)`
- `77b655c47` `perf(mobile): defer file preview highlighter startup (#9752)`
- `6365919f2` `perf(server): skip history reads for metadata commands (#9758)`
- `15eda897d` `perf(web): defer image URL requests for thread history (#9760)`
- `bc03c3640` `fix(models): make GPT-6-Astra current (#9762)`
- `d115a9676` `fix(web): stop empty diffs replacing pull requests (#9753)`
- `45bd3b631` `fix(sidebar): mute background working threads (#9759)`
- `f6db42062` `fix(web): reset automatic pull to default (#9763)`
- `13427ecd8` `fix(web): restore file comment focus in editable preview (#9061)`
- `2e688a53c` `docs: keep internal guides focused on architecture (#9755)`
- `9e1fb459a` `docs: focus user guides on features and workflows (#9756)`
- `cd713679b` `fix(web): stop panel motion during navigation (#9766)`
- `8e056a0e5` `fix(web): open composer selectors below controls (#9767)`
- `163d86a78` `perf(server): skip unused Linux process detail reads (#9768)`
- `bfef973d9` `fix(server): remove retired Codex models after refresh (#9773)`
- `cc60753aa` `test: stop path and platform tests depending on the host OS (#9564)`
- `4701041ee` `test(server): skip posix executable fixtures on a Windows host (#9565)`
- `30f128fab` `test: skip symlink fixtures where the host cannot create symlinks (#9566)`
- `5c6c1d67d` `test(server): run fake provider CLIs through a Node stub on every host (#9567)`
- `c251e41b5` `test(desktop): make path fixtures and timeouts host-portable (#9568)`
- `f083f520f` `fix(server): tolerate the missing directory fsync on Windows (#9569)`
- `12b6d026b` `test(server): pin git config for fixtures and compare native realpaths (#9570)`
- `1108be0fc` `test: skip POSIX mode-bit assertions on a Windows host (#9571)`
- `9af5139f5` `test(server): keep provider fixture directories host-portable (#9572)`
- `9fa54eeb4` `test: resolve the Windows temp directory to its long name (#9573)`
- `912276bcd` `test(server): run the Antigravity install harness for the host platform (#9574)`
- `5f4c7161f` `fix(server): canonicalise media paths the same way their callers do (#9575)`
- `b123cbb31` `test(server): make Windows path and async fixtures deterministic (#9576)`
- `781f41ef1` `fix(server): refuse symlinked theme files on Windows too (#9580)`
- `0a590fa01` `test(scripts): keep Windows packaging checks host-portable (#9589)`
- `b7d6e6502` `fix(contracts): include tool.denied in runtime event types (#9770)`
- `24aef0e6c` `feat(mobile): split the usage page into Usage and Limits tabs (#9775)`
- `935917f50` `fix(web): restore the running tool label shine (#9777)`
- `764946502` `fix(web): align provider controls with machine tabs (#9769)`
- `5e1c23d76` `docs(web): document panel motion during navigation (#9778)`
- `394e8470c` `feat(usage): support custom model prices (#9774)`
- `91c66ac43` `fix(web): center pull request link previews (#9794)`
- `98a29cbaa` `fix: address usage limits and merge settlement regressions (#9784)`
- `389bbcc8d` `fix(web): give toggle thumbs consistent inset spacing (#9805)`
- `5a2f3ebf6` `fix(web): use segmented controls for mode switches (#9781)`
- `b906ce2d7` `fix(server): recover opted-in threads after machine restarts (#9803)`
- `dd7bc147f` `fix(web): simplify changed files into a persistent folder tree (#9821)`
- `5a433244d` `feat: add custom model names and option descriptors (#9807)`
- `f33fdc992` `fix(ssh): exec managed servers without npm wrappers (#9843)`
- `0dd5c64bc` `fix(server): detect nested Git workspaces for checkpoints (#9842)`
- `4f1092cec` `fix(web): keep worktree origin preference visible (#9846)`
- `2e61301b1` `fix(web): smooth settings sidebar transitions (#9811)`
- `4d3907f63` `feat(web): highlight visible settings sections (#9812)`
- `caf4981e3` `fix(web): reload saved colors when reopening the theme editor (#9847)`
- `ed2bdbb27` `feat(desktop): import cookies from Safari (#7262)`
- `8faf031c2` `fix(web): respect case in POSIX file links (#9309)`
- `fce850845` `fix(server): surface a missing workspace folder instead of a spawn error (#5040)`
- `b6f72681d` `fix: stop favicon requests for private link hosts on web and mobile (#5838)`
- `2d5464afb` `fix(server): preserve native provider executable paths during updates (#9850)`
- `720e126b7` `fix(web): restore composer expansion after tool calls (#9782)`
- `2dca7a1ed` `fix(client): explain possible network blocking for T3 Connect (#9783)`
- `b5fb3fba0` `fix(desktop): isolate preview keyboard shortcuts from the host (#9840)`
- `110bbe6b5` `fix(prs): reuse GitHub data and defer optional reads (#9835)`
- `896fe82f2` `fix(web): preserve focus and prioritize picker shortcuts (#9795)`
- `ce4712d5b` `fix: restore UX after performance improvements (#9799)`
- `4ade36518` `fix(ci): add fallback Ubuntu package mirrors (#9864)`
- `03c6cd8ba` `fix(web): copy text over plain HTTP (#8023)`
- `d7fe47fd0` `fix(server): dismiss native questions when their turn ends (#9851)`
- `d28077e58` `fix(server): quote copied native provider update commands (#9856)`
- `1665d81bb` `fix(release): install the correct Windows Spectre component (#9859)`
- `1246146f5` `fix(web): show retained runtime diagnostics in the work log (#9870)`
- `7f8cf30ca` `fix(web): make sidebar project actions reachable by keyboard and screen reader (#5521)`
- `de1b798c6` `fix(preview): bound automation waits and screenshot captures (#4685)`
- `7ee52b077` `fix(web): render and filter usage as environments respond (#9860)`
- `84b99f3fb` `feat(web): edit usage prices across selected environments (#9861)`
- `ac90950f1` `fix(mobile): keep usage tabs below the header when switching (#9876)`
- `363cde411` `fix(connect): refresh HTTP credentials without reconnecting (#9594)`
- `b01771c23` `fix(web): keep file autosaves active after effect replay (#9878)`
- `a0eb23993` `fix(web): prioritize open panel pull request when copying (#9877)`
- `9cb40178a` `fix(cli): resolve projects with missing workspace directories (#9885)`
- `931d41f93` `fix(web): sort equally merge-ready pull requests by diff size (#9887)`
- `94cc8152f` `fix(chat): show hours for long runs (#9894)`
- `2fb99a7a6` `fix(server): only run provider updates through the installer that owns the binary (#9325)`
- `df8e0eb46` `fix(web): discard stale highlights after file edits (#9902)`
- `fd773172e` `feat(web): recall sent prompts with the up arrow (#9173)`
- `c7dc3cbd0` `fix(server): keep mise-owned npm packages manual-only (#9927)`
- `7a089b2b2` `fix(server): capture turn checkpoints after all edits finish (#9841)`
- `2fa5ef4c7` `fix(web): load file grammar before enabling edits (#9947)`
- `e5a87e8b9` `fix(web): deduplicate PR project filter choices (#9948)`
- `07d2497db` `test(web): keep provider field readers private (#9952)`
- `a399473c3` `test(mobile): keep composer selection helper private (#9953)`
- `f530d7b61` `test(client-runtime): keep scoped key implementation private (#9955)`
- `6b87ce3a0` `fix(web): reveal reselected diff files (#9951)`
- `eae770b12` `refactor(web): remove obsolete changed-files preview helpers (#9956)`
- `bc8584bf8` `fix(web): give the browser keybinding notice breathing room (#9964)`
- `126ea5c3b` `chore: configure Knip workspace audits (#9958)`
- `4a42fc62e` `refactor(web): prune unused UI and provider code (#9959)`
- `2759ef05b` `chore(mobile): remove obsolete widget wiring script (#9960)`
- `00d46188b` `chore: remove redundant root tooling dependencies (#9961)`
- `d2c3e2e5d` `ci: reject unused files and dependencies with Knip (#9962)`

### 2026-09-05

- `087cfb8ae` `fix(cursor): discover symlinked skills as package boundaries (#9420)`
- `1963ca0ab` `fix(web): keep the sidebar project filter across navigation (#9416)`
- `a5bbad910` `fix(server): surface Claude safety model fallback notices instead of dropping them (#8853)`
- `c3caceade` `perf(shared): skip duplicate PATH entries and per-probe tracing (#9618)`
- `82f64cd8d` `fix(skills): support names beginning with digits (#9244)`
- `89ee69e44` `fix(server): advertise truecolor in the integrated terminal (#7680)`
- `940e8233c` `fix(claude): surface usage-limit pauses in the thread (#7165)`
- `57a6b70e2` `fix(codex): show what a file-change approval will change (#8669)`
- `f47a3fe90` `fix(settings): share restart continuation across environments (#9933)`
- `dfc70a329` `test(contracts): keep driver default lookup private (#9968)`
- `32142cff1` `test(server): remove Azure permissions constant snapshot (#9973)`
- `1568b3fd0` `refactor(shared): remove unused viewport formatters (#9970)`
- `c1e279eca` `refactor(mobile): remove unused provider option summary (#9971)`
- `1782a2af4` `refactor(client-runtime): remove unused connection phase message (#9972)`
- `eda0cec92` `refactor(mobile): remove unused layout calculations (#9974)`
- `044a6e168` `refactor(client-runtime): remove unused file position predicate (#9976)`
- `5fe29c894` `refactor(mobile): remove unused font size steppers (#9975)`
- `b3f8dd979` `test(server): cover thread lookup through command invariants (#9978)`
- `2fc630c9e` `test(server): remove provider equality wrapper fixture (#9979)`
- `1550f1b74` `test(server): assert the dispatched welcome thread model (#9980)`
- `14da63457` `refactor(desktop): remove unused keyring remediation text (#9981)`
- `a9caf7b70` `refactor(desktop): remove test-only Electron error predicates (#9982)`
- `ea0487cc9` `refactor(web): remove unused pull request state label (#9984)`
- `aefef95ff` `perf(web): keep timeline row reuse engaged while text streams (#9909)`
- `3e1333319` `fix(web): reset markdown widgets when the previewed file changes (#9910)`
- `50027bb3a` `fix(mobile): keep highlighting review diffs after a long line (#9911)`
- `fc1f543d6` `fix(marketing): align the endorsement carousel with its heading (#9912)`
- `f87ecf0cc` `fix(client): keep warm thread resumes live instead of flashing sync (#9913)`
- `371e32392` `test(server): remove authorization prompt snapshots (#9985)`
- `10421bcdc` `test(server): remove static OAuth page snapshots (#9986)`
- `9867eb123` `test(server): remove provider label identity assertion (#9987)`
- `94d1fa7ff` `test(server): consolidate agent activity opt-in coverage (#9988)`
- `aca2afc0b` `refactor(shared): remove unused preview URL predicate (#9989)`
- `c6410d37d` `refactor(shared): remove unused mention path serializer (#9990)`
- `da1bebbb1` `refactor(shared): remove retired PATH capture parser (#9991)`
- `3bcde91f8` `refactor(client-runtime): remove unused subagent selectors (#9992)`
- `487d1766c` `refactor(web): test the live usage column builder (#9993)`
- `c7e93f520` `refactor(web): remove unused aspect ratio reconciler (#9994)`
- `bf1c1b097` `refactor(web): remove obsolete cloud listing helpers (#9995)`
- `4f1dc55ca` `test(web): remove composer control style snapshots (#9996)`
- `11cb88efc` `test(web): keep the preview profile label helper private (#9997)`
- `3fedf5246` `test(server): cover raw OpenCode deltas through the adapter (#9977)`
- `ba873b818` `refactor(web): remove obsolete pull request link opener (#9983)`
- `ac93fbfad` `test(relay): keep the stage slug helper private (#9998)`
- `1e24b43d3` `refactor(mobile): keep project selection helper private (#9999)`
- `1c59d3b72` `refactor(mobile): keep review default ID helper private (#10000)`
- `3382b26c4` `refactor(mobile): remove unused native style constants (#10001)`
- `393d1ffc9` `refactor(mobile): test terminal palettes through public theme API (#10002)`
- `8d48a3134` `refactor(mobile): remove unused file tree walkers (#10003)`
- `1584076d7` `refactor(shared): keep persisted settings helpers private (#10004)`
- `4e5e17fd9` `test(mobile): remove mocked UUID shape assertions (#10006)`
- `1449deca0` `refactor(mobile): test final connection status presentation (#10007)`
- `4e59b06b8` `test(web): keep pull request menu items private (#10016)`
- `3e544f8cd` `refactor(shared): test favicon selection through public API (#10005)`
- `270e021f2` `refactor(server): remove test-only pricing normalizer (#10017)`
- `93d4dfa20` `refactor(web): remove unused desktop update visibility helper (#10014)`
- `c9b76e6f5` `refactor(web): remove obsolete provider update helpers (#10015)`
- `b7fc81dea` `refactor(web): remove unused terminal context preview formatter (#10009)`
- `82c2b7ffb` `refactor(web): test environment-scoped draft promotion (#10010)`
- `6270a6f88` `fix(web): retain wrapped row heights during edits (#10018)`
- `cb58dfd64` `refactor(shared): remove unused Clerk hostname predicate (#10008)`
- `1d58f2ecc` `refactor(tailscale): keep package internals private (#10011)`
- `cd92a7e7a` `ci: reject unused tailscale exports with Knip (#10012)`
- `eced382b4` `fix(web): keep chat media at a stable size while it loads (#9938)`
- `31fb21009` `refactor(server): keep manifest age parsing private (#10028)`
- `37bf4e6ec` `refactor(mobile): remove unused awareness relay URL normalizer (#10029)`
- `f5d9d1202` `refactor(server): remove unused startup heartbeat launcher (#10030)`
- `86f079964` `refactor(shared): keep search ranking comparator private (#10031)`
- `68aa7aa83` `refactor(server): keep telemetry identity errors private (#10032)`
- `83a2897ed` `refactor(mobile): test composer persistence through the live decoder (#10033)`
- `5cb696595` `refactor(web): remove unused sidebar selectors (#10034)`
- `ad3721eb5` `refactor(server): keep Cursor fallback models private (#10038)`
- `07fb04dc6` `refactor(web): remove unused xterm link range helpers (#10040)`
- `c059d09b9` `refactor(mobile): remove obsolete review list builder (#10039)`
- `a21c0d724` `test(server): remove duplicate VCS error constructor checks (#10042)`
- `5e828bf3d` `refactor(mobile): keep appearance calculations private (#10043)`
- `5a4287cd6` `refactor(web): remove unused sidebar menu action (#10044)`
- `6615d3d70` `refactor(web): test live Ghostty link resolution directly (#10041)`
- `df370c31d` `test(server): exercise Codex prompts through public assembly (#10045)`
- `62e74cdd9` `refactor(shared): remove unused elapsed-time adapter (#10046)`
- `91ba05e87` `refactor(web): remove unused preview thread reset helper (#10049)`
- `56a2f42b8` `refactor(desktop): remove test-only error predicates (#10047)`
- `c2aff911c` `refactor(mobile): keep review reset hashing private (#10048)`
- `a98dad77e` `test(web): remove AppRoot element order snapshot (#10052)`
- `62e4ae400` `refactor(codex): keep app-server client internals private (#10035)`
- `4631000f5` `ci: reject unused Codex client exports with Knip (#10036)`
- `45f5a5ffb` `refactor(server): simplify native telemetry error internals (#10057)`
- `5b7f6bcfb` `refactor(mobile): remove write-only terminal font cache (#10058)`
- `80f775a42` `refactor(web): remove obsolete HSL theme generator (#10061)`
- `d524eb969` `refactor(mobile): remove obsolete native diff token stream (#10062)`
- `bc24d98d1` `test(server): remove title prompt editorial snapshots (#10063)`
- `160e337a5` `test(server): remove repeated runtime prompt interpolation cases (#10059)`
- `43700b83e` `refactor(web): observe preview tests through the live registry (#10064)`
- `fedf84ac7` `test(server): remove keybinding default assignment snapshot (#10065)`
- `4db2c542a` `refactor(mobile): remove obsolete whole-file review highlighters (#10067)`
- `0acf05f4f` `test(server): cover CLI runner detection through command suggestions (#10066)`
- `ee150e178` `refactor(mobile): remove unused cloud relay URL normalizer (#10068)`
- `009c13fad` `refactor(web): test live keybinding resolvers directly (#10069)`
- `25cbcd62d` `test(server): cover Grok skill parsing through discovery (#10070)`
- `38812c101` `test(web): remove mocked diff view prop snapshot (#10073)`
- `19ea3c5be` `test(web): remove mocked annotation options snapshot (#10074)`
- `688e59480` `refactor(web): keep pending action labels private (#10075)`
- `b92a81228` `refactor(mobile): remove unused cloud pending-status mapper (#10071)`
- `ab0933a41` `refactor(web): remove unused model picker hint helpers (#10072)`
- `c843c1929` `fix(server): resume checkpointing after git init (#10078)`
- `09aac7156` `feat(web): first-run welcome wizard with agent setup and project import (#5362)`
- `2271a27da` `fix(server): keep Homebrew mise shims manual-only (#10085)`
- `39802c061` `fix(ssh): report remote package installation failures accurately (#10088)`
- `bd7f7ea09` `fix(web): keep bulk thread deletion going after failures (#4615)`
- `be7796d86` `fix(web): scale agent spawn rows with interface font (#10092)`
- `485782b2a` `fix(web): prevent sidebar tooltip title clipping (#10086)`
- `c1d27e593` `fix(web): keep the composer expanded until the thread can scroll (#9965)`
- `761d4bac1` `fix(web): preserve original mention text in the composer (#10100)`
- `6a8f4d3b8` `refactor(mobile): remove unused pairing redaction wrapper (#10147)`
- `47e250a84` `test(web): drop provider banner styling assertions (#10148)`
- `29c3a54a4` `refactor(client-runtime): remove unused relay token waiter (#10151)`
- `a324cabc0` `test(web): drop sidebar artwork styling snapshots (#10152)`
- `3fbc497b7` `refactor(ssh): keep package internals private (#10144)`
- `62ed748ac` `ci: reject unused SSH exports with Knip (#10145)`
- `cb9a69423` `refactor(acp): keep protocol implementation exports private (#10165)`
- `2c301fd0c` `fix(shared): validate cloudflared with the version subcommand (#9880)`
- `60e1b7394` `fix(desktop): separate LAN and Tailscale pairing endpoints (#9882)`
- `311f05c8e` `fix(server): install pinned runtime when pnpm node lacks npm (#9923)`
- `8d3c56b48` `fix(web): hide sidebar search shortcut on mobile (#9932)`
- `89bd6376d` `fix(web): align tool disclosure chevrons with expanded state (#9935)`
- `6349a0e68` `fix(antigravity): distinguish session initialization auth failures (#9919)`
- `0d8a91a25` `fix(cursor): cache successful model discovery between refreshes (#9918)`
- `4ca71463a` `fix(opencode): revert from the first removed assistant message (#9924)`
- `d92dca74e` `fix(web): resume imported custom-provider threads (#10184)`
- `f8b4c464b` `test(web): cancel pending highlight fixture frames during cleanup (#10188)`
- `e2e6ce6a2` `feat(server): report image dimensions with signed asset URLs (#10198)`
- `7451d17a6` `fix(mobile): size a chat image's frame before its bytes arrive (#10199)`
- `d0f855bfa` `fix(web): size the chat image slot from server-reported dimensions (#10200)`
- `0671e3427` `refactor(shared): remove unused runtime helpers and exports (#10166)`
- `dbfd51731` `refactor(client-runtime): remove unused runtime exports and helpers (#10167)`
- `5716dec97` `refactor(contracts): keep RPC implementation exports private (#10168)`
- `50bc62a83` `refactor(contracts): trim unused client API runtime exports (#10169)`
- `2ae3b712b` `refactor(contracts): keep unused settings and relay exports private (#10170)`
- `5fe5c6fe9` `ci: enforce runtime exports while allowing types and schemas (#10171)`
- `54441e63d` `fix(web): copy provider update commands from compact rows (#9888)`
- `3be90ced4` `fix(web): align provider header action sizes and spacing (#9890)`
- `3fb8942a4` `fix(mobile): restore live tool shimmer and add a Thinking row (#10173)`
- `1cb49c3df` `fix(mobile): even out the working pill's spacing (#10209)`
- `7eda989d3` `fix(mobile): only make work rows expandable when the body adds something (#10210)`
- `579a77588` `fix(mobile): fold subagent lifecycle rows into one batch per spawn (#10211)`
- `89cc7434f` `fix(mobile): stop clipping expanded tool groups (#10212)`
- `88fc41c1b` `refactor(web): test file cache identity through its public helpers (#10219)`
- `748fe0f8b` `refactor(web): test favicon fallback through the component (#10220)`
- `585ce2c2a` `refactor(web): test formatted timestamps instead of formatter options (#10221)`
- `bd16b86d5` `fix(client-runtime): report terminated thread loads (#10216)`
- `050690d1b` `fix(server): settle threads using actual pull request terminal timestamps (#9934)`
- `b438447f6` `fix(mobile): use selected theme across input forms and controls (#10239)`
- `bfba77816` `fix(mobile): keep the new-task draft when switching environment (#10247)`
- `3da9399b1` `fix(web): let authorized clients scrolling reach settings (#10080)`
- `c8872fd22` `fix(server): keep the Antigravity Google sign-in across server restarts (#10244)`
- `ab67795dd` `fix(antigravity): load user skills from ~/.gemini for every project (#10257)`
- `b2e15185a` `feat(marketing): add a Windows 95 landing page (#10286)`
- `fdcc491e0` `refactor(web): remove unused runtime wrappers and exports (#10225)`
- `226abe5f9` `refactor(web): keep feature component helpers private (#10226)`
- `1200f530b` `refactor(web): keep app utilities private and remove dead helpers (#10227)`
- `da2ba5b81` `ci: enforce unused runtime exports in the web app (#10228)`
- `76f686d03` `test(desktop): cover Clerk setup through the service (#10284)`
- `cabac780f` `test(desktop): cover WSL hashes through runtime resolution (#10285)`
- `181e45110` `test(desktop): cover password store through startup (#10287)`
- `0c200c5f8` `test(desktop): cover WSL paths through public behavior (#10289)`
- `b4040d9bf` `test(desktop): exercise WSL cache safety through public scripts (#10301)`
- `f93aafcc2` `test(web): cover file classification through diff ordering (#10304)`
- `a9fc4dc2b` `test(web): focus command palette tests on search behavior (#10302)`
- `b972f1c1d` `test(web): keep Markdown gutter styling private (#10306)`
- `f1e84c28f` `test(web): keep settings viewport comparison private (#10307)`
- `b7465a3bc` `fix(mobile): stop the work log flickering during subagent runs and failing calls (#10273)`
- `a49538558` `fix(mobile): save linked media from chat (#10271)`
- `272d6d747` `feat(markdown): show the GitHub mark for github.com links (#10324)`
- `d924fe266` `fix(marketing): show a real preview card when t3.codes is shared (#10305)`

### 2026-09-06

- `c2cfe59ac` `fix(web): defer browser discovery in integrations (#9797)`
- `183c34330` `feat: show provider usage limits with /usage-limits (#9875)`
- `be53bbd85` `feat(usage): show remaining quota instead of used (#9889)`
- `f12d39359` `fix(ui): unify loading and refresh feedback across clients (#9561)`
- `eee05575e` `fix(clients): persist project icons across reloads and reconnects (#10138)`
- `2c3353578` `fix(web): keep timestamp tooltip dates in English (#10256)`
- `add8c3a55` `fix(web): remember usage page selection (#10189)`
- `84aebb72f` `fix(web): respect reduced motion in shared disclosures (#10258)`
- `fc7ad2eda` `fix(web): add project settings to legacy sidebar project menu (#10021)`
- `9f40b2f56` `feat(settings): add shared project defaults and scoped overrides (#9754)`
- `420fd76f6` `feat(connections): balance new threads across connected machines (#9895)`
- `4f782beda` `fix(web): prevent file tree search focus ring clipping (#10175)`
- `b273d1cfe` `feat(usage): pool subscription limits per provider across accounts and environments (#10300)`
- `00d6109cb` `chore(web): remove usage limits demo fixtures (#10330)`
- `127efae44` `fix(web): expose error disclosure state (#10125)`
- `bc028738a` `fix(web): name the editor picker accurately (#10124)`
- `aea9ecbc4` `fix(web): make task row states readable (#10128)`
- `82689782e` `fix(web): explain hosted connection prerequisites (#10129)`
- `55333833e` `fix(web): name combobox chip removal targets (#10127)`
- `e5d086c26` `fix(marketing): present the Git workflow as an illustration (#10130)`
- `b155c2199` `feat(mobile): pool usage limits across selected environments (#10334)`
- `7544d3d2c` `fix(release): space automatic nightlies at least six hours apart (#10272)`
- `dd6407291` `refactor(web): share bulk thread deletion between sidebars (#10106)`
- `ac11bd29b` `refactor(client): share tool outcome rules (#10122)`
- `4c7cd17a8` `refactor(server): share Claude result status and error mapping (#10296)`
- `f66cfe221` `fix(server): settle inactive threads without a PR lookup (#10103)`
- `60e6fa30c` `fix(ssh): report remote stop failures without losing ownership (#10105)`
- `281b92b48` `perf(server): stop scanning old OpenCode parts (#10116)`
- `17490c0a0` `perf(server): avoid full thread reads on turn start (#10108)`
- `076d753ae` `perf(web): skip checkpoint map rebuilds while streaming (#10118)`
- `eb8ed8030` `perf(server): skip plan bodies in thread summaries (#10341)`
- `62f568b88` `fix(server): skip disabled provider instances for text generation fallback (#10346)`
- `e0adcc8a2` `fix(server): capture checkpoints before refreshing PR status (#10347)`
- `bccad2704` `fix(web): keep manual panel choices during a turn (#10113)`
- `e63ddb48e` `fix(threads): keep completed requests closed across clients (#10123)`
- `e4e9fa9a0` `perf(server): finish runtime messages without full thread reads (#10120)`
- `5fa35d211` `refactor(server): let adapters declare context compaction (#10112)`
- `223ff4490` `fix(server): link thread PRs without an open client (#10101)`
- `72cb638a8` `fix(web): show Tux icon for WSL environments (#8511)`
- `64fafbdfc` `perf(web): speed up folder menu sorting (#10190)`
- `29d03ec55` `style(web): fix inconsistencies in new settings layouts (#10177)`
- `2d645df47` `feat(threads): persist manual active thread order (#9729)`
- `6766e682a` `feat(mobile): arrange active threads from both thread lists (#9730)`
- `4023d93bc` `feat(web): drag threads across sections with consistent motion (#9731)`
- `9a47c7bd4` `feat(web): simplify sidebar drag destination cues (#9750)`
- `36c48a6b7` `fix(mobile): keep pending tasks queued when a send fails in flight (#10245)`
- `c0bf35466` `feat(mobile): show new-task drafts alongside pending tasks in the thread list (#10260)`
- `8e129a0df` `feat(mobile): allow several new-task drafts per project (#10327)`
- `98469159d` `fix(mobile): slide settled threads out before collapsing (#10345)`
- `95d99373b` `fix(clients): show feedback results in composer banners (#10398)`
- `c2c4185e1` `fix(web): onboarding installs agents without needing Node or npm (#10402)`
- `7ac93e300` `fix(server): allow settling threads with unanswered async questions (#10400)`
- `001f06d54` `feat(ci): ship stable releases from the latest nightly commit (#10410)`
- `075a86e3b` `feat(marketing): add a nightly channel to the download page (#10408)`
- `2d6a37999` `fix(web): only show auto balance errors after failed checks (#10407)`
- `3941c2a1d` `fix(web): improve preview recording frame delivery (#10403)`
- `3cd2cbbc1` `Modify model and budget settings in ui-consistency.md`
- `f5a1ec5e2` `Update model and effort in effect-service-conventions`
- `003289265` `Fix duplicate maxBudgetPerRun entry in UI consistency`
- `d57bdf384` `Fix formatting of maxBudgetPerPR in conventions file`
- `45387700b` `fix(web): keep settings section headings description-free (#10415)`
- `0a89364f1` `fix(usage): read and redeem hub reset credits through CLIProxyAPI (#10395)`
- `79394154d` `fix(web): deduplicate expanded tool labels and keep errors expandable (#10420)`
- `86070cbc7` `fix(server): skip git status scans while the index is locked (#9845)`
- `29c5ecd0e` `fix(mcp): allow text-only preview snapshots (#10232)`
- `66a24d6c1` `feat(mobile): queue a message while its attachment is still uploading (#10404)`
- `d6aa179ad` `feat(mobile): show when an existing thread has a message waiting in the outbox (#10405)`
- `d3d4ea42e` `fix(server): skip disabled settlement lookups (#10424)`
- `9ab0635db` `fix(server): run OpenCode CLI commands sequentially (#10427)`
- `5b0c923ea` `feat(web): name the drop action while dragging sidebar threads (#10378)`
- `252df7742` `perf(web): keep the sidebar responsive during bulk thread updates (#10413)`
- `ec36176e4` `fix(web): onboarding wizard now supports light mode (#10432)`
- `7112697e8` `feat(threads): dismiss async questions without replying (#10431)`
- `a12589dc0` `fix(web): stop collapsing the composer when it loses focus (#10437)`
- `1abc717f0` `fix(server): keep interrupted threads resumable after restarts (#10421)`
- `efeac1442` `fix(web): show load balancing note for a single machine (#10433)`
- `1e740e48a` `fix(server): follow placeholder branches after checkout updates (#10441)`
- `8c9a49afb` `fix(mobile): expand single-line tool details in work logs (#10442)`
- `95f9b14f8` `fix(server): import transcripts with oversized tool records (#10430)`
- `0860cea0c` `fix(marketing): deploy site with nightly releases (#10443)`
- `a07715c09` `fix(web): preserve multiline composer drafts during timeline scrolling (#10444)`
- `da976cf29` `fix(marketing): restore continuous endorsement scrolling (#10450)`
- `bd280de80` `Revert "fix(marketing): restore continuous endorsement scrolling" (#10454)`
- `b22646c31` `fix(marketing): bring back the endorsement marquee (#10455)`
- `de28fa1ff` `chore: enable CodeRabbit automatic reviews (#10457)`
- `1c1d38fcd` `fix(codex): keep Spark limits from replacing the main allowance (#10458)`
- `7e03dcfe5` `fix(marketing): send 95 nightly downloads to the downloads page (#10460)`
- `ecf3716fd` `fix(web): composer regains focus when you tab back into T3 Code (#10463)`
- `4e969f373` `fix(web): keep sidebar drag dividers clear and gestures smooth (#10453)`
- `f5fb056d2` `fix(web): clear stuck panel resize cursor (#10461)`
- `490eb17d3` `fix(web): clarify sidebar drag dividers and empty targets (#10464)`
- `f729e8fd8` `fix(web): make onboarding a shared multi-computer wizard (#10465)`
- `6abdf37a5` `fix(shared): redeem reset credits through the hub when it holds the account (#10462)`
- `e1230d603` `fix(mobile): keep pending messages in the chat timeline (#10449)`
- `bb5748bfa` `fix(mobile): show connection status in the floating pill instead of a second one (#10440)`
- `a7028f139` `fix: use Pierre icons consistently for attachments (#10475)`

### 2026-09-07

- `ea646c083` `fix(server): stop Windows terminal polling from spiking CPU (#9476)`
- `9c96ac258` `fix(web): keep settings inputs focused during IME composition (#10262)`
- `f1a08116f` `fix(server): preserve Codex reset credits during usage updates (#10308)`
- `e15ffb9c0` `docs: link the repository security reporting policy (#10303)`
- `ac4f1a2b6` `fix(server): preserve inline provider secrets on redacted saves (#10054)`
- `210899643` `fix(web, mobile): replace Apple desktop machine labels (#10396)`
- `7e8ae6b8d` `fix(web): hide browser when the right panel starts closing (#10385)`
- `3d00cfd5a` `fix(claude): name the expired login or usage limit instead of a generic API error (#10321)`
- `95139254b` `fix(codex): accept misalignment policy errors on thread resume (#10373)`
- `52b2bf77a` `fix(server): handle JSON-wrapped titles and verbose Claude output (#10446)`
- `6134b90ff` `fix(server): mark Cursor transport error answers as failed (#10337)`
- `08c715ed9` `chore(release): prepare v0.0.39`
- `5b68b2c8e` `feat(mobile): open the thread screen as soon as a new task is submitted (#10435)`
- `7376536b2` `fix(devcontainer): make repository setup work (#7875)`
- `d8bc6831c` `fix(projects): prevent invalid script IDs from crashing threads (#10019)`
- `bc3dc2694` `fix(mobile): hide changed-files navigator and restore refresh in raw diff fallback (#9828)`
- `e3b644c5a` `fix(ios): scroll short source files from blank space (#10178)`
- `7dda0b1c0` `feat(mobile): start a new thread on an existing branch (#10359)`
- `062987b2f` `fix(mobile): improve font-size slider performance and prevent maximum update depth errors (#7138)`
- `b919d6389` `fix(web): keep composer toolbar controls anchored during transitions (#10478)`
- `f57d3832c` `fix(web): resize the floating preview from any edge (#10467)`
- `71297974c` `fix(mobile): prevent chat from disappearing when scrolling (#10479)`
- `b248f5ad5` `fix(mobile): smooth composer status pill resizing (#10484)`
- `c0d4e95c0` `fix(mobile): release initial scroll target after dragging (#10483)`
- `e32dd42f8` `fix(mobile): animate thread lifecycle transitions consistently (#10487)`
- `b7175371d` `fix(mobile): restore assistant message bottom padding (#10491)`
- `dc39615ae` `fix(mobile): preserve chat rows when toggling commands (#10492)`
- `8b2838e0e` `feat(web): group onboarding project import by repository (#10493)`
- `fe07ffe7c` `fix(web): remove inserted citations on cancel (#10518)`
- `357b8d521` `fix(mobile): match Working status color to desktop`
- `8d7f78121` `fix(mobile): wait for native thread scroll before reveal (#10486)`
- `1d1bf5040` `chore(mobile): bump app version to 1.1.0`
- `62fbbe08a` `fix(web): tolerate servers that predate git identity in project import (#10547)`
- `72d94087b` `fix(web): restore settled PR colors on hover (#10023)`
- `9cc983954` `fix(web): keep popup triggers steady when pressed (#10468)`
- `3bf74eb6d` `fix(claude): report usage limits on retried turns (#10549)`
- `5b8a69c7b` `refactor(desktop): classify backend exports (#10265)`
- `5a853a4b4` `refactor(desktop): classify electron exports (#10266)`
- `89dd9ab32` `refactor(desktop): classify app exports (#10267)`
- `e279e402c` `refactor(desktop): classify preview exports (#10268)`
- `b491e41da` `ci(knip): enforce desktop exports (#10269)`
- `577b6cc22` `fix(web): remove excess sidebar thread spacing (#10569)`
- `c8ec7df12` `fix(web): make settings project scopes searchable and scrollable (#10570)`
- `12f560444` `fix(web): correct pending question attachment message (#10599)`
- `c0cad74bf` `fix(mobile): restore brand artwork in the Android adaptive icon (#10598)`
- `dadba6d95` `fix(web): remember Composer Fast mode across new chats (#2981)`
- `09e8de9c6` `Add stop thread keybinding command (#4308)`
- `ea2983afb` `fix(web): copy selected pull request link from PR page (#10615)`
- `569a8cd2c` `fix(web): play pull request videos inline (#10617)`
- `e0e0bcb11` `fix(desktop): preserve browser editing shortcuts (#10621)`
- `d081ab7ab` `fix(web): open pull request markdown links in the panel (#10623)`
- `892de47f0` `fix(mobile): fit the Android splash icon to its circular mask (#10620)`
- `8588d7f63` `fix(web): open proactive panels when entering threads (#10610)`
- `9fe4d6568` `fix(native): wait for the KDE feedback test listener (#10645)`
- `a01b227d6` `fix(desktop): resolve local media linked from remote threads (#10619)`
- `b7c002f91` `fix(web): add bottom padding to project actions header (#10634)`
- `f0bd43eaf` `Add 'macroscope-review' label to conventions`
- `5a18fb95e` `Add 'macroscope-review' label to UI consistency`
- `a37c66406` `chore: upgrade to TypeScript 7.0.2 (#10663)`
- `6ba15c027` `fix: hide email-bearing account labels in usage limits (#10668)`
- `bd56e920b` `chore(deps): upgrade Effect to rc.112 and Alchemy to beta.76 (#10652)`
- `458f50298` `chore(refs): sync Effect reference to rc.112 (#10653)`
- `9d345fa95` `chore(refs): sync Alchemy reference to beta.76 (#10654)`
- `b5f7fa0ed` `fix(desktop): enable context menus in the browser (#10670)`
- `bc88fdf6a` `fix(desktop): stop generating declarations during bundling (#10679)`
- `349ce3014` `fix(desktop): restore layout control hit targets (#10673)`

### 2026-09-08

- `0d34579d6` `fix(web): keep project favicon shape consistent across sizes (#10502)`
- `5ec6f77ec` `fix(web): use `tabular-nums` with the ui font for sidebar timer (#10592)`
- `02443335b` `fix(mobile): configure iOS Keychain access group (#3665)`
- `95834d68a` `fix(server): disable executable capabilities in Claude metadata generation (#4169)`
- `2c8e95a4b` `fix(mobile): show the provider account badge on thread rows (#9899)`
- `d64335bb5` `fix(codex): name the usage limit and its reset instead of relaying "out of credits" (#10473)`
- `d67157a09` `fix(web): keep ref picker steady when opening (#9472)`
- `8de9169f0` `chore(release): prepare v0.0.40`
- `299404a75` `feat(desktop): add cross-platform window capture (#8103)`
- `15193df9f` `fix(web): update machines together in auto balance (#10596)`
- `9e37f0c29` `fix(preview): transfer recordings to the agent environment (#10572)`
- `6df0add6e` `fix(web): navigate markdown images as galleries (#10625)`
- `50a76cee7` `fix(web): keep scroll-to-end button close to composer (#10543)`
- `bc4b00666` `fix: generate thread titles with the selected model across connections (#10526)`
- `7220dfe2c` `feat(chat): attach files to question answers (#9871)`
- `991526383` `feat(desktop): refresh macOS installer with aurora artwork (#10632)`
- `430fbd1ff` `fix(server): give completed turns a full session idle window (#10689)`
- `7d9aaf6a7` `feat(web): add pull request merge defaults (#8088)`
- `1f14d6d10` `fix(usage): keep account columns aligned across limit rows (#10690)`
- `11601da84` `fix(web): chat text no longer shows through a 1px gap under composer banners (#10635)`
- `6f4cd07b9` `refactor(server): classify runtime exports (#10274)`
- `0af04f180` `refactor(server): classify orchestration exports (#10275)`
- `161715b1e` `refactor(server): classify service exports (#10276)`
- `77d9ffc82` `refactor(server): classify telemetry exports (#10277)`
- `060c576f8` `refactor(server): classify provider exports (#10278)`
- `3b6ce931c` `refactor(server): classify source control exports (#10279)`
- `7cdeb696e` `refactor(server): classify source control registry API (#10280)`
- `1f0a14cf7` `refactor(server): classify preview toolkit exports (#10281)`
- `b28471567` `chore(mobile): bump app version to 1.1.1`
- `7d620506a` `ci(knip): enforce server exports (#10282)`
- `134b7194b` `feat(web): add previous/next turn navigation in minimap (#8531)`
- `d6dbe8dd6` `fix(web): stop the settings sidebar shifting when switching pages (#10705)`
- `83b865fec` `fix(web): copy terminal selection with Ctrl+Insert (#8541)`
- `82451eeb7` `fix(web): show the same project icon in the command palette as everywhere else (#10712)`
- `d7a59c63c` `fix(web): stop sidebar rows flashing and shifting on click (#10713)`
- `eb1150636` `refactor(web): pass the project record to ProjectFavicon so icons cannot drift (#10714)`
- `bde39d4d7` `feat(web): accept file drops into sidebar threads (#7892)`
- `b5d89038a` `feat(web): accept file drops into sidebar threads (#7892)`
- `061543e9e` `fix(mcp): keep preview snapshots usable by the agent and let it save them (#10501)`
- `47eed9fac` `fix(server): stop Windows terminal processes when closing (#10771)`
- `579266caa` `feat(mobile): use Android wallpaper colors (#10691)`
- `4664c572a` `feat(mobile): add optional Material You layout (#10692)`
- `12391bd0d` `feat(web): show project favicon in new-thread project picker (#10790)`
- `5d14c0e96` `fix(desktop): use official logo in macOS installer (#10819)`
- `0fe4c99ee` `fix(desktop): neutral artwork for stable macOS installer (#10820)`
- `5e6cc2b89` `fix(web): restore text-only draft project title (#10821)`
- `3faeee49a` `refactor(web): consolidate setup wizards into shared components (#10832)`
- `de545c417` `fix(web): stop the bar under the composer popping in after threads load (#10727)`
- `7fbc545ae` `fix(web): keep the composer footer still while thread data loads (#10768)`
- `20e2e899e` `fix(desktop): defer keyring loading until macOS cookie import (#10667)`
- `fdf34c401` `fix(relay): share notification policy and prioritize waiting agents (#10848)`
- `3dfc134e6` `fix(relay): recheck queued iOS alerts and retain fast completions (#10849)`
- `9d6c43f32` `fix(mobile): respect notification permission when tokens rotate (#10850)`
- `3e6f856f2` `fix(mobile): tolerate native Headers without getSetCookie (#10851)`
- `1862686f9` `fix(relay): use current APNs registration routing for queued jobs (#10859)`
- `08463e2c4` `fix(server): release consumed event replay pages (#10777)`
- `2a3035353` `feat(mobile): arrange threads with drag handles (#10496)`

### 2026-09-09

- `772ea1473` `fix(web): honor terminal link browser overrides (#10060)`
- `6c583620f` `feat(mobile): add Android agent notifications and ongoing activity (#10416)`
- `a29a7cc58` `fix(mobile): blur glass fallbacks to prevent background text bleed (#10964)`
- `e16b8b059` `feat(web): add provider model bulk toggle (#10947)`
- `50f918c57` `fix(web): allow expanding duplicate tool call commands (#10981)`
- `75e4ceb96` `fix(mobile): prevent Android chat rows overlapping during sync (#10983)`
- `383cc40f4` `fix(mobile): prevent text leaking through Android glass (#10998)`
- `afb84898b` `feat(pull-requests): link multiple pull requests to threads (#10839)`
- `f0401c629` `feat(search): find threads by linked pull request (#10870)`
- `de37964db` `feat(prs): navigate, merge and rebase GitHub stacks (#10875)`
- `33242d016` `fix(server): preserve recent PR reads across server restarts (#11007)`
- `8d8189e67` `feat(web): zoom and pan expanded images (#10869)`
- `b7b3ef1e6` `fix(ui): use available space for composer model names (#11002)`
- `addfb1390` `fix(web): restore pr list diff counts to the top right (#10609)`
- `385cc0a4c` `fix(web): show message copy buttons on touch devices (#11020)`
- `d1eeb1624` `fix(web): middle-click pastes in the terminal on Linux (#11018)`
- `0f602b337` `fix(editors): open remote projects in Zed (#11022)`

### 2026-09-10

- `bb5e824c9` `feat: add blue and orange diff color palette (#10671)`
- `d29c56a5c` `fix(server): resolve project identity before legacy pr relinks (#11045)`
- `444fd8bad` `fix(mobile): keep Android markdown icons aligned with text (#11079)`
- `3836890e4` `Revert "fix(mobile): keep Android markdown icons aligned with text" (#11098)`
- `e784975bb` `fix(ui): simplify multiple linked pull request badges (#11104)`
- `0882431e0` `fix(preview): return to pip when closing the right panel (#11102)`
- `0527ddf06` `fix: quiet settled threads and simplify PR badges (#11101)`
- `f814983c2` `fix(web): emphasize primary pull request actions (#11105)`
- `21d744039` `fix(web): fit provider update text inside sidebar notices (#11034)`
- `60eff99f2` `fix(web): save PR body edits with Cmd/Ctrl+Enter (#10660)`
- `502131adf` `fix(web): collapse a tool call by clicking its expanded label (#11017)`
- `dca7b59be` `feat(devices): add simulator and emulator support (#10677)`
- `e022fa430` `feat(devices): scope targets and sessions to their hosts (#10854)`
- `7734c6d71` `feat(devices): target concurrent agent sessions across hosts (#10855)`
- `d2eeacd8c` `feat(devices): connect simulator hosts over SSH (#10856)`
- `dfa345b36` `feat(web): use a compact right-panel surface menu (#11111)`
- `47dbb06c3` `fix(mobile): add close controls to tablet files and terminal (#11115)`
- `96f43708a` `fix(mobile): preserve the final composer animation frame (#11114)`
- `859304b78` `fix(mobile): keep composer transitions aligned (#11127)`
- `1a9336bcd` `refactor(mobile): name shared markdown renderer without iOS suffixes (#11128)`
- `a5ac76659` `fix(media): preserve playback during fullscreen transitions (#11113)`
- `39ca4171e` `fix(marketing): redirect /app to app.t3.codes (#11145)`
- `2afa02a28` `chore(marketing): update to 300k users and 22k stars (#11146)`
- `6a2d24666` `fix(pr): update labels and reviewers without redundant reloads (#11117)`
- `27eb79dc7` `fix(chat): fold question answers into tool activity (#11014)`
- `48654c118` `fix(usage): flag unpriced model activity instead of showing $0.00 (#11021)`
- `5735693d4` `fix(server): let Claude launch args override the derived permission mode (#11026)`
- `20ef25037` `fix(editors): accept root paths and Windows servers in Zed remote links (#11044)`
- `4d06156dd` `fix(web): center pull request unavailable states (#11110)`
- `8fc253605` `perf(web): format minimap previews only when opened (#11181)`
- `a9dabbf10` `perf(web): reuse completed Markdown prefixes while streaming (#11193)`
- `d7d7f8f3e` `perf(web): resume syntax highlighting from completed lines (#11196)`
- `8078c532c` `perf(web): preserve completed code-line DOM while streaming (#11198)`
- `211618fd9` `perf(web): huge-thread switch no longer blanks the chat pane (#11169)`

### 2026-09-11

- `21a5ccf88` `fix(web): prevent seams in the topbar scroll fade (#10914)`
- `3997b9a3a` `fix(web): align floating browser preview corners (#10915)`
- `32b690934` `fix(mobile): keep Android markdown icons aligned (#11118)`
- `c52b8d96e` `feat(command-palette): show environments in search results (#10722)`
- `0a37240a8` `fix(web): remove sidebar pull request link icon (#11179)`
- `02297e3db` `fix(ui): color linked pr counts by aggregate status (#11180)`
- `6c69534a5` `fix(preview): render website favicons for browser tool activity (#11032)`
- `18c5a1d2d` `fix(web): simplify pull request summary sections (#10612)`
- `ef6fa1187` `fix(web): preserve drafts when compacting context (#11103)`
- `57aee3e19` `fix(server): queue messages during context compaction (#11107)`
- `fb3d165d3` `fix(web): show platform file manager icons in Open menu (#11228)`
- `26894dda7` `fix(server): detect file renames in review diffs (#8086)`
- `5eecc24a1` `fix(cli): pin shared Effect dependency for npm installs (#11240)`
- `2ebc9fa4e` `fix(mobile): prevent Hermes crashes when opening threads (#11233)`
- `05d404210` `feat(web): open Usage on the Limits tab by default (#11261)`
- `2b7d3a45e` `perf(web): avoid scanning chat history for sidebar backgrounds (#11206)`
- `7bd7f99e6` `perf(mobile): reuse completed code lines while streaming (#11211)`
- `6e8931d75` `perf(client): reduce remote request and message sync overhead (#11029)`
- `e1c94f703` `fix(web): refresh usage limit countdowns without switching tabs (#11187)`
- `fb52d125b` `fix(client-runtime): typecheck device hub ticket request on main (#11304)`
- `2c0e89174` `feat(settings): add per-project overrides for scopable server settings (#11176)`
- `8b2c0465d` `feat(web): pick settings environment and project as two selects (#10636)`
- `e22040dfc` `feat(settings): edit any scopable setting as a project override (#10639)`
- `8bbe2bf66` `feat(web): float device streams over chat (#11285)`
- `18f7254e0` `fix(web): floating preview can use the margins beside the composer (#11290)`
- `0eaa18c12` `feat(web): show recording status on floating previews (#11312)`
- `095d57552` `fix(desktop): hold-to-quit no longer strands the quit (#11016)`
- `4a8ab1b72` `feat(web): mark projects on another machine in project pickers (#11323)`
- `867eb9bff` `fix(web): themed panel toggles show their disabled state (#11188)`
- `cd64ad384` `fix(mobile): keep Android file icons on the line with wrapped filenames (#11234)`
- `a92161a05` `fix(codex): preserve qualified model ids in selection and generation (#9921)`
- `36668dbe4` `feat(desktop): share macOS permission onboarding (#11289)`
- `8a2d5f545` `fix(test): drain worker broadcasts before restoring browser globals (#11349)`
- `8461c25ff` `fix(web): disable linked pull requests when none are linked (#11348)`
- `1f73a89fc` `fix(models): default to astra medium and fable 5.1 medium (#11347)`
- `4d16e6bc6` `fix(web): align provider settings with shared settings rows (#10571)`
- `cf1ba3d7d` `feat(settings): configure default permissions for new threads (#11346)`
- `fd5553f1a` `fix: restore provider history and prompts when rewinding (#11338)`
- `25da98603` `fix(web): keep comment actions visible when pr comments are folded (#11357)`
- `4a4c6dd2a` `feat(settings): add open source license notices (#8962)`

### 2026-09-12

- `e145c5f22` `perf(client-runtime): speed up message sync on desktop and mobile (#11302)`
- `15c6167bc` `fix(web): use the configured panel shortcut on the PR page (#11292)`
- `b3ed07fb3` `feat(web): add PR page selections to new draft threads (#11296)`
- `871192933` `fix(web): show pointer cursors on pull request controls (#11283)`
- `50791a053` `fix(web): use branch wording in commit dialogs (#11281)`
- `efccda9ac` `feat: rewind conversations while keeping file changes (#11358)`
- `38827789c` `fix(web): keep sidebar scroll position when pinning threads (#10757)`
- `8eec78cf8` `fix(web): remove pr description reactions (#11361)`
- `e81606494` `fix(desktop): keep preview keystrokes out of the composer (#11354)`
- `ca6416ec2` `perf(client): reduce repeated sorting and date formatting (#11019)`
- `4fed6cfb3` `feat: add inline file previews and attachment chips across surfaces (#11265)`
- `57b23a09f` `fix(desktop): preserve long offscreen text in SnapShots (#11250)`
- `b1e223e2b` `perf(server): avoid workspace scans when loading pull requests (#11299)`
- `d1d15c67f` `feat(sidebar): fold the project scope into the search row (#11315)`
- `18d8cbfd9` `fix(mobile): pin expo-audio so the release smoke patch stays in use (#11426)`
- `534952210` `Delete .pnpm-store/v11 directory`
- `a43f9b45a` `fix(web): preserve snapshot preview size in sent messages (#11429)`
- `bbedad027` `fix(mobile): render photo library picks to a bounded JPEG off the JS thread (#11440)`
- `348645152` `fix(chat): keep user input outside collapsed work (#11363)`
- `cfeaca41a` `fix(web): preserve preview focus on window return (#11444)`
- `03e135577` `fix(web): complete thread status icons and keep input threads prominent (#11461)`
- `75d8b132c` `feat(web): tint image chips with their average color (#11468)`
- `c1ff6ab3d` `fix(web): move viewer controls outside media and restore arrow navigation (#11470)`
- `b0c6c3b2f` `fix(web): tighten sidebar search and footer spacing (#11466)`
- `c0ddfb3a8` `feat(web): subagent spawns render as an expandable work row (#11433)`
- `af2baccd1` `fix(web): keep subagent rows visible under folded turns (#11474)`
- `fcbe45796` `fix(usage): make unavailable account limits more visible (#10601)`
- `8ddd9f7ef` `fix(desktop): bound backend shutdown wait during quit (#7599)`
- `36caf200c` `feat(web): choose the default diff file state (#11484)`
- `2db675aef` `fix(usage): respect provider account homes (#11485)`
- `2587c8060` `feat(web): switch saved environments off instead of removing them (#11478)`
- `5781e2be2` `fix(mobile): stop crashing on launch when a thread has a PR stack (#11486)`
- `af0657e3b` `fix(mobile): stop alerting that shared content vanished after sending it (#11487)`
- `0e0ddaeed` `feat(web): add opt-in thread notifications and sounds (#11481)`
- `c29976458` `fix(server): open Cursor links in classic IDE mode (#11498)`
- `0c5771d60` `fix(web): match draft row heights to thread rows (#11512)`
- `3138f5716` `fix(grok): emit task lifecycle for monitors and background shells (#9139)`
- `8b3ddf51c` `fix(mobile): stop crashing on launch before the shell snapshot arrives (#11537)`
- `20a8f1de3` `chore(mobile): enable noUncheckedIndexedAccess and noImplicitOverride (#11538)`
- `0a91b9a11` `feat(mobile): show startup crashes in Settings → Diagnostics (#11540)`

### 2026-09-13

- `c542b781c` `fix(desktop): keep the native preview User-Agent so Turnstile passes (#7110)`
- `68c2277f5` `feat(composer): fold large pastes into text attachments (#11442)`
- `6cdbf76fa` `feat(web): expose each chat message as a heading for screen readers (#11199)`
- `6fd68f5c3` `feat(source-control): support Forgejo and Gitea with fj and tea (#11436)`
- `46140c96a` `fix(web): unify panel resizing and retain final drag width (#11529)`
- `2ec59ca1f` `fix(web): hide back button for single linked pull requests (#11520)`
- `21d53ca2e` `fix(files): browse ignored files and load folders on demand (#11527)`
- `d7c71f91d` `feat(web): float the pull request comment composer (#11531)`
- `db6e0531e` `feat(github): route pull request operations across matching accounts (#11367)`
- `17f8e2a8a` `feat(mobile): add pooled subscription usage widgets (#11506)`
- `20363c32c` `feat(web): add provider selector to pull request toolbar (#11524)`
- `4a39cade9` `fix(web): offer recovery from missing pages (#11314)`
- `e62868393` `fix(web): retry startup after the server recovers (#11291)`
- `ca2cc1339` `feat(web): add optional compact sidebar rail (#11525)`
- `42b6bcc6f` `feat(web): add opt-in in-app thread notifications (#11570)`
- `f26198d79` `feat(web): organize connections by environment (#11542)`
- `0118b5229` `fix(web): keep sparse sidebar shelves at the bottom (#11595)`
- `9bf349cf6` `fix(cursor): preserve internal agent errors without transport labels (#11365)`
- `dd6ba84dc` `fix(server): fall back when new worktrees are unavailable (#6208)`
- `6e5e986f1` `feat: badge background thread notifications on desktop and web (#11569)`
- `df7ccc8fd` `feat(web): refine compact thread row badges (#11644)`
- `7b6109988` `feat(web): show the linked pull request in the compact sidebar rail (#11652)`
- `9086a1f71` `fix(mobile): adopt system glass for Live Activities (#11604)`
- `3689c98d2` `fix(web): separate expanded tool output from adjacent hover highlights (#11658)`
- `66e39ca2a` `fix(web): apply device settings to selected environments (#11541)`
- `c07575f57` `feat(server): show finished paragraphs and code blocks while the response streams (#11062)`
- `2d7374650` `fix(web): disconnect offline servers from threads (#11671)`
- `5e961d3d7` `feat(web): flatten the connections page into one environments list (#11672)`
- `564719165` `fix(mobile): keep usage widget rows consistently sized (#11669)`
- `3b75e607e` `feat(server): add reusable auth token for dev worktrees (#8606)`
- `1bbca0e78` `feat(settings): choose how responses stream, with a warning on legacy token mode (#11678)`
- `683aa8709` `build(desktop): bundle the main process and stage only its native externals (#11410)`
- `06de59b3d` `build(server): make the CLI bundle loadable as a Node single-executable (#11316)`
- `eb8f6f42a` `ci(release): build, sign, and publish self-contained CLI archives (#11317)`
- `8f90b380f` `feat(server): install preview runtimes from release archives (#11318)`
- `13c134c10` `feat(ssh): run preview builds on remotes from the release archive (#11319)`
- `c7f23c466` `feat(cli): add t3 update for self-contained installs (#11451)`
- `af6c138a0` `feat(server): manage runtimes as release archives only, never from npm (#11510)`
- `07549200d` `feat(desktop): run the WSL backend from the Linux CLI archive (#11511)`
- `2c54f2ff1` `ci(release): build CLI archives for five targets, each on its own architecture (#11605)`
- `2f7616ef1` `ci(release): build the JS bundle once and run every platform and architecture in parallel (#11606)`
- `91cd91c08` `feat(release): publish npx t3 as a launcher over per-platform executable packages (#11607)`
- `b70015b6d` `feat(cli): add t3 uninstall for self-contained installs (#11659)`
- `73b206f4b` `feat(web): show each worktree setup step and let users cancel it (#11372)`
- `1ced38a66` `fix(server): skip device hosts that resolve to the local machine (#11698)`
- `8984f8103` `fix(web): test device hosts across selected environments (#11699)`
- `0b54e00f9` `Change input type from 'full_diff' to 'incremental'`
- `e3792a53f` `Update model and input type in ui-consistency.md`
- `cba7dd778` `feat(desktop): allow disabling the local environment (#9194)`
- `d8655ed2f` `feat(cli): add t3 service restart and make t3 update repoint the service eagerly (#11702)`

### 2026-09-14

- `77bca8b2d` `feat(web): add compact thread list mode (#9417)`
- `d81278aa6` `revert(web): remove the compact sidebar (#11685)`
- `01e05c152` `docs(claude): clarify OpenRouter model selection (#11369)`
- `0dec07d91` `fix(web): keep large image previews from stalling composer typing (#11324)`
- `8ef478eb0` `fix(server): avoid extra round trips for terminal output (#11407)`
- `6f00d3881` `fix(web): remember panel width for each thread (#11310)`
- `9375c7797` `fix(release): preserve updates from npm-based services (#11732)`
- `8b1ea4dd2` `fix(desktop): restore Node discovery for WSL providers (#11741)`
- `ae67c5b81` `fix(release): stop npm from pruning the platform packages' shipped node_modules (#11750)`
- `955b787e6` `fix(server): parse CLI versions with a "v" prefix (#11738)`
- `05e3bcbc6` `fix(desktop): keep preview releases out of the nightly update changelog (#11753)`
- `ec5ede5e6` `fix(web): open video attachment thumbnails in the viewer (#11734)`
- `494cfac24` `Allow setting T3CODE_OTLP_HEADERS (#11218)`
- `47ace9496` `fix(web): use consistent PR section toggles (#11763)`
- `33118d9ab` `Add T3CODE_OTLP_PROTOCOL to allow protobuf protocol (#11224)`
- `9130d932f` `feat(web): add composer and PR number shortcuts (#11615)`
- `f328db30d` `chore(server): keep the legacy service entry point to the npm package only (#11770)`
- `112a7088d` `fix(web): use project monograms for automatic icon fallbacks (#11572)`
- `8d7c700c1` `feat(web): clone repositories in the background instead of holding the palette open (#11762)`
- `549d182aa` `feat(mobile): clone repositories in the background and gate the draft on the clone (#11774)`
- `9d4bb550a` `fix(mobile): scale inline pills with Dynamic Type (#11792)`
- `bcc20249c` `chore(deps): bump the Clerk stack to current releases (#11764)`
- `0f21fcbb6` `feat(mobile): add a T3 Connect page to the Clerk profile (#11765)`
- `dc0869b60` `feat(server): use Clerk's device authorization grant for headless connect login (#11794)`
- `84192388b` `Add new GitHub user f-trycua`
- `793122797` `fix(server): stop refreshing providers on every config subscription (#11811)`
- `5bf43c9f3` `fix(web): align monogram project icons in menus (#11806)`
- `9a49d6d5a` `ci(desktop): sign fork PR macOS previews without exposing signing secrets (#11760)`
- `3be02ae57` `feat: add custom snooze dates and durations (#11800)`
- `ea6af5924` `feat(mobile): redesign the Android agent activity card (#11645)`
- `5ea643981` `feat(web): inline worktree setup rows and async setup scripts (#11832)`
- `b5b29e7b8` `fix(server): stream tight list items one at a time in paragraph mode (#11833)`
- `7cafe52bb` `fix(server): keep thread titles tied to user intent (#10720)`
- `e9b055588` `Remove labels from effect service conventions`
- `537dc0fe1` `Remove labels from ui-consistency.md`
- `970a8730e` `Change conclusion status from failure to neutral`
- `8b9f6d3d5` `Change conclusion from 'failure' to 'neutral'`
- `08abda9dc` `refactor(server): resolve title links through source control providers (#11844)`
- `a62e7d670` `refactor(server): align title generation with Effect conventions (#11847)`

### 2026-09-15

- `014016a62` `fix(web): make copy PR link discoverable in keybindings (#11826)`
- `6dbea7ed0` `chore(mobile): bump app version to 1.2.0`
