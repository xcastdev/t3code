import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { VideoSource } from "expo-video";
import type { AppStateStatus } from "react-native";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { enrollVerifiedRoute, markVerificationRequired } from "../connection/verified-route";
import type { downloadAttachmentForPreview } from "./attachmentDownload";

const mocks = vi.hoisted(() => ({
  focused: true,
  appState: "active" as AppStateStatus,
  appStateListeners: new Set<(state: AppStateStatus) => void>(),
  players: [] as ReturnType<typeof createPlayer>[],
  assetUrl: "",
  refresh: vi.fn<() => Promise<string | null>>(),
  refreshNative:
    vi.fn<
      (
        environmentId: EnvironmentId,
        resource: AssetResource,
        signal?: AbortSignal,
      ) => Promise<string | null>
    >(),
  present: vi.fn<(...args: string[]) => Promise<void>>(),
  dismiss: vi.fn<(identifier: string) => Promise<void>>(),
  alert: vi.fn(),
  replace: vi.fn<(source: VideoSource) => Promise<void>>(),
  download: vi.fn<typeof downloadAttachmentForPreview>(),
  secureValues: new Map<string, string>(),
  thumbnail: vi.fn<(key: string, source: unknown, signal: AbortSignal) => Promise<null>>(),
}));
vi.mock("@react-navigation/native", () => {
  const navigation = { isFocused: () => mocks.focused, addListener: () => () => {} };
  return { useIsFocused: () => mocks.focused, useNavigation: () => navigation };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Keyboard: { dismiss: () => {} },
  StyleSheet: { absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("expo", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    requireOptionalNativeModule: () => null,
    requireNativeModule: () => ({
      presentVideo: mocks.present,
      dismissVideo: mocks.dismiss,
      addListener: () => ({ remove: () => {} }),
    }),
    useEvent: (player: ReturnType<typeof createPlayer>, event: string, initial: unknown) => {
      const playing = useSyncExternalStore(player.subscribe, () => player.playing);
      return event === "playingChange" ? { isPlaying: playing } : initial;
    },
  };
});
vi.mock("expo-video", async () => {
  const { useState } = await import("react");
  return {
    useVideoPlayer: (
      _source: unknown,
      initialize: (player: ReturnType<typeof createPlayer>) => void,
    ) =>
      useState(() => {
        const player = createPlayer();
        initialize(player);
        mocks.players.push(player);
        return player;
      })[0],
    VideoView: (props: { onFullscreenEnter: () => void; onFullscreenExit: () => void }) => (
      <div aria-label="Video">
        <button aria-label="Enter fullscreen" onClick={props.onFullscreenEnter} />
        <button aria-label="Exit fullscreen" onClick={props.onFullscreenExit} />
      </div>
    ),
  };
});
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: vi.fn() },
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
  setIsAudioActiveAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: () => ({ actions: [], sharing: false }),
}));
vi.mock("../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: mocks.assetUrl }),
  useRefreshAssetUrl: () => mocks.refresh,
  refreshAssetUrl: mocks.refreshNative,
}));
vi.mock("../state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("./attachmentDownload", () => ({ downloadAttachmentForPreview: mocks.download }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mocks.secureValues.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mocks.secureValues.set(key, value);
  },
}));
vi.mock("./videoThumbnails", () => ({
  cachedVideoThumbnail: () => null,
  loadVideoThumbnail: mocks.thumbnail,
}));
vi.mock("../components/ui/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (value: unknown) => value,
}));
vi.mock("../components/ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../features/threads/ThreadMarkdownImage", () => ({ ThreadMarkdownImageView: () => null }));

import {
  ThreadMarkdownVideo,
  ThreadMediaVisibleContext,
} from "../features/threads/ThreadMarkdownVideo";
import {
  PullRequestMedia,
  PullRequestMediaContext,
  PullRequestMediaVisibleContext,
} from "../features/pull-requests/PullRequestMedia";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";
import { VideoPreviewModal, type VideoPreviewSource } from "../components/ui/VideoPreviewModal";
import { useWorkspaceFileAssetUrlState } from "../features/files/workspaceFileAssetUrl";
import { WorkspaceFileVideoPreview } from "../features/files/WorkspaceFileVideoPreview";

const environmentId = EnvironmentId.make("test");
const threadId = ThreadId.make("thread");

function WorkspaceVideo() {
  const asset = useWorkspaceFileAssetUrlState({
    cwd: "/project",
    environmentId,
    relativePath: "clip.mp4",
    threadId,
  });
  return (
    <WorkspaceFileVideoPreview
      name="clip.mp4"
      thumbnailKey="workspace-video:test"
      uri={asset._tag === "Success" ? asset.url : null}
      source={null}
      resolvePlaybackUri={asset.refresh}
    />
  );
}

function createPlayer() {
  let playing = false;
  const listeners = new Set<() => void>();
  const playingListeners = new Set<(event: { isPlaying: boolean }) => void>();
  const setPlaying = (next: boolean) => {
    playing = next;
    for (const listener of listeners) listener();
    for (const listener of playingListeners) listener({ isPlaying: next });
  };
  return {
    currentTime: 0,
    status: "readyToPlay",
    get playing() {
      return playing;
    },
    play: vi.fn(() => setPlaying(true)),
    pause: vi.fn(() => setPlaying(false)),
    replaceAsync: vi.fn((source: VideoSource): Promise<void> => mocks.replace(source)),
    addListener(event: string, listener: (event: { isPlaying: boolean }) => void) {
      if (event === "playingChange") playingListeners.add(listener);
      return { remove: () => playingListeners.delete(listener) };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function setup(
  kind: "thread" | "PR" | "files" | "workspace",
  compact = false,
  uri = "https://media.example/clip.mp4",
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.appState = "active";
  mocks.players = [];
  mocks.appStateListeners.clear();
  mocks.assetUrl = "https://media.example/clip.mp4";
  mocks.refresh.mockReset().mockResolvedValue("https://media.example/clip.mp4");
  mocks.replace.mockReset().mockResolvedValue();
  mocks.download.mockReset();
  mocks.thumbnail.mockReset().mockResolvedValue(null);
  const container = document.createElement("div");
  const root = createRoot(container);
  // Configured like the app's registry: the React default keeps unmounted atoms for 400ms,
  // which would hold thumbnail loads open across renders and tests.
  const registry = AtomRegistry.make();
  return {
    render(visible = true, thumbnailKey = "workspace-video:test") {
      if (kind === "files") mocks.focused = visible;
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            {kind === "workspace" ? (
              <WorkspaceVideo />
            ) : kind === "files" ? (
              <MediaVideoPlayer
                name="clip.mp4"
                thumbnailKey={thumbnailKey}
                uri={uri}
                fitToVideo
                visible={visible}
                resolvePlaybackUri={mocks.refresh}
              />
            ) : kind === "thread" ? (
              <ThreadMediaVisibleContext value={visible}>
                <ThreadMarkdownVideo
                  source={{
                    type: "media",
                    name: "clip.mp4",
                    mimeType: "video/mp4",
                    environmentId,
                    resource: {
                      _tag: "github-media",
                      cwd: "/project",
                      url: "https://github.com/user-attachments/assets/video",
                    },
                  }}
                />
              </ThreadMediaVisibleContext>
            ) : (
              <PullRequestMediaContext value={{ environmentId, cwd: "/project" }}>
                <PullRequestMediaVisibleContext value={visible}>
                  <PullRequestMedia
                    url="https://github.com/user-attachments/assets/video"
                    kind="video"
                    compact={compact}
                  />
                </PullRequestMediaVisibleContext>
              </PullRequestMediaContext>
            )}
          </RegistryContext.Provider>,
        ),
      );
    },
    async open() {
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(mocks.players).toHaveLength(1);
      return mocks.players[0]!;
    },
    async retry() {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Retry video"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    },
    fullscreen(open: boolean) {
      const button = container.querySelector<HTMLButtonElement>(
        `[aria-label="${open ? "Enter" : "Exit"} fullscreen"]`,
      );
      expect(button).not.toBeNull();
      act(() => button!.click());
    },
    appState(state: AppStateStatus) {
      mocks.appState = state;
      act(() => {
        for (const listener of mocks.appStateListeners) listener(state);
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

const oldIssuer = "https://old-verified.example";
const currentIssuer = "https://current-verified.example";

async function enrollVideoIssuers() {
  for (const httpsOrigin of [oldIssuer, currentIssuer]) {
    await enrollVerifiedRoute({
      httpsOrigin,
      environmentId: "test",
      leafSpkiSha256: "A".repeat(43) + "=",
    });
  }
}

function setupNativeVideo() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.present.mockReset().mockResolvedValue(undefined);
  mocks.dismiss.mockReset().mockResolvedValue(undefined);
  mocks.refreshNative.mockReset();
  mocks.download.mockReset();
  mocks.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  return {
    render(source: VideoPreviewSource | null) {
      return act(async () =>
        root.render(<VideoPreviewModal source={source} onRequestClose={onRequestClose} />),
      );
    },
    onRequestClose,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

const nativeResourceVideo = {
  type: "media",
  name: "clip.mp4",
  mimeType: "video/mp4",
  environmentId,
  resource: { _tag: "media-file", threadId, path: "/project/clip.mp4" },
  srcFragment: "#t=12",
} as const;

it.each(["resource", "bare URI"] as const)(
  "presents a verified local file for a native %s and leases it through dismissal",
  async (kind) => {
    const issuer = "https://native-verified.example";
    markVerificationRequired(issuer);
    const signed = issuer + "/clip.mp4?signature=new";
    const file = { uri: "file:///native/clip.mp4", dispose: vi.fn(), share: vi.fn() };
    const presentation = Promise.withResolvers<void>();
    await using screen = setupNativeVideo();
    mocks.present.mockReturnValue(presentation.promise);
    mocks.refreshNative.mockResolvedValue(signed);
    mocks.download.mockResolvedValue(file);
    await screen.render(
      kind === "resource"
        ? nativeResourceVideo
        : { type: "media", name: "clip.mp4", mimeType: "video/mp4", uri: signed + "#t=12" },
    );
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: signed,
        requireVerified: true,
      }),
    );
    expect(mocks.present).toHaveBeenCalledExactlyOnceWith(
      file.uri + "#t=12",
      "clip.mp4",
      "",
      expect.any(String),
    );
    const { signal } = mocks.download.mock.calls[0]![0];
    if (kind === "resource") {
      expect(mocks.refreshNative).toHaveBeenCalledExactlyOnceWith(
        environmentId,
        nativeResourceVideo.resource,
        signal,
      );
    }
    const [, , , identifier] = mocks.present.mock.calls[0]!;
    await screen.render(null);
    expect(signal.aborted).toBe(true);
    expect(mocks.dismiss).toHaveBeenCalledWith(identifier);
    expect(file.dispose).not.toHaveBeenCalled();
    await act(async () => presentation.resolve());
    expect(file.dispose).toHaveBeenCalledOnce();
    expect(screen.onRequestClose).not.toHaveBeenCalled();
  },
);

it("aborts the native download when another video with the same title replaces it", async () => {
  const issuer = "https://native-verified.example";
  markVerificationRequired(issuer);
  const late = Promise.withResolvers<Awaited<ReturnType<typeof downloadAttachmentForPreview>>>();
  const file = { uri: "file:///native/late.mp4", dispose: vi.fn(), share: vi.fn() };
  await using screen = setupNativeVideo();
  mocks.refreshNative
    .mockResolvedValueOnce(issuer + "/clip.mp4")
    .mockResolvedValueOnce("https://media.example/other.mp4");
  mocks.download.mockReturnValue(late.promise);
  await screen.render(nativeResourceVideo);
  expect(mocks.download).toHaveBeenCalledOnce();
  const { signal } = mocks.download.mock.calls[0]![0];
  expect(signal.aborted).toBe(false);
  await screen.render({
    ...nativeResourceVideo,
    resource: { ...nativeResourceVideo.resource, path: "/project/other.mp4" },
  });
  expect(signal.aborted).toBe(true);
  await act(async () => late.resolve(file));
  expect(file.dispose).toHaveBeenCalledOnce();
  expect(mocks.present).toHaveBeenCalledExactlyOnceWith(
    "https://media.example/other.mp4#t=12",
    "clip.mp4",
    "",
    expect.any(String),
  );
});

it("waits for native dismissal before presenting a different video", async () => {
  const first = Promise.withResolvers<void>();
  await using screen = setupNativeVideo();
  mocks.present.mockReturnValueOnce(first.promise);
  mocks.refreshNative
    .mockResolvedValueOnce("https://media.example/clip.mp4")
    .mockResolvedValueOnce("https://media.example/other.mp4");
  await screen.render(nativeResourceVideo);
  expect(mocks.present).toHaveBeenCalledOnce();
  const [, , , identifier] = mocks.present.mock.calls[0]!;
  await screen.render({
    ...nativeResourceVideo,
    resource: { ...nativeResourceVideo.resource, path: "/project/other.mp4" },
  });
  expect(mocks.dismiss).toHaveBeenCalledWith(identifier);
  expect(mocks.present).toHaveBeenCalledOnce();
  await act(async () => first.resolve());
  expect(mocks.present).toHaveBeenLastCalledWith(
    "https://media.example/other.mp4#t=12",
    "clip.mp4",
    "",
    expect.any(String),
  );
  expect(mocks.present.mock.calls[1]?.[3]).not.toBe(identifier);
});

it("closes a native video whose required verified download fails", async () => {
  const issuer = "https://native-verified.example";
  markVerificationRequired(issuer);
  await using screen = setupNativeVideo();
  mocks.refreshNative.mockResolvedValue(issuer + "/clip.mp4");
  mocks.download.mockRejectedValue(new Error("Verified download failed"));
  await screen.render(nativeResourceVideo);
  expect(mocks.present).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledWith("Could not open video", "Verified download failed");
  expect(screen.onRequestClose).toHaveBeenCalledOnce();
});

it("loads a workspace video from a fresh owned download even when the poster is cached", async () => {
  await enrollVideoIssuers();
  const signed = currentIssuer + "/clip.mp4?signature=new";
  const playbackFile = { uri: "file:///playback/clip.mp4", dispose: vi.fn(), share: vi.fn() };
  {
    using screen = setup("workspace");
    mocks.assetUrl = "file:///poster/clip.mp4";
    mocks.refresh.mockResolvedValue(signed + "#t=12");
    mocks.download.mockResolvedValue(playbackFile);
    screen.render();
    const player = await screen.open();
    expect(player.replaceAsync).toHaveBeenCalledExactlyOnceWith({
      uri: playbackFile.uri + "#t=12",
      contentType: "progressive",
    });
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: signed,
        requireVerified: true,
      }),
    );
    mocks.assetUrl = "file:///poster/new/clip.mp4";
    screen.render();
    expect(playbackFile.dispose).not.toHaveBeenCalled();
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
  }
  expect(playbackFile.dispose).toHaveBeenCalledOnce();
});

it("releases each failed verified replacement when native loading rejects", async () => {
  await enrollVideoIssuers();
  using screen = setup("files");
  const rejected = Promise.withResolvers<void>();
  const first = { uri: "file:///failed/first.mp4", dispose: vi.fn(), share: vi.fn() };
  const second = { uri: "file:///failed/second.mp4", dispose: vi.fn(), share: vi.fn() };
  mocks.refresh.mockResolvedValue(currentIssuer + "/clip.mp4");
  mocks.download.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  mocks.replace
    .mockReturnValueOnce(rejected.promise)
    .mockRejectedValueOnce(new Error("unsupported"));
  screen.render();
  const player = await screen.open();
  expect(first.dispose).not.toHaveBeenCalled();
  await act(async () => rejected.reject(new Error("unsupported")));
  expect(first.dispose).toHaveBeenCalledOnce();
  await screen.retry();
  expect(second.dispose).toHaveBeenCalledOnce();
  expect(player.play).not.toHaveBeenCalled();
});

it.each([
  ["direct", "https://media.example/clip.mp4", currentIssuer],
  ["verified on the same route", oldIssuer + "/clip.mp4?signature=old#t=1", oldIssuer],
  ["verified on a different route", oldIssuer + "/clip.mp4?signature=old#t=1", currentIssuer],
] as const)(
  "loads freshly issued verified video after a %s source",
  async (_kind, initial, issuer) => {
    await enrollVideoIssuers();
    const refreshed = issuer + "/clip.mp4?signature=new";
    const oldFile = { uri: "file:///old/clip.mp4", dispose: vi.fn(), share: vi.fn() };
    const newFile = { uri: "file:///new/clip.mp4", dispose: vi.fn(), share: vi.fn() };
    {
      using screen = setup("files", false, initial);
      mocks.refresh.mockResolvedValue(refreshed + "#t=12");
      mocks.download.mockImplementation(async ({ url }) => (url === refreshed ? newFile : oldFile));
      await act(async () => screen.render());
      const player = await screen.open();
      expect(player.replaceAsync).toHaveBeenCalledWith({
        uri: newFile.uri + "#t=12",
        contentType: "progressive",
      });
      expect(mocks.download).toHaveBeenLastCalledWith(expect.objectContaining({ url: refreshed }));
      expect(newFile.dispose).not.toHaveBeenCalled();
    }
    expect(newFile.dispose).toHaveBeenCalledOnce();
  },
);

it.each(["unmount", "source change"] as const)(
  "cancels the verified playback download on %s",
  async (end) => {
    await enrollVideoIssuers();
    const download =
      Promise.withResolvers<Awaited<ReturnType<typeof downloadAttachmentForPreview>>>();
    const file = { uri: "file:///late/clip.mp4", dispose: vi.fn(), share: vi.fn() };
    const screen = setup("files");
    let unmounted = false;
    try {
      mocks.refresh.mockResolvedValue(currentIssuer + "/clip.mp4");
      mocks.download.mockReturnValue(download.promise);
      screen.render();
      const player = await screen.open();
      expect(mocks.download).toHaveBeenCalledOnce();
      const { signal } = mocks.download.mock.calls[0]![0];
      if (end === "source change") {
        screen.render(true, "workspace-video:other");
      } else {
        screen[Symbol.dispose]();
        unmounted = true;
      }
      expect(signal.aborted).toBe(true);
      await act(async () => download.resolve(file));
      expect(player.replaceAsync).not.toHaveBeenCalled();
      expect(file.dispose).toHaveBeenCalledOnce();
    } finally {
      if (!unmounted) screen[Symbol.dispose]();
    }
  },
);

it("does not give the player a route requiring verification when its download fails", async () => {
  const issuer = "https://unavailable-verified.example";
  markVerificationRequired(issuer);
  using screen = setup("files");
  mocks.refresh.mockResolvedValue(issuer + "/clip.mp4");
  mocks.download.mockRejectedValue(new Error("Verified download failed"));
  screen.render();
  const player = await screen.open();
  expect(player.replaceAsync).not.toHaveBeenCalled();
  expect(player.play).not.toHaveBeenCalled();
});

it.each(["thread", "PR"] as const)(
  "retains the %s player and position while hidden and requires deliberate resume",
  async (kind) => {
    using screen = setup(kind);
    screen.render();
    const player = await screen.open();
    expect(player.playing).toBe(true);
    player.currentTime = 37;
    screen.render(false);
    expect(player.playing).toBe(false);
    screen.render(true);
    expect(mocks.players).toEqual([player]);
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
    expect(player.currentTime).toBe(37);
    expect(player.playing).toBe(false);
  },
);

it.each(["thread", "PR"] as const)(
  "does not start a hidden %s video when signing or native loading finishes late",
  async (kind) => {
    using screen = setup(kind);
    const signed = Promise.withResolvers<string | null>();
    const replaced = Promise.withResolvers<void>();
    mocks.refresh.mockReturnValue(signed.promise);
    mocks.replace.mockReturnValue(replaced.promise);
    screen.render();
    const player = await screen.open();
    screen.render(false);
    await act(async () => signed.resolve("https://media.example/renewed.mp4"));
    expect(player.replaceAsync).toHaveBeenCalledExactlyOnceWith({
      uri: "https://media.example/renewed.mp4",
      contentType: "progressive",
    });
    expect(player.play).not.toHaveBeenCalled();
    await act(async () => replaced.resolve());
    expect(player.play).not.toHaveBeenCalled();
    screen.render(true);
    expect(player.playing).toBe(false);
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["PR", false],
  ["PR", true],
  ["files", false],
] as const)(
  "stops inactive %s thumbnail requests (compact: %s) and restarts on return",
  async (kind, compact) => {
    using screen = setup(kind, compact);
    mocks.thumbnail.mockReturnValue(new Promise(() => {}));
    screen.render(false);
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    await act(async () => screen.render(true));
    const requests = kind === "files" ? 2 : 1;
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests);
    const aborted = Promise.all(
      mocks.thumbnail.mock.calls.map(([, , signal]) => {
        expect(signal.aborted).toBe(false);
        return new Promise((resolve) => signal.addEventListener("abort", resolve));
      }),
    );
    screen.render(false);
    await act(() => aborted);
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests);
    await act(async () => screen.render(true));
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests * 2);
  },
);

it("pauses on screen blur and app inactivity without resuming on return", async () => {
  using screen = setup("thread");
  screen.render();
  const player = await screen.open();
  for (const reason of ["blur", "inactive", "background"] as const) {
    act(() => player.play());
    player.currentTime = 37;
    if (reason === "blur") {
      mocks.focused = false;
      screen.render();
    } else screen.appState(reason);
    expect(player.playing, reason).toBe(false);
    mocks.focused = true;
    screen.appState("active");
    screen.render();
    expect(player.playing, reason).toBe(false);
    expect(player.currentTime).toBe(37);
  }
  expect(player.replaceAsync).toHaveBeenCalledTimes(1);
});

it.each(["thread", "PR"] as const)(
  "keeps the %s play request cancelled when loading finishes after returning",
  async (kind) => {
    using screen = setup(kind);
    const signed = Promise.withResolvers<string | null>();
    const replaced = Promise.withResolvers<void>();
    mocks.refresh.mockReturnValue(signed.promise);
    mocks.replace.mockReturnValue(replaced.promise);
    screen.render();
    const player = await screen.open();
    screen.render(false);
    screen.render(true);
    await act(async () => signed.resolve("https://media.example/renewed.mp4"));
    await act(async () => replaced.resolve());
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    act(() => player.play());
    expect(player.playing).toBe(true);
  },
);

it("pauses when native fullscreen exits while the app remains in the background", async () => {
  using screen = setup("thread");
  screen.render();
  const player = await screen.open();
  player.currentTime = 37;
  screen.fullscreen(true);
  screen.appState("background");
  expect(player.playing).toBe(true);
  screen.fullscreen(false);
  expect(player.playing).toBe(false);
  screen.appState("active");
  expect(player.playing).toBe(false);
  expect(player.currentTime).toBe(37);
});
