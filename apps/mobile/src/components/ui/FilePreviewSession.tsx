import { AssetWorkspaceAssetNotFoundError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Dialog from "./Dialog";
import { useContext, useEffect, useEffectEvent, useRef, useState, type ComponentType } from "react";

import {
  initializeVerifiedRoutes,
  supportsVerifiedRoutes,
  verificationRequiredFor,
} from "../../connection/verified-route";
import { loadLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import {
  downloadAndShareAttachment,
  downloadAttachmentForPreview,
  nativeViewerErrorMessage,
  shareLocalAttachment,
  type AttachmentPreviewFile,
} from "../../lib/attachmentDownload";
import { usePreviewPresentation } from "../../lib/previewPresentation";
import { refreshAssetUrl } from "../../state/assets";
import {
  filePreviewGallery,
  filePreviewKey,
  filePreviewName,
  filePreviewSourceIdentifier,
} from "../../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import type {
  FilePreviewItem,
  FilePreviewLease,
  FilePreviewModalProps,
  FilePreviewSource,
  FilePreviewViewerProps,
} from "./FilePreviewModal.types";

interface FilePreviewSessionOptions {
  /** Opens before every image resolves; the viewer takes later URLs as they arrive. */
  readonly progressiveGallery: boolean;
  readonly Viewer: ComponentType<FilePreviewViewerProps>;
}

class PreviewResolutionError extends Schema.TaggedError<PreviewResolutionError>()(
  "PreviewResolutionError",
  { cause: Schema.Defect(), fallbackMessage: Schema.String },
) {
  override get message(): string {
    return this.fallbackMessage;
  }
}

const isPreviewResolutionError = Schema.is(PreviewResolutionError);
const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

function remotePreviewFailureMessage(error: unknown): string {
  if (!isAssetNotFoundError(error)) {
    return "Reconnect to this environment and try again. The file may have been moved or deleted.";
  }
  const path = error.checkedPath ?? ("path" in error.resource ? error.resource.path : undefined);
  return path ? `The file was not found at ${path}.` : error.message;
}

interface ResolvedPreviewUri {
  readonly uri: string;
  readonly verifiedLocal?: boolean;
  readonly lease?: FilePreviewLease;
  readonly dispose?: () => void;
}

function leasedUri(
  file: AttachmentPreviewFile,
  fragment: string,
  verifiedLocal = false,
): ResolvedPreviewUri {
  let references = 1;
  const release = () => {
    if (--references === 0) file.dispose();
  };
  return {
    uri: file.uri + fragment,
    verifiedLocal,
    lease: {
      retain: () => {
        references++;
        return release;
      },
      ...(file.retainAfterHandoff ? { retainAfterHandoff: file.retainAfterHandoff } : {}),
    },
    dispose: release,
  };
}

const isHttpUri = (uri: string) => /^https?:/i.test(uri.trimStart());

function withoutFragment(uri: string) {
  return uri.split("#", 1)[0]!;
}

function previewFragment(uri: string, item: FilePreviewItem) {
  return item.srcFragment ?? uri.slice(withoutFragment(uri).length);
}

function presentationKey(item: FilePreviewItem) {
  return JSON.stringify([
    item.kind,
    filePreviewKey(item),
    item.srcFragment,
    "attachment" in item ? item.attachment.fileUri : undefined,
  ]);
}

async function resolvePreviewUri(
  item: FilePreviewItem,
  signal: AbortSignal,
): Promise<ResolvedPreviewUri | null> {
  if ("attachment" in item) {
    try {
      const file = await loadLocalAttachmentPreview(item.attachment, signal);
      return file && leasedUri(file, item.srcFragment ?? "");
    } catch (error) {
      throw new PreviewResolutionError({
        cause: error,
        fallbackMessage: "Attach the file again and retry.",
      });
    }
  }
  try {
    const url =
      "uri" in item ? item.uri : await refreshAssetUrl(item.environmentId, item.resource, signal);
    if (!url) throw new Error("Reconnect to this environment and try again.");
    if (isHttpUri(url)) await initializeVerifiedRoutes();
    if (signal.aborted) return null;
    const fragment = previewFragment(url, item);
    const base = withoutFragment(url);
    if (!verificationRequiredFor(url)) return { uri: base + fragment };
    if (!(await supportsVerifiedRoutes())) throw new Error("Verified preview is unavailable.");
    if (signal.aborted) return null;
    const name = filePreviewName(item);
    const file = await downloadAttachmentForPreview({
      url: base,
      attachment: {
        name: item.kind === "pdf" && !/\.pdf$/i.test(name) ? `${name}.pdf` : name,
        mimeType:
          item.mimeType ??
          ("resource" in item && "mimeType" in item.resource
            ? item.resource.mimeType
            : undefined) ??
          (item.kind === "pdf" ? "application/pdf" : "application/octet-stream"),
      },
      signal,
      requireVerified: true,
    });
    if (file === null && !signal.aborted) throw new Error("Verified preview is unavailable.");
    return file && leasedUri(file, fragment, true);
  } catch (error) {
    throw new PreviewResolutionError({
      cause: error,
      fallbackMessage: remotePreviewFailureMessage(error),
    });
  }
}

// Shares from the unresolved item so remote URLs refresh and draft files take their own lease.
function pdfActionsSource(item: FilePreviewItem): MediaActionsSource {
  const metadata = {
    name: filePreviewName(item),
    mimeType: item.mimeType ?? "application/pdf",
    ...(item.sourceIdentifier ? { sourceIdentifier: item.sourceIdentifier } : {}),
  };
  if ("uri" in item) return { ...metadata, uri: item.uri };
  if ("attachment" in item) return { ...metadata, attachment: item.attachment };
  return { ...metadata, environmentId: item.environmentId, resource: item.resource };
}

function ResolvedFilePreview(
  props: FilePreviewSessionOptions & {
    readonly source: FilePreviewSource;
    readonly onRequestClose: () => void;
    readonly onOpenError?: (error: unknown) => void;
    readonly onPresent: (isFinished: () => boolean) => void;
  },
) {
  const { progressiveGallery, Viewer } = props;
  // Freeze the group at opening; streaming messages and URL refreshes must not reopen the viewer.
  const [items] = useState(() => filePreviewGallery(props.source, []));
  const selectedKey = filePreviewKey(props.source);
  const selectedIndex = items.findIndex((item) => filePreviewKey(item) === selectedKey);
  // Undefined while resolving, null once it cannot be.
  const [initial] = useState(() =>
    items.map((item) =>
      "uri" in item && !isHttpUri(item.uri) && !verificationRequiredFor(item.uri)
        ? { uri: withoutFragment(item.uri) + previewFragment(item.uri, item) }
        : undefined,
    ),
  );
  const [files, setFiles] = useState<readonly (ResolvedPreviewUri | null | undefined)[]>(initial);
  const pending = useRef<AbortController | null>(null);
  const close = () => {
    pending.current?.abort();
    props.onRequestClose();
  };
  const onResolutionError = useEffectEvent((error: PreviewResolutionError) => {
    if (props.onOpenError) props.onOpenError(error.cause);
    else Dialog.alert("Could not open preview", error.fallbackMessage);
    close();
  });
  // Resolves once per presentation and holds local file leases until it closes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves preview files and holds their local file leases until the preview closes
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    const leases: (() => void)[] = [];
    const settle = (index: number, file: ResolvedPreviewUri | null) =>
      setFiles((current) => current.map((value, at) => (at === index ? file : value)));
    items.forEach((item, index) => {
      if (initial[index]) return;
      void resolvePreviewUri(item, controller.signal).then(
        (resolved) => {
          if (controller.signal.aborted) return resolved?.dispose?.();
          if (resolved?.dispose) leases.push(resolved.dispose);
          settle(index, resolved);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (progressiveGallery && index !== selectedIndex) return settle(index, null);
          controller.abort();
          onResolutionError(
            isPreviewResolutionError(error)
              ? error
              : new PreviewResolutionError({ cause: error, fallbackMessage: "Try again." }),
          );
        },
      );
    });
    return () => {
      controller.abort();
      pending.current = null;
      for (const dispose of leases) dispose();
    };
  }, [initial, items, selectedIndex, progressiveGallery]);
  const selected = { ...items[selectedIndex]!, name: filePreviewName(items[selectedIndex]!) };
  if (selected.kind === "image") {
    // A viewer that resets image gestures when its sources change waits for every image.
    if (!progressiveGallery && files.some((file) => file === undefined)) return null;
    const images = items.map((item, index) => {
      const file = files[index];
      const sourceIdentifier =
        item.sourceIdentifier ??
        ("uri" in item && isHttpUri(item.uri) && (!file || file.verifiedLocal)
          ? undefined
          : filePreviewSourceIdentifier(item));
      return {
        kind: "image" as const,
        name: filePreviewName(item),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.actionsSource ? { actionsSource: item.actionsSource } : {}),
        ...(item.srcFragment ? { srcFragment: item.srcFragment } : {}),
        ...(sourceIdentifier === undefined ? {} : { sourceIdentifier }),
        ...(file
          ? { uri: file.uri, ...(file.lease ? { lease: file.lease } : {}) }
          : file === null
            ? { failed: true }
            : {}),
      };
    });
    return (
      <Viewer
        source={{ kind: "image", images, selectedIndex }}
        onRequestClose={close}
        onPresent={props.onPresent}
        {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
      />
    );
  }
  const file = files[selectedIndex];
  if (!file) return null;
  const { uri, verifiedLocal, lease } = file;
  const onOpenError = (error: unknown) => {
    if (props.onOpenError) return props.onOpenError(error);
    Dialog.alert("Could not open preview", nativeViewerErrorMessage(error), [
      { text: "Cancel", style: "cancel" },
      ...(selected.kind === "document"
        ? [
            {
              text: "Save or share",
              onPress: () => {
                const input = {
                  attachment: {
                    name: selected.name,
                    mimeType: selected.mimeType ?? "application/octet-stream",
                  },
                  signal: new AbortController().signal,
                };
                const sharing = verifiedLocal
                  ? resolvePreviewUri(selected, input.signal).then((fresh) =>
                      Promise.resolve()
                        .then(() =>
                          fresh?.verifiedLocal
                            ? shareLocalAttachment({ ...input, uri: withoutFragment(fresh.uri) })
                            : undefined,
                        )
                        .finally(() => fresh?.dispose?.()),
                    )
                  : /^(file|content):/.test(uri)
                    ? shareLocalAttachment({ ...input, uri: withoutFragment(uri) })
                    : downloadAndShareAttachment({ ...input, url: uri });
                void sharing.catch(() => Dialog.alert("Could not share file", "Please try again."));
              },
            },
          ]
        : []),
    ]);
  };
  const actionsSource =
    selected.actionsSource ?? (selected.kind === "pdf" ? pdfActionsSource(selected) : undefined);
  return (
    <Viewer
      source={{
        kind: selected.kind,
        name: selected.name,
        ...(selected.mimeType ? { mimeType: selected.mimeType } : {}),
        ...(selected.sourceIdentifier ? { sourceIdentifier: selected.sourceIdentifier } : {}),
        ...(selected.srcFragment ? { srcFragment: selected.srcFragment } : {}),
        uri,
        ...(verifiedLocal ? { verifiedLocal } : {}),
        ...(lease ? { lease } : {}),
        ...(actionsSource ? { actionsSource } : {}),
      }}
      onRequestClose={close}
      onOpenError={onOpenError}
      onPresent={props.onPresent}
    />
  );
}

/**
 * The part of FilePreviewModal both platforms share: it resolves sources, freezes the gallery
 * at opening and closes with its screen. Each platform's FilePreviewModal passes its viewer.
 */
export function FilePreviewSession(props: FilePreviewModalProps & FilePreviewSessionOptions) {
  const group = useContext(FilePreviewGallery);
  const source =
    props.source === null
      ? null
      : { ...props.source, gallery: filePreviewGallery(props.source, group) };
  const key = source && presentationKey(source);
  usePreviewPresentation(key, props.onRequestClose);
  // A tap can land after the native viewer closed but before its close reached the caller, which
  // still holds the same item; that tap only opens a new viewer under a new key.
  // Only a viewer that presented and has since closed reopens; one still resolving never does.
  const [opening, setOpening] = useState<{
    readonly source: FilePreviewModalProps["source"];
    readonly count: number;
    readonly presented: { readonly isFinished: () => boolean } | null;
  }>({ source: props.source, count: 0, presented: null });
  if (opening.source !== props.source) {
    const sameItem =
      opening.source !== null && props.source !== null && presentationKey(opening.source) === key;
    const reopened = sameItem && opening.presented?.isFinished() === true;
    setOpening({
      source: props.source,
      count: opening.count + (reopened ? 1 : 0),
      presented: sameItem && !reopened ? opening.presented : null,
    });
  }
  const { count } = opening;
  const onPresent = (isFinished: () => boolean) =>
    setOpening((current) =>
      current.count === count && current.presented === null
        ? { ...current, presented: { isFinished } }
        : current,
    );

  if (!source) return null;
  return (
    <ResolvedFilePreview
      key={`${opening.count}:${key}`}
      source={source}
      onRequestClose={props.onRequestClose}
      progressiveGallery={props.progressiveGallery}
      Viewer={props.Viewer}
      onPresent={onPresent}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
