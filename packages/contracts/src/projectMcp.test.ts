import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  McpServerId,
  ProjectMcpApplicationMode,
  ProjectMcpCatalog,
  ProjectMcpCreateInput,
  ProjectMcpEnvironmentVariableNameConflictError,
  ProjectMcpProviderNotFoundError,
  ProjectMcpListInput,
  ProjectMcpManagedServer,
  ProjectMcpNameConflictError,
  ProjectMcpOAuthAuthorizationUrl,
  ProjectMcpOAuthBeginResult,
  ProjectMcpRemoveInput,
  ProjectMcpServer,
  ProjectMcpTransport,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
  ProjectMcpUpdateInput,
  ProjectMcpUrl,
  parseProjectMcpOAuthAuthorizationUrl,
  getProjectMcpTransport,
} from "./projectMcp.ts";

const decodeProjectMcpServer = Schema.decodeUnknownSync(ProjectMcpServer);
const decodeProjectMcpTransport = Schema.decodeUnknownSync(ProjectMcpTransport);
const decodeProjectMcpProviderNotFoundError = Schema.decodeUnknownSync(
  ProjectMcpProviderNotFoundError,
);
const decodeProjectMcpServerLimitExceededError = Schema.decodeUnknownSync(
  ProjectMcpServerLimitExceededError,
);
const decodeProjectMcpServerNotFoundError = Schema.decodeUnknownSync(ProjectMcpServerNotFoundError);
const decodeProjectMcpManagedServer = Schema.decodeUnknownSync(ProjectMcpManagedServer);
const decodeProjectMcpCatalog = Schema.decodeUnknownSync(ProjectMcpCatalog);
const decodeProjectMcpApplicationModes = Schema.decodeUnknownSync(
  Schema.Array(ProjectMcpApplicationMode),
);
const decodeProjectMcpListInput = Schema.decodeUnknownSync(ProjectMcpListInput);
const decodeProjectMcpCreateInput = Schema.decodeUnknownSync(ProjectMcpCreateInput);
const decodeProjectMcpUpdateInput = Schema.decodeUnknownSync(ProjectMcpUpdateInput);
const decodeProjectMcpRemoveInput = Schema.decodeUnknownSync(ProjectMcpRemoveInput);
const decodeMcpServerId = Schema.decodeUnknownSync(McpServerId);
const decodeProjectMcpUrl = Schema.decodeUnknownSync(ProjectMcpUrl);
const decodeProjectMcpOAuthAuthorizationUrl = Schema.decodeUnknownSync(
  ProjectMcpOAuthAuthorizationUrl,
);
const decodeProjectMcpOAuthBeginResult = Schema.decodeUnknownSync(ProjectMcpOAuthBeginResult);
const decodeProjectMcpNameConflictError = Schema.decodeUnknownSync(ProjectMcpNameConflictError);
const decodeProjectMcpEnvironmentVariableNameConflictError = Schema.decodeUnknownSync(
  ProjectMcpEnvironmentVariableNameConflictError,
);
const encodeProjectMcpServer = Schema.encodeSync(ProjectMcpServer);

describe("ProjectMcpServer", () => {
  it("accepts explicit modern HTTP, legacy SSE, and stdio transports", () => {
    expect(
      decodeProjectMcpTransport({
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [],
      }),
    ).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: [],
      authorization: { type: "none" },
    });
    expect(
      decodeProjectMcpTransport({
        type: "legacy-sse",
        url: "https://example.com/sse",
        headers: [],
      }),
    ).toEqual({
      type: "legacy-sse",
      url: "https://example.com/sse",
      headers: [],
      authorization: { type: "none" },
    });
    expect(
      decodeProjectMcpTransport({
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        cwd: "/tmp",
        env: [
          {
            name: "API_TOKEN",
            credential: {
              id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
              name: "API token",
            },
          },
        ],
      }),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      cwd: "/tmp",
      env: [
        {
          name: "API_TOKEN",
          credential: {
            id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
            name: "API token",
          },
        },
      ],
    });
  });

  it("rejects unsafe stdio transport fields and unsafe remote URLs", () => {
    expect(() =>
      decodeProjectMcpTransport({ type: "stdio", command: "", args: [], env: [] }),
    ).toThrow();
    expect(() =>
      decodeProjectMcpTransport({
        type: "stdio",
        command: "node",
        args: [],
        env: [
          {
            name: "not-valid",
            credential: {
              id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
              name: "Secret",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeProjectMcpTransport({ type: "legacy-sse", url: "http://example.com/sse", headers: [] }),
    ).toThrow();
  });

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

  it("accepts HTTPS and loopback HTTP URLs with an empty provider selection", () => {
    for (const url of [
      "https://example.com/mcp",
      "http://localhost:8787/mcp",
      "http://127.0.0.1:8787/mcp",
      "http://[::1]:8787/mcp",
    ]) {
      expect(
        decodeProjectMcpServer({
          id: "mcp-1",
          name: "  Docs  ",
          url,
          enabled: true,
          providerInstanceIds: [],
        }),
      ).toMatchObject({ id: "mcp-1", name: "Docs", url, providerInstanceIds: [] });
    }
  });

  it("accepts a stdio server without a remote URL", () => {
    expect(
      decodeProjectMcpServer({
        id: "mcp-stdio",
        name: "Filesystem",
        enabled: true,
        providerInstanceIds: ["codex"],
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: [],
        },
      }),
    ).toMatchObject({
      id: "mcp-stdio",
      name: "Filesystem",
      transport: { type: "stdio", command: "npx" },
    });
  });

  it("keeps HTTP header names case-insensitive while allowing case-distinct stdio names", () => {
    expect(() =>
      decodeProjectMcpTransport({
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [
          {
            name: "X-Token",
            credential: {
              id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
              name: "Upper token",
            },
          },
          {
            name: "x-token",
            credential: {
              id: "ad949dba-339d-48d5-8a15-b230711f50e3",
              name: "Lower token",
            },
          },
        ],
      }),
    ).toThrow();

    const persisted = decodeProjectMcpTransport({
      type: "stdio",
      command: "node",
      args: [],
      env: [
        {
          name: "HTTP_PROXY",
          credential: {
            id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
            name: "Upper proxy",
          },
        },
        {
          name: "http_proxy",
          credential: {
            id: "ad949dba-339d-48d5-8a15-b230711f50e3",
            name: "Lower proxy",
          },
        },
      ],
    });
    expect(persisted.type).toBe("stdio");
    if (persisted.type === "stdio")
      expect(persisted.env.map(({ name }) => name)).toEqual(["HTTP_PROXY", "http_proxy"]);

    const created = decodeProjectMcpCreateInput({
      projectId: "project-1",
      name: "Proxy-aware command",
      enabled: true,
      providerInstanceIds: [],
      transport: {
        type: "stdio",
        command: "node",
        args: [],
        env: [
          { name: "HTTP_PROXY", credential: { name: "Upper proxy", value: "upper" } },
          { name: "http_proxy", credential: { name: "Lower proxy", value: "lower" } },
        ],
      },
    });
    const createdTransport = created.transport;
    expect(createdTransport?.type).toBe("stdio");
    if (createdTransport?.type === "stdio")
      expect(createdTransport.env.map(({ name }) => name)).toEqual(["HTTP_PROXY", "http_proxy"]);
  });

  it.each([
    "http://example.com/mcp",
    "ftp://example.com/mcp",
    "https://user:password@example.com/mcp",
    "https://example.com/mcp?token=secret",
    `https://${"a".repeat(2041)}.com/mcp`,
  ])("rejects unsafe or invalid URL %s", (url) => {
    expect(() =>
      decodeProjectMcpServer({
        id: "mcp-1",
        name: "Docs",
        url,
        enabled: true,
        providerInstanceIds: [],
      }),
    ).toThrow();
  });

  it("caps names at 120 characters", () => {
    const base = {
      id: "mcp-1",
      url: "https://example.com/mcp",
      enabled: true,
      providerInstanceIds: [],
    };
    expect(decodeProjectMcpServer({ ...base, name: "a".repeat(120) }).name).toHaveLength(120);
    expect(() => decodeProjectMcpServer({ ...base, name: "a".repeat(121) })).toThrow();
  });
});

describe("Project MCP contract shapes", () => {
  it("accepts enabled-only patches without accepting replacement fields", () => {
    const patch = { projectId: "project-1", id: "mcp-1", enabled: false, patch: "enabled" };
    expect(decodeProjectMcpUpdateInput(patch)).toEqual(patch);
    for (const replacement of [
      { name: "Replacement" },
      { url: "https://replacement.example.test/mcp" },
      { transport: { type: "stdio" } },
      { providerInstanceIds: [] },
    ]) {
      expect(() => decodeProjectMcpUpdateInput({ ...patch, ...replacement })).toThrow();
    }
    expect(() => decodeProjectMcpUpdateInput({ ...patch, patch: undefined })).toThrow();
    expect(() =>
      decodeProjectMcpUpdateInput({
        ...patch,
        name: "Replacement",
        url: "https://replacement.example.test/mcp",
        providerInstanceIds: [],
      }),
    ).toThrow();
  });

  it("returns credential references without secret values from catalog servers", () => {
    const server = decodeProjectMcpServer({
      id: "mcp-credentials",
      name: "Private docs",
      enabled: true,
      providerInstanceIds: [],
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [
          {
            name: "X-Api-Key",
            credential: {
              id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
              name: "Docs API key",
              value: "catalog-secret-must-not-escape",
            },
          },
        ],
        authorization: {
          type: "oauth",
          registration: {
            type: "pre-registered",
            clientId: "docs-client",
            clientSecret: {
              id: "ad949dba-339d-48d5-8a15-b230711f50e3",
              name: "Docs OAuth secret",
              value: "oauth-secret-must-not-escape",
            },
          },
        },
      },
    });

    expect(encodeProjectMcpServer(server)).toEqual({
      id: "mcp-credentials",
      name: "Private docs",
      enabled: true,
      providerInstanceIds: [],
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [
          {
            name: "X-Api-Key",
            credential: {
              id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
              name: "Docs API key",
            },
          },
        ],
        authorization: {
          type: "oauth",
          registration: {
            type: "pre-registered",
            clientId: "docs-client",
            clientSecret: {
              id: "ad949dba-339d-48d5-8a15-b230711f50e3",
              name: "Docs OAuth secret",
            },
          },
        },
      },
    });
  });

  it("requires values for new credentials but retains identified credentials on update", () => {
    const retained = {
      id: "f6caec74-f44d-4fe3-babb-1d5f1c3bb2bc",
      name: "Docs API key",
    };
    const base = {
      projectId: "project-1",
      name: "Docs",
      enabled: true,
      providerInstanceIds: [],
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [{ name: "X-Api-Key", credential: retained }],
      },
    };

    expect(() => decodeProjectMcpCreateInput(base)).toThrow();
    expect(decodeProjectMcpUpdateInput({ ...base, id: "mcp-1" })).toMatchObject({
      transport: { headers: [{ credential: retained }] },
    });
    expect(
      decodeProjectMcpCreateInput({
        ...base,
        transport: {
          ...base.transport,
          headers: [
            {
              name: "X-Api-Key",
              credential: { name: "Docs API key", value: "write-only-secret" },
            },
          ],
        },
      }),
    ).toMatchObject({
      transport: {
        headers: [{ credential: { name: "Docs API key", value: "write-only-secret" } }],
      },
    });
  });

  it("requires UUID credential ids and rejects case-insensitive duplicate credential slots", () => {
    const base = {
      projectId: "project-1",
      name: "Docs",
      enabled: true,
      providerInstanceIds: [],
    };

    expect(() =>
      decodeProjectMcpUpdateInput({
        ...base,
        id: "mcp-1",
        transport: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [
            {
              name: "X-Api-Key",
              credential: { id: "../credentials/key", name: "Docs API key" },
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProjectMcpCreateInput({
        ...base,
        transport: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [
            { name: "X-Api-Key", credential: { name: "One", value: "one" } },
            { name: "x-api-key", credential: { name: "Two", value: "two" } },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProjectMcpCreateInput({
        ...base,
        transport: {
          type: "stdio",
          command: "node",
          args: [],
          env: [
            { name: "API_TOKEN", credential: { name: "One", value: "one" } },
            { name: "API_TOKEN", credential: { name: "Two", value: "two" } },
          ],
        },
      }),
    ).toThrow();
  });

  it("keeps URL-only records readable as unauthenticated Streamable HTTP", () => {
    const server = decodeProjectMcpServer({
      id: "mcp-legacy",
      name: "Legacy docs",
      url: "https://example.com/mcp",
      enabled: true,
      providerInstanceIds: [],
    });

    expect(getProjectMcpTransport(server)).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: [],
      authorization: { type: "none" },
    });
  });

  it("models automatic and pre-registered OAuth without exposing client-secret values", () => {
    const base = {
      projectId: "project-1",
      name: "OAuth docs",
      enabled: true,
      providerInstanceIds: [],
    };
    const automatic = decodeProjectMcpCreateInput({
      ...base,
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [],
        authorization: { type: "oauth", registration: { type: "automatic" } },
      },
    });
    const preRegistered = decodeProjectMcpCreateInput({
      ...base,
      transport: {
        type: "legacy-sse",
        url: "https://example.com/sse",
        headers: [],
        authorization: {
          type: "oauth",
          registration: {
            type: "pre-registered",
            clientId: "client-id",
            clientSecret: { name: "OAuth client secret", value: "write-only-secret" },
          },
        },
      },
    });

    expect(automatic.transport).toMatchObject({ authorization: { type: "oauth" } });
    expect(preRegistered.transport).toMatchObject({
      authorization: {
        registration: { clientSecret: { name: "OAuth client secret", value: "write-only-secret" } },
      },
    });
    expect(() =>
      decodeProjectMcpCreateInput({
        ...base,
        transport: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [{ name: "Authorization", credential: { name: "Token", value: "secret" } }],
          authorization: { type: "oauth", registration: { type: "automatic" } },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProjectMcpCreateInput({
        ...base,
        transport: {
          type: "stdio",
          command: "node",
          args: [],
          env: [],
          authorization: { type: "oauth", registration: { type: "automatic" } },
        },
      }),
    ).toThrow();
  });

  it("keeps application reasons optional and bounded", () => {
    const catalog = decodeProjectMcpCatalog({
      external: [],
      managed: [],
      applications: [
        {
          serverId: "mcp-1",
          providerInstanceId: "external-opencode",
          mode: "unsupported",
          reason: "T3 cannot configure externally managed OpenCode servers.",
        },
      ],
    });

    expect(catalog.applications[0]?.reason).toContain("externally managed OpenCode");
    expect(() =>
      decodeProjectMcpCatalog({
        external: [],
        managed: [],
        applications: [
          {
            serverId: "mcp-1",
            providerInstanceId: "external-opencode",
            mode: "unsupported",
            reason: "x".repeat(1_001),
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a server-owned managed endpoint bound to a non-loopback host", () => {
    expect(
      decodeProjectMcpManagedServer({
        id: "t3-code",
        name: "t3-code",
        url: "http://100.64.0.40:43123/mcp",
        providerInstanceIds: ["codex"],
      }),
    ).toEqual({
      id: "t3-code",
      name: "t3-code",
      url: "http://100.64.0.40:43123/mcp",
      providerInstanceIds: ["codex"],
    });
  });

  it("decodes the catalog's separate external and managed entries", () => {
    expect(
      decodeProjectMcpCatalog({
        external: [
          {
            id: "mcp-1",
            name: "Docs",
            url: "https://example.com/mcp",
            enabled: true,
            providerInstanceIds: [],
          },
        ],
        managed: [],
        applications: [{ serverId: "mcp-1", providerInstanceId: "codex", mode: "next-session" }],
      }),
    ).toEqual({
      external: [
        {
          id: "mcp-1",
          name: "Docs",
          url: "https://example.com/mcp",
          enabled: true,
          providerInstanceIds: [],
        },
      ],
      managed: [],
      applications: [{ serverId: "mcp-1", providerInstanceId: "codex", mode: "next-session" }],
    });
  });

  it("exposes the exact application modes", () => {
    expect(
      decodeProjectMcpApplicationModes([
        "active-session",
        "next-session",
        "unsupported",
        "unavailable",
      ]),
    ).toEqual(["active-session", "next-session", "unsupported", "unavailable"]);
  });

  it("requires project scope on every mutation and list input", () => {
    expect(decodeProjectMcpListInput({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
    expect(
      decodeProjectMcpCreateInput({
        projectId: "project-1",
        name: "Docs",
        url: "https://example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
      }),
    ).toMatchObject({ projectId: "project-1" });
    expect(
      decodeProjectMcpUpdateInput({
        projectId: "project-1",
        id: "mcp-1",
        name: "Docs",
        url: "https://example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
      }),
    ).toMatchObject({ projectId: "project-1", id: "mcp-1" });
    expect(decodeProjectMcpRemoveInput({ projectId: "project-1", id: "mcp-1" })).toEqual({
      projectId: "project-1",
      id: "mcp-1",
    });
  });

  it("brands MCP server ids and keeps URL values bounded", () => {
    expect(decodeMcpServerId("mcp-1")).toBe("mcp-1");
    expect(decodeProjectMcpUrl("https://example.com/mcp")).toBe("https://example.com/mcp");
  });

  it("accepts only safe HTTP(S) OAuth authorization URLs", () => {
    for (const value of [
      "https://issuer.example.test/authorize?state=opaque",
      "http://127.0.0.1:8787/authorize?state=opaque",
    ]) {
      expect(parseProjectMcpOAuthAuthorizationUrl(value)).toBe(new URL(value).toString());
      expect(decodeProjectMcpOAuthAuthorizationUrl(value)).toBe(new URL(value).toString());
      expect(
        decodeProjectMcpOAuthBeginResult({
          authorizationUrl: value,
          expiresAt: "2026-09-08T00:00:00.000Z",
        }),
      ).toMatchObject({ authorizationUrl: new URL(value).toString() });
    }

    for (const value of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///tmp/authorize",
      "mailto:oauth@example.test",
      "https://user:pass@issuer.example.test/authorize",
      "not a url",
    ]) {
      expect(parseProjectMcpOAuthAuthorizationUrl(value)).toBeUndefined();
      expect(() =>
        decodeProjectMcpOAuthBeginResult({
          authorizationUrl: value,
          expiresAt: "2026-09-08T00:00:00.000Z",
        }),
      ).toThrow();
    }

    const authorizationUrlAtLimit = `https://issuer.example.test/authorize?padding=${"x".repeat(
      4_096 - "https://issuer.example.test/authorize?padding=".length,
    )}`;
    const authorizationUrlOverLimit = `${authorizationUrlAtLimit}x`;
    const rawUrlThatCanonicalizesOverLimit = `https://issuer.example.test/authorize?padding=${" ".repeat(1_366)}x`;
    expect(authorizationUrlAtLimit.length).toBe(4_096);
    expect(authorizationUrlOverLimit.length).toBe(4_097);
    expect(rawUrlThatCanonicalizesOverLimit.length).toBeLessThanOrEqual(4_096);
    expect(new URL(rawUrlThatCanonicalizesOverLimit).toString().length).toBeGreaterThan(4_096);

    expect(parseProjectMcpOAuthAuthorizationUrl(authorizationUrlAtLimit)).toBe(
      authorizationUrlAtLimit,
    );
    expect(decodeProjectMcpOAuthAuthorizationUrl(authorizationUrlAtLimit)).toBe(
      authorizationUrlAtLimit,
    );
    expect(parseProjectMcpOAuthAuthorizationUrl(authorizationUrlOverLimit)).toBeUndefined();
    expect(() => decodeProjectMcpOAuthAuthorizationUrl(authorizationUrlOverLimit)).toThrow();
    expect(parseProjectMcpOAuthAuthorizationUrl(rawUrlThatCanonicalizesOverLimit)).toBeUndefined();
    expect(() => decodeProjectMcpOAuthAuthorizationUrl(rawUrlThatCanonicalizesOverLimit)).toThrow();
    expect(
      decodeProjectMcpOAuthBeginResult({
        authorizationUrl: authorizationUrlAtLimit,
        expiresAt: "2026-09-08T00:00:00.000Z",
      }),
    ).toMatchObject({ authorizationUrl: authorizationUrlAtLimit });
    expect(() =>
      decodeProjectMcpOAuthBeginResult({
        authorizationUrl: authorizationUrlOverLimit,
        expiresAt: "2026-09-08T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes an actionable case-folded name conflict error", () => {
    const error = decodeProjectMcpNameConflictError({
      _tag: "ProjectMcpNameConflictError",
      name: "Docs",
      message: 'An MCP server named "Docs" already exists in this project.',
    });

    expect(error._tag).toBe("ProjectMcpNameConflictError");
    expect(error.name).toBe("Docs");
    expect(error.message).toContain("already exists");
  });

  it("decodes actionable mutation errors", () => {
    const unknownProvider = decodeProjectMcpProviderNotFoundError({
      _tag: "ProjectMcpProviderNotFoundError",
      providerInstanceId: "missing-provider",
    });
    const limit = decodeProjectMcpServerLimitExceededError({
      _tag: "ProjectMcpServerLimitExceededError",
      limit: 50,
    });
    const missingServer = decodeProjectMcpServerNotFoundError({
      _tag: "ProjectMcpServerNotFoundError",
      id: "missing-server",
    });
    const environmentConflict = decodeProjectMcpEnvironmentVariableNameConflictError({
      _tag: "ProjectMcpEnvironmentVariableNameConflictError",
      name: "HTTP_PROXY",
      message: "Stdio environment variable 'HTTP_PROXY' conflicts with another name on Windows.",
    });

    expect(unknownProvider.message).toContain("missing-provider");
    expect(limit.message).toContain("50");
    expect(missingServer.message).toContain("missing-server");
    expect(environmentConflict.message).toContain("conflicts with another name on Windows");
  });
});
