import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { mcpCatalogScopeKey } from "./mcpCatalog.ts";

describe("MCP catalog client state", () => {
  it("keeps mutation lanes independent by environment and scope", () => {
    const environmentId = EnvironmentId.make("environment-1");
    expect(mcpCatalogScopeKey({ environmentId, scope: "global", scopeId: environmentId })).toBe(
      "environment-1:global:environment-1",
    );
    expect(mcpCatalogScopeKey({ environmentId, scope: "project", scopeId: "project-1" })).not.toBe(
      mcpCatalogScopeKey({ environmentId, scope: "session", scopeId: "project-1" }),
    );
    expect(
      mcpCatalogScopeKey({
        environmentId: EnvironmentId.make("environment-2"),
        scope: "global",
        scopeId: environmentId,
      }),
    ).not.toBe("environment-1:global:environment-1");
  });
});
