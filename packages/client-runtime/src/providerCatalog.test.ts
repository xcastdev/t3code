import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeServerProviderCatalogs } from "./providerCatalog.ts";

const provider = (instanceId: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "stale" }],
  skills: [
    {
      name: "stale",
      path: "/old/.opencode/skills/stale/SKILL.md",
      enabled: true,
    },
  ],
});

describe("mergeServerProviderCatalogs", () => {
  it("replaces directory-scoped commands and skills while preserving other provider metadata", () => {
    const result = mergeServerProviderCatalogs([provider("opencode")], {
      providers: [
        {
          instanceId: ProviderInstanceId.make("opencode"),
          slashCommands: [{ name: "project-command", description: "Project command" }],
          skills: [
            {
              name: "project-skill",
              path: "/repo/.opencode/skills/project-skill/SKILL.md",
              enabled: true,
            },
          ],
        },
      ],
    });

    expect(result[0]?.models).toEqual([]);
    expect(result[0]?.slashCommands).toEqual([
      { name: "project-command", description: "Project command" },
    ]);
    expect(result[0]?.skills[0]?.name).toBe("project-skill");
  });

  it("leaves instances without a directory catalog unchanged", () => {
    const current = [provider("codex")];
    expect(mergeServerProviderCatalogs(current, { providers: [] })).toBe(current);
  });
});
