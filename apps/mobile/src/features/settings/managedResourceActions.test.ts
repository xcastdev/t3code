import {
  EnvironmentId,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
  ThreadId,
  SkillContentHash,
  type ManagedTextResourceKind,
  type ManagedTextResourceSummary,
  type SkillContentDetail,
  type SkillManagedCatalogSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSkillSave,
  buildTextSave,
  effectiveMcpCatalogDefinitions,
  isTextReloadCurrent,
  orphanedThreadTextOverlays,
  resourceEditorConflict,
  resourceEditorDestinationKey,
  textReloadEntry,
  textResourceActions,
  threadTextOverlayReset,
  type ResourceEditorDestination,
  skillDeploymentActions,
  skillMutationForAction,
  textMutationForAction,
} from "./managedResourceActions";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const environmentTarget = { environmentId, projectId: null };
const projectTarget = { environmentId, projectId };

const skillEditor = (
  target: { environmentId: EnvironmentId; projectId: ProjectId | null },
  mode: "create" | "edit" | "override",
  identity: string | null = "skill-1",
): ResourceEditorDestination<"skill"> => ({ ...target, resource: "skill", mode, identity });
const textEditor = (
  target: { environmentId: EnvironmentId; projectId: ProjectId | null },
  resource: ManagedTextResourceKind,
  mode: "create" | "edit" | "override",
  identity: string | null = "review",
): ResourceEditorDestination<ManagedTextResourceKind> => ({
  ...target,
  resource,
  mode,
  identity,
});

const skill: SkillManagedCatalogSummary = {
  origin: "managed",
  id: ManagedSkillId.make("skill-1"),
  key: ManagedSkillKey.make("review"),
  name: "Review",
  scope: "global",
  scopeId: "environment-1",
  projectState: "inherit",
  revision: { revision: 3, hash: SkillContentHash.make("hash-3") },
  validity: "valid",
  effective: true,
  compatibility: [],
};

const content = (hash: string): SkillContentDetail => ({
  metadata: {
    id: skill.id,
    key: skill.key,
    name: "Review",
    scope: "global",
    scopeId: "environment-1",
    origin: "created",
    ownership: "t3",
    revision: { revision: 3, hash: SkillContentHash.make(hash) },
  },
  content: {
    key: skill.key,
    name: "Review",
    body: "Old body",
    assetPaths: ["scripts/check.sh"],
    frontmatter: { "allowed-tools": ["Read"] },
  },
});

describe("skill mutations", () => {
  it("guards project actions with the catalog revision and deletes by content hash", () => {
    const revision = SkillCatalogRevision.make(9);
    expect(skillMutationForAction("disable-project", skill, projectTarget, revision)).toEqual({
      command: "projectSetDisabled",
      input: { projectId, expectedRevision: revision, key: skill.key },
    });
    expect(skillMutationForAction("delete", skill, environmentTarget, revision)).toEqual({
      command: "globalDelete",
      input: { environmentId, skillId: skill.id, expectedHash: skill.revision.hash },
    });
    expect(skillMutationForAction("delete", skill, projectTarget, revision)).toBeNull();
  });

  it("edits against the loaded hash and keeps bundled files and frontmatter", () => {
    expect(
      buildSkillSave({
        form: { key: "review", name: "Review", body: "New body" },
        destination: skillEditor(environmentTarget, "edit"),
        current: skillEditor(environmentTarget, "edit"),
        catalogRevision: SkillCatalogRevision.make(9),
        source: { entry: skill, content: content("hash-3") },
      }),
    ).toEqual({
      ok: true,
      mutation: {
        command: "globalUpdate",
        input: {
          environmentId,
          skillId: skill.id,
          expectedHash: "hash-3",
          content: {
            name: "Review",
            body: "New body",
            assetPaths: ["scripts/check.sh"],
            frontmatter: { "allowed-tools": ["Read"] },
          },
        },
      },
    });
  });

  it("refuses to save over a revision that changed after opening", () => {
    expect(
      buildSkillSave({
        form: { key: "review", name: "Review", body: "New body" },
        destination: skillEditor(environmentTarget, "edit"),
        current: skillEditor(environmentTarget, "edit"),
        catalogRevision: SkillCatalogRevision.make(9),
        source: { entry: skill, content: content("hash-2") },
      }),
    ).toMatchObject({ ok: false });
  });

  it("creates a project override, not an environment edit, from a project", () => {
    expect(
      buildSkillSave({
        form: { key: "review", name: "Review", body: "Project body" },
        destination: skillEditor(projectTarget, "override"),
        current: skillEditor(projectTarget, "override"),
        catalogRevision: SkillCatalogRevision.make(9),
        source: { entry: skill, content: content("hash-3") },
      }),
    ).toMatchObject({
      ok: true,
      mutation: { command: "projectSetOverride", input: { projectId } },
    });
  });
});

describe("text resource mutations", () => {
  const command: ManagedTextResourceSummary = {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: true,
  };
  const catalogRevision = ManagedTextResourceCatalogRevision.make(4);

  it("uses the entry revision for environment actions and the catalog revision for project ones", () => {
    expect(textMutationForAction("disable", command, environmentTarget, catalogRevision)).toEqual({
      command: "environmentSetEnabled",
      input: {
        environmentId,
        kind: "command",
        id: command.id,
        expectedRevision: command.revision,
        enabled: false,
      },
    });
    expect(textMutationForAction("reset-project", command, projectTarget, catalogRevision)).toEqual(
      {
        command: "projectDeleteState",
        input: {
          projectId,
          kind: "command",
          expectedCatalogRevision: catalogRevision,
          key: command.key,
        },
      },
    );
    expect(textMutationForAction("delete", command, projectTarget, catalogRevision)).toBeNull();
  });

  it("validates keys and creates or updates the right scope", () => {
    expect(
      buildTextSave({
        form: { key: "Bad Key", name: "", body: "x" },
        destination: textEditor(environmentTarget, "snippet", "create"),
        current: textEditor(environmentTarget, "snippet", "create"),
        catalogRevision,
        editing: null,
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildTextSave({
        form: { key: "review", name: "", body: "Review $ARGUMENTS" },
        destination: textEditor(environmentTarget, "command", "edit"),
        current: textEditor(environmentTarget, "command", "edit"),
        catalogRevision,
        editing: command,
      }),
    ).toMatchObject({
      ok: true,
      mutation: { command: "environmentUpdate", input: { expectedRevision: "revision-1" } },
    });
    expect(
      buildTextSave({
        form: { key: "review", name: "", body: "Project text" },
        destination: textEditor(projectTarget, "command", "override"),
        current: textEditor(projectTarget, "command", "override"),
        catalogRevision,
        editing: command,
      }),
    ).toMatchObject({
      ok: true,
      mutation: { command: "projectSetOverride", input: { expectedCatalogRevision: 4 } },
    });
  });
});

describe("thread overlays", () => {
  const threadTarget = {
    environmentId,
    projectId,
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
  };

  it("switches a skill for this thread only and resets it to the inherited default", () => {
    const revision = SkillCatalogRevision.make(7);
    expect(skillMutationForAction("session-disable", skill, threadTarget, revision)).toEqual({
      command: "sessionSetEnabled",
      input: {
        threadId: "thread-1",
        providerInstanceId: "codex",
        expectedRevision: 7,
        key: "review",
        enabled: false,
      },
    });
    expect(skillMutationForAction("session-reset", skill, threadTarget, revision)).toMatchObject({
      command: "sessionReset",
      input: { threadId: "thread-1", key: "review" },
    });
    // No provider yet means no overlay owner; nothing is sent.
    expect(
      skillMutationForAction(
        "session-enable",
        skill,
        { ...threadTarget, thread: { ...threadTarget.thread, providerInstanceId: null } },
        revision,
      ),
    ).toBeNull();
  });

  it("switches a command for this thread and puts it back", () => {
    const command: ManagedTextResourceSummary = {
      kind: "command",
      id: ManagedTextResourceId.make("review-command"),
      key: ManagedTextResourceKey.make("review"),
      scope: "project",
      scopeId: "project-1",
      projectState: "override",
      revision: ManagedTextResourceRevision.make("revision-1"),
      effective: true,
    };
    const revision = ManagedTextResourceCatalogRevision.make(2);
    expect(textMutationForAction("thread-disable", command, threadTarget, revision)).toEqual({
      command: "threadSetEnabled",
      input: {
        threadId: "thread-1",
        kind: "command",
        expectedCatalogRevision: 2,
        key: "review",
        enabled: false,
      },
    });
    expect(textMutationForAction("thread-reset", command, threadTarget, revision)).toMatchObject({
      command: "threadReset",
    });
    expect(textMutationForAction("thread-reset", command, projectTarget, revision)).toBeNull();
  });
});

describe("editor baselines", () => {
  it("saves form A against A's hash even after the live content became B", () => {
    // The screen keeps the source it loaded; a newer live revision is a conflict, not a new baseline.
    const loaded = { entry: skill, content: content("hash-3") };
    expect(
      resourceEditorConflict(
        { catalogRevision: null, entryRevision: "hash-3" },
        { catalogRevision: 9, entryRevision: "hash-4" },
      ),
    ).toBe("changed");
    expect(
      buildSkillSave({
        form: { key: "review", name: "Review", body: "Form A" },
        destination: skillEditor(environmentTarget, "edit"),
        current: skillEditor(environmentTarget, "edit"),
        catalogRevision: SkillCatalogRevision.make(1),
        source: loaded,
      }),
    ).toMatchObject({ ok: true, mutation: { input: { expectedHash: "hash-3" } } });
  });

  it("treats a deleted project-only entry as removed instead of recreating it", () => {
    expect(
      resourceEditorConflict(
        { catalogRevision: 4, entryRevision: "revision-1" },
        { catalogRevision: 5, entryRevision: undefined },
      ),
    ).toBe("removed");
  });
});

describe("skill deployment actions", () => {
  it("installs, updates or removes only T3 Code's own copy and never an edited one", () => {
    expect(skillDeploymentActions({ status: "absent" }, "review")).toEqual(["install"]);
    expect(
      skillDeploymentActions({ status: "owned", key: ManagedSkillKey.make("review") }, "review"),
    ).toEqual(["update", "uninstall"]);
    expect(
      skillDeploymentActions({ status: "owned", key: ManagedSkillKey.make("other") }, "review"),
    ).toEqual([]);
    expect(skillDeploymentActions({ status: "drifted" }, "review")).toEqual([]);
    // Inventory: an orphaned copy can be removed by key; an edited one stays.
    expect(
      skillDeploymentActions({ status: "owned", key: ManagedSkillKey.make("old-name") }, null),
    ).toEqual(["uninstall"]);
    expect(
      skillDeploymentActions({ status: "drifted", key: ManagedSkillKey.make("old-name") }, null),
    ).toEqual([]);
  });
});

describe("effectiveMcpCatalogDefinitions", () => {
  it("lists what a project gets, with its overrides applied", () => {
    const definition = {
      definitionId: "definition-1",
      logicalServerId: "server-1",
      scope: "global",
      scopeId: "environment-1",
      name: "Docs",
      transport: { type: "stdio", command: "docs", args: [], env: [] },
      enabled: true,
      providerInstanceIds: [],
      revision: 1,
    } as never;
    const [effective] = effectiveMcpCatalogDefinitions({
      inherited: [definition],
      own: [],
      overrides: [
        {
          id: "override-1",
          scope: "project",
          scopeId: "project-1",
          targetId: "server-1",
          enabled: false,
          name: "Docs here",
        } as never,
      ],
    });
    expect(effective).toMatchObject({ name: "Docs here", enabled: false });
  });
});

describe("editor destinations", () => {
  const environmentB = EnvironmentId.make("environment-2");
  const catalogRevision = ManagedTextResourceCatalogRevision.make(0);

  it("refuses a retained form when the screen now points at another environment or kind", () => {
    // The navigator kept the screen and swapped its params; both catalogs are at revision 0.
    const opened = textEditor(environmentTarget, "command", "create", null);
    for (const current of [
      textEditor({ environmentId: environmentB, projectId: null }, "command", "create", null),
      textEditor(environmentTarget, "snippet", "create", null),
      textEditor(projectTarget, "command", "create", null),
    ]) {
      expect(resourceEditorDestinationKey(current)).not.toBe(resourceEditorDestinationKey(opened));
      expect(
        buildTextSave({
          form: { key: "review", name: "", body: "Private draft for A" },
          destination: opened,
          current,
          catalogRevision,
          editing: null,
        }),
      ).toMatchObject({ ok: false });
    }
    // Unchanged, the same form saves to the destination it was opened for.
    expect(
      buildTextSave({
        form: { key: "review", name: "", body: "Private draft for A" },
        destination: opened,
        current: textEditor(environmentTarget, "command", "create", null),
        catalogRevision,
        editing: null,
      }),
    ).toMatchObject({
      ok: true,
      mutation: { command: "environmentCreate", input: { environmentId, kind: "command" } },
    });
  });

  it("refuses a retained skill form for another environment, project or skill", () => {
    const opened = skillEditor(environmentTarget, "create", null);
    for (const current of [
      skillEditor({ environmentId: environmentB, projectId: null }, "create", null),
      skillEditor(projectTarget, "create", null),
      skillEditor(environmentTarget, "edit", "skill-2"),
    ])
      expect(
        buildSkillSave({
          form: { key: "review", name: "Review", body: "Draft" },
          destination: opened,
          current,
          catalogRevision: SkillCatalogRevision.make(0),
          source: null,
        }),
      ).toMatchObject({ ok: false });
    // A loaded source must be the skill the editor was opened for.
    const otherSkill = skillEditor(environmentTarget, "edit", "skill-2");
    expect(
      buildSkillSave({
        form: { key: "review", name: "Review", body: "Draft" },
        destination: otherSkill,
        current: otherSkill,
        catalogRevision: SkillCatalogRevision.make(0),
        source: { entry: skill, content: content("hash-3") },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("text editor reload", () => {
  const at = (revision: string): ManagedTextResourceSummary => ({
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make(revision),
    effective: true,
  });
  const body = (revision: string) => ({
    kind: "command" as const,
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    revision: ManagedTextResourceRevision.make(revision),
    body: `Body ${revision}`,
  });

  it("asks for the current revision and saves against it after one reload", () => {
    // Opened at r1; another client moved it to r2.
    const entry = textReloadEntry({ kind: "command", key: "review" }, [at("r2")]);
    expect(entry?.revision).toBe("r2");
    expect(isTextReloadCurrent(entry!, body("r2"))).toBe(true);
    const editor = textEditor(environmentTarget, "command", "edit");
    expect(
      buildTextSave({
        form: { key: "review", name: "", body: body("r2").body },
        destination: editor,
        current: editor,
        catalogRevision: ManagedTextResourceCatalogRevision.make(5),
        editing: entry,
      }),
    ).toMatchObject({
      ok: true,
      mutation: { command: "environmentUpdate", input: { expectedRevision: "r2" } },
    });
  });

  it("adopts nothing when the entry moved again or disappeared while loading", () => {
    const entry = textReloadEntry({ kind: "command", key: "review" }, [at("r2")])!;
    expect(isTextReloadCurrent(entry, body("r3"))).toBe(false);
    expect(isTextReloadCurrent(entry, { ...body("r2"), kind: "snippet" })).toBe(false);
    expect(textReloadEntry({ kind: "command", key: "review" }, [])).toBeNull();
    expect(textReloadEntry({ kind: "snippet", key: "review" }, [at("r2")])).toBeNull();
  });
});

describe("orphaned thread text overlays", () => {
  const thread = {
    environmentId,
    projectId,
    thread: { threadId: ThreadId.make("thread-1"), providerInstanceId: null },
  };
  const review: ManagedTextResourceSummary = {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "project",
    scopeId: "project-1",
    projectState: "override",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: false,
  };
  const disabled = {
    threadId: ThreadId.make("thread-1"),
    kind: "command" as const,
    key: ManagedTextResourceKey.make("review"),
    enabled: false,
    revision: ManagedTextResourceRevision.make("overlay-1"),
  };

  it("keeps an overlay resettable after its only source is removed", () => {
    // Turned off for the thread, then the project-only source was deleted.
    expect(orphanedThreadTextOverlays([], [disabled])).toEqual([disabled]);
    expect(
      threadTextOverlayReset(disabled, thread, ManagedTextResourceCatalogRevision.make(6)),
    ).toEqual({
      command: "threadReset",
      input: {
        threadId: "thread-1",
        kind: "command",
        expectedCatalogRevision: 6,
        key: "review",
      },
    });
    // A listed source shows the overlay on its own row instead.
    expect(orphanedThreadTextOverlays([review], [disabled])).toEqual([]);
    expect(orphanedThreadTextOverlays([{ ...review, kind: "snippet" }], [disabled])).toEqual([
      disabled,
    ]);
  });

  it("offers only the reset for an unusable source that still has an overlay", () => {
    const context = { projectId, threadId: ThreadId.make("thread-1") };
    for (const projectState of ["invalid", "orphan"] as const) {
      expect(textResourceActions({ ...review, projectState }, context, true)).toEqual([
        "thread-reset",
      ]);
      expect(textResourceActions({ ...review, projectState }, context, false)).toEqual([]);
    }
  });
});
