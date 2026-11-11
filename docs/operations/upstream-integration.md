# Upstream integration

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Record the
exact upstream commit here when updating the fork so the next integration has a
known starting point.

| Integration date | Previous upstream baseline                 | Updated upstream baseline                  | Fork before integration                    |
| ---------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 2026-10-27       | `e07595714a467e18c750107137d2c2e50f0c3530` | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `890e89f2e7b92c5524b47278da37ffd8fefc01dc` |
| 2026-11-02       | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `47f2c8d29e981c7723467efe137ee19e91df924e` | `63e994493a87319bfd31bcd0c71d6bcfcd123ab7` |
| 2026-11-11       | `47f2c8d29e981c7723467efe137ee19e91df924e` | `7e565c510d6dfaef2e1fd97bf9d89a97ce9cece7` | `bec7f5fad7167ed8e897b3d91468779216a79123` |

The latest update is on `integration/upstream-2026-11-11`. It merges 1,076 upstream
commits since November 2, advancing the desktop and server package versions from
0.1.6 to 0.1.9. The updated upstream tip is
`fix(git): stop new threads inheriting historical branch PRs (#34218)`.
The [upstream comparison](https://github.com/pingdotgg/t3code/compare/47f2c8d29e981c7723467efe137ee19e91df924e...7e565c510d6dfaef2e1fd97bf9d89a97ce9cece7)
contains the complete commit history.

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
- Upstream migrations 078–081 and broad server, streaming and mobile performance work.

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

Two fork paths needed changes to stay correct on the merged runtime. Project Work run
admission read the database while holding the event publish lane, which deadlocked
under upstream's concurrent PR-watch sweep; the read now happens inside the commit
transaction. Commits wake the effect worker only when they enqueue work, as upstream
does.

These checks do not replace full CI or browser, Electron, native-device and
real-provider verification. No installation switch, deployment or live database write
was performed.
