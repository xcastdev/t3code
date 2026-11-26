import { describe, expect, it, vi } from "vite-plus/test";

import { installVerifiedViewerTransport } from "../../lib/verifiedViewer.browser";
import { start, stop } from "./device-stream.browser";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    length >>> 24,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

function viewerFixture(supported: boolean) {
  vi.useFakeTimers();
  const configured: string[] = [];
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = async () => ({ supported });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure(config: VideoDecoderConfig) {
        configured.push(config.codec);
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
    },
  );
  const videoBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requested.push(new URL(url).pathname);
    if (!url.includes("stream.avcc")) return Promise.resolve(new Response(null));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            videoBodies.push(body);
            init.signal?.addEventListener("abort", () => body.error(new Error("aborted")));
          },
        }),
      ),
    );
  });
  vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
  start({
    platform: "ios",
    deviceId: "sim",
    access: {
      httpBase: "https://environment.test/api/device-hub",
      wsBase: "wss://environment.test/api/device-hub",
      credentials: false,
      query: {},
    },
    colors: {
      background: "black",
      foreground: "white",
      muted: "gray",
      buttonBackground: "black",
      buttonForeground: "white",
      buttonBorder: "gray",
    },
  });
  return { configured, requested, videoBodies };
}

describe("native iOS simulator viewer", () => {
  it.each([
    { supported: true, image: "" },
    { supported: false, image: "/api/device-hub/vendor/serve-sim/helper/sim/stream.mjpeg" },
  ])(
    "streams H.264 when WebCodecs decodes it, else MJPEG (supported: $supported)",
    async ({ supported, image }) => {
      try {
        const { configured, requested, videoBodies } = viewerFixture(supported);
        await vi.advanceTimersByTimeAsync(0);
        expect(requested).toContain("/api/device-hub/vendor/serve-sim/helper/sim/stream.avcc");
        videoBodies[0]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0x00, 0x33])));
        await vi.advanceTimersByTimeAsync(0);
        expect(configured).toEqual(supported ? ["avc1.640033"] : []);
        const img = document.querySelector("img")!;
        expect(img.src && new URL(img.src).pathname).toBe(image);
        expect(img.style.display).toBe(supported ? "none" : "block");
      } finally {
        stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});

it.each([
  { format: "raw AVCC", nativeMjpeg: false },
  { format: "iOS multipart MJPEG", nativeMjpeg: true },
])("keeps $format and binary control on the verified WebView bridge", async ({ nativeMjpeg }) => {
  const messages: Array<{ viewerTransport: string; id: number; url?: string; binary?: string }> =
    [];
  const emitted = Promise.withResolvers<number>();
  const pulled = Promise.withResolvers<void>();
  const cancel = Promise.withResolvers<void>();
  const fallback = vi.fn();
  vi.stubGlobal("fetch", fallback);
  vi.stubGlobal("WebSocket", vi.fn());
  vi.stubGlobal("T3VerifiedViewer", undefined);
  vi.stubGlobal("ReactNativeWebView", {
    postMessage(data: string) {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.viewerTransport === "fetch") emitted.resolve(message.id);
      if (message.viewerTransport === "pull") pulled.resolve();
      if (message.viewerTransport === "cancel") cancel.resolve();
    },
  });
  try {
    installVerifiedViewerTransport();
    const media = `https://relay.test/api/device-hub/helper/sim/stream.${nativeMjpeg ? "mjpeg" : "avcc"}?wsTicket=signed`;
    const input = "wss://relay.test/api/device-hub/helper/ws?wsTicket=signed";
    const request = fetch(media);
    const id = await emitted.promise;
    const reply = (type: string, payload?: object) =>
      window.T3VerifiedViewer!(id, { type, status: 200, headers: {}, bodyBase64: "", ...payload });
    reply("headers", {
      headers: {
        "Content-Type": nativeMjpeg ? 'multipart/x-mixed-replace; boundary="frame"' : "video/h264",
      },
    });
    const reader = (await request).body!.getReader();
    if (nativeMjpeg) {
      reply("headers", { headers: { "Content-Type": "image/jpeg", "Content-Length": "3" } });
    }
    reply("chunk", { binary: "AQID" });
    expect(messages.some((message) => message.viewerTransport === "pull")).toBe(false);
    const read = reader.read();
    await pulled.promise;
    const delivered = await Promise.race([read, Promise.resolve(undefined)]);
    expect(delivered?.done).toBe(false);
    expect(new TextDecoder().decode(delivered?.value)).toBe(
      nativeMjpeg
        ? "\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n\x01\x02\x03"
        : "\x01\x02\x03",
    );
    await reader.cancel();
    await cancel.promise;
    const socket = new WebSocket(input);
    const socketId = messages.at(-1)!.id;
    window.T3VerifiedViewer!(socketId, { type: "open", status: 0, headers: {}, bodyBase64: "" });
    socket.send(Uint8Array.of(3, 4));
    expect(messages).toContainEqual({
      viewerTransport: "fetch",
      id,
      url: media,
      method: "GET",
      headers: [],
    });
    expect(messages).toContainEqual({ viewerTransport: "connect", id: socketId, url: input });
    expect(messages.at(-1)).toEqual({ viewerTransport: "send", id: socketId, binary: "AwQ=" });
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
