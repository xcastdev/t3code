Github Tracked: false
Status: planned
Github Issue: none

# Scoped MCP editors and live reload

## Goal

Expose global, project-override, and active-session MCP catalog editing on web and desktop. Apply catalog changes without restarting only for providers whose real MCP clients handle list-change notifications. Keep restart-required behavior and explicit external OpenCode ownership where needed.

## Scope

- In: Shared client state for scoped catalog RPCs; global, project, and session editors; a production aggregate gateway and catalog-application reactor; per-provider live capability tests; clearer external OpenCode setup; documentation updates.
- Out: Mobile MCP editing, silent management of external OpenCode, cross-process or native-client OpenCode locking, forcing live mode on unproven providers, and removal of legacy `projectMcp.*` APIs.

## Acceptance criteria

- [ ] AC-1: A capable web or desktop client can create, edit, disable, and remove environment-global MCP definitions.
- [ ] AC-2: Project settings distinguish inherited, project-local, and overridden definitions; users can create and remove complete project overrides without changing global definitions.
- [ ] AC-3: An active thread can show its captured catalog, desired/applied revisions and failures, make session-local changes, and reset to current defaults.
- [ ] AC-4: A provider connected to the aggregate gateway sees upstream server additions, replacements, and removals through MCP list-change notifications without reconnecting; credentials remain server-side.
- [ ] AC-5: Each adapter reports `live` only after an integration test proves its native MCP client observes catalog changes. Adapters that do not pass remain `restart-required`.
- [ ] AC-6: A failed live apply persists `apply-failed`, preserves the last applied catalog, and allows a later revision to apply without restarting T3 Code.
- [ ] AC-7: External OpenCode stays unmanaged until the existing explicit opt-in is enabled; blocked MCP UI links to that setting and validates its public origin.
- [ ] AC-8: Older environments retain the legacy project-local editor through capability gating. Mobile remains consumption-only for this scope.

## Plan

- [ ] P1: `apps/server/src/mcp/McpCatalogGateway.ts`, `McpCatalogGateway.contract.test.ts`, and new gateway route tests: replace the current registry-only helper with a production aggregate MCP server. Keep stable provider-facing identity, namespace tools/resources/prompts, atomically swap revisions, and emit list-change notifications from the production implementation.
- [ ] P2: `apps/server/src/mcp/McpCatalogGatewayHttpServer.ts`, `McpSessionRegistry.ts`, and `server.ts`: mount an authenticated gateway endpoint beside the existing project proxy routes. Bind it to provider-scoped credentials and revoke it with the provider session.
- [ ] P3: new `apps/server/src/orchestration/Layers/McpCatalogReactor.ts` and service/tests, `ProviderService.ts`, and `McpProviderSession.ts`: react to session catalog update, reset, and disposal events; serialize work per logical catalog session; dispatch applied or failed receipts; preserve the last applied revision after failure; wire startup and shutdown draining.
- [ ] P4: `apps/server/src/provider/Layers/{Codex,Claude,Cursor,Grok,Antigravity,OpenCode}Adapter.ts` and their tests: inject the stable aggregate endpoint for live-capable adapters, exercise real client list changes, and set `sessionMcpCatalog` to `live` only where proven. Retain existing per-server launch configuration as the fallback.
- [ ] P5: new `packages/client-runtime/src/state/mcpCatalog.ts`, its package export, and web state bindings: wrap global, project-state, override, session, OAuth, and catalog-subscription RPCs. Serialize mutations by scope, invalidate state on revision notices, and independently gate global, override, and session controls by environment capability.
- [ ] P6: `apps/web/src/components/settings/ProjectMcpSettings.tsx`, new shared scoped-editor components, `IntegrationsSettings.tsx`, `ProjectSettingsPanel.tsx`, and settings search: extract reusable transport, credentials, OAuth, and provider controls. Add global definitions under Integrations and inherited/project-local/override sections under Project settings; preserve unsaved drafts after stale-revision refreshes.
- [ ] P7: `apps/web/src/components/threadActionMenu.logic.ts`, `hooks/useThreadActionMenu.ts`, ChatView dialog hosting, and a new thread catalog dialog: expose session editing from both thread action-menu surfaces, display desired/applied application state and failures, and offer Reset to current defaults.
- [ ] P8: `ProviderSettingsForm.tsx`, `ProjectMcpSettings.tsx`, `OpenCodeAdapter.ts`, and OpenCode integration tests: retain the external OpenCode opt-in, surface its blocked reason and a direct settings path, validate remote public-origin configuration before session start, and use live mode only if the external-client test proves it.
- [ ] P9: `docs/internals/mcp-catalog-scopes.md`, `docs/user/project-mcp-servers.md`, and `docs/user/providers-opencode.md`: document actual aggregate gateway behavior, scope inheritance, session reset, live versus restart-required application, and external OpenCode ownership.

## Validation

- [ ] `vp test run packages/contracts/src/mcpCatalog.test.ts packages/client-runtime/src/state/mcpCatalog.test.ts apps/server/src/mcp/McpCatalogGateway.test.ts apps/server/src/mcp/McpCatalogGateway.contract.test.ts apps/server/src/mcp/McpCatalogGatewayHttpServer.test.ts apps/server/src/orchestration/Layers/McpCatalogReactor.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/provider/Layers/AntigravityAdapter.test.ts apps/server/src/provider/Layers/OpenCodeAdapter.test.ts apps/server/src/provider/OpenCodeExternalMcp.integration.test.ts apps/web/src/components/settings/McpCatalogSettings.test.tsx apps/web/src/components/settings/ProjectMcpSettings.test.tsx apps/web/src/components/ThreadMcpCatalogDialog.test.tsx apps/web/src/components/threadActionMenu.logic.test.ts`
- [ ] `vp run --filter @t3tools/contracts --filter @t3tools/client-runtime --filter t3 --filter @t3tools/web --filter @t3tools/desktop typecheck`
- [ ] With explicit computer-use approval: run one web integration pass through global definition, project override, session mutation, and reset; then run `vp run --filter @t3tools/desktop smoke-test`.

## Outcome

Planning evidence: the current worktree was clean. Focused validation passed: `vp test run packages/contracts/src/mcpCatalog.test.ts apps/server/src/mcp/McpCatalogGateway.test.ts apps/server/src/mcp/McpCatalogGateway.contract.test.ts apps/server/src/provider/OpenCodeExternalMcp.integration.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts apps/web/src/components/settings/ProjectMcpSettings.test.tsx` reported 6 files and 54 tests passed.

The completed MCP port already has scoped backend RPCs, persistence, and the project-local editor. The planned work fills the missing clients and corrects an overstatement in the gateway implementation: `McpCatalogGateway` has no production consumer or aggregate MCP route, and its contract test currently uses an in-memory fixture rather than the production gateway. External OpenCode opt-in is retained because T3 Code cannot safely claim exclusive ownership of a server shared with another T3 process or native OpenCode client.
