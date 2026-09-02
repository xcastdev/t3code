# Project MCP catalog implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Let users manage project-scoped remote HTTP MCP servers and attach them to compatible provider sessions.

**Architecture:** Persist external MCP records with a project, expose typed project RPCs, and resolve them once at provider-session start. Each adapter translates resolved records to native configuration. The web settings page renders server-supplied provider application modes.

**Tech Stack:** TypeScript, Effect, Effect Schema, WebSocket RPC, React, Effect Atom.

**Spec:** `docs/superpowers/specs/2026-09-02-project-mcp-catalog-design.md`

## Global constraints

- Store external MCP records with the project, not `settings.json`.
- Support remote HTTP MCP only. Accept HTTPS and loopback HTTP URLs.
- Do not add headers, secrets, OAuth, stdio, health checks, mobile UI, or active reload behavior.
- Keep T3 preview MCP outside mutable catalog persistence.
- Return application modes from the server. Do not guess them in the client.
- Run focused tests only. Do not run repository-wide checks.

## File structure

- `packages/contracts/src/projectMcp.ts` defines records, application modes, RPC input, output, and errors.
- `packages/contracts/src/rpc.ts` exposes list, create, update, and remove methods.
- `apps/server/src/project/ProjectMcpService.ts` owns persistence, validation, and session-time resolution.
- `packages/contracts/src/orchestration.ts`, `apps/server/src/orchestration/decider.ts`, and `apps/server/src/orchestration/projector.ts` own catalog commands, events, and replay.
- `apps/server/src/persistence/Migrations.ts` and a numbered migration create the projection table and register it.
- `apps/server/src/provider/Layers/ProviderService.ts` resolves project MCP before it starts an adapter session.
- `apps/server/src/provider/Services/ProviderAdapter.ts` declares remote HTTP MCP capability.
- `apps/server/src/provider/Layers/*Adapter.ts` converts resolved records to native provider configuration.
- `apps/server/src/ws.ts` routes authorized calls.
- `apps/web/src/components/settings/ProjectSettingsPanel.tsx` mounts an environment-scoped catalog section.

### Task 1: Define the contract

**Files:**

- Create: `packages/contracts/src/projectMcp.ts`
- Create: `packages/contracts/src/projectMcp.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/rpc.ts`

**Produces:** `ProjectMcpServer`, `ProjectMcpCatalog`, `ProjectMcpApplicationMode`, and four typed RPC definitions.

- [ ] **Step 1: Write the failing schema test**

```ts
it("rejects an external HTTP URL", () => {
  expect(() =>
    decodeProjectMcpServer({
      id: "mcp-1",
      name: "Docs",
      url: "http://example.com/mcp",
      enabled: true,
      providerInstanceIds: [],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the focused test**

Run: `vp test run packages/contracts/src/projectMcp.test.ts`

Expected: FAIL because the contract does not exist.

- [ ] **Step 3: Add schemas and RPCs**

```ts
export const ProjectMcpApplicationMode = Schema.Literals([
  "active-session",
  "next-session",
  "unsupported",
]);
export const ProjectMcpServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  url: ProjectMcpUrl,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
```

Define `projectMcp.list`, `projectMcp.create`, `projectMcp.update`, and `projectMcp.remove`. Every input includes `projectId`. Constrain name, URL length, URL scheme, userinfo, and query. Keep the provider ID array valid when it is empty.

- [ ] **Step 4: Run the focused test**

Run: `vp test run packages/contracts/src/projectMcp.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/projectMcp.ts packages/contracts/src/projectMcp.test.ts packages/contracts/src/index.ts packages/contracts/src/rpc.ts
git commit -m "feat(contracts): add project MCP catalog schema"
```

### Task 2: Persist and resolve entries

**Files:**

- Create: `apps/server/src/project/ProjectMcpService.ts`
- Create: `apps/server/src/project/ProjectMcpService.test.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Create: `apps/server/src/persistence/Migrations/044_ProjectionProjectMcpServers.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/server.ts`

**Consumes:** Task 1 contracts.

**Produces:** `ProjectMcpService.list`, `create`, `update`, `remove`, and `resolveForSession`.

- [ ] **Step 1: Write failing service tests**

```ts
it.effect("resolves only enabled entries for the selected project and provider", () =>
  Effect.gen(function* () {
    expect(yield* service.resolveForSession(projectA, codexInstance)).toEqual([codexEntry]);
  }).pipe(Effect.provide(testLayer)),
);
```

Include a Project B entry in the fixture. It must never resolve for Project A.

- [ ] **Step 2: Run the focused test**

Run: `vp test run apps/server/src/project/ProjectMcpService.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement persistence and validation**

Add `project.mcp-server.created`, `project.mcp-server.updated`, and `project.mcp-server.removed` events and matching commands. The decider validates the command's aggregate state. The projector upserts and deletes rows in `projection_project_mcp_servers`. The migration creates a project-ID index. Rebuild replay must produce the same rows as live projection. Generate IDs in the command service. Reject duplicate case-folded names, non-loopback `http:` URLs, URL userinfo and queries, unknown provider instance IDs, and IDs outside the caller's project authority. Disabled and later-removed provider IDs remain visible as `unavailable`. Return built-in managed rows only as derived read-model rows. Never persist them.

- [ ] **Step 4: Implement neutral resolution**

```ts
resolveForSession(projectId, providerInstanceId) {
  return this.read(projectId).pipe(Effect.map((catalog) =>
    catalog.external.filter((entry) =>
      entry.enabled && entry.providerInstanceIds.includes(providerInstanceId))));
}
```

Keep this result adapter-neutral.

- [ ] **Step 5: Run focused tests**

Run: `vp test run apps/server/src/project/ProjectMcpService.test.ts`

Expected: PASS, including command replay, deletion, URL policy, project isolation, empty provider arrays, and stale provider IDs.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/project apps/server/src/orchestration packages/contracts/src
git commit -m "feat(server): persist project MCP servers"
```

### Task 3: Route catalog operations and attach sessions

**Files:**

- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Modify: `apps/server/src/provider/Layers/CursorAdapter.ts`
- Modify: `apps/server/src/provider/Layers/GrokAdapter.ts`
- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- Test: `apps/server/src/server.test.ts` and focused adapter tests
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Modify: `apps/server/src/provider/Services/ProviderAdapter.ts`
- Modify: `apps/server/src/provider/Services/ProviderService.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts` recovery path
- Modify: `apps/server/src/serverRuntimeStartup.ts`

**Produces:** Native external MCP configuration and an application mode for each provider instance.

- [ ] **Step 1: Write failing routing and adapter tests**

```ts
it.effect("passes a resolved project MCP server to Claude", () =>
  Effect.gen(function* () {
    yield* startSession(projectWithMcp);
    expect(capturedQueryOptions.mcpServers?.docs.url).toBe("https://docs.example.test/mcp");
  }).pipe(Effect.provide(testLayer)),
);
```

- [ ] **Step 2: Run targeted tests**

Run: `vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/server.test.ts`

Expected: FAIL because only `t3-code` is attached.

- [ ] **Step 3: Add handlers and session input**

Register list with environment read and mutations with environment operate in `RpcAuthorization.ts`, then validate project ownership in the handler. Add a server capability advertised to clients before they invoke the methods. Add `remoteHttpMcp` to `ProviderAdapterCapabilities` and test registry-derived modes. Give `ProviderService` a durable thread-to-project lookup and resolve catalog entries centrally in `startSession`. Prove that the normal `ProviderCommandReactor`, internal `recoverSessionForThread`, and process-restart recovery in `serverRuntimeStartup.ts` all call that path. Pass `ReadonlyArray<ResolvedProjectMcpServer>` to adapter session input. Do not change preview credential issuance.

- [ ] **Step 4: Convert per adapter**

Each adapter either converts remote HTTP records to native configuration or returns `unsupported`. Use `next-session` where the native runtime reads MCP configuration only at session start. Derive native keys from immutable server IDs. Add a regression case with an external display name of `t3-code`. Preserve each adapter's existing preview MCP entry.

- [ ] **Step 5: Run focused server tests**

Run: `vp test run apps/server/src/server.test.ts apps/server/src/serverRuntimeStartup.reconcile.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/provider
git commit -m "feat(server): attach project MCP servers to sessions"
```

### Task 4: Add project settings

**Files:**

- Create: `apps/web/src/components/settings/ProjectMcpSettings.tsx`
- Create: `apps/web/src/components/settings/ProjectMcpSettings.test.tsx`
- Modify: `apps/web/src/components/settings/ProjectSettingsPanel.tsx`
- Modify: the environment-scoped web RPC atom module

**Produces:** An external-server list and an add/edit form.

- [ ] **Step 1: Write failing UI tests**

```ts
it("labels next-session support honestly", () => {
  expect(applicationLabel("next-session")).toBe("Applies to new sessions");
});
it("does not expose mutation controls for a managed entry", () => {
  expect(canEdit(managedEntry)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test**

Run: `vp test run apps/web/src/components/settings/ProjectMcpSettings.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the list and form**

Show the name, URL host, enabled state, selected providers, and every provider's application label for the selected environment and physical project. Disable controls for derived managed rows. Reject blank names and URLs, but allow an empty provider selection as a saved-but-unattached entry. Hide the section when the connected server does not advertise the catalog capability. Re-read the catalog after a mutation.

- [ ] **Step 4: Run the focused UI test**

Run: `vp test run apps/web/src/components/settings/ProjectMcpSettings.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings apps/web/src/state
git commit -m "feat(web): manage project MCP servers"
```

### Task 5: Document the user-visible behavior

**Files:**

- Create: `docs/user/project-mcp-servers.md`
- Modify: the applicable user-doc navigation file

- [ ] **Step 1: Document project scope and session timing**

State that external MCP servers apply only to the configured project and may require a new provider session. State that T3-managed servers are visible but cannot be changed. Do not mention repository paths or implementation internals.

- [ ] **Step 2: Commit the documentation**

Commit the two user documentation files with `docs: explain project MCP servers`.

## Plan review

The tasks cover the spec's contract, event-sourced persistence, session and recovery resolution, provider matrix, protected managed entries, settings UI, and user docs. They deliberately exclude secrets, headers, stdio, health checks, mobile, and live reload. Both feature plans modify `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts`; rebase the second worktree before integration and resolve those small hotspot conflicts deliberately.
