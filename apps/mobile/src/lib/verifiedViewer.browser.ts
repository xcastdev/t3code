function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

type ViewerReply = {
  readonly type: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
  readonly binary?: string;
  readonly text?: string;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
};

declare global {
  interface Window {
    T3VerifiedViewer?: (id: number, reply: ViewerReply) => void;
  }
}

export function installVerifiedViewerTransport() {
  if (window.T3VerifiedViewer) return;
  const pending = new Map<number, (reply: ViewerReply) => void>();
  let nextId = 0;
  const post = (viewerTransport: string, id: number, payload?: object) =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
    window.ReactNativeWebView.postMessage(JSON.stringify({ viewerTransport, id, ...payload }));
  window.T3VerifiedViewer = (id, reply) => pending.get(id)?.(reply);

  class ViewerSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly #id = ++nextId;
    readyState = ViewerSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    constructor(url: string | URL) {
      super();
      pending.set(this.#id, (reply) => {
        if (reply.type === "open" && this.readyState === ViewerSocket.CONNECTING) {
          this.readyState = ViewerSocket.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        } else if (reply.type === "message" && this.readyState === ViewerSocket.OPEN) {
          const event = new MessageEvent("message", {
            data: reply.binary === undefined ? reply.text : decode(reply.binary).buffer,
          });
          this.dispatchEvent(event);
          this.onmessage?.(event);
        } else if (reply.type === "close") {
          pending.delete(this.#id);
          this.readyState = ViewerSocket.CLOSED;
          const event = new CloseEvent("close", {
            code: reply.code ?? 1006,
            reason: reply.reason ?? "",
            wasClean: reply.wasClean ?? false,
          });
          this.dispatchEvent(event);
          this.onclose?.(event);
        }
      });
      post("connect", this.#id, { url: url.toString() });
    }

    send(value: string | ArrayBuffer | ArrayBufferView) {
      if (this.readyState !== ViewerSocket.OPEN) return;
      if (typeof value === "string") post("send", this.#id, { text: value });
      else {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        post("send", this.#id, { binary: encode(bytes) });
      }
    }

    close() {
      if (this.readyState >= ViewerSocket.CLOSING) return;
      this.readyState = ViewerSocket.CLOSING;
      post("close", this.#id);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", { value: ViewerSocket });
  globalThis.fetch = async (input, init) => {
    const id = ++nextId;
    const request = new Request(input, init);
    const { signal } = request;
    signal.throwIfAborted();
    const body = request.body ? await request.text() : undefined;
    signal.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let multipartBoundary: string | undefined;
      let partHeader: Uint8Array | undefined;
      let waiting: (() => void) | undefined;
      let queued: Uint8Array | undefined;
      const cleanup = () => {
        pending.delete(id);
        signal.removeEventListener("abort", abort);
        waiting?.();
        waiting = undefined;
        queued = undefined;
      };
      const fail = (error: unknown) => {
        controller?.error(error);
        reject(error);
        cleanup();
      };
      const abort = () => {
        post("cancel", id);
        fail(signal.reason);
      };
      const deliver = () => {
        if (!waiting || !queued) return;
        controller?.enqueue(queued);
        queued = undefined;
        waiting();
        waiting = undefined;
        post("pull", id);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.set(id, (reply) => {
        switch (reply.type) {
          case "headers": {
            const headers = new Headers(reply.headers);
            const contentType = headers.get("content-type") ?? "";
            // URLSession strips MJPEG boundaries and emits each part's headers separately.
            if (controller) {
              const length = Number(headers.get("content-length"));
              if (
                multipartBoundary &&
                /^image\/jpeg\b/i.test(contentType) &&
                Number.isSafeInteger(length) &&
                length > 0
              ) {
                partHeader = new TextEncoder().encode(
                  `\r\n--${multipartBoundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`,
                );
              }
              break;
            }
            if (/^multipart\/x-mixed-replace\s*;/i.test(contentType)) {
              const boundary = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
              multipartBoundary = boundary?.[1] ?? boundary?.[2];
            }
            const responseBody = new ReadableStream<Uint8Array>(
              {
                start(stream) {
                  controller = stream;
                },
                pull() {
                  return new Promise<void>((ready) => {
                    waiting = ready;
                    deliver();
                  });
                },
                cancel() {
                  post("cancel", id);
                  cleanup();
                },
              },
              { highWaterMark: 0 },
            );
            if ([204, 205, 304].includes(reply.status)) {
              void responseBody.cancel();
              resolve(new Response(null, reply));
            } else resolve(new Response(responseBody, reply));
            break;
          }
          case "chunk": {
            const bytes = decode(reply.binary ?? "");
            if (partHeader) {
              queued = new Uint8Array(partHeader.length + bytes.length);
              queued.set(partHeader);
              queued.set(bytes, partHeader.length);
              partHeader = undefined;
            } else queued = bytes;
            deliver();
            break;
          }
          case "end":
            controller?.close();
            cleanup();
            break;
          case "response":
            resolve(
              new Response(
                [204, 205, 304].includes(reply.status) ? null : decode(reply.bodyBase64),
                reply,
              ),
            );
            cleanup();
            break;
          case "failure":
            fail(new TypeError("Verified viewer request failed."));
            break;
        }
      });
      post("fetch", id, {
        url: request.url,
        method: request.method,
        headers: Array.from(request.headers.entries()),
        body,
      });
    });
  };
}
