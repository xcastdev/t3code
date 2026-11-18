import {
  EnvironmentId,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  ProjectId,
  ProviderInstanceId,
  SkillContentHash,
  SkillNativeObservationId,
  ThreadId,
  type ManagedTextResourceSummary,
  type SkillCatalogSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resourceEditorConflict } from "@t3tools/client-runtime/resource-actions";

import {
  matchesResourceQuery,
  resolveResourceCheckout,
  skillActions,
  skillKeyCollisions,
  skillReloadBaseline,
  textResourceActions,
} from "./resourceInventory";

const codex = ProviderInstanceId.make("codex");

describe("resourceEditorConflict", () => {
  it("keeps an editor on its own baseline and names what moved", () => {
    const editing = { catalogRevision: 4, entryRevision: "r1" };
    expect(resourceEditorConflict(editing, { catalogRevision: 4, entryRevision: "r1" })).toBe(null);
    expect(resourceEditorConflict(editing, { catalogRevision: 5, entryRevision: "r1" })).toBe(
      "changed",
    );
    expect(resourceEditorConflict(editing, { catalogRevision: 4, entryRevision: "r2" })).toBe(
      "changed",
    );
    expect(resourceEditorConflict(editing, { catalogRevision: 5, entryRevision: undefined })).toBe(
      "removed",
    );
    // A content-hash edit ignores unrelated catalog changes.
    expect(
      resourceEditorConflict(
        { catalogRevision: null, entryRevision: "h1" },
        { catalogRevision: 9, entryRevision: "h1" },
      ),
    ).toBe(null);
  });
});

describe("resolveResourceCheckout", () => {
  it("writes only to a single checkout and asks when a project has several", () => {
    const a = { id: ProjectId.make("a") };
    const b = { id: ProjectId.make("b") };
    expect(resolveResourceCheckout([a])).toEqual({ kind: "single", projectId: "a" });
    expect(resolveResourceCheckout([a, b])).toEqual({ kind: "ambiguous", members: [a, b] });
    expect(resolveResourceCheckout([])).toEqual({ kind: "none" });
  });
});

const managedSkill = (
  overrides: Partial<Extract<SkillCatalogSummary, { origin: "managed" }>> = {},
) =>
  ({
    origin: "managed",
    id: ManagedSkillId.make("skill-1"),
    key: ManagedSkillKey.make("review"),
    name: "Review",
    scope: "global",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: { revision: 1, hash: SkillContentHash.make("hash-1") },
    validity: "valid",
    effective: true,
    compatibility: [],
    ...overrides,
  }) satisfies SkillCatalogSummary;

const nativeSkill: SkillCatalogSummary = {
  origin: "native",
  id: SkillNativeObservationId.make("observation-1"),
  providerInstanceId: codex,
  key: "review",
  name: "Review",
  scope: "provider",
  scopeId: "codex",
  projectState: "inherit",
  revision: { revision: 0, hash: SkillContentHash.make("native-hash") },
  validity: "valid",
  effective: true,
  compatibility: [],
};

describe("skillReloadBaseline", () => {
  const revisionB = { revision: 2, hash: SkillContentHash.make("hash-2") };
  const detailB = {
    metadata: {
      id: ManagedSkillId.make("skill-1"),
      key: ManagedSkillKey.make("review"),
      name: "Review",
      scope: "global",
      scopeId: "environment-1",
      origin: "created",
      ownership: "t3",
      revision: revisionB,
    },
    content: { key: ManagedSkillKey.make("review"), name: "Review", body: "B\n" },
  } as const;
  const source = managedSkill();

  it("adopts fresh content with the catalog revision that names it, in one reload", () => {
    const catalog = {
      entries: [managedSkill({ revision: revisionB })],
      catalogRevision: 7 as never,
    };
    expect(skillReloadBaseline(source, detailB, catalog)).toBe(7);
  });

  it("adopts nothing when the catalog moved again, dropped the skill, or names another one", () => {
    const revisionC = { revision: 3, hash: SkillContentHash.make("hash-3") };
    for (const entries of [
      [managedSkill({ revision: revisionC })],
      [],
      [managedSkill({ revision: revisionB, scope: "project" })],
    ])
      expect(skillReloadBaseline(source, detailB, { entries, catalogRevision: 8 as never })).toBe(
        null,
      );
    const other = { ...detailB, metadata: { ...detailB.metadata, id: ManagedSkillId.make("x") } };
    expect(
      skillReloadBaseline(source, other, {
        entries: [managedSkill({ revision: revisionB })],
        catalogRevision: 8 as never,
      }),
    ).toBe(null);
  });
});

describe("skill actions", () => {
  const environment = { projectId: null, threadId: null };
  const project = { projectId: "project-1", threadId: null };
  const thread = { projectId: "project-1", threadId: "thread-1" };

  it("edits shared packages only at their own scope and overlays sessions per thread", () => {
    expect(skillActions(managedSkill(), environment)).toContain("edit");
    expect(skillActions(managedSkill(), project)).toEqual([
      "override",
      "disable-project",
      "install",
    ]);
    expect(
      skillActions(managedSkill({ scope: "project", projectState: "override" }), project),
    ).toContain("edit-override");
    expect(skillActions(managedSkill(), thread)).toEqual(["session-disable", "session-reset"]);
    expect(skillActions(managedSkill({ effective: false }), thread)).toEqual([
      "session-enable",
      "session-reset",
    ]);
  });

  it("offers a thread's key-only session toggle only on the package that wins the key", () => {
    const global = managedSkill({ effective: false, projectState: "override" });
    const winner = managedSkill({
      id: ManagedSkillId.make("skill-2"),
      scope: "project",
      scopeId: "project-1",
      projectState: "override",
    });
    const entries = [global, winner];
    expect(skillActions(global, thread, entries)).toEqual([]);
    expect(skillActions(winner, thread, entries)).toEqual(["session-disable", "session-reset"]);
    // Turned off for the thread, the project package still owns the key, not the shadowed one.
    const off = { ...winner, effective: false };
    expect(skillActions(global, thread, [global, off])).toEqual([]);
    expect(skillActions(off, thread, [global, off])).toEqual(["session-enable", "session-reset"]);
    const shadowed = managedSkill({
      conflict: { kind: "shadowed", keys: [ManagedSkillKey.make("review")], message: "Shadowed" },
    });
    expect(skillActions(shadowed, thread, [shadowed])).toEqual([]);
  });

  it("imports provider skills only environment-wide and never edits them in place", () => {
    expect(skillActions(nativeSkill, environment)).toEqual(["view-native", "import-native"]);
    expect(skillActions(nativeSkill, project)).toEqual(["view-native"]);
  });

  it("flags a key offered by both a managed and a provider source", () => {
    expect([...skillKeyCollisions([managedSkill(), nativeSkill])]).toEqual(["review"]);
    expect([...skillKeyCollisions([managedSkill()])]).toEqual([]);
  });
});

describe("text resource actions", () => {
  const command: ManagedTextResourceSummary = {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: EnvironmentId.make("environment-1"),
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: true,
  };

  it("follows the destination: environment edit, project override, thread overlay", () => {
    expect(textResourceActions(command, { projectId: null, threadId: null }, false)).toEqual([
      "edit",
      "disable",
      "delete",
    ]);
    expect(
      textResourceActions(command, { projectId: ProjectId.make("p"), threadId: null }, false),
    ).toEqual(["override", "disable-project"]);
    expect(
      textResourceActions(
        command,
        { projectId: ProjectId.make("p"), threadId: ThreadId.make("t") },
        true,
      ),
    ).toEqual(["thread-disable", "thread-reset"]);
    expect(
      textResourceActions(
        { ...command, projectState: "orphan" },
        { projectId: "p", threadId: null },
        false,
      ),
    ).toEqual(["reset-project"]);
  });
});

describe("matchesResourceQuery", () => {
  it("matches names and keys without case or surrounding whitespace", () => {
    expect(matchesResourceQuery(" REVIEW-CODE ", "Code review", "review-code")).toBe(true);
    expect(matchesResourceQuery("REVIEW", "Code review", "inspect")).toBe(true);
    expect(matchesResourceQuery("", undefined, "inspect")).toBe(true);
    expect(matchesResourceQuery("docs", undefined, "inspect")).toBe(false);
  });
});
