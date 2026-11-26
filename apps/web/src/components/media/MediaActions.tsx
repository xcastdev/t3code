import {
  formatFilePathForClipboard,
  type MediaActionId,
} from "@t3tools/client-runtime/media-actions";
import {
  mediaReferenceFileName,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  type AssetResource,
  type ContextMenuItem,
  type EnvironmentId,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, type ReactElement } from "react";
import { useGT } from "gt-react";

import { readAdmittedStaticAsset, requiresAdmittedAsset } from "../../assets/admittedAssetSource";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { downloadMedia, readMediaPng } from "./mediaContent";
import { READY_DOWNLOAD_MS } from "./mediaDownloadStorage";
import { pickMediaDownload, saveAdmittedMedia } from "./saveAdmittedMedia";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}

function mediaFileName(source: MediaActionSource): string {
  return (
    (source.reference && mediaReferenceFileName(source.reference)) || source.name || source.kind
  );
}

function allowsHostMedia(session: SessionGrantInput | null) {
  return session !== null && sessionGrantsScope(session, AuthFilesystemReadScope);
}

function canReadHostMedia(environmentId: EnvironmentId | null): boolean {
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return result._tag !== "Failure" && allowsHostMedia(AsyncResult.getOrElse(result, () => null));
}

export function useMediaActions(source: MediaActionSource) {
  const hostEnvironmentId =
    source.asset &&
    (source.asset.resource._tag === "workspace-file" || source.asset.resource._tag === "media-file")
      ? source.asset.environmentId
      : null;
  const fileSession = useEnvironmentQuery(
    hostEnvironmentId === null ? null : environmentSession.sessionStateAtom(hostEnvironmentId),
  );
  const canReadMedia =
    hostEnvironmentId === null ||
    (fileSession.error === null && fileSession.data !== null && allowsHostMedia(fileSession.data));
  const assertCanReadMedia = () => {
    if (!canReadHostMedia(hostEnvironmentId)) {
      throw new Error("This connection cannot read host files.");
    }
  };
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const resolveActionSource = async () => {
    assertCanReadMedia();
    if (!source.asset) {
      if (!source.src || requiresAdmittedAsset(source.src)) {
        throw new Error("This media is unavailable. Try reopening the preview.");
      }
      return { url: source.src };
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("Reconnect to this environment and try again.");
    const connectionRequiresAdmission = requiresAdmittedAsset(connection.httpBaseUrl);
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    assertCanReadMedia();
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid media URL.");
    if (connectionRequiresAdmission && !requiresAdmittedAsset(url)) {
      throw new Error("The media URL does not match the verified connection.");
    }
    return { environmentId, url };
  };
  const loadActionSource = async () => {
    const { environmentId, url } = await resolveActionSource();
    return environmentId !== undefined && requiresAdmittedAsset(url)
      ? readAdmittedStaticAsset(environmentId, url, AbortSignal.timeout(60_000))
      : url;
  };
  const admittedVideoBaseUrl = () => {
    if (source.kind !== "video" || !source.asset) return;
    const baseUrl = readPreparedConnection(source.asset.environmentId)?.httpBaseUrl;
    return baseUrl && requiresAdmittedAsset(baseUrl) ? baseUrl : undefined;
  };
  const save = async (requestSignal?: AbortSignal) => {
    const signal = requestSignal ?? new AbortController().signal;
    assertCanReadMedia();
    const name = mediaFileName(source);
    const baseUrl = admittedVideoBaseUrl();
    const pick = baseUrl ? pickMediaDownload(baseUrl, name) : undefined;
    const destination = pick ? await pick : undefined;
    if (destination === null) return;

    signal.throwIfAborted();
    const { environmentId, url } = await resolveActionSource();
    if (environmentId !== undefined && requiresAdmittedAsset(url)) {
      if (source.kind === "video")
        return saveAdmittedMedia(environmentId, url, name, destination, signal);
      await downloadMedia(
        await readAdmittedStaticAsset(environmentId, url, AbortSignal.timeout(60_000)),
        name,
      );
    } else {
      if (baseUrl) throw new Error("The media URL does not match the verified connection.");
      await downloadMedia(url, name);
    }
  };
  const copyImage = async () => {
    assertCanReadMedia();
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(
        "Image copying is unavailable. Use a secure browser connection or save the image.",
      );
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": loadActionSource().then(readMediaPng) }),
    ]);
  };
  return { save, copyImage, canReadMedia, assertCanReadMedia, admittedVideoBaseUrl };
}

export function MediaActions({
  source,
  children,
  showTooltip = true,
}: {
  source: MediaActionSource;
  children: ReactElement;
  showTooltip?: boolean;
}) {
  const gt = useGT();
  const { save, copyImage, canReadMedia, assertCanReadMedia, admittedVideoBaseUrl } =
    useMediaActions(source);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);
  const downloadErrorText = (error: unknown) => {
    switch (error instanceof Error ? error.message : "") {
      case "This file exceeds the download size limit.":
        return gt("This file exceeds the download size limit.");
      case "This browser can prepare downloads up to 4 GiB.":
        return gt("This browser can prepare downloads up to 4 GiB.");
      case "This browser can save up to 256 MiB without a file picker or temporary download storage.":
        return gt(
          "This browser can save up to 256 MiB without a file picker or temporary download storage.",
        );
      case "There is not enough browser storage to prepare this download.":
        return gt("There is not enough browser storage to prepare this download.");
      case "Temporary download storage is full. Try again later.":
        return gt("Temporary download storage is full. Try again later.");
      case "The prepared download expired. Choose Save again.":
        return gt("The prepared download expired. Choose Save again.");
      case "Finish the current video download before starting another.":
        return gt("Finish the current video download before starting another.");
      case "Open T3 Code in its own tab to save this video.":
        return gt("Open T3 Code in its own tab to save this video.");
      case "This connection cannot read host files.":
        return gt("This connection cannot read host files.");
      default:
        return error instanceof Error ? error.message : gt("The media action failed.");
    }
  };

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = "Could not open media menu";
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    const result = await settlePromise(async () => {
      const noun = source.kind === "image" ? "image" : "video";
      const unavailable = !canReadMedia || (source.src === null && source.asset === undefined);
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: "Copy full path" });
        if (reference.relativePath)
          items.push({ id: "copy-relative-path", label: "Copy relative path" });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: "Copy URL" });
      }
      if (source.onOpenFile)
        items.push({ id: "open-file", label: "Open in file viewer", disabled: !canReadMedia });
      items.push({ id: "save", label: `Save ${noun}`, disabled: unavailable });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: "Copy image",
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position);
      if (!action) return;
      failureTitle = `Could not ${items.find((item) => item.id === action)?.label.toLowerCase() ?? "complete media action"}`;
      const text =
        action === "copy-full-path" && reference?.kind === "file"
          ? reference.path
          : action === "copy-relative-path" && reference?.kind === "file"
            ? reference.relativePath
            : action === "copy-url" && reference?.kind === "url"
              ? reference.url
              : undefined;
      if (text !== undefined) {
        const clipboardText =
          reference?.kind === "file" ? formatFilePathForClipboard(text, reference.path) : text;
        await writeTextToClipboard(clipboardText, reference?.kind === "file" ? "file path" : "URL");
      } else if (action === "open-file") {
        assertCanReadMedia();
        source.onOpenFile?.();
      } else if (action === "save" || action === "copy-image") {
        const cancel = new AbortController();
        const canCancel =
          action === "save" && admittedVideoBaseUrl() !== undefined && !window.desktopBridge;
        const id = toastManager.add({
          ...stackedThreadToast({
            type: "loading",
            title:
              action === "save"
                ? source.kind === "video"
                  ? gt("Preparing video download…")
                  : gt("Preparing image download…")
                : gt("Copying image…"),
            timeout: 0,
            ...(canCancel && {
              actionProps: {
                children: gt("Cancel"),
                onClick: () => {
                  cancel.abort();
                  toastManager.close(id);
                },
              },
            }),
          }),
          ...(canCancel && { onClose: () => cancel.abort() }),
        });
        progressToast = id;
        const prepared = await (action === "save" ? save(cancel.signal) : copyImage()).catch(
          (error) => {
            if (!cancel.signal.aborted) throw error;
          },
        );
        if (prepared) {
          toastManager.update(id, {
            ...stackedThreadToast({
              type: "info",
              title: gt("Video ready to download"),
              timeout: READY_DOWNLOAD_MS,
              actionProps: {
                children: gt("Download"),
                onClick: () => {
                  try {
                    assertCanReadMedia();
                    prepared.download();
                    toastManager.close(id);
                  } catch (error) {
                    prepared.dispose();
                    toastManager.update(id, {
                      ...stackedThreadToast({
                        type: "error",
                        title: failureTitle,
                        description: downloadErrorText(error),
                      }),
                      actionProps: undefined,
                    });
                  }
                },
              },
            }),
            onClose: prepared.dispose,
          });
        } else {
          toastManager.close(id);
        }
      }
    });
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: downloadErrorText(error),
      });
      if (progressToast) toastManager.update(progressToast, { ...toast, actionProps: undefined });
      else toastManager.add(toast);
    }
    menuOpen.current = false;
  };

  return (
    <Tooltip disabled={!showTooltip} open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        render={children}
        tabIndex={0}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            event.clientX === 0 && event.clientY === 0
              ? { x: bounds.left, y: bounds.bottom }
              : { x: event.clientX, y: event.clientY },
          );
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu({ x: bounds.left, y: bounds.bottom });
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
