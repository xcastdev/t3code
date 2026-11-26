import type {
  DesktopRelayBridge,
  DesktopRelayCommand,
  DesktopRelayEvent,
  DesktopRelayMediaKind,
} from "@t3tools/contracts";

const chunkSize = 64 * 1024;
const maxSocketBuffer = 16 * 1024 * 1024;

const bridge = () =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.relayTransport;

function resolveUrl(value: string | URL): URL | null {
  return URL.parse(String(value), typeof window === "undefined" ? undefined : window.location.href);
}

export function desktopRelayAdmissionRequired(url: string | URL): boolean {
  const resolved = resolveUrl(url);
  return (
    resolved !== null &&
    (bridge()?.origins.includes(resolved.origin.replace(/^(?:ws|wss|http):/, "https:")) ?? false)
  );
}

const unavailable = () => new TypeError("Desktop relay transport failed.");

export class DesktopRelayOutcomeUnknown extends TypeError {
  override readonly name = "DesktopRelayOutcomeUnknown";

  constructor() {
    super("The relay disconnected before the outcome of the request was known.");
  }
}

export function fetchDesktopRelayResource(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const inputUrl = input instanceof Request ? input.url : String(input);
  if (!desktopRelayAdmissionRequired(inputUrl)) return globalThis.fetch(input, init);
  return Promise.resolve().then(() => {
    const transport = bridge();
    const url = resolveUrl(inputUrl);
    if (
      transport === undefined ||
      url?.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (init?.redirect !== undefined && init.redirect !== "error")
    )
      throw unavailable();
    const request = new Request(input, { ...init, credentials: "omit", redirect: "error" });
    return relayFetch(transport, request);
  });
}

function relayFetch(transport: DesktopRelayBridge, request: Request): Promise<Response> {
  const signal = request.signal;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let receiveCredit: (() => void) | undefined;
    let leftover: Uint8Array | undefined;
    let done = false;
    const upload = request.body?.getReader();
    const cleanup = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      void upload?.cancel().catch(() => {});
      receiveCredit?.();
    };
    const fail = (error: unknown) => {
      if (done) return;
      controller?.error(error);
      reject(error);
      send?.({ type: "abort" });
      cleanup();
    };
    const abort = () =>
      fail(
        send !== undefined && request.method !== "GET" && request.method !== "HEAD"
          ? new DesktopRelayOutcomeUnknown()
          : signal.reason,
      );
    let send: ((command: DesktopRelayCommand) => void) | undefined;
    const sendUpload = async () => {
      if (upload === undefined) throw unavailable();
      while (leftover === undefined) {
        const item = await upload.read();
        if (done) return;
        if (item.done) {
          send?.({ type: "uploadEnd" });
          return;
        }
        if (item.value.byteLength > 0) leftover = item.value;
      }
      if (done || leftover === undefined) return;
      const bytes = leftover.slice(0, chunkSize);
      leftover =
        leftover.byteLength > bytes.byteLength ? leftover.subarray(bytes.byteLength) : undefined;
      send?.({ type: "upload", bytes });
    };

    const receive = (event: DesktopRelayEvent) => {
      if (done) return;
      switch (event.type) {
        case "uploadPull":
          void sendUpload().catch(fail);
          break;
        case "response": {
          const body = event.body
            ? new ReadableStream<Uint8Array>(
                {
                  start(value) {
                    controller = value;
                  },
                  pull() {
                    return new Promise<void>((credit) => {
                      receiveCredit = credit;
                      send?.({ type: "pull" });
                    });
                  },
                  cancel() {
                    send?.({ type: "abort" });
                    cleanup();
                  },
                },
                { highWaterMark: 0 },
              )
            : null;
          try {
            resolve(
              new Response(body, {
                status: event.status,
                statusText: event.statusText,
                headers: event.headers.map(([key, value]) => [key, value]),
              }),
            );
            if (!event.body) cleanup();
          } catch (error) {
            fail(error);
          }
          break;
        }
        case "bytes": {
          controller?.enqueue(event.bytes);
          receiveCredit?.();
          receiveCredit = undefined;
          break;
        }
        case "end":
          controller?.close();
          cleanup();
          break;
        case "error":
          fail(event.outcomeUnknown ? new DesktopRelayOutcomeUnknown() : unavailable());
          break;
      }
    };
    try {
      send = transport.open(
        {
          kind: "http",
          url: request.url,
          method: request.method,
          headers: [...request.headers],
          body: upload !== undefined,
        },
        receive,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    } catch (error) {
      fail(error);
    }
  });
}

class DesktopRelaySocket extends EventTarget {
  #state: number = WebSocket.CONNECTING;
  #send: ((command: DesktopRelayCommand) => void) | undefined;
  #buffered = 0;
  #queuedFrames = 0;
  #protocol = "";
  #extensions = "";
  #write = Promise.resolve();
  binaryType: BinaryType = "blob";
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  readonly url: string;

  constructor(transport: DesktopRelayBridge, url: string, protocols: readonly string[]) {
    super();
    this.url = url;
    // A caller can close() immediately after construction without starting TLS or consuming a ticket.
    queueMicrotask(() => {
      if (this.#state !== WebSocket.CONNECTING) {
        this.#closed(1006, "");
        return;
      }
      try {
        this.#send = transport.open({ kind: "socket", url, protocols }, (event) => {
          switch (event.type) {
            case "open": {
              if (this.#state !== WebSocket.CONNECTING) return;
              this.#state = WebSocket.OPEN;
              this.#protocol = event.protocol;
              this.#extensions = event.extensions;
              this.#emit(new Event("open"), this.onopen);
              this.#send?.({ type: "pull" });
              break;
            }
            case "message": {
              const byteData =
                typeof event.data === "string" ? event.data : new Uint8Array(event.data).buffer;
              const data =
                typeof byteData === "string" || this.binaryType === "arraybuffer"
                  ? byteData
                  : new Blob([byteData]);
              this.#emit(new MessageEvent("message", { data }), this.onmessage);
              this.#send?.({ type: "pull" });
              break;
            }
            case "sent":
              this.#buffered -= event.bytes;
              this.#queuedFrames -= 1;
              break;
            case "close":
              this.#closed(event.code, event.reason);
              break;
            case "error":
              this.#failed();
              break;
          }
        });
      } catch {
        this.#failed();
      }
    });
  }

  get CONNECTING() {
    return WebSocket.CONNECTING;
  }
  get OPEN() {
    return WebSocket.OPEN;
  }
  get CLOSING() {
    return WebSocket.CLOSING;
  }
  get CLOSED() {
    return WebSocket.CLOSED;
  }
  get readyState() {
    return this.#state;
  }
  get bufferedAmount() {
    return this.#buffered;
  }
  get protocol() {
    return this.#protocol;
  }
  get extensions() {
    return this.#extensions;
  }

  #emit<T extends Event>(event: T, handler: ((this: WebSocket, event: T) => void) | null) {
    this.dispatchEvent(event);
    handler?.call(this as unknown as WebSocket, event);
  }

  #closed(code: number, reason: string) {
    if (this.#state === WebSocket.CLOSED) return;
    this.#state = WebSocket.CLOSED;
    this.#send = undefined;
    this.#emit(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }), this.onclose);
  }

  #failed() {
    if (this.#state === WebSocket.CLOSED) return;
    this.#send?.({ type: "abort" });
    this.#emit(new Event("error"), this.onerror);
    this.#closed(1006, "");
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
    if (this.#state === WebSocket.CONNECTING)
      throw new DOMException("WebSocket is connecting.", "InvalidStateError");
    if (this.#state !== WebSocket.OPEN) return;
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).length
        : data instanceof Blob
          ? data.size
          : data.byteLength;
    if (this.#buffered + size > maxSocketBuffer || this.#queuedFrames >= 128) {
      this.#failed();
      return;
    }
    this.#buffered += size;
    this.#queuedFrames += 1;
    const bytes =
      typeof data === "string" || data instanceof Blob
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
          : new Uint8Array(data).slice();
    this.#write = this.#write
      .then(async () => {
        const payload = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
        if (this.#state === WebSocket.OPEN || this.#state === WebSocket.CLOSING)
          this.#send?.({ type: "send", data: payload });
      })
      .catch(() => this.#failed());
  }

  close(code = 1000, reason = "") {
    if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999))
      throw new DOMException("Invalid WebSocket close code.", "InvalidAccessError");
    if (new TextEncoder().encode(reason).length > 123)
      throw new DOMException("WebSocket close reason exceeds 123 bytes.", "SyntaxError");
    if (this.#state >= WebSocket.CLOSING) return;
    this.#state = WebSocket.CLOSING;
    if (this.#send !== undefined) {
      void this.#write.then(() => this.#send?.({ type: "close", code, reason }));
    }
  }
}

export function createDesktopRelayWebSocketConstructor(): typeof WebSocket {
  return new Proxy(globalThis.WebSocket, {
    construct(NativeSocket, [rawUrl, offered]: ConstructorParameters<typeof WebSocket>) {
      if (!desktopRelayAdmissionRequired(rawUrl)) return new NativeSocket(rawUrl, offered);
      const transport = bridge();
      const url = resolveUrl(rawUrl);
      if (
        transport === undefined ||
        url === null ||
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "wss:" && url.protocol !== "https:")
      )
        throw unavailable();
      if (url.protocol === "https:") url.protocol = "wss:";
      const protocols = typeof offered === "string" ? [offered] : [...(offered ?? [])];
      return new DesktopRelaySocket(transport, url.href, protocols);
    },
  });
}

export async function createDesktopRelayMediaLease(
  input: string | URL,
  kind: DesktopRelayMediaKind,
): Promise<{ readonly url: string; readonly dispose: () => Promise<void> }> {
  const transport = bridge();
  const url = resolveUrl(input);
  if (transport === undefined || url === null || !desktopRelayAdmissionRequired(url))
    throw unavailable();
  const lease = await transport.createMediaLease(url.href, kind);
  return {
    url: lease,
    dispose: () => transport.disposeMediaLease(lease).catch(() => {}),
  };
}
