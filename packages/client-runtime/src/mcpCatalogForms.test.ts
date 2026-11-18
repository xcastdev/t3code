import {
  EnvironmentId,
  McpCatalogOverrideId,
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProjectId,
  ProjectMcpCredentialId,
  ProviderInstanceId,
  ThreadId,
  type McpCatalogDefinition,
  type McpCatalogSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveMcpDefinitions,
  mcpApplicationSummary,
  mcpCatalogDestinationView,
  mcpCatalogRows,
  mcpDefinitionInputFromForm,
  mcpFormFromDefinition,
  mcpOverrideFieldsFromRow,
  mcpOverrideInput,
  mcpOverridePatchFromFields,
  mcpSessionToggleOperation,
  prepareMcpFormSecrets,
  withNewCredentialValues,
  type McpCatalogRow,
  type McpOverrideFields,
} from "./mcpCatalogForms.ts";

const codex = ProviderInstanceId.make("codex");
const credentialId = ProjectMcpCredentialId.make("4f7d3c4e-3c2b-4a1d-9f4e-0d6c5b2a1e9f");

function definition(overrides: Partial<McpCatalogDefinition> = {}): McpCatalogDefinition {
  return {
    definitionId: McpDefinitionId.make("definition-1"),
    logicalServerId: McpServerId.make("server-1"),
    scope: "global",
    scopeId: "environment-1",
    name: "Docs",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "X-Api-Key" as never, credential: { id: credentialId, name: "X-Api-Key" } },
      ],
      authorization: { type: "none" },
    },
    enabled: true,
    providerInstanceIds: [codex],
    revision: 1,
    ...overrides,
  };
}

describe("MCP editor form", () => {
  it("keeps stored credentials as IDs so editing never needs or sends the secret", () => {
    const input = mcpDefinitionInputFromForm({
      ...mcpFormFromDefinition(definition()),
      name: "Docs v2",
    });
    expect(input).toEqual({
      ok: true,
      value: {
        name: "Docs v2",
        enabled: true,
        providerInstanceIds: [codex],
        allProviders: false,
        transport: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: [{ name: "X-Api-Key", credential: { id: credentialId, name: "X-Api-Key" } }],
          authorization: { type: "none" },
        },
      },
    });
    expect(input.ok && JSON.stringify(input.value.transport)).not.toMatch(/"value"|secretRef/);
  });

  it("requires a one-use secret reference for a replaced credential", () => {
    const form = mcpFormFromDefinition(definition());
    const replaced = {
      ...form,
      headers: form.headers.map((header) => ({
        ...header,
        credential: { kind: "secret-ref" as const, name: header.name, secretRef: "" },
      })),
    };
    expect(mcpDefinitionInputFromForm(replaced)).toMatchObject({ ok: false });
    const withRef = {
      ...replaced,
      headers: replaced.headers.map((header) => ({
        ...header,
        credential: { ...header.credential, secretRef: "secret-ref-1" },
      })),
    };
    expect(mcpDefinitionInputFromForm(withRef)).toMatchObject({
      ok: true,
      value: {
        transport: {
          headers: [{ credential: { name: "X-Api-Key", secretRef: "secret-ref-1" } }],
        },
      },
    });
  });

  it("rejects an Authorization header alongside OAuth and plain HTTP to remote hosts", () => {
    const form = mcpFormFromDefinition(definition());
    expect(
      mcpDefinitionInputFromForm({
        ...form,
        authorization: { type: "oauth-automatic" },
        headers: [{ ...form.headers[0]!, name: "Authorization" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      mcpDefinitionInputFromForm({ ...form, url: "http://mcp.example.com/mcp" }),
    ).toMatchObject({ ok: false });
    expect(mcpDefinitionInputFromForm({ ...form, url: "http://127.0.0.1:8080/mcp" })).toMatchObject(
      { ok: true },
    );
  });

  it("keeps stdio arguments one per line, including spaces", () => {
    expect(
      mcpDefinitionInputFromForm({
        ...mcpFormFromDefinition(definition()),
        transport: "stdio",
        command: "npx",
        args: "-y\n@scope/server\n--root=/a dir",
        env: [],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@scope/server", "--root=/a dir"],
        },
      },
    });
  });
});

describe("mcpCatalogRows", () => {
  it("applies only this project's override to an inherited definition", () => {
    const rows = mcpCatalogRows({
      inherited: [definition()],
      own: [
        definition({
          definitionId: McpDefinitionId.make("own"),
          logicalServerId: McpServerId.make("server-local"),
          scope: "project",
          name: "Local",
        }),
      ],
      overrides: [
        {
          id: McpCatalogOverrideId.make("override-1"),
          scope: "project",
          scopeId: "project-1",
          targetId: McpServerId.make("server-1"),
          enabled: false,
          providerInstanceIds: [],
        },
      ],
    });
    expect(
      rows.map((row) => [row.name, row.inherited, row.enabled, row.providerInstanceIds]),
    ).toEqual([
      ["Docs", true, false, []],
      ["Local", false, true, [codex]],
    ]);
  });

  it("lists a session's own copy of an inherited server once, with the session's override", () => {
    const own = [definition({ scope: "session", name: "Docs (thread)" })];
    const disabled = {
      id: McpCatalogOverrideId.make("override-1"),
      scope: "session" as const,
      scopeId: "session-1",
      targetId: McpServerId.make("server-1"),
      enabled: false,
    };
    expect(
      [[], [disabled]].map((overrides) =>
        mcpCatalogRows({ inherited: [definition()], own, overrides }).map((row) => [
          row.name,
          row.inherited,
          row.enabled,
          row.override?.id ?? null,
        ]),
      ),
    ).toEqual([
      [["Docs (thread)", true, true, null]],
      [["Docs (thread)", true, false, "override-1"]],
    ]);
  });

  it("keeps an inherited all-providers selection until an override names providers", () => {
    const everywhere = definition({ allProviders: true, providerInstanceIds: [] });
    const narrowed = {
      id: McpCatalogOverrideId.make("override-1"),
      scope: "project" as const,
      scopeId: "project-1",
      targetId: McpServerId.make("server-1"),
      providerInstanceIds: [codex],
    };
    expect(
      [[], [narrowed]].map(
        (overrides) =>
          mcpCatalogRows({ inherited: [everywhere], own: [], overrides })[0]!.allProviders,
      ),
    ).toEqual([true, false]);
  });
});

describe("MCP overrides", () => {
  const override = {
    id: McpCatalogOverrideId.make("override-1"),
    scope: "project" as const,
    scopeId: "project-1",
    targetId: McpServerId.make("server-1"),
    name: "Docs (project)",
    providerInstanceIds: [codex],
    transport: {
      type: "streamable-http" as const,
      url: "https://project.example.com/mcp",
      headers: [
        { name: "X-Api-Key" as never, credential: { id: credentialId, name: "X-Api-Key" } },
      ],
      authorization: { type: "none" as const },
    },
    transportDefinitionId: McpDefinitionId.make("override-transport"),
  };
  const row = mcpCatalogRows({ inherited: [definition()], own: [], overrides: [override] })[0]!;

  it("keeps every overridden field when changing only one", () => {
    const result = mcpOverrideInput({
      scope: "project",
      scopeId: "project-1",
      row,
      patch: { enabled: false },
      newId: McpCatalogOverrideId.make("unused"),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: "override-1",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        enabled: false,
        name: "Docs (project)",
        providerInstanceIds: [codex],
        transport: {
          type: "streamable-http",
          url: "https://project.example.com/mcp",
          headers: [{ name: "X-Api-Key", credential: { id: credentialId, name: "X-Api-Key" } }],
          authorization: { type: "none" },
        },
        transportDefinitionId: "override-transport",
      },
    });
  });

  it("clears a name or connection only when asked to", () => {
    const result = mcpOverrideInput({
      scope: "session",
      scopeId: "session-1",
      row,
      patch: { name: null, transport: null },
      newId: McpCatalogOverrideId.make("unused"),
    });
    expect(result.ok && result.value).toEqual({
      id: "override-1",
      scope: "session",
      scopeId: "session-1",
      targetId: "server-1",
      providerInstanceIds: [codex],
    });
  });

  it("shows what the destination effectively gets and which connection OAuth belongs to", () => {
    expect(row).toMatchObject({
      name: "Docs (project)",
      transportDefinitionId: "override-transport",
    });
    expect(effectiveMcpDefinitions([row])).toMatchObject([
      {
        name: "Docs (project)",
        enabled: true,
        transport: { url: "https://project.example.com/mcp" },
      },
    ]);
  });
});

describe("MCP override editor fields", () => {
  const build = (row: McpCatalogRow, fields: McpOverrideFields) =>
    mcpOverrideInput({
      scope: "project",
      scopeId: "project-1",
      row,
      patch: mcpOverridePatchFromFields(fields),
      newId: McpCatalogOverrideId.make("override-new"),
    });

  it("pins only the name when only the name changed, so enablement and providers keep following", () => {
    const row = mcpCatalogRows({ inherited: [definition()], own: [], overrides: [] })[0]!;
    // The editor shows the inherited on/providers values without making them fields.
    const fields = mcpOverrideFieldsFromRow(row);
    expect(fields).toEqual({
      name: "",
      enabled: null,
      providerInstanceIds: null,
      allProviders: null,
    });
    expect(build(row, { ...fields, name: "Docs (project)" })).toEqual({
      ok: true,
      value: {
        id: "override-new",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        name: "Docs (project)",
      },
    });
  });

  it("keeps an existing pinned field when another changes, and lets it follow again", () => {
    const pinned = {
      id: McpCatalogOverrideId.make("override-1"),
      scope: "project" as const,
      scopeId: "project-1",
      targetId: McpServerId.make("server-1"),
      enabled: false,
    };
    const row = mcpCatalogRows({ inherited: [definition()], own: [], overrides: [pinned] })[0]!;
    const fields = mcpOverrideFieldsFromRow(row);
    expect(build(row, { ...fields, name: "Docs (project)" })).toMatchObject({
      ok: true,
      value: { enabled: false, name: "Docs (project)" },
    });
    const followed = build(row, { ...fields, enabled: null, name: "Docs (project)" });
    expect(followed.ok && "enabled" in followed.value).toBe(false);
    expect(followed.ok && "providerInstanceIds" in followed.value).toBe(false);
  });

  it("keeps a name pin that equals the inherited name when another field changes", () => {
    const pinned = {
      id: McpCatalogOverrideId.make("override-1"),
      scope: "project" as const,
      scopeId: "project-1",
      targetId: McpServerId.make("server-1"),
      name: "Docs",
    };
    const row = mcpCatalogRows({
      inherited: [definition({ name: "Docs" })],
      own: [],
      overrides: [pinned],
    })[0]!;
    const fields = mcpOverrideFieldsFromRow(row);
    expect(fields.name).toBe("Docs");
    expect(build(row, fields)).toMatchObject({ ok: true, value: { name: "Docs" } });
    expect(build(row, { ...fields, enabled: false })).toEqual({
      ok: true,
      value: {
        id: "override-1",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        name: "Docs",
        enabled: false,
      },
    });
    expect(build(row, { ...fields, providerInstanceIds: [] })).toMatchObject({
      ok: true,
      value: { name: "Docs", providerInstanceIds: [] },
    });
    // Clearing the name is the deliberate way back to following the definition.
    const followed = build(row, { ...fields, name: "  ", enabled: false });
    expect(followed.ok && "name" in followed.value).toBe(false);
  });

  it("adds no name pin when an inherited row is saved unchanged", () => {
    const row = mcpCatalogRows({
      inherited: [definition({ name: "Docs" })],
      own: [],
      overrides: [],
    })[0]!;
    const fields = mcpOverrideFieldsFromRow(row);
    expect(fields.name).toBe("");
    const result = build(row, fields);
    expect(result.ok && "name" in result.value).toBe(false);
  });
});

describe("prepareMcpFormSecrets", () => {
  it("exchanges typed values for one-use references before the write is built", async () => {
    const typed = withNewCredentialValues(mcpFormFromDefinition(definition()));
    expect(typed.headers[0]!.credential).toEqual({
      kind: "new-secret",
      name: "X-Api-Key",
      value: "",
    });
    expect(await prepareMcpFormSecrets(typed, async () => "unused")).toEqual({
      ok: false,
      error: "Enter the secret for X-Api-Key.",
    });
    const prepared: string[] = [];
    const result = await prepareMcpFormSecrets(
      {
        ...typed,
        headers: typed.headers.map((header) => ({
          ...header,
          credential: { kind: "new-secret" as const, name: header.name, value: "s3cret" },
        })),
      },
      async (value) => {
        prepared.push(value);
        return "secret-ref-1";
      },
    );
    expect(prepared).toEqual(["s3cret"]);
    expect(result.ok && mcpDefinitionInputFromForm(result.value)).toMatchObject({
      ok: true,
      value: { transport: { headers: [{ credential: { secretRef: "secret-ref-1" } }] } },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("stops when the server refuses to prepare a secret", async () => {
    const form = {
      ...mcpFormFromDefinition(definition()),
      headers: [
        {
          rowId: "h",
          name: "X-Api-Key",
          credential: { kind: "new-secret" as const, name: "X-Api-Key", value: "v" },
        },
      ],
    };
    expect(await prepareMcpFormSecrets(form, async () => null)).toEqual({ ok: false, error: "" });
  });
});

describe("mcpApplicationSummary", () => {
  const snapshot = (overrides: Partial<McpCatalogSnapshot>): McpCatalogSnapshot => ({
    catalogSessionId: McpCatalogSessionId.make("session-1"),
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: codex,
    baseline: [],
    desired: [],
    applied: [],
    desiredRevision: 2,
    appliedRevision: 1,
    ...overrides,
  });

  it("only reports applied from a receipt for the desired revision", () => {
    expect(mcpApplicationSummary(snapshot({})).label).toBe("Waiting for delivery");
    expect(
      mcpApplicationSummary(
        snapshot({
          appliedRevision: 2,
          application: { status: "applied", revision: 2, appliedAt: "2026-10-21T00:00:00.000Z" },
        }),
      ).tone,
    ).toBe("success");
    expect(
      mcpApplicationSummary(
        snapshot({
          application: {
            status: "restart-required",
            revision: 2,
            failedAt: "2026-10-21T00:00:00.000Z",
            reason: "Provider must restart",
          },
        }),
      ),
    ).toEqual({
      label: "Restart required: Provider must restart",
      tone: "warning",
    });
  });
});

describe("mcpCatalogDestinationView", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const projectId = ProjectId.make("project-1");
  const threadId = ThreadId.make("thread-1");
  const sessionId = McpCatalogSessionId.make("session-1");
  const read = (definitions: ReadonlyArray<McpCatalogDefinition>) => ({
    definitions,
    overrides: [],
  });
  const snapshot: McpCatalogSnapshot = {
    catalogSessionId: sessionId,
    threadId,
    providerInstanceId: codex,
    baseline: [definition()],
    desired: [],
    applied: [],
    desiredRevision: 1,
    appliedRevision: 1,
  };
  const base = {
    environmentId,
    projectId,
    threadId,
    global: read([definition()]),
    project: read([]),
    snapshot: null,
    session: null,
  };

  it("waits for every read the destination needs", () => {
    expect(mcpCatalogDestinationView({ ...base, global: null })).toBeNull();
    expect(mcpCatalogDestinationView({ ...base, project: null })).toBeNull();
  });

  it("shows a thread without a session its project's rows with nowhere to write", () => {
    const view = mcpCatalogDestinationView(base);
    expect(view?.scope).toBeNull();
    expect(view?.rows.map((row) => [row.name, row.inherited])).toEqual([["Docs", true]]);
  });

  it("writes a thread with a session to that session, inheriting its baseline", () => {
    const view = mcpCatalogDestinationView({ ...base, snapshot, session: read([]) });
    expect(view?.scope).toEqual({ scope: "session", scopeId: sessionId });
    expect(view?.rows.map((row) => row.inherited)).toEqual([true]);
  });

  it("writes environment and project destinations to their own scope", () => {
    expect(mcpCatalogDestinationView({ ...base, projectId: null, threadId: null })?.scope).toEqual({
      scope: "global",
      scopeId: environmentId,
    });
    expect(mcpCatalogDestinationView({ ...base, threadId: null })?.scope).toEqual({
      scope: "project",
      scopeId: projectId,
    });
  });
});

describe("mcpSessionToggleOperation", () => {
  const newOverrideId = McpCatalogOverrideId.make("override-new");

  it("overrides an inherited server for the session, keeping its other pins", () => {
    const [row] = mcpCatalogRows({
      inherited: [definition()],
      own: [],
      overrides: [
        {
          id: McpCatalogOverrideId.make("override-1"),
          scope: "session",
          scopeId: "session-1",
          targetId: McpServerId.make("server-1"),
          name: "Pinned",
        },
      ],
    });
    const operation = mcpSessionToggleOperation({
      sessionId: "session-1",
      row: row!,
      newOverrideId,
    });
    expect(operation).toEqual({
      ok: true,
      value: {
        type: "put-override",
        override: {
          id: McpCatalogOverrideId.make("override-1"),
          scope: "session",
          scopeId: "session-1",
          targetId: McpServerId.make("server-1"),
          enabled: false,
          name: "Pinned",
        },
      },
    });
  });

  it("rewrites a server the session owns with only enablement flipped", () => {
    const [row] = mcpCatalogRows({
      inherited: [],
      own: [definition({ scope: "session", enabled: false })],
      overrides: [],
    });
    const operation = mcpSessionToggleOperation({
      sessionId: "session-1",
      row: row!,
      newOverrideId,
    });
    expect(operation.ok && operation.value.type).toBe("update");
    expect(operation.ok && operation.value.type === "update" && operation.value.definition).toEqual(
      expect.objectContaining({ name: "Docs", enabled: true, providerInstanceIds: [codex] }),
    );
  });
});
