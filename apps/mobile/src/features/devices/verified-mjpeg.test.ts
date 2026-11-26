import { expect, it } from "vite-plus/test";

import { readMjpegFrames } from "./verified-mjpeg";

it("yields complete frames across split headers and bodies without reading past a frame", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of [
        "--frame\r\nContent-Len",
        "gth: 3\r\n\r\nxy",
        "z\r\n--frame\r\nContent-Length: 1\r\n\r\na\r\n",
      ]) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  const frames = readMjpegFrames(stream);
  expect(await frames.next()).toEqual({ done: false, value: encoder.encode("xyz") });
  expect(await frames.next()).toEqual({ done: false, value: encoder.encode("a") });
  expect((await frames.next()).done).toBe(true);
});

it("refuses an oversized frame before buffering its body", async () => {
  const body = new Response("--frame\r\nContent-Length: 999999999\r\n\r\n").body!;
  await expect(readMjpegFrames(body).next()).rejects.toThrow("Invalid MJPEG frame length");
});
