import type { DocumentPickerResult } from "expo-document-picker";
import { RegistryContext } from "@effect/atom-react";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { PreviewEvent, PreviewListResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { BrowserPreviewRouteScreen } from "./BrowserPreviewRouteScreen";
import type { PreviewStreamMessage } from "./preview-stream-document";

type AppStateStatus = "active" | "inactive" | "background";
const harness = vi.hoisted(() => {
  const listeners = new Set<(status: AppStateStatus) => void>();
  const appState = {
    currentState: "active" as AppStateStatus,
    addEventListener: (_event: string, callback: (status: AppStateStatus) => void) => {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
  };
  const emitAppState = (status: AppStateStatus) => {
    for (const listener of listeners) listener(status);
  };
  return {
    platform: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios",
    appState,
    emitAppState,
    setAppState(status: AppStateStatus) {
      appState.currentState = status;
      emitAppState(status);
    },
    focused: true,
    close: vi.fn(),
    pick: vi.fn<() => Promise<DocumentPickerResult>>(),
    upload: vi.fn<(url: string, files: readonly object[], signal: AbortSignal) => Promise<void>>(),
    alert: vi.fn(),
    nextMessages: null as PreviewStreamMessage[] | null,
  };
});

vi.mock("react-native", () => ({
  AppState: harness.appState,
  Platform: { OS: harness.platform },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => harness.focused,
  useNavigation: () => ({ goBack: harness.close }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/useBarInset", () => ({ useContentTopInset: () => 0 }));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: ({
    onClose,
    menus,
  }: {
    onClose: () => void;
    menus?: readonly { items: readonly { id: string; onPress: () => void }[] }[];
  }) => (
    <>
      <button onClick={onClose}>Close browser</button>
      {menus?.flatMap(({ items }) =>
        items.map(({ id, onPress }) => (
          <button key={id} onClick={onPress}>
            {id}
          </button>
        )),
      )}
    </>
  ),
}));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("../../components/PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: vi.fn() }));
vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { empty } = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(empty) };
});
vi.mock("../../state/session", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    usePreparedConnection: () => useAtomValue(preparedAtom),
    environmentSession: { preparedConnectionValueAtom: () => preparedAtom },
  };
});
vi.mock("@t3tools/client-runtime/state/deviceHubAccess", async () => {
  const { succeed } = await import("effect/Effect");
  return {
    resolveDeviceHubAccess: ({ prepared }: { prepared: typeof initialPrepared }) =>
      succeed(prepared.access),
  };
});
vi.mock("@t3tools/client-runtime/state/preview", () => {
  return {
    createPreviewEnvironmentAtoms: () => ({
      list: () => tabsAtom,
      events: () => eventsAtom,
    }),
  };
});
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: { "--color-sheet-solid": "#111" } }),
}));
vi.mock("./BrowserTabMenu", () => ({ BrowserTabMenu: () => null }));
vi.mock("expo-clipboard", () => ({}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: harness.pick }));
vi.mock("./verifiedFileChooser", () => ({ sendVerifiedChooserFiles: harness.upload }));
vi.mock("../../lib/verifiedViewerBridge", async () => {
  const { viewerEndpoint } = await import("../../lib/verifiedViewerScope");
  return {
    viewerUsesVerifiedRoute: () => true,
    verifiedViewerEndpoint: viewerEndpoint,
    createVerifiedViewerBridge: () => ({ stop() {}, onMessage: () => false }),
  };
});

const initialPrepared = {
  httpBaseUrl: "https://preview.example",
  access: {
    httpBase: "https://preview.example/stream",
    wsBase: "wss://preview.example/stream",
    query: { wsTicket: "original" },
    credentials: false,
  } satisfies DeviceHubAccess,
};
const preparedAtom = Atom.make(Option.some(initialPrepared));
const tabsAtom = Atom.make(
  AsyncResult.success<PreviewListResult>({
    serverEpoch: "epoch",
    revision: 0,
    sessions: ["tab", "other-tab"].map((tabId) => ({
      tabId,
      threadId: "thread",
      runtime: "server",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-11-19",
    })),
  }),
);
const eventsAtom = Atom.make(AsyncResult.initial<PreviewEvent>());
const uploadUrl = "https://preview.example/stream/upload?chooser=original&wsTicket=original";
const reissuedUrl = "https://preview.example/stream/upload?chooser=reissued&wsTicket=original";
const chooser = { uploadUrl, multiple: false, credentials: false, accept: "", requestId: "picker" };
const controller = {
  type: "control",
  controller: "you",
  canOperate: true,
  generation: 1,
  dialog: null,
} as const;
const asset = { name: "fixture.txt", uri: "file:///fixture.txt", size: 35, lastModified: 0 };

vi.mock("../../native/secureWebView", () => ({
  SecureWebView: ({
    onMessage,
  }: {
    onMessage: (event: { nativeEvent: { data: string } }) => void;
  }) => (
    <button
      onClick={() => {
        const messages: PreviewStreamMessage[] = harness.nextMessages ?? [
          { type: "status", status: "streaming" },
          controller,
          { type: "fileChooser", chooser },
        ];
        harness.nextMessages = null;
        for (const message of messages) {
          onMessage({ nativeEvent: { data: JSON.stringify(message) } });
        }
      }}
    >
      WebView
    </button>
  ),
}));

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.focused = true;
  harness.appState.currentState = "active";
  harness.pick.mockReset();
  harness.upload.mockReset().mockResolvedValue(undefined);
  harness.alert.mockClear();
  harness.nextMessages = null;
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <BrowserPreviewRouteScreen
            route={{
              params: { environmentId: "env", threadId: "thread", tabId: "tab" },
            }}
          />
        </RegistryContext.Provider>,
      ),
    );
  await render();
  harness.close.mockImplementation(() => root.render(null));
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  return {
    render,
    setPrepared(prepared: Option.Option<typeof initialPrepared>) {
      return act(async () => registry.set(preparedAtom, prepared));
    },
    button,
    emit(...messages: PreviewStreamMessage[]) {
      const target = button("WebView");
      if (!target) throw new Error("Missing WebView");
      harness.nextMessages = messages;
      act(() => target.click());
    },
    click(label: string) {
      const target = button(label);
      if (!target) throw new Error(`Missing button ${label}`);
      act(() => target.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    },
  };
}

async function openPicker(screen: Awaited<ReturnType<typeof mount>>, nativeBackground: boolean) {
  const picker = Promise.withResolvers<DocumentPickerResult>();
  const launched = Promise.withResolvers<void>();
  harness.pick.mockImplementation(() => {
    if (nativeBackground) harness.setAppState("background");
    launched.resolve();
    return picker.promise;
  });
  screen.click("WebView");
  await act(async () => {
    screen.click("Choose file");
    await launched.promise;
  });
  return picker;
}

if (harness.platform === "android") {
  it.each(["select", "cancel", "replaced"] as const)(
    "after Android closes the viewer socket, waits for a matching re-offer before %s",
    async (outcome) => {
      using screen = await mount();
      const picker = await openPicker(screen, true);
      screen.emit(
        { type: "fileChooser", chooser: null },
        { type: "status", status: "connecting" },
        { type: "unauthorized" },
      );
      act(() => harness.setAppState("active"));
      await act(async () =>
        picker.resolve(
          outcome === "cancel"
            ? { canceled: true, assets: null }
            : { canceled: false, assets: [asset] },
        ),
      );
      expect(harness.upload).not.toHaveBeenCalled();
      await act(async () =>
        screen.emit(
          { ...controller, generation: 2 },
          {
            type: "fileChooser",
            chooser: {
              ...chooser,
              uploadUrl: reissuedUrl,
              requestId: outcome === "replaced" ? "different-picker" : chooser.requestId,
            },
          },
        ),
      );
      if (outcome === "replaced") {
        expect(harness.upload).not.toHaveBeenCalled();
        expect(harness.alert).toHaveBeenCalledOnce();
        expect(screen.button("Choose file")).toBeDefined();
      } else {
        expect(harness.upload).toHaveBeenCalledExactlyOnceWith(
          reissuedUrl,
          outcome === "cancel" ? [] : [asset],
          expect.any(AbortSignal),
        );
      }
    },
  );

  it.each(["select", "cancel", "error"] as const)(
    "keeps the Android stream for the system picker and releases it after %s while backgrounded",
    async (outcome) => {
      using screen = await mount();
      const original = screen.button("WebView");
      expect(original).toBeDefined();
      const picker = await openPicker(screen, true);
      expect(screen.button("WebView")).toBe(original);

      await act(async () => {
        if (outcome === "error") picker.reject(new Error("Picker failed"));
        else
          picker.resolve(
            outcome === "select"
              ? { canceled: false, assets: [asset] }
              : { canceled: true, assets: null },
          );
      });
      if (outcome === "error") {
        expect(harness.alert).toHaveBeenCalledOnce();
        expect(harness.upload).not.toHaveBeenCalled();
      } else {
        expect(harness.upload).toHaveBeenCalledExactlyOnceWith(
          uploadUrl,
          outcome === "select" ? [asset] : [],
          expect.any(AbortSignal),
        );
      }
      expect(screen.button("WebView")).toBeUndefined();
    },
  );

  it.each([
    ["stable", "select"],
    ["prepared gap", "select"],
    ["renewed access", "select"],
    ["prepared gap", "cancel"],
    ["renewed access", "refused"],
  ] as const)(
    "submits one Android chooser response after resuming with %s and outcome %s",
    async (accessChange, outcome) => {
      using screen = await mount();
      const original = screen.button("WebView");
      const picker = await openPicker(screen, true);
      act(() => harness.emitAppState("active"));
      expect(screen.button("WebView")).toBe(original);
      if (accessChange === "prepared gap") await screen.setPrepared(Option.none());
      if (accessChange === "renewed access") {
        await screen.setPrepared(
          Option.some({
            ...initialPrepared,
            access: { ...initialPrepared.access, query: { wsTicket: "renewed" } },
          }),
        );
      }
      const duringPicker = screen.button("WebView");
      const upload = Promise.withResolvers<void>();
      harness.upload.mockReturnValue(upload.promise);
      await act(async () =>
        picker.resolve(
          outcome === "cancel"
            ? { canceled: true, assets: null }
            : { canceled: false, assets: [asset] },
        ),
      );
      expect(harness.upload).toHaveBeenCalledExactlyOnceWith(
        uploadUrl,
        outcome === "cancel" ? [] : [asset],
        expect.any(AbortSignal),
      );
      expect(duringPicker).toBe(original);
      expect(screen.button("WebView")).toBe(original);
      act(() => harness.setAppState("active"));
      expect(screen.button("WebView")).toBe(original);
      await act(async () => {
        if (outcome === "refused")
          upload.reject(new Error("The page's file picker is no longer open."));
        else upload.resolve();
      });
      expect(harness.upload).toHaveBeenCalledOnce();
      if (outcome === "refused") {
        expect(harness.alert).toHaveBeenCalledExactlyOnceWith(
          "Could not send the files to the page",
          "The page's file picker is no longer open.",
        );
      } else {
        expect(harness.alert).not.toHaveBeenCalled();
      }
      if (accessChange === "prepared gap") expect(screen.button("WebView")).toBeUndefined();
      else if (accessChange === "renewed access")
        expect(screen.button("WebView")).not.toBe(original);
      else expect(screen.button("WebView")).toBe(original);
    },
  );

  it.each(["blur", "switch tabs", "close"] as const)(
    "cancels the Android chooser when the user leaves via %s",
    async (reason) => {
      using screen = await mount();
      const original = screen.button("WebView");
      const picker = await openPicker(screen, true);
      expect(screen.button("WebView")).toBe(original);
      act(() => harness.emitAppState("active"));
      if (reason === "blur") {
        harness.focused = false;
        await screen.render();
      } else {
        screen.click(reason === "switch tabs" ? "other-tab" : "Close browser");
      }
      expect(screen.button("WebView")).not.toBe(original);
      await act(async () => picker.resolve({ canceled: false, assets: [asset] }));
      expect(harness.upload).not.toHaveBeenCalled();
    },
  );

  it("releases the Android stream on background after the chooser response settles", async () => {
    using screen = await mount();
    const upload = Promise.withResolvers<void>();
    harness.upload.mockReturnValue(upload.promise);
    const original = screen.button("WebView");
    const picker = await openPicker(screen, true);
    expect(screen.button("WebView")).toBe(original);

    act(() => harness.setAppState("active"));
    await act(async () => picker.resolve({ canceled: false, assets: [asset] }));
    expect(screen.button("WebView")).toBe(original);
    const signal = harness.upload.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    await act(async () => upload.resolve());

    act(() => harness.setAppState("background"));
    expect(screen.button("WebView")).toBeUndefined();
    expect(signal?.aborted).toBe(false);
  });
} else {
  it("submits the iOS picker result without remounting the stream", async () => {
    using screen = await mount();
    const original = screen.button("WebView");
    const picker = await openPicker(screen, false);
    act(() => harness.setAppState("inactive"));
    await act(async () => picker.resolve({ canceled: false, assets: [asset] }));
    act(() => harness.setAppState("active"));

    expect(screen.button("WebView")).toBe(original);
    expect(harness.upload).toHaveBeenCalledExactlyOnceWith(
      uploadUrl,
      [asset],
      expect.any(AbortSignal),
    );
  });

  it("retains the iOS stream for an inactive picker and releases it on background", async () => {
    using screen = await mount();
    const original = screen.button("WebView");
    const picker = await openPicker(screen, false);
    act(() => harness.setAppState("inactive"));
    expect(screen.button("WebView")).toBe(original);
    act(() => harness.setAppState("background"));
    expect(screen.button("WebView")).toBeUndefined();

    await act(async () => picker.resolve({ canceled: false, assets: [asset] }));
    expect(harness.upload).not.toHaveBeenCalled();
  });
}
