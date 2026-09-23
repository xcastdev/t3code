import { describe, expect, it, vi } from "vite-plus/test";
import {
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  ProviderDriverKind,
} from "@t3tools/contracts";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildManagedTextResourceMenuItems,
  buildComposerSlashCommandItems,
  managedCommandInvocationNeedsChoice,
  resolveComposerCommandSelection,
} from "./composer-command-menu-model";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("hides a provider slash command when a visible skill has the same name", () => {
    const items = buildComposerSlashCommandItems({
      query: "rev",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      visibleSkillNames: new Set(["review"]),
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("claudeAgent"),
        slashCommands: [{ name: "review" }, { name: "review-history" }],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["pcmd:review-history"]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });

  it("keeps managed and provider-native slash commands as source-labeled choices on collisions", () => {
    const managedEntry = {
      kind: "command" as const,
      id: ManagedTextResourceId.make("resource-review"),
      key: ManagedTextResourceKey.make("review"),
      name: "Review changes",
      scope: "project" as const,
      scopeId: "project-1",
      projectState: "override" as const,
      revision: ManagedTextResourceRevision.make("revision-1"),
      effective: true,
    };
    const input = {
      query: "rev",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("claudeAgent"),
        slashCommands: [{ name: "review", description: "Open provider review" }],
      },
      managedEntries: [managedEntry],
    } satisfies Parameters<typeof buildComposerSlashCommandItems>[0];

    const items = buildComposerSlashCommandItems(input);

    expect(items.map((item) => item.id)).toEqual(["managed:review", "pcmd:review"]);
    expect(items.map((item) => ("sourceLabel" in item ? item.sourceLabel : undefined))).toEqual([
      "Managed · Project",
      "Provider native",
    ]);
    const nativeItems = items.filter((item) => item.type !== "managed-text-resource");
    expect(
      managedCommandInvocationNeedsChoice({
        key: "review",
        catalogResolved: true,
        entries: [managedEntry],
        nativeItems,
        nativeChoiceKey: null,
      }),
    ).toBe(true);
    expect(
      managedCommandInvocationNeedsChoice({
        key: "review",
        catalogResolved: true,
        entries: [managedEntry],
        nativeItems,
        nativeChoiceKey: "review",
      }),
    ).toBe(false);
    expect(
      managedCommandInvocationNeedsChoice({
        key: "review",
        catalogResolved: false,
        entries: [],
        nativeItems,
        nativeChoiceKey: null,
      }),
    ).toBe(true);
  });

  it("offers effective snippets by single-colon key and keeps their source visible", () => {
    const entries = [
      {
        kind: "snippet" as const,
        id: ManagedTextResourceId.make("resource-fix"),
        key: ManagedTextResourceKey.make("fix-layout"),
        name: "Fix layout",
        scope: "environment" as const,
        scopeId: "environment-1",
        projectState: "inherit" as const,
        revision: ManagedTextResourceRevision.make("revision-1"),
        effective: true,
      },
      {
        kind: "snippet" as const,
        id: ManagedTextResourceId.make("resource-private"),
        key: ManagedTextResourceKey.make("private"),
        scope: "project" as const,
        scopeId: "project-1",
        projectState: "disabled" as const,
        revision: ManagedTextResourceRevision.make("revision-2"),
        effective: false,
      },
      {
        kind: "snippet" as const,
        key: ManagedTextResourceKey.make("invalid"),
        scope: "project" as const,
        scopeId: "project-1",
        projectState: "invalid" as const,
        revision: ManagedTextResourceRevision.make("revision-3"),
        effective: false,
      },
      {
        kind: "snippet" as const,
        key: ManagedTextResourceKey.make("orphan"),
        scope: "project" as const,
        scopeId: "project-1",
        projectState: "orphan" as const,
        revision: ManagedTextResourceRevision.make("revision-4"),
        effective: false,
      },
    ];

    expect(buildManagedTextResourceMenuItems({ entries, kind: "snippet", query: "fix" })).toEqual([
      {
        id: "managed:fix-layout",
        type: "managed-text-resource",
        resource: entries[0],
        label: ":fix-layout",
        description: "Fix layout",
        sourceLabel: "Managed · Environment",
      },
    ]);
  });
});
