import * as Dialog from "./Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef } from "react";

import { verificationRequiredFor } from "../../connection/verified-route";
import type { AttachmentPreviewFile } from "../../lib/attachmentDownload";
import { loadLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import { usePreviewPresentation, videoPreviewKey } from "../../lib/previewPresentation";
import { downloadVerifiedLocalAsset } from "../../lib/useVerifiedLocalAsset";
import { fullscreenVideoClosed, fullscreenVideoOpened } from "../../lib/videoAudioSession";
import {
  mediaVideoPreviewUri,
  type MediaVideoPreviewSource,
  type VideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { refreshAssetUrl } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";

export type { VideoPreviewSource } from "../../lib/videoPreviewSource";

const NativeControls = requireNativeModule<{
  presentVideo(
    uri: string,
    title: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
  addListener(
    event: "videoPlaybackChange",
    listener: (event: { identifier: string; isPlaying: boolean }) => void,
  ): { remove(): void };
}>("T3NativeControls");

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const sourceKey = source === null ? null : videoPreviewKey(source);
  usePreviewPresentation(sourceKey, props.onRequestClose);
  const instanceId = useId();
  const generation = useRef(0);
  const activePresentation = useRef<Promise<void> | null>(null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const getSource = useEffectEvent(() => source);
  const environmentId =
    source?.type === "media" && "environmentId" in source ? source.environmentId : null;
  const preparedConnection = usePreparedConnection(environmentId);
  // Mints a fresh URL for each presentation: AVKit retains the URL and offers no retry,
  // so a cached link that expired while the app was suspended would fail to play.
  const resolvePlaybackUrl = useEffectEvent(
    async (source: MediaVideoPreviewSource, signal: AbortSignal): Promise<string> => {
      if (!("resource" in source)) return source.uri;
      const url = await refreshAssetUrl(source.environmentId, source.resource, signal).catch(
        () => null,
      );
      const playbackUrl = mediaVideoPreviewUri(source, url);
      if (playbackUrl !== null) return playbackUrl;
      throw new Error(
        preparedConnection._tag === "None"
          ? "Reconnect to this environment and open the video again."
          : "Could not load this video. Check the connection and try again.",
      );
    },
  );
  const reauthorize = useEffectEvent(() => {
    if (source?.type === "media" && "resource" in source) {
      void refreshAssetUrl(source.environmentId, source.resource).catch(() => {});
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native fullscreen video and owns its audio session and file lease until cleanup
  useEffect(() => {
    if (sourceKey === null) return;
    const source = getSource();
    if (source === null) return;
    const identifier = `${instanceId}:${++generation.current}`;
    const controller = new AbortController();
    let token: ReturnType<typeof acquireAudioSession> | null = null;
    const release = () => {
      if (token) void releaseAudioSession(token).catch(() => {});
      token = null;
    };
    const acquire = () => {
      const next = acquireAudioSession("playback", () => {
        release();
        void NativeControls.dismissVideo(identifier).catch(() => {});
      });
      if (!isAudioSessionOwner(next)) {
        void NativeControls.dismissVideo(identifier).catch(() => {});
        return null;
      }
      token = next;
      return next;
    };
    const subscription = NativeControls.addListener("videoPlaybackChange", (event) => {
      if (event.identifier !== identifier || controller.signal.aborted) return;
      if (event.isPlaying) {
        if (!token) acquire();
      } else release();
    });
    let ready = false;
    fullscreenVideoOpened();
    let file: AttachmentPreviewFile | null = null;
    void (async () => {
      await activePresentation.current?.catch(() => {});
      if (controller.signal.aborted) return;
      let uri: string;
      if (source.type === "local") {
        file = await loadLocalAttachmentPreview(source.attachment, controller.signal);
        if (file === null) return;
        uri = file.uri;
      } else {
        uri = await resolvePlaybackUrl(source, controller.signal);
        if (controller.signal.aborted) return;
        if (verificationRequiredFor(uri)) {
          file = await downloadVerifiedLocalAsset(uri, controller.signal);
          if (controller.signal.aborted) return;
          if (file === null) throw new Error("Could not load this video.");
          uri = file.uri;
        }
      }
      if (controller.signal.aborted) return;
      const current = acquire();
      if (!current || !(await activateAudioSession(current, true)) || controller.signal.aborted) {
        if (!controller.signal.aborted) onRequestClose();
        return;
      }
      ready = true;
      const completion = NativeControls.presentVideo(
        uri,
        source.type === "media" ? source.name : source.attachment.name,
        source.sourceIdentifier ?? "",
        identifier,
      );
      activePresentation.current = completion;
      // Native completion follows dismissal, so playback keeps its file lease.
      await completion.finally(() => {
        activePresentation.current = null;
      });
      return true;
    })()
      .finally(() => {
        file?.dispose();
        release();
      })
      .then((completed) => {
        if (completed && !controller.signal.aborted) onRequestClose();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // AVKit gives no retry, so re-mint now; the minted URL may already be unusable.
        if (ready) reauthorize();
        Dialog.alert(
          "Could not open video",
          ready
            ? "This video couldn't be loaded or played. Check the connection, or touch and hold the video to save or share the original."
            : error instanceof Error
              ? error.message
              : "Could not load this video.",
        );
        onRequestClose();
      });
    return () => {
      controller.abort();
      fullscreenVideoClosed();
      subscription.remove();
      release();
      if (ready) void NativeControls.dismissVideo(identifier).catch(() => undefined);
    };
  }, [sourceKey, instanceId]);

  return null;
}
