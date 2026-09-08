import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  McpCatalogDefinition,
  McpCatalogOverride,
  McpCatalogSnapshot,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
} from "./mcpCatalog.ts";

const decodeDefinition = Schema.decodeUnknownSync(McpCatalogDefinition);
const decodeOverride = Schema.decodeUnknownSync(McpCatalogOverride);

const transport = {
  type: "streamable-http" as const,
  url: "https://example.test/mcp",
  headers: [],
  authorization: { type: "none" as const },
};

const base = {
  definitionId: "definition-1",
  logicalServerId: "server-1",
  scope: "global" as const,
  scopeId: "environment-1",
  name: "Weather",
  transport,
  enabled: true,
  providerInstanceIds: ["codex"],
  revision: 1,
};

describe("MCP catalog contracts", () => {
  it("decodes a complete definition and metadata-only override", () => {
    expect(decodeDefinition(base)).toMatchObject(base);
    expect(
      decodeOverride({
        id: "override-1",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        enabled: false,
      }),
    ).toMatchObject({ targetId: "server-1", enabled: false });
  });

  it("requires a new definition id when an override replaces transport", () => {
    expect(() =>
      decodeOverride({
        id: "override-1",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        transport,
      }),
    ).toThrow();
    expect(
      decodeOverride({
        id: "override-1",
        scope: "project",
        scopeId: "project-1",
        targetId: "server-1",
        transport,
        transportDefinitionId: "definition-2",
      }),
    ).toMatchObject({ transportDefinitionId: "definition-2" });
  });

  it("decodes a session snapshot with retained transport ownership", () => {
    const snapshot = Schema.decodeUnknownSync(McpCatalogSnapshot)({
      catalogSessionId: "catalog-session-1",
      threadId: "thread-1",
      providerInstanceId: "codex",
      baseline: [base],
      desired: [base],
      desiredRevision: 1,
      appliedRevision: 1,
      application: { status: "applied", revision: 1, appliedAt: "2026-09-08T00:00:00.000Z" },
    });
    expect(snapshot.baseline[0]?.transport).toEqual(transport);
    expect(snapshot.baseline[0]?.definitionId).toBe("definition-1");
  });

  it("decodes stale revision and stale logical session errors", () => {
    expect(
      Schema.decodeUnknownSync(McpCatalogStaleRevisionError)({
        _tag: "McpCatalogStaleRevisionError",
        scope: "project",
        scopeId: "project-1",
        expectedRevision: 2,
        actualRevision: 3,
      }),
    ).toMatchObject({ actualRevision: 3 });
    expect(
      Schema.decodeUnknownSync(McpCatalogStaleSessionError)({
        _tag: "McpCatalogStaleSessionError",
        threadId: "thread-1",
        requestedSessionId: "old-session",
        activeSessionId: "new-session",
      }),
    ).toMatchObject({ activeSessionId: "new-session" });
  });
});
