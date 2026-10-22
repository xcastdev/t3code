import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  readComposerDraftSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
// The hook's managed-resource and dialog wiring loads Expo; these tests cover pure helpers only.
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/resources", () => ({
  issueSearchEnvironment: {},
  managedTextEnvironment: {},
  resourceCatalogInput: vi.fn(),
  skillsEnvironment: {},
  useComposerResourceSubscriptions: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => refreshProviders,
}));

import {
  buildComposerSlashCommandItems,
  isComposerMenuVisible,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

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

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("isComposerMenuVisible", () => {
  it("shows a failed managed or issue lookup even when nothing matches", () => {
    for (const kind of ["slash-command", "skill", "issue"]) {
      const trigger = { kind };
      expect(isComposerMenuVisible({ trigger, items: [], error: null })).toBe(false);
      expect(
        isComposerMenuVisible({ trigger, items: [], error: "Managed skills couldn't be loaded." }),
      ).toBe(true);
    }
    expect(
      isComposerMenuVisible({ trigger: { kind: "pull-request" }, items: [], error: null }),
    ).toBe(true);
    expect(isComposerMenuVisible({ trigger: null, items: [], error: "failed" })).toBe(false);
  });
});
