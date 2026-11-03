import "~/index.css";

import { pluginPanelKey } from "@t3tools/client-runtime/plugins/commands";
import {
  EnvironmentId,
  PluginId,
  type PluginInstallRecord,
  type PluginManifest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PluginPanelInstall } from "../../plugins/pluginInstalls";
import { PluginPanelFrame } from "./PluginPanelFrame";
import {
  PluginPanelView,
  type PluginPanelActions,
  type PluginPanelServices,
} from "./PluginPanelSurface";
import { collectPanelProbes, pluginPanelTestHtml } from "./pluginPanelTestHtml";

const mocks = vi.hoisted(() => ({
  urls: new Map<string, string>(),
  minted: [] as Array<{ readonly version: string }>,
}));

vi.mock("~/assets/longLivedAssetUrls", () => ({
  useLongLivedAssetUrl: (_environmentId: unknown, resource: { _tag: string; version?: string }) => {
    if (resource._tag !== "plugin-panel" || resource.version === undefined) {
      return { _tag: "Loading" };
    }
    mocks.minted.push({ version: resource.version });
    const url = mocks.urls.get(resource.version);
    return url === undefined
      ? { _tag: "Loading" }
      : { _tag: "Success", url, expiresAt: Number.MAX_SAFE_INTEGER };
  },
}));

function setup() {
  mocks.urls.clear();
  mocks.minted.length = 0;
}

function panelUrl(version: string, html: string): Disposable {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  mocks.urls.set(version, url);
  return { [Symbol.dispose]: () => URL.revokeObjectURL(url) };
}

const ENVIRONMENT = EnvironmentId.make("env-a");
const PLUGIN = PluginId.make("echo");
const PANEL_KEY = pluginPanelKey(ENVIRONMENT, PLUGIN, "main");

const manifest = (version: string): PluginManifest =>
  ({
    manifestVersion: 1,
    id: PLUGIN,
    name: "Echo",
    version,
    hostApi: "1.0",
    author: "T3 Tools",
    ui: { panels: [{ id: "main", title: "Echo", entry: "ui/main.html" }], commands: [] },
    backend: {
      entry: "backend.cjs",
      operations: [],
      topics: [{ name: "events" }],
      resources: [],
      prerequisites: [],
    },
    capabilities: [],
  }) as unknown as PluginManifest;

const environmentInstall = (
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginPanelInstall => ({
  kind: "environment",
  environmentId: ENVIRONMENT,
  environmentLabel: "Workstation",
  record: {
    pluginId: PLUGIN,
    version,
    name: "Echo",
    author: "T3 Tools",
    enabled: true,
    status: "running",
    manifest: manifest(`${version}.0.0`),
    ...overrides,
  },
});

function memoryServices(overrides: Partial<PluginPanelServices> = {}) {
  const states = new Map<string, { value: unknown; version: string }>();
  const services: PluginPanelServices = {
    readState: async (key) => states.get(key) ?? null,
    writeState: async (key, value, version) => {
      states.set(key, { value, version });
    },
    backend: () => ({
      call: async () => null,
      subscribe: () => () => {},
    }),
    attach: async () => "inserted",
    openPanel: () => {},
    ...overrides,
  };
  return services;
}

const noActions: PluginPanelActions = {
  enable: () => {},
  start: () => {},
  restart: () => {},
  showLogs: () => {},
};

describe("PluginPanelFrame", () => {
  it("ignores messages from other windows", async () => {
    const getState = vi.fn(async () => null);
    await using screen = await render(
      <div style={{ width: 400, height: 300 }}>
        <PluginPanelFrame
          title="Echo"
          document={{ kind: "srcdoc", html: pluginPanelTestHtml("") }}
          bridge={{
            manifest: manifest("1.0.0"),
            panelId: "main",
            pluginVersion: "1",
            state: { get: getState, set: async () => {} },
            openSurface: async () => {},
            attach: async () => "inserted",
          }}
          destination={{ kind: "client" }}
          chatTarget={null}
        />
      </div>,
    );
    using probes = collectPanelProbes(screen.container);
    await probes.probe("initialized");

    // Listeners run in registration order, so once this one sees the message the bridge has too.
    const delivered = new Promise<void>((resolve) =>
      window.addEventListener("message", () => resolve(), { once: true }),
    );
    window.postMessage({ jsonrpc: "2.0", id: 99, method: "t3/state.get", params: {} }, "*");
    await delivered;
    expect(getState).not.toHaveBeenCalled();
  });

  it("shows Enable for a disabled plugin, only with permission, and does not mount the frame", async () => {
    const enable = vi.fn();
    const view = (actions: PluginPanelActions) => (
      <PluginPanelView
        panelKey={PANEL_KEY}
        install={environmentInstall("1", { enabled: false, status: "disabled" })}
        chatTarget={null}
        services={memoryServices()}
        actions={actions}
      />
    );
    await using screen = await render(view({ ...noActions, enable }));
    await page.getByRole("button", { name: "Enable" }).click();
    expect(enable).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelector("iframe")).toBeNull();

    await screen.rerender(view({ ...noActions, enable: null }));
    await expect.element(page.getByRole("button", { name: "Enable" })).toBeDisabled();
  });

  it("remounts on the new version when another client updates the plugin", async () => {
    setup();
    using _v1 = panelUrl(
      "1",
      pluginPanelTestHtml(`
        await call("t3/backend.subscribe", { topic: "events", params: {} });
        await call("t3/state.set", { value: { draft: "written by v1" } });
        probe("v1-ready", null);
      `),
    );
    using _v2 = panelUrl(
      "2",
      pluginPanelTestHtml(`
        const state = await call("t3/state.get", {});
        probe("v2-state", state.result);
      `),
    );
    const released = vi.fn();
    const subscribe = vi.fn(() => released);
    const services = memoryServices({
      backend: () => ({ call: async () => null, subscribe }),
    });
    const view = (version: string) => (
      <div style={{ width: 400, height: 300 }}>
        <PluginPanelView
          panelKey={PANEL_KEY}
          install={environmentInstall(version)}
          chatTarget={null}
          services={services}
          actions={noActions}
        />
      </div>
    );

    await using screen = await render(view("1"));
    using probes = collectPanelProbes(screen.container);
    await probes.probe("v1-ready");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();

    await screen.rerender(view("2"));
    expect(released).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(mocks.urls.get("2"));
    expect(mocks.minted.at(-1)).toEqual({ version: "2" });
    expect(await probes.probe("v2-state")).toEqual({
      value: { draft: "written by v1" },
      version: "1",
    });
  });
});
