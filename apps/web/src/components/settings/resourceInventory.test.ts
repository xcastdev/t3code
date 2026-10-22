import {
  EnvironmentId,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  McpCatalogOverrideId,
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProjectId,
  ProjectMcpCredentialId,
  ProviderInstanceId,
  SkillContentHash,
  SkillNativeObservationId,
  ThreadId,
  type McpCatalogDefinition,
  type McpCatalogSnapshot,
  type ManagedTextResourceSummary,
  type SkillCatalogSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resourceEditorConflict } from "@t3tools/client-runtime/resource-actions";

import {
  effectiveMcpDefinitions,
  filterInventoryRows,
  mcpApplicationSummary,
  mcpCatalogRows,
  mcpDefinitionInputFromForm,
  mcpFormFromDefinition,
  mcpOverrideFieldsFromRow,
  mcpOverrideInput,
  mcpOverridePatchFromFields,
  prepareMcpFormSecrets,
  resolveResourceCheckout,
  skillActions,
  skillKeyCollisions,
  skillReloadBaseline,
  textResourceActions,
  withNewCredentialValues,
  type McpCatalogRow,
  type McpOverrideFields,
} from "./resourceInventory";

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
        definition({ definitionId: McpDefinitionId.make("own"), scope: "project", name: "Local" }),
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
    expect(fields).toEqual({ name: "", enabled: null, providerInstanceIds: null });
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

describe("resourceEditorConflict", () => {
  it("keeps an editor on its own baseline and names what moved", () => {
    const editing = { catalogRevision: 4, entryRevision: "r1" };
    expect(resourceEditorConflict(editing, { catalogRevision: 4, entryRevision: "r1" })).toBe(null);
    expect(resourceEditorConflict(editing, { catalogRevision: 5, entryRevision: "r1" })).toBe(
      "changed",
    );
    expect(resourceEditorConflict(editing, { catalogRevision: 4, entryRevision: "r2" })).toBe(
      "changed",
    );
    expect(resourceEditorConflict(editing, { catalogRevision: 5, entryRevision: undefined })).toBe(
      "removed",
    );
    // A content-hash edit ignores unrelated catalog changes.
    expect(
      resourceEditorConflict(
        { catalogRevision: null, entryRevision: "h1" },
        { catalogRevision: 9, entryRevision: "h1" },
      ),
    ).toBe(null);
  });
});

describe("resolveResourceCheckout", () => {
  it("writes only to a single checkout and asks when a project has several", () => {
    const a = { id: ProjectId.make("a") };
    const b = { id: ProjectId.make("b") };
    expect(resolveResourceCheckout([a])).toEqual({ kind: "single", projectId: "a" });
    expect(resolveResourceCheckout([a, b])).toEqual({ kind: "ambiguous", members: [a, b] });
    expect(resolveResourceCheckout([])).toEqual({ kind: "none" });
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
    expect(mcpApplicationSummary(snapshot({})).label).toBe(
      "Waiting for delivery (desired r2, applied r1)",
    );
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
      label: "Restart required (desired r2, applied r1): Provider must restart",
      tone: "warning",
    });
  });
});

const managedSkill = (
  overrides: Partial<Extract<SkillCatalogSummary, { origin: "managed" }>> = {},
) =>
  ({
    origin: "managed",
    id: ManagedSkillId.make("skill-1"),
    key: ManagedSkillKey.make("review"),
    name: "Review",
    scope: "global",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: { revision: 1, hash: SkillContentHash.make("hash-1") },
    validity: "valid",
    effective: true,
    compatibility: [],
    ...overrides,
  }) satisfies SkillCatalogSummary;

const nativeSkill: SkillCatalogSummary = {
  origin: "native",
  id: SkillNativeObservationId.make("observation-1"),
  providerInstanceId: codex,
  key: "review",
  name: "Review",
  scope: "provider",
  scopeId: "codex",
  projectState: "inherit",
  revision: { revision: 0, hash: SkillContentHash.make("native-hash") },
  validity: "valid",
  effective: true,
  compatibility: [],
};

describe("skillReloadBaseline", () => {
  const revisionB = { revision: 2, hash: SkillContentHash.make("hash-2") };
  const detailB = {
    metadata: {
      id: ManagedSkillId.make("skill-1"),
      key: ManagedSkillKey.make("review"),
      name: "Review",
      scope: "global",
      scopeId: "environment-1",
      origin: "created",
      ownership: "t3",
      revision: revisionB,
    },
    content: { key: ManagedSkillKey.make("review"), name: "Review", body: "B\n" },
  } as const;
  const source = managedSkill();

  it("adopts fresh content with the catalog revision that names it, in one reload", () => {
    const catalog = {
      entries: [managedSkill({ revision: revisionB })],
      catalogRevision: 7 as never,
    };
    expect(skillReloadBaseline(source, detailB, catalog)).toBe(7);
  });

  it("adopts nothing when the catalog moved again, dropped the skill, or names another one", () => {
    const revisionC = { revision: 3, hash: SkillContentHash.make("hash-3") };
    for (const entries of [
      [managedSkill({ revision: revisionC })],
      [],
      [managedSkill({ revision: revisionB, scope: "project" })],
    ])
      expect(skillReloadBaseline(source, detailB, { entries, catalogRevision: 8 as never })).toBe(
        null,
      );
    const other = { ...detailB, metadata: { ...detailB.metadata, id: ManagedSkillId.make("x") } };
    expect(
      skillReloadBaseline(source, other, {
        entries: [managedSkill({ revision: revisionB })],
        catalogRevision: 8 as never,
      }),
    ).toBe(null);
  });
});

describe("skill actions", () => {
  const environment = { projectId: null, threadId: null };
  const project = { projectId: "project-1", threadId: null };
  const thread = { projectId: "project-1", threadId: "thread-1" };

  it("edits shared packages only at their own scope and overlays sessions per thread", () => {
    expect(skillActions(managedSkill(), environment)).toContain("edit");
    expect(skillActions(managedSkill(), project)).toEqual([
      "override",
      "disable-project",
      "install",
    ]);
    expect(
      skillActions(managedSkill({ scope: "project", projectState: "override" }), project),
    ).toContain("edit-override");
    expect(skillActions(managedSkill(), thread)).toEqual(["session-disable", "session-reset"]);
    expect(skillActions(managedSkill({ effective: false }), thread)).toEqual([
      "session-enable",
      "session-reset",
    ]);
  });

  it("offers a thread's key-only session toggle only on the package that wins the key", () => {
    const global = managedSkill({ effective: false, projectState: "override" });
    const winner = managedSkill({
      id: ManagedSkillId.make("skill-2"),
      scope: "project",
      scopeId: "project-1",
      projectState: "override",
    });
    const entries = [global, winner];
    expect(skillActions(global, thread, entries)).toEqual([]);
    expect(skillActions(winner, thread, entries)).toEqual(["session-disable", "session-reset"]);
    // Turned off for the thread, the project package still owns the key, not the shadowed one.
    const off = { ...winner, effective: false };
    expect(skillActions(global, thread, [global, off])).toEqual([]);
    expect(skillActions(off, thread, [global, off])).toEqual(["session-enable", "session-reset"]);
    const shadowed = managedSkill({
      conflict: { kind: "shadowed", keys: [ManagedSkillKey.make("review")], message: "Shadowed" },
    });
    expect(skillActions(shadowed, thread, [shadowed])).toEqual([]);
  });

  it("imports provider skills only environment-wide and never edits them in place", () => {
    expect(skillActions(nativeSkill, environment)).toEqual(["view-native", "import-native"]);
    expect(skillActions(nativeSkill, project)).toEqual(["view-native"]);
  });

  it("flags a key offered by both a managed and a provider source", () => {
    expect([...skillKeyCollisions([managedSkill(), nativeSkill])]).toEqual(["review"]);
    expect([...skillKeyCollisions([managedSkill()])]).toEqual([]);
  });
});

describe("text resource actions", () => {
  const command: ManagedTextResourceSummary = {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: EnvironmentId.make("environment-1"),
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: true,
  };

  it("follows the destination: environment edit, project override, thread overlay", () => {
    expect(textResourceActions(command, { projectId: null, threadId: null }, false)).toEqual([
      "edit",
      "disable",
      "delete",
    ]);
    expect(
      textResourceActions(command, { projectId: ProjectId.make("p"), threadId: null }, false),
    ).toEqual(["override", "disable-project"]);
    expect(
      textResourceActions(
        command,
        { projectId: ProjectId.make("p"), threadId: ThreadId.make("t") },
        true,
      ),
    ).toEqual(["thread-disable", "thread-reset"]);
    expect(
      textResourceActions(
        { ...command, projectState: "orphan" },
        { projectId: "p", threadId: null },
        false,
      ),
    ).toEqual(["reset-project"]);
  });
});

describe("filterInventoryRows", () => {
  it("filters by kind and by key or name", () => {
    const rows = [
      {
        id: "1",
        kind: "skill",
        source: "managed",
        key: "review",
        name: "Review",
        scope: "global",
        scopeId: "e",
        enabled: true,
        revision: 1,
      },
      {
        id: "2",
        kind: "mcp",
        source: "managed",
        key: "docs",
        name: "Docs",
        scope: "project",
        scopeId: "p",
        enabled: true,
        revision: 1,
      },
    ] as const;
    expect(filterInventoryRows(rows, "doc", "all").map((row) => row.id)).toEqual(["2"]);
    expect(filterInventoryRows(rows, "", "skill").map((row) => row.id)).toEqual(["1"]);
  });
});
