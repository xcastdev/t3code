import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pluginPanelKey,
  type PluginInstallEntry,
  type PluginPanelScope,
} from "@t3tools/client-runtime/plugins/commands";
import {
  EnvironmentId,
  PluginContributionId,
  PluginId,
  type PluginManifest,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  selectDockedPluginPanels,
  selectPinnedRailPanels,
  usePluginPanelStore,
} from "./pluginPanelStore";
import { useRightPanelStore } from "./rightPanelStore";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const inspector = PluginId.make("inspector");
const converter = PluginId.make("converter");

function setup() {
  usePluginPanelStore.setState({ byEnvironment: {}, pinned: [] });
  return usePluginPanelStore.getState();
}

const docked = (environmentId: string | null) =>
  selectDockedPluginPanels(usePluginPanelStore.getState().byEnvironment, environmentId);

describe("pluginPanelStore", () => {
  it("a thread's automatic panel updates keep the plugin focused, its user actions take over", () => {
    const store = setup();
    const key = pluginPanelKey(A, inspector, "requests");
    store.open(key, A);
    const panels = useRightPanelStore.getState();
    const second = scopeThreadRef(A, ThreadId.make("thread-focus-2"));
    const elsewhere = scopeThreadRef(B, ThreadId.make("thread-focus-b"));

    panels.openProactive(
      second,
      { kind: "diff", turnId: RunId.make("turn-1") },
      panels.getUserActionRevision(second),
    );
    expect(docked(A).focused).toBe(key);

    panels.open(elsewhere, "files");
    expect(docked(A).focused).toBe(key);

    panels.open(second, "files");
    expect(docked(A).focused).toBeNull();
  });

  it("switching environment selects that environment's instance", () => {
    const store = setup();
    const inA = pluginPanelKey(A, inspector, "requests");
    const inB = pluginPanelKey(B, inspector, "requests");
    store.open(inA, A);
    store.open(inB, B);
    expect(docked(A)).toEqual({ open: [inA], focused: inA });
    expect(docked(B)).toEqual({ open: [inB], focused: inB });
  });

  it("client panels appear for every environment", () => {
    const store = setup();
    const key = pluginPanelKey("client", converter, "converter");
    store.open(key, A);
    expect(docked(A)).toEqual({ open: [key], focused: key });
    expect(docked(B)).toEqual({ open: [key], focused: null });
    store.blur(A);
    expect(docked(A)).toEqual({ open: [key], focused: null });
  });

  it("dropPlugin removes open, focused, and pinned entries", () => {
    const store = setup();
    const inA = pluginPanelKey(A, inspector, "requests");
    const otherInA = pluginPanelKey(A, converter, "converter");
    const inB = pluginPanelKey(B, inspector, "requests");
    store.open(otherInA, A);
    store.open(inA, A);
    store.open(inB, B);
    store.pin(inA);
    store.pin(otherInA);
    store.pin(inB);
    store.dropPlugin(A, inspector);
    expect(docked(A)).toEqual({ open: [otherInA], focused: null });
    expect(docked(B)).toEqual({ open: [inB], focused: inB });
    expect(usePluginPanelStore.getState().pinned).toEqual([otherInA, inB]);
  });

  it("pin and unpin are idempotent and keep pin order", () => {
    const store = setup();
    const first = pluginPanelKey(A, inspector, "requests");
    const second = pluginPanelKey("client", converter, "converter");
    store.pin(first);
    store.pin(second);
    store.pin(first);
    expect(usePluginPanelStore.getState().pinned).toEqual([first, second]);
    store.unpin(first);
    store.unpin(first);
    expect(usePluginPanelStore.getState().pinned).toEqual([second]);
  });

  it("rehydrating a v1 entry keeps its docked panels and starts with no pins", async () => {
    setup();
    const key = pluginPanelKey(A, inspector, "requests");
    const { name, storage } = usePluginPanelStore.persist.getOptions();
    await storage?.setItem(name ?? "", {
      state: { byEnvironment: { [A]: { open: [key], focused: key } } },
      version: 1,
    });
    await usePluginPanelStore.persist.rehydrate();
    expect(docked(A)).toEqual({ open: [key], focused: key });
    expect(usePluginPanelStore.getState().pinned).toEqual([]);
  });
});

const install = (
  scope: PluginPanelScope,
  pluginId: PluginId,
  panels: ReadonlyArray<{ id: string; title: string; icon?: string }>,
): PluginInstallEntry => ({
  scope,
  scopeLabel: String(scope),
  record: {
    pluginId,
    version: "1.0.0",
    manifest: {
      ui: {
        panels: panels.map((panel) => ({ ...panel, id: PluginContributionId.make(panel.id) })),
        commands: [],
      },
    } as unknown as PluginManifest,
  },
});

describe("selectPinnedRailPanels", () => {
  const inspectorInA = pluginPanelKey(A, inspector, "requests");
  const converterOnDevice = pluginPanelKey("client", converter, "converter");
  const installs = [
    install(A, inspector, [{ id: "requests", title: "Requests", icon: "network" }]),
    install("client", converter, [{ id: "converter", title: "Converter" }]),
  ];

  it.each([
    {
      name: "client scope docks beside any environment's chat",
      pinned: [converterOnDevice],
      installs,
      chat: B,
      expected: [converterOnDevice],
    },
    {
      name: "another environment's scope is hidden",
      pinned: [inspectorInA, converterOnDevice],
      installs,
      chat: B,
      expected: [converterOnDevice],
    },
    {
      name: "a plugin missing from the enabled installs is hidden",
      pinned: [inspectorInA, converterOnDevice],
      installs: installs.slice(1),
      chat: A,
      expected: [converterOnDevice],
    },
    {
      name: "pins keep their order",
      pinned: [converterOnDevice, inspectorInA],
      installs,
      chat: A,
      expected: [converterOnDevice, inspectorInA],
    },
    {
      name: "no chat shows no pins",
      pinned: [converterOnDevice],
      installs,
      chat: null,
      expected: [],
    },
  ])("$name", ({ pinned, installs, chat, expected }) => {
    expect(selectPinnedRailPanels(pinned, installs, chat).map((panel) => panel.key)).toEqual(
      expected,
    );
  });

  it("carries the panel title and manifest icon", () => {
    expect(selectPinnedRailPanels([inspectorInA], installs, A)).toEqual([
      { key: inspectorInA, title: "Requests", icon: "network" },
    ]);
  });
});
