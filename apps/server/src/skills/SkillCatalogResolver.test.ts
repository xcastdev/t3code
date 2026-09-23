import { assert, describe, it } from "@effect/vitest";
import type {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillContentHash,
  SkillNativeObservation,
} from "@t3tools/contracts";

import type { SkillCatalogEntry, SkillCatalogSnapshot } from "./SkillCatalogIndex.ts";
import { resolveSkillCatalog } from "./SkillCatalogResolver.ts";

const key = (value: string) => value as ManagedSkillKey;
const id = (value: string) => value as ManagedSkillId;
const hash = (value: string) => value as SkillContentHash;

const entry = (
  skillKey: string,
  scope: "global" | "project",
  state: SkillCatalogEntry["state"] = scope === "global" ? "global" : "override",
): SkillCatalogEntry => ({
  key: skillKey,
  validity: "valid",
  diagnostics: [],
  skillId: id(`${scope}-${skillKey}`),
  name: `${scope} ${skillKey}`,
  revision: 1,
  hash: hash(`${scope}-${skillKey}-hash`),
  state,
});

const snapshot = (
  scope: "global" | "project",
  entries: ReadonlyArray<SkillCatalogEntry>,
): SkillCatalogSnapshot => ({
  scope,
  scopeId: scope === "global" ? "global" : "project-one",
  catalogRevision: 1,
  availability: "available",
  entries,
});

const native = (nativeIdentity: string): SkillNativeObservation => ({
  observationId: `observation-${nativeIdentity}` as SkillNativeObservation["observationId"],
  providerInstanceId: "codex" as ProviderInstanceId,
  nativeIdentity,
  key: key("deploy"),
  displayName: "Native deploy",
  source: "codex",
  scopeSummary: "user",
  freshness: "fresh",
  attemptedAt: "2026-09-20T12:00:00.000Z",
});

describe("SkillCatalogResolver", () => {
  it("resolves inheritance, override, disable, session re-enable, deletion, and rename by key", () => {
    const global = snapshot("global", [entry("deploy", "global"), entry("lint", "global")]);

    const inherited = resolveSkillCatalog({ global, project: snapshot("project", []) });
    assert.equal(inherited.byKey.get("deploy")?.winner?.skillId, id("global-deploy"));
    assert.isTrue(inherited.byKey.get("deploy")?.effective);

    const overridden = resolveSkillCatalog({
      global,
      project: snapshot("project", [entry("deploy", "project")]),
    });
    assert.equal(overridden.byKey.get("deploy")?.winner?.skillId, id("project-deploy"));
    assert.equal(overridden.byKey.get("deploy")?.projectState, "override");

    const disabled = resolveSkillCatalog({
      global,
      project: snapshot("project", [entry("deploy", "project", "disabled")]),
    });
    assert.isFalse(disabled.byKey.get("deploy")?.effective);
    assert.equal(disabled.byKey.get("deploy")?.winner?.skillId, id("global-deploy"));

    const reenabled = resolveSkillCatalog({
      global,
      project: snapshot("project", [entry("deploy", "project", "disabled")]),
      session: [{ key: key("deploy"), enabled: true }],
    });
    assert.isTrue(reenabled.byKey.get("deploy")?.effective);

    const renamed = resolveSkillCatalog({
      global: snapshot("global", [entry("ship", "global")]),
      project: snapshot("project", [entry("deploy", "project")]),
    });
    assert.equal(renamed.byKey.get("ship")?.projectState, "inherit");
    assert.equal(renamed.byKey.get("deploy")?.projectState, "override");
  });

  it("blocks inherited content for malformed and duplicate project keys and keeps orphan tombstones", () => {
    const malformed: SkillCatalogEntry = {
      key: "deploy",
      validity: "invalid",
      diagnostics: [{ code: "invalid_manifest", message: "broken" }],
      state: "invalid",
    };
    const result = resolveSkillCatalog({
      global: snapshot("global", [entry("deploy", "global")]),
      project: snapshot("project", [malformed, malformed]),
    });
    const resolved = result.byKey.get("deploy");
    assert.isUndefined(resolved?.winner);
    assert.isFalse(resolved?.effective);
    assert.equal(resolved?.validity, "invalid");
    assert.isTrue(
      resolved?.diagnostics.some((diagnostic) => diagnostic.code === "duplicate_project_key"),
    );

    const orphan = resolveSkillCatalog({
      global: snapshot("global", []),
      project: snapshot("project", [entry("gone", "project", "disabled")]),
      session: [{ key: key("gone"), enabled: true }],
    }).byKey.get("gone");
    assert.equal(orphan?.projectState, "orphan");
    assert.isUndefined(orphan?.winner);
    assert.isFalse(orphan?.effective);
  });

  it("retains every qualified native collision without exposing paths", () => {
    const result = resolveSkillCatalog({
      global: snapshot("global", [entry("deploy", "global")]),
      project: snapshot("project", []),
      nativeDiscoveries: [
        {
          providerInstanceId: "codex" as ProviderInstanceId,
          freshness: "fresh",
          attemptedAt: "2026-09-20T12:00:00.000Z",
          observations: [native("user:deploy:a"), native("project:deploy:b")],
        },
      ],
    });
    const collisions = result.byKey.get("deploy")?.nativeCollisions ?? [];
    assert.deepEqual(
      collisions.map((observation) => observation.nativeIdentity),
      ["project:deploy:b", "user:deploy:a"],
    );
    assert.isFalse("nativePath" in collisions[0]!);
  });
});
