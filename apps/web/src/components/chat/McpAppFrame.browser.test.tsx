import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { HostedAssetDocument } from "~/components/files/HostedAssetDocument";
import { setAppearanceMode } from "~/hooks/useTheme";
import { act, fakeTimers, render } from "../../../test/render";

// Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout.
const APP_HTML = `<script>
let answered = false;
addEventListener("message", (event) => {
  const message = event.data;
  if (message === "close") {
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
  } else if (message?.method === "ui/resource-teardown" && !answered) {
    answered = true;
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  }
});
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
</script>`;

const hostedUrl = "https://widget-relay.example/api/assets/signed.grant/app.html";
const desktopUrl = "https://desktop-relay.example/api/assets/signed.grant/app.html";
const mocks = vi.hoisted(() => ({
  assetUrl: undefined as string | undefined,
  rendered: vi.fn<(props: ComponentProps<typeof HostedAssetDocument>) => void>(),
  updateModelContext: vi.fn(),
}));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: mocks.assetUrl ?? `data:text/html,${encodeURIComponent(APP_HTML)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

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

vi.mock(import("~/state/mcpApps"), async (importOriginal) => {
  const { mcpAppEnvironment } = await importOriginal();
  return {
    mcpAppEnvironment: {
      ...mcpAppEnvironment,
      updateModelContext: {
        ...mcpAppEnvironment.updateModelContext,
        run: async (_registry, input) => {
          mocks.updateModelContext(input);
          return AsyncResult.success(undefined);
        },
      },
    },
  };
});

import { McpAppFrame } from "./McpAppFrame";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const itemId = TurnItemId.make("item");
const app = {
  attachmentId: "attachment",
  server: "Demo",
  tool: "show",
  resourceUri: "ui://demo/app",
};

const nextInitializedFrom = () =>
  new Promise<MessageEventSource>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.source === null || event.data?.method !== "ui/notifications/initialized") return;
      window.removeEventListener("message", listen);
      resolve(event.source);
    };
    window.addEventListener("message", listen);
  });

describe("McpAppFrame", () => {
  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    setAppearanceMode("dark");
    mocks.assetUrl = undefined;
    const firstInitialized = nextInitializedFrom();
    await using screen = await render(
      <McpAppFrame
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
        conversationThreadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        revision="1"
        app={{
          attachmentId: "attachment",
          server: "Demo",
          tool: "show",
          resourceUri: "ui://demo/app",
        }}
        onSendMessage={undefined}
      />,
    );
    const firstApp = await firstInitialized;
    using _timers = fakeTimers();

    (firstApp as Window).postMessage("close", "*");
    await userEvent.click(screen.getByRole("button", { name: "Show app" }));
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Show app" }).query()).toBeNull();
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();
  });

  it.each([
    { kind: "hosted web", url: hostedUrl },
    { kind: "enrolled Electron", url: desktopUrl },
  ])("uses the $kind widget connection for scoped host calls", async ({ url }) => {
    setAppearanceMode("dark");
    mocks.assetUrl = url;
    if (url === desktopUrl) {
      vi.stubGlobal("desktopBridge", { relayTransport: {} });
    }
    using _desktop = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    mocks.rendered.mockClear();
    mocks.updateModelContext.mockClear();
    const conversationThreadId = ThreadId.make("conversation");
    await using screen = await render(
      <McpAppFrame
        environmentId={environmentId}
        threadId={threadId}
        conversationThreadId={conversationThreadId}
        itemId={itemId}
        revision="1"
        app={app}
        onSendMessage={undefined}
      />,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.container.querySelector("iframe")).toBeNull();
    expect(mocks.rendered).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId,
        src: url,
        widget: expect.objectContaining({ kind: "mcp-app" }),
      }),
    );
    const widget = mocks.rendered.mock.lastCall?.[0].widget;
    if (!widget) throw new Error("Expected a hosted MCP app.");
    const post = vi.fn();
    using openLink = vi.spyOn(window, "open").mockReturnValue(null);
    const connection = widget.connect(post);
    await act(() => {
      connection.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize" }, false);
      connection.receive(
        { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 416 } },
        false,
      );
      connection.receive(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "ui/update-model-context",
          params: { structuredContent: { example: 1 }, threadId: "other-thread" },
        },
        false,
      );
      connection.receive(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "ui/open-link",
          params: { url: "https://widget-relay.example" },
          activated: true,
        },
        false,
      );
    });
    expect(post).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      result: expect.objectContaining({ hostContext: expect.objectContaining({ theme: "dark" }) }),
    });
    expect(screen.container.querySelector('[style="height: 416px;"]')).not.toBeNull();
    expect(mocks.updateModelContext).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId, itemId, conversationThreadId, structuredContent: { example: 1 } },
    });
    expect(post).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 2, result: {} });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        error: expect.objectContaining({ message: "Links open only from a click in the app." }),
      }),
    );
    expect(openLink).not.toHaveBeenCalled();
    connection.dispose();
    await act(() => {
      connection.receive({ jsonrpc: "2.0", id: 4, method: "ui/update-model-context" }, true);
    });
    expect(mocks.updateModelContext).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(3);
  });
});
