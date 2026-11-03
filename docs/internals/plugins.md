# Trusted plugins

> For maintainers. Using T3 Code? See [docs/user/plugins.md](../user/plugins.md).

A plugin is a `.t3plugin` zip with a manifest, optional panel HTML, and an optional
single-file CommonJS backend. Contracts: [`plugins.ts`](../../packages/contracts/src/plugins.ts).
Manifest rules: [`pluginManifest.ts`](../../packages/shared/src/pluginManifest.ts). Host:
[`PluginService.ts`](../../apps/server/src/plugins/PluginService.ts) and
[`PluginWorkerSupervisor.ts`](../../apps/server/src/plugins/PluginWorkerSupervisor.ts). The
request inspector in [`packages/plugin-request-inspector`](../../packages/plugin-request-inspector)
is the reference plugin that exercises all of it.

## Trust model

Plugins are trusted code, not sandboxed code. A backend runs in a separate worker process, but
that gives crash isolation and a killable unit, not containment: it has the server user's files,
network, and credentials. The install prompt names the author and the machine for that reason.
Panel HTML is different: it runs in an opaque-origin sandboxed iframe and reaches the host only
through the bridge, so it gets the MCP app CSP (`injectMcpAppCsp` in
[`http.ts`](../../apps/server/src/http.ts)). Do not describe either as a security boundary
beyond that.

## Panels are not MCP Apps

MCP Apps are bound to a tool-result item and a live provider session
([`McpAppRequests.ts`](../../apps/server/src/mcpApps/McpAppRequests.ts), reason `session-stopped`).
A plugin panel must open with no chat and keep working after the agent stops, so it has its own
`plugin-panel` asset resource and its own bridge. Reuse MCP only where it fits: agent tools and
the CSP. Never fake a tool-result item to host a panel.

## Panel state and the page route

Chat's right panel is thread-keyed ([`rightPanelStore.ts`](../../apps/web/src/rightPanelStore.ts))
and only exists when a thread is open. Plugin panel state is keyed by `PluginPanelKey`
(scope, plugin, panel) in [`pluginPanelStore.ts`](../../apps/web/src/pluginPanelStore.ts), so it
survives thread switches; `rightPanelStore` only holds a derived `plugin` tab kind that is never
persisted. The standalone page route exists because a panel must open with no thread. Both
hosts render the same surface. The installed `version` is part of panel identity: the asset URL,
the frame key, and every UI-to-backend call (`expectedVersion`, failing with `version-changed`).
An update remounts open panels and keeps `state`, returned with the version that wrote it.

## Backend packaging

Installed packages sit under `stateDir/plugins/` with no `node_modules` and no install step, and
the release ships a Node SEA that resolves only builtins. So a backend must be one
builtins-only CommonJS file, loaded through `createRequire`, and packing fails on anything else.
Native code is an external prerequisite (the inspector needs `mitmdump` on PATH). Non-JS files
are embedded as text and materialized by the SDK to `dataDir/runtime/` at start, because
mitmproxy puts a script's directory on `sys.path` and that directory must hold nothing else. The
archive therefore holds only the manifest, panel HTML, and the backend entry. The worker starts
through `t3 plugin-worker`, so it runs on whichever runtime the server uses.

## Long-running mutations and replay

`invoke` times out at 30 s and cannot report whether a mutation finished. A mutation that can
run longer therefore enqueues, returns an id, and the caller reads the outcome. The inspector's
`replay_request` does this; `get_replay` reports `pending`, `completed`, `failed`, or `unknown`.

- Replay goes through mitmproxy's `replay.client`, not `fetch`: `fetch` follows redirects and
  decodes content encoding, which would change what is replayed.
- Dispatch intent is committed before handoff to mitmdump. A missing acknowledgement is not
  evidence that nothing was sent, so an interrupted replay is `unknown`, never "not sent".
- Idempotency keys are issued by `preview_replay`. History is bounded (1000 finished replays),
  so the store cannot remember caller-chosen keys forever. A stored floor makes expiry decidable
  from the key alone, with no clock: a key below the floor is `expired` and may have been sent.
- Keys carry an HMAC tag from a per-database secret, so a corrupted retry is refused instead of
  read as new. The tag guards exact retries only. It is not authorization, and asking for a new
  key is asking for a new replay.
- Storage maintenance (incremental vacuum, WAL checkpoint) runs between transactions under the
  one store lane, with automatic checkpoints off, so it never interleaves with a write. `maxDiskBytes`
  bounds captures, pending replays, and drafts by pruning old captures. It is not a hard cap: usage
  can briefly exceed it mid-write, and when only unprunable data is left, replays are refused.

Inspector refusals cross the host as `operation-failed` with stable detail text
([`refusals.ts`](../../packages/plugin-request-inspector/backend/refusals.ts)); the panel
classifies replay outcomes from that text, so changing it is a contract change.

## Subscriptions

One envelope runs from SDK to worker to RPC to bridge: `snapshot` first, then `batch`,
`resync`, or `closed`. `revision` and `cursor` are opaque to the host, which never reads items.
The host bounds payload, batch, and message sizes with `PLUGIN_LIMITS` in contracts. The
supervisor's per-subscription inbox resyncs at 16 queued events: it drops the worker
subscription, sends `resync`, and opens a new one whose first event is a fresh snapshot. A
client that reconnects gets the same treatment. The inspector's topics are `capture_status` and
`requests`; the panel reconciles tracked replays by id after each snapshot.

## Agent tools

Plugin tools join the catalog gateway at request time
([`McpCatalogGateway.ts`](../../apps/server/src/mcp/McpCatalogGateway.ts)), so disabling takes
effect on the next list or call with no provider restart. The gateway, not the provider, is
authoritative: a provider that listed tools once still fails on a disabled plugin. Operations
marked `mutates` additionally require the thread to be full-access and in default interaction
mode; the gateway reads that from the projection store, not from the caller. Assistants select
operations in their resource bindings; the key is `plugin:<pluginId>:<operation>` in the
admitted snapshot, and plugin resources are hidden whenever an assistant policy applies.

| Provider                                         | Plugin tools                       |
| ------------------------------------------------ | ---------------------------------- |
| Codex, Claude, Cursor, OpenCode, Pi, Muse        | Supported through catalog endpoint |
| Grok, Fx, Antigravity, trusted-bridge ACP agents | Supported through the ACP bridge   |
| Other ACP registry agents                        | Unsupported                        |
| OpenCode2                                        | Unsupported: no protocol proof     |
| Replay (dev)                                     | Unsupported                        |

This matrix comes from adapter source (`supportsMcpTools` and the catalog endpoint wiring). Only
Claude has been checked with a real turn (a read-only call, and the full-access refusal of a
mutating call); re-verify any other row before promising it.

## References

`plugin-reference` composer records (see
[composer context references](./composer-context-references.md)) are attached only from plugins
installed in an environment, because resolving one is a server call. A client-only plugin has
no backend to resolve it. Mobile has no Configure action yet; settings are edited on web.
