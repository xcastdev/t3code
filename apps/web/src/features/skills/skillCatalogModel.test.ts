import type { SkillCatalogSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { skillStatusLabel, skillSurfaceSections } from "./skillCatalogModel.ts";

const summary = (overrides: Partial<SkillCatalogSummary>): SkillCatalogSummary =>
  ({
    origin: "managed",
    id: "skill-1",
    key: "deploy",
    name: "Deploy",
    scope: "global",
    scopeId: "global",
    projectState: "inherit",
    revision: { revision: 1, hash: "hash" },
    validity: "valid",
    effective: true,
    compatibility: [],
    ...overrides,
  }) as SkillCatalogSummary;

describe("skill catalog presentation", () => {
  it("separates managed and provider-owned definitions", () => {
    const sections = skillSurfaceSections([
      summary({}),
      summary({ origin: "native", id: "native-1", providerInstanceId: "codex" } as never),
    ]);
    expect(sections.managed).toHaveLength(1);
    expect(sections.native).toHaveLength(1);
  });

  it("explains pending and failed provider application state", () => {
    expect(skillStatusLabel("pending_new_session")).toBe("Available in a new session");
    expect(skillStatusLabel("failed")).toBe("Delivery failed");
  });
});
