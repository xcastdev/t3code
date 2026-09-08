# Scoped MCP catalogs

This document records the scope and lifetime rules for the MCP catalog. It is
also the durable evidence ledger for provider catalog refresh support.

## Scope and identity

The environment owns global MCP definitions. A project inherits those
definitions, can apply metadata or complete-transport overrides, and can add
project-local definitions. A logical catalog session captures the effective
global/project catalog when a provider session starts. Session overrides and
session-local definitions are applied to that captured baseline only.

Every entry has a stable logical server id and a definition id. The logical id
is the target for overrides. The definition id owns one complete transport and
its credentials. Replacing a transport therefore creates a new definition id;
metadata-only changes retain the inherited definition id.

Resolution order is global definitions, project overrides, project-local
definitions, session baseline, session overrides, and session-local definitions.
The result is then filtered by enabled state, provider assignment, and provider
capability before name-conflict and 50-entry-limit validation.

Global/project changes affect future logical sessions. An active logical
session changes only through a session mutation or **Reset to current defaults**.
The logical session id survives recoverable provider-process restarts while the
short-lived provider session id changes. Explicit stop, provider change, thread
deletion, and unrecoverable expiry dispose the logical session.

## Revisions and secrets

Each logical session tracks desired and applied revisions. Mutations increment
the desired revision; the runtime reactor records an applied or failed result.
An unreachable upstream does not make a saved revision fail because upstream
connections are lazy. Invocation reports the connection failure instead.

Snapshots retain complete transports and definition ids so old credentials can
be leased during recovery after a saved definition rotates. Secret values,
OAuth state, and upstream proxy details never enter events, projections, or
RPC responses. Explicit OAuth disconnect revokes the grant even when a retained
session snapshot still references the old definition.

## Gateway contract

The catalog gateway is one stable MCP endpoint for a live-capable provider. It
starts with an empty catalog, atomically swaps to each applied revision, and
publishes the corresponding MCP list-change notification. Clients do not need
to reconnect to observe additions, updates, or removals. Per-server proxy
endpoints remain the compatibility path for restart-required providers.

Names use the deterministic form `mcp_<logical-id-without-dashes>__<upstream-name>`.
Resource URIs use `t3-mcp://<logical-id>/<base64url(upstream-uri)>` and are
rewritten back to the owning upstream on read or completion. A provider whose
name restrictions reject this reversible mapping remains restart-required until
the mapping has an explicit design and tests.

## Provider refresh evidence

The gateway protocol fixture in
`apps/server/src/mcp/McpCatalogGateway.contract.test.ts` starts with no tools,
adds one tool, changes its description, and removes it while the same MCP
client connection remains open. This proves the notification/list contract,
not provider-specific refresh behavior.

As of 2026-09-08, no real provider integration case has been run in this
worktree. Therefore all managed adapters remain `restart-required` and external
OpenCode remains `unsupported` until a provider-specific test observes add,
update, and remove without a runtime restart. Provider versions and observed
behaviors must be appended here when those cases are run.

## Compatibility

The old `projectMcp.*` RPCs continue to expose only project-local definitions.
New clients gate global, project-override, and session RPCs independently on
the environment capability flags `globalMcpCatalog`, `projectMcpOverrides`, and
`sessionMcpCatalog`. Catalog subscriptions are opt-in and carry only scope id
and revision notices.
