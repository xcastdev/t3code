# Upstream integration

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Record the
exact upstream commit here when updating the fork so the next integration has a
known starting point.

| Integration date | Previous upstream baseline                 | Updated upstream baseline                  | Fork before integration                    |
| ---------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 2026-10-27       | `e07595714a467e18c750107137d2c2e50f0c3530` | `36d4d711b79c73eb33131944f73ea4a8c6156484` | `890e89f2e7b92c5524b47278da37ffd8fefc01dc` |

The update is on `integration/upstream-2026-10-27`. It includes 615 upstream
commits since October 21, advancing the desktop and server package versions from
0.1.1 to 0.1.3. The updated upstream tip is
[`fix(server): bound hung delegated stop effects so later runs can start`](https://github.com/pingdotgg/t3code/commit/36d4d711b79c73eb33131944f73ea4a8c6156484).
The [upstream comparison](https://github.com/pingdotgg/t3code/compare/e07595714a467e18c750107137d2c2e50f0c3530...36d4d711b79c73eb33131944f73ea4a8c6156484)
contains the complete commit history.

## Included upstream changes

- The web redesign, settings modals and reorganized settings pages.
- Rich document and archive previews, inline audio, and SVG attachments.
- Guest thread sharing, indexed thread search, and expanded mobile navigation and PR controls.
- Smaller connection and thread payloads, fewer streaming renders, and Pierre highlighting.
- Vercel fx, consolidated MCP actions, smaller agent instructions, and delegation lifecycle fixes.
- Desktop startup recovery and release boot checks.

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

## Validation

Scoped typechecks pass for the server, web, mobile, desktop, contracts, shared
client runtime, GitHub source control, and all nine provider packages. The
production web build passes.

Focused tests cover provider instruction delivery, Work and assistant ownership,
memory and routines, resource menus, desktop attachment, navigation, migrations,
MCP registration, WebSocket handlers, and disposable upgrade fixtures. The
fixtures include HTTP/RPC and real Git/PTY execution. An independent integration
review found no actionable findings in the reviewed seams.

Resolved and repaired files pass formatting, lint, and whitespace checks. These
checks do not replace full CI or browser, Electron, native-device, and real-provider
verification. No installation switch, deployment, or live database write was
performed.
