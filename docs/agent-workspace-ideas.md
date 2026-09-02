# Agent workspace direction

T3 Code should own durable workspace state. Providers should remain replaceable runtimes that access permitted workspace capabilities through MCP.

This direction avoids building a separate product for each provider. It also gives users one place to inspect, configure, and control the tools that agents use.

## Manage agent resources in one place

The app should manage these project resources through one catalog:

- MCP servers
- Skills
- Commands
- Agent definitions
- Text snippets

Each resource needs a scope, enablement state, provider compatibility, and an audit trail. MCP servers also need secure server-side storage for credentials and headers.

The MCP manager should show configured servers, connection state, enabled providers, and whether a change takes effect immediately or requires a new provider session. T3-managed MCPs, such as preview and terminal tools, should appear in the same view but remain protected from accidental removal.

## Keep project knowledge and tasks durable

Project knowledge includes notes, plans, and agent memory. Tracked tasks describe work that is planned, active, blocked, or complete.

The server should persist both as first-class records rather than leave agents to edit unstructured files. The UI can then show history and current state, while MCP tools let permitted agents search, read, create, and update the same records.

Possible tool groups include:

- `project_knowledge.search`, `project_knowledge.read`, and `project_knowledge.upsert`
- `tasks.list`, `tasks.create`, `tasks.update`, and `tasks.complete`

The task model should support a Jira-like workflow without requiring an external tracker.

## Expose T3 capabilities through MCP

T3 can expose its own controlled capabilities as MCP tools. The existing preview MCP is the first example.

A terminal toolkit can reuse the server's existing PTY manager. It needs tools to list, open, read, write, resize, and close terminals. Because MCP calls return one result, terminal output needs bounded buffering and read cursors instead of an unbounded stream.

Opening or writing to a terminal is a destructive operation. The server must enforce capability checks, require appropriate approval, and clean up terminals when the owning session ends.

## Treat provider support as a capability matrix

Provider configuration differs. T3 should report what each provider can do instead of presenting a common control that does not work everywhere.

- Codex can reload MCP configuration during an active session.
- Other providers may require a new session before changes apply.
- OpenCode MCP configuration is directory-scoped, not thread-scoped.
- Providers expose different subscription and API usage data, so usage monitoring must report unsupported or unavailable data honestly.

Provider status should cover authentication, quota or subscription usage when available, reset time when available, and recent configuration errors.

## Make history operations durable

Chat forks and "revert to here" must operate on durable thread and workspace state, not only hide messages in the UI.

A revert should restore the selected checkpoint, stop or archive later turns and active subagents, and preserve removed history as a recoverable branch or archive. A fork should retain enough parent context and checkpoint information to reproduce its starting point.

## Expand Git controls safely

T3 should offer the everyday source-control actions users expect from VS Code: tracked-file state, stage and unstage, diffs, commits, branches, and related status views.

These operations mutate the environment. They need clear remote-safe confirmations and must use the same authoritative Git services as provider and terminal workflows.

## Build in dependency order

The intended sequence is:

1. MCP management and the shared resource catalog.
2. Project knowledge and tracked tasks, with MCP access.
3. Skills, commands, agents, and snippets on the catalog.
4. Git workflow controls.
5. Durable chat forks and reverts.
6. Provider usage monitoring, provider by provider.
7. Per-subagent transcript, terminal, and interaction controls.

Subagent controls come last because current credentials and terminals are scoped to a thread. A real per-subagent experience needs separate identities, transcript routing, lifecycle rules, and authorization.
