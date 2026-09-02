import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  McpServerId,
  ProjectMcpApplicationMode,
  ProjectMcpCatalog,
  ProjectMcpCreateInput,
  ProjectMcpListInput,
  ProjectMcpNameConflictError,
  ProjectMcpRemoveInput,
  ProjectMcpServer,
  ProjectMcpUpdateInput,
  ProjectMcpUrl,
} from "./projectMcp.ts";

const decodeProjectMcpServer = Schema.decodeUnknownSync(ProjectMcpServer);

describe("ProjectMcpServer", () => {
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
  it("decodes the catalog's separate external and managed entries", () => {
    expect(
      Schema.decodeUnknownSync(ProjectMcpCatalog)({
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
      Schema.decodeUnknownSync(Schema.Array(ProjectMcpApplicationMode))([
        "active-session",
        "next-session",
        "unsupported",
        "unavailable",
      ]),
    ).toEqual(["active-session", "next-session", "unsupported", "unavailable"]);
  });

  it("requires project scope on every mutation and list input", () => {
    expect(Schema.decodeUnknownSync(ProjectMcpListInput)({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
    expect(
      Schema.decodeUnknownSync(ProjectMcpCreateInput)({
        projectId: "project-1",
        name: "Docs",
        url: "https://example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
      }),
    ).toMatchObject({ projectId: "project-1" });
    expect(
      Schema.decodeUnknownSync(ProjectMcpUpdateInput)({
        projectId: "project-1",
        id: "mcp-1",
        name: "Docs",
        url: "https://example.com/mcp",
        enabled: true,
        providerInstanceIds: [],
      }),
    ).toMatchObject({ projectId: "project-1", id: "mcp-1" });
    expect(
      Schema.decodeUnknownSync(ProjectMcpRemoveInput)({ projectId: "project-1", id: "mcp-1" }),
    ).toEqual({ projectId: "project-1", id: "mcp-1" });
  });

  it("brands MCP server ids and keeps URL values bounded", () => {
    expect(Schema.decodeUnknownSync(McpServerId)("mcp-1")).toBe("mcp-1");
    expect(Schema.decodeUnknownSync(ProjectMcpUrl)("https://example.com/mcp")).toBe(
      "https://example.com/mcp",
    );
  });

  it("decodes an actionable case-folded name conflict error", () => {
    const error = Schema.decodeUnknownSync(ProjectMcpNameConflictError)({
      _tag: "ProjectMcpNameConflictError",
      name: "Docs",
      message: 'An MCP server named "Docs" already exists in this project.',
    });

    expect(error._tag).toBe("ProjectMcpNameConflictError");
    expect(error.name).toBe("Docs");
    expect(error.message).toContain("already exists");
  });
});
