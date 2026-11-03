import "~/index.css";

import type {
  ClientPluginRecord,
  ClientPluginStorage,
} from "@t3tools/client-runtime/plugins/client-packages";
import { PluginId, type PluginManifest } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { refreshClientPlugins } from "../../plugins/pluginInstalls";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { PluginPanelPage } from "./PluginPanelPage";
import { collectPanelProbes, pluginPanelTestHtml } from "./pluginPanelTestHtml";

const storage = vi.hoisted(() => ({
  packages: new Map<string, unknown>(),
  states: new Map<string, unknown>(),
}));

vi.mock("~/plugins/clientPluginStore", async () => {
  const { createClientPluginStore } =
    await import("@t3tools/client-runtime/plugins/client-packages");
  const memory: ClientPluginStorage = {
    listPackages: async () => [...storage.packages.values()] as ClientPluginRecord[],
    getPackage: async (pluginId) =>
      (storage.packages.get(pluginId) as ClientPluginRecord | undefined) ?? null,
    putPackage: async (record) => {
      storage.packages.set(record.pluginId, record);
    },
    deletePackage: async (pluginId) => {
      storage.packages.delete(pluginId);
    },
    listStateKeys: async () => [...storage.states.keys()],
    getState: async (key) =>
      (storage.states.get(key) as { value: unknown; version: string } | undefined) ?? null,
    putState: async (key, state) => {
      storage.states.set(key, state);
    },
    deleteState: async (key) => {
      storage.states.delete(key);
    },
  };
  return { clientPluginStore: createClientPluginStore(memory) };
});

const CONVERTER = PluginId.make("converter");

function setup(panelScript: string, body = "") {
  storage.packages.clear();
  storage.states.clear();
  const manifest = {
    manifestVersion: 1,
    id: CONVERTER,
    name: "Converter",
    version: "0.1.0",
    hostApi: "1.0",
    author: "T3 Tools",
    ui: {
      panels: [{ id: "converter", title: "Converter", entry: "ui/converter.html" }],
      commands: [{ id: "open", title: "Open Converter", opens: { panel: "converter" } }],
    },
    capabilities: ["chat.attach"],
  } as unknown as PluginManifest;
  const record: ClientPluginRecord = {
    pluginId: CONVERTER,
    version: "0.1.0",
    name: "Converter",
    enabled: true,
    manifest,
    panelHtml: { converter: pluginPanelTestHtml(panelScript, body) },
  };
  storage.packages.set(CONVERTER, record);
  refreshClientPlugins();
}

const page_ = <PluginPanelPage scope="client" pluginId="converter" panelId="converter" />;

describe("PluginPanelPage", () => {
  it('opens a client panel with no chat selected and refuses attach with "Open a chat to attach this."', async () => {
    setup(
      `
        document.getElementById("attach").addEventListener("click", async () => {
          const response = await call("t3/chat.attach", {
            kind: "text",
            text: "converted",
            expectedChatTargetKey: null,
          });
          probe("attached", response.error ? response.error.message : response.result);
        });
        probe("ready", init.result.hostContext.chatTarget);
      `,
      `<button id="attach" style="position:fixed;inset:0;width:100%;height:100%">Attach</button>`,
    );
    await using screen = await render(
      <AppAtomRegistryProvider>
        <div style={{ width: 600, height: 400, display: "flex" }}>{page_}</div>
      </AppAtomRegistryProvider>,
      { router: "/plugins/client/converter/converter" },
    );
    using probes = collectPanelProbes(screen.container);
    expect(await probes.probe("ready")).toBeNull();
    // Page input before the test (the runner's own) must be older than the activation window.
    const now = performance.now.bind(performance);
    using _later = vi.spyOn(performance, "now").mockImplementation(() => now() + 60_000);
    await page.getByTitle("Converter").click();
    expect(await probes.probe("attached")).toBe("Open a chat to attach this.");
  });

  it("restores bridge state after the page unmounts and remounts", async () => {
    setup(`
      const state = await call("t3/state.get", {});
      if (state.result === null) await call("t3/state.set", { value: { input: "{}" } });
      probe(state.result === null ? "written" : "restored", state.result);
    `);
    function Routed() {
      const pathname = useLocation({ select: (location) => location.pathname });
      return pathname.startsWith("/plugins/") ? page_ : <p>Settings</p>;
    }
    await using screen = await render(
      <AppAtomRegistryProvider>
        <div style={{ width: 600, height: 400, display: "flex" }}>
          <Routed />
        </div>
      </AppAtomRegistryProvider>,
      { router: "/plugins/client/converter/converter" },
    );
    using probes = collectPanelProbes(screen.container);
    await probes.probe("written");

    await screen.router!.navigate({ to: "/settings/plugins" });
    await expect.element(page.getByText("Settings")).toBeVisible();
    expect(screen.container.querySelector("iframe")).toBeNull();

    await screen.router!.navigate({
      to: "/plugins/$scope/$pluginId/$panelId",
      params: { scope: "client", pluginId: "converter", panelId: "converter" },
    });
    expect(await probes.probe("restored")).toEqual({ value: { input: "{}" }, version: "0.1.0" });
  });
});
