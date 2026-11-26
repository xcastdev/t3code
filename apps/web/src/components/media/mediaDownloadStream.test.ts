import { expect, it, vi } from "vite-plus/test";

import { writeMediaDownload } from "./mediaDownloadStream";

const chunkBytes = 64 * 1024;

it("streams more than 256 MiB through one outstanding write and preserves the bytes", async () => {
  const chunkCount = 4097;
  const firstWrite = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let reads = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (reads === chunkCount) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(chunkBytes);
        chunk[0] = reads % 251;
        chunk[chunkBytes - 1] = (reads + 17) % 251;
        reads++;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  let writes = 0;
  let correctBytes = true;
  const close = vi.fn();
  const sink = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (writes === 0) {
        firstWrite.resolve();
        await resume.promise;
      }
      correctBytes &&=
        chunk.byteLength === chunkBytes &&
        chunk[0] === writes % 251 &&
        chunk[chunkBytes - 1] === (writes + 17) % 251;
      writes++;
    },
    close,
  });
  const saving = writeMediaDownload(
    new Response(source, { headers: { "content-length": String(chunkCount * chunkBytes) } }),
    async () => sink,
    16 * 1024 ** 3,
    new AbortController().signal,
  );

  await firstWrite.promise;
  expect(reads).toBeLessThanOrEqual(2);
  resume.resolve();
  await saving;
  expect(writes).toBe(chunkCount);
  expect(correctBytes).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  { limit: 8, declared: null, description: "an undeclared response exceeds the limit" },
  { limit: 16, declared: "8", description: "the server returns more than it declared" },
  { limit: 16, declared: "12", description: "the server returns fewer bytes than declared" },
])("aborts the destination when $description", async ({ limit, declared }) => {
  const abort = vi.fn();
  const close = vi.fn();
  const sink = new WritableStream<Uint8Array>({ abort, close });
  const response = new Response(new Uint8Array(10), {
    headers: declared === null ? {} : { "content-length": declared },
  });
  await expect(
    writeMediaDownload(response, async () => sink, limit, new AbortController().signal),
  ).rejects.toThrow();
  expect(abort).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("cancels before opening a destination when the response declares an oversize file", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
    headers: { "content-length": "268435457" },
  });
  const openSink = vi.fn(async () => new WritableStream<Uint8Array>());
  await expect(
    writeMediaDownload(response, openSink, 256 * 1024 ** 2, new AbortController().signal),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(openSink).not.toHaveBeenCalled();
});

it("propagates cancellation to the outstanding upstream read and aborts the destination", async () => {
  const pendingRead = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const abort = vi.fn();
  const close = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          pendingRead.resolve();
          return new Promise<void>(() => {});
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
  const sink = new WritableStream<Uint8Array>({ abort, close });
  const controller = new AbortController();
  const saving = writeMediaDownload(response, async () => sink, 16, controller.signal);

  await pendingRead.promise;
  controller.abort();
  await expect(saving).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(abort).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("cancels the source and settles without waiting for an outstanding disk write", async () => {
  const writing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const sink = new WritableStream<Uint8Array>({
    write() {
      writing.resolve();
      return resume.promise;
    },
    abort() {
      aborted.resolve();
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel,
  });
  const controller = new AbortController();
  const saving = writeMediaDownload(new Response(body), async () => sink, 16, controller.signal);
  const rejected = expect(saving).rejects.toMatchObject({ name: "AbortError" });
  await writing.promise;
  controller.abort();
  try {
    expect(cancel).toHaveBeenCalledOnce();
    await rejected;
  } finally {
    resume.resolve();
    await rejected;
  }
  await aborted.promise;
});
