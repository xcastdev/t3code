Github Tracked: false
Status: planned
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

- [ ] AC-1: For one selected environment or checkout, Resources lists managed MCP servers, skills, commands, and snippets with type, name/key, owning scope, and catalog-derived state. It does not mix entries from another target.
- [ ] AC-2: The project view includes inherited, overridden, disabled, invalid, and orphaned entries or diagnostics where reported. Provider-native skills and built-in MCP tools are excluded. A diagnostic or orphan row leads to its corresponding recovery context without offering an invalid edit action.
- [ ] AC-3: Name/key search and resource-type filtering work across the combined inventory; same-named resources remain distinct by type and identity.
- [ ] AC-4: Selecting a normal entry or add action opens its existing editor at the correct target and item/form, including a nonprimary global MCP environment and inherited project entries. Old direct editor routes remain valid. A stale item target never selects or edits another item.
- [ ] AC-5: After an editor mutation, returning to Resources reflects the current catalogs. If one catalog fails, the others remain visible with an error and retry for that type. Missing scoped MCP capability is shown explicitly without an unsupported RPC request.
- [ ] AC-6: Ambiguous, unavailable, or disconnected selections do not issue catalog reads or silently choose a representative checkout. Inventory loading does not request bodies, history, deployment, OAuth, credentials, or live connection state.
- [ ] AC-7: The Resources page replaces Skills and Commands in the web/desktop settings sidebar. Existing editor URLs, authorization, revisions, and provider application behavior continue to work; mobile and relay behavior stays as it is.

## Plan

- [ ] P1 (AC-1, AC-2, AC-3, AC-6): Add a pure inventory projection in `apps/web/src/features/resources/resourceInventory.ts` with focused tests. Adapt `SkillCatalogListResult` managed entries and diagnostics, `ManagedTextResourceCatalogListResult`, and `McpCatalogGlobalState`/`McpCatalogProjectState`. Fold MCP overrides by logical server ID, retain orphan overrides, retain kind-specific status, and project only safe summary fields. Use a stable row key including kind, scope, and resource identity; never merge same-named types.
- [ ] P2 (AC-2, AC-4, AC-7): Add `apps/web/src/features/resources/resourceTarget.ts` with parsing/building tests, then teach `apps/web/src/features/skills/SkillsSettings.tsx`, `apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.tsx`, and `apps/web/src/components/settings/McpCatalogSettings.tsx` to consume validated item/create targets after their catalog loads. Validate targets on `apps/web/src/routes/settings.skills.tsx`, `settings.commands.tsx`, `settings.integrations.tsx`, and `settings.projects.tsx`; test direct reloads with the selected scope. Cover skill ID versus a diagnostic locator checked against the loaded list, text kind/key/owning scope, MCP definition versus override ID, and missing targets. Diagnostic and orphan targets highlight their existing rows and recovery controls; they do not open an invalid editor. Suppress the skills editor's automatic first-item selection for a diagnostic target. A target change updates selection without resetting a dirty draft on an unrelated catalog refresh.
- [ ] P3 (AC-4, AC-7): Wire project MCP destinations through `apps/web/src/components/settings/ProjectSettingsPanel.tsx` and `ProjectMcpSettings.tsx`. Wire global MCP destinations through `apps/web/src/components/settings/IntegrationsSettings.tsx` so an explicit settings environment wins over its current primary-environment default and unavailable explicit targets cannot fall back. Add interaction tests for a nonprimary environment, inherited/override entries, route changes while mounted, and stale destinations.
- [ ] P4 (AC-1, AC-3, AC-5, AC-6): Add `apps/web/src/features/resources/ResourcesSettings.tsx` and `apps/web/src/routes/settings.resources.tsx`. Use `useSettingsScope()` to require one physical target before constructing the existing catalog queries; subscribe to their existing change streams. Keep each type's loading, error, retry, and capability state independent. Add local search/type filters and row/add links. Test ambiguous scopes including two checkouts on one environment, a disconnected member, an explicitly disconnected checkout, and a stale checkout; assert that no catalog reads occur until a valid target exists. Test partial failure, unsupported scoped MCP, refresh after mutations, and that inventory loading never calls content, history, deployment, OAuth, or credential APIs.
- [ ] P5 (AC-4, AC-7): Update `apps/web/src/components/settings/settingsSearch.ts`, `SettingsSidebarNav.tsx`, and settings navigation tests for the Resources route. Keep Skills/Commands labels and search destinations for direct links while hiding only their sidebar entries. Regenerate and review tracked `apps/web/src/routeTree.gen.ts` through the existing TanStack Router Vite plugin.
- [ ] P6 (AC-1, AC-4, AC-7): Update `docs/user/skills.md`, `docs/user/composer.md`, and `docs/user/project-mcp-servers.md` to direct users through Resources and the existing editors. Update `docs/agent-workspace-checklist.md` to mark the shared view complete while leaving catalog service unification open.

## Validation

- [ ] `vp test run apps/web/src/features/resources/resourceInventory.test.ts apps/web/src/features/resources/resourceTarget.test.ts apps/web/src/features/resources/ResourcesSettings.test.tsx apps/web/src/features/skills/SkillsSettings.test.tsx apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.test.tsx apps/web/src/components/settings/McpCatalogSettings.test.tsx apps/web/src/components/settings/ProjectMcpSettings.test.tsx apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx apps/web/src/components/settings/settingsScopeNavigation.test.ts apps/web/src/components/settings/settingsSearch.test.ts`
- [ ] `vp run --filter @t3tools/web typecheck`
- [ ] `vp lint apps/web/src/features/resources apps/web/src/features/skills/SkillsSettings.tsx apps/web/src/features/managedTextResources/ManagedTextResourcesSettings.tsx apps/web/src/components/settings/McpCatalogSettings.tsx apps/web/src/components/settings/ProjectMcpSettings.tsx apps/web/src/components/settings/ProjectSettingsPanel.tsx apps/web/src/components/settings/IntegrationsSettings.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/routes/settings.resources.tsx apps/web/src/routes/settings.skills.tsx apps/web/src/routes/settings.commands.tsx apps/web/src/routes/settings.integrations.tsx apps/web/src/routes/settings.projects.tsx`
- [ ] `git diff --check`

## Risks and rollback

The existing project MCP editor lives under Project settings, while the global editor has its own environment picker. The item target and explicit environment must agree before opening either editor. Catalog errors lack a structured unsupported code for skills and text resources, so those failures must stay honest and type-specific. Rollback removes the Resources route/navigation and item-target handling; no migration or saved resource data changes are involved. Browser verification requires separate user approval under the repository instructions.

## Outcome

Planned; implementation has not started.
