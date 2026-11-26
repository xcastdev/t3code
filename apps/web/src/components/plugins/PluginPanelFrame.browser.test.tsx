import "~/index.css";

import { pluginPanelKey } from "@t3tools/client-runtime/plugins/commands";
import {
  EnvironmentId,
  PluginId,
  type PluginInstallRecord,
  type PluginManifest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import type { HostedAssetDocument } from "~/components/files/HostedAssetDocument";
import { setAppearanceMode } from "~/hooks/useTheme";
import type { PluginPanelInstall } from "../../plugins/pluginInstalls";
import { PluginPanelFrame } from "./PluginPanelFrame";
import {
  PluginPanelSurface,
  PluginPanelView,
  type PluginPanelActions,
  type PluginPanelServices,
} from "./PluginPanelSurface";
import { collectPanelProbes, pluginPanelTestHtml } from "./pluginPanelTestHtml";

const mocks = vi.hoisted(() => ({
  urls: new Map<string, string>(),
  install: undefined as PluginPanelInstall | undefined,
  waitForConnection: vi.fn<() => Promise<void>>(),
  mutate: vi.fn(),
  minted: [] as Array<{ readonly version: string }>,
  rendered: vi.fn<(props: ComponentProps<typeof HostedAssetDocument>) => void>(),
}));

const hostedUrl = "https://widget-relay.example/api/assets/signed.grant/main.html";
const desktopUrl = "https://desktop-relay.example/api/assets/signed.grant/main.html";

vi.mock(import("~/plugins/pluginInstalls"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePluginPanelInstall: () => {
    if (!mocks.install) throw new Error("Expected a plugin install.");
    return mocks.install;
  },
}));

vi.mock(import("@t3tools/client-runtime/state/connections"), async (importOriginal) => ({
  ...(await importOriginal()),
  waitForEnvironmentConnection: mocks.waitForConnection,
}));

vi.mock(import("~/state/plugins"), async (importOriginal) => {
  const { pluginEnvironment } = await importOriginal();
  return {
    pluginEnvironment: {
      ...pluginEnvironment,
      mutate: {
        ...pluginEnvironment.mutate,
        run: async (_registry, input) => {
          mocks.mutate(input);
          return AsyncResult.success(null);
        },
      },
    },
  };
});

vi.mock(import("~/connection/hostedRelayAdmission"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostedAdmissionRequired: (url) => url === hostedUrl,
}));

vi.mock(import("~/lib/desktopRelayTransport"), async (importOriginal) => ({
  ...(await importOriginal()),
  desktopRelayAdmissionRequired: (url) => url === desktopUrl,
}));

vi.mock(import("~/components/files/HostedAssetDocument"), () => ({
  HostedAssetDocument: (props) => {
    mocks.rendered(props);
    return <div aria-label={props.title} />;
  },
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
  setAppearanceMode("dark");
  mocks.urls.clear();
  mocks.minted.length = 0;
  mocks.rendered.mockClear();
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
  it.each([
    { kind: "hosted web", url: hostedUrl },
    { kind: "enrolled Electron", url: desktopUrl },
  ])("keeps $kind backend calls and subscriptions inside the panel bridge", async ({ url }) => {
    setup();
    mocks.urls.set("1", url);
    if (url === desktopUrl) {
      vi.stubGlobal("desktopBridge", { relayTransport: {} });
    }
    using _desktop = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const subscribed = vi.fn();
    const unsubscribe = vi.fn();
    const clipboard = vi.fn();
    const installedManifest = { ...manifest("1.0.0"), capabilities: ["clipboard.write" as const] };
    const install = environmentInstall("1", { manifest: installedManifest });
    const backend = vi.fn(() => ({
      call: async () => null,
      subscribe: (...args: Parameters<ReturnType<PluginPanelServices["backend"]>["subscribe"]>) => {
        subscribed(...args);
        return unsubscribe;
      },
    }));
    await using screen = await render(
      <PluginPanelView
        panelKey={PANEL_KEY}
        install={install}
        chatTarget={null}
        services={memoryServices({ backend })}
        actions={noActions}
      />,
    );
    using _clipboard = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(clipboard);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.container.querySelector("iframe")).toBeNull();
    expect(mocks.rendered).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT,
        src: url,
        widget: expect.objectContaining({ kind: "plugin-panel" }),
      }),
    );
    const widget = mocks.rendered.mock.lastCall?.[0].widget;
    if (!widget) throw new Error("Expected a hosted plugin panel.");
    const post = vi.fn();
    const connection = widget.connect(post);
    await act(() => {
      connection.receive(
        { jsonrpc: "2.0", id: 1, method: "t3/initialize", params: { apiVersion: "1.0" } },
        false,
      );
      connection.receive(
        { jsonrpc: "2.0", id: 2, method: "t3/backend.subscribe", params: { topic: "events" } },
        false,
      );
      connection.receive(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "t3/clipboard.write",
          params: { text: "blocked" },
          activated: true,
        },
        false,
      );
    });
    expect(backend).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENVIRONMENT, pluginId: PLUGIN, version: "1" }),
    );
    expect(subscribed).toHaveBeenCalledExactlyOnceWith("events", {}, expect.any(Function));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({
          pluginId: PLUGIN,
          panelId: "main",
          hostContext: expect.objectContaining({ theme: "dark" }),
        }),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        error: expect.objectContaining({ message: expect.stringContaining("Copying was blocked") }),
      }),
    );
    expect(clipboard).not.toHaveBeenCalled();
    connection.dispose();
    connection.receive(
      { jsonrpc: "2.0", id: 4, method: "t3/backend.subscribe", params: { topic: "events" } },
      true,
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribed).toHaveBeenCalledOnce();
  });

  it("withdraws a pending backend mutation when the widget closes during reconnect", async () => {
    setup();
    mocks.urls.set("1", hostedUrl);
    const installedManifest = manifest("1.0.0");
    const backend = installedManifest.backend!;
    mocks.install = environmentInstall("1", {
      manifest: {
        ...installedManifest,
        backend: {
          ...backend,
          operations: [
            {
              name: "write",
              title: "Write",
              description: "Write plugin state",
              inputSchema: {},
              mutates: true,
              agent: false,
            },
          ],
        },
      },
    });
    const reconnect = Promise.withResolvers<void>();
    mocks.waitForConnection.mockReset().mockReturnValue(reconnect.promise);
    mocks.mutate.mockClear();
    await using screen = await render(
      <PluginPanelSurface panelKey={PANEL_KEY} chatTarget={null} />,
    );
    expect(screen.container.querySelector("iframe")).toBeNull();
    const widget = mocks.rendered.mock.lastCall?.[0].widget;
    if (!widget) throw new Error("Expected a hosted plugin panel.");
    const post = vi.fn();
    const connection = widget.connect(post);
    connection.receive(
      { jsonrpc: "2.0", id: 1, method: "t3/initialize", params: { apiVersion: "1.0" } },
      false,
    );
    const request = {
      jsonrpc: "2.0",
      id: 2,
      method: "t3/backend.call",
      params: { operation: "write", input: {} },
    };
    connection.receive(request, false);
    expect(mocks.waitForConnection).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled();
    connection.dispose();
    await act(async () => reconnect.resolve());
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));

    const reopened = widget.connect(post);
    try {
      reopened.receive(
        { jsonrpc: "2.0", id: 3, method: "t3/initialize", params: { apiVersion: "1.0" } },
        false,
      );
      await act(() => reopened.receive({ ...request, id: 4 }, false));
      expect(mocks.mutate).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 4, result: null });
    } finally {
      reopened.dispose();
    }
  });

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
            saveFile: async () => "saved",
            writeClipboard: async () => {},
            pickFile: async () => null,
            chatTargets: () => ({ threads: [], projects: [] }),
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

  it("refuses a hovered panel that focuses itself right after a click elsewhere in T3", async () => {
    const writeClipboard = vi.fn(async (_text: string) => {});
    await using screen = await render(
      <div style={{ width: 400, height: 300 }}>
        <button type="button">Open panel</button>
        <PluginPanelFrame
          title="Echo"
          document={{
            kind: "srcdoc",
            html: pluginPanelTestHtml(
              `let tried = false;
              addEventListener("pointermove", async () => {
                if (tried) return;
                tried = true;
                window.focus();
                probe("focused", document.hasFocus());
                probe("copied", await call("t3/clipboard.write", { text: "hi" }));
              });`,
              `<div style="height:200px"></div>`,
            ),
          }}
          bridge={{
            manifest: { ...manifest("1.0.0"), capabilities: ["clipboard.write"] },
            panelId: "main",
            pluginVersion: "1",
            state: { get: async () => null, set: async () => {} },
            openSurface: async () => {},
            attach: async () => "inserted",
            saveFile: async () => "saved",
            writeClipboard,
            pickFile: async () => null,
            chatTargets: () => ({ threads: [], projects: [] }),
          }}
          destination={{ kind: "client" }}
          chatTarget={null}
        />
      </div>,
    );
    using probes = collectPanelProbes(screen.container);
    await probes.probe("initialized");

    await page.getByRole("button", { name: "Open panel" }).click();
    await page.getByTitle("Echo").hover();
    // Without this the test would pass on a browser that blocks the panel's self-focus.
    expect(await probes.probe("focused")).toBe(true);
    expect(document.activeElement).toBe(screen.container.querySelector("iframe"));
    expect(await probes.probe("copied")).toMatchObject({
      error: {
        message: "Copying was blocked. Wait a few seconds, then click or tap in the panel again.",
      },
    });
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("copies when the user clicks inside the panel", async () => {
    const writeClipboard = vi.fn(async (_text: string) => {});
    await using screen = await render(
      <div style={{ width: 400, height: 300 }}>
        <PluginPanelFrame
          title="Echo"
          document={{
            kind: "srcdoc",
            html: pluginPanelTestHtml(
              `addEventListener("click", async () => {
                probe("copied", await call("t3/clipboard.write", { text: "hi" }));
              }, { once: true });`,
              `<div style="height:200px"></div>`,
            ),
          }}
          bridge={{
            manifest: { ...manifest("1.0.0"), capabilities: ["clipboard.write"] },
            panelId: "main",
            pluginVersion: "1",
            state: { get: async () => null, set: async () => {} },
            openSurface: async () => {},
            attach: async () => "inserted",
            saveFile: async () => "saved",
            writeClipboard,
            pickFile: async () => null,
            chatTargets: () => ({ threads: [], projects: [] }),
          }}
          destination={{ kind: "client" }}
          chatTarget={null}
        />
      </div>,
    );
    using probes = collectPanelProbes(screen.container);
    await probes.probe("initialized");
    // Far past any page-input timestamp earlier tests' clicks on the T3 page recorded.
    using _now = vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);

    await page.getByTitle("Echo").click();
    expect(await probes.probe("copied")).toMatchObject({ result: {} });
    expect(writeClipboard).toHaveBeenCalledWith("hi");
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
