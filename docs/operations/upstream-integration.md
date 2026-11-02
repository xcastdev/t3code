# Upstream integration

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Record the
exact upstream commit here when updating the fork so the next integration has a
known starting point.

| Integration date | Previous upstream baseline                 | Updated upstream baseline                  | Fork before integration                    |
| ---------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 2026-10-27       | `e07595714a467e18c750107137d2c2e50f0c3530` | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `890e89f2e7b92c5524b47278da37ffd8fefc01dc` |
| 2026-11-02       | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `47f2c8d29e981c7723467efe137ee19e91df924e` | `63e994493a87319bfd31bcd0c71d6bcfcd123ab7` |

The latest update is on `integration/upstream-2026-11-02`. It merges 1,091 upstream
commits since October 27, advancing the desktop and server package versions from
0.1.3 to 0.1.6. The updated upstream tip is
`fix(server): Claude threads no longer join the Claude session that launched T3 (#29169)`.
The [upstream comparison](https://github.com/pingdotgg/t3code/compare/36d4d711b79c73eb33131944f73ea4a8c6156484...47f2c8d29e981c7723467efe137ee19e91df924e)
contains the complete commit history.

## Included upstream changes

- Linked environments: agents delegate to, mention and work in another machine.
- Side chats beside the main thread, project pinning and archiving, and the
  "boring" sidebar with project folders and keyboard navigation.
- The composer redesign with one model-and-effort control, and Markdown source editing.
- One-off scheduled tasks, managed organization policy, and secret providers.
- Local commit review, maintainer edits, dev servers a thread started, and simulator leasing.
- Upstream migrations 070–077 and broad timeline, streaming and server performance work.

## Fork integration decisions

Work, teams, knowledge, guided approvals, guarded publication, assistants, private
memory, managed resources, shared project terminals, Home Assistant notifications,
and attachment to an independently owned desktop backend remain part of the fork.
Their clients use the updated upstream navigation and settings structure.

Managed provider instructions and catalog delivery remain available alongside
upstream's smaller default instructions. Upstream's GitHub driver and fork issue
intake share one credential and quota context. Feature migrations retain their
independent ledger alongside the updated upstream migrations.

The MCP context budget includes the retained fork tools. Compact advertised
schemas still validate inputs against each tool's full original codec.

Idle-compaction modes use upstream's `idleCompaction` field. The legacy
`compactIdleThreads` field remains compatible with shipped clients; fork settings
saved as explicit modes are still read.

Assistant chats keep their `"chat"` lineage relationship next to upstream's
`sideChat` flag; the two are separate features. The fork's right-panel Work tabs sit
beside upstream's side-chat tab, and the fork's timeline live steps, thoughts and
turn report sit on upstream's reworked timeline. Tool-call file diffs open in
upstream's diff panel.

`@modelcontextprotocol/sdk` is a fork-owned dependency of the server. Upstream never
imported it and removed it as unused; the fork's catalog gateway and connections to
users' own MCP servers need it. Effect's `effect/ai` provides an MCP server but no
client or OAuth, so the client side stays on the SDK.

Upstream deletions of code nothing reached upstream were taken unless a fork feature
used it. The fork restored only what it uses: `transformResultNames` on the shared
SQLite client (bounded-hydration tests) and the ACP mock's hang-after-replay switch.
The fork's project list query selects upstream's new pin and archive columns.

## Validation

Scoped typechecks report no errors for every workspace package, and the production
web build passes.

Focused tests cover the server's assistants, scheduled tasks, project work, MCP,
persistence and upgrade fixtures, peer links, WebSocket handlers, providers,
terminals, project setup, and the orchestration and adapter suites touched by the
merge; web chat, sidebar, assistants, Work, settings, right panel, connection and
environment suites; contracts, client runtime, GitHub source control, Cursor, and
the mobile workspace, Work and thread-agent tests.

Six Codex account tests in `CodexChatGptAuth.test.ts` and `CodexManagedRuntime.test.ts`
fail the same way on the fork before this merge. One upstream timeline browser test
fails only under heavy parallel load and passes in its own file.

Resolved and repaired files pass formatting, lint, and whitespace checks. These
checks do not replace full CI or browser, Electron, native-device, and real-provider
verification. No installation switch, deployment, or live database write was
performed.
