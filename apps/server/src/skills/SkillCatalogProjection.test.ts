import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { SkillCatalogListResult } from "@t3tools/contracts";
import type {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillContentHash,
} from "@t3tools/contracts";

import type { SkillCatalogSnapshot } from "./SkillCatalogIndex.ts";
import { projectSkillCatalog } from "./SkillCatalogProjection.ts";
import { resolveSkillCatalog } from "./SkillCatalogResolver.ts";

const source = (scope: "global" | "project"): SkillCatalogSnapshot => ({
  scope,
  scopeId: scope,
  catalogRevision: scope === "global" ? 7 : 9,
  availability: "available",
  entries: [
    {
      key: "deploy",
      validity: "valid",
      diagnostics: [],
      skillId: `${scope}-deploy` as ManagedSkillId,
      name: `${scope} deploy`,
      revision: 2,
      hash: `${scope}-hash` as SkillContentHash,
      state: scope === "global" ? "global" : "override",
    },
  ],
});

describe("SkillCatalogProjection", () => {
  it("reports malformed no-key packages without breaking catalog encoding or masking valid skills", () => {
    const global = source("global");
    const projection = projectSkillCatalog(
      resolveSkillCatalog({
        global: {
          ...global,
          entries: [
            ...global.entries,
            {
              key: "Bad_Name",
              validity: "invalid",
              state: "invalid",
              diagnostics: [{ code: "invalid_key", message: "Invalid portable key." }],
            },
          ],
        },
      }),
    );
    assert.isTrue(Schema.is(SkillCatalogListResult)(projection));
    assert.equal(projection.entries.length, 1);
    assert.isTrue(projection.entries[0]!.effective);
    assert.equal(projection.diagnostics?.[0]?.name, "Bad_Name");
  });
  it("projects bounded managed/native summaries and marks the effective winner", () => {
    const providerInstanceId = "codex" as ProviderInstanceId;
    const resolved = resolveSkillCatalog({
      global: source("global"),
      project: source("project"),
      nativeDiscoveries: [
        {
          providerInstanceId,
          freshness: "fresh",
          attemptedAt: "2026-09-20T12:00:00.000Z",
          observations: [
            {
              observationId: "native-deploy" as never,
              providerInstanceId,
              nativeIdentity: "user:deploy",
              key: "deploy" as ManagedSkillKey,
              displayName: "Native deploy",
              source: "codex",
              scopeSummary: "user",
              freshness: "fresh",
              attemptedAt: "2026-09-20T12:00:00.000Z",
            },
          ],
        },
      ],
    });
    const projection = projectSkillCatalog(resolved, {
      compatibilityByKey: new Map([
        [
          "deploy" as ManagedSkillKey,
          [
            {
              providerInstanceId,
              support: "supported",
              applicationMode: "new_session_required",
              reasons: [],
            },
          ],
        ],
      ]),
    });

    assert.equal(projection.catalogRevision, 9);
    assert.equal(projection.entries.length, 3);
    assert.deepEqual(
      projection.entries.filter((item) => item.origin === "managed").map((item) => item.effective),
      [false, true],
    );
    const native = projection.entries.find((item) => item.origin === "native");
    assert.equal(native?.scope, "provider");
    assert.deepInclude(native?.conflict, { kind: "shadowed" });
    assert.isFalse(JSON.stringify(projection).includes("nativePath"));
    assert.isFalse(JSON.stringify(projection).includes("body"));
    const unsupported = projectSkillCatalog(resolved, {
      compatibilityByKey: new Map([
        [
          "deploy" as ManagedSkillKey,
          [
            {
              providerInstanceId,
              support: "unsupported",
              applicationMode: "unsupported",
              reasons: [],
            },
          ],
        ],
      ]),
    });
    const nativeWithoutDelivery = unsupported.entries.find((item) => item.origin === "native");
    assert.isTrue(nativeWithoutDelivery?.effective);
    assert.isUndefined(nativeWithoutDelivery?.conflict);
  });
});
