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

Rail pins are device-local and keyed by `PluginPanelKey` in the same store, so one panel of a
multi-panel plugin can be pinned alone. A pin shows only where the open rule resolves to `dock`
and the plugin is installed and enabled; otherwise it is hidden, not deleted, so it returns with
the plugin or the chat. Mobile has no rail and no pins.

Host API skew is decided in the client, not the server: a remote environment can install a
plugin that this client cannot host, so the server's version cannot decide it. Clients render an
"update the app" state for a panel whose manifest `hostApi` is newer (`isHostApiCompatible`).
That needs the record to decode, so manifest `capabilities` are open strings on the wire and
`decodePluginManifest` rejects an unknown one only when the host claims the manifest's `hostApi`.
Host API 1.0 clients decoded capabilities as a closed list: they cannot read a registry holding a
manifest that declares `file.save` or `clipboard.write`, and must update. `file.pick` needs host
API 1.2, so a plugin that declares it shows "update the app" on 1.1 clients.

## Backend packaging

Installed packages sit under `stateDir/plugins/` with no `node_modules` and no install step, and
the release ships a Node SEA that resolves only builtins. So a backend must be one
builtins-only CommonJS file, loaded through `createRequire`, and packing fails on anything else.
Native code is an external prerequisite (the inspector needs `mitmdump` on PATH). Non-JS files
are embedded as text and materialized by the SDK to `dataDir/runtime/` at start, because
mitmproxy puts a script's directory on `sys.path` and that directory must hold nothing else. The
archive therefore holds only the manifest, panel HTML, and the backend entry. The worker starts
through `t3 plugin-worker`, so it runs on whichever runtime the server uses.

## Call context

The server derives who is calling; the plugin never supplies it. A docked panel sends only a
hint, `{threadId}` or `{projectId}`, and only when the chat is in the plugin's own environment
(the page route and mobile send none). The server resolves it from the projection store
([`PluginService.ts`](../../apps/server/src/plugins/PluginService.ts)); a missing or deleted
target becomes an empty context rather than a failure. Agent calls take the thread from the
gateway, so an agent cannot claim another thread's context. The context rides on the `invoke`
params as an optional field, so old backends ignore it and new backends run on old hosts.

A plugin that must act on an explicit thread or project id (linking a resource to another chat)
cannot trust the id, so the worker asks the host with the `t3/context.resolve` request, which
the supervisor answers from the same projection lookup. Worker request ids are strings so they
never collide with the host's numeric ids. Subscriptions carry no context; a panel reads its
caller first and subscribes with explicit ids.

## Host bridge: save and clipboard

A panel frame has no downloads or clipboard, so `file.save` and `clipboard.write` run in the
viewing client ([`bridge.ts`](../../packages/client-runtime/src/plugins/bridge.ts)). Frame
messages are capped well below a large export, so saving is chunked: `begin`, `append`*,
`commit` or `abort`, bounded by `PLUGIN_LIMITS.maxSaveBytes`. Both need user activation, and
activation expires. `begin` therefore checks it and its `size` is optional: a streaming export
does not know its size until it has read everything, and waiting would let the activation lapse.
When a size is declared it is enforced on `append` and `commit`. A new `begin` drops a save the
panel abandoned. Mobile cannot see whether the share sheet was dismissed, so its commit always
reports `saved`. `chat.targets.list` needs `chat.attach` or `chat.reference` but no activation,
so a target picker can fill as it opens.

`file.pick` lets a panel ask for a path on its environment without a backend operation that
lists directories. Web and desktop open the command palette in a pick-file mode on the install's
environment (`filesystem.browse` with `includeFiles`). The pick settles as cancelled whenever the
palette's intent changes, so closing it or opening another pick never leaves the panel waiting.
Mobile has no palette and refuses the request.

## Long-running mutations and replay

`invoke` times out at 30 s and cannot report whether a mutation finished. A mutation that can
run longer therefore enqueues, returns an id, and the caller reads the outcome. The inspector's
`replay_request` does this; `get_replay` reports `pending`, `completed`, `failed`, or `unknown`.

- Replay goes through mitmproxy's `replay.client`, not `fetch`: `fetch` follows redirects and
  decodes content encoding, which would change what is replayed.
- A replay leaves the way the original request did: through the source request's proxy when it
  runs, else a transient replay-only mitmdump with that proxy's upstream. Results land in the
  source request's recording.
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

## Request inspector recording

A proxy and a recording are separate. A running proxy forwards everything and stores flows only
while a recording is open; the addon is told to stop serializing bodies when none is.

- Pass-through hosts (tunnelled, not decrypted, recorded as host, SNI, timing, and bytes) and
  ignored hosts (forwarded, not recorded) both go through mitmproxy's `ignore_hosts`, which
  decides before TLS; the addon chooses which ignored connections to record. Host lists are on
  argv so they hold from the first connection, because the addon's hooks run after mitmproxy
  starts listening. Later edits apply live.
- Counting bytes for a pass-through host depends on `show_ignored_hosts` and the addon's `tcp_*`
  hooks, which clear each message list after counting (the forwarded bytes are separate). Trap:
  mitmproxy is slated to drop that option and record ignored flows by default. The addon sets it
  only when the option exists, so check the pass-through path first when bumping mitmproxy.
- Upstream credentials never go on argv (visible in `ps`) or into an environment option that
  outlives the launch. A launch with credentials gets its own confdir holding a 0600
  `config.yaml` and a link to the shared CA, removed on exit. The addon also strips the
  `Proxy-Authorization` that mitmproxy adds, so recorded flows and replays never keep it.
- Exports are regenerable, so under disk pressure they are pruned before recordings, and writing
  an export never prunes a recording. The certificate bundle in the exports folder is exempt.

## Subscriptions

One envelope runs from SDK to worker to RPC to bridge: `snapshot` first, then `batch`,
`resync`, or `closed`. `revision` and `cursor` are opaque to the host, which never reads items.
The host bounds payload, batch, and message sizes with `PLUGIN_LIMITS` in contracts. The
supervisor's per-subscription inbox resyncs at 16 queued events: it drops the worker
subscription, sends `resync`, and opens a new one whose first event is a fresh snapshot. A
client that reconnects gets the same treatment. The inspector's topics are `proxies` and
`requests`. `proxies` carries proxy state, recording state, storage status, and replay
progress, and the panel reconciles tracked replays by id after each snapshot.

## Agent tools

Plugin tools join the catalog gateway at request time
([`McpCatalogGateway.ts`](../../apps/server/src/mcp/McpCatalogGateway.ts)), so disabling takes
effect on the next list or call with no provider restart. The gateway, not the provider, is
authoritative: a provider that listed tools once still fails on a disabled plugin. The gateway
sends no `tools/list_changed`, so a session started before a plugin update keeps the old tool
schemas until it lists again; calls are validated against the new ones, and refusal text is what
lets the model recover. Operations
marked `mutates` additionally require the thread to be full-access and in default interaction
mode; the gateway reads that from the projection store, not from the caller. Assistants select
operations in their resource bindings; the key is `plugin:<pluginId>:<operation>` in the
admitted snapshot, and plugin resources are hidden whenever an assistant policy applies.

| Provider                                         | Plugin tools                       |
| ------------------------------------------------ | ---------------------------------- |
| Codex, Claude, Cursor, OpenCode, Pi, OMP, Muse   | Supported through catalog endpoint |
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
