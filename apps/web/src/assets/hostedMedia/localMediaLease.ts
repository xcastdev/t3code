import { boundRelayMediaRange } from "@t3tools/shared/relayMediaDownload";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";

import {
  isMediaRange,
  mediaResponse,
  type MediaDestination,
  type MediaMethod,
} from "./mediaResponse";

const WORKER_PATH = "/t3-media-worker.js";
const MEDIA_PREFIX = "/__t3code/media/";
const MAX_REQUESTS = 4;
const MAX_REQUEST_MS = 10 * 60_000;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_LEASE_MS = 60 * 60_000;
const SETUP_MS = 10_000;
const MAX_LEASES = 64;

let leases = 0;
let requests = 0;
let installing: Promise<ServiceWorker> | undefined;

async function mediaWorker(signal: AbortSignal) {
  const workers = navigator.serviceWorker;
  const script = new URL(WORKER_PATH, location.origin).href;
  const root = new URL("/", location.origin).href;
  const current = workers.controller;
  if (current?.scriptURL === script) return current;
  if (current) throw new Error("Another service worker controls this app.");
  const registrations = await workers.getRegistrations();
  signal.throwIfAborted();
  // Re-registering at the same scope would update the existing registration.
  if (
    registrations.some(
      (entry) =>
        entry.scope === root &&
        [entry.active, entry.waiting, entry.installing].some(
          (worker) => worker !== null && worker.scriptURL !== script,
        ),
    )
  ) {
    throw new Error("The app already has a service worker.");
  }
  const registration = await workers.register(script, { scope: "/", updateViaCache: "none" });
  return new Promise<ServiceWorker>((resolve, reject) => {
    const finish = () => {
      workers.removeEventListener("controllerchange", check);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const check = () => {
      const controller = workers.controller;
      if (!controller) return;
      finish();
      if (controller.scriptURL === script && registration.active === controller)
        resolve(controller);
      else reject(new Error("The media service worker could not control this app."));
    };
    workers.addEventListener("controllerchange", check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

function getMediaWorker() {
  return (installing ??= mediaWorker(AbortSignal.timeout(SETUP_MS)).finally(() => {
    installing = undefined;
  }));
}

function register(
  worker: ServiceWorker,
  id: string,
  destination: MediaDestination,
  expiresAt: number,
  signal: AbortSignal,
) {
  const { port1, port2 } = new MessageChannel();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      port1.close();
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    port1.onmessage = ({ data }) => {
      finish();
      if (data === "ready") resolve();
      else reject(new Error("The media service worker refused the lease."));
    };
    port1.onmessageerror = () => {
      finish();
      reject(new Error("The media service worker could not acknowledge the lease."));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      worker.postMessage({ type: "t3-media-register", id, destination, expiresAt }, [port2]);
    } catch (error) {
      port2.close();
      finish();
      reject(error);
    }
  });
}

type FetchMedia = (
  method: MediaMethod,
  range: string | null,
  signal: AbortSignal,
) => Promise<Response>;

async function replyToMedia(
  port: MessagePort,
  fetchMedia: FetchMedia,
  method: MediaMethod,
  range: string | null,
  destination: MediaDestination,
  signal: AbortSignal,
) {
  requests++;
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([
    controller.signal,
    signal,
    AbortSignal.timeout(MAX_REQUEST_MS),
  ]);
  let grantCredit: (() => void) | undefined;
  let serving = true;
  const finish = () => {
    if (!serving) return;
    serving = false;
    requests--;
    requestSignal.removeEventListener("abort", abort);
    controller.abort();
    grantCredit?.();
    port.close();
  };
  const abort = () => {
    port.postMessage("abort");
    finish();
  };
  requestSignal.addEventListener("abort", abort, { once: true });
  port.onmessage = ({ data }) => {
    if (data === "cancel" || data === "done") finish();
    else if (data === "credit") grantCredit?.();
  };
  port.onmessageerror = finish;
  try {
    requestSignal.throwIfAborted();
    const upstreamRange = boundRelayMediaRange(range);
    const response = await fetchMedia(method, upstreamRange, requestSignal);
    if (requestSignal.aborted) {
      await response.body?.cancel();
      return;
    }
    const reply = mediaResponse(response, method, upstreamRange, destination);
    if (!reply?.body) {
      await response.body?.cancel();
      port.postMessage(reply ?? { status: 502 });
      finish();
      return;
    }

    try {
      port.postMessage(reply, [reply.body]);
      return;
    } catch (error) {
      if (
        !(
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "DataCloneError")
        )
      ) {
        throw error;
      }
    }

    const reader = reply.body.getReader();
    try {
      port.postMessage({ status: reply.status, headers: reply.headers, chunks: true });
      let remainder: Uint8Array | undefined;
      while (true) {
        await new Promise<void>((resolve) => {
          grantCredit = resolve;
        });
        requestSignal.throwIfAborted();
        grantCredit = undefined;
        if (!remainder?.length) {
          const next = await reader.read();
          requestSignal.throwIfAborted();
          if (next.done) {
            port.postMessage("eof");
            break;
          }
          remainder = next.value;
        }
        const chunk = remainder.slice(0, MAX_CHUNK_BYTES);
        remainder = remainder.subarray(chunk.byteLength);
        port.postMessage(chunk, [chunk.buffer]);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    finish();
  } catch {
    if (!requestSignal.aborted) port.postMessage({ status: 502 });
    finish();
  }
}

/** Keep the fetch closure in the app document for the entire lease. */
export async function openLocalMediaLease(
  destination: MediaDestination,
  issuedExpiry: number,
  fetchMedia: FetchMedia,
  signal: AbortSignal,
): Promise<string> {
  if (!isSecureContext || !navigator.serviceWorker || leases >= MAX_LEASES) {
    throw new Error("Hosted media is unavailable in this browser.");
  }

  const expiresAt = Math.min(issuedExpiry, Date.now() + MAX_LEASE_MS);
  const lifetime = expiresAt - Date.now();
  if (!(lifetime > 0)) throw new Error("The signed media URL expired.");

  const lease = new AbortController();
  const leaseSignal = AbortSignal.any([signal, lease.signal, AbortSignal.timeout(lifetime)]);
  leaseSignal.throwIfAborted();
  leases++;
  try {
    const worker = await getMediaWorker();
    leaseSignal.throwIfAborted();
    const workers = navigator.serviceWorker;
    const id = uuidV4Unsafe();
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== worker || workers.controller !== worker) return;
      const data = event.data;
      if (data?.type !== "t3-media-fetch" || data.id !== id) return;
      const port = event.ports[0];
      if (!port) return;
      if (
        leaseSignal.aborted ||
        Date.now() >= expiresAt ||
        requests >= MAX_REQUESTS ||
        data.destination !== destination ||
        (data.method !== "GET" && data.method !== "HEAD") ||
        (data.range !== null && typeof data.range !== "string") ||
        !isMediaRange(data.range)
      ) {
        port.postMessage({ status: 410 });
        port.close();
        return;
      }
      void replyToMedia(port, fetchMedia, data.method, data.range, destination, leaseSignal);
    };
    const onControllerChange = () => lease.abort();
    const cleanup = () => {
      workers.removeEventListener("message", handleMessage);
      workers.removeEventListener("controllerchange", onControllerChange);
      if (worker.state !== "redundant") {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker messages target this exact worker.
        worker.postMessage({ type: "t3-media-release", id });
      }
    };
    workers.addEventListener("message", handleMessage);
    workers.addEventListener("controllerchange", onControllerChange);
    leaseSignal.addEventListener("abort", cleanup, { once: true });
    await register(
      worker,
      id,
      destination,
      expiresAt,
      AbortSignal.any([leaseSignal, AbortSignal.timeout(SETUP_MS)]),
    );
    leaseSignal.throwIfAborted();
    return MEDIA_PREFIX + id;
  } catch (error) {
    lease.abort();
    throw error;
  } finally {
    if (leaseSignal.aborted) leases--;
    else leaseSignal.addEventListener("abort", () => leases--, { once: true });
  }
}
