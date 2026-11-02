# Trusted plugins with persistent UI

Status: proposed design for approval. No product code has been changed.

## Intent and agreed decisions

Extend T3 Code with trusted plugins that may contribute a client UI, an environment backend, or both. Plugins must work with remote environments. The first substantial example is a mitmproxy request inspector with viewing, searching, replay, chat references, and agent tools.

The user selected trusted plugins and web UI bundles communicating through a T3 bridge. Plugin interfaces can occupy persistent sidebar-accessible panels; they do not have to originate from chat tool calls. On mobile the interface opens in its own screen.

## Approaches

Selected: sandboxed HTML/JS bundles with a versioned host bridge and optional backend process. Reuse MCP for agent tools/resources and compatible portions of the existing MCP Apps bridge. This can share plugin UI across web, desktop, and mobile without exposing T3's React internals.

Considered: importing T3 React components directly into plugins. This provides tighter integration but couples third parties to internal dependencies and leaves native mobile support unresolved. It is outside the initial design.

Existing MCP Apps remain supported as conversation-bound apps. Persistent plugins have their own identity and lifecycle; do not fake a tool-result item or running provider session to host a panel.

## Proposed initial scope

The following details are design proposals, not additional user decisions.

Ship a small plugin SDK, local package installation and management, persistent panels, commands, settings, backend calls, agent tools/resources, and explicit chat attachment. Prove these with a client-only converter and the combined request inspector. Server-only packages use the same lifecycle without a UI entry point.

Do not include a marketplace, automatic updates, OS-enforced backend permissions, native plugin components, arbitrary React tree injection, or automatic traffic interception. Installation requires explicitly trusting a backend package's author.

## Package and ownership

A package contains a manifest, prebuilt optional web assets, and an optional backend entry point. Manifest fields cover identity, package version, host API compatibility, contributions, settings schema, entry points, and declared capabilities. Contributions have namespaced stable IDs. No package install scripts execute as an incidental installation step; first version accepts self-contained prebuilt packages, with externally installed executable prerequisites declared explicitly.

Client-only packages install into the client's local storage without creating an environment backend record. Installation on one client does not automatically install on other clients. Their contributions can insert user-selected results into chat; they do not advertise durable agent tools.

Packages with backends install into a selected environment. A remote client can upload a prebuilt package through authenticated T3 transport; no shell or local machine path is required. The environment serves that package's web assets through authenticated asset delivery. No browser must connect directly to a plugin's localhost service. Backend installation does not copy the executable to viewing clients.

Plugin settings distinguish client preferences from environment-owned backend configuration. Secrets use the existing secret storage mechanism and are not broadcast as ordinary settings. Plugin data is separate from the host's orchestration tables.

## Client host and panels

Register a sidebar entry and an independently addressable panel. Provide the same open command to command palette and keybinding infrastructure. Web and desktop use the web panel host; mobile uses a WebView screen and shared bridge logic.

Panel identity includes the plugin, contribution, and owning environment where applicable. Environment plugin state must not silently move to a different environment when the user changes threads. Preserve the selected panel and its plugin state when switching threads in the same environment; changing environments selects that environment's instance. Closing a panel releases its UI subscription, not its backend capture session. This needs explicit integration because the existing right-panel store is thread-scoped.

The host supplies theme, dimensions, platform, destination identity, and an optional current chat target. All design previews and verification use dark mode. Reusing a bridge does not grant access to arbitrary MCP servers or T3 internal RPC methods.

Bridge methods cover bounded local state, declared backend operations, bounded subscriptions, opening registered surfaces, and user-initiated chat attachments. Host validates message schemas and ownership. UI code has no direct access to T3 auth credentials, Electron APIs, or filesystem.

## Backend lifecycle and operations

An environment-owned service manages enabled packages and starts each backend in a separate process. Backend execution is trusted and has the OS account's ordinary privileges. Process separation contains crashes, not malicious access.

Provide explicit enable, disable, start, stop, restart, status, and bounded logs. A backend may outlive any panel or provider session. Disabling stops it and removes callable tools and subscriptions; reenabling restores availability. Uninstall stops it and removes registration. Retain plugin data by default, with an explicit separate delete-data action. Updates are explicit package replacement with API compatibility checks, stopped workers, and plugin-owned data migrations; failed updates must report their state clearly rather than claiming transparent rollback of migrated data.

Backend operations are one service surface shared by UI calls and MCP tools. Enforce destination environment access through existing guarded RPC machinery. A plugin declares which operations are agent-visible and which mutate state; read-only annotations do not substitute for server authorization. Reuse the MCP catalog/gateway path for provider exposure instead of implementing a separate tool protocol per provider. During planning, inventory every provider: expose tools through its supported MCP integration or explicitly mark unsupported capabilities. Plugin panels remain usable regardless of the active provider.

Subscriptions carry bounded summaries with batching, backpressure, cancellation, and reconnect resynchronization. Query large data on demand; never place capture bodies or plugin databases in global thread snapshots. Client disconnection does not stop a capture. Stop workers and owned subprocesses precisely, never by process-name matching.

## Chat references

Attach a selected request through an explicit user action targeting a specific conversation. Persist a versioned reference with owning environment, plugin ID, capture ID, request ID, label, and a bounded snapshot of selected text. Show a readable fallback if the plugin or capture is unavailable. Expanding a reference fetches details from its owner; it does not execute a plugin tool automatically.

Agent context receives the selected snapshot and reference, with bodies fetched through tools when needed. Do not inject all traffic or continuously mutate conversation context as captures arrive. If the user changes the chat target during an attachment action, require a definite destination before inserting it. Existing generic composer records are a compatibility starting point, not proof that custom references already resolve.

## Request inspector example

Initial capture requires explicitly configuring the target application to use a proxy. Automatic agent subprocess capture, machine-wide interception, and client-device capture are excluded. A remotely controlled environment proxy captures only traffic routed to it; visiting T3 from a phone does not capture the phone's traffic. HTTPS certificate trust setup is an explicit prerequisite and never silently changes system trust.

Run mitmdump with a small addon under the plugin worker's ownership. Mitmproxy is initially an externally installed dependency; show an actionable missing-dependency status. The plugin owns its storage, indexes, ports, capture session IDs, and configurable disk/body retention limits. Bind control services privately; use the T3 bridge for control and data access.

The panel can start/stop capture, list/search/filter request summaries, inspect headers and bodies, edit a captured request for replay, replay it, and attach selected material to chat. Replays create distinct records linked to their source and expose the destination before execution. Start with captured HTTP request/response data; advanced WebSocket frame editing and transparent proxy modes are deferred.

Example agent operations: start/stop capture, search requests, get a request with explicit body limits, and replay a selected request with explicit edits. Replay is a mutation under T3's normal agent approval policy. Do not forward auth headers or bodies into logs or agent context unless the requested inspection needs them.

## Verification and completion criteria

Demonstrate client-only operation without a backend and server-only agent access without an open panel. A combined plugin must work while its originating chat agent is stopped. Verify install, enable, disable, restart, uninstall, retained data, and explicit data deletion.

Verify remote asset delivery and RPC routing, reconnect behavior, environment switching, tool removal when disabled, reference fallback, and bounded queries/subscriptions. Use focused tests at the lowest meaningful layer for lifecycle, authorization, persistence, protocol, and replay behavior. No duplicated wrapper tests or repo-wide checks.

Perform an integrated dark-mode pass in web and mobile after implementation; desktop shares the web host and must avoid assuming Electron APIs. Follow the repository's test-t3-app and test-t3-mobile workflows. Use focused package checks and check:changed before any requested push. Do not create a PR unless asked.

## Left to implementation planning

Exact package container, schema and bridge method names, worker transport, storage engine, panel-store migration, asset/WebView loading mechanism, and plugin SDK directory layout are builder choices. Read the owning server and UI conventions before implementing. Inspect existing MCP provider paths and establish a concrete capability matrix before promising agent support across all providers.

Implement in coherent stages: core package/lifecycle contracts and client-only example; persistent hosts and remote transport; backend/MCP integration and references; request inspector; integrated verification. No implementation starts until this design is approved.
