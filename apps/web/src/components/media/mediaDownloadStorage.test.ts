import { expect, it, vi } from "vite-plus/test";

import {
  offerStoredMediaDownload,
  reserveMediaDownloadFile,
  type MediaDownloadDirectory,
} from "./mediaDownloadStorage";

function directory(files: readonly string[] = []) {
  const entries = new Set(files);
  const getFileHandle = vi.fn(async (name: string) => {
    entries.add(name);
    return { retrieve: () => name };
  });
  const removeEntry = vi.fn(async (name: string) => {
    entries.delete(name);
  });
  const handle: MediaDownloadDirectory<{ retrieve: () => string }> = {
    keys: async function* () {
      yield* entries;
    },
    getFileHandle,
    removeEntry,
  };
  return { handle, entries, getFileHandle, removeEntry };
}

const ownerId = "12345678-1111-2222-3333-123456789123";
const downloadId = "12345678-1111-2222-3333-123456789456";
const unrelated = "keep-this-file";
const previousOwner = "12345678-9999-8888-7777-123456789789";

it("prunes expired app temp files while leaving another tab's live file intact", async () => {
  const expired = `1000-${previousOwner}-${downloadId}.part`;
  const live = `2001-${previousOwner}-${downloadId}.part`;
  const { handle, entries } = directory([expired, live, unrelated]);

  const reserved = await reserveMediaDownloadFile(handle, ownerId, downloadId, 2000);
  const name = reserved.file.retrieve();
  expect(name).toContain(ownerId);
  expect(entries).toEqual(new Set([live, unrelated, name]));

  await reserved.remove();
  expect(entries).toEqual(new Set([live, unrelated]));
});

it("refuses another slot while four tabs have retained files", async () => {
  const files = [3000, 3100, 3200, 3300].map(
    (expiry) => `${expiry}-${previousOwner}-${downloadId}.part`,
  );
  const { handle, entries, getFileHandle } = directory(files);

  await expect(reserveMediaDownloadFile(handle, ownerId, downloadId, 2000)).rejects.toThrow();
  expect(getFileHandle).not.toHaveBeenCalled();
  expect(entries).toEqual(new Set(files));
});

it("removes a staged file when its relay admission ends before the user clicks Download", async () => {
  const remove = vi.fn(async () => {});
  const controller = new AbortController();
  const prepared = offerStoredMediaDownload(
    new File(["exact video bytes"], "private.part"),
    "original.mp4",
    remove,
    controller.signal,
  );

  controller.abort();

  expect(remove).toHaveBeenCalledOnce();
  expect(() => prepared.download()).toThrow();
});

it("keeps the disk-backed file alive for the browser download manager after handoff", async () => {
  vi.useFakeTimers();
  const file = new File(["exact video bytes"], "private.part");
  using createUrl = vi.spyOn(URL, "createObjectURL");
  using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
  const click = vi.fn();
  const anchor = { href: "", download: "", click };
  vi.stubGlobal("document", { createElement: () => anchor });
  try {
    const remove = vi.fn(async () => {});
    const controller = new AbortController();
    const prepared = offerStoredMediaDownload(file, "original.mp4", remove, controller.signal);

    prepared.download();
    controller.abort();

    expect(createUrl).toHaveBeenCalledWith(file);
    expect(anchor.download).toBe("original.mp4");
    expect(click).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(revokeUrl).toHaveBeenCalledWith(anchor.href);
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
