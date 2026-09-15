Github Tracked: false
Status: ready_to_validate
Github Issue: none

# Port fork features onto current upstream

## Goal

Port the seven shipped feature families documented in `docs/internals/origin-main-fork-audit.md` onto the current upstream architecture documented in `docs/internals/upstream-main-audit.md`. Keep the current upstream tree authoritative, preserve its behavior, and add only the fork's missing functionality.

The immutable implementation base is `0310cbf9f46ca94e9df0231a3440bca08ac44709` on `sync-upstream`. Use `origin/main` only as a behavioral, documentation, and test reference. Do not merge it, replay its commit series, or replace shared upstream files wholesale.

## Scope

- In: Home Assistant notifications; OpenCode parity and external ownership; workspace panes and combined project-script control; guarded Source Control; project-local and scoped MCP; desktop attached-primary mode; per-turn provenance and activity; fork migrations 001-006; required contracts, tests, dependencies, patches, and durable documentation.
- In: Web and desktop surfaces from the fork, mobile's audited work-count subset, all six current providers, older-client/server capability negotiation, and local/direct-remote/relay/tunnel compatibility.
- Out: Historical fork plans, ledgers, specifications, research, checkpoints, and `docs/agent-workspace-ideas.md`.
- Out: New scoped MCP editors, expanded mobile settings or panes, durable notification queues, hunk staging, conflict resolution, live MCP reload where unsupported, unrelated upstream-audit findings, and publishing `origin/upstream-main`.

## Acceptance criteria

- [x] AC-1: `sync-upstream` remains based on `0310cbf9f46ca94e9df0231a3440bca08ac44709`, and its diff contains only intentional fork-feature ports. P1-P16; V9.
- [x] AC-2: Upstream migrations 001-052 retain their identities and order. Fork migrations 001-006 use `t3_fork_migrations`, run second, and preserve data for clean, upstream-only, existing-fork, and repeated-startup paths. P2; V1.
- [x] AC-3: MCP dependencies and any necessary patches are installed before MCP source imports. JSON-RPC request ID zero cancellation and synchronous progress-before-response work in ESM and CommonJS. P4; V2, V8.
- [x] AC-4: Project MCP supports Streamable HTTP, legacy HTTP/SSE, stdio, OAuth, write-only credentials, provider assignment, connection actions, and its web editor. P3-P7; V2, V8.
- [x] AC-5: Scoped catalog resolution, definition identity, desired/applied revisions, recovery, and restart-required application work for Codex, Claude, Cursor, Grok, Antigravity, and managed OpenCode. Unmanaged external OpenCode stays unsupported unless explicitly opted into T3-managed MCP. P3, P6; V2, V3.
- [x] AC-6: OpenCode detaches external work during restart, reconnect, shutdown, and `stopAll`; explicit stop and replacement terminate under the documented confirmation and fencing rules. Current upstream compaction, recovery, attachments, usage, icons, source metadata, slash commands, and pending requests remain intact. P8; V3.
- [x] AC-7: External notifications remain versioned, secret-safe, deduplicated, bounded, best-effort, and unable to fail orchestration. P9; V4.
- [x] AC-8: Turn provenance and work counts remain accurate under settlement, retention truncation, late diffs, older hosts, and mobile's reduced presentation. Existing upstream usage, message context, and worktree-setup visibility remain intact. P10; V3, V6.
- [x] AC-9: Git mutations are repository-root serialized, literal-path safe, guarded against stale reviewed state, server-confirmed where required, and capability-gated. P11; V5.
- [x] AC-10: Workspace panes preserve device, terminal, preview, attachment, diff, pull-request, and Project Explorer surfaces while file editors use a persistent, sanitized secondary pane. The responsive layout and combined project-script control retain their documented behavior. P12; V6.
- [x] AC-11: Unified Source Control reuses current multi-PR, stack, provider-routing, and Forgejo/Gitea behavior and remains reachable from every existing entry point. P11-P13; V5, V6.
- [x] AC-12: Desktop attachment accepts only authorized loopback primaries, encrypts credentials, verifies environment identity, and never acquires process ownership. P14; V7.
- [x] AC-13: Applicable web, desktop, mobile, provider, local, remote, relay, and tunnel paths receive focused validation, targeted typechecks, structural checks, and approved integrated client passes. P15-P16; V1-V10.

## Plan

- [x] P1: Base and behavior gaps: pin the full base SHA; compare fork tests with current behavior; classify each feature as present, missing, or conflicting; port only tests that still express missing behavior. Preserve post-audit changes in `ProjectSetupScriptRunner.ts`, `ws.ts`, `ChatView.tsx`, and `MessagesTimeline.logic.ts`.
- [x] P2: `apps/server/src/persistence/Migrations.ts`, `Migrations.forkSequence.test.ts`, `Migrations/fork/`, and `apps/server/scripts/migrate-dev-db.ts`: keep upstream migrations 001-052, add the independent `t3_fork_migrations` sequence, and run upstream first. Replace the obsolete fake migration ID 50 fixture. Test empty, upstream-at-052, existing-fork-at-upstream-043-plus-fork-006, and repeated no-op databases. Seed and retain turn provenance, project MCP, desired/applied catalog state, and events; also prove upstream migration 050 PR conversion and migration 051 message context survive.
- [x] P3: `packages/contracts`, `packages/shared`, and `packages/client-runtime`: add external-notification, project-MCP, catalog, provider-command, VCS, settings, work-count, provider-catalog, and VCS state contracts additively. Preserve current recovery, attachments, token usage, tool icons, source metadata, custom answers, compaction, rollback capability, promptless continuation, older decoding, and secret redaction.
- [x] P4: `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `patches/`, and `ProjectMcpSdk.test.ts`: add exact MCP client/core/server dependencies before MCP implementation. Reproduce the two audited protocol defects and retain the client/server `2.0.0` patches only if needed. Regenerate the lockfile; do not copy the fork lockfile.
- [x] P5: `apps/server/src/project/ProjectMcpService.ts`, `apps/server/src/mcp/ProjectMcp*`, `server.ts`, `http.ts`, and `ws.ts`: port project-local transports, secret storage, OAuth, credential leasing, connection management, and authenticated proxies. Permit HTTPS or loopback HTTP without userinfo or query strings. Discard stdio stderr at the OS boundary. Fall back to SSE only for 400, 404, or 405. Keep child Effects interruption-safe and prevent source credentials from crossing provider or RPC boundaries.
- [x] P6: MCP catalog identity, resolver, service, gateway, orchestration, projection, persistence, and provider adapters: preserve global -> project override -> project-local -> session baseline -> session override -> session-local -> filtering -> validation/50 resolution. Preserve logical/definition IDs, desired/applied revisions, applied recovery, reversible names, and list-change events. Inject at launch and advertise `restart-required` for all six managed providers. Prove Antigravity catalog injection, restart/reconnect, authorization scopes, agent-device environment, and built-in preview/device behavior.
- [x] P7: `apps/web/src/components/settings/ProjectMcpSettings.tsx` and current `IntegrationsSettings.tsx`: add the visible project-local editor with create, update, connect, open-authorization, disconnect, credential replacement, provider assignment, and enablement actions. Keep inputs write-only. Do not add scoped catalog editors.
- [x] P8: Current `OpenCodeAdapter`, `OpenCodeServerOwner`, and `ProviderCommandReactor`, plus `OpenCodeExternalMcpCoordinator`, `OpenCodeExternalMcpUrl`, and `OpenCodeCommand`: port only missing OpenCode gaps. Detach external work on restart, reconnect, shutdown, and `stopAll`; require abort or valid idle confirmation within ten seconds for explicit stop; terminate replaced targets; fence late sends, recovery, requests, and MCP handoffs; drain old managed generations; preserve current upstream OpenCode features.
- [x] P9: `ExternalNotificationDispatcher`, `HomeAssistantWebhookAdapter`, `AgentAwarenessRelay`, server/shared settings, and current `IntegrationsSettings.tsx`: add versioned payloads, `state: null`, dedupe excluding `updatedAt`, serialized batches, concurrency four, ten-second timeouts, swallowed/logged failures, authorization-gated test delivery, and `ServerSecretStore` rollback when settings persistence fails. There is no separate `ExternalNotificationsSettings.tsx`.
- [x] P10: Turn projections, orchestration, settlement/checkpoint reactors, provider adapters, `turnWorkCounts`, web `MessagesTimeline`, and mobile thread activity: stamp model/effort at start and counts at settlement; allow only the audited late changed-file restamp; enforce 500-row and 500-turn retention rules; hide unverifiable counts; preserve upstream usage, typed message context, and post-audit worktree visibility. Web gets footer and row detail; mobile gets aggregate counts only.
- [x] P11: Current `GitWorkflowService`, `GitManager`, `GitVcsDriver`, `GitVcsDriverCore`, `VcsStatusBroadcaster`, `ws.ts`, and Git/VCS contracts: add status, staged/worktree diffs, whole-file stage/unstage, guarded index-only commit, branch switch, and branch creation. Serialize by resolved repository root, use literal pathspecs, compare reviewed branch/ref/HEAD/index/merge heads, handle hooks and partial publication safely, enforce confirmations on the server, and preserve stacks, provider routing, projections, and Forgejo/Gitea.
- [x] P12: Current `rightPanelStore`, `rightPanelLayout`, `RightPanelTabs`, and `ChatView`; new `secondaryPaneStore`, `workspacePaneLayout`, `components/right-panel/RightPanelRail.tsx`, `SecondaryPaneShell`, and `SecondaryPaneTabs`: migrate current persisted state; preserve all current surfaces; route files into the secondary pane; sanitize per-environment/thread hydration; support close operations, active-only mounting, maximize, <=760-pixel stacking, narrow sheets, and current performance behavior. Preserve selected-script fallback, primary fallback, and add-script intent with a focused test.
- [x] P13: `apps/web/src/components/source-control/SourceControlPanel.tsx` and lowercase `sourceControlPanel.logic.ts`: build Changes and Pull requests views on current PR list/detail/stack/comment/check/reaction/routing components. Capability-gate index operations and preserve older-server fallbacks, ChatView, command palette, shortcuts, keybindings, chat links, and the bottom-left PR entry point.
- [x] P14: `DesktopAttachedBackend`, `DesktopAttachedBackendEndpoints`, `primaryBackend` IPC, current desktop backend manager/pool/settings/protocol/main process, and server `serve`/`pair --owner`: accept only loopback HTTP owner pairing; reject userinfo, unknown parameters, non-admin credentials, changed identity, and already-owned endpoints; use current authorization and environment descriptors; persist safeStorage ciphertext and non-secret metadata; proxy through the primary slot; disable process-owned controls; serialize selection, renewal, and recovery; leave the CLI server running on Electron exit.
- [x] P15: Surfaces and documentation: cover web/desktop features, mobile counts and server-side MCP benefit, all six providers, local/direct-remote/relay/tunnel URL handling, and every reverse state. Port only durable user and internal documentation for notifications, MCP, OpenCode, Source Control, workspace panes, activity, remote access, migrations, provider constraints, and glossary terms.
- [x] P16: Validation: run V1-V9 after the relevant phases and as the final targeted gate. With explicit computer-use approval, run V10. Do not run repository-wide tests, typechecks, or checks.

## Validation

- [x] V1 - migrations:

  ```bash
  vp test run \
    apps/server/src/persistence/Migrations.forkSequence.test.ts \
    apps/server/src/persistence/Migrations/fork/001_ProjectionTurnsProvenance.test.ts \
    apps/server/src/persistence/Migrations/fork/004_McpCatalogScopes.test.ts \
    apps/server/src/persistence/Migrations/fork/005_McpCatalogRevisions.test.ts \
    apps/server/src/persistence/Migrations/fork/006_McpCatalogAppliedCatalog.test.ts \
    apps/server/src/persistence/Migrations/fork/008_RepairTextMcpCatalogInitialization.test.ts \
    apps/server/src/persistence/Migrations/050_ProjectionThreadPullRequests.test.ts \
    apps/server/src/persistence/Migrations/051_ProjectionThreadMessageContext.test.ts \
    apps/server/scripts/migrate-dev-db.test.ts
  ```

- [x] V2 - MCP:

  ```bash
  vp test run \
    packages/contracts/src/mcpCatalog.test.ts \
    packages/contracts/src/projectMcp.test.ts \
    packages/contracts/src/providerCommands.test.ts \
    apps/server/src/mcp/ProjectMcpSdk.test.ts \
    apps/server/src/mcp/ProjectMcpSecretStore.test.ts \
    apps/server/src/mcp/ProjectMcpTransport.test.ts \
    apps/server/src/mcp/ProjectMcpConnection.test.ts \
    apps/server/src/mcp/ProjectMcpBroker.test.ts \
    apps/server/src/mcp/ProjectMcpOAuth.test.ts \
    apps/server/src/mcp/ProjectMcpOAuthHttp.test.ts \
    apps/server/src/mcp/ProjectMcpProxyHttpServer.test.ts \
    apps/server/src/mcp/ProjectMcpProxyRegistry.test.ts \
    apps/server/src/mcp/McpCatalogResolver.test.ts \
    apps/server/src/mcp/McpCatalogService.test.ts \
    apps/server/src/mcp/McpCatalogGateway.test.ts \
    apps/server/src/mcp/McpCatalogGateway.contract.test.ts \
    apps/server/src/mcp/McpInvocationContext.test.ts \
    apps/server/src/mcp/McpSessionRegistry.test.ts \
    apps/server/src/orchestration/decider.mcpCatalog.test.ts \
    apps/server/src/project/ProjectMcpService.test.ts \
    apps/web/src/components/settings/ProjectMcpSettings.test.tsx
  ```

- [x] V3 - providers and OpenCode:

  ```bash
  vp test run \
    apps/server/src/provider/Layers/AntigravityAdapter.test.ts \
    apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
    apps/server/src/provider/Layers/CodexAdapter.test.ts \
    apps/server/src/provider/Layers/CursorAdapter.test.ts \
    apps/server/src/provider/Layers/GrokAdapter.test.ts \
    apps/server/src/provider/Layers/OpenCodeAdapter.test.ts \
    apps/server/src/provider/OpenCodeServerOwner.test.ts \
    apps/server/src/provider/OpenCodeExternalMcpCoordinator.test.ts \
    apps/server/src/provider/OpenCodeExternalMcpUrl.test.ts \
    apps/server/src/provider/OpenCodeExternalMcp.integration.test.ts \
    apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
  ```

- [x] V4 - notifications:

  ```bash
  vp test run \
    apps/server/src/notifications/ExternalNotificationDispatcher.test.ts \
    apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts \
    apps/server/src/relay/AgentAwarenessRelay.test.ts \
    apps/server/src/serverSettings.test.ts \
    packages/shared/src/serverSettings.test.ts \
    apps/web/src/components/settings/ExternalNotificationsSettings.logic.test.ts \
    apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx
  ```

- [x] V5 - Git and pull requests:

  ```bash
  vp test run \
    packages/contracts/src/git.test.ts \
    packages/contracts/src/vcs.test.ts \
    packages/contracts/src/pullRequest.test.ts \
    apps/server/src/git/GitWorkflowService.test.ts \
    apps/server/src/git/GitManager.test.ts \
    apps/server/src/vcs/GitVcsDriver.test.ts \
    apps/server/src/vcs/GitVcsDriverCore.test.ts \
    apps/server/src/orchestration/decider.pullRequests.test.ts \
    apps/server/src/orchestration/projector.pullRequests.test.ts \
    apps/server/src/pullRequest/PullRequestService.test.ts \
    apps/server/src/pullRequest/githubStackActions.test.ts \
    apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts \
    apps/web/src/components/source-control/sourceControlPanel.logic.test.ts \
    apps/web/src/components/source-control/SourceControlPanel.interaction.test.tsx
  ```

- [x] V6 - activity and workspace:

  ```bash
  vp test run \
    packages/shared/src/turnWorkCounts.test.ts \
    apps/server/src/orchestration/messageContext.test.ts \
    apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
    apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
    apps/web/src/rightPanelStore.test.ts \
    apps/web/src/secondaryPaneStore.test.ts \
    apps/web/src/workspacePaneLayout.test.ts \
    apps/web/src/components/RightPanelTabs.test.tsx \
    apps/web/src/components/ChatView.logic.test.ts \
    apps/web/src/components/chat/MessagesTimeline.logic.test.ts \
    apps/web/src/components/chat/MessagesTimeline.test.tsx \
    apps/mobile/src/lib/threadActivity.test.ts
  ```

- [x] V7 - desktop and authorization:

  ```bash
  vp test run \
    apps/desktop/src/backend/DesktopAttachedBackend.test.ts \
    apps/desktop/src/backend/DesktopAttachedBackendEndpoints.test.ts \
    apps/desktop/src/ipc/methods/primaryBackend.test.ts \
    apps/desktop/src/app/DesktopLaunchIntent.test.ts \
    apps/desktop/src/backend/DesktopBackendManager.test.ts \
    apps/desktop/src/backend/DesktopBackendPool.test.ts \
    apps/desktop/src/electron/ElectronProtocol.test.ts \
    apps/server/src/auth/RpcAuthorization.test.ts \
    apps/server/src/cli/pair.test.ts
  ```

- [x] V8 - targeted typechecks:

  ```bash
  vp run --filter @t3tools/contracts --filter @t3tools/shared --filter @t3tools/client-runtime typecheck
  vp run --filter t3 typecheck
  vp run --filter @t3tools/web typecheck
  vp run --filter @t3tools/desktop typecheck
  vp run --filter @t3tools/mobile typecheck
  ```

- [x] V9 - structural checks against the immutable base. If neither MCP patch is retained, omit the two exclusion pathspecs:

  ```bash
  git diff --check 0310cbf9f46ca94e9df0231a3440bca08ac44709...HEAD -- . \
    ':(exclude)patches/@modelcontextprotocol__client@2.0.0.patch' \
    ':(exclude)patches/@modelcontextprotocol__server@2.0.0.patch'
  git diff --stat 0310cbf9f46ca94e9df0231a3440bca08ac44709...HEAD
  git log --oneline --decorate 0310cbf9f46ca94e9df0231a3440bca08ac44709..HEAD
  ```

- [x] V10 - integrated checks, only with explicit computer-use approval:

  Passed with explicit computer-use approval. The web app completed pairing, onboarding, settings, notifications, provider availability, project actions and MCP configuration, persistent workspace panes, attachment removal confirmation, Source Control changes and pull-request views, a rendered nested-project working-tree diff, and harmless end-to-end Codex turns. A preserved-state cold restart recovered a malformed MCP catalog projection and a fresh first turn persisted an applied catalog receipt without an invariant error. The desktop production build and Electron smoke test passed. Mobile was deliberately deferred at the user's direction.

  ```text
  test-t3-app
  vp run --filter @t3tools/desktop smoke-test
  test-t3-mobile  # deferred by user
  ```

## Outcome

Implemented and integrated-validated for web and desktop. V1-V7 passed 2,048 focused tests; all targeted contract, shared, client-runtime, server, web, desktop, and mobile typechecks passed; V9 confirmed the immutable base, formatting, and structural integrity. Independent GPT-6 Astra reviews at medium effort iterated to `PASS` after correcting guarded Git publication, OpenCode termination/MCP handoff, secondary-pane migration/routing, turn-provenance presentation, Source Control review/confirmation/scope behavior, and desktop runtime attachment transitions. V10 passed for web and desktop with explicit computer-use approval; mobile integrated validation was deliberately deferred at the user's direction. The integrated pass also found and fixed nested-project Git status paths that prevented Source Control diffs from rendering, an MCP catalog link lost during provider runtime updates, and swapped MCP catalog projection columns that broke cold restart. Fork migration 8 safely repairs the malformed SQLite TEXT-affinity rows while migration 7 remains immutable.

Material risks and rollback constraints:

- MCP is the highest-risk subsystem. Keep dependency, transport, catalog, provider, and external-OpenCode commits separate.
- Change OpenCode through focused behavior gaps, not file replacement.
- Exercise Git mutations only in temporary repositories.
- Fork migrations are additive and have no down migration. Back up representative databases and prove that an older binary tolerates the extra fork table and columns before declaring rollback safe.
- Never place MCP credentials, webhook URLs, owner tokens, or bearer tokens in logs, events, RPC fixtures, or committed snapshots.
- Revert feature commits in reverse dependency order. Keep `origin/main` unchanged until the branch passes V1-V10 as applicable.
