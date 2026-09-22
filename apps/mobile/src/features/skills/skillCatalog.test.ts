import {
  ManagedSkillId,
  ManagedSkillKey,
  SkillContentHash,
  type SkillCatalogSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mobileSkillSubtitle, sessionSkillNextEnabled } from "./skillCatalog.ts";

const entry = {
  origin: "managed",
  id: ManagedSkillId.make("skill-1"),
  key: ManagedSkillKey.make("deploy"),
  name: "Deploy",
  scope: "global",
  scopeId: "global",
  projectState: "inherit",
  revision: { revision: 1, hash: SkillContentHash.make("hash") },
  validity: "valid",
  effective: true,
  compatibility: [],
} satisfies SkillCatalogSummary;

describe("mobile skills catalog", () => {
  it("keeps ownership and effective state visible", () => {
    expect(mobileSkillSubtitle(entry)).toBe("T3 managed · inherited · enabled");
  });

  it("session control toggles only the shallow overlay", () => {
    expect(sessionSkillNextEnabled(entry)).toBe(false);
    expect(sessionSkillNextEnabled({ ...entry, effective: false })).toBe(true);
  });
});
