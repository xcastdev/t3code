/* global clients, self */
const MEDIA_PREFIX = "/__t3code/media/";
const MAX_LEASE_MS = 60 * 60_000;
const MAX_REQUEST_MS = 10 * 60_000;
const RESPONSE_TIMEOUT_MS = 20_000;
const MAX_LEASES = 512;
const MAX_REQUESTS = 32;
const MAX_CLIENT_REQUESTS = 4;
const MAX_CHUNK_BYTES = 64 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const leases = new Map();
const pendingByClient = new Map();
let pending = 0;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

self.addEventListener("message", (event) => {
  const { source, data } = event;
  const port = event.ports[0];
  if (source?.type !== "window" || source.frameType !== "top-level" || !UUID.test(data?.id)) {
    port?.close();
    return;
  }
  if (data.type === "t3-media-release") {
    const lease = leases.get(data.id);
    if (lease?.owner === source.id) {
      leases.delete(data.id);
      for (const cancel of lease.active) cancel();
    }
    return;
  }
  if (data.type !== "t3-media-register" || !port) return;
  const now = Date.now();
  for (const [id, lease] of leases) {
    if (lease.expiresAt <= now) leases.delete(id);
  }
  if (
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= now ||
    data.expiresAt - now > MAX_LEASE_MS ||
    (data.destination !== "audio" && data.destination !== "video") ||
    leases.has(data.id) ||
    leases.size >= MAX_LEASES
  ) {
    port.postMessage("refused");
  } else {
    leases.set(data.id, {
      owner: source.id,
      destination: data.destination,
      expiresAt: data.expiresAt,
      active: new Set(),
    });
    port.postMessage("ready");
  }
  port.close();
});

const localFailure = (status) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

async function proxyMedia(event, url, release) {
  const { request, clientId } = event;
  const id = url.pathname.slice(MEDIA_PREFIX.length);
  const lease = leases.get(id);
  if (!UUID.test(id) || url.search || !lease || lease.expiresAt <= Date.now())
    return localFailure(410);
  if (lease.owner !== clientId || lease.destination !== request.destination)
    return localFailure(403);
  if (request.method !== "GET" && request.method !== "HEAD") return localFailure(405);
  const range = request.headers.get("range");
  if (range !== null && !/^bytes=(?:\d{1,12}-\d{0,12}|-\d{1,12})$/.test(range)) {
    return localFailure(416);
  }
  const client = await clients.get(clientId);
  if (
    !client ||
    request.signal.aborted ||
    leases.get(id) !== lease ||
    lease.expiresAt <= Date.now()
  ) {
    return localFailure(410);
  }
  const clientPending = pendingByClient.get(clientId) ?? 0;
  if (pending >= MAX_REQUESTS || clientPending >= MAX_CLIENT_REQUESTS) return localFailure(503);
  pending++;
  pendingByClient.set(clientId, clientPending + 1);

  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    let closed = false;
    let reader;
    let body;
    let credit;
    const timer = setTimeout(cancel, Math.min(MAX_REQUEST_MS, lease.expiresAt - Date.now()));
    const responseTimer = setTimeout(cancel, RESPONSE_TIMEOUT_MS);
    function finish(message) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(responseTimer);
      pending--;
      const remaining = pendingByClient.get(clientId) - 1;
      if (remaining === 0) pendingByClient.delete(clientId);
      else pendingByClient.set(clientId, remaining);
      request.signal.removeEventListener("abort", cancel);
      lease.active.delete(cancel);
      port1.postMessage(message);
      port1.close();
      release();
    }
    function cancel() {
      if (closed) return;
      const error = new Error("Media request ended.");
      resolve(localFailure(410));
      body?.error(error);
      credit?.();
      void reader?.cancel(error).catch(() => undefined);
      finish("cancel");
    }

    lease.active.add(cancel);
    request.signal.addEventListener("abort", cancel, { once: true });
    port1.onmessageerror = cancel;
    port1.onmessage = ({ data }) => {
      if (closed) return;
      if (body) {
        if (data === "abort" || !credit) {
          cancel();
          return;
        }
        const acknowledge = credit;
        credit = undefined;
        if (data === "eof") {
          body.close();
          finish("done");
        } else if (
          data instanceof Uint8Array &&
          data.byteLength > 0 &&
          data.byteLength <= MAX_CHUNK_BYTES
        ) {
          body.enqueue(data);
        } else {
          cancel();
        }
        acknowledge();
        return;
      }
      if (data?.status !== 200 && data?.status !== 206 && data?.status !== 416) {
        resolve(localFailure(data?.status === 410 ? 410 : 502));
        finish("cancel");
        return;
      }
      clearTimeout(responseTimer);
      const headers = new Headers({
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
        if (typeof data.headers?.[name] === "string") headers.set(name, data.headers[name]);
      }
      if (request.method === "HEAD" || data.status === 416) {
        resolve(new Response(null, { status: data.status, headers }));
        finish("done");
        return;
      }
      try {
        if (data.body instanceof ReadableStream) reader = data.body.getReader();
        else if (data.chunks !== true) throw new Error("Missing media response body.");
        const stream = new ReadableStream(
          {
            start(controller) {
              body = controller;
              if (reader) {
                port1.onmessage = () => cancel();
              }
            },
            async pull() {
              if (!reader) {
                await new Promise((acknowledge) => {
                  credit = acknowledge;
                  port1.postMessage("credit");
                });
                return;
              }
              try {
                const { value, done } = await reader.read();
                if (closed) return;
                if (done) {
                  body.close();
                  finish("done");
                } else {
                  body.enqueue(value);
                }
              } catch {
                cancel();
              }
            },
            cancel() {
              void reader?.cancel().catch(() => undefined);
              credit?.();
              finish("cancel");
            },
          },
          { highWaterMark: 0 },
        );
        resolve(new Response(stream, { status: data.status, headers }));
      } catch {
        cancel();
      }
    };
    try {
      client.postMessage(
        {
          type: "t3-media-fetch",
          id,
          method: request.method,
          destination: request.destination,
          range,
        },
        [port2],
      );
    } catch {
      port2.close();
      cancel();
    }
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(MEDIA_PREFIX)) return;
  let release;
  event.waitUntil(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  event.respondWith(
    proxyMedia(event, url, release).then(
      (response) => {
        if (response.body === null) release();
        return response;
      },
      () => {
        release();
        return localFailure(502);
      },
    ),
  );
});
