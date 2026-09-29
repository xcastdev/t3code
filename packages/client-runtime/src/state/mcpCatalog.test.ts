import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import { makeMcpCatalogInvalidationSignals, mcpCatalogScopeKey } from "./mcpCatalog.ts";

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

  it("refreshes project catalogs when their environment catalog changes", () => {
    const registry = AtomRegistry.make();
    const signals = makeMcpCatalogInvalidationSignals();
    const environmentId = EnvironmentId.make("environment-1");
    const anotherEnvironmentId = EnvironmentId.make("environment-2");
    const project = signals.project({ environmentId, input: { scopeId: "project-1" } });
    const otherProject = signals.project({ environmentId, input: { scopeId: "project-2" } });
    const otherEnvironment = signals.project({
      environmentId: anotherEnvironmentId,
      input: { scopeId: "project-1" },
    });
    registry.mount(project);
    registry.mount(otherProject);
    registry.mount(otherEnvironment);
    try {
      const before = [project, otherProject, otherEnvironment].map((atom) => registry.get(atom));
      signals.publish(environmentId, { scope: "global", scopeId: environmentId }, registry);
      expect(registry.get(project)).not.toBe(before[0]);
      expect(registry.get(otherProject)).not.toBe(before[1]);
      expect(registry.get(otherEnvironment)).toBe(before[2]);

      const afterGlobal = [project, otherProject].map((atom) => registry.get(atom));
      signals.publish(environmentId, { scope: "project", scopeId: "project-1" }, registry);
      expect(registry.get(project)).not.toBe(afterGlobal[0]);
      expect(registry.get(otherProject)).toBe(afterGlobal[1]);
    } finally {
      registry.dispose();
    }
  });
});
