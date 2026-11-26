import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { saveAdmittedMedia } from "./saveAdmittedMedia";

const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  admission: vi.fn(),
  verify: vi.fn(),
  desktop: vi.fn(),
  download: vi.fn(),
  supportsStorage: vi.fn(),
  openStorage: vi.fn(),
  offer: vi.fn(),
}));

vi.mock("../../browser/readVerifiedPreviewAsset", () => ({
  verifyPreviewIssuer: transport.verify,
}));
vi.mock("../../connection/environmentTransport", () => ({
  requiresDesktopRelayTransport: transport.desktop,
}));
vi.mock("../../connection/hostedRelayAdmission", () => ({
  assertHostedRelayAdmission: transport.admission,
  fetchHostedRelayResource: transport.fetch,
}));
vi.mock("./mediaContent", () => ({ downloadMedia: transport.download }));
vi.mock("./mediaDownloadStorage", () => ({
  supportsMediaDownloadStorage: transport.supportsStorage,
  openMediaDownloadStorage: transport.openStorage,
  offerStoredMediaDownload: transport.offer,
  OPFS_MAX_DOWNLOAD_BYTES: 4 * 1024 ** 3,
}));

const id = EnvironmentId.make("download-host");
const grant = "https://relay.example/api/assets/workspace-file/grant?signature=token#preview";

async function fileETag(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"sha256-${hex}-${"0".repeat(64)}"`;
}

const abcETag =
  '"sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad-' +
  "0".repeat(64) +
  '"';

function setup() {
  transport.fetch.mockReset();
  transport.admission.mockReset().mockReturnValue(new AbortController().signal);
  transport.verify.mockReset().mockResolvedValue(new URL(grant));
  transport.desktop.mockReset().mockReturnValue(false);
  transport.download.mockReset();
  transport.supportsStorage.mockReset().mockReturnValue(false);
  transport.openStorage.mockReset();
  transport.offer.mockReset();
  const app = new EventTarget();
  vi.stubGlobal("window", Object.assign(app, { top: app }));
  return () => vi.unstubAllGlobals();
}

it("fails closed after admission is cleared and never starts a raw request", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  using rawFetch = vi.spyOn(globalThis, "fetch");
  transport.admission.mockReturnValue(undefined);

  await expect(
    saveAdmittedMedia(id, grant, "video.mp4", undefined, new AbortController().signal),
  ).rejects.toThrow("verified download connection");

  expect(transport.fetch).not.toHaveBeenCalled();
  expect(rawFetch).not.toHaveBeenCalled();
  expect(transport.download).not.toHaveBeenCalled();
});

it("preserves original bytes for the bounded fallback on browsers without a disk sink", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  const source = new Uint8Array([0, 255, 137, 60, 0, 118]);
  transport.fetch.mockResolvedValue(
    new Response(source, {
      status: 206,
      headers: {
        "content-length": "6",
        "content-range": "bytes 0-5/6",
        etag: await fileETag(source),
        "content-type": "video/mp4",
      },
    }),
  );

  await saveAdmittedMedia(id, grant, "video.mp4", undefined, new AbortController().signal);

  const blob: Blob = transport.download.mock.calls[0]![0];
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(source);
  expect(transport.download.mock.calls[0]![1]).toBe("video.mp4");
  expect(transport.fetch).toHaveBeenCalledExactlyOnceWith(
    new URL(grant.split("#", 1)[0]!),
    expect.objectContaining({
      headers: { range: "bytes=0-8388607", "x-t3-media-download": "sha-256" },
    }),
  );
});

it("passes the verified signed asset to Electron main and performs no renderer fetch", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  const saveMedia = vi.fn(async () => {});
  const app = { desktopBridge: { relayTransport: { saveMedia } } };
  vi.stubGlobal("window", Object.assign(app, { top: app }));
  transport.desktop.mockReturnValue(true);

  await saveAdmittedMedia(id, grant, "video.mp4", undefined, new AbortController().signal);

  expect(transport.verify).toHaveBeenCalledWith(id, grant);
  expect(saveMedia).toHaveBeenCalledWith(grant.split("#", 1)[0], "video.mp4");
  expect(transport.fetch).not.toHaveBeenCalled();
  expect(transport.download).not.toHaveBeenCalled();
});

it("keeps only one active web transfer per tab and never restarts a canceled request", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  const started = Promise.withResolvers<void>();
  transport.fetch.mockImplementation((_url, { signal }: { signal: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    });
  });
  const controller = new AbortController();
  const pending = saveAdmittedMedia(id, grant, "first.mp4", undefined, controller.signal);
  await started.promise;

  await expect(
    saveAdmittedMedia(id, grant, "second.mp4", undefined, new AbortController().signal),
  ).rejects.toThrow("current video download");

  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(transport.fetch).toHaveBeenCalledOnce();
});

it.each(["expired", "replaced", "unavailable"] as const)(
  "refuses OPFS handoff when current authorization is %s",
  async (change) => {
    using _restore = { [Symbol.dispose]: setup() };
    transport.supportsStorage.mockReturnValue(true);
    const download = vi.fn();
    const remove = vi.fn(async () => {});
    transport.offer.mockReturnValue({ download });
    transport.openStorage.mockResolvedValue({
      file: {
        createWritable: async () => new WritableStream(),
        getFile: async () => new File([], "prepared"),
      },
      remove,
    });
    transport.fetch.mockResolvedValue(
      new Response("abc", {
        status: 200,
        headers: { "content-length": "3", "content-type": "video/mp4", etag: abcETag },
      }),
    );
    const prepared = await saveAdmittedMedia(
      id,
      grant,
      "video.mp4",
      undefined,
      new AbortController().signal,
    );
    expect(prepared).toBeDefined();
    switch (change) {
      case "expired":
        transport.admission.mockImplementation(() => {
          throw new Error("Admission expired");
        });
        break;
      case "replaced":
        transport.admission.mockReturnValue(new AbortController().signal);
        break;
      case "unavailable":
        transport.admission.mockReturnValue(undefined);
        break;
    }
    expect(() => prepared!.download()).toThrow();
    expect(download).not.toHaveBeenCalled();
  },
);

it("holds the next range until the destination finishes writing the first", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  const firstSize = 8 * 1024 ** 2;
  const firstWrite = Promise.withResolvers<void>();
  const allowWrite = Promise.withResolvers<void>();
  const writes: number[] = [];
  const mimeType = "video/mp4";
  const complete = new Uint8Array(firstSize + 1);
  complete[firstSize] = 1;
  const etag = await fileETag(complete);
  transport.fetch
    .mockResolvedValueOnce(
      new Response(new Uint8Array(firstSize), {
        status: 206,
        headers: {
          "content-length": String(firstSize),
          "content-range": `bytes 0-${firstSize - 1}/${firstSize + 1}`,
          "content-type": mimeType,
          etag,
        },
      }),
    )
    .mockResolvedValueOnce(
      new Response(Uint8Array.of(1), {
        status: 206,
        headers: {
          "content-length": "1",
          "content-range": `bytes ${firstSize}-${firstSize}/${firstSize + 1}`,
          "content-type": mimeType,
          etag,
        },
      }),
    );
  const destination = {
    createWritable: async () =>
      new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk.byteLength);
          if (writes.length === 1) {
            firstWrite.resolve();
            return allowWrite.promise;
          }
        },
      }),
  } as FileSystemFileHandle;
  const finished = saveAdmittedMedia(
    id,
    grant,
    "video.mp4",
    destination,
    new AbortController().signal,
  );
  try {
    await Promise.race([firstWrite.promise, finished]);
    expect(transport.fetch).toHaveBeenCalledOnce();
  } finally {
    allowWrite.resolve();
  }
  await finished;
  expect(writes).toEqual([firstSize, 1]);
  expect(transport.fetch).toHaveBeenNthCalledWith(
    2,
    new URL(grant.split("#", 1)[0]!),
    expect.objectContaining({
      headers: {
        range: "bytes=8388608-8388608",
        "if-range": etag,
        "x-t3-media-download": "sha-256",
      },
    }),
  );
});

it("releases the tab slot when an aborted OPFS write still blocks removal", async () => {
  using _restore = { [Symbol.dispose]: setup() };
  const writing = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const removing = Promise.withResolvers<void>();
  const releaseRemove = Promise.withResolvers<void>();
  transport.supportsStorage.mockReturnValue(true);
  transport.openStorage.mockResolvedValue({
    file: {
      createWritable: async () =>
        new WritableStream({
          write() {
            writing.resolve();
            return releaseWrite.promise;
          },
        }),
    },
    remove() {
      removing.resolve();
      return releaseRemove.promise;
    },
  });
  transport.fetch.mockImplementation(
    async () =>
      new Response("abc", {
        headers: { "content-length": "3", "content-type": "video/mp4", etag: abcETag },
      }),
  );

  const cancel = new AbortController();
  const signal = cancel.signal;
  const first = saveAdmittedMedia(id, grant, "first.mp4", undefined, signal);
  const canceled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  try {
    await Promise.race([writing.promise, first]);
    cancel.abort();
    await Promise.race([removing.promise, first]);
    transport.supportsStorage.mockReturnValue(false);
    await saveAdmittedMedia(id, grant, "second.mp4", undefined, new AbortController().signal);
    expect(transport.download).toHaveBeenCalledOnce();
  } finally {
    releaseWrite.resolve();
    releaseRemove.resolve();
    await canceled;
  }
});

it.each(["picker", "opfs"] as const)(
  "aborts the %s writable on a digest mismatch",
  async (sink) => {
    using _restore = { [Symbol.dispose]: setup() };
    const close = vi.fn();
    const abort = vi.fn();
    const remove = vi.fn(async () => {});
    const file: FileSystemFileHandle = {
      kind: "file",
      name: "video.mp4",
      isSameEntry: async () => false,
      createWritable: async () =>
        Object.assign(new WritableStream({ close, abort }), {
          seek: vi.fn(),
          truncate: vi.fn(),
          write: vi.fn(),
        }),
      getFile: vi.fn(),
    };
    transport.supportsStorage.mockReturnValue(sink === "opfs");
    transport.openStorage.mockResolvedValue({ file, remove });
    transport.fetch.mockResolvedValue(
      new Response("bad", {
        headers: { "content-length": "3", "content-type": "video/mp4", etag: abcETag },
      }),
    );

    await expect(
      saveAdmittedMedia(
        id,
        grant,
        "video.mp4",
        sink === "picker" ? file : undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow("file changed");
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(file.getFile).not.toHaveBeenCalled();
    expect(transport.offer).not.toHaveBeenCalled();
    if (sink === "opfs") expect(remove).toHaveBeenCalledOnce();
  },
);
