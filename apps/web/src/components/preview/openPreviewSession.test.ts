import {
  DEFAULT_CLIENT_SETTINGS,
  type PreviewSessionSnapshot,
  EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as browserDefaults from "~/browser/browserDefaults";
import {
  BrowserSettingsReadError,
  openFileInPreview,
  openUrlInPreview,
} from "~/browser/openFileInPreview";
import * as previewRuntime from "~/browser/previewRuntime";
import { verifiedRoutePolicy } from "~/connection/verifiedRoute";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  hostRightPanel,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "~/previewStateStore";

import { openPreviewSession } from "./openPreviewSession";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Loading",
    url: "https://t3.chat/",
    title: "",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-11T23:00:00.000Z",
};

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openPreviewSession", () => {
  it.each(["session", "link"] as const)(
    "does not open a %s with unread settings and uses the saved profile on retry",
    async (entryPoint) => {
      const failure = new Error("Settings read failed");
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(failure);
      const viewport = { _tag: "freeform", width: 1280, height: 720 } as const;
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultViewport: viewport,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const input = { openPreview, threadRef, url: "https://t3.chat/" };
      const open = entryPoint === "session" ? openPreviewSession : openUrlInPreview;

      const result = await open(input);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toBeInstanceOf(BrowserSettingsReadError);
        expect(Cause.squash(result.cause)).toMatchObject({ cause: failure });
      }
      expect(openPreview).not.toHaveBeenCalled();
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);

      await expect(open(input)).resolves.toMatchObject({ _tag: "Success" });
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: input.url,
          viewport,
          profileId: "work",
        },
      });
    },
  );

  it.each(["new tab", "link"] as const)(
    "opens a server tab from a %s with the default zoom and appearance",
    async (entryPoint) => {
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 0.8,
        browserDefaultAppearance: "dark",
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

      if (entryPoint === "link") {
        vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
        await openUrlInPreview({ openPreview, threadRef, url: "https://t3.chat/" });
      } else {
        await openPreviewSession({ openPreview, threadRef, runtime: "server" });
      }

      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({ runtime: "server", zoomFactor: 0.8, colorScheme: "dark" }),
      });
    },
  );
});

describe("openUrlInPreview from a link", () => {
  it.each(["link", "file"] as const)(
    "opens a side chat's %s in the parent's browser panel after the pane unmounts",
    async (entryPoint) => {
      const sideChatRef = { ...threadRef, threadId: "side-chat" as ScopedThreadRef["threadId"] };
      const unhost = hostRightPanel(sideChatRef, threadRef);
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockImplementation(async () => {
        unhost();
        return browserDefaults.getBrowserDefaults();
      });

      if (entryPoint === "link") {
        await openUrlInPreview({ openPreview, threadRef: sideChatRef, url: "https://t3.chat/" });
      } else {
        await openFileInPreview({
          threadRef: sideChatRef,
          filePath: "/repo/index.html",
          workspaceRoot: "/repo",
          httpBaseUrl: "http://localhost:3000",
          createAssetUrl: async () => {
            unhost();
            return AsyncResult.success({ relativeUrl: "/assets/index.html", expiresAt: 0 });
          },
          openPreview,
        });
      }

      expect(openPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            threadId: threadRef.threadId,
            url:
              entryPoint === "link"
                ? "https://t3.chat/"
                : "http://localhost:3000/assets/index.html",
          }),
        }),
      );
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
      expect(readThreadPreviewState(sideChatRef).sessions).toEqual({});
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.kind,
      ).toBe("preview");
    },
  );

  it.each(["matching", "wrong-environment", "wrong-origin", "relative", "redirect"] as const)(
    "keeps the learned file grant in the client with %s enrollment or response",
    async (scenario) => {
      const issuer = "https://enrolled.test";
      const issuedUrl = `${issuer}/api/assets/signature/report.pdf`;
      const readEnrollment = vi.spyOn(verifiedRoutePolicy, "readEnrollment").mockReturnValue(
        Effect.succeed({
          environmentId:
            scenario === "wrong-environment"
              ? EnvironmentId.make("other")
              : threadRef.environmentId,
          httpsOrigin: scenario === "wrong-origin" ? "https://other.test" : issuer,
        }),
      );
      vi.spyOn(verifiedRoutePolicy, "enforce").mockReturnValue(Effect.succeed(true));
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (scenario === "redirect") throw new TypeError("Redirect refused");
        return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
      });
      vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(false);
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const result = await openFileInPreview({
        threadRef,
        filePath: "/repo/report.pdf",
        workspaceRoot: "/repo",
        httpBaseUrl: "https://replacement.test",
        createAssetUrl: async () =>
          AsyncResult.success({
            relativeUrl: scenario === "relative" ? "/api/assets/signature/report.pdf" : issuedUrl,
            expiresAt: 0,
            learnedRoute: true as const,
          }),
        openPreview,
      });

      expect(openPreview).not.toHaveBeenCalled();
      if (scenario === "matching" || scenario === "redirect") {
        expect(readEnrollment).toHaveBeenCalledWith(issuer);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          issuedUrl,
          expect.objectContaining({ credentials: "omit", redirect: "error", cache: "no-store" }),
        );
      } else {
        expect(fetch).not.toHaveBeenCalled();
      }
      if (scenario === "matching") {
        expect(result._tag).toBe("Success");
        expect(
          selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
        ).toMatchObject({ kind: "file", localPreview: { type: "application/pdf", size: 8 } });
      } else {
        expect(result._tag).toBe("Failure");
        expect(
          selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
        ).toBeNull();
      }
    },
  );

  it.each(["accepted", "missing-pin", "wrong-origin", "wrong-environment"] as const)(
    "hands a learned file only to the pinned renderer when %s",
    async (scenario) => {
      const issuer = "https://enrolled.test";
      const issuedUrl = `${issuer}/api/assets/signature/report.pdf`;
      const readMedia = vi.fn(async () => null);
      vi.stubGlobal("window", {
        desktopBridge: {
          getVerifiedRouteBinding: async () => ({
            environmentId: scenario === "wrong-environment" ? "other" : threadRef.environmentId,
            httpsOrigin: scenario === "wrong-origin" ? "https://wrong.test" : issuer,
            ...(scenario === "missing-pin"
              ? {}
              : { leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
          }),
          readMedia,
        },
      });
      try {
        const fetch = vi.spyOn(globalThis, "fetch");
        vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
        const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
        const result = await openFileInPreview({
          threadRef,
          filePath: "/repo/report.pdf",
          workspaceRoot: "/repo",
          httpBaseUrl: "https://replacement.test",
          createAssetUrl: async () =>
            AsyncResult.success({ relativeUrl: issuedUrl, expiresAt: 0, learnedRoute: true }),
          openPreview,
        });
        expect(result._tag).toBe(scenario === "accepted" ? "Success" : "Failure");
        expect(fetch).not.toHaveBeenCalled();
        expect(openPreview).not.toHaveBeenCalled();
        expect(readMedia).not.toHaveBeenCalled();
        const surface = selectActiveRightPanelSurface(
          useRightPanelStore.getState().byThreadKey,
          threadRef,
        );
        if (scenario === "accepted") {
          expect(surface).toMatchObject({ kind: "file", localPreview: issuedUrl });
        } else {
          expect(surface).toBeNull();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    { name: "index.html", unmount: "never" },
    { name: "diagram.svg", unmount: "never" },
    { name: "index.html", unmount: "during issuance" },
    { name: "diagram.svg", unmount: "during verification" },
  ])(
    "opens an explicitly paired Electron relay file $name in the parent's guarded document view (unmount $unmount)",
    async ({ name, unmount }) => {
      const issuer = "https://relay.example.test";
      const relativeUrl = `/api/assets/signed.grant/${name}`;
      const sideChatRef = { ...threadRef, threadId: "side-chat" as ScopedThreadRef["threadId"] };
      const unhost = unmount === "never" ? undefined : hostRightPanel(sideChatRef, threadRef);
      vi.stubGlobal("window", {
        location: { href: "t3code://app/" },
        desktopBridge: {
          relayTransport: { origins: [issuer] },
          getVerifiedRouteBinding: async () => {
            if (unmount === "during verification") unhost?.();
            return {
              environmentId: threadRef.environmentId,
              httpsOrigin: issuer,
              transportRole: "relay",
              leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            };
          },
        },
      });
      try {
        using fetch = vi.spyOn(globalThis, "fetch");
        const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
        const result = await openFileInPreview({
          threadRef: unhost === undefined ? threadRef : sideChatRef,
          filePath: `/repo/${name}`,
          workspaceRoot: "/repo",
          httpBaseUrl: issuer,
          createAssetUrl: async () => {
            if (unmount === "during issuance") unhost?.();
            return AsyncResult.success({ relativeUrl, expiresAt: 0 });
          },
          openPreview,
        });
        expect(result._tag).toBe("Success");
        expect(fetch).not.toHaveBeenCalled();
        expect(openPreview).not.toHaveBeenCalled();
        const { byThreadKey } = useRightPanelStore.getState();
        expect(selectActiveRightPanelSurface(byThreadKey, threadRef)).toMatchObject({
          kind: "file",
          localPreview: issuer + relativeUrl,
        });
        expect(selectActiveRightPanelSurface(byThreadKey, sideChatRef)).toBeNull();
      } finally {
        unhost?.();
        vi.unstubAllGlobals();
      }
    },
  );

  it("does not fall back to a browser RPC when a guarded document receives a direct grant", async () => {
    vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    const result = await openFileInPreview({
      threadRef,
      filePath: "/repo/index.html",
      workspaceRoot: "/repo",
      httpBaseUrl: "https://relay.example.test",
      requireAdmittedDocument: true,
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "https://direct.example.test/api/assets/signed.grant/index.html",
          expiresAt: 0,
        }),
      openPreview,
    });

    expect(result._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
  });

  // regression: #16961 a background link open switched the active preview tab
  it("keeps the current tab active for a background open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    const state = readThreadPreviewState(threadRef);
    expect(state.activeTabId).toBe("tab-current");
    expect(Object.keys(state.sessions).toSorted()).toEqual(["tab-1", "tab-current"]);
  });

  it("keeps a tab the user picked while a background open was in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        applyPreviewServerSnapshot(threadRef, snapshot);
        setActivePreviewTab(threadRef, "tab-other");
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-other");
  });
});
