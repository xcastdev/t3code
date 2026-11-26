import { act, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { SecureWebView } from "./secureWebView";

const { nativeModule } = vi.hoisted(() => ({ nativeModule: vi.fn() }));
vi.mock("expo", () => ({ requireOptionalNativeModule: nativeModule }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  findNodeHandle: (view: HTMLElement | null) => (view ? 7 : null),
  View: ({ children, ref }: { children: ReactNode; ref: Ref<HTMLDivElement> }) => (
    <div ref={ref}>{children}</div>
  ),
}));
vi.mock("react-native-webview", () => ({
  WebView: ({
    source,
    onLoadEnd,
  }: {
    source: { html?: string; uri?: string };
    onLoadEnd: (event: { nativeEvent: { url?: string } }) => void;
  }) => {
    if (source.uri === "about:blank") throw new Error("about:blank is not a file URL");
    return (
      <button onClick={() => onLoadEnd({ nativeEvent: { url: source.uri ?? "about:blank" } })}>
        {source.html ?? source.uri}
      </button>
    );
  },
}));

function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    render: (child: ReactNode) => act(() => root.render(child)),
    webView: () => {
      const view = container.querySelector("button");
      if (view === null) throw new Error("Missing WebView.");
      return view;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
      nativeModule.mockReset();
    },
  };
}

it("loads local content only after its own WebView has been fenced", async () => {
  const firstFence = Promise.withResolvers<boolean>();
  const secondFence = Promise.withResolvers<boolean>();
  const blockWebViewNetworkLoads = vi
    .fn()
    .mockReturnValueOnce(firstFence.promise)
    .mockReturnValueOnce(secondFence.promise);
  nativeModule.mockReturnValue({ blockWebViewNetworkLoads });
  using screen = mount();
  const onLoadEnd = vi.fn();

  screen.render(
    <SecureWebView key="one" verified source={{ html: "first" }} onLoadEnd={onLoadEnd} />,
  );
  expect(screen.webView().textContent).toBe("");
  act(() => screen.webView().click());
  expect(blockWebViewNetworkLoads).toHaveBeenCalledExactlyOnceWith(7);
  expect(onLoadEnd).not.toHaveBeenCalled();

  screen.render(
    <SecureWebView key="two" verified source={{ html: "second" }} onLoadEnd={onLoadEnd} />,
  );
  const replacement = screen.webView();
  act(() => replacement.click());
  await act(async () => firstFence.resolve(true));
  expect(replacement.textContent).toBe("");

  await act(async () => secondFence.resolve(true));
  expect(screen.webView()).toBe(replacement);
  expect(replacement.textContent).toBe("second");
  act(() => replacement.click());
  expect(onLoadEnd).toHaveBeenCalledOnce();
});

it("keeps verified content off an older native client", async () => {
  nativeModule.mockReturnValue({});
  using screen = mount();
  const onFenceError = vi.fn();
  screen.render(
    <SecureWebView verified source={{ html: "private" }} onFenceError={onFenceError} />,
  );

  await act(async () => screen.webView().click());
  expect(screen.webView().textContent).toBe("");
  expect(onFenceError).toHaveBeenCalledOnce();
});
