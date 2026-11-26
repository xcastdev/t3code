// @effect-diagnostics nodeBuiltinImport:off -- Lease identifiers are generated and consumed in Electron main.
import * as NodeCrypto from "node:crypto";
import type { Session, WebContents, WebFrameMain } from "electron";
import type { DesktopRelayMediaKind } from "@t3tools/contracts";
import { isRelayMediaTarget, parseRelayHttp } from "./DesktopRelayPolicy.ts";
import type { DesktopRelayTransport } from "./DesktopRelayTransport.ts";
import { fetchRelayMediaRange } from "./relayMediaWindows.ts";

export const DESKTOP_RELAY_MEDIA_SCHEME = "t3-relay-media";
const prefix = `${DESKTOP_RELAY_MEDIA_SCHEME}://lease/`;
const proofHeader = "x-t3-desktop-media-request";
const leaseLifetime = 15 * 60 * 1000;
const limit = 64;
const responseHeaders = new Set([
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]);

export interface DesktopRelayOwner {
  readonly contents: WebContents;
  readonly frame: WebFrameMain;
  readonly signal: AbortSignal;
}

type Lease = DesktopRelayOwner & {
  readonly target: string;
  readonly kind: DesktopRelayMediaKind;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
};

type MediaRequest = {
  readonly lease: Lease;
  readonly localUrl: string;
  readonly method: string;
  readonly proof: string;
  readonly controller: AbortController;
  readonly timeout: AbortSignal;
  readonly expire: () => void;
};

export function installDesktopRelayMedia(network: Session, transport: DesktopRelayTransport) {
  const leases = new Map<string, Lease>();
  const requests = new Map<number, MediaRequest>();
  const proofs = new Map<string, number>();
  const endRequest = (id: number) => {
    const pending = requests.get(id);
    if (pending === undefined) return;
    requests.delete(id);
    proofs.delete(pending.proof);
    pending.timeout.removeEventListener("abort", pending.expire);
    pending.controller.abort();
  };
  const dispose = (url: string) => {
    const lease = leases.get(url);
    if (lease === undefined) return;
    leases.delete(url);
    lease.controller.abort();
    for (const [id, request] of requests) {
      if (request.lease === lease) endRequest(id);
    }
  };

  const filter = { urls: [`${DESKTOP_RELAY_MEDIA_SCHEME}://lease/*`] };
  network.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const lease = leases.get(details.url);
    if (
      lease === undefined ||
      lease.signal.aborted ||
      details.webContentsId !== lease.contents.id ||
      details.frame !== lease.frame ||
      details.resourceType !== "media" ||
      requests.size >= limit ||
      (details.method !== "GET" && details.method !== "HEAD")
    ) {
      callback({ cancel: true });
      return;
    }
    endRequest(details.id);
    const proof = NodeCrypto.randomUUID();
    const request = {
      lease,
      proof,
      localUrl: details.url,
      method: details.method,
      controller: new AbortController(),
      timeout: AbortSignal.timeout(15_000),
      expire: () => endRequest(details.id),
    };
    request.timeout.addEventListener("abort", request.expire, { once: true });
    requests.set(details.id, request);
    proofs.set(proof, details.id);
    const headers = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== proofHeader),
    );
    callback({ requestHeaders: { ...headers, [proofHeader]: proof } });
  });
  network.webRequest.onErrorOccurred(filter, ({ id }) => endRequest(id));
  network.webRequest.onCompleted(filter, ({ id }) => endRequest(id));

  network.protocol.handle(DESKTOP_RELAY_MEDIA_SCHEME, async (request) => {
    const proof = request.headers.get(proofHeader);
    const id = proof === null ? undefined : proofs.get(proof);
    const pending = id === undefined ? undefined : requests.get(id);
    if (
      id === undefined ||
      pending === undefined ||
      pending.localUrl !== request.url ||
      pending.method !== request.method ||
      pending.lease.signal.aborted
    )
      return new Response(null, { status: 404 });
    proofs.delete(pending.proof);
    pending.timeout.removeEventListener("abort", pending.expire);
    const signal = AbortSignal.any([
      pending.lease.signal,
      pending.controller.signal,
      request.signal,
    ]);
    const parse = (range: string | null) =>
      parseRelayHttp({
        kind: "http",
        url: pending.lease.target,
        method: request.method,
        headers: range === null ? [] : [["Range", range]],
        body: false,
      });
    const range = request.headers.get("range");
    if (parse(range) === null) return new Response(null, { status: 416 });
    const fetchWindow = async (windowRange: string | null) => {
      const parsed = parse(windowRange);
      if (parsed === null) throw new Error("Relay media range was refused.");
      const reply = await transport.request(parsed, signal);
      return {
        ...reply,
        headers: new Headers(reply.headers.map(([name, value]) => [name, value])),
      };
    };
    try {
      const upstream =
        request.method === "GET"
          ? await fetchRelayMediaRange(range, fetchWindow)
          : await fetchWindow(range);
      const { headers } = upstream;
      const contentType = headers.get("content-type")?.toLowerCase() ?? "";
      const readable = upstream.status === 200 || upstream.status === 206;
      if (!readable || !contentType.startsWith(`${pending.lease.kind}/`)) {
        await upstream.body?.cancel();
        if (upstream.status === 416) {
          const contentRange = headers.get("content-range");
          return new Response(null, {
            status: 416,
            headers: contentRange === null ? {} : { "Content-Range": contentRange },
          });
        }
        return new Response(null, { status: readable ? 415 : upstream.status });
      }
      const out = new Headers({
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      });
      for (const [name, value] of headers) if (responseHeaders.has(name)) out.set(name, value);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch {
      return new Response(null, { status: 502 });
    }
  });

  return {
    create(owner: DesktopRelayOwner, target: string, kind: DesktopRelayMediaKind): string {
      const parsed = URL.parse(target);
      if (
        leases.size >= limit ||
        owner.signal.aborted ||
        parsed === null ||
        transport.getBinding(parsed.origin) === undefined ||
        !isRelayMediaTarget(target)
      ) {
        throw new Error("Desktop relay media unavailable.");
      }
      const url = prefix + NodeCrypto.randomUUID();
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        owner.signal,
        AbortSignal.timeout(leaseLifetime),
      ]);
      leases.set(url, { ...owner, target, kind, controller, signal });
      signal.addEventListener("abort", () => dispose(url), { once: true });
      return url;
    },
    dispose(owner: DesktopRelayOwner, url: string) {
      const lease = leases.get(url);
      if (
        lease?.contents === owner.contents &&
        lease.frame === owner.frame &&
        !owner.signal.aborted
      )
        dispose(url);
    },
    close() {
      for (const url of leases.keys()) dispose(url);
      for (const id of requests.keys()) endRequest(id);
      // Electron keeps one listener per event, and these three belong to this app session.
      network.webRequest.onBeforeSendHeaders(null);
      network.webRequest.onErrorOccurred(null);
      network.webRequest.onCompleted(null);
      network.protocol.unhandle(DESKTOP_RELAY_MEDIA_SCHEME);
    },
  };
}
