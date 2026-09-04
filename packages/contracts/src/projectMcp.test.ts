import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  McpServerId,
  ProjectMcpApplicationMode,
  ProjectMcpCatalog,
  ProjectMcpCreateInput,
  ProjectMcpProviderNotFoundError,
  ProjectMcpListInput,
  ProjectMcpManagedServer,
  ProjectMcpNameConflictError,
  ProjectMcpRemoveInput,
  ProjectMcpServer,
  ProjectMcpTransport,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
  ProjectMcpUpdateInput,
  ProjectMcpUrl,
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
const decodeProjectMcpNameConflictError = Schema.decodeUnknownSync(ProjectMcpNameConflictError);

describe("ProjectMcpServer", () => {
  it("accepts explicit modern HTTP, legacy SSE, and stdio transports", () => {
    expect(
      decodeProjectMcpTransport({
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: [],
      }),
    ).toEqual({ type: "streamable-http", url: "https://example.com/mcp", headers: [] });
    expect(
      decodeProjectMcpTransport({
        type: "legacy-sse",
        url: "https://example.com/sse",
        headers: [],
      }),
    ).toEqual({ type: "legacy-sse", url: "https://example.com/sse", headers: [] });
    expect(
      decodeProjectMcpTransport({
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        cwd: "/tmp",
        env: [{ name: "API_TOKEN", secretRef: "project-mcp-secret-1" }],
      }),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      cwd: "/tmp",
      env: [{ name: "API_TOKEN", secretRef: "project-mcp-secret-1" }],
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
        env: [{ name: "not-valid", secretRef: "secret" }],
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

    expect(unknownProvider.message).toContain("missing-provider");
    expect(limit.message).toContain("50");
    expect(missingServer.message).toContain("missing-server");
  });
});
