import { uuidV4Unsafe } from "effect/crypto/SecureRandom";

const DIRECTORY = "t3-media-downloads";
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const TEMP_FILE = new RegExp(`^(\\d{1,16})-${UUID}-${UUID}\\.part$`);
const MAX_RETAINED_FILES = 4;
const TEMP_LIFETIME_MS = 45 * 60_000;
export const OPFS_MAX_DOWNLOAD_BYTES = 4 * 1024 ** 3;
export const READY_DOWNLOAD_MS = 5 * 60_000;
const HANDOFF_MS = 30 * 60_000;

export interface MediaDownloadDirectory<FileHandle> {
  keys(): AsyncIterable<string>;
  getFileHandle(name: string, options: { create: true }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
}

async function pruneMediaDownloads(
  directory: Pick<MediaDownloadDirectory<unknown>, "keys" | "removeEntry">,
  now: number,
) {
  let retained = 0;
  let nextExpiry = Infinity;
  for await (const name of directory.keys()) {
    const matched = TEMP_FILE.exec(name);
    if (!matched) continue;
    const expiry = Number(matched[1]);
    if (expiry > now) {
      retained++;
      nextExpiry = Math.min(nextExpiry, expiry);
    } else {
      await directory.removeEntry(name).catch((error) => {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      });
    }
  }
  return { retained, nextExpiry };
}

export async function reserveMediaDownloadFile<FileHandle>(
  directory: MediaDownloadDirectory<FileHandle>,
  ownerId: string,
  downloadId: string,
  now: number,
) {
  const { retained } = await pruneMediaDownloads(directory, now);
  if (retained >= MAX_RETAINED_FILES) {
    throw new Error("Temporary download storage is full. Try again later.");
  }
  const name = `${now + TEMP_LIFETIME_MS}-${ownerId}-${downloadId}.part`;
  const file = await directory.getFileHandle(name, { create: true });
  const remove = () => directory.removeEntry(name).catch(() => undefined);
  return { file, remove };
}

export function supportsMediaDownloadStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.top === window &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof navigator.locks?.request === "function" &&
    typeof globalThis.FileSystemFileHandle?.prototype.createWritable === "function"
  );
}

async function cleanPreviousDownloads() {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY);
  const { nextExpiry } = await navigator.locks.request(DIRECTORY, () =>
    pruneMediaDownloads(directory, Date.now()),
  );
  if (Number.isFinite(nextExpiry)) {
    setTimeout(cleanPreviousDownloadsOnStartup, Math.max(0, nextExpiry - Date.now()));
  }
}

function cleanPreviousDownloadsOnStartup() {
  void cleanPreviousDownloads().catch(() => undefined);
}

if (supportsMediaDownloadStorage()) cleanPreviousDownloadsOnStartup();

let ownerId: string | undefined;

export async function openMediaDownloadStorage(length: number | null, signal: AbortSignal) {
  const { quota, usage } = await navigator.storage.estimate();
  if (quota !== undefined && usage !== undefined && (length ?? 1) > quota - usage) {
    throw new Error("There is not enough browser storage to prepare this download.");
  }
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
  return navigator.locks.request(DIRECTORY, { signal }, () => {
    signal.throwIfAborted();
    return reserveMediaDownloadFile(
      directory,
      (ownerId ??= uuidV4Unsafe()),
      uuidV4Unsafe(),
      Date.now(),
    );
  });
}

export function offerStoredMediaDownload(
  file: File,
  name: string,
  remove: () => Promise<void>,
  signal: AbortSignal,
) {
  let url: string | undefined;
  const expiresAt = Date.now() + READY_DOWNLOAD_MS;
  let deadline = setTimeout(dispose, READY_DOWNLOAD_MS);
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadline);
    signal.removeEventListener("abort", dispose);
    if (url) URL.revokeObjectURL(url);
    void remove();
  }
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();

  return {
    download() {
      if (disposed || url || Date.now() >= expiresAt) {
        throw new Error("The prepared download expired. Choose Save again.");
      }
      signal.throwIfAborted();
      url = URL.createObjectURL(file);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        // The download manager may continue reading the disk-backed File after the click.
        signal.removeEventListener("abort", dispose);
        clearTimeout(deadline);
        deadline = setTimeout(dispose, HANDOFF_MS);
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
