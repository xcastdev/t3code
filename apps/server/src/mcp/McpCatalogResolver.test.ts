import { McpDefinitionId, McpServerId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  McpCatalogNameConflictError,
  McpCatalogProviderLimitExceededError,
  type McpCatalogDefinition,
  type McpCatalogOverride,
} from "@t3tools/contracts";
import {
  resolveProjectCatalog,
  resolveSessionCatalog,
  validateEffectiveCatalog,
  type ResolveProjectCatalogInput,
  type ResolveSessionCatalogInput,
} from "./McpCatalogResolver.ts";

const provider = ProviderInstanceId.make("codex");
const otherProvider = ProviderInstanceId.make("claude");
const server = (id: string, name: string, scope: McpCatalogDefinition["scope"] = "global") =>
  ({
    definitionId: McpDefinitionId.make(`definition-${id}`),
    logicalServerId: McpServerId.make(id),
    scope,
    scopeId: scope === "global" ? "environment-1" : scope === "project" ? "project-1" : "session-1",
    name,
    transport: {
      type: "streamable-http" as const,
      url: `https://${id}.example.test/mcp`,
      headers: [],
      authorization: { type: "none" as const },
    },
    enabled: true,
    providerInstanceIds: [provider],
    revision: 1,
  }) satisfies McpCatalogDefinition;

const override = (targetId: string, patch: Partial<McpCatalogOverride>): McpCatalogOverride =>
  ({
    id: `override-${targetId}`,
    scope: "project",
    scopeId: "project-1",
    targetId: McpServerId.make(targetId),
    ...patch,
  }) as McpCatalogOverride;

const projectInput = (overrides: Partial<ResolveProjectCatalogInput> = {}) =>
  ({
    globalDefinitions: [server("weather", "Weather")],
    projectDefinitions: [],
    projectOverrides: [],
    providerInstanceId: provider,
    providerCapability: "restart-required",
    ...overrides,
  }) satisfies ResolveProjectCatalogInput;

describe("McpCatalogResolver", () => {
  it("applies global, project override, and project-local precedence", () => {
    const weather = server("weather", "Project Weather");
    const local = server("local", "Local", "project");
    const entries = resolveProjectCatalog(
      projectInput({
        projectDefinitions: [local],
        projectOverrides: [override("weather", { name: weather.name, enabled: true })],
      }),
    );
    expect(entries.map((entry) => entry.name)).toEqual(["Project Weather", "Local"]);
    expect(entries[0]?.logicalServerId).toBe(McpServerId.make("weather"));
  });

  it("allows a lower scope to re-enable an inherited definition", () => {
    const disabled = { ...server("weather", "Weather"), enabled: false };
    const project = resolveProjectCatalog(
      projectInput({
        globalDefinitions: [disabled],
        projectOverrides: [override("weather", { enabled: true })],
      }),
    );
    expect(project).toHaveLength(1);

    const session = resolveSessionCatalog({
      baseline: [{ ...disabled, scope: "project", scopeId: "project-1" }],
      sessionDefinitions: [],
      sessionOverrides: [
        {
          ...override("weather", { enabled: true }),
          scope: "session",
          scopeId: "session-1",
        },
      ],
      providerInstanceId: provider,
      providerCapability: "restart-required",
    });
    expect(session).toHaveLength(1);
  });

  it("keeps duplicate names when provider assignments are disjoint", () => {
    expect(
      resolveProjectCatalog(
        projectInput({
          globalDefinitions: [{ ...server("a", "Same"), providerInstanceIds: [provider] }],
          projectDefinitions: [
            { ...server("b", "Same", "project"), providerInstanceIds: [otherProvider] },
          ],
        }),
      ),
    ).toHaveLength(1);
  });

  it("reports same-provider name conflicts with the complete entries", () => {
    expect(() =>
      resolveProjectCatalog(
        projectInput({
          projectDefinitions: [server("other", "Weather", "project")],
        }),
      ),
    ).toThrow(McpCatalogNameConflictError);
    try {
      resolveProjectCatalog(
        projectInput({ projectDefinitions: [server("other", "Weather", "project")] }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(McpCatalogNameConflictError);
      expect((error as McpCatalogNameConflictError).conflicts).toHaveLength(2);
    }
  });

  it("keeps a transport replacement's definition identity", () => {
    const replaced = {
      ...server("weather", "Weather"),
      transport: {
        type: "streamable-http" as const,
        url: "https://replacement.example.test/mcp",
        headers: [],
        authorization: { type: "none" as const },
      },
    };
    const result = resolveProjectCatalog(
      projectInput({
        projectOverrides: [
          override("weather", {
            transport: replaced.transport,
            transportDefinitionId: McpDefinitionId.make("definition-replacement"),
          }),
        ],
      }),
    );
    expect(result[0]?.transportDefinitionId).toBe("definition-replacement");
    expect(result[0]?.logicalServerId).toBe("weather");
  });

  it("filters unsupported providers and enforces the provider entry limit", () => {
    expect(resolveProjectCatalog(projectInput({ providerCapability: "unsupported" }))).toEqual([]);
    const many = Array.from({ length: 51 }, (_, index) =>
      server(`server-${index}`, `Server ${index}`, "project"),
    );
    expect(() =>
      resolveProjectCatalog(projectInput({ globalDefinitions: [], projectDefinitions: many })),
    ).toThrow(McpCatalogProviderLimitExceededError);
  });

  it("validates effective names and limits across the selected providers", () => {
    expect(() =>
      validateEffectiveCatalog({
        definitions: [server("one", "Same"), server("two", "same")],
        providerInstanceIds: [provider],
      }),
    ).toThrow(McpCatalogNameConflictError);

    expect(() =>
      validateEffectiveCatalog({
        definitions: Array.from({ length: 51 }, (_, index) =>
          server(`limit-${index}`, `Server ${index}`),
        ),
        providerInstanceIds: [provider],
      }),
    ).toThrow(McpCatalogProviderLimitExceededError);

    expect(() =>
      validateEffectiveCatalog({
        definitions: [
          { ...server("codex", "Same"), providerInstanceIds: [provider] },
          { ...server("claude", "Same"), providerInstanceIds: [otherProvider] },
        ],
        providerInstanceIds: [provider, otherProvider],
      }),
    ).not.toThrow();
  });

  it("resolves the session's desired catalog directly, including inherited edits and removals", () => {
    const inherited = server("inherited", "Inherited");
    const updated = {
      ...inherited,
      name: "Updated inherited",
      transport: {
        ...inherited.transport,
        url: "https://updated.example.test/mcp",
      },
    };
    const local = server("local", "Local", "session");

    expect(
      resolveSessionCatalog({
        desired: [updated, local],
        providerInstanceId: provider,
        providerCapability: "restart-required",
      }),
    ).toEqual([
      expect.objectContaining({
        logicalServerId: inherited.logicalServerId,
        name: "Updated inherited",
        transport: updated.transport,
      }),
      expect.objectContaining({ logicalServerId: local.logicalServerId }),
    ]);

    expect(
      resolveSessionCatalog({
        desired: [local],
        providerInstanceId: provider,
        providerCapability: "restart-required",
      }),
    ).toEqual([expect.objectContaining({ logicalServerId: local.logicalServerId })]);
  });
});
