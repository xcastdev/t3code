import {
  ManagedSkillId,
  ManagedSkillKey,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
  SkillContentHash,
  ThreadId,
  type SkillCatalogChanged,
  type SkillCatalogListInput,
  type SkillCatalogListResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SkillCatalogCache,
  skillCatalogQueryKey,
  sessionSkillDeliveryLabel,
  sessionSkillEntries,
} from "./skillCatalog.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const providerInstanceId = ProviderInstanceId.make("codex-main");
const key = ManagedSkillKey.make("deploy");

const query: SkillCatalogListInput = { projectId, threadId, providerInstanceId };
const result: SkillCatalogListResult = {
  catalogRevision: SkillCatalogRevision.make(3),
  entries: [
    {
      origin: "managed",
      id: ManagedSkillId.make("skill-1"),
      key,
      name: "Deploy",
      scope: "global",
      scopeId: "global",
      projectState: "inherit",
      revision: { revision: 1, hash: SkillContentHash.make("hash-1") },
      validity: "valid",
      effective: true,
      compatibility: [],
    },
  ],
};

describe("SkillCatalogCache", () => {
  it("offers one overlay toggle per key and uses the effective definition regardless of order", () => {
    const entry = result.entries[0]!;
    if (entry.origin !== "managed") throw new Error("Expected managed fixture");
    const global = { ...entry, effective: false };
    const project = {
      ...global,
      id: ManagedSkillId.make("project-skill"),
      scope: "project" as const,
      effective: true,
    };
    expect(sessionSkillEntries([global, project])).toEqual([project]);
    expect(sessionSkillEntries([project, global])).toEqual([project]);
    expect(sessionSkillEntries([global, { ...project, effective: false }])).toHaveLength(1);
  });
  it("does not offer session use when the selected provider cannot deliver a managed skill", () => {
    const entry = result.entries[0]!;
    expect(
      sessionSkillEntries([
        {
          ...entry,
          compatibility: [
            {
              providerInstanceId,
              support: "unsupported",
              applicationMode: "unsupported",
              reasons: [],
            },
          ],
        },
      ]),
    ).toEqual([]);
  });
  it("does not confuse desired enablement with provider delivery", () => {
    const entry = result.entries[0]!;
    expect(sessionSkillDeliveryLabel(entry)).toBe("Delivery has not been reported");
    expect(
      sessionSkillDeliveryLabel({
        ...entry,
        application: {
          desiredRevision: SkillCatalogRevision.make(4),
          appliedRevision: SkillCatalogRevision.make(2),
          status: "pending_new_session",
        },
      }),
    ).toBe("Pending new session (desired 4, applied 2)");
    expect(
      sessionSkillDeliveryLabel({
        ...entry,
        application: {
          desiredRevision: SkillCatalogRevision.make(4),
          appliedRevision: SkillCatalogRevision.make(2),
          status: "failed",
          failure: { code: "rejected", message: "Provider rejected the plugin." },
        },
      }),
    ).toBe("Delivery failed (desired 4, applied 2): Provider rejected the plugin.");
  });
  it("uses only opaque identifiers in cache keys", () => {
    expect(skillCatalogQueryKey(query)).toBe("project-1:thread-1:codex-main");
  });

  it("keeps compact summaries and invalidates only matching queries", () => {
    const cache = new SkillCatalogCache();
    const otherQuery = { projectId: ProjectId.make("project-2") };
    cache.set(query, result);
    cache.set(otherQuery, { ...result, catalogRevision: SkillCatalogRevision.make(1) });

    const change: SkillCatalogChanged = {
      scope: "project",
      scopeId: projectId,
      catalogRevision: SkillCatalogRevision.make(4),
      changedKeys: [key],
    };
    expect(cache.invalidate(change)).toEqual([skillCatalogQueryKey(query)]);
    expect(cache.get(query)).toBeUndefined();
    expect(cache.get(otherQuery)?.catalogRevision).toBe(1);
  });

  it("invalidates every cached view for a global change", () => {
    const cache = new SkillCatalogCache();
    cache.set(query, result);
    cache.set({}, result);

    cache.invalidate({
      scope: "global",
      scopeId: "global",
      catalogRevision: SkillCatalogRevision.make(4),
      changedKeys: [key],
    });

    expect(cache.size).toBe(0);
  });
});
