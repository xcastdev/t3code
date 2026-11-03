import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pluginPanelKey } from "@t3tools/client-runtime/plugins/commands";
import { EnvironmentId, PluginId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectDockedPluginPanels, usePluginPanelStore } from "./pluginPanelStore";
import { useRightPanelStore } from "./rightPanelStore";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const inspector = PluginId.make("inspector");
const converter = PluginId.make("converter");

function setup() {
  usePluginPanelStore.setState({ byEnvironment: {} });
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

  it("dropPlugin removes open and focused entries", () => {
    const store = setup();
    const inA = pluginPanelKey(A, inspector, "requests");
    const otherInA = pluginPanelKey(A, converter, "converter");
    const inB = pluginPanelKey(B, inspector, "requests");
    store.open(otherInA, A);
    store.open(inA, A);
    store.open(inB, B);
    store.dropPlugin(A, inspector);
    expect(docked(A)).toEqual({ open: [otherInA], focused: null });
    expect(docked(B)).toEqual({ open: [inB], focused: inB });
  });
});
