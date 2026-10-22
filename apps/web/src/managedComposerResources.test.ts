import type {
  ManagedTextResourceContentGetResult,
  ManagedTextResourceSummary,
} from "@t3tools/contracts";
import {
  EnvironmentId,
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillContentHash,
  SkillNativeObservationId,
  type SkillCatalogSummary,
  ProjectId,
  ThreadId,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerTriggerTokenEnd,
  isComposerInsertionCurrent,
  managedCommandArgumentRange,
  resolveManagedSkillInsertion,
  managedSkillMenuItems,
  managedTextMenuItems,
  resolveManagedTextResourceInsertion,
} from "./managedComposerResources";

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

function content(
  overrides: Partial<ManagedTextResourceContentGetResult> = {},
): ManagedTextResourceContentGetResult {
  return {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    revision: ManagedTextResourceRevision.make("revision-1"),
    body: "Review $ARGUMENTS and report risks.",
    ...overrides,
  };
}

describe("resolveManagedTextResourceInsertion", () => {
  it("expands a selected command into ordinary editable draft text", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: command,
        content: content(),
        currentEntries: [command],
        draft: "Please /rev",
        expectedDraft: "Please /rev",
        rangeStart: 7,
        rangeEnd: 11,
        argument: "src/a.ts",
      }),
    ).toEqual({
      status: "inserted",
      text: "Please Review src/a.ts and report risks.",
      cursor: 40,
    });
  });

  it("inserts only the selected snippet range and keeps the surrounding draft", () => {
    const snippet: ManagedTextResourceSummary = {
      ...command,
      kind: "snippet",
      id: ManagedTextResourceId.make("fix-snippet"),
      key: ManagedTextResourceKey.make("fix"),
    };
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: snippet,
        content: content({
          kind: "snippet",
          id: ManagedTextResourceId.make("fix-snippet"),
          key: ManagedTextResourceKey.make("fix"),
          body: "Please fix this.",
        }),
        currentEntries: [snippet],
        draft: "left :fi right",
        expectedDraft: "left :fi right",
        rangeStart: 5,
        rangeEnd: 8,
      }),
    ).toEqual({ status: "inserted", text: "left Please fix this. right", cursor: 21 });
  });

  it("rejects content that does not match the selected revision", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: command,
        content: content({
          revision: ManagedTextResourceRevision.make("revision-2"),
          body: "New body",
        }),
        currentEntries: [command],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("requires reselection if the catalog changed while content was loading", () => {
    const newer = { ...command, revision: ManagedTextResourceRevision.make("revision-2") };
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: command,
        content: content(),
        currentEntries: [newer],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("does not insert a project entry reported as invalid or orphaned", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: command,
        content: content(),
        currentEntries: [{ ...command, projectState: "orphan", effective: true }],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "stale-resource" });
  });

  it("does not overwrite draft edits made while content was loading", () => {
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: { environmentId: EnvironmentId.make("environment-1") },
        currentTarget: { environmentId: EnvironmentId.make("environment-1") },
        selected: command,
        content: content(),
        currentEntries: [command],
        draft: "/review plus user edits",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "draft-changed" });
  });
});

it("rejects a loaded insertion after changing environment, project or thread", () => {
  const target = {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
  };
  for (const currentTarget of [
    { ...target, environmentId: EnvironmentId.make("remote") },
    { ...target, projectId: ProjectId.make("other") },
    { ...target, threadId: ThreadId.make("other") },
  ]) {
    expect(
      resolveManagedTextResourceInsertion({
        selectedTarget: target,
        currentTarget,
        selected: command,
        content: content(),
        currentEntries: [command],
        draft: "/review",
        expectedDraft: "/review",
        rangeStart: 0,
        rangeEnd: 7,
      }),
    ).toEqual({ status: "target-changed" });
  }
});

describe("managed composer menu items", () => {
  it("lists effective commands with source-qualified IDs and flags a provider command of the same name", () => {
    const items = managedTextMenuItems({
      entries: [
        command,
        { ...command, key: ManagedTextResourceKey.make("off"), effective: false },
        { ...command, key: ManagedTextResourceKey.make("gone"), projectState: "orphan" },
      ],
      query: "",
      nativeCommandNames: ["review"],
    });
    expect(items.map((item) => [item.id, item.collidesWithNative])).toEqual([
      ["managed-text:command:managed:review", true],
    ]);
  });

  it("keeps a managed skill next to a provider skill with the same key", () => {
    const managed: SkillCatalogSummary = {
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
    };
    const native: SkillCatalogSummary = {
      ...managed,
      origin: "native",
      id: SkillNativeObservationId.make("observation-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      scope: "provider",
      scopeId: "codex",
    };
    const items = managedSkillMenuItems({
      entries: [managed, native],
      query: "rev",
      nativeSkillNames: ["review"],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entry: { id: "skill-1" }, collidesWithNative: true });
    expect(items[0]!.id).toBe(
      `managed-skill:${JSON.stringify(["managed", "global", "environment-1", "skill-1"])}`,
    );
  });
});

describe("managedCommandArgumentRange", () => {
  it("takes the rest of the command's line as $ARGUMENTS and covers it in the replaced range", () => {
    const draft = "/review src/a.ts and b.ts\nnext line";
    expect(managedCommandArgumentRange(draft, "/review".length)).toEqual({
      argument: "src/a.ts and b.ts",
      rangeEnd: draft.indexOf("\n"),
    });
    expect(managedCommandArgumentRange("/review", 7)).toEqual({ argument: "", rangeEnd: 7 });
  });

  it("starts $ARGUMENTS after the whole command token when the caret is inside it", () => {
    const draft = "/review src/a.ts";
    expect(managedCommandArgumentRange(draft, "/rev".length)).toEqual({
      argument: "src/a.ts",
      rangeEnd: draft.length,
    });
    expect(composerTriggerTokenEnd(draft, "/rev".length)).toBe("/review".length);
    expect(managedCommandArgumentRange("/review\nmore", 4)).toEqual({ argument: "", rangeEnd: 7 });
  });
});

const managedSkill = {
  origin: "managed",
  id: ManagedSkillId.make("skill-1"),
  key: ManagedSkillKey.make("review"),
  name: "Review",
  scope: "project",
  scopeId: "project-1",
  projectState: "override",
  revision: { revision: 3, hash: SkillContentHash.make("hash-3") },
  validity: "valid",
  effective: true,
  compatibility: [],
} as const satisfies SkillCatalogSummary;

const skillContent = {
  metadata: {
    id: managedSkill.id,
    key: managedSkill.key,
    name: "Review",
    scope: "project",
    scopeId: "project-1",
    origin: "created",
    ownership: "t3",
    revision: managedSkill.revision,
  },
  content: { key: managedSkill.key, name: "Review", body: "Check every changed file.\n" },
} as const;

describe("resolveManagedSkillInsertion", () => {
  it("replaces the whole $ token with the verified, source-qualified body", () => {
    const draft = "please $rev now";
    const result = resolveManagedSkillInsertion({
      selected: managedSkill,
      content: skillContent,
      currentEntries: [managedSkill],
      draft,
      rangeStart: 7,
      rangeEnd: composerTriggerTokenEnd(draft, 9),
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;
    expect(result.text).toBe(
      'please <managed-skill key="review" name="Review" source="project" scope-id="project-1" id="skill-1" revision="3" hash="hash-3">\nCheck every changed file.\n</managed-skill>\n now',
    );
    expect(result.text).not.toContain("$review");
    expect(result.cursor).toBe(result.text.length - " now".length);
  });

  it("inserts nothing when the package or its catalog row moved on while loading", () => {
    const base = {
      selected: managedSkill,
      content: skillContent,
      draft: "$review",
      rangeStart: 0,
      rangeEnd: 7,
    };
    const newer = { revision: 4, hash: SkillContentHash.make("hash-4") };
    for (const currentEntries of [
      [],
      [{ ...managedSkill, revision: newer }],
      [{ ...managedSkill, effective: false }],
      [{ ...managedSkill, validity: "invalid" as const }],
      [{ ...managedSkill, scope: "global" as const, scopeId: "environment-1" }],
    ])
      expect(resolveManagedSkillInsertion({ ...base, currentEntries })).toEqual({
        status: "stale-resource",
      });
    expect(
      resolveManagedSkillInsertion({
        ...base,
        currentEntries: [managedSkill],
        content: { ...skillContent, metadata: { ...skillContent.metadata, revision: newer } },
      }),
    ).toEqual({ status: "stale-resource" });
  });
});

describe("isComposerInsertionCurrent", () => {
  const selected = {
    epoch: 4,
    ownerKey: "thread:a",
    target: { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("p") },
    providerInstanceId: "codex",
    draft: "/rev",
    cursor: 4,
    selection: { start: 4, end: 4 },
  };

  it("lands only while nothing the insertion was started against has moved", () => {
    expect(isComposerInsertionCurrent(selected, { ...selected })).toBe(true);
    for (const current of [
      // Escape, dismissal, a caret move, a newer selection or unmount bump the epoch.
      { ...selected, epoch: 5 },
      // Another draft with the same text and destination.
      { ...selected, ownerKey: "draft:b" },
      { ...selected, target: { ...selected.target, projectId: ProjectId.make("q") } },
      { ...selected, draft: "/revi" },
      { ...selected, cursor: 2 },
      // Shift+Right from the caret: the caret stays, only the selection end moves.
      { ...selected, selection: { start: 4, end: 5 } },
      // A switched provider has its own session overlays; the old catalog read proves nothing.
      { ...selected, providerInstanceId: "claude" },
      { ...selected, providerInstanceId: null },
    ])
      expect(isComposerInsertionCurrent(selected, current)).toBe(false);
  });
});
