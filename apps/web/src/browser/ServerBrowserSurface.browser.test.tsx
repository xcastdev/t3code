import { EnvironmentId, ThreadId, type DesktopRelayBridge } from "@t3tools/contracts";
import type {
  PreviewStreamControl,
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { HostedAssetDocument } from "~/components/files/HostedAssetDocument";
import { setAppearanceMode } from "~/hooks/useTheme";
import { act, render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient:
    vi.fn<
      (
        target: unknown,
        handlers: PreviewStreamEvents,
        openSocket: (url: string) => WebSocket,
      ) => unknown
    >(),
  sent: [] as PreviewStreamInput[],
  access: {
    url: "ws://preview.test",
    token: "test",
    environmentId: undefined as EnvironmentId | undefined,
  },
  painted: null as (() => void) | null,
  assetUrlState: vi.fn<() => import("~/assets/assetUrls").AssetUrlState>(),
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: mocks.assetUrlState,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: mocks.createClient as never,
  createPreviewFramePainter: (_canvas, onPainted) => {
    mocks.painted = onPainted ?? null;
    return { paint: () => undefined, stop: () => undefined };
  },
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

function setup() {
  mocks.sent.length = 0;
  mocks.painted = null;
  mocks.access.environmentId = undefined;
  mocks.assetUrlState.mockReset();
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: (input: PreviewStreamInput) => mocks.sent.push(input),
    stop: () => undefined,
  }));
}

it("keeps the paired workspace document stream open across grant renewals until its revision changes", async () => {
  setup();
  setAppearanceMode("dark");
  const environmentId = EnvironmentId.make("workspace-document");
  const origin = "https://document-relay.test";
  const threadRef = { environmentId, threadId: ThreadId.make("workspace-thread") };
  const { WorkspaceBrowserPreview } = await import("~/components/files/FilePreviewPanel");
  mocks.access.environmentId = environmentId;
  using _desktop = stubGlobal("desktopBridge", {
    getLocalEnvironmentEnabled: () => false,
    getClientSettings: async () => null,
    getVerifiedRouteBinding: async () => ({
      environmentId,
      httpsOrigin: origin,
      transportRole: "relay",
    }),
    relayTransport: { origins: [origin] },
  });
  const preview = (grant: string, revision: string) => {
    mocks.assetUrlState.mockReturnValue({
      _tag: "Success",
      url: `${origin}/api/assets/${grant}/index.html`,
      expiresAt: 0,
    });
    return (
      <div style={{ width: 400, height: 300, display: "flex" }}>
        <WorkspaceBrowserPreview
          environmentId={environmentId}
          threadRef={threadRef}
          draft
          absolutePath="/repo/index.html"
          workspaceRoot="/repo"
          title="Workspace document"
          workspaceMutationId={revision}
        />
      </div>
    );
  };
  await using screen = await render(preview("original.grant", "one"));
  const canvas = () => screen.container.querySelector("canvas");
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const initialCanvas = canvas();
  expect(initialCanvas).not.toBeNull();

  await screen.rerender(preview("renewed.grant", "one"));
  expect(canvas()).toBe(initialCanvas);

  await screen.rerender(preview("updated.grant", "two"));
  await vi.waitFor(() =>
    expect(mocks.createClient.mock.lastCall?.[0]).toMatchObject({
      asset: { verifiedAssetUrl: `${origin}/api/assets/updated.grant/index.html` },
    }),
  );
  expect(canvas()).not.toBe(initialCanvas);
});

async function renderSurface(controller: PreviewStreamControl["controller"]) {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px; display: flex;";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-copy")}
        threadId="thread-copy"
        tabId="tab-copy"
        visible
        followSize={false}
        className="flex-1"
      />,
      { container },
    ),
  );
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const handlers = mocks.createClient.mock.calls.at(-1)![1];
  await act(() =>
    handlers.onControl?.({ canOperate: true, controller, generation: 1, dialog: null }),
  );
  mocks.sent.length = 0;
  const input = container.querySelector("textarea")!;
  const canvas = container.querySelector("canvas")!;
  stack.move();
  return { screen, input, canvas };
}

const keys = () => mocks.sent.filter((input) => input.type === "key");

describe("enrolled Electron widget stream", () => {
  const environmentId = EnvironmentId.make("widget-destination");
  const origin = "https://widget-relay.test";
  const src = `${origin}/api/assets/signed.widget/app.html`;
  const endpoint = "wss://widget-relay.test/api/preview-stream/ws?asset=1&wsTicket=fixture";

  it.each([
    { bindingEnvironment: environmentId, admitted: true },
    { bindingEnvironment: EnvironmentId.make("other-destination"), admitted: false },
  ])(
    "opens the main-owned socket only for the matching binding ($admitted)",
    async ({ bindingEnvironment, admitted }) => {
      setup();
      setAppearanceMode("dark");
      mocks.access.environmentId = environmentId;
      const open = vi.fn<DesktopRelayBridge["open"]>(() => () => {});
      const readBinding = vi.fn(async () => ({
        environmentId: bindingEnvironment,
        httpsOrigin: origin,
        transportRole: "relay",
      }));
      vi.stubGlobal("desktopBridge", {
        getVerifiedRouteBinding: readBinding,
        relayTransport: { origins: [origin], open },
      });
      using _desktop = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
      await using screen = await render(
        <div style={{ width: 400, height: 300, display: "flex" }}>
          <HostedAssetDocument
            environmentId={environmentId}
            src={src}
            title="Widget"
            widget={{ kind: "mcp-app", connect: () => ({ receive: vi.fn(), dispose: vi.fn() }) }}
          />
        </div>,
      );
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(readBinding).toHaveBeenCalledWith(origin);
      expect(screen.container.querySelector("iframe")).toBeNull();
      if (!admitted) {
        await expect.element(screen.getByText("Unable to load file preview.")).toBeVisible();
        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        return;
      }

      await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
      const [target, , openSocket] = mocks.createClient.mock.lastCall!;
      expect(target).toMatchObject({
        asset: {
          verifiedAssetUrl: `${src}?t3-color-scheme=dark`,
          appearance: "dark",
          widget: "mcp-app",
        },
      });
      expect(() => openSocket(endpoint.replace("/ws?", "/other?"))).toThrow();
      expect(() => openSocket(endpoint.replace("wss:", "ws:"))).toThrow();
      expect(open).not.toHaveBeenCalled();
      const socket = openSocket(endpoint);
      try {
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(open).toHaveBeenCalledWith(
          { kind: "socket", url: endpoint, protocols: [] },
          expect.any(Function),
        );
      } finally {
        socket.close();
      }
    },
  );
});

describe("ServerBrowserSurface clipboard commands", () => {
  it("sends a native Copy or Cut menu command to the page once", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    // Chromium runs a script Copy or Cut only during a user gesture, as a menu click is.
    await userEvent.click(canvas);
    input.focus();
    mocks.sent.length = 0;

    // Like Electron's webContents.copy(): the browser's Copy command, with no key.
    expect(document.execCommand("copy")).toBe(true);
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
    ]);

    mocks.sent.length = 0;
    expect(document.execCommand("cut")).toBe(true);
    expect(input.value).toBe("\u200b");
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
      { type: "key", action: "up", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
    ]);
  });

  it("sends a keyboard Copy or Cut once and leaves menu Copy working after any shortcut", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    await userEvent.click(canvas);
    input.focus();
    const prevented: boolean[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (/^[cx]$/i.test(event.key)) prevented.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", onKeyDown);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("keydown", onKeyDown) };

    // An unprevented copy or cut key also makes the browser fire copy or cut: here Chromium's
    // Ctrl key binding, on macOS Electron's menu after the Meta keyup.
    for (const [shortcut, cancels] of [
      ["{Control>}x{/Control}", true],
      ["{Control>}c{/Control}", true],
      ["{Meta>}{x>}{/Meta}{/x}", true],
      ["{Control>}{Shift>}c{/Shift}{/Control}", false],
      ["{Control>}{Alt>}x{/Alt}{/Control}", false],
    ] as const) {
      mocks.sent.length = 0;
      prevented.length = 0;
      await userEvent.keyboard(shortcut);
      expect(prevented, shortcut).toEqual([cancels]);
      expect(keys().filter((key) => /^[cx]$/i.test(key.key)).length, shortcut).toBe(2);
      expect(input.value).toBe("\u200b");

      mocks.sent.length = 0;
      expect(document.execCommand("copy")).toBe(true);
      expect(keys(), shortcut).toEqual([
        { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
        { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      ]);
    }
  });

  it("sends nothing when another viewer controls the page", async () => {
    setup();
    const { screen, input } = await renderSurface("another-viewer");
    await using _screen = screen;

    expect(
      input.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(
      input.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(mocks.sent).toEqual([]);
  });
});

const mouseUp = (canvas: HTMLCanvasElement, button: number) => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("ServerBrowserSurface history", () => {
  it("routes mouse thumb buttons to the preview's history instead of the app", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 3).defaultPrevented).toBe(true);
    expect(mouseUp(canvas, 4).defaultPrevented).toBe(true);
    expect(mocks.sent).toEqual([
      { type: "history", delta: -1 },
      { type: "history", delta: 1 },
    ]);
  });

  it("leaves other mouse buttons alone", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 0).defaultPrevented).toBe(false);
    expect(mocks.sent).toEqual([]);
  });

  it("does not forward thumb-button presses to the page", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;
    canvas.width = 400;
    canvas.height = 300;
    // Synthetic pointers have no active pointer id to capture.
    canvas.setPointerCapture = () => undefined;
    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    await act(() => {
      mocks.painted?.();
      handlers.onViewport({ width: 400, height: 300 });
    });
    const { left, top } = canvas.getBoundingClientRect();
    const press = (type: "pointerdown" | "pointerup", button: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          button,
          buttons: type === "pointerdown" ? 1 << button : 0,
          clientX: left + 10,
          clientY: top + 10,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    const mouseInputs = () => mocks.sent.filter((input) => input.type === "mouse");

    for (const button of [3, 4]) {
      press("pointerdown", button);
      press("pointerup", button);
    }
    expect(mouseInputs()).toEqual([]);

    press("pointerdown", 0);
    expect(mouseInputs()).not.toEqual([]);
  });
});
