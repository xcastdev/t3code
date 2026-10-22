import {
  EnvironmentId,
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  ProjectId,
  SkillCatalogRevision,
  ManagedSkillId,
  ManagedSkillKey,
  SkillContentHash,
  McpCatalogDefinition,
  McpDefinitionId,
  McpServerId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  composeManagedResourceInventory,
  isCurrentManagedResourceDraft,
} from "./managedResources.ts";

describe("managed resource destinations", () => {
  it("requires the same environment, project, thread and revision to save a draft", () => {
    const current = {
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("thread"),
      revision: 4,
    };
    expect(isCurrentManagedResourceDraft(current, { ...current })).toBe(true);
    for (const draft of [
      { ...current, environmentId: EnvironmentId.make("remote") },
      { ...current, projectId: ProjectId.make("other") },
      { ...current, threadId: ThreadId.make("other") },
      { ...current, revision: 5 },
    ])
      expect(isCurrentManagedResourceDraft(current, draft)).toBe(false);
  });
  it("bounds inventory and strips content from independent catalog projections", () => {
    const text = {
      catalogRevision: ManagedTextResourceCatalogRevision.make(1),
      entries: [
        {
          kind: "snippet" as const,
          id: ManagedTextResourceId.make("example"),
          key: ManagedTextResourceKey.make("example"),
          scope: "environment" as const,
          scopeId: "local",
          projectState: "inherit" as const,
          revision: ManagedTextResourceRevision.make("hash"),
          effective: true,
          body: "never copy this content",
        },
      ],
    };
    const input = {
      skills: {
        catalogRevision: SkillCatalogRevision.make(0),
        entries: [
          {
            origin: "managed" as const,
            id: ManagedSkillId.make("skill"),
            key: ManagedSkillKey.make("example"),
            name: "Example skill",
            scope: "global" as const,
            scopeId: "local",
            projectState: "inherit" as const,
            revision: { revision: 3, hash: SkillContentHash.make("skill-hash") },
            validity: "valid" as const,
            effective: true,
            compatibility: [],
            application: {
              status: "pending_restart" as const,
              desiredRevision: SkillCatalogRevision.make(3),
              appliedRevision: SkillCatalogRevision.make(2),
            },
          },
        ],
      },
      text,
      mcp: {
        revision: 1,
        definitions: [
          McpCatalogDefinition.make({
            definitionId: McpDefinitionId.make("mcp"),
            logicalServerId: McpServerId.make("example"),
            name: "Example MCP",
            scope: "global",
            scopeId: "local",
            enabled: true,
            providerInstanceIds: [],
            revision: 1,
            transport: {
              type: "stdio",
              command: "sensitive-command",
              args: ["sensitive-argument"],
              env: [],
            },
          }),
        ],
        overrides: [],
      },
    };
    const inventory = composeManagedResourceInventory(input);
    expect(inventory.rows).toHaveLength(3);
    expect(inventory.rows[1]).toMatchObject({ kind: "snippet", enabled: true, revision: "hash" });
    expect(inventory.rows[0]?.application).toMatchObject({
      desiredRevision: 3,
      appliedRevision: 2,
      status: "pending_restart",
    });
    expect(inventory.rows[2]).toMatchObject({ kind: "mcp", key: "example" });
    expect(JSON.stringify(inventory)).not.toContain("never copy");
    expect(JSON.stringify(inventory)).not.toContain("sensitive-");
    expect(composeManagedResourceInventory({ ...input, limit: 2 }).truncated).toBe(true);
    expect(composeManagedResourceInventory({ ...input, limit: 0 })).toEqual({
      rows: [],
      truncated: true,
    });
  });
});
