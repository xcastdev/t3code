import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ManagedTextResourceCatalogListResult,
  McpCatalogGlobalState,
  McpCatalogProjectState,
  ProjectId,
  SkillCatalogListResult,
} from "@t3tools/contracts";

import { projectResourceInventory } from "./resourceInventory";

const environmentId = EnvironmentId.make("environment-1");

const decodeSkills = Schema.decodeUnknownSync(SkillCatalogListResult);
const decodeText = Schema.decodeUnknownSync(ManagedTextResourceCatalogListResult);
const decodeGlobalMcp = Schema.decodeUnknownSync(McpCatalogGlobalState);
const decodeProjectMcp = Schema.decodeUnknownSync(McpCatalogProjectState);

describe("projectResourceInventory", () => {
  it("projects managed summaries, diagnostics, and text state while excluding provider skills", () => {
    const skills = decodeSkills({
      catalogRevision: 2,
      entries: [
        {
          origin: "managed",
          id: "managed-1",
          key: "review",
          name: "Review",
          scope: "global",
          scopeId: "global",
          projectState: "inherit",
          revision: { revision: 1, hash: "sha256:one" },
          validity: "valid",
          effective: true,
          compatibility: [],
        },
        {
          origin: "native",
          id: "native-1",
          providerInstanceId: "codex",
          key: "native-review",
          name: "Native Review",
          scope: "provider",
          scopeId: "provider-1",
          projectState: "inherit",
          revision: { revision: 1, hash: "sha256:native" },
          validity: "valid",
          effective: true,
          compatibility: [],
        },
      ],
      diagnostics: [
        {
          scope: "project",
          scopeId: "project-1",
          name: "broken-skill",
          reasons: [{ code: "parse", message: "Invalid frontmatter" }],
        },
      ],
    });
    const textResources = decodeText({
      catalogRevision: 4,
      entries: [
        {
          kind: "command",
          key: "deploy",
          scope: "project",
          scopeId: "project-1",
          projectState: "disabled",
          revision: "r1",
          effective: false,
        },
        {
          kind: "snippet",
          key: "focus",
          scope: "project",
          scopeId: "project-1",
          projectState: "orphan",
          revision: "r2",
          effective: false,
        },
      ],
    });

    const rows = projectResourceInventory({ environmentId, skills, textResources });

    expect(rows.map(({ kind, name, status }) => [kind, name, status])).toEqual([
      ["skill", "Review", "inherit"],
      ["skill", "broken-skill", "invalid definition"],
      ["command", "deploy", "disabled"],
      ["snippet", "focus", "orphan"],
    ]);
    expect(rows[0]?.target).toMatchObject({ scope: "environment", scopeId: environmentId });
    expect(rows[1]?.diagnostic).toBe("skill");
    expect(rows[1]?.target).toMatchObject({ identity: "diagnostic", scope: "project" });
    expect(rows[2]?.target).toMatchObject({ identity: "summary", kind: "command" });
  });

  it("folds inherited project overrides and keeps removed overrides as recovery rows", () => {
    const projectMcp = decodeProjectMcp({
      globalDefinitions: [
        {
          definitionId: "definition-1",
          logicalServerId: "server-1",
          scope: "global",
          scopeId: "environment-1",
          name: "Weather",
          transport: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: [],
            authorization: { type: "none" },
          },
          enabled: true,
          providerInstanceIds: ["codex"],
          revision: 1,
        },
      ],
      projectDefinitions: [],
      projectOverrides: [
        {
          id: "override-1",
          scope: "project",
          scopeId: "project-1",
          targetId: "server-1",
          enabled: false,
        },
        {
          id: "override-orphan",
          scope: "project",
          scopeId: "project-1",
          targetId: "removed-server",
          name: "Old server",
        },
      ],
      globalRevision: 1,
      projectRevision: 1,
    });

    const rows = projectResourceInventory({
      environmentId,
      projectMcp,
      projectId: ProjectId.make("project-1"),
    });

    expect(rows.map(({ name, status }) => [name, status])).toEqual([
      ["Weather", "overridden · disabled · assigned to 1 providers"],
      ["Old server", "orphaned override"],
    ]);
    expect(rows[0]?.key).toBe("mcp:project:definition-1");
    expect(rows[0]?.target).toMatchObject({ identity: "override", id: "override-1" });
    expect(rows[1]?.target).toMatchObject({ identity: "orphan-override", id: "override-orphan" });
    expect(rows[1]?.diagnostic).toBe("orphan-mcp");
  });

  it("labels an unmodified inherited MCP entry as environment-owned while keeping its destination project-scoped", () => {
    const projectMcp = decodeProjectMcp({
      globalDefinitions: [
        {
          definitionId: "definition-inherited",
          logicalServerId: "server-inherited",
          scope: "global",
          scopeId: "environment-1",
          name: "Inherited server",
          transport: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: [],
            authorization: { type: "none" },
          },
          enabled: true,
          providerInstanceIds: [],
          revision: 1,
        },
      ],
      projectDefinitions: [],
      projectOverrides: [],
      globalRevision: 1,
      projectRevision: 1,
    });

    const [row] = projectResourceInventory({
      environmentId,
      projectMcp,
      projectId: ProjectId.make("project-1"),
    });

    expect(row).toMatchObject({
      ownerScope: "environment",
      target: { scope: "project", scopeId: "project-1" },
    });
  });

  it("keeps same-named global MCP and text entries separate with safe MCP status", () => {
    const globalMcp = decodeGlobalMcp({
      definitions: [
        {
          definitionId: "definition-1",
          logicalServerId: "server-1",
          scope: "global",
          scopeId: "environment-1",
          name: "Search",
          transport: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: [],
            authorization: { type: "none" },
          },
          enabled: true,
          providerInstanceIds: [],
          revision: 1,
        },
      ],
      globalRevision: 1,
    });
    const textResources = decodeText({
      catalogRevision: 1,
      entries: [
        {
          kind: "snippet",
          key: "search",
          name: "Search",
          scope: "environment",
          scopeId: "environment-1",
          projectState: "inherit",
          environmentState: "active",
          revision: "r1",
          effective: true,
        },
      ],
    });

    const rows = projectResourceInventory({ environmentId, globalMcp, textResources });
    const mcp = rows.find((row) => row.kind === "mcp");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(mcp?.status).toBe("enabled · no providers assigned");
    expect(mcp?.target).not.toHaveProperty("transport");
  });
});
