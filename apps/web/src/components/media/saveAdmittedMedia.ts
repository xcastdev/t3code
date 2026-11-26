import {
  openRelayMediaDownload,
  RELAY_MEDIA_DOWNLOAD_MS,
} from "@t3tools/shared/relayMediaDownload";
import type { EnvironmentId } from "@t3tools/contracts";

import { verifyPreviewIssuer } from "../../browser/readVerifiedPreviewAsset";
import { requiresDesktopRelayTransport } from "../../connection/environmentTransport";
import {
  assertHostedRelayAdmission,
  fetchHostedRelayResource,
} from "../../connection/hostedRelayAdmission";
import { downloadMedia } from "./mediaContent";
import {
  offerStoredMediaDownload,
  openMediaDownloadStorage,
  OPFS_MAX_DOWNLOAD_BYTES,
  supportsMediaDownloadStorage,
} from "./mediaDownloadStorage";
import { writeMediaDownload } from "./mediaDownloadStream";

const MAX_FILE_BYTES = 16 * 1024 ** 3;
const MAX_BUFFER_BYTES = 256 * 1024 ** 2;
let savingInTab = false;

interface BrowserSavePicker {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
}

export interface PreparedMediaDownload {
  readonly download: () => void;
  readonly dispose: () => void;
}

export function pickMediaDownload(baseUrl: string, name: string) {
  if (
    typeof window === "undefined" ||
    window.top !== window ||
    requiresDesktopRelayTransport(baseUrl) ||
    !navigator.userActivation?.isActive
  )
    return;

  const browser: Window & BrowserSavePicker = window;
  return browser.showSaveFilePicker?.({ suggestedName: name }).catch((error) => {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  });
}

export async function saveAdmittedMedia(
  environmentId: EnvironmentId,
  issuedUrl: string,
  name: string,
  destination: FileSystemFileHandle | undefined,
  cancel: AbortSignal,
): Promise<PreparedMediaDownload | undefined> {
  cancel.throwIfAborted();
  if (window.top !== window) throw new Error("Open T3 Code in its own tab to save this video.");
  const url = await verifyPreviewIssuer(environmentId, issuedUrl);
  cancel.throwIfAborted();
  url.hash = "";
  if (requiresDesktopRelayTransport(url.href)) {
    const relay = window.desktopBridge?.relayTransport;
    if (!relay?.saveMedia) throw new Error("This desktop app cannot save verified relay videos.");
    await relay.saveMedia(url.href, name);
    return;
  }

  const binding = { environmentId, httpsOrigin: url.origin };
  const admission = assertHostedRelayAdmission(binding);
  if (!admission) throw new Error("The verified download connection is unavailable.");
  const assertCurrentAdmission = () => {
    if (assertHostedRelayAdmission(binding) !== admission) {
      throw new Error("The verified download connection is unavailable.");
    }
  };
  if (savingInTab) throw new Error("Finish the current video download before starting another.");

  const lifetime = new AbortController();
  const activity = AbortSignal.any([cancel, admission, lifetime.signal]);
  const transfer = AbortSignal.any([activity, AbortSignal.timeout(RELAY_MEDIA_DOWNLOAD_MS)]);
  window.addEventListener("pagehide", () => lifetime.abort(), {
    once: true,
    signal: lifetime.signal,
  });
  let ready = false;
  savingInTab = true;
  try {
    transfer.throwIfAborted();
    const storedDownload = !destination && supportsMediaDownloadStorage();
    const maxBytes = destination
      ? MAX_FILE_BYTES
      : storedDownload
        ? OPFS_MAX_DOWNLOAD_BYTES
        : MAX_BUFFER_BYTES;
    const tooLarge = destination
      ? "This file exceeds the download size limit."
      : storedDownload
        ? "This browser can prepare downloads up to 4 GiB."
        : "This browser can save up to 256 MiB without a file picker or temporary download storage.";
    const download = await openRelayMediaDownload(
      (headers, signal) => {
        assertCurrentAdmission();
        return fetchHostedRelayResource(url, { headers, signal }).catch(() => {
          signal.throwIfAborted();
          throw new Error("Unable to download the file from the verified environment.");
        });
      },
      { signal: transfer, maxBytes, tooLarge },
    );
    const response = new Response(download.body, {
      headers: {
        "content-type": download.mimeType,
        "content-length": String(download.length),
      },
    });
    if (destination) {
      await writeMediaDownload(
        response,
        () => destination.createWritable(),
        maxBytes,
        transfer,
        tooLarge,
      );
    } else if (storedDownload) {
      let temporary: Awaited<ReturnType<typeof openMediaDownloadStorage>> | undefined;
      try {
        await writeMediaDownload(
          response,
          async (length) => {
            temporary = await openMediaDownloadStorage(length, transfer);
            transfer.throwIfAborted();
            return temporary.file.createWritable();
          },
          maxBytes,
          transfer,
          tooLarge,
        );
        if (!temporary) throw new Error("The browser could not prepare the download.");
        const file = await temporary.file.getFile();
        transfer.throwIfAborted();
        const stored = offerStoredMediaDownload(file, name, temporary.remove, activity);
        ready = true;
        return {
          download() {
            try {
              assertCurrentAdmission();
              activity.throwIfAborted();
              stored.download();
            } catch (error) {
              lifetime.abort(error);
              throw error;
            }
          },
          dispose: () => lifetime.abort(),
        };
      } catch (error) {
        // A native write can still hold the file lock after cancellation.
        void temporary?.remove();
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          throw new Error("There is not enough browser storage to prepare this download.", {
            cause: error,
          });
        }
        throw error;
      }
    } else {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      await writeMediaDownload(
        response,
        async () =>
          new WritableStream({
            write(chunk) {
              chunks.push(chunk);
            },
          }),
        maxBytes,
        transfer,
        tooLarge,
      );
      transfer.throwIfAborted();
      await downloadMedia(new Blob(chunks, { type: download.mimeType }), name);
    }
  } finally {
    savingInTab = false;
    if (!ready) lifetime.abort();
  }
}
