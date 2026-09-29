Github Tracked: false
Status: completed
Github Issue: none

# Shared resource inventory

## Goal

Give web and desktop users one Resources page to find managed MCP servers, skills, commands, and snippets, see their scope and state, and open the existing editor for a specific item. Compose existing catalog reads in the client; each catalog remains authoritative.

## Scope

- In: one selected environment or project checkout; inherited, overridden, disabled, invalid, and orphaned entries where the catalogs report them; local name/key search and type filtering; exact editor destinations; independent catalog loading and errors; settings navigation and user guidance.
- Out: mobile and relay-specific work, provider-native skills, T3 built-in MCP tools, managed agent definitions, direct mutations from the inventory, new persistence or wire contracts, and changes to provider delivery rules.

## Design decisions

- Keep the existing Skills and Commands editor routes and direct links. Replace only their settings sidebar entries with Resources. Integrations and Project settings remain the MCP editors.
- Build inventory rows from the existing summary queries. Never fetch skill or command bodies, skill history or deployment, MCP credentials, OAuth state, or connection probes for the inventory. Show configured and assigned state without calling an MCP server connected.
- Resolve uniqueness from the full settings scope before checking connection state. A project with multiple checkouts must select one checkout, even when only one is connected. An explicit missing or disconnected target never falls back to another environment.
- Use each catalog's own state labels. A project override appears with its inherited source as one logical resource. Show source-removed MCP overrides and skill diagnostics as recovery/diagnostic rows; do not pretend they are editable definitions.
- Use a validated, namespaced URL item target for editor navigation. Include resource type, owning scope, stable item identity, and create intent. Preserve the selected environment/checkout. When a target disappears, show a missing-item state rather than selecting another resource.
- Gate scoped MCP reads with the existing environment capability flags. For skills and text resources, which have no catalog capability flags, report a catalog-specific read failure and retry if the request fails; do not infer unsupported status from an error string. On a legacy project MCP server, show scoped MCP inventory unavailable and link to its existing project editor.

## Acceptance criteria

- [x] AC-1: For one selected environment or checkout, Resources lists managed MCP servers, skills, commands, and snippets with type, name/key, owning scope, and catalog-derived state. It does not mix entries from another target.
- [x] AC-2: The project view includes inherited, overridden, disabled, invalid, and orphaned entries or diagnostics where reported. Provider-native skills and built-in MCP tools are excluded. A diagnostic or orphan row leads to its corresponding recovery context without offering an invalid edit action.
- [x] AC-3: Name/key search and resource-type filtering work across the combined inventory; same-named resources remain distinct by type and identity.
- [x] AC-4: Selecting a normal entry or add action opens its existing editor at the correct target and item/form, including a nonprimary global MCP environment and inherited project entries. Old direct editor routes remain valid. A stale item target never selects or edits another item.
- [x] AC-5: After an editor mutation, returning to Resources reflects the current catalogs. If one catalog fails, the others remain visible with an error and retry for that type. Missing scoped MCP capability is shown explicitly without an unsupported RPC request.
- [x] AC-6: Ambiguous, unavailable, or disconnected selections do not issue catalog reads or silently choose a representative checkout. Inventory loading does not request bodies, history, deployment, OAuth, credentials, or live connection state.
- [x] AC-7: The Resources page replaces Skills and Commands in the web/desktop settings sidebar. Existing editor URLs, authorization, revisions, and provider application behavior continue to work; mobile and relay behavior stays as it is.

## Plan

- [x] P1 (AC-1, AC-2, AC-3, AC-6): Add a pure inventory projection in `apps/web/src/features/resources/resourceInventory.ts` with focused tests. Adapt `SkillCatalogListResult` managed entries and diagnostics, `ManagedTextResourceCatalogListResult`, and `McpCatalogGlobalState`/`McpCatalogProjectState`. Fold MCP overrides by logical server ID, retain orphan overrides, retain kind-specific status, and project only safe summary fields. Use a stable row key including kind, scope, and resource identity; never merge same-named types.
- [x] P2 (AC-2, AC-4, AC-7): Add `apps/web/src/features/resources/resourceTarget.ts` with parsing/building tests, then teach `apps/web/src/features/skills/SkillsSettings.tsx`, `apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.tsx`, and `apps/web/src/components/settings/McpCatalogSettings.tsx` to consume validated item/create targets after their catalog loads. Validate targets on `apps/web/src/routes/settings.skills.tsx`, `settings.commands.tsx`, `settings.integrations.tsx`, and `settings.projects.tsx`; test direct reloads with the selected scope. Cover skill ID versus a diagnostic locator checked against the loaded list, text kind/key/owning scope, MCP definition versus override ID, and missing targets. Diagnostic and orphan targets highlight their existing rows and recovery controls; they do not open an invalid editor. Suppress the skills editor's automatic first-item selection for a diagnostic target. A target change updates selection without resetting a dirty draft on an unrelated catalog refresh.
- [x] P3 (AC-4, AC-7): Wire project MCP destinations through `apps/web/src/components/settings/ProjectSettingsPanel.tsx` and `ProjectMcpSettings.tsx`. Wire global MCP destinations through `apps/web/src/components/settings/IntegrationsSettings.tsx` so an explicit settings environment wins over its current primary-environment default and unavailable explicit targets cannot fall back. Add interaction tests for a nonprimary environment, inherited/override entries, route changes while mounted, and stale destinations.
- [x] P4 (AC-1, AC-3, AC-5, AC-6): Add `apps/web/src/features/resources/ResourcesSettings.tsx` and `apps/web/src/routes/settings.resources.tsx`. Use `useSettingsScope()` to require one physical target before constructing the existing catalog queries; subscribe to their existing change streams. Keep each type's loading, error, retry, and capability state independent. Add local search/type filters and row/add links. Test ambiguous scopes including two checkouts on one environment, a disconnected member, an explicitly disconnected checkout, and a stale checkout; assert that no catalog reads occur until a valid target exists. Test partial failure, unsupported scoped MCP, refresh after mutations, and that inventory loading never calls content, history, deployment, OAuth, or credential APIs.
- [x] P5 (AC-4, AC-7): Update `apps/web/src/components/settings/settingsSearch.ts`, `SettingsSidebarNav.tsx`, and settings navigation tests for the Resources route. Keep Skills/Commands labels and search destinations for direct links while hiding only their sidebar entries. Regenerate and review tracked `apps/web/src/routeTree.gen.ts` through the existing TanStack Router Vite plugin.
- [x] P6 (AC-1, AC-4, AC-7): Update `docs/user/skills.md`, `docs/user/composer.md`, and `docs/user/project-mcp-servers.md` to direct users through Resources and the existing editors. Update `docs/agent-workspace-checklist.md` to mark the shared view complete while leaving catalog service unification open.

## Validation

- [x] `vp test run apps/web/src/features/resources/resourceInventory.test.ts apps/web/src/features/resources/resourceTarget.test.ts apps/web/src/features/resources/ResourcesSettings.test.tsx apps/web/src/features/skills/SkillsSettings.test.tsx apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.test.tsx apps/web/src/components/settings/McpCatalogSettings.test.tsx apps/web/src/components/settings/ProjectMcpSettings.test.tsx apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx apps/web/src/components/settings/settingsScopeNavigation.test.ts apps/web/src/components/settings/settingsSearch.test.ts`
- [x] `vp run --filter @t3tools/web typecheck`
- [x] `vp lint apps/web/src/features/resources apps/web/src/features/skills/SkillsSettings.tsx apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.tsx apps/web/src/components/settings/McpCatalogSettings.tsx apps/web/src/components/settings/ProjectMcpSettings.tsx apps/web/src/components/settings/ProjectSettingsPanel.tsx apps/web/src/components/settings/IntegrationsSettings.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/routes/settings.resources.tsx apps/web/src/routes/settings.skills.tsx apps/web/src/routes/settings.commands.tsx apps/web/src/routes/settings.integrations.tsx apps/web/src/routes/settings.projects.tsx`
- [x] `git diff --check`

## Risks and rollback

The existing project MCP editor lives under Project settings, while the global editor has its own environment picker. The item target and explicit environment must agree before opening either editor. Catalog errors lack a structured unsupported code for skills and text resources, so those failures must stay honest and type-specific. Rollback removes the Resources route/navigation and item-target handling; no migration or saved resource data changes are involved. Browser verification requires separate user approval under the repository instructions.

## Outcome

Implemented locally and validated. Resources now composes the existing skill, text-resource, and MCP summary catalogs for one physical settings target, with independent loading and retry, search and type filters, and exact editor destinations. The existing editor routes remain available. The settings sidebar and user guidance now point to Resources. No persistence or wire contract changed.

Changed files: `apps/web/src/features/resources/` and `settings.resources.tsx`; settings scope, navigation, search, Skills, managed text, MCP, Integrations, Projects, route validation, and generated route tree under `apps/web/src/`; `docs/user/skills.md`, `docs/user/composer.md`, `docs/user/project-mcp-servers.md`, and `docs/agent-workspace-checklist.md`.

Validation: the saved focused test list plus `resourceScope.test.ts` passed (11 files, 139 tests); `vp run --filter @t3tools/web typecheck` passed with Effect suggestions; the saved focused `vp lint` command exited 0 with warnings; `git diff --check` passed. The independent Astra validation passed AC-1 through AC-7 after one repair attempt.

Deviation: added a pure physical-scope resolver and test so checkout ambiguity is established before connection filtering. Repair tests exposed a skill catalog scope mapping bug; the editor now maps the environment route scope to the catalog's global scope.

Live browser verification was approved and run in a disposable environment in dark mode with two parallel preview tabs. It covered environment and project inventories, all four add destinations, inherited items, project disabling and restoring, an MCP override, cross-tab catalog refresh, search, type filters, and exact editor destinations. It exposed and led to fixes for hash navigation dropping resource targets, project MCP state missing global invalidation, project override targets not opening their form, and inherited skill targets using the catalog's `global` scope instead of the environment ID. The final focused run passed 12 files and 142 tests; web and client-runtime typechecks, focused lint, and `git diff --check` exited 0. Browser MP4s are kept as external evidence, not committed to the repository. A later parallel-browser-MCP pass used a second disposable server to verify the nonprimary environment editor and inventory, explicit disconnected environment and checkout messages, an orphan MCP override and its recovery destination, and a partial skill catalog failure while MCP rows remained visible. The failure was isolated by temporarily redirecting the second server's managed skills directory outside its state root; the directory was restored and the error cleared. This MCP has screenshot capture but no video recording command, so those four MP4s encode dark-mode screenshots captured at each browser state.

Validation-stage verdict: PASS. The earlier independent Astra review passed AC-1 through AC-7 before live testing. The subsequent live pass repaired four defects and reran the focused checks listed above.
