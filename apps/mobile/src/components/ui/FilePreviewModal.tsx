import * as Dialog from "./Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type {
  FilePreviewImage,
  FilePreviewModalProps,
  FilePreviewViewerProps,
} from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  presentFiles(
    uris: readonly (string | null)[],
    names: readonly string[],
    selectedIndex: number,
    sourceIdentifiers: readonly string[],
    identifier: string,
  ): Promise<void>;
  updateFile(identifier: string, index: number, uri: string | null): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
  isFilePreviewFinished(identifier: string): boolean;
}>("T3NativeControls");

// Null tells the viewer an image failed; undefined means its URL has not arrived yet.
const nativeUri = (image: FilePreviewImage) => (image.failed ? null : image.uri);

function NativeFilePreview(props: FilePreviewViewerProps) {
  const viewId = useId();
  const generation = useRef(0);
  // Later URLs reach the native presentation through updateFile instead of presenting again.
  const [presented] = useState(props.source);
  const active = useRef<{
    readonly identifier: string;
    readonly delivered: (string | null | undefined)[];
    readonly releases: (() => void)[];
  } | null>(null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onPresent = useEffectEvent((isFinished: () => boolean) => props.onPresent?.(isFinished));
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    const identifier = `${viewId}:${++generation.current}`;
    const releases: (() => void)[] = [];
    const delivered: (string | null | undefined)[] = [];
    active.current = { identifier, delivered, releases };
    let canceled = false;
    let presentation: Promise<void>;
    // Images hand over before every URL resolves; other files must download first so Quick Look can refuse them.
    if (presented.kind === "image") {
      const { images, selectedIndex } = presented;
      for (const image of images) {
        delivered.push(image.uri);
        if (image.lease) releases.push(image.lease.retain());
      }
      presentation = NativeControls.presentFiles(
        images.map((image) => image.uri ?? null),
        images.map((image) => image.name ?? "Preview"),
        selectedIndex,
        images.map((image) => image.sourceIdentifier ?? ""),
        identifier,
      );
    } else {
      const { uri, name, sourceIdentifier } = presented;
      if (presented.lease) releases.push(presented.lease.retain());
      presentation = NativeControls.presentFile(
        uri,
        name ?? "Preview",
        sourceIdentifier ?? "",
        identifier,
      );
    }
    onPresent(() => NativeControls.isFilePreviewFinished(identifier));
    void presentation
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
      })
      .finally(() => {
        if (active.current?.identifier === identifier) active.current = null;
        for (const release of releases) release();
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      if (active.current?.identifier === identifier) {
        active.current = null;
        void NativeControls.dismissFile(identifier).catch(() => undefined);
      }
    };
  }, [presented, viewId]);

  const images = props.source.kind === "image" ? props.source.images : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands image URLs that resolve after opening to the native viewer
  useEffect(() => {
    const viewer = active.current;
    if (!viewer) return;
    images?.forEach((image, index) => {
      const uri = nativeUri(image);
      if (uri === undefined || viewer.delivered[index] === uri) return;
      viewer.delivered[index] = uri;
      if (image.lease) viewer.releases.push(image.lease.retain());
      void NativeControls.updateFile(viewer.identifier, index, uri).catch(() => undefined);
    });
  }, [images]);

  return null;
}

/** Shows images, PDFs and documents full screen in the native viewer (Android: FilePreviewModal.android.tsx). */
export function FilePreviewModal(props: FilePreviewModalProps) {
  return <FilePreviewSession {...props} progressiveGallery Viewer={NativeFilePreview} />;
}
