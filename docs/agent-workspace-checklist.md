# Agent workspace checklist

Status at the current checkout. This tracks the [workspace direction](https://github.com/xcastdev/t3code/blob/pre-upstream-rebase/docs/agent-workspace-ideas.md) in its proposed dependency order. The [project knowledge research](https://github.com/xcastdev/t3code/blob/pre-upstream-rebase/docs/research/2026-09-08-durable-project-knowledge-mcp.md) gives more detail for item 2. Checked items have working code; unchecked items still have a gap. A checked subitem does not mean its parent is complete.

1. **MCP management and shared resource catalog**
   - [x] Manage scoped MCP definitions, credentials, provider assignments, and session application through the [MCP catalog](../apps/server/src/mcp/McpCatalogService.ts) and [web settings](../apps/web/src/components/settings/McpCatalogSettings.tsx).
   - [ ] Extend the catalog concept to the other agent resource types. The current MCP catalog and [skill catalog](../apps/server/src/skills/SkillCatalogService.ts) are separate services.
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
   - [ ] Preserve reverted turns and checkpoints as a recoverable branch or archive. The current reactor deletes later checkpoint refs.
   - [ ] Add a T3 thread fork that retains parent context and a reproducible starting checkpoint. The Claude adapter's provider `forkSession` call is an implementation detail of conversation rollback, not that product feature.

6. **Provider usage monitoring**
   - [x] Show token history, estimated cost, and model breakdowns for Codex, Claude Code, and Grok Build; show available Codex and Claude subscription limits and reset times. See [Usage and limits](user/usage.md), the [Usage service](../apps/server/src/usage/UsageService.ts), and [provider limit contracts](../packages/contracts/src/providerUsageLimits.ts).
   - [ ] Complete the provider-by-provider coverage described in the direction document. Other providers do not yet have the same history and limit coverage.

7. **Per-subagent controls**
   - [x] Show native subagent status in the [Agents panel](../apps/web/src/components/AgentsPanel.tsx).
   - [ ] Add separately routed transcripts, terminal and interaction controls, identities, lifecycle rules, and authorization for each subagent.

## Other proposed capability

- [ ] Expose a terminal toolkit through T3's MCP server with bounded output, read cursors, capability checks, and session cleanup. The current [MCP server](../apps/server/src/mcp/McpHttpServer.ts) registers preview, device, pull request, and Project Work toolkits, but no terminal toolkit.
