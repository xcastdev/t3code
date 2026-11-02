# Trusted Plugins with Persistent UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trusted T3 Code plugins. A plugin can supply a client UI, an environment backend, or both. Its panels persist beside chat and stay reachable from the sidebar. They work remotely on web, desktop, and mobile. Two example plugins prove the design: a client-only converter and a mitmproxy request inspector.

**Architecture:** A plugin is a zip-packaged `t3-plugin.json` manifest. It can carry self-contained HTML panels and an optional backend, packed as one self-contained CommonJS file that imports only Node builtins. Panels run in sandboxed frames that talk only to a versioned host bridge (`packages/client-runtime/src/plugins/`). An environment-owned `PluginService` (`apps/server/src/plugins/`) manages installed packages and one supervised worker process per enabled backend. One operation surface serves UI calls (new `plugins.*` WebSocket RPCs) and agent calls, which reach providers through the existing `McpCatalogGateway`. Panels are scoped by environment, not by thread or provider session. On web and desktop they open as a standalone page that needs no chat (`/plugins/<scope>/<pluginId>/<panelId>`), or docked in the right panel beside a chat. On mobile they open in their own screen.

**Tech Stack:** Effect services and Schema (server, contracts), effect/rpc WebSocket RPC, `@modelcontextprotocol/sdk` server in the catalog gateway, React + zustand (web), React Native + `react-native-webview` (mobile), JSZip/yauzl for archives, esbuild (SDK pack: panels and backend), `node:sqlite` (inspector storage; the server already loads it in every runtime, `apps/server/src/serverOwnership.ts`), externally installed `mitmdump` (capture and replay).

**Spec:** [design.md](./design.md) (approved). Read it alongside this plan. Repository rules in `AGENTS.md` override this plan's defaults where they conflict.

## Global Constraints

- Trusted plugins only. A backend runs with the OS account's ordinary privileges. Process separation contains crashes, not malicious access. Installing a backend requires an explicit "I trust this author" confirmation.
- Out of scope: a marketplace, automatic updates, OS-enforced backend permissions, native plugin components, React tree injection, automatic traffic interception, install scripts, and transparent-proxy or WebSocket frame editing.
- Client-only packages install into one client's local storage. They create no environment record, do not sync to other clients, and advertise no agent tools.
- A backend package installs into a selected environment by authenticated upload. No shell or local path is required. Its executable is never copied to viewing clients.
- No browser connects to a plugin's localhost service. All control and data access goes through the T3 bridge and RPC.
- Plugin UI code gets no T3 auth credentials, Electron APIs, filesystem access, arbitrary MCP servers, or T3 internal RPC.
- Panel identity is `(environmentId | "client", pluginId, panelId)`. The loaded frame is additionally keyed by installed `version`, so an update remounts it while its state is kept. Switching threads in the same environment keeps the selected panel and its state. Switching environments selects that environment's instance. Closing a panel releases its UI subscriptions, not backend work.
- Disabling a plugin stops its backend, removes its tools and subscriptions, and marks open panels disabled. Uninstalling stops it and removes registration but keeps data. Deleting data is a separate explicit action. Updates are explicit package replacements gated on API compatibility. A failed migration is reported as failed, never rolled back silently.
- Subscriptions are bounded and batched, apply backpressure, can be cancelled, and resync after reconnect. Capture bodies and plugin databases never enter thread snapshots or shell streams.
- Workers and their subprocesses are stopped by captured PID or process group, never by matching names (AGENTS.md rule 1).
- The request inspector captures only traffic explicitly routed to its proxy. mitmproxy is an externally installed prerequisite. HTTPS trust setup is a manual user step, and T3 never changes system trust.
- Replay is a mutation. Agent calls follow T3's normal agent policy (full-access runtime and default interaction mode). Auth headers and bodies stay out of logs and out of agent output unless explicitly requested.
- Verification: focused `vp test run <files>` and `vp run --filter <pkg> typecheck` only. No repo-wide checks. Run `vp run check:changed` before any requested push. No PR unless asked. All visual work uses dark mode.
- Model-facing text changes (plugin reference projection, inspector tool descriptions, gateway refusal messages) need an `evals/mcp-tool-use` case per `evals/README.md`. All of these cases depend on the inspector manifest, so they land in Task 13, the first task where every imported source exists.
- Every task's gate must pass using only the files that it and earlier tasks create.
- Payloads crossing the bridge, the RPC, the worker pipe, or MCP obey `PLUGIN_LIMITS` (Task 1). Nothing large travels whole.

## Decisions this plan makes (builder choices the spec left open)

| Topic                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Grounding                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package container         | Zip archive with extension `.t3plugin`, at most 50 MiB, at most 2048 entries, and `t3-plugin.json` at the root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Same limits as `packages/client-runtime/src/zip/boundedZip.ts:4-7`. Server reads it with `apps/server/src/zipArchive.ts:openZipArchive`                                                                                                                                                                                                                                                                                              |
| Panel assets              | Each panel entry is one self-contained HTML file (inline JS and CSS, data: images) of at most 5 MiB. The SDK `pack` step inlines bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Same limit and CSP injection as MCP Apps (`MCP_APP_MAX_HTML_BYTES`, `packages/shared/src/mcpApp.ts`). Avoids per-subresource signed URLs inside opaque-origin frames                                                                                                                                                                                                                                                                 |
| Server panel delivery     | New `AssetResource` member `plugin-panel { pluginId, panelId, version }` minted through the existing `AssetCreateUrl` RPC and served by `layerAssetRoute`. Sandboxed iframe uses `src=`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/contracts/src/assets.ts:20-62`, `apps/server/src/http.ts:405-455`, `apps/web/src/components/chat/McpAppFrame.tsx`                                                                                                                                                                                                                                                                                                          |
| Client-only delivery      | Sandboxed iframe uses `srcdoc` from client storage (web IndexedDB, mobile `expo-file-system`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No environment involved                                                                                                                                                                                                                                                                                                                                                                                                              |
| Upload transport          | Existing signed attachment upload (`type: "file"`, ≤ `PROVIDER_SEND_TURN_MAX_FILE_BYTES`), then `plugins.install({ attachmentId })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/server/src/assets/AttachmentUpload.ts`. Works over LAN, Tailscale, relay, and T3 Connect like other uploads                                                                                                                                                                                                                                                                                                                    |
| Worker transport          | Newline-delimited JSON-RPC 2.0 over the worker's stdin/stdout, each line ≤ `PLUGIN_LIMITS.maxMessageBytes`. stderr goes to a bounded log ring. The worker starts through a new `t3 plugin-worker <entry>` fast path, spawned with `resolveSelfInvocation` + `selfInvocationArgs`, so it runs on the server's own runtime (dev Node, Node SEA binary, or desktop Electron-as-Node, whose `ELECTRON_RUN_AS_NODE=1` the child inherits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mirrors the `acp-mcp-bridge` fast path in `apps/server/src/bin.ts:35-37` and `packages/shared/src/nodeRuntime.ts:36-53`. No `node` on PATH is required                                                                                                                                                                                                                                                                               |
| Backend artifact          | `backend.entry` must be one `.cjs` file. `packPlugin` bundles it with esbuild (`bundle`, `platform: "node"`, `format: "cjs"`, `target: "node22"`) including `@t3tools/plugin-sdk/backend`. Pack fails on any external non-builtin import, any `.node` native addon, and esbuild's `unsupported-require-call` / `unsupported-dynamic-import` warnings. The worker entry loads the file with `NodeModule.createRequire(import.meta.url)(absoluteEntryPath)`. Native code ships as an external executable prerequisite (as the inspector does with `mitmdump`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Installed packages live under `stateDir`, with no `node_modules` and no install step. The repo's SEA build rule says its imports resolve only builtins and file-backed code must load through `createRequire` (`scripts/lib/cli-executable-imports.ts:5`, `apps/server/src/preview/ServerBrowserContexts.ts:12-13`). The release ships the SEA (`docs/operations/release.md:47-49`). The SDK backend runtime uses only Node builtins |
| Backend assets            | Non-JS files a backend needs at runtime (the inspector's `addon.py`) are imported as text and embedded in the one `.cjs`. `packPlugin` sets esbuild `loader: { ".py": "text", ".txt": "text" }`. At runtime the SDK's `materializeAsset(name, contents)` writes the file to `<dataDir>/runtime/<sha256-16>-<name>`: a temp file, then rename, mode `0600`. It returns the absolute path. `runtime/` holds only materialized assets, because mitmproxy puts a script's directory on `sys.path` while loading it. The archive keeps exactly three kinds of entry: the manifest, panel HTML, and the backend entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The archive rule in Task 3 excludes every other file. `mitmproxy/addons/script.py:23-57` (`load_script` inserts `os.path.dirname(path)` into `sys.path`). Text embedding keeps the builtins-only `.cjs` rule, so the SEA loads it unchanged. No manifest asset list, no install-time extraction rules                                                                                                                                |
| Long-running mutations    | `PluginWorkerSupervisor.invoke` times out after 30 s with `timed-out` and never retries. Its message says a state-changing operation may still finish. On timeout, or when the caller is interrupted (client disconnect, MCP abort), the host sends `cancel { id }`. The SDK aborts that call's `OperationContext.signal`, and a late response is dropped. A mutation that can outlast the invoke budget must enqueue and return an id. The inspector's `replay_request` does this: it accepts (`pending`) and returns within the budget, the caller reads the outcome with `get_replay`, and the required `idempotencyKey`, issued by `preview_replay`, makes retries safe while the replay's row is kept. A key carries an HMAC tag from a per-database secret, so an altered or mistyped key is refused as not issued, never accepted as a new replay. History is bounded: a retry whose row was pruned is refused as expired, never accepted as a new replay. The worker commits `dispatched: true` before it hands the request to mitmdump, so an interrupted replay is reported as `unknown`, never as not sent. Idempotency covers exact retries of an issued key while its row is kept. A caller that deliberately gets a new key is asking for a new replay. Exactly-once network delivery and idempotency beyond the kept history are not promised | A synchronous 30 s replay inside a 30 s invoke cannot report a definite outcome. Enqueue-and-query is the smallest model that gives the caller an identity to reconcile with                                                                                                                                                                                                                                                         |
| Subscription envelope     | One schema from SDK to worker to RPC to bridge. `snapshot { items, revision, cursor }`, `batch { items, revision }`, `resync`, `closed { reason }`. `revision` is an opaque string (≤ 128 chars) naming the plugin's change position. `cursor` is an opaque string (≤ 1024 chars), or `null` when the snapshot window holds everything. The host enforces that each worker subscription starts with a snapshot, that a snapshot is ≤ `maxPayloadBytes`, and that a batch is ≤ `maxBatchBytes`. It never reads `items`. On overflow it drops the worker subscription, sends `resync`, and opens a new worker subscription, whose first event is a new snapshot. The plugin defines item identity and page queries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The pipe and the RPC stream keep event order, so there are no gaps unless the host drops events. When it drops them it always sends `resync` and a new snapshot                                                                                                                                                                                                                                                                      |
| Panel revision identity   | The installed `version` is part of the `plugin-panel` asset resource, the long-lived URL cache key, the frame's React key, and every UI backend call (`expectedVersion`). An update elsewhere changes the registry version. Each open panel then disposes its bridge (releasing subscriptions), mints a URL for the new version, and remounts. A call that races the update fails with `version-changed`. Panel `state` is kept and returned as `{ value, version }`, so new UI can migrate or discard state written by older UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/web/src/assets/longLivedAssetUrls.ts:35-63` keys by `JSON.stringify([environmentId, resource])` and re-mints only near expiry                                                                                                                                                                                                                                                                                                  |
| Command resolution        | Keybinding commands are `plugin.<pluginId>.<commandId>`, naming a manifest `ui.commands` entry that resolves to its panel through `opens.panel`. When the key is pressed, `resolvePluginCommand` collects the installs that declare the command and picks the first that applies: (1) the current chat's environment, (2) the client install, (3) the only connected environment. If none applies, more than one environment matches, and the palette opens with the command title as its query, listing one item per scope. The sidebar, palette items, Settings, and the mobile palette always carry an explicit `PluginPanelKey` and never resolve by id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `apps/web/src/shortcuts/dispatcher.ts:60-73` looks up `commands[command]`, so plugin handlers register dynamically through `registerCommands`. `openCommandPalette({ query })` (`apps/web/src/commandPaletteBus.ts:16-28`) already opens the palette with a query                                                                                                                                                                    |
| Payload budgets           | One set of constants in contracts, `PLUGIN_LIMITS`. `maxPayloadBytes = 240 KiB` is the UTF-8 JSON size of any operation input, operation result, resource read, state value, or subscription snapshot. `maxMessageBytes = 256 KiB` caps any bridge message in either direction and any worker NDJSON line, envelope included. `maxBatchBytes = 64 KiB`. Bodies never travel whole. They move in binary-safe chunks of at most `maxBodyChunkBytes = 128 KiB` raw, which is 174,764 bytes as base64 and stays under `maxPayloadBytes` with its envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The MCP Apps bridge already caps frames at 256 KiB (`packages/client-runtime/src/mcpApps/host.ts:7`). The server WebSocket has no frame cap, so the plugin layer enforces its own                                                                                                                                                                                                                                                    |
| Replay engine             | Replay runs inside mitmdump through the built-in `replay.client` command, never Node `fetch`. With a capture running, its mitmdump replays. Otherwise the worker starts a transient `mitmdump --set server=false` with the same materialized addon and confdir, then stops it by captured PID. Replay is asynchronous (see "Long-running mutations"): `pending`, then `completed`, `failed`, or `unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `mitmproxy/addons/clientplayback.py` (`replay.client`, `ReplayHandler`) in mitmproxy 12.3.1. A local probe confirmed it returns an upstream 302 unfollowed, keeps duplicate request and response headers in order, sends a binary request body byte-exact, and keeps the gzip response raw. Node `fetch` follows redirects by default and decodes content encoding                                                                   |
| Host storage              | Files under `ServerConfig.stateDir/plugins/`: `registry.json` (atomic writes), `packages/<id>/<version>/`, `data/<id>/`, `config/<id>.json`. Secrets live in `ServerSecretStore` under `plugin.<id>.<key>`. No SQL migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keeps plugin data out of orchestration tables. `packages/shared/src/atomicWrite.ts`, `apps/server/src/auth/ServerSecretStore.ts:142-149`                                                                                                                                                                                                                                                                                             |
| Agent exposure            | Plugin tools and resources are added to every catalog-gateway generation at request time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/server/src/mcp/McpCatalogGateway.ts:118-276` builds a stateless server per request, so disabling a plugin takes effect on the next list or call without a provider restart                                                                                                                                                                                                                                                     |
| Assistant policy          | `AssistantResourceSelection` gains `plugins: optionalKey(Array<{ pluginId, operations }>)`. Selected operations enter the admitted snapshot's `toolIds` as `plugin:<pluginId>:<operation>`, beside today's `<definitionId>:<toolName>`. The gateway checks that key on list and call. Plugin resources follow the existing assistant rule: hidden from list and refused on read whenever a policy applies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/contracts/src/assistants.ts:39-54`, `apps/server/src/assistants/AssistantResources.ts:139,152`, `AssistantNativeResources.ts:49-54`, `McpCatalogGateway.ts:141-180` (tools), `:182-183,224-226` (resources). An absent optional key leaves the canonical configuration hash of stored assistants unchanged (`AssistantResources.ts:23-26`)                                                                                 |
| Panel hosts (web/desktop) | Two hosts share one `PluginPanelSurface`. (1) A standalone route `/_chat/plugins/$scope/$pluginId/$panelId` needs no chat. (2) Docked in ChatView's right panel when a chat is open. `resolvePluginOpenTarget` picks dock or page for every entry point. Plugin UI state lives in bridge `state` keyed by `PluginPanelKey`, never by thread, so a frame remount restores it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `ChatView.tsx:1081-1083` gates the right panel on `activeThreadRef !== null`. `:3260` builds content only with a thread ref. `RightPanelSurfaceContent` requires `threadRef` (`chat/RightPanelSurfaceContent.tsx:70`). `_chat.pull-requests.tsx` is the precedent for a thread-free page                                                                                                                                             |
| Panel store               | New environment-keyed `apps/web/src/pluginPanelStore.ts` holds docked state. `rightPanelStore` gains a derived-only `"plugin"` surface kind for tabs and drops it from persisted thread state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/src/rightPanelStore.ts:16-91` is thread-keyed with a closed union                                                                                                                                                                                                                                                                                                                                                          |
| Scopes                    | install/update/uninstall/deleteData → `environment:maintain`. enable/disable/start/stop/restart/configure → `settings:write`. list/subscribeRegistry/query/subscribe/resolveReference/asset URL → `orchestration:read`. mutate → `orchestration:operate`. logs → `diagnostics:read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/contracts/src/auth.ts:31-48`, `apps/server/src/auth/RpcAuthorization.ts`                                                                                                                                                                                                                                                                                                                                                   |
| Host API version          | `PLUGIN_HOST_API = { major: 1, minor: 0 }`. A manifest `hostApi: "1.0"` is compatible when the major versions match and the manifest minor ≤ host minor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Spec "API compatibility"                                                                                                                                                                                                                                                                                                                                                                                                             |

## Provider MCP capability matrix (source-backed)

Every built-in driver (`apps/server/src/provider/builtInDrivers.ts:31-42`) gets the catalog endpoint from `McpSessionRegistry` (`apps/server/src/mcp/McpSessionRegistry.ts:150`, `catalogEndpoint: ${endpoint}/catalog/${providerSessionId}`). Plugin tools ride that endpoint, so no provider gets plugin-specific code.

| Driver                      | How the catalog endpoint reaches the agent                                          | Plugin tools                                                               | Evidence                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                       | HTTP MCP server in session config                                                   | Supported                                                                  | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1388-1392`                                                                                                                                              |
| Claude                      | `t3_catalog` HTTP server                                                            | Supported                                                                  | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1767-1772`                                                                                                                                             |
| Cursor                      | HTTP server in session MCP list                                                     | Supported                                                                  | `packages/provider-cursor/src/server/adapter.ts:222-226`                                                                                                                                                             |
| Grok, Fx, Antigravity (ACP) | `t3_catalog` stdio server through `t3 acp-mcp-bridge`                               | Supported                                                                  | `packages/provider-acp/src/server/adapter.ts:700-720`. Grok `packages/provider-grok/src/server/adapter.ts:346`, Fx `packages/provider-fx/src/server/adapter.ts:195`, Antigravity `AntigravityAdapterV2.ts:62-66,212` |
| ACP registry agents         | Same bridge, only when `hasTrustedBridge`                                           | Supported only for trusted-bridge agents. Otherwise unsupported            | `packages/provider-acp/src/server/adapter.ts:599,681`                                                                                                                                                                |
| OpenCode (v1)               | Remote MCP entry with `catalogEndpoint`                                             | Supported                                                                  | `packages/provider-opencode/src/server/adapter.ts:156` (`supportsMcpTools: true`), `:985-992`                                                                                                                        |
| OpenCode2                   | Registers `<name>_catalog` via `client.mcp`, but declares `supportsMcpTools: false` | Marked unsupported until Task 9's verification test passes. Do not promise | `packages/provider-opencode/src/server/v2/adapter.ts:137,3034-3121`                                                                                                                                                  |
| Pi                          | Injected extension client for `catalogEndpoint`                                     | Supported                                                                  | `packages/provider-pi/src/server/mcpInjection.ts:319-326`                                                                                                                                                            |
| Muse                        | HTTP server entry                                                                   | Supported                                                                  | `packages/provider-muse/src/server/adapter.ts:1846-1851`                                                                                                                                                             |
| Replay (dev)                | None                                                                                | Unsupported (dev only)                                                     | —                                                                                                                                                                                                                    |

Tool-list freshness differs by provider: some list tools once per session. Call-time enforcement in the gateway is authoritative. A call to a disabled plugin's tool fails with `Plugin "<name>" is disabled.` whether or not the provider re-listed. Plugin panels never depend on the provider.

## Review Focus

1. **The T3 server dies while a capture is running.** The worker sees EOF on stdin, stops `mitmdump` by its captured PID, and exits. No orphan keeps the proxy port bound. Test pinned in Task 6 (`worker exits and stops its children when the host pipe closes`) and Task 13 (`addon shuts mitmdump down when its control socket closes`).
2. **The proxy port is already in use, or `mitmdump` is missing.** The capture start fails with an actionable status (`port-in-use` / `missing-prerequisite` plus a hint) and the panel stays usable. Tests in Task 13.
3. **A client reconnects (relay drop, phone sleep) mid-subscription, or records arrive while the panel pages older ones.** The panel receives `resync` and a fresh snapshot (`revision`, `cursor`). It does not show duplicated or missing rows. Replay outcomes that changed during the gap are recovered by querying each tracked `replayId` after the new snapshot. The capture keeps running. Tests in Task 7 (overflow resubscribes and drops the old worker subscription's events), Task 2 (bridge resubscribe after host reconnect), and Task 13 (paging under concurrent inserts and updates, and replay reconciliation after a missed terminal change).
4. **A plugin is updated, disabled, or uninstalled while its panel is open on another device.** An update remounts the panel on the new version, a disable or uninstall shows that state, and a failed update shows the failure. Old UI never talks to the new backend: stale calls fail with `version-changed`. Tests in Task 7 (`calls after disable fail with plugin-disabled`, `calls with a stale expectedVersion fail with version-changed`), Task 8 (non-active version not found), and Task 10 (`shows Enable for a disabled plugin…`, `remounts on the new version when another client updates the plugin`).
5. **The user switches threads or environments while an attach is pending.** Nothing is inserted until the user confirms a definite destination. Test in Task 12 (`attach refuses when target changed since request`).
6. **An installed backend runs from the release binary.** The packed `.cjs` has no `node_modules` to resolve from, and the SEA loads file-backed code only through `createRequire`. Tests in Task 3 (bundle has only builtin requires) and Task 6 (`packed backend runs from a state dir outside the repository`). Packaged-binary smoke in Task 15.
7. **Replay is not what was captured.** Redirects, duplicate headers, binary bodies, content encoding, and truncated captures. Tests in Task 13 (`integration/` replay fidelity, incomplete-body refusal).
8. **The user opens a plugin with no chat selected.** The standalone route renders it. Test in Task 10 (`PluginPanelPage.browser.test.tsx`).
9. **A replay outlasts its caller.** The upstream is slow, the client disconnects, or the call times out. The replay has a `replayId` and an `idempotencyKey` that the caller got from `preview_replay`. A retry with the same key returns the same replay without sending it again, and `get_replay` reports `pending`, `completed`, `failed`, or `unknown`. A crash or socket loss after handoff gives `unknown`, never "not sent". Keys are issued by `preview_replay` and carry an HMAC tag, and history is bounded. A retry whose replay was pruned, whose key came from deleted data, or whose key was altered in any character, is refused, never accepted as a new replay. Tests in Task 6 (invoke timeout and cancel) and Task 13 (replay identity, abort, deadline, restart states, handoff-interruption cases, history pruning, expired and altered keys, storage-pressure accept on real `node:sqlite`, plus delayed-upstream integration cases).
10. **A backend needs a non-JS file.** The inspector's mitmproxy addon is embedded in the `.cjs` and materialized under `dataDir/runtime/`. Integration tests run the packed and extracted archive, never source files. Tests in Task 3 (archive entries), Task 6 (the echo asset materializes from an installed package), and Task 13 (`integration/` runs only the packed archive).
11. **The same plugin is installed in two environments and on the client.** Every explicit entry point names its scope. A keybinding resolves by the documented precedence or opens the palette to choose. Tests in Task 10 (`packages/client-runtime/src/plugins/commands.test.ts` table).

---

## File structure

```
packages/contracts/src/plugins.ts                 # manifest, ids, host API, RPC payloads, errors (new)
packages/shared/src/pluginManifest.ts             # pure manifest validation + compatibility + tool naming (new)
packages/client-runtime/src/plugins/bridge.ts     # sandboxed-frame host bridge (new)
packages/client-runtime/src/plugins/clientPackages.ts  # client-only package parse/install model (new)
packages/client-runtime/src/plugins/commands.ts   # PluginPanelKey (Task 4), panel targets and command resolution (Task 10) (new)
packages/client-runtime/src/state/plugins.ts      # environment plugin RPC atoms (new)
packages/plugin-sdk/                              # @t3tools/plugin-sdk: ui, backend, pack (new)
packages/plugin-converter/                        # client-only example (new, private)
packages/plugin-request-inspector/                # combined example (new, private)
apps/server/src/plugins/PluginPackageStore.ts     # install/verify/extract/registry/uninstall/data (new)
apps/server/src/plugins/PluginWorkerSupervisor.ts # processes, protocol, logs, status (new)
apps/server/src/plugins/PluginService.ts          # lifecycle + operations + subscriptions + tools (new)
apps/server/src/plugins/pluginWorkerEntry.ts      # `t3 plugin-worker` fast path (new)
apps/web/src/pluginPanelStore.ts                  # environment-scoped docked-panel state (new)
apps/web/src/plugins/openPluginPanel.ts           # dock-or-page routing for every entry point (new)
apps/web/src/routes/_chat.plugins.$scope.$pluginId.$panelId.tsx  # thread-free panel page (new)
apps/web/src/components/plugins/                  # PluginPanelFrame, settings, attach confirm (new)
apps/mobile/src/features/plugins/                 # PluginPanelScreen, PluginWebView, settings (new)
docs/internals/plugins.md, docs/user/plugins.md   # trust model + panel scoping; user guide (new)
```

---

### Task 1: Plugin contracts and manifest validation

**Files:**

- Create: `packages/contracts/src/plugins.ts`, `packages/contracts/src/plugins.test.ts`
- Create: `packages/shared/src/pluginManifest.ts`, `packages/shared/src/pluginManifest.test.ts`
- Modify: `packages/contracts/src/index.ts` (export), `packages/shared/package.json` (add `"./pluginManifest"` export beside `"./mcpApp"` at line 506)
- Modify: `packages/contracts/src/keybindings.ts:121-133` (add `PLUGIN_OPEN_COMMAND_PATTERN` to the `KeybindingCommand` union)

**Interfaces:**

- Consumes: `TrimmedNonEmptyString`, `EnvironmentId`, `NonNegativeInt` from `packages/contracts/src/baseSchemas.ts`
- Produces (contracts, all new):
  - `PluginId` = branded string, 2 to 23 chars, matching `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. Hyphens separate non-empty segments, so there are no leading, trailing, or doubled hyphens. `PluginOperationName` matches `^[a-z][a-z0-9_]{0,31}$`. `PluginContributionId` matches `^[a-z][a-z0-9-]{0,31}$`
  - `PLUGIN_LIMITS = { maxPayloadBytes: 240 * 1024, maxMessageBytes: 256 * 1024, maxBatchBytes: 64 * 1024, maxBodyChunkBytes: 128 * 1024, maxPendingRequests: 16 } as const`. Payload means the UTF-8 JSON size. Message includes the JSON-RPC envelope (see the decision table)
  - `PLUGIN_HOST_API = { major: 1, minor: 0 } as const`
  - `PluginManifest` Schema with these fields: `manifestVersion: 1`, `id`, `name` (≤ 64 chars), `version` (semver), `hostApi` (`"<major>.<minor>"`), `author` (≤ 128 chars), `description?`.
    - `ui?: { panels: Array<{ id, title, entry, icon? }>, commands: Array<{ id, title, opens: { panel: id } }> }`. Each `opens.panel` must name a declared panel. Panel ids and command ids are separate namespaces. A keybinding names a command id, never a panel id
    - `backend?: { entry /* relative path ending in .cjs */, operations: Array<PluginOperationDecl>, topics: Array<{ name }>, resources: Array<{ name /* PluginOperationName */, title, operation /* non-mutating op name */ }>, prerequisites: Array<{ executable, hint }> }`. The gateway exposes each resource as `t3-plugin://<pluginId>/<name>`
    - `settings?: { client: Array<PluginSettingField>, environment: Array<PluginSettingField> }`
    - `capabilities: Array<"chat.attach" | "chat.reference">`
  - `PluginOperationDecl = { name, title, description (≤ 1024), inputSchema: JsonObject, mutates: boolean, agent: boolean }`
  - `PluginSettingField = { key, label, type: "string" | "number" | "boolean" | "enum" | "secret", default?, options? }`
  - `PluginRuntimeStatus = "stopped" | "starting" | "running" | "failed" | "missing-prerequisite" | "disabled"`
  - `PluginInstallRecord = { pluginId, version, name, author, enabled, status, statusDetail?, failedUpdate?: { from, to, reason }, manifest }`
  - `PluginRegistrySnapshot = { installed: PluginInstallRecord[], retainedData: Array<{ pluginId, bytes }> }`
  - `PluginRequestError` (TaggedError, fields `reason` and optional `detail` ≤ 1024 chars): `"not-installed" | "disabled" | "not-running" | "unknown-operation" | "operation-mutates" | "operation-failed" | "incompatible-host-api" | "invalid-package" | "too-large" | "worker-failed" | "capability-denied" | "subscription-limit" | "timed-out" | "version-changed"`. Each reason has a fixed user-facing `message`, as in `McpAppRequestError` (`packages/contracts/src/mcpApps.ts:66-98`). `timed-out`: "The plugin did not answer in time. A state-changing operation may still finish; check its status before retrying." `version-changed`: "This plugin was updated. Reload the panel." Only `operation-failed` carries `detail`, the plugin's own bounded error text (for example the inspector's incomplete-body refusal)
  - `PluginSubscriptionEvent` Schema (the envelope in the decision table): `{ type: "snapshot"; items: Array<unknown>; revision: string /* ≤ 128 */; cursor: string /* ≤ 1024 */ | null } | { type: "batch"; items: Array<unknown>; revision: string } | { type: "resync" } | { type: "closed"; reason: "plugin-disabled" | "plugin-updated" | "plugin-uninstalled" | "worker-failed" | "protocol-error" | "too-large" }`. The SDK, worker protocol, RPC stream, and bridge all use this schema
  - `PLUGIN_OPEN_COMMAND_PATTERN` = TemplateLiteral `plugin.<pluginId>.<commandId>`, where `commandId` is a `ui.commands[].id`
- Produces (shared): `decodePluginManifest(json: unknown): Result<PluginManifest, string>`, `isHostApiCompatible(hostApi: string, host = PLUGIN_HOST_API): boolean`, `pluginToolName(pluginId, op): string` (returns `plugin_${pluginId.replaceAll("-", "_")}__${op}`; at most 7 + 23 + 2 + 32 = 64 chars), `parsePluginToolName(name): { pluginId, operation } | undefined`, `pluginResourceUri(pluginId, name)` / `parsePluginResourceUri(uri)`, `pluginToolPolicyKey(pluginId, op)` (returns `plugin:<pluginId>:<op>`), and `pluginAgentTools(manifest): Array<{ name, description, inputSchema, annotations: { title, readOnlyHint, destructiveHint } }>`. The gateway (Task 9) and the eval harness (Task 13) both call `pluginAgentTools`, so neither copies tool text

- [ ] **Step 1: Write failing tests**

```ts
// packages/shared/src/pluginManifest.test.ts
it("accepts the minimum client-only manifest", ...)       // ui only, no backend
it("rejects a manifest whose panel entry is not .html", ...)
it("rejects a backend entry that is not a relative .cjs path", ...)
it("rejects a resource whose operation is undeclared or mutates", ...)
it("a full maxBodyChunkBytes chunk as base64 plus a 4 KiB envelope fits maxPayloadBytes", ...) // guards PLUGIN_LIMITS arithmetic
it("rejects duplicate operation names and contribution ids", ...)
it("rejects a command whose opens.panel names no declared panel", ...)
it("rejects agent:true operations without inputSchema.type === 'object'", ...)
it.each([["1.0", true], ["1.1", false], ["2.0", false], ["0.9", false]])(
  "hostApi %s compatible with 1.0 → %s", (v, ok) => expect(isHostApiCompatible(v)).toBe(ok))
it.each(["a--b", "a-", "-a", "a", "A-b", "a_b", "abcdefghijklmnopqrstuvwx" /* 24 */])(
  "rejects plugin id %s", ...)
it.each([["ab", true], ["a-b", true], ["a1-b2-c3", true], ["abcdefghijklmnopqrstuvw" /* 23 */, true]])(
  "accepts plugin id %s", ...)
const PAIRS = [
  ["request-inspector-abcde", "search_requests_with_long_name_x"], // exactly 64 chars
  ["a-b", "search"], ["ab", "b__search"], ["ab", "b_"], ["a1-b", "x"],
] as const;
it.each(PAIRS)("round-trips tool name for %s / %s and keeps it ≤ 64 chars", ...)
it("distinct (id, op) pairs never share a tool name", () => {
  // Reproduced collision before the grammar fix: a--b/search and a/b__search both encoded to plugin_a__b__search
  expect(new Set(PAIRS.map(([id, op]) => pluginToolName(id, op))).size).toBe(PAIRS.length);
})
it.each(["mcp_6162__x", "plugin___x", "plugin_a_", "plugin_a__", "plugin_a___x", "plugin_A__x"])(
  "parsePluginToolName(%s) is undefined", ...)
// packages/contracts/src/plugins.test.ts — extend keybindings decode table:
it("decodes plugin.converter.open as a KeybindingCommand", ...)
it("PluginSubscriptionEvent rejects a snapshot without revision or with a cursor over 1024 chars", ...)
```

- [ ] **Step 2:** Run `vp test run packages/shared/src/pluginManifest.test.ts packages/contracts/src/plugins.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the schemas and helpers above. A plugin id cannot contain `_` or `--`, and cannot end in `-`. Its encoded form therefore contains no `__` and does not end in `_`. An operation name starts with a letter. So the first `__` after `plugin_` is always the separator. `parsePluginToolName` splits there, maps `_` back to `-`, and then re-validates both halves with the `PluginId` and `PluginOperationName` schemas. It returns `undefined` when either fails. That rejects `plugin_a___x`, whose operation would start with `_`. Catalog names start with `mcp_` (`apps/server/src/mcp/ProjectMcpBroker.ts:3-4`), so they cannot collide with plugin names.
- [ ] **Step 4:** Re-run the tests. Expected: PASS. Then run `vp run --filter @t3tools/contracts typecheck` and `vp run --filter @t3tools/shared typecheck`.
- [ ] **Step 5: Commit** (when commits are authorized): `feat(contracts): plugin manifest and host API contracts`

### Task 2: Host bridge for sandboxed plugin frames

**Files:**

- Create: `packages/client-runtime/src/plugins/bridge.ts`, `packages/client-runtime/src/plugins/bridge.test.ts`
- Modify: `packages/client-runtime/src/mcpApps/host.ts:113-119`. Export `jsonBytes` without changing behavior. The plugin bridge takes its limits from `PLUGIN_LIMITS` (same 256 KiB / 16 values as `host.ts:7-8`).
- Modify: `packages/client-runtime/package.json` (export `"./plugins/bridge"`)

**Interfaces:**

- Consumes: `PluginManifest`, `PLUGIN_HOST_API`, `PluginSubscriptionEvent` (Task 1)
- Produces:

```ts
export interface PluginHostContext {
  readonly apiVersion: "1.0";
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly containerDimensions: { readonly width: number; readonly height: number };
  readonly platform: "web" | "desktop" | "mobile";
  readonly destination:
    | { readonly kind: "client" }
    | { readonly kind: "environment"; readonly environmentId: string; readonly label: string };
  readonly chatTarget: { readonly key: string; readonly title: string } | null;
}
export interface PluginBridgeOptions {
  readonly manifest: PluginManifest;
  readonly panelId: string;
  readonly post: (message: unknown) => void;
  readonly hostContext: () => PluginHostContext;
  readonly pluginVersion: string; // the installed version this frame was loaded for
  readonly state: {
    // keyed by PluginPanelKey, value ≤ PLUGIN_LIMITS.maxPayloadBytes
    readonly get: () => Promise<{ readonly value: unknown; readonly version: string } | null>; // version = plugin version that wrote it
    readonly set: (value: unknown) => Promise<void>; // the host stores it with pluginVersion
  };
  readonly backend?: {
    // the host adapter sends expectedVersion = pluginVersion on every call and subscribe
    readonly call: (operation: string, input: unknown) => Promise<unknown>; // rejects PluginRequestError
    readonly subscribe: (
      topic: string,
      params: unknown,
      onEvent: (e: PluginSubscriptionEvent) => void,
    ) => () => void;
  };
  readonly openSurface: (contributionId: string) => Promise<void>;
  readonly attach: (
    request: PluginAttachRequest,
    activated: boolean,
  ) => Promise<"inserted" | "cancelled">;
}
// PluginSubscriptionEvent is the Task 1 contracts schema: snapshot { items, revision, cursor } | batch { items, revision } | resync | closed { reason }
export type PluginAttachRequest =
  | { readonly kind: "text"; readonly text: string; readonly expectedChatTargetKey: string | null }
  | {
      readonly kind: "reference";
      readonly label: string;
      readonly locator: Readonly<Record<string, string>>;
      readonly snapshot: string;
      readonly expectedChatTargetKey: string | null;
    };
export interface PluginBridge {
  readonly receive: (data: unknown, activated: boolean) => void;
  readonly updateHostContext: () => void;
  readonly hostReconnected: () => void;
  readonly dispose: () => void;
}
export function makePluginBridge(options: PluginBridgeOptions): PluginBridge;
```

The bridge speaks JSON-RPC 2.0. App to host: `t3/initialize`, `t3/state.get`, `t3/state.set`, `t3/backend.call`, `t3/backend.subscribe` (returns `{ subscriptionId }`), `t3/backend.unsubscribe`, `t3/surface.open`, `t3/chat.attach`. Host to app notifications: `t3/hostContext.changed`, `t3/backend.event { subscriptionId, event }`.

- [ ] **Step 1: Write failing tests** in `bridge.test.ts`:
  - `refuses requests before t3/initialize` (error -32002)
  - `initialize negotiates apiVersion 1.0 and returns host context`
  - `rejects app messages over maxMessageBytes and a 17th pending request`
  - `a backend.call result whose response would exceed maxMessageBytes is replaced by a too-large error` (host-to-app direction)
  - `backend.call is refused when the manifest has no backend` and `refuses an operation not declared in the manifest`
  - `state.set rejects values whose JSON exceeds maxPayloadBytes`
  - `state.get returns the stored value with the version that wrote it`
  - `backend.event forwards snapshot revision and cursor unchanged`
  - `chat.attach without user activation is refused` (`activated=false` → error, `attach` not called)
  - `chat.attach reference is refused unless the manifest declares chat.reference`
  - `dispose cancels every live subscription` (spy on the unsubscribe closures)
  - `hostReconnected re-subscribes live subscriptions and forwards a resync event first`
- [ ] **Step 2:** Run `vp test run packages/client-runtime/src/plugins/bridge.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `makePluginBridge`. It holds a `Map<subscriptionId, { topic, params, dispose }>`. `hostReconnected` emits `resync` for each subscription and then calls `subscribe` again. Validate params with small Schema decoders, never casts.
- [ ] **Step 4:** Re-run the tests plus `packages/client-runtime/src/mcpApps/host.test.ts` (no regression). Expected: PASS. Run `vp run --filter @t3tools/client-runtime typecheck`.
- [ ] **Step 5: Commit:** `feat(client-runtime): plugin host bridge`

### Task 3: Plugin SDK and pack tool

**Files:**

- Create: `packages/plugin-sdk/package.json` (`@t3tools/plugin-sdk`, exports `./ui`, `./backend`, `./pack`, `./testing`; `esbuild` and `jszip` are dependencies of `./pack` and `./testing` only), `packages/plugin-sdk/src/ui.ts`, `src/backend.ts` (Node builtins only, no runtime dependencies), `src/pack.ts`, `src/testing.ts`, `src/pack.test.ts`, `src/backend.test.ts`, `src/testFixtures/echo/`, and `README.md`.
  - Echo fixture: manifest id `echo`. Operations:
    - `ping` (agent, read-only), `pong` (agent, mutates).
    - `spawn_child` (UI-only; spawns a sleeping child and reports its pid).
    - `big` (returns a result of the requested size).
    - `asset` (UI-only; materializes the embedded `backend/hello.txt` and returns `{ path, text }`).
    - One topic `ticks`, whose snapshot carries `revision` and `cursor`. One resource `status` → `ping`.
    - `backend/index.ts` imports `@t3tools/plugin-sdk/backend` and `./hello.txt`. One tiny panel.
  - README (author guide): manifest fields, trust, limits, panels restore from `state.get` and check its `version`, backends bundle to one CommonJS file with builtins only, text assets are imported and materialized, mutations that may exceed 30 s must enqueue and return an id, and native code goes in an external prerequisite.
- Modify: `knip.jsonc` if the new package needs an entry

**Interfaces:**

- Consumes: `decodePluginManifest` (Task 1), the bridge method names (Task 2)
- Produces:
  - `connectT3(): Promise<T3PluginClient>` where `T3PluginClient = { context, onContextChange(cb), state: { get, set }, call(op, input), subscribe(topic, params, onEvent) → unsubscribe, openSurface(id), attach(req) }`
  - `definePluginBackend(def: { operations: Record<string, (input: unknown, ctx: OperationContext) => Promise<unknown>>; topics?: Record<string, TopicHandler>; resolveReference?: (locator) => Promise<{ title: string; detail: string }>; onStart?(ctx); onStop?() }): void`. `OperationContext = { caller: "ui" | "agent", signal: AbortSignal, dataDir, config, secrets, log }`. `signal` aborts when the host sends `cancel` for this call.
  - `TopicHandler = (params, emit: { snapshot(page: { items, revision, cursor }), batch(items, revision) }) => () => void`. The SDK throws if `batch` comes before the first `snapshot`. A `snapshot` over `maxPayloadBytes` throws. A `batch` over `maxBatchBytes` is split into ordered events that all carry the same `revision`. A single item over `maxBatchBytes` throws.
  - `materializeAsset(name: string, contents: string | Uint8Array): Promise<string>`. It writes to `<dataDir>/runtime/<sha256-16>-<name>` (see "Backend assets"), skips the write when the file already exists with the same hash, and returns the absolute path.
  - Worker protocol (host ↔ worker NDJSON JSON-RPC, version `1`, each line ≤ `PLUGIN_LIMITS.maxMessageBytes`, results ≤ `maxPayloadBytes`).
    - Host to worker: `initialize { apiVersion, pluginId, version, previousVersion?, dataDir, config, secrets }`, `invoke { operation, input, caller }`, `cancel { id }` (notification naming an `invoke` request id), `subscribe { subscriptionId, topic, params }`, `unsubscribe`, `resolveReference { locator }`, `shutdown`.
    - Worker to host: responses, `event { subscriptionId, event: PluginSubscriptionEvent /* snapshot or batch */ }`, `status { state, detail? }`.
    - `definePluginBackend` exits the process when stdin closes.
  - `packPlugin(dir: string, outFile: string): Promise<void>`.
    - It validates the manifest, bundles each `ui/*.ts` panel with esbuild into the matching panel HTML as an inline script, and fails if any panel HTML references a relative `src=` or `href=`.
    - When the manifest has a `backend`, it bundles the backend source (`backend/index.ts` by convention) to `backend.entry` with the esbuild settings in the decision table plus `loader: { ".py": "text", ".txt": "text" }`.
    - With `metafile: true`, it fails when any output import is `external` and not `NodeModule.isBuiltin`, when an input is a `.node` file, or when esbuild reports `unsupported-require-call` or `unsupported-dynamic-import`.
    - The archive holds only the manifest, panel HTML, and the one backend file. No source, asset file, or `node_modules` is ever packed.
  - `./testing` (tests only): `extractPluginArchive(archive, dir)` and `startPackedBackend({ entryPath, dataDir, config? })`. The second spawns `process.execPath <entryPath>` and returns a small protocol client (`initialize`, `invoke`, `cancel`, `subscribe`, `close`) plus the child PID. Plugin packages use it to test their packed archive with no server.

- [ ] **Step 1: Write failing tests.** In `pack.test.ts`: `refuses a panel HTML with a relative script src`, `refuses an invalid manifest with the decoder's message`, `produces a zip with t3-plugin.json at the root and inlined panel`, `bundles the echo backend, including @t3tools/plugin-sdk/backend, into one .cjs whose only requires are node builtins` (scan the output with the metafile and assert the archive's entry list), `refuses a backend that imports an unresolvable package`, `refuses a backend that requires a computed path`, and `embeds an imported .txt asset in the .cjs, and the archive lists exactly the manifest, panel HTML, and backend entry`. In `backend.test.ts`, drive `definePluginBackend` through in-memory streams:
  - `answers invoke with the handler result` and `reports unknown-operation`
  - `cancel aborts the operation's signal`
  - `emits a snapshot with revision and cursor, then batches, and stops on unsubscribe`
  - `batch before snapshot throws` and `an oversized batch is split in order under one revision`
  - `materializeAsset writes once per content hash under dataDir/runtime`
  - `exits on stdin EOF after running onStop`
- [ ] **Step 2:** Run `vp test run packages/plugin-sdk/src`. Expected: FAIL.
- [ ] **Step 3:** Implement. `backend.ts` takes injectable `{ input, output, exit }` for tests and defaults to the process streams.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter @t3tools/plugin-sdk typecheck`.
- [ ] **Step 5: Commit:** `feat(plugin-sdk): ui client, backend runtime and pack tool`

### Task 4: Client-only packages and the converter example

**Files:**

- Create: `packages/client-runtime/src/plugins/commands.ts` with only `PluginPanelKey` (`` `${EnvironmentId | "client"}:${PluginId}:${PluginContributionId}` ``), `pluginPanelKey`, and `parsePluginPanelKey`. Export `"./plugins/commands"`. Task 10 adds command resolution to this file.
- Create: `packages/client-runtime/src/plugins/clientPackages.ts`, `clientPackages.test.ts`. Pure logic: parse an archive via `boundedZip`, decode the manifest, refuse packages with a `backend`, compute `ClientPluginRecord`.
- Create: `apps/web/src/plugins/clientPluginStore.ts`, built on IndexedDB database `t3code-plugins` with stores `packages` and `panelState`. Same `indexedDB.open` pattern as `apps/web/src/assets/projectFaviconCache.ts:15`.
- Create: `apps/mobile/src/features/plugins/clientPluginStore.ts`, using `expo-file-system` under the document directory at `plugins/<id>/<version>/`.
- Create: `packages/plugin-converter/` (`t3-plugin.json`, `ui/converter.html`, `ui/converter.ts`, `package.json` with a `pack` script). Panel `converter` converts JSON format/minify, Base64, and URL encoding. It has an "Insert into chat" button that calls `attach({ kind: "text" })`. Command `open` opens the panel.

**Interfaces:**

- Consumes: Task 1 manifest helpers, Task 3 SDK ui
- Produces:
  - `ClientPluginRecord = { pluginId, version, name, enabled, manifest, panelHtml: Record<panelId, string> }`
  - `readClientPluginArchive(bytes: ArrayBuffer): Promise<ClientPluginRecord>`
  - Web and mobile `ClientPluginStore = { list(): Promise<ClientPluginRecord[]>; install(bytes): Promise<ClientPluginRecord> /* replaces an installed id (explicit client-only update) */; setEnabled(id, enabled); uninstall(id) /* keeps panelState */; deleteData(id); readState(panelKey): Promise<{ value: unknown; version: string } | null>; writeState(panelKey, value, version) }`

- [ ] **Step 1: Write failing tests** (`clientPackages.test.ts`): `refuses archives with a backend entry ("Install this plugin into an environment")`, `refuses incompatible hostApi`, `refuses a panel html over 5 MiB`, `loads the converter fixture` (archive built in-test with JSZip), `installing a newer version of an installed id replaces it and keeps panelState`.
- [ ] **Step 2:** Run `vp test run packages/client-runtime/src/plugins/clientPackages.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the pure reader and both stores. Uninstall removes the package and keeps `panelState`. `deleteData` removes `panelState` entries for the id.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter @t3tools/plugin-converter pack` and confirm `packages/plugin-converter/dist/converter-0.1.0.t3plugin` exists (`dist/` is gitignored).
- [ ] **Step 5: Commit:** `feat(plugins): client-only packages and converter example`

### Task 5: Server package store (install, verify, uninstall, data)

**Files:**

- Create: `apps/server/src/plugins/PluginPackageStore.ts`, `PluginPackageStore.test.ts`

**Interfaces:**

- Consumes: `ServerConfig.stateDir`, `resolveAttachmentPathById` (`apps/server/src/attachmentStore.ts`), `openZipArchive`, `writeFileStringAtomically`, `ServerSecretStore`, Task 1 helpers
- Produces (`Context.Service` `"t3/plugins/PluginPackageStore"`):

```ts
readonly installFromAttachment: (input: { attachmentId: string; trustBackendAuthor: boolean }) =>
  Effect.Effect<{ record: PluginInstallRecord; replaced: false }, PluginRequestError>;
readonly stageUpdate: (input: { pluginId: PluginId; attachmentId: string; trustBackendAuthor: boolean }) =>
  Effect.Effect<{ from: string; to: string; packageDir: string }, PluginRequestError>;
readonly commitVersion: (pluginId: PluginId, version: string) => Effect.Effect<void>;
readonly markFailedUpdate: (pluginId: PluginId, failed: { from: string; to: string; reason: string }) => Effect.Effect<void>;
readonly setEnabled: (pluginId: PluginId, enabled: boolean) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
readonly uninstall: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;   // keeps data/, config/, secrets
readonly deleteData: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>; // refused while installed+running
readonly snapshot: Effect.Effect<PluginRegistrySnapshot>;
readonly changes: Stream.Stream<PluginRegistrySnapshot>;
readonly paths: (pluginId: PluginId) => { packageDir: string; dataDir: string; configPath: string };
readonly readConfig / writeConfig: ... // non-secret fields in config/<id>.json; secret fields via ServerSecretStore `plugin.<id>.<key>`, reads return { set: boolean }
```

- [ ] **Step 1: Write failing tests** (`it.effect`, temp state dir):
  - `installs a backend package only with trustBackendAuthor` (false → `capability-denied`), and `installs a UI-only package without it` (an environment may host UI-only packages; no worker starts)
  - `refuses path traversal entries and symlinks in the archive` (`invalid-package`)
  - `refuses incompatible hostApi before touching the registry`
  - `refuses a backend package whose manifest entry is missing from the archive` (`invalid-package`)
  - `uninstall removes registry and package but retains data and lists it under retainedData`
  - `deleteData removes data, config and plugin secrets`
  - `stageUpdate validates the new archive without changing the active version` (registry still shows the old version)
  - `registry writes are atomic` (a failed write leaves the previous `registry.json` decodable)
  - `config reads never return secret values`
- [ ] **Step 2:** Run `vp test run apps/server/src/plugins/PluginPackageStore.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Extract into `packages/<id>/<version>.tmp-<random>/`, then rename into place. Guard concurrent mutations of one plugin with `KeyedLock`.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter t3 typecheck`.
- [ ] **Step 5: Commit:** `feat(server): plugin package store`

### Task 6: Worker supervisor and `t3 plugin-worker` fast path

**Files:**

- Create: `apps/server/src/plugins/PluginWorkerSupervisor.ts`, `PluginWorkerSupervisor.test.ts`, `apps/server/src/plugins/pluginWorkerEntry.ts`
- Modify: `apps/server/src/bin.ts:35-37`. Add a `command === "plugin-worker"` branch beside `acp-mcp-bridge`. It runs `(await import("./plugins/pluginWorkerEntry.ts")).run(process.argv.slice(3))`. `run` checks that the argument is an absolute `.cjs` path, then loads it with `NodeModule.createRequire(import.meta.url)(entryPath)`. It never uses `import(pathToFileURL(...))`, which the SEA cannot resolve.
- Modify: `apps/server/package.json` (devDependency `@t3tools/plugin-sdk: workspace:*`, used by tests to pack the echo fixture)

**Interfaces:**

- Consumes: `resolveSelfInvocation`/`selfInvocationArgs` (`packages/shared/src/nodeRuntime.ts`), `ChildProcessSpawner`, Task 3 protocol and `packPlugin`, Task 5 `installFromAttachment`/`paths` (tests)
- Produces (`"t3/plugins/PluginWorkerSupervisor"`):

```ts
readonly start: (input: { pluginId; version; entryPath; dataDir; config; secrets; previousVersion?; prerequisites }) =>
  Effect.Effect<void, PluginRequestError>;                // checks prerequisites on PATH first → status missing-prerequisite
readonly stop: (pluginId: PluginId) => Effect.Effect<void>; // shutdown request, 5 s grace, then kill captured PID (process group on POSIX, `taskkill /T /PID` on Windows)
readonly invoke: (pluginId, req: { operation; input; caller: "ui" | "agent" }) => Effect.Effect<unknown, PluginRequestError>;
  // 30 s timeout → timed-out, never retried. On timeout or interruption it sends `cancel { id }` and drops a late response.
  // Result ≤ PLUGIN_LIMITS.maxPayloadBytes. Plugin-thrown errors → operation-failed with bounded detail.
readonly subscribe: (pluginId, topic, params) => Stream.Stream<PluginSubscriptionEvent, PluginRequestError>;
  // One worker subscription per stream. A first event that is not a snapshot → closed protocol-error. A snapshot over
  // maxPayloadBytes or a batch over maxBatchBytes → closed too-large. Ending the stream sends unsubscribe.
readonly resolveReference: (pluginId, locator) => Effect.Effect<{ title: string; detail: string }, PluginRequestError>;
readonly status: (pluginId) => Effect.Effect<{ status: PluginRuntimeStatus; detail?: string }>;
readonly statusChanges: Stream.Stream<{ pluginId: PluginId; status: PluginRuntimeStatus; detail?: string }>;
readonly logs: (pluginId, limit ≤ 500) => Effect.Effect<ReadonlyArray<{ at: number; line: string }>>; // ring: 1000 lines / 256 KiB, lines truncated at 2 KiB; returns the newest lines that fit PLUGIN_LIMITS.maxPayloadBytes
```

- [ ] **Step 1: Write failing tests** (`it.live`, spawning the echo fixture; subprocess fixtures are allowed live). A shared test helper packs `packages/plugin-sdk/src/testFixtures/echo` with `packPlugin` into a fresh `os.tmpdir()` directory. It places the archive as an attachment in a temporary `stateDir` under the same directory, at the path `resolveAttachmentPathById` reads, then installs it with `PluginPackageStore.installFromAttachment`. The worker therefore runs from a path with no `node_modules` ancestor, unlike a worktree's `.t3` state, which would resolve from the repo:
  - `packed backend runs from a state dir outside the repository` (assert no ancestor of the installed entry contains `node_modules`, then start and invoke)
  - `start reports running and invoke round-trips`
  - `missing prerequisite yields missing-prerequisite without spawning`
  - `crash moves status to failed and keeps the last 1000 log lines`
  - `stop terminates the captured process group` (fixture spawns a sleeping child and reports its pid; assert both pids are gone via `process.kill(pid, 0)` throwing ESRCH)
  - `worker exits and stops its children when the host pipe closes`
  - `worker results over maxPayloadBytes, or lines over maxMessageBytes, fail with too-large and the worker keeps serving`
  - `packed backend materializes its embedded asset under dataDir/runtime` (invoke `asset`, read the returned path, and assert it is under the installed plugin's `dataDir` and its text matches)
  - `a batch before the first snapshot closes the subscription with protocol-error`

  Timeout and cancel run on `it.effect` with the `TestClock`, against the supervisor's protocol connection over in-memory streams (`makeWorkerConnection(input, output)`), not a spawned worker:
  - `invoke times out with timed-out after 30 s, sends cancel, and drops the late response`
  - `interrupting invoke sends cancel for that request id`

- [ ] **Step 2:** Run `vp test run apps/server/src/plugins/PluginWorkerSupervisor.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `detached: true` (POSIX process group). Record the spawn PID only. Never look up processes by name. Keep the JSON-RPC framing, timeout, and cancel logic in `makeWorkerConnection`, so the clock-driven tests need no subprocess.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): plugin worker supervisor`

### Task 7: PluginService, RPC contracts, and authorization

**Files:**

- Create: `apps/server/src/plugins/PluginService.ts`, `PluginService.test.ts`
- Modify: `packages/contracts/src/rpc.ts` (add `WS_METHODS.plugins*` beside `mcpApps*` at line 641, plus `Rpc.make` entries like lines 1677-1690. Stream RPCs use `stream: true`), `packages/contracts/src/clientRpcPermissions.ts:20` (guarded mutations), `apps/server/src/auth/RpcAuthorization.ts:40+` (scopes per the decision table), `apps/server/src/ws.ts:3137` neighborhood (thin handlers), `apps/server/src/server.ts` (layer wiring), `apps/server/src/observability/RpcInstrumentation.ts` if it enumerates methods
- Modify: `apps/server/src/auth/RpcAuthorization.test.ts` (extend the scope table)
- Create: `packages/client-runtime/src/state/plugins.ts`. `createPluginEnvironmentAtoms(runtime)` uses `createEnvironmentRpcCommand` and `createEnvironmentRpcSubscriptionAtomFamily` (registry subscription, lifecycle and operation commands), like `packages/client-runtime/src/state/mcpApps.ts`. Also create the thin `apps/web/src/state/plugins.ts` and `apps/mobile/src/state/plugins.ts` bindings, mirroring each app's `state/mcpApps.ts`. They are created here because Task 9's selection UI is their first consumer.

**Interfaces:**

- Consumes: Tasks 5 and 6
- Produces RPCs (all new): `plugins.list`, `plugins.subscribeRegistry` (stream of `PluginRegistrySnapshot`), `plugins.install { attachmentId, trustBackendAuthor }`, `plugins.update { pluginId, attachmentId, trustBackendAuthor }`, `plugins.uninstall`, `plugins.deleteData`, `plugins.setEnabled`, `plugins.start`, `plugins.stop`, `plugins.restart`, `plugins.configure { pluginId, values }`, `plugins.readConfig`, `plugins.logs`, `plugins.query { pluginId, operation, input, expectedVersion? }` (non-mutating only), `plugins.mutate` (same input, mutating only), `plugins.subscribe { pluginId, topic, params, expectedVersion? }` (stream of `PluginSubscriptionEvent`), `plugins.resolveReference { pluginId, locator }`. Panel calls always send `expectedVersion`. When it differs from the active version, the call fails with `version-changed` before reaching the worker. Agent calls and references omit it
- Produces service (`"t3/plugins/PluginService"`). It mirrors the RPCs, plus `callOperation(input: { pluginId; operation; input; caller: "ui" | "agent" })` and `agentCatalog: Effect<ReadonlyArray<{ pluginId; name; operations: PluginOperationDecl[]; resources }>>` (enabled plugins only, consumed by Task 9)
- Lifecycle semantics: `setEnabled(false)` stops the worker and closes subscriptions with `closed: "plugin-disabled"`. `update` closes them with `plugin-updated` and `uninstall` with `plugin-uninstalled`, before the worker stops. Startup starts enabled backends in the background, and one failing does not block server start. `update` runs stageUpdate, stop, commitVersion, then start with `previousVersion`. If start or migration fails, it calls `markFailedUpdate` and reports `failed` with the text "Update to X failed during start; data may already be migrated." No rollback.
- Payload bounds: `query`, `mutate`, and `resolveReference` inputs and results, and `configure` values, are each capped at `PLUGIN_LIMITS.maxPayloadBytes`. Larger inputs fail with `too-large` before reaching the worker.
- Subscription bounds: at most 8 subscriptions per client connection per plugin and 64 per plugin. Batches coalesce every 250 ms, at most 200 items or `maxBatchBytes` per batch. A merged batch carries the `revision` of its last source batch. A worker batch over 200 items is split in order, and every piece keeps its `revision`. A snapshot is at most `maxPayloadBytes`. A topic with more data puts a window in the snapshot and returns a non-null `cursor`. The panel pages older items with one of the plugin's non-mutating operations, which takes that cursor and returns `{ items, cursor, revision }`. The host passes `revision` and `cursor` through without reading them.
- Overflow and reconnect: the per-subscription queue holds 16 batches. On overflow the service unsubscribes the worker subscription, emits `resync`, and subscribes again under a new worker subscription id. Events still arriving for the old id are dropped, so the next event the client sees is the new snapshot. A client reconnect ends the RPC stream, which unsubscribes. The bridge's `hostReconnected` subscribes again and gets a new snapshot the same way.

- [ ] **Step 1: Write failing tests** (`PluginService.test.ts`, worker supervisor stubbed by a test layer, since the supervisor is an external process boundary):
  - `query refuses mutating operations and mutate refuses read-only ones` (`operation-mutates`)
  - `calls after disable fail with plugin-disabled and re-enable restores them`
  - `disable closes live subscriptions with plugin-disabled`
  - `subscription overflow emits resync, resubscribes the worker, drops events from the old worker subscription, and the next event is a snapshot`
  - `calls with a stale expectedVersion fail with version-changed without reaching the worker`
  - `update closes live subscriptions with plugin-updated`
  - `ninth subscription from one connection fails with subscription-limit`
  - `query input over maxPayloadBytes fails with too-large without reaching the worker`
  - `failed update records failedUpdate and does not report the new version as running`
  - `uninstall while running stops the worker first`
  - In `RpcAuthorization.test.ts`, add rows: `plugins.install requires environment:maintain`, `plugins.mutate requires orchestration:operate`, `plugins.logs requires diagnostics:read`.
- [ ] **Step 2:** Run `vp test run apps/server/src/plugins/PluginService.test.ts apps/server/src/auth/RpcAuthorization.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the service. Each ws handler decodes, calls one method, and maps errors (AGENTS.md "Taste").
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter t3 typecheck`, `vp run --filter @t3tools/contracts typecheck`, `vp run --filter @t3tools/client-runtime typecheck`, `vp run --filter @t3tools/web typecheck`, and `vp run --filter @t3tools/mobile typecheck`.
- [ ] **Step 5: Commit:** `feat(server): plugin service and RPCs`

### Task 8: Authenticated panel asset delivery

**Files:**

- Modify: `packages/contracts/src/assets.ts:20-62`. Add `Schema.TaggedStruct("plugin-panel", { pluginId: PluginId, panelId: PluginContributionId, version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)) })`. The version is in the resource, so it is part of the signed token and of the client's long-lived URL cache key (`longLivedAssetUrls.ts:63`).
- Modify: `apps/server/src/assets/AssetAccess.ts`. Resolve `plugin-panel` through `PluginPackageStore.paths` to the panel file only when `version` is the active version. Any other version, or a disabled or uninstalled plugin, returns not found. A frame cached for the old version therefore cannot load after an update, and the client mints a new URL because the key changed.
- Modify: `apps/server/src/http.ts:161-195`. Serve plugin panel HTML like `renderIntent: "mcp-app"`: bounded read, `injectMcpAppThemeBootstrap`, `injectMcpAppCookieBootstrap`, and a CSP meta with `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'`.
- Test: `apps/server/src/assets/AssetAccess.test.ts` (extend the existing table)

**Interfaces:**

- Consumes: Task 5 `paths`, the existing `AssetCreateUrl` RPC
- Produces: `AssetResource` `_tag: "plugin-panel"`, used by Tasks 10 and 11

- [ ] **Step 1: Write failing tests** (extend existing cases): `mints and serves plugin-panel html with injected CSP`, `returns not found for a disabled or uninstalled plugin`, `a resource naming a non-active version is not found, before and after update to B`.
- [ ] **Step 2:** Run `vp test run apps/server/src/assets/AssetAccess.test.ts apps/server/src/http.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): authenticated plugin panel assets`

### Task 9: Agent tools, resources, and assistant policy through the catalog gateway

**Files:**

- Modify: `apps/server/src/mcp/McpCatalogGateway.ts:118-276` (`makeServer`). Add a `plugins` source alongside `generation.connections`. Every handler checks plugin names and URIs before calling `named()` or `resource()`, which throw on non-catalog items:
  - `ListTools` appends `pluginAgentTools(manifest)` for each enabled plugin. When `allowed !== undefined` (an assistant thread), it keeps only tools whose `pluginToolPolicyKey(pluginId, op)` is in `allowed`. This is the same filter shape as catalog tools at lines 150-156.
  - `CallTool` routes names that `parsePluginToolName` accepts to `PluginService.callOperation(caller: "agent")`. Before calling, it rejects an operation that is unknown or not `agent: true` (`unknown-operation`). Under an assistant policy, it rejects a key not in `allowed` with the existing text "This tool is not selected in the assistant configuration." (line 173).
  - `ListResources` appends `{ uri: pluginResourceUri(pluginId, name), name, title }` for each enabled plugin. `ReadResource` routes `t3-plugin://` URIs to the declared non-mutating operation with empty input and returns its JSON result as one `text` content (≤ `maxPayloadBytes`). Under an assistant policy, both keep today's behavior at lines 182-183 and 224-226: empty list, and a refused read. Assistants therefore get plugin data only through selected tools.
  - Mutating calls first load the calling thread (`ThreadManagementService.getThreadShell(generation.session.threadId)`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:424`) and require `runtimeMode === "full-access" && interactionMode === "default"`. This is the same rule as `assertFullAccess` in `apps/server/src/mcp/threadAccess.ts:154-157`. Otherwise they fail with the exported constant `PLUGIN_MUTATION_REFUSED_MESSAGE` = "This tool changes state; the thread needs full access."
- Modify: `apps/server/src/mcp/McpCatalogGateway.ts:456-458` layer (provide `PluginService`)
- Modify (assistant selection, end to end):
  - `packages/contracts/src/assistants.ts:39-54`. Add `plugins: Schema.optionalKey(Schema.Array(Schema.Struct({ pluginId: PluginId, operations: Schema.Array(PluginOperationName).check(Schema.isMaxLength(64)) })).check(Schema.isMaxLength(50)))` to `AssistantResourceSelection`. Leave it absent rather than `[]` when nothing is selected, so existing configuration hashes do not change.
  - `apps/server/src/assistants/AssistantResources.ts:139,152`. Both `toolIds` builders append `pluginToolPolicyKey(pluginId, op)` for every selected plugin operation.
  - `apps/server/src/assistants/AssistantNativeResources.ts:49-54`. The `current` set also includes the selected plugin keys, so the admitted snapshot is intersected with the current configuration exactly as catalog tools are.
  - `packages/client-runtime/src/assistantPresentation.ts` (beside `setAssistantMcpTools`, line 355): `setAssistantPluginOperations(resources, pluginId, operations)`. It removes the plugin entry when `operations` is empty and drops the key when no entries remain.
  - `apps/web/src/components/assistants/AgentResourceBindings.tsx:261-292`: a "Plugin tools" row lists each installed plugin's `agent: true` operations in the assistant's environment (from Task 7's `apps/web/src/state/plugins.ts` registry atom) as checkboxes. Selected operations of a plugin that is no longer installed show as "Unavailable plugin" with a Remove action. Mirror this in `apps/mobile/src/features/assistants/AssistantResources.tsx:99,236`.
- Test: `apps/server/src/mcp/McpCatalogGateway.test.ts`, `apps/server/src/assistants/AssistantNativeResources.test.ts`, `packages/contracts/src/assistants.test.ts`
- Test (verification only, no adapter changes): extend the nearest existing OpenCode2 MCP test under `packages/provider-opencode/src/server/v2/` with a protocol fixture demonstrating that the provider discovers and invokes a catalog tool and receives its result. Registering the catalog server alone does not prove tool support. Mark the OpenCode2 row supported only after this protocol proof and the integrated agent check pass; otherwise leave it unsupported.
- Evals: none in this task. The inspector cases, including the refusal message, live in Task 13, after the inspector manifest exists.

**Interfaces:**

- Consumes: `PluginService.agentCatalog`, `callOperation` (Task 7), `pluginToolName`/`parsePluginToolName`/`pluginToolPolicyKey`/`pluginResourceUri`/`pluginAgentTools` (Task 1), Task 7 registry atoms (selection UI)
- Produces: plugin tools visible in every provider listed as supported in the matrix, `AssistantResourceSelection.plugins`, `setAssistantPluginOperations`, `PLUGIN_MUTATION_REFUSED_MESSAGE`

- [ ] **Step 1: Write failing tests**
  - `McpCatalogGateway.test.ts` (`it.effect`, using the existing session fixtures at lines 95-209):
    - `lists plugin agent tools with read-only and destructive hints`
    - `omits non-agent operations and refuses calling them by name`
    - `disabling a plugin removes its tools from the next list and fails in-flight names with plugin-disabled`
    - `mutating plugin tool is refused for a non-full-access thread`
    - `assistant policy lists and calls only selected plugin operations` (policy stub returning `["plugin:echo:ping"]`: `ping` listed and callable, `pong` hidden and refused with the assistant-selection message)
    - `assistant policy hides plugin resources and refuses reading them`; without a policy, `reads a plugin resource through its declared operation`
    - `plugin tools work with zero catalog entries` (empty generation path, lines 410-428)
  - `AssistantNativeResources.test.ts`: `returns selected plugin keys that are present in the admitted snapshot` and `drops a plugin key that was deselected after admission`.
  - Contracts: `decodes a stored assistant configuration without plugins` (existing fixture, unchanged).
- [ ] **Step 2:** Run `vp test run apps/server/src/mcp/McpCatalogGateway.test.ts apps/server/src/assistants/AssistantNativeResources.test.ts packages/contracts/src/assistants.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter t3 typecheck`, `vp run --filter @t3tools/contracts typecheck`, `vp run --filter @t3tools/client-runtime typecheck`, `vp run --filter @t3tools/web typecheck`, and `vp run --filter @t3tools/mobile typecheck`.
- [ ] **Step 5: Commit:** `feat(server): expose plugin operations through the MCP catalog gateway`

### Task 10: Web and desktop panel hosts, panel store, and entry points

**Files:**

- Modify: `packages/client-runtime/src/plugins/commands.ts` (from Task 4). Create `commands.test.ts`. Add pure logic shared by web and mobile:
  - `listPluginPanelTargets(installs)` returns one entry per (scope, panel) and one per (scope, command), with a scope label ("On this device" or the environment label).
  - `resolvePluginCommand({ pluginId, commandId }, installs, chatEnvironmentId)` returns `{ kind: "open"; key } | { kind: "choose"; title; candidates } | { kind: "missing" }`, with the precedence in "Command resolution". The command resolves to its panel only through the manifest's `opens.panel`.
  - `installs` is `Array<{ scope: EnvironmentId | "client"; scopeLabel; record: { pluginId; version; manifest } }>`, built from the client store and each connected environment's registry atom.
- Create: `apps/web/src/pluginPanelStore.ts`, `pluginPanelStore.test.ts`. Persisted zustand under key `t3code:plugin-panels:v1`, holding docked-panel state per environment.
- Create: `apps/web/src/plugins/openPluginPanel.ts`, `openPluginPanel.test.ts`. A pure `resolvePluginOpenTarget(input: { scope: string /* environmentId | "client" */; chat: { environmentId: string } | null }): "dock" | "page"` returns `"dock"` only when a chat view is showing and the scope is `"client"` or that chat's environment. Otherwise it returns `"page"`. `openPluginPanel(key)` reads the current chat from the router match (thread or draft route), then calls `pluginPanelStore.open` for `"dock"` or navigates to the plugin route for `"page"`. The sidebar, the command palette, the keybinding, and Settings all call `openPluginPanel`.
- Create: `apps/web/src/routes/_chat.plugins.$scope.$pluginId.$panelId.tsx` and `apps/web/src/components/plugins/PluginPanelPage.tsx`. This is a thread-free page in `SidebarInset` with `WorkspacePageHeader`, following `_chat.pull-requests.tsx`. It renders `PluginPanelSurface` full-size. `chatTarget` is the most recently viewed thread in the same environment (client scope uses the most recent of any), or `null`. With `null`, attach is refused with "Open a chat to attach this." An unknown plugin or panel shows an empty state with a link to Settings → Plugins.
- Create: `apps/web/src/components/plugins/PluginPanelFrame.tsx` (sandboxed iframe, `sandbox="allow-scripts allow-forms"` as in `McpAppFrame.tsx:470`. Server panels use a `src` from `useLongLivedAssetUrl` (`apps/web/src/assets/longLivedAssetUrls.ts:71`) with resource `plugin-panel { pluginId, panelId, version }`. Client panels use `srcdoc` from the record of that version. Messages are accepted only from `frame.contentWindow`).
- Create: `apps/web/src/components/plugins/PluginPanelSurface.tsx`. It takes `{ panelKey: PluginPanelKey; chatTarget: PluginHostContext["chatTarget"] }` and never a `ScopedThreadRef`.
  - It reads the install record for `panelKey` (registry atom or client store) and shows one of: not installed (link to Settings → Plugins), disabled (Enable), not running (Start, only when the manifest has a backend), failed (status detail, plus the `failedUpdate` text when present, with Restart and Logs), or the frame. Only the last mounts a frame.
  - The frame and its bridge are keyed by `${panelKey}@${version}`. When the record's version changes (an update from any client, or a client-only reinstall), the old bridge is disposed, which releases its subscriptions. A new URL is minted for the new version and the frame remounts. The backend adapter sends `expectedVersion` on every call and subscribe, and passes `version-changed` to the panel as an ordinary error.
  - Bridge `state` reads and writes the client plugin store's `panelState` under `panelKey` as `{ value, version }`, for client and environment panels alike. State survives thread switches, route changes, frame remounts, and updates, and the new UI decides whether to use state written by an older version.
- Modify: `apps/web/src/rightPanelStore.ts:16-91`. Add `"plugin"` to `RIGHT_PANEL_KINDS` and the surface `{ id: \`plugin:${string}\`; kind: "plugin"; panelKey: PluginPanelKey }`, used only for tabs. The persist `migrate`/sanitize step drops `kind: "plugin"`entries from`byThreadKey`. Bump `RIGHT_PANEL_STORAGE_VERSION` (line 90) from 14 to 15.
- Modify: `apps/web/src/components/ChatView.tsx`:
  - Around 1053-1092: `docked = pluginStore.focused(chatEnvironmentId)`, where `chatEnvironmentId` is the active or draft thread's environment. `surfaces = [...thread.surfaces, ...pluginSurfaces(chatEnvironmentId)]`, and `activeSurfaceId = docked ?? thread.activeSurfaceId`. Change the presence condition at 1081-1083 to `(rightPanelOpen && activeThreadRef !== null) || docked !== null`. Activating a non-plugin surface calls `pluginStore.blur(chatEnvironmentId)`.
  - Around 3260: build `rightPanelContent` as `docked ? <PluginPanelSurface key={docked} panelKey={docked} chatTarget={currentChat} /> : activeThreadRef ? <RightPanelSurfaceContent …/> : undefined`. The plugin branch comes before, and does not depend on, `activeThreadRef`. Keying by `panelKey` keeps the frame mounted across thread switches whenever ChatView itself stays mounted. When ChatView remounts (keys at `ThreadRouteView.tsx:150,174,198`), the panel restores from bridge `state`.
- Modify: `apps/web/src/components/RightPanelTabs.tsx` (tab title and icon from the manifest). `RightPanelSurfaceContent.tsx` is unchanged, because it requires a `threadRef`.
- Modify: `apps/web/src/components/sidebar/SidebarChrome.tsx:228-310`. Add a "Plugins" utility item that opens a popover built from `listPluginPanelTargets`: client panels, plus each connected environment's panels, labeled by scope. Selecting one calls `openPluginPanel(key)` with that explicit key.
- Modify: `apps/web/src/components/CommandPalette.logic.ts`. New `buildPluginPanelItems` makes one item per panel target and per command target, titled `<title> — <scope label>`, each opening its explicit key.
- Create: `apps/web/src/shortcuts/pluginCommands.ts`. `installPluginCommands(router)` registers a `registerCommands` scope whose handler map has one `plugin.<pluginId>.<commandId>` key per declared command across all installs. It re-registers (disposing the previous scope) when the client store or a registry atom changes. Each handler calls `resolvePluginCommand` with the current route's chat environment. On `open` it calls `openPluginPanel`. On `choose` it opens the palette with the command title as the query (`openCommandPalette({ query })`), where each scope is listed. On `missing` it returns `false`. Install it beside `installCommandPaletteCommands`.
- Create: `apps/web/src/routes/_chat.settings.plugins.tsx`, `apps/web/src/components/settings/PluginsSettings.tsx`. The page has two sections. "On this device" covers client-only install, enable, disable, uninstall, delete data, and Open. "On <environment>" covers upload install with an author-trust confirmation, enable, disable, start, stop, restart, status, logs, configure (secrets shown as set or unset), update, uninstall, delete data, retained data, and Open. Modify `apps/web/src/components/settings/settingsSearch.ts` to add the route entry.

**Interfaces:**

- Consumes: Tasks 1 (`PLUGIN_OPEN_COMMAND_PATTERN`), 2, 4, 7 (including the plugin state atoms), 8
- Produces:

```ts
// PluginPanelKey, listPluginPanelTargets, resolvePluginCommand: packages/client-runtime/src/plugins/commands.ts (above)
interface PluginPanelStoreState {
  byEnvironment: Record<string, { open: PluginPanelKey[]; focused: PluginPanelKey | null }>;
  open: (environmentId: string | "client", pluginId: string, panelId: string) => void; // also focuses
  focus / blur / close: (...) => void;
  dropPlugin: (environmentId: string | "client", pluginId: string) => void; // on uninstall
}
export function resolvePluginOpenTarget(input: { scope: string; chat: { environmentId: string } | null }): "dock" | "page";
export function openPluginPanel(key: PluginPanelKey): void;
```

Docked client-scoped (`"client"`) panels appear in every environment's tab list. Docked environment panels appear only in their own environment. The page route shows any panel regardless of the current chat.

- [ ] **Step 1: Write failing tests.**
  - `pluginPanelStore.test.ts`: `focused panel survives switching threads in the same environment` (pure selector over two thread refs), `switching environment selects that environment's instance`, `client panels appear for every environment`, `dropPlugin removes open and focused entries`.
  - `openPluginPanel.test.ts` (table): no chat → page; chat in env A with scope A → dock; scope `client` with a chat → dock; chat in env A with scope B → page.
  - `packages/client-runtime/src/plugins/commands.test.ts` (table over installs in env A, env B, and client, with command `open` → panel `converter`):
    - `plugin.converter.open` resolves to panel `converter`, never to a panel named `open`.
    - Chat in A, installed in A, B, and client → A.
    - Chat in A, installed in B and client → client.
    - No chat, installed only in B → B.
    - No chat, installed in A and B → `choose` with both candidates.
    - Unknown command id → `missing`.
    - `listPluginPanelTargets` gives distinct keys and scope labels for the same plugin in A, B, and client.
  - Extend `rightPanelStore.test.ts` with `persisted plugin surfaces in thread state are dropped on load`.
  - Browser test `apps/web/src/components/plugins/PluginPanelFrame.browser.test.tsx` (`await using screen = await render(...)`): `ignores messages from other windows`, `shows Enable for a disabled plugin and does not mount the frame`, and `remounts on the new version when another client updates the plugin`. The registry atom changes from v1 to v2 while the panel is open. Assert that the v1 bridge's subscription is released, the frame `src` names a v2 resource, and `t3/state.get` in the new frame returns the v1-written value with `version: "1"`.
  - Browser test `apps/web/src/components/plugins/PluginPanelPage.browser.test.tsx` (`router: "/plugins/client/converter/converter"`, no thread exists, client store seeded with the converter fixture): `opens a client panel with no chat selected and refuses attach with "Open a chat to attach this."`, and `restores bridge state after the page unmounts and remounts` (the panel writes state, the test navigates to `/settings/plugins` and back, then asserts that `t3/state.get` returns the written value).
- [ ] **Step 2:** Run `vp test run packages/client-runtime/src/plugins/commands.test.ts apps/web/src/pluginPanelStore.test.ts apps/web/src/plugins/openPluginPanel.test.ts apps/web/src/rightPanelStore.test.ts apps/web/src/components/plugins/PluginPanelFrame.browser.test.tsx apps/web/src/components/plugins/PluginPanelPage.browser.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Desktop uses the same code with no Electron APIs. The frame never gets `allow-same-origin`.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter @t3tools/client-runtime typecheck` and `vp run --filter @t3tools/web typecheck`.
- [ ] **Step 5: Commit:** `feat(web): persistent plugin panels, settings and entry points`

### Task 11: Mobile host and screens

**Files:**

- Create: `apps/mobile/src/features/plugins/PluginWebView.tsx`. Same outer-document plus secret-relay pattern as `apps/mobile/src/features/threads/McpAppWebView.tsx:51-60`. The inner iframe uses `src` (server, `plugin-panel` resource with `version`) or `srcdoc` (client), and the bridge comes from `@t3tools/client-runtime/plugins/bridge`. The WebView and bridge are keyed by `${panelKey}@${version}` and show the same disabled, not-running, and failed states as web, with the same `expectedVersion` and `{ value, version }` state rules.
- Create: `apps/mobile/src/features/plugins/PluginPanelRouteScreen.tsx`, `PluginsSettingsRouteScreen.tsx` (using `apps/mobile/src/state/plugins.ts` from Task 7)
- Modify: `apps/mobile/src/Stack.tsx`. Add `Plugins` (linking `settings/plugins`, `SETTINGS_PAGE_OPTIONS`) and `PluginPanel` (linking `plugins/:scope/:pluginId/:panelId`, `GLASS_HEADER_OPTIONS`) near `SettingsUsage` at line 475. Drill in with `StackActions.push` per `docs/internals/mobile-navigation.md`.
- Modify: `apps/mobile/src/features/settings/settings-navigation.ts` (Plugins row), `apps/mobile/src/features/keyboard/CommandPalette.tsx` (panel and command items from `listPluginPanelTargets`, each with its scope label and explicit key; mobile has no plugin keybindings)

**Interfaces:**

- Consumes: Tasks 2, 4, 7, 8, 10 (`listPluginPanelTargets`), and the mobile `ClientPluginStore`
- Produces: a mobile panel screen that is independent of any thread. Attach uses the most recently viewed thread as `chatTarget` and always confirms.

- [ ] **Step 1: Write a failing test:** `apps/mobile/src/features/plugins/pluginRelay.test.ts`. It covers the pure relay decoder extracted from `PluginWebView`: `drops relayed messages without the secret`.
- [ ] **Step 2:** Run `vp test run apps/mobile/src/features/plugins/pluginRelay.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS. Run `vp run --filter @t3tools/mobile typecheck`.
- [ ] **Step 5: Commit:** `feat(mobile): plugin panel screen and settings`

### Task 12: Chat attachments and plugin references

**Files:**

- Modify: `packages/contracts/src/composerContext.ts:200-275`. Add `PluginReferenceContextRecord`:

  ```ts
  { ...recordBase, kind: "plugin-reference", referenceVersion: 1,
    environmentId, pluginId, pluginName (≤ 64), locator: Record<string, ≤ 256 chars> (≤ 8 keys),
    snapshot: ≤ 8_000 chars, snapshotTruncated: boolean }
  ```

  Add it to `KnownComposerContextRecord`, and add `plugin-reference` to the known-kind exclusion so `UnknownContextRecord` rejects it.

- Modify: `packages/shared/src/composerContextReferences.ts:247-310`. Projection marker `[Plugin <pluginName>: <label>; ref=<ctx>]`. Envelope entry `<context kind="plugin-reference" id environment plugin>` holds the escaped snapshot plus `locator` JSON, followed by the line "Fetch more with the plugin's tools if needed; this is a snapshot." This is model-facing text, covered by eval case (d) in Task 13, which needs the inspector's tools.
- Modify: `apps/web/src/composerDraftStore.ts:603-620` (`addPluginReferences`/`setPluginReferences`, modeled on `addEnvironmentContexts`), `apps/web/src/components/contextPresentationRegistry.ts` (chip with plugin icon; fallback "Plugin unavailable" when the plugin is not installed in that environment), `apps/web/src/components/chat/UserMessageContextChips.tsx` (expand calls `plugins.resolveReference` on click only)
- Create: `apps/web/src/components/plugins/PluginAttachConfirm.tsx`. The web `attach` implementation for the bridge works as follows:
  - Refuse when there is no chat target ("Open a chat to attach this.").
  - Compare `expectedChatTargetKey` with the current target. On mismatch, or always for `reference`, show the confirm dialog naming the destination thread.
  - `text` inserts into the composer draft.
  - `reference` adds a record. A reference is allowed only when the plugin's environment equals the target thread's environment. Otherwise refuse with "This capture belongs to <env>; attach it from a chat in that environment."
- Modify: `apps/mobile/src/lib/composerContext.ts`, `apps/mobile/src/features/threads/ThreadFeed.tsx` (chip and fallback)
- Test: `packages/contracts/src/composerContext.test.ts`, `packages/shared/src/composerContextReferences.test.ts`, `apps/web/src/components/plugins/PluginAttachConfirm.browser.test.tsx`

**Interfaces:**

- Consumes: Task 2 `PluginAttachRequest`, Task 7 `plugins.resolveReference`
- Produces: `PluginReferenceContextRecord`

- [ ] **Step 1: Write failing tests:** `decodes a plugin-reference record and rejects 9 locator keys`, `projects plugin-reference with escaped snapshot and unavailable fallback for missing records`, `attach refuses when target changed since request until confirmed` (browser test), `attach refuses a reference into another environment's thread`.
- [ ] **Step 2:** Run `vp test run packages/contracts/src/composerContext.test.ts packages/shared/src/composerContextReferences.test.ts apps/web/src/components/plugins/PluginAttachConfirm.browser.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Rendering an unavailable reference never calls a plugin tool.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: plugin chat references and attachments`

### Task 13: Request inspector plugin and its evals

**Files:**

- Create: `packages/plugin-request-inspector/` containing:
  - `t3-plugin.json`: id `request-inspector`, backend entry `backend/index.cjs`. `prerequisites: [{ executable: "mitmdump", hint: "Install mitmproxy (https://mitmproxy.org) and make mitmdump available on PATH." }]`. Environment settings: `listenHost` (default `127.0.0.1`), `listenPort` (default `8080`), `maxBodyBytes` (default 1 MiB, range 0 to 16 MiB; the captured prefix kept per body), `maxDiskBytes` (default 512 MiB, minimum 64 MiB; the inspector's whole storage budget, see "Storage budget" below), `maxRequestsPerCapture` (default 50 000). Capabilities `chat.attach`, `chat.reference`.
  - `backend/index.ts` (`definePluginBackend`; packed to `backend/index.cjs`). `backend/store.ts` uses `node:sqlite` in `dataDir/inspector.sqlite`, schema versioned by `PRAGMA user_version`. Headers are an ordered list of `[name, value]` byte pairs, so duplicates and order survive. Each body is stored as raw wire bytes (still content-encoded) in a blob table with `capturedBytes`, `declaredBytes?` (from `Content-Length`), `truncated`, and `contentEncoding`.
    - Each record has an insertion `id` and a `seq` taken from one store-wide counter on every insert, update, and prune. The `revision` the `requests` topic emits is the decimal `seq` high-water mark.
    - A `replays` table: `replayId`, `idempotencyKey` (unique), `keySeq` (the `seq` encoded in the key), `inputHash` (SHA-256 of the canonical `requestId` and `edits`), `sourceRequestId`, `state` (`pending | completed | failed | unknown`), `dispatched` (boolean: the worker committed its intent to hand the request to mitmdump, so the upstream may have received it), `detail?` (at most 1 KiB), `resultRequestId?`, `seq`, `acceptedAt`, `dispatchedAt?`. The row's `seq` comes from the same store-wide counter and is bumped on every row change. `acceptedAt` and `dispatchedAt` are for display only; no retention rule reads a clock.
    - A one-row `meta` table holds `storeId` (16 random hex chars), `keySecret` (32 random bytes), and `keyFloor` (initially 0). The first two are written when the database is created. `keySecret` only lets the store recognize keys it issued (see "Replay keys"). It is not an authorization boundary: anyone who can read `dataDir` is already trusted with the plugin. It never leaves the worker, and it does not go in `ServerSecretStore`.
    - **Store lane.** The worker has one store connection and one single-permit lane. Every store write and every write or delete under `replay/` and `drafts/` runs inside the lane. That covers flow inserts, replay admission, dispatch commits, settles, history pruning, budget maintenance, draft writes, `delete_capture`, and worker-start recovery. Reads do not take the lane. No read transaction or statement iterator stays open across an `await`, so the worker's own reads never block a checkpoint. While a flow record waits for the lane, the worker pauses reading the control socket.
    - **Storage budget.** `maxDiskBytes` bounds everything the inspector writes under `dataDir`, except `mitmproxy/` (CA files) and `runtime/` (the addon). Usage is the measured on-disk size of `inspector.sqlite` and its `-wal` file, plus every file under `replay/` and `drafts/`. The database is created with `PRAGMA auto_vacuum = INCREMENTAL` (set before the first table), `journal_mode = WAL`, and `wal_autocheckpoint = 0`. SQLite's automatic checkpoint copies pages into the main file but never shrinks the `-wal` file, so with it on, the same data sits on disk twice. A local `node:sqlite` probe (SQLite 3.53) hit about 2 × the budget that way. The store checkpoints itself instead.
      - **Checkpoint rule.** `PRAGMA wal_checkpoint(TRUNCATE)` runs only outside any transaction. Inside one, SQLite fails it with "database table is locked" (reproduced with `node:sqlite`). It runs after any commit that leaves the `-wal` file over `walTarget = 1 MiB`, and between maintenance steps. A result with `busy != 0` means a reader blocked it. The store then marks the checkpoint incomplete.
      - **Admission.** Admission runs inside the lane, before any transaction that writes. `admit(bytes, { protect? })` takes the size about to be written: one flow, one replay body plus a 4 KiB row allowance, or one draft chunk. It returns `ok` or `full`, and it runs maintenance, each step its own short transaction or a pragma outside one, in this order:
        1. If the last checkpoint was incomplete, retry it. If it is still incomplete, return `full` without pruning, because each vacuum step would grow the `-wal` file a blocked checkpoint cannot reset.
        2. While measured usage plus `bytes` exceeds `maxDiskBytes`, do the following:
           - One write transaction deletes the oldest prunable records. The order is oldest capture first, then the running capture's oldest records. Each pass deletes enough stored bytes to cover the shortfall, and at least one record. Prunable excludes the source request of every pending replay and `protect`, the source of the replay being admitted. Pruned records bump `seq` and reach the topic as `removed`. Deletes write little WAL, because freed pages are only listed: deleting 10 MiB wrote 58 KiB.
           - After the commit, run `PRAGMA incremental_vacuum(256)` (1 MiB at the default 4 KiB page size), then checkpoint, and repeat until the freelist is empty. A single unbounded `incremental_vacuum` moved 8.8 MiB of pages into the `-wal` file before the checkpoint could fold them back. Bounded steps kept that to about 1 MiB.
           - Stop when nothing prunable remains, when a checkpoint is incomplete, or when a maintenance pragma throws. Maintenance errors are logged without data.
        3. Return `ok` if measured usage plus `bytes` is within `maxDiskBytes`, otherwise `full`.

        Committed prune deletes stay committed even when the admission that ran them ends `full`. That is harmless, because pruning only removes data the budget allowed it to remove.

      - **Refusals.** When admission returns `full`, nothing is written:
        - A flow is dropped and counted as `droppedFlows` in capture status. Capture status also shows `storageBlocked: true` while a checkpoint is incomplete.
        - A replay or draft write is refused with `operation-failed`, recording nothing: "Not sent: the inspector's storage budget is full. Delete captures or raise maxDiskBytes."

        Data that cannot be pruned: pending replay bodies and their source requests, drafts, and replay history.

        The budget never refuses a replay row's state change: dispatch, settle, timeout, or recovery. Such a change is a small update, bounded by the 20-pending cap, and safety depends on it. A completed replay's response record is a flow insert and goes through admission. If admission refuses it, the replay is still `completed`, with no `resultRequestId` and detail "Response not stored: the inspector's storage budget is full."

      - **Bound.** The rule is honest about what it controls. Before every write, measured usage plus the write's estimated size is within `maxDiskBytes`. Physical use can briefly exceed it by these amounts:
        - The write in progress beyond its estimate: SQLite page, index, and overflow overhead. About 64 KiB for a 256 KiB flow in the probe.
        - The unchecked `-wal` (at most `walTarget` plus one write).
        - One vacuum step (1 MiB).

        No overshoot persists past the next admission, because admission measures real file sizes rather than predicting them. A reader that blocks checkpoints, such as an external `sqlite3` holding a transaction, stops new writes instead of letting the `-wal` file grow. This is a budget, not a file-system quota.
    - A replay's result record joins its source request's capture, so capture pruning covers it.
  - `backend/mitm.ts` spawns mitmdump and records the captured PID. `backend/index.ts` imports `./addon.py` as text (packed by Task 3's text loader). Before each spawn, `mitm.ts` calls `materializeAsset("addon.py", addonSource)` and passes the returned absolute path, so nothing is resolved relative to the source tree or the package directory. Capture mode: `mitmdump --listen-host <h> --listen-port <p> --set confdir=<dataDir>/mitmproxy -q -s <dataDir>/runtime/<hash>-addon.py`. Replay-only mode: `mitmdump --set server=false --set confdir=<dataDir>/mitmproxy -q -s <same path>`. Both connect to a worker-owned `127.0.0.1:0` TCP control socket using a random token from env.
  - `backend/addon.py` streams NDJSON flow records. Header byte pairs and body bytes are base64, and bodies are cut at `maxBodyBytes` with a `truncated` flag. It handles `replay { replayId, request: { method, scheme, host, port, authority, path, httpVersion, headers, bodyFile } }`. It constructs `http.Request(host, port, method, scheme, authority, path, http_version, Headers(fields), content=<bodyFile bytes>, trailers=None, …)` directly. The constructor's `content` is raw, and `Request.make` and the `.content` setter would re-encode per `Content-Encoding` and rewrite `Content-Length` (`mitmproxy/http.py:523-537,631`). It wraps the request in an `http.HTTPFlow` with placeholder client and server connections, as `view.flows.create` does (`mitmproxy/addons/view.py:476-492`), and calls `ctx.master.commands.call("replay.client", [flow])`. It sends no dispatch acknowledgement; the worker's committed intent is the only dispatch record. In its `response`/`error` hooks it reports `replayResult { replayId, … }` for flows with `is_replay == "request"`. It calls `ctx.master.shutdown()` when the control socket closes.
  - `backend/replay.ts` runs replay as enqueue-and-query (decision table, "Long-running mutations"):
    - **Replay keys.** Each `preview_replay` call returns a new `idempotencyKey` of the form `rk1.<storeId>.<seq>.<nonce>.<tag>`:
      - `seq` is the store's current `seq` high-water mark, in decimal with no leading zeros.
      - `nonce` is 16 random lowercase hex chars.
      - `tag` is the first 32 lowercase hex chars of HMAC-SHA256(`keySecret`, `"rk1.<storeId>.<seq>.<nonce>"`).

      A key is at most 87 chars, and the tool input is a 1-96 char string, so a malformed key gets the refusal below instead of a schema error. A key is _issued_ when it matches `^rk1\.[0-9a-f]{16}\.(0|[1-9][0-9]{0,15})\.[0-9a-f]{16}\.[0-9a-f]{32}$` exactly, names this `storeId`, and its `tag` text equals the recomputed tag. Only one spelling passes, so two spellings cannot decode to one key. Changing any character of an issued key fails the tag, except with probability 2⁻¹²⁸. That includes changing `seq` to another value between the floor and the high-water mark.

      Minting writes nothing, and keys use no clock. `storeId`, `keySecret`, `seq`, and `keyFloor` live in the database, so a key stays valid across worker and server restarts. Two previews at the same `seq` differ by `nonce`. If two nonces collided, the two Sends would share one key: the second would get the first replay back, or be refused for different input. It would never send twice.

    - **Accept** (inside `replay_request`, well under the 30 s invoke budget). Accept holds the store lane from its first check to its commit. Storage maintenance cannot run inside a write transaction, so Accept checks first, then admits, then commits in a transaction that re-checks:
      1. **Check (read-only).** Look up `idempotencyKey` by exact text. The same key with the same `inputHash` returns the existing replay, whatever its state or `keySeq`. It sends nothing and needs no storage. The same key with a different hash fails with `operation-failed`: "This idempotency key was already used for a different replay." With no row for the key, Accept refuses with `operation-failed` and records and sends nothing in these cases:
         - The key is not issued (see "Replay keys"), or its `seq` is above the current high-water mark: "This idempotency key was not issued by this inspector. If you are retrying, the key may have been copied wrong, and the replay that used the correct key may have been sent. Call preview_replay for a new key only if a new replay is intended." This covers malformed and altered keys, and keys from another environment or from data that was deleted and recreated.
         - Its `seq` is below `keyFloor`: "This idempotency key has expired. A replay that used it may have been sent and is no longer kept. Call preview_replay for a new key only if a new replay is intended."
         - 20 replays are already `pending`: "Not sent: 20 replays are in progress. Wait for one to settle."
         - The edits name a draft that no longer exists: "Not sent: the body draft no longer exists. Upload the body again."
         - The source request no longer exists: `not-found`.

         Then build the request from the stored record plus edits, and run the completeness and HTTP-only refusals. If `ctx.signal` is already aborted, record nothing and fail.

      2. **Admit.** Call `admit(bodyBytes + 4 KiB, { protect: requestId })` (see "Storage budget"), outside any transaction. On `full`, refuse with the storage-full detail, recording nothing.
      3. **Body.** Write the body, from the build or copied from the draft, to `dataDir/replay/<replayId>.bin`.
      4. **Commit.** In one `BEGIN IMMEDIATE` transaction, re-run every check in step 1, plus "the source request exists" and "`ctx.signal` is not aborted". Then insert the row as `pending` with `dispatched: false`, and commit. Any refusal here rolls back and deletes the body file. Every store writer takes the lane, so these checks normally repeat step 1's answers. Re-running them keeps the decision atomic with the insert, so correctness does not rest on that. After the commit, delete a draft the edits named, apply the checkpoint rule, and return `{ replayId, state: "pending", destination }`. From here the caller's abort or disconnect does not stop the replay.

      A crash between steps 3 and 4 leaves a body file with no row. Worker start deletes every file under `replay/` that has no `pending` row.

    - **Dispatch** (in the background). Use the capture's mitmdump, or start a transient replay-only one. If the transient mitmdump has not connected its control socket within 10 s, the replay becomes `failed` with `dispatched: false` ("Not sent: mitmdump did not start."). Once a control connection is live, commit `dispatched: true` and `dispatchedAt` to the store, and only then write the `replay` message to the socket. If that commit fails, write nothing; the row stays undispatched and settles as not sent. From the commit on, the worker never reports the replay as not sent. Absence of a response is never evidence that nothing was sent.
    - **Settle.** `replayResult` with a response stores it as a new record with `replayOf` and sets `completed` and `resultRequestId`. A mitmproxy `error` sets `failed` with its text. Once `dispatched` is true, the upstream may have received the request. With no result 30 s after dispatch, the state becomes `unknown` ("No response within 30 s; the upstream may have received it."). If the control socket closes, a socket write fails, or the mitmdump carrying a replay exits first (for example `stop_capture`), its pending replays settle at once by the same rule as worker start, with detail "Interrupted after handoff; the upstream may have received it." for dispatched rows. Each settle deletes the body file. A transient mitmdump is stopped by its captured PID after it settles.
    - **Worker start.** Rows left `pending` become `unknown` when `dispatched` ("Interrupted after handoff; the upstream may have received it."), and otherwise `failed` with "Not sent: the plugin stopped." That second message is true because the request is written to mitmdump only after `dispatched` is committed.
    - **Replay history.** The store keeps every `pending` row and at most the `maxReplayHistory = 1000` most recently settled rows, ordered by row `seq`. When a settle leaves 1001 settled rows, the same transaction deletes the oldest settled row and sets `keyFloor = max(keyFloor, row.keySeq + 1)`. Every key a pruned row used is therefore below the floor, and a retry with it is refused as expired, never accepted as a new replay. A key that was minted but never used before the floor passed it expires too, which is a safe refusal. A pending row settles within 40 s of acceptance (10 s startup plus the 30 s deadline) or at worker start, and at most 20 are pending, so the table holds at most 1020 rows. `get_replay` for a pruned `replayId` returns `not-found`. Host `deleteData` removes the database. The recreated database has a new `storeId` and `keySecret`, so earlier keys are refused as not issued. Idempotency lasts only as long as the kept history.
    - Only `completed` and `failed` with `dispatched: false` are definite. A `failed` with `dispatched: true` (a mitmproxy error) may still have reached the upstream. The commit-before-write order survives process crashes; it does not promise anything across power loss. Nothing promises exactly-once delivery.
    - The timer, process spawner, `maxReplayHistory`, and the store's `onStorageStep` observer (called after every store write and maintenance step) are injected. Unit tests can then drive deadlines and pruning without real time or 1000 rows, and measure disk use between steps.
  - `backend/bodies.ts` handles chunked body reads and body drafts. `backend/redact.ts`.
  - `ui/inspector.html` and `ui/inspector.ts` keep the active filter and selected request in bridge `state`, so they survive thread switches and remounts. They provide capture controls, a summary list with search and filters (snapshot plus pages merged by `id`, keeping the highest `seq`; page results whose `revision` differs from the current snapshot's are discarded), header and body detail (bodies paged with `read_body`), a replay editor that shows the destination from `preview_replay` before sending (edited bodies over one chunk are uploaded with `body_draft_write`), and "Attach to chat". Each Send click uses the `idempotencyKey` from the editor's latest `preview_replay` result. It keeps that key, and the returned `replayId`, in bridge `state` until the replay settles, so a retry after a reconnect or `timed-out` reuses it. After each Send the editor drops that key and calls `preview_replay` again, and Send stays disabled until a fresh key arrives, so two Sends never share a key. A Retry refused as expired or not issued drops the entry and shows the refusal, labeled "may have been sent". An entry with a key but no `replayId` shows "Not confirmed" with a Retry button that reuses the key; it is never retried automatically. At most 20 unsettled replays are tracked, and Send is disabled while 20 are unsettled. `ui/replayTracker.ts` is a pure module that holds the panel's replay statuses keyed by `replayId`. It applies a `capture-status` replay item or a `get_replay` result only when its `seq` is greater than the held one, so a delayed response can never overwrite a newer state. After every `capture-status` snapshot (first subscribe, remount, and the snapshot that follows any `resync` from a reconnect or overflow), the panel calls `get_replay { waitMs: 0 }` once for each tracked `replayId` and merges the results. The subscription is live before the query, so a change after the query's read arrives as a batch. A terminal merge (completed, failed, or unknown) drops the entry from bridge `state`, and a `not-found` result drops it too. The panel labels `unknown`, and `failed` with `dispatched: true`, as "may have been sent".
  - Tests: `backend/store.test.ts`, `backend/mitm.test.ts`, `backend/redact.test.ts`, `backend/replay.test.ts`, `backend/bodies.test.ts`, `ui/replayTracker.test.ts`. Real-mitmproxy subprocess tests live in a separate `integration/` directory with a targeted `test:mitmproxy` script. They run only the packed archive: `packPlugin` into a fresh `os.tmpdir()` directory, `extractPluginArchive`, then `startPackedBackend` with a `dataDir` in that directory (Task 3 `./testing`). They never import or spawn files from the package source.
- Agent operations (`agent: true`):
  - `start_capture` (mutates) and `stop_capture` (mutates).
  - `search_requests { query?, method?, host?, status?, captureId?, limit ≤ 200, cursor? }` returns `{ items, cursor, revision }`. Each summary's path is cut at 512 chars. `cursor` accepts this operation's own cursor or a `requests` topic snapshot cursor. A cursor encodes the snapshot's high-water `id` and the last `id` returned, so later pages hold only older records that existed at snapshot time. Records inserted afterwards arrive only through topic batches. A page carries the `revision` encoded in its cursor. A search without a cursor carries the current `seq`.
  - `get_request { requestId, previewBytes ≤ 32768 (default 8192), bodies: "none" | "request" | "response" | "both" (default "none"), includeSensitiveHeaders?: boolean }`. It returns ordered headers, with each value cut at 8 KiB and each side's headers at 32 KiB, flagged `headersTruncated` (replay always uses the full stored headers), and per-body metadata `{ capturedBytes, declaredBytes?, truncated, contentEncoding, isText }`. A preview of the decoded body, UTF-8 text or base64 when binary, is included only for the requested sides.
  - `read_body { requestId, side: "request" | "response", offset ≥ 0, length ≤ 131072, decoded?: boolean (default false) }`. It returns `{ base64, offset, length, totalBytes, eof, truncatedAtCapture }`. With `decoded: false` it slices the raw stored bytes. With `decoded: true` it decodes gzip, deflate, or br with `node:zlib`, up to 16 MiB of output, then slices.
  - `preview_replay` (read-only) takes the same input as `replay_request` without `idempotencyKey`. It returns `{ destination: { scheme, host, port }, method, path, bodyBytes, refusal?, idempotencyKey }`. The description says it shows where a replay would go and returns a fresh key, that each key is for one replay only, and that a retry must pass the key unchanged.
  - `replay_request { requestId, idempotencyKey /* 1-96 chars, from preview_replay, required */, edits?: { method?, url?, headers?: Array<[string, string]>, body?: { kind: "inline"; base64 /* ≤ 131072 raw bytes */ } | { kind: "draft"; draftId } } }` (mutates). It returns `{ replayId, state, destination }` as soon as the replay is accepted, usually with `state: "pending"`. The description tells the agent to call `preview_replay` for a new key for each distinct replay, and to retry with the exact same key or call `get_replay`, never a new key, after a `timed-out` or unclear result. A key protects only exact retries: a request with a new key is a new replay. If a retry is refused as expired or not issued, the agent reports that the earlier replay may have been sent and asks the user before it requests a new key. Only `failed` with `dispatched: false` means the request was definitely not sent; `unknown`, and `failed` with `dispatched: true`, mean it may have been.
  - `get_replay { replayId, waitMs ≤ 20000 (default 0) }` (read-only). It returns `{ replayId, seq, state, dispatched, detail?, resultRequestId?, destination }`, where `seq` is the row's `seq` at read time. With `waitMs`, it answers as soon as the state leaves `pending`, or when the wait ends, so the agent needs no polling loop. The cap keeps it inside the 30 s invoke budget. `not-found` for a `replayId` this inspector issued means the replay settled long ago and left the kept history.
- UI-only operations: `body_draft_write { draftId?, offset, base64 ≤ 131072 raw }` returning `{ draftId, size }` (files under `drafts/`; a draft is at most 16 MiB, at most 4 exist, and creating a fifth deletes the least recently written one; drafts are deleted after replay or on worker start), `delete_capture`, and `list_captures`. Topics: `capture-status` and `requests { captureId, filter }`. The panel always subscribes to `capture-status`, whose params are empty. Its snapshot is the capture state only, and its `revision` is the same store `seq` high-water mark, with `cursor: null`. Its batches carry capture state changes and `{ kind: "replay", replayId, seq, state, dispatched, sourceRequestId, resultRequestId? }`, sent on every replay row change, whatever capture or filter the panel shows. `requests` carries request summaries only. A `requests` snapshot is the newest summaries matching the filter that fit `maxPayloadBytes` (at most 200), with `revision` = current `seq` and `cursor` for older ones. Items are `{ kind: "request", id, seq, … }` summaries. Batches are upserts keyed by `id` with their `seq`. A pruned record is sent as `{ kind: "request", id, seq, removed: true }`. A replay's result record is an ordinary request summary with `replayOf`. Replay status reconciliation is described with `ui/inspector.ts` above. `resolveReference { captureId, requestId }`.
- Replay semantics. These are the only promises:
  - mitmproxy sends the request as stored or edited. Redirects are never followed, and a 3xx is recorded as the result.
  - Request and response header order and duplicates are preserved.
  - Bodies are byte-exact. The response is stored raw, still content-encoded.
  - Upstream TLS is verified (mitmproxy's default `ssl_insecure=false`). HTTP/2 or HTTP/1.1 is negotiated with the server, so the captured version is advisory.
  - When the body is edited and the request carries `Content-Length`, the header is set to the new byte length. `Transfer-Encoding` is never added or removed.
  - Refusals: replay fails with `operation-failed` and detail "The captured request body is incomplete (<captured> of <declared or unknown> bytes). Provide a replacement body to replay." when the stored body is `truncated` and no `edits.body` is given. WebSocket upgrades and non-HTTP flows are refused ("Only HTTP requests can be replayed."), matching `ClientPlayback.check` (`clientplayback.py:196-210`). A truncated response never blocks replay.
  - Captured-request byte budget: every agent and UI result fits `PLUGIN_LIMITS.maxPayloadBytes`. Larger bodies are read and written only in `maxBodyChunkBytes` chunks.

**Interfaces:**

- Consumes: Task 3 SDK (`definePluginBackend`, `materializeAsset`, `./testing`) and `packPlugin`, Task 12 reference shape (`locator = { captureId, requestId }`), Task 1 `pluginAgentTools`, Task 9 `PLUGIN_MUTATION_REFUSED_MESSAGE`
- Produces: a packed `dist/request-inspector-0.1.0.t3plugin`

- [ ] **Step 1: Write failing tests:**
  - `under storage pressure, inserting flows prunes the oldest captures and then the running capture's oldest records, and measured usage stays within the stated bound`. It runs on real `node:sqlite` in a temporary `dataDir`, with a 4 MiB budget and 256 KiB bodies, and inserts 200 flows. The store's injected `onStorageStep` hook measures the database, `-wal`, `replay/`, and `drafts/` after every write and maintenance step. Sizes must stay at or below `maxDiskBytes` + one flow + `walTarget` + one 1 MiB vacuum step. Before each admitted write, usage plus the estimate must be within `maxDiskBytes`. The database file must shrink after pruning, and no maintenance step may throw "database table is locked". The test asserts file sizes, not row counts.
  - `a checkpoint blocked by an open reader stops new writes instead of growing the -wal file, and the next admission after the reader closes checkpoints and accepts`. A second `node:sqlite` connection holds a read transaction while the store is over budget. Flows are dropped with `storageBlocked: true`, and the `-wal` size does not grow across five admissions. After the reader commits, the next admission completes the checkpoint, the file shrinks, and the write is accepted.
  - `when only unprunable data remains over budget, a new flow is dropped and counted, and replay_request and body_draft_write are refused with the storage-full detail, recording and sending nothing; a pending replay that completes in that state settles `completed` with the response-not-stored detail`
  - `body_draft_write keeps at most 4 drafts, evicting the least recently written, and a replay naming an evicted draft is refused as not sent`
  - `bodies over maxBodyBytes are truncated and flagged with declared length`
  - `headers keep duplicates and order through store round-trip`
  - `read_body pages a 1 MiB binary body in 128 KiB chunks that reassemble byte-exact, and refuses length > 131072`
  - `read_body decoded:true returns gunzipped bytes; decoded:false returns raw wire bytes`
  - `body_draft_write assembles chunks and refuses a draft over 16 MiB`
  - `every operation result for the 1 MiB fixture stays under PLUGIN_LIMITS.maxPayloadBytes`
  - `redact removes authorization, cookie, set-cookie and proxy-authorization unless requested`
  - `replay refuses a truncated captured body without a replacement, with the incomplete-body detail`
  - `replay with an edited body rewrites an existing Content-Length and never adds Transfer-Encoding`
  - `start fails with port-in-use when the port is bound` (bind a test socket first)
  - `start reports missing-prerequisite when mitmdump is absent` (PATH override)
  - `logs contain no header values or bodies` (capture the SDK `log` calls)
  - `capture and replay-only argv pass the materialized addon path under dataDir/runtime` (injected spawner)
  - `paging a requests snapshot while 100 records arrive and 10 paged records update yields every record exactly once after merging by id and seq`
  - Replay identity and outcome (`replay.test.ts`, fake mitmdump control connection, injected timer):
    - `replay_request returns pending with a replayId before the upstream answers`
    - `the same idempotencyKey and input returns the existing replay and dispatches once`, and `the same key with different input is refused`
    - `an abort before acceptance records nothing; an abort after acceptance does not stop dispatch`
    - `no result 30 s after dispatch marks unknown and stops the transient mitmdump by its captured PID`
    - `a transient mitmdump that never connects marks failed with dispatched false`
    - `worker start marks dispatched pending replays unknown and undispatched ones failed`
    - `the replay message reaches the control connection only after dispatched:true is committed`: the fake control connection, on receiving the message, reads the row through a second store connection and sees `dispatched: true`.
    - `an interruption after the replay message is written and before any result is unknown, never not-sent`, as a table: (1) abandon the replay service without shutdown, open a new one on the same `dataDir`, and run worker-start recovery; (2) close the fake control connection; (3) fail the next socket write. Each row ends `unknown` with `dispatched: true`.
    - `a failed intent commit writes nothing to the control connection and settles failed with dispatched false` (injected store failure).
    - `history keeps every pending row and the newest settled rows; the settle that exceeds maxReplayHistory deletes the oldest settled row and raises keyFloor above its keySeq in the same transaction` (`maxReplayHistory` injected as 3).
    - `a same-key retry after its replay was pruned is refused as expired and writes nothing to the control connection`. In the same test, a minted but unused key below the floor is refused as expired, a kept replay whose `keySeq` is below the floor is still returned, and `get_replay` for the pruned `replayId` returns `not-found`.
    - `a key minted before a restart is accepted after reopening the same dataDir; a key from a deleted and recreated dataDir, a key whose seq is above the high-water mark, and a malformed key are refused as not issued and send nothing`.
    - `an issued key altered in one character is refused as not issued before dispatch`, as a table over a valid unused key. Its rows change: the `storeId`; `seq` to another value between `keyFloor` and the high-water mark; the `nonce`; the `tag`; hex to uppercase; `seq` with a leading zero; and a key minted by another `dataDir` with its own secret. Every row records no replay row and no body file, and writes nothing to the control connection. The original key is then accepted once. The same alterations of a key that already has a row are also refused as not issued, and they never return or duplicate that row.
    - `under storage pressure, replay_request prunes and checkpoints outside its accept transaction and then accepts`, on real `node:sqlite` in a temporary `dataDir`, with a fake control connection. Old captures fill a 4 MiB budget. The replay's source is the oldest prunable request. Accept returns `pending`, and other records are pruned instead of the source. The database file shrank, no step threw "database table is locked", and the row and body file exist. The fake control connection then sees one `replay` message. Second row: an open reader on a second connection blocks the checkpoint, and the replay is refused with the storage-full detail, with no row, no body file, and no message. A same-key retry of an already-accepted replay under the same pressure still returns that replay, so the idempotency check needs no storage.
    - `a 21st concurrent replay is refused with nothing recorded, and a same-key retry of a pending replay is still returned at the cap`.
    - `get_replay with waitMs answers when the replay completes`, also asserting that `seq` increases on each row change and equals the `capture-status` item's `seq` for the same change.
  - Replay status merge (`ui/replayTracker.test.ts`, fake `get_replay` resolved by the test through a deferred, no timers):
    - `a terminal replay change missed during a gap is recovered by the get_replay reconcile after the next snapshot`, as two rows: a `resync` from host reconnect, and a `resync` from overflow. In both, the terminal batch is never delivered.
    - `a delayed pending get_replay result after a terminal batch does not regress the state`.
    - `a terminal merge or not-found removes the replay from tracked state, and a key without a replayId is not queried`.
  - In `integration/` (real mitmdump):
    - `addon shuts mitmdump down when its control socket closes`.
    - `the packed archive holds no addon.py entry, and capture spawns mitmdump with the addon materialized under dataDir/runtime`.
    - `replay preserves an upstream 302, duplicate request and response headers, a binary request body, and a raw gzip response, and links the new record to its source`. The local upstream is a Node `http` server in the test that returns `302` with two `Set-Cookie` headers and a gzip body, and records what it received. Run it twice: once through a running capture, and once with no capture, which uses the transient replay-only mitmdump and asserts that process exits. Each run takes its key from `preview_replay` and gets a result through `get_replay` with `waitMs`.
    - `a delayed upstream leaves the replay pending, and a same-key retry returns it without a second upstream request`. The upstream holds its response until the test has called `replay_request`, seen `pending`, retried with the same key, and confirmed the upstream received one request. Then it releases the response, and `get_replay` reports `completed`.
    - `stop_capture after the upstream received a replay and before it answers reports unknown with dispatched true`. The upstream holds its response. After it records the request, the test calls `stop_capture`, awaits the capture mitmdump's exit, and `get_replay` reports `unknown`.
    - Run these through the explicit `test:mitmproxy` script with a real local mitmdump prerequisite, outside the normal unit-test directory. The script fails with actionable prerequisite instructions when mitmdump is absent. Do not add conditional skips or invent a quarantine issue. Run this suite in a provisioned verification environment before claiming inspector integration is complete. Await process exit, control-socket, and `replayResult` milestones rather than sleep or polling.
- [ ] **Step 2:** Run `vp test run packages/plugin-request-inspector/backend packages/plugin-request-inspector/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement. Search runs over indexed summary columns (method, host, path, status, started_at), with `LIKE` on path. Bodies are fetched only by `get_request` previews and `read_body`.
- [ ] **Step 4:** Re-run. Expected: PASS. With mitmdump installed in the isolated verification environment, run `vp run --filter @t3tools/plugin-request-inspector test:mitmproxy` and require PASS. Run `vp run --filter @t3tools/plugin-request-inspector pack`. The `integration/` suite above already runs this kind of archive extracted outside the repository. Task 6 proves the server's install-and-spawn path from a temporary state dir. Task 15 Step 5b runs the whole inspector flow from an installed package on the release binary. No source-relative run counts as proof.
- [ ] **Step 5: Evals** (`evals/mcp-tool-use`, per `evals/README.md`). Extend `evals/mcp-tool-use/run.ts` with a plugin tool source. It reads `packages/plugin-request-inspector/t3-plugin.json`, builds tools with `pluginAgentTools`, uses `PLUGIN_MUTATION_REFUSED_MESSAGE` for refusal mocks, and copies no description. Add a grader row to `run.test.ts` if the grader changes. Add `cases/plugins.ndjson`:
  - (a) guard: "find the failing login request" uses `search_requests`, then `get_request` with bounded `previewBytes`.
  - (b) guard: "show me the request" does not call `replay_request`.
  - (c) control: an unrelated coding task calls no plugin tool.
  - (d) guard: a turn with a `plugin-reference` (projected by Task 12's `projectComposerContextForProvider`) whose snapshot lacks the body leads the agent to call `get_request` or `read_body` rather than inventing the body.
  - (e) guard: `replay_request` in a non-full-access thread returns the refusal, and the agent reports it without retrying or seeking a workaround.
  - (f) guard: the agent calls `preview_replay`, then `replay_request` with the returned key. `replay_request` returns `pending`. The agent calls `get_replay` (with `waitMs`) before reporting an outcome, and does not call `replay_request` again with a new key. When the mocked `get_replay` returns `unknown`, the agent reports that the request may have reached the upstream rather than that it was not sent.
  - (g) guard, as two rows. A retry of `replay_request` returns (1) the expired refusal, or (2) the not-issued refusal (the agent's retry key was altered). In both rows the agent does not call `preview_replay` and replay again. It may call `get_replay` for a `replayId` it already holds. It reports that the earlier replay may have been sent and asks the user.

  Check each with `--dry-run --case <id>`. Then run `pnpm mcp-tool-use --case <ids> --out runs/plugins` from `evals/` and record the pass rates. These are new tools, so there is no old text to fail against. The cases guard the current text, and the control guards against overuse.

- [ ] **Step 6: Commit:** `feat(plugins): mitmproxy request inspector example`

### Task 14: Documentation

**Files:**

- Create: `docs/internals/plugins.md`. Cover the trust model and why process separation is not a sandbox. Explain why plugin panels are not MCP Apps: the existing MCP Apps requests require a tool-result item and a live originating provider session (`apps/server/src/mcpApps/McpAppRequests.ts:69-80`, `McpAppRequestError` reason `session-stopped`), and plugins must not. Also cover:
  - Environment-scoped panel state versus the thread-scoped `rightPanelStore`, and why the page route exists.
  - Why backends are single builtin-only CommonJS bundles (SEA module resolution), and why text assets are embedded and materialized under `dataDir/runtime/` instead of packed as files.
  - Why replay goes through mitmproxy instead of `fetch`, and why long-running mutations enqueue and return an id (the invoke timeout cannot report a definite outcome), and why dispatch intent is committed before handoff (a missing acknowledgement is not evidence that nothing was sent). Also why replay keys are issued by the inspector and expire through a stored floor: bounded history cannot remember caller-chosen keys forever, and the floor makes expiry decidable from the key with no clock. Keys carry an HMAC tag so a corrupted retry key is refused rather than treated as new. The tag guards exact retries only: it is not an authorization boundary, and a deliberately requested new key is a new replay. Also why storage maintenance (vacuum, checkpoint) runs between transactions under one lane, with automatic checkpoints off, and what the disk bound does and does not promise.
  - The subscription envelope invariants (snapshot first, `revision`/`cursor` opaque to the host, overflow resubscribes), and why the version is part of panel identity.
  - `PLUGIN_LIMITS`, the provider capability matrix, assistant plugin-tool selection, and subscription bounds.

  Link source and do not narrate it.

- Create: `docs/user/plugins.md`. Explain:
  - Installing client-only and environment plugins, the trust prompt, enable, disable, uninstall, and delete data.
  - Opening a panel with or without a chat. How a plugin keybinding chooses between the same plugin installed on this device and in several environments, and that the palette lists each one.
  - Letting an assistant use plugin tools: select the operations in the assistant's resource bindings under Plugin tools. Plugin resources are not available to assistants.
  - Request inspector prerequisites, proxy configuration, and HTTPS certificate trust (CA under the plugin's data dir, `mitmproxy/` subfolder; manual trust steps).
  - Replay limits: redirects are not followed, and a truncated capture needs a replacement body. Replay outcomes: pending, completed, failed, or unknown, where unknown means the upstream may have received the request. Only a failure marked not sent is certain not to have reached it. The inspector keeps the latest 1000 finished replays. A retry of an older one is refused as expired, and that replay may have been sent. `maxDiskBytes` covers captures, pending replays, and body drafts. Old captures are pruned to stay within it. When the space left holds only data that cannot be pruned, new replays are refused. Usage can briefly go a little over the limit while the inspector is writing or cleaning up. If another program keeps the inspector's database open, capture shows storage blocked and new flows are dropped until it closes.
- Modify: `docs/user/assistants.md:57`. Extend the existing pointer sentence to name plugin tools and link `plugins.md`. Do not add a section.
- Modify: `docs/internals/composer-context-references.md`. Add the `plugin-reference` kind to the record list sentence. Rewrite it in place; do not append.

- [ ] **Step 1:** Write the docs. Check each paragraph against AGENTS.md "Documentation" rules.
- [ ] **Step 2: Commit:** `docs: plugins`

### Task 15: Integrated verification

Not code. Run it once, as the primary agent, after Tasks 1-14.

- [ ] **Step 1:** Run `vp run check:changed`. Expected: clean.
- [ ] **Step 2: Web and desktop pass** (`test-t3-app` skill, dark mode, `Replay (dev)` for any chat turn, worktree `.t3` state only):
  - Install the converter on the client. With no chat selected (Settings or Pull requests page), open it from the sidebar and confirm it opens as a page. From a chat, open it from the sidebar, the command palette, and its keybinding (`plugin.converter.open`), confirm it docks, and insert text into chat. Confirm it works with no backend.
  - Also upload the converter package into two environments (an environment accepts a UI-only package, and its panel is served by `plugin-panel`), so it is installed in A, B, and on the client. Confirm the sidebar and palette list three labeled entries. The keybinding opens the current chat's environment instance. With no chat, it opens the client instance. After uninstalling the client copy, with no chat, it opens the palette to choose.
  - Upload and install the inspector into the dev environment with the trust confirmation. Check enable, disable, restart, status, and logs.
  - Configure `curl -x http://127.0.0.1:8080` requests, including one to a URL that redirects. Search, inspect (page a body over 128 KiB), replay the redirecting request and confirm the 3xx is recorded unfollowed, and attach.
  - Switch threads and confirm the panel and its filter persist. Switch environments and confirm the instance is swapped.
  - Stop the originating agent and confirm the panel still works.
  - Replay against a local upstream that delays its response. Confirm the panel shows the replay pending, then completed, with one upstream request. Repeat with `stop_capture` while the upstream holds the response, and confirm the panel shows unknown ("may have been sent").
  - With the inspector panel open in one browser, update the inspector from a second browser. Confirm the first panel remounts on the new version, keeps its filter, and does not error.
  - Disable the plugin and confirm tools fail and the panel shows Enable. Uninstall and confirm data is retained, then delete data.
- [ ] **Step 3: Remote pass:** run `vp run dev --share` and repeat panel load and a subscription from the tailnet URL. Drop and restore the connection and confirm resync with no duplicate rows. Start a replay against the delaying upstream, drop the connection, release the response, restore, and confirm the panel shows completed.
- [ ] **Step 4: Mobile pass** (`test-t3-mobile`, dark mode): open both panels from Settings and the command palette, then attach to a thread with confirmation.
- [ ] **Step 5: Agent pass** with the cheapest real model per supported provider you can afford (Claude Haiku at minimum). With no panel open, ask for "requests to /login". Confirm `search_requests` is called. Confirm `replay_request` is refused in a non-full-access thread. In an assistant (agent) thread, select only `search_requests` under Plugin tools. Confirm only that tool is listed, and that plugin resources are hidden.
- [ ] **Step 5b: Packaged runtime pass.** On a host whose Node matches root `engines.node`, run `vp run --filter t3 build:exe` and assemble the archive per `scripts/build-cli-archive.ts`. Start that binary with a fresh `--home-dir` in a scratch directory outside the repository. Install the packed inspector through its web UI (`test-t3-app`) and start it. Start a capture, send one `curl -x` request through the proxy, search, replay it, and require `get_replay { waitMs: 20000 }` to report `completed`. This proves the materialized addon runs from an installed package. Stop the plugin and confirm that its worker and mitmdump PIDs are gone. In the desktop dev app (Electron-as-Node server), start the inspector backend and confirm status `running`.
- [ ] **Step 6:** Record the provider matrix results in `docs/internals/plugins.md`. Capture before/after evidence only if a PR is requested.

---

## Self-review notes

- **Spec coverage.** Each spec requirement maps to a task:
  - Client-only, server-only, and combined packages: Tasks 4, 5, 13.
  - Self-contained backend packages that run from `stateDir` on every runtime: Tasks 3, 6, 15 (Step 5b).
  - Backend lifecycle: Tasks 6 and 7.
  - Persistent sidebar panels, with or without a chat: Task 10. Mobile screen: Task 11.
  - Remote assets and RPC: Tasks 7 and 8.
  - Provider MCP: Task 9 and the matrix. Approval policy and assistant tool selection: Task 9.
  - Chat references and fallback: Task 12.
  - Inspector limits (explicit proxy, external mitmproxy, retention, private control socket, redaction, replay fidelity, chunked bodies): Task 13.
  - Retained data and uninstall: Tasks 5 and 7. Explicit updates and failure reporting: Tasks 7 and 10 (open panels follow the new version or show the failure).
  - Bounded subscriptions with reconnect resynchronization: Tasks 1 (envelope), 3, 6, 7, and 13 (paging under concurrent changes, replay status reconciliation by `seq`).
  - Commands, palette, and keybindings with environment identity: Tasks 1 and 10.
  - API compatibility: Tasks 1 and 8.
  - Verification criteria: Task 15.
- **Server-only packages:** a manifest with `backend` and no `ui`. Tasks 5-7 and 9 cover them. Task 9's tests call tools with no panel.
- **Type consistency.** Each of these is defined once and reused by name:
  - Task 1: `PluginId`, `PLUGIN_LIMITS`, `PluginOperationDecl`, `PluginRequestError` (including `timed-out` and `version-changed`), `PluginSubscriptionEvent`, `PLUGIN_OPEN_COMMAND_PATTERN`, `pluginToolName`, `pluginToolPolicyKey`, `pluginAgentTools`.
  - Task 2: `PluginAttachRequest`, `PluginBridgeOptions.pluginVersion`.
  - Task 3: `materializeAsset`, `OperationContext.signal`, the worker `cancel` notification, `./testing`.
  - Task 4: `PluginPanelKey`.
  - Task 9: `PLUGIN_MUTATION_REFUSED_MESSAGE`.
  - Task 10: `resolvePluginOpenTarget`, `listPluginPanelTargets`, `resolvePluginCommand`.
- **Task order.** Each task consumes only earlier outputs:
  - Task 4's client stores key state by Task 4's `PluginPanelKey`. Task 11 (mobile) uses Task 10's `listPluginPanelTargets`.
  - Task 6 tests use Task 3's `packPlugin` and Task 5's store.
  - Task 9's selection UI uses Task 7's registry atoms (`packages/client-runtime/src/state/plugins.ts` and the web and mobile bindings), not atoms from Tasks 10 and 11.
  - Every eval that imports the inspector manifest or Task 12's projection is in Task 13.
- **Byte budgets.** These are all within `PLUGIN_LIMITS`:
  - Bridge, RPC, worker pipe, and MCP payloads.
  - Inspector chunks: 128 KiB raw is 174,764 bytes as base64, under 240 KiB with its envelope.
  - Batches: 64 KiB. Snapshots, and every page result with its `cursor` and `revision`: ≤ `maxPayloadBytes`.
  - `get_replay` waits at most 20 s, inside the 30 s invoke budget. Reconciliation sends at most 20 `get_replay { waitMs: 0 }` calls per `capture-status` snapshot.

  Captures keep at most `maxBodyBytes` (≤ 16 MiB) per body, which stays reachable through `read_body` and body drafts.

  Inspector disk: `maxDiskBytes` covers the measured database, WAL, pending replay bodies, and drafts. Every write is admitted against measured sizes. Physical use can briefly exceed the budget by SQLite's overhead on the write in progress, `walTarget` (1 MiB), and one 1 MiB vacuum step. Checkpoints and vacuum never run inside a transaction. Replay keys are at most 87 chars, within the 96-char input. Replay rows: at most 20 pending and 1000 settled. Drafts: at most 4 of 16 MiB. Idempotency lasts as long as a row is kept, and expired keys are refused. Altered keys fail the tag and are refused as not issued.

- **Proportion:** bodies are omitted. Code blocks are limited to signatures and pinned values.
