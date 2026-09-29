# Agent workspace checklist

Status at the current checkout. This tracks the [workspace direction](https://github.com/xcastdev/t3code/blob/pre-upstream-rebase/docs/agent-workspace-ideas.md) in its proposed dependency order. The [project knowledge research](https://github.com/xcastdev/t3code/blob/pre-upstream-rebase/docs/research/2026-09-08-durable-project-knowledge-mcp.md) gives more detail for item 2. Checked items have working code; unchecked items still have a gap. A checked subitem does not mean its parent is complete.

1. **MCP management and shared resource catalog**
   - [x] Manage scoped MCP definitions, credentials, provider assignments, and session application through the [MCP catalog](../apps/server/src/mcp/McpCatalogService.ts) and [web settings](../apps/web/src/components/settings/McpCatalogSettings.tsx).
   - [x] List managed MCP servers, skills, commands, and snippets for a selected environment or project checkout in web and desktop [Resources settings](../apps/web/src/features/resources/ResourcesSettings.tsx). Search and filter the combined list, then open an item or add a new one in its existing editor. Project entries include inherited resources and reported overrides, disabled entries, and diagnostics.
   - [ ] Unify the underlying catalogs behind one cross-resource API. Resources currently combines reads from the separate [MCP](../apps/server/src/mcp/McpCatalogService.ts), [skill](../apps/server/src/skills/SkillCatalogService.ts), and [text-resource](../apps/server/src/managedTextResources/ManagedTextResourceCatalogService.ts) services in the web client.
   - [ ] Add mobile editing for scoped MCP catalogs. Mobile currently consumes configured catalogs; see the [scope rules](internals/mcp-catalog-scopes.md#compatibility).

2. **Durable project knowledge and tracked tasks, with MCP access**
   - [x] Persist tasks, attempts, leases, checkpoints, decisions, knowledge, relationships, and activity in [Project Work](../apps/server/src/projectWork/ProjectWorkRepository.ts), with a [shared read contract](../packages/contracts/src/projectWork.ts).
   - [x] Provide bounded briefing and search reads, a [web Work view](../apps/web/src/components/work/WorkPage.tsx), and [MCP read/write tools](../apps/server/src/mcp/toolkits/projectWork/tools.ts).

3. **Skills, commands, agents, and snippets**
   - [x] Create, import, scope, deliver, and install [managed skills](../apps/server/src/skills/SkillCatalogService.ts); see the [user guide](user/skills.md).
   - [x] Add managed commands and text snippets with environment and project scopes, thread enablement, compatibility with provider-native commands, and mutation audit history. See the [user guide](user/composer.md#commands-snippets-and-skills).
   - [ ] Add managed agent definitions. The current subagent panel shows provider-native agents; named agent launch remains deferred until providers expose a reliable way to start one.

4. **Git workflow controls**
   - [x] Provide status, staging, diffs, commits, branches, history, and remote actions through [Source Control](user/source-control.md) and the [Git workflow service](../apps/server/src/git/GitWorkflowService.ts).

5. **Durable chat forks and reverts**
   - [x] Revert a thread conversation, optionally restoring its [workspace checkpoint](../apps/server/src/orchestration/Layers/CheckpointReactor.ts). The [projector](../apps/server/src/orchestration/projector.ts) trims the active thread's later messages and checkpoints.
   - [x] Preserve reverted turns and checkpoints in recoverable [history archives](../apps/server/src/persistence/ThreadHistoryArchive.ts). Users can inspect and restore an archived path from History; restoring also archives the path they leave.
   - [x] Fork a new T3 thread from a checkpoint in History, retaining the earlier conversation and starting checkpoint. Users can keep the current workspace files or create a separate worktree at that checkpoint; see the [user guide](user/composer.md#edit-an-earlier-prompt).

6. **Provider usage monitoring**
   - [x] Show token history, estimated cost, and model breakdowns for Codex, Claude Code, and Grok Build; show available Codex and Claude subscription limits and reset times. See [Usage and limits](user/usage.md), the [Usage service](../apps/server/src/usage/UsageService.ts), and [provider limit contracts](../packages/contracts/src/providerUsageLimits.ts).
   - [ ] Deferred until needed: complete provider-by-provider coverage. Other providers do not yet have the same history and limit coverage.

7. **Per-subagent controls**
   - [x] Show native subagent status in the [Agents panel](../apps/web/src/components/AgentsPanel.tsx).
   - [x] Open a selected subagent's captured transcript on web, desktop, and mobile, including earlier activity when available. Show when provider history is partial or unavailable; see [Subagent activity](user/chat-timeline.md#subagent-activity).
   - [x] Route supported message, stop, approval, and question actions to the selected subagent, with server-side authorization. Availability depends on the provider and active session.
   - [ ] Complete per-subagent coverage across providers, including agents that only expose grouped activity. Add individual lifecycle and interaction controls where the provider supports them.

## Other proposed capability

- [x] Expose a shared project terminal toolkit through T3's [MCP server](../apps/server/src/mcp/McpHttpServer.ts), with bounded output, read cursors, capability checks, and session cleanup. See [Agent terminals](user/terminal.md#agent-terminals).
