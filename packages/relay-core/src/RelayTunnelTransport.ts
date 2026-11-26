// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This Node adapter owns raw TLS sockets and their deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeTimers from "node:timers";
import * as NodeTls from "node:tls";
import {
  RELAY_ADMISSION_ACTIVE,
  RELAY_ADMISSION_HEADER,
  RELAY_ADMISSION_PATH,
  RELAY_ADMISSION_RETIRED,
} from "@t3tools/contracts/relay";
import { RELAY_HOSTED_WS_PROTOCOL } from "@t3tools/contracts/selfHostedRelayHosted";
import {
  SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES,
  SELF_HOSTED_RELAY_HOOK_PROOF_HEADER,
  SelfHostedRelayHookMethod,
  SelfHostedRelayHookRawTarget,
} from "@t3tools/contracts/selfHostedRelayHooks";
import {
  VERIFIED_DOCUMENT_ASSET_PATH,
  verifiedDocumentCsp,
} from "@t3tools/shared/verifiedDocumentCsp";
import * as Schema from "effect/Schema";

export const RELAY_BROWSER_COOKIE = "__Host-t3-relay";

export interface RelayHostedForwardingPolicy {
  readonly clientOrigin: string;
  readonly applicationProtocols?: ReadonlyArray<string>;
}

export function hostedCorsHeaders(clientOrigin: string, vary?: string) {
  const fields = new Map<string, string>();
  for (const field of vary?.split(",") ?? []) {
    const trimmed = field.trim();
    if (trimmed) fields.set(trimmed.toLowerCase(), trimmed);
  }
  fields.set("origin", "Origin");
  return {
    "access-control-allow-origin": clientOrigin,
    "access-control-expose-headers": `Accept-Ranges, Content-Range, Content-Disposition, ETag, ${RELAY_ADMISSION_HEADER}`,
    vary: fields.has("*") ? "*" : [...fields.values()].join(", "),
  };
}

const PROTOCOL = "t3-relay-http1";
const HANDSHAKE_MS = 5_000;
const RETRY_MS = 1_000;
const MAX_SLOTS = 64;
const HEADER_BYTES = 16 * 1024;
const BUFFER_BYTES = 16 * 1024;
const DEFAULT_HTTP_BYTES = 128 * 1024 * 1024;
const WEBSOCKET_BYTES = 256 * 1024 * 1024;
const HTTP_MS = 120_000;
const WEBSOCKET_IDLE_MS = 300_000;
const WEBSOCKET_MS = 3_600_000;

type TlsCredentials = Required<Pick<NodeTls.SecureContextOptions, "ca" | "cert" | "key">>;
type Admission = "active" | "retired" | "unknown";
type Authorities = { readonly external: URL; readonly canonical: URL };

export interface RelayTunnelHookRequest {
  readonly method: SelfHostedRelayHookMethod;
  readonly rawTarget: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface RelayTunnelHookResponse {
  readonly status: number;
  readonly outcome?: string;
  readonly retryAfter?: string;
}

const relayHookPrefix = "/api/relay-hooks/";
const isRelayHookTarget = Schema.is(SelfHostedRelayHookRawTarget);
const isRelayHookMethod = Schema.is(SelfHostedRelayHookMethod);
const hookReplyLimit = 4096;

export function validRelayTunnelHookRequest(request: RelayTunnelHookRequest): boolean {
  return (
    validTarget(request.rawTarget) &&
    isRelayHookTarget(request.rawTarget) &&
    isRelayHookMethod(request.method) &&
    request.body.byteLength <= SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES
  );
}

const authorities = new WeakMap<object, Authorities>();

export function trustedStaticRelayExternalOrigin(socket: object | undefined): string | undefined {
  return socket === undefined ? undefined : authorities.get(socket)?.external.origin;
}

export function trustedStaticRelayCanonicalOrigin(socket: object | undefined): string | undefined {
  return socket === undefined ? undefined : authorities.get(socket)?.canonical.origin;
}

function registration({ external, canonical }: Authorities): Buffer {
  return NodeCrypto.createHash("sha256")
    .update(external.origin + "\n" + canonical.origin)
    .digest();
}

function httpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error("Expected an exact HTTPS origin for the static relay");
  }
  return url;
}

function validPin(pin: string): string {
  if (!/^(?:[a-f\d]{2}:){31}[a-f\d]{2}$/iu.test(pin)) {
    throw new Error("Expected a SHA-256 certificate fingerprint for the static relay");
  }
  return pin.toUpperCase();
}

function positiveLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error("Invalid static relay limit");
  }
  return value;
}

function isPinnedPeer(socket: NodeTls.TLSSocket, pin: string): boolean {
  return (
    socket.authorized &&
    socket.alpnProtocol === PROTOCOL &&
    socket.getPeerCertificate().fingerprint256 === pin
  );
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEnd(headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders {
  const connectionTokens = new Set(headers.connection?.toLowerCase().split(/\s*,\s*/u));
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !hopByHop.has(name) &&
        !connectionTokens.has(name) &&
        name !== "forwarded" &&
        name !== "x-real-ip" &&
        !name.startsWith("x-forwarded-") &&
        !name.startsWith("x-t3-relay-") &&
        name !== SELF_HOSTED_RELAY_HOOK_PROOF_HEADER &&
        !name.startsWith("t3-relay-"),
    ),
  );
}

function cookieName(field: string): string {
  return field.split("=", 1)[0]!.trim();
}

function requestHeaders(
  incoming: NodeHttp.IncomingHttpHeaders,
  hosted?: RelayHostedForwardingPolicy,
): NodeHttp.OutgoingHttpHeaders {
  const headers = endToEnd(incoming);
  if (hosted !== undefined) {
    delete headers.cookie;
    delete headers.cookie2;
    delete headers["sec-websocket-protocol"];
    if (hosted.applicationProtocols?.length) {
      headers["sec-websocket-protocol"] = hosted.applicationProtocols.join(", ");
    }
    return headers;
  }
  if (typeof headers.cookie === "string" && headers.cookie.includes(RELAY_BROWSER_COOKIE)) {
    const fields = headers.cookie.split(";");
    const allowed = fields.filter((field) => cookieName(field) !== RELAY_BROWSER_COOKIE);
    if (allowed.length !== fields.length) {
      const cookie = allowed.join(";").trim();
      if (cookie === "") delete headers.cookie;
      else headers.cookie = cookie;
    }
  }
  return headers;
}

const reservedSetCookie = /(?:^|,)\s*__Host-t3-relay\s*=/u;

const isRedirect = (status: number) => status >= 300 && status < 400 && status !== 304;

function responseHeaders(
  incoming: NodeHttp.IncomingHttpHeaders,
  hosted?: RelayHostedForwardingPolicy,
): NodeHttp.OutgoingHttpHeaders {
  const headers = endToEnd(incoming);
  if (hosted !== undefined) {
    for (const name of Object.keys(headers)) {
      if (name.startsWith("access-control-")) delete headers[name];
    }
    delete headers[RELAY_ADMISSION_HEADER.toLowerCase()];
    delete headers["set-cookie"];
    delete headers["set-cookie2"];
    delete headers["sec-websocket-protocol"];
    delete headers.location;
    delete headers.refresh;
    return {
      ...headers,
      ...hostedCorsHeaders(
        hosted.clientOrigin,
        typeof headers.vary === "string" ? headers.vary : undefined,
      ),
      "cache-control": "no-store",
    };
  }
  if (Array.isArray(headers["set-cookie"])) {
    const allowed = headers["set-cookie"].filter(
      (field) => !reservedSetCookie.test(field.split(";", 1)[0] ?? ""),
    );
    if (allowed.length === 0) delete headers["set-cookie"];
    else headers["set-cookie"] = allowed;
  }
  return headers;
}

function validTarget(path: string | undefined): path is string {
  return path !== undefined && /^\/(?!\/)[^\\#]*$/u.test(path);
}

function isAssetTarget(target: string): boolean {
  if (target.startsWith(VERIFIED_DOCUMENT_ASSET_PATH)) return true;
  // CSP path matching percent-decodes each segment.
  const prefix = /^\/[^/?]+\/[^/?]+\//u.exec(target)?.[0];
  if (prefix === undefined || !prefix.includes("%")) return false;
  try {
    return decodeURIComponent(prefix) === VERIFIED_DOCUMENT_ASSET_PATH;
  } catch {
    return false;
  }
}

function countHostHeaders(request: NodeHttp.IncomingMessage): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === "host") count += 1;
  }
  return count;
}

function limitedBytes(limit: number): NodeStream.Transform {
  let bytes = 0;
  return new NodeStream.Transform({
    highWaterMark: BUFFER_BYTES,
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) callback(new Error("Static relay byte limit exceeded"));
      else callback(null, chunk);
    },
  });
}

function expire(ms: number, action: () => void, socket: NodeStream.Duplex) {
  const timeout = NodeTimers.setTimeout(action, ms).unref();
  const cancel = () => NodeTimers.clearTimeout(timeout);
  socket.once("close", cancel);
  return cancel;
}

function sendStatus(
  response: NodeHttp.ServerResponse,
  status: number,
  hosted?: RelayHostedForwardingPolicy,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) response.destroy();
  else
    response
      .writeHead(status, {
        "cache-control": "no-store",
        connection: "close",
        ...(hosted === undefined ? {} : hostedCorsHeaders(hosted.clientOrigin)),
      })
      .end();
}

function endUpgrade(
  socket: NodeStream.Duplex,
  status: number,
  hosted?: RelayHostedForwardingPolicy,
): void {
  if (socket.destroyed) return;
  writeUpgradeResponse(socket, status, {
    connection: "close",
    "content-length": 0,
    ...(hosted === undefined
      ? {}
      : {
          ...hostedCorsHeaders(hosted.clientOrigin),
          "cache-control": "no-store",
        }),
  });
  socket.end();
}

function writeUpgradeResponse(
  socket: NodeStream.Duplex,
  status: number,
  headers: NodeHttp.OutgoingHttpHeaders,
): void {
  const lines = [`HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status] ?? ""}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  socket.write(lines.join("\r\n") + "\r\n\r\n");
}

export function makeStaticRelayEdge(options: {
  readonly tunnelTls: TlsCredentials;
  readonly environmentFingerprint: string;
  readonly publicOrigin: string;
  readonly canonicalOrigin: string;
  readonly admission: () => Admission;
  readonly admissionBrowserOrigins?: ReadonlySet<string>;
  readonly onSlotAvailable?: (available: number) => void;
  readonly limits?:
    | {
        readonly streams?: number;
        readonly requestBytes?: number;
        readonly responseBytes?: number;
      }
    | undefined;
}) {
  const external = httpsOrigin(options.publicOrigin);
  const canonical = httpsOrigin(options.canonicalOrigin);
  const documentCsp = verifiedDocumentCsp(external.origin);
  const expectedRegistration = registration({ external, canonical });
  const pin = validPin(options.environmentFingerprint);
  const maxStreams = positiveLimit(options.limits?.streams ?? MAX_SLOTS, MAX_SLOTS);
  const requestLimit = positiveLimit(
    options.limits?.requestBytes ?? DEFAULT_HTTP_BYTES,
    DEFAULT_HTTP_BYTES,
  );
  const responseLimit = positiveLimit(
    options.limits?.responseBytes ?? DEFAULT_HTTP_BYTES,
    DEFAULT_HTTP_BYTES,
  );
  const idle = new Set<NodeTls.TLSSocket>();
  const connections = new Set<NodeStream.Duplex>();
  const dispatched = new Set<NodeTls.TLSSocket>();
  const pending = new Set<() => void>();
  const ready = Promise.withResolvers<void>();
  let revoked = false;

  const admission = () => (revoked ? "retired" : options.admission());
  const tunnelServer = NodeTls.createServer({
    ...options.tunnelTls,
    minVersion: "TLSv1.3",
    ALPNProtocols: [PROTOCOL],
    requestCert: true,
    rejectUnauthorized: true,
    handshakeTimeout: HANDSHAKE_MS,
    pauseOnConnect: false,
    highWaterMark: BUFFER_BYTES,
  });
  tunnelServer.maxConnections = maxStreams;
  tunnelServer.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  tunnelServer.on("tlsClientError", (_error, socket) => socket.destroy());
  tunnelServer.on("secureConnection", (socket) => {
    if (admission() !== "active" || !isPinnedPeer(socket, pin)) {
      socket.destroy();
      return;
    }
    const handshake = NodeTimers.setTimeout(() => socket.destroy(), HANDSHAKE_MS).unref();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      NodeTimers.clearTimeout(handshake);
      idle.delete(socket);
    });
    const register = () => {
      const received: unknown = socket.read(expectedRegistration.length);
      if (received === null) return;
      socket.off("readable", register);
      NodeTimers.clearTimeout(handshake);
      if (
        !Buffer.isBuffer(received) ||
        !received.equals(expectedRegistration) ||
        socket.readableLength !== 0 ||
        admission() !== "active"
      ) {
        socket.destroy();
        return;
      }
      idle.add(socket);
      ready.resolve();
      options.onSlotAvailable?.(idle.size);
      while (idle.size > 0 && pending.size > 0) {
        pending.values().next().value?.();
      }
    };
    socket.on("readable", register);
  });

  const take = () => {
    for (const socket of idle) {
      idle.delete(socket);
      if (socket.destroyed || socket.readableEnded || socket.readableLength > 0) {
        socket.destroy();
        continue;
      }
      dispatched.add(socket);
      socket.once("close", () => dispatched.delete(socket));
      return socket;
    }
    return undefined;
  };

  const validateIngress = (request: NodeHttp.IncomingMessage) => {
    if (request.httpVersion !== "1.1" || !validTarget(request.url)) return 400;
    const socket = request.socket;
    const servername = Reflect.get(socket, "servername");
    if (
      !(socket instanceof NodeTls.TLSSocket) ||
      servername !== external.hostname ||
      request.headers.host?.toLowerCase() !== external.host ||
      countHostHeaders(request) !== 1
    ) {
      return 421;
    }
    return undefined;
  };

  const dialExchange = (
    request: NodeHttp.IncomingMessage,
    socket: NodeTls.TLSSocket,
    headers: NodeHttp.OutgoingHttpHeaders,
  ) => {
    const exchange = NodeHttp.request({
      method: request.method,
      path: request.url,
      headers: { ...headers, host: canonical.host },
      createConnection: () => socket,
      maxHeaderSize: HEADER_BYTES,
    });
    exchange.maxHeadersCount = 0;
    return exchange;
  };

  const deliverHook = (
    request: RelayTunnelHookRequest,
    signal: AbortSignal,
  ): Promise<RelayTunnelHookResponse | undefined> => {
    if (signal.aborted || admission() !== "active" || !validRelayTunnelHookRequest(request)) {
      return Promise.resolve(undefined);
    }
    const socket = take();
    if (socket === undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let upstream: NodeHttp.ClientRequest | undefined;
      const finish = (reply?: RelayTunnelHookResponse) => {
        resolve(reply);
        upstream?.destroy();
        socket.destroy();
      };
      socket.once("close", () => finish());
      try {
        upstream = NodeHttp.request({
          method: request.method,
          path: request.rawTarget,
          headers: {
            ...request.headers,
            host: canonical.host,
            connection: "close",
            "content-length": String(request.body.byteLength),
          },
          createConnection: () => socket,
          maxHeaderSize: HEADER_BYTES,
          signal,
        });
        upstream.once("upgrade", () => finish());
        upstream.once("error", () => finish());
        upstream.once("response", (reply) => {
          let bytes = 0;
          reply.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > hookReplyLimit) finish();
          });
          reply.once("error", () => finish());
          reply.once("end", () => {
            const outcome = reply.headersDistinct["x-t3-hook-outcome"];
            const retryAfter = reply.headersDistinct["retry-after"];
            finish(
              reply.complete && reply.statusCode !== undefined
                ? {
                    status: reply.statusCode,
                    ...(outcome?.length === 1 ? { outcome: outcome[0]! } : {}),
                    ...(retryAfter?.length === 1 ? { retryAfter: retryAfter[0]! } : {}),
                  }
                : undefined,
            );
          });
        });
        upstream.end(request.body);
      } catch {
        finish();
      }
    });
  };

  const forwardHttp = (
    incoming: NodeHttp.IncomingMessage,
    outgoing: NodeHttp.ServerResponse,
    expectsContinue: boolean,
    hosted?: RelayHostedForwardingPolicy,
  ) => {
    if (outgoing.destroyed || incoming.socket.destroyed || outgoing.writableEnded) return;
    const reject = (status: number) => sendStatus(outgoing, status, hosted);
    const invalid = validateIngress(incoming);
    if (invalid !== undefined) return reject(invalid);
    if (incoming.url?.startsWith(relayHookPrefix)) return reject(404);
    const state = admission();
    if (incoming.url === RELAY_ADMISSION_PATH) {
      const marker =
        state === "active"
          ? RELAY_ADMISSION_ACTIVE
          : state === "retired"
            ? RELAY_ADMISSION_RETIRED
            : undefined;
      const origin = incoming.headers.origin;
      const cors =
        origin !== undefined && options.admissionBrowserOrigins?.has(origin)
          ? {
              "access-control-allow-origin": origin,
              "access-control-expose-headers": RELAY_ADMISSION_HEADER,
            }
          : {};
      outgoing
        .writeHead(incoming.method !== "HEAD" ? 405 : (marker?.status ?? 404), {
          "cache-control": "no-store",
          vary: "Origin",
          ...(incoming.method !== "HEAD" ? { allow: "HEAD" } : {}),
          ...(incoming.method === "HEAD" && marker !== undefined
            ? { [RELAY_ADMISSION_HEADER]: marker.marker }
            : {}),
          ...cors,
        })
        .end();
      return;
    }
    if (state !== "active") return reject(state === "retired" ? 410 : 404);
    const encoding = incoming.headers["transfer-encoding"]?.toLowerCase();
    if (encoding !== undefined && encoding !== "chunked") return reject(400);
    if (Number(incoming.headers["content-length"] ?? 0) > requestLimit) {
      return reject(413);
    }
    const socket = take();
    if (socket === undefined) {
      if (dispatched.size + pending.size >= maxStreams) {
        return reject(503);
      }
      const cancel = () => {
        pending.delete(resume);
        NodeTimers.clearTimeout(deadline);
        outgoing.off("close", cancel);
      };
      const resume = () => {
        cancel();
        forwardHttp(incoming, outgoing, expectsContinue, hosted);
      };
      const deadline = NodeTimers.setTimeout(() => {
        cancel();
        reject(503);
      }, HANDSHAKE_MS).unref();
      pending.add(resume);
      outgoing.once("close", cancel);
      return;
    }

    if (expectsContinue) outgoing.writeContinue();
    const isAsset = isAssetTarget(incoming.url ?? "");
    const headers = requestHeaders(incoming.headers, hosted);
    delete headers.expect;
    if (isAsset) delete headers["sec-required-csp"];
    const upstream = dialExchange(incoming, socket, { ...headers, connection: "close" });
    const body = limitedBytes(requestLimit);
    const replyBody = limitedBytes(responseLimit);
    expire(
      HTTP_MS,
      () => {
        reject(504);
        socket.destroy();
      },
      socket,
    );

    const closeUpstream = () => {
      incoming.unpipe(body);
      body.destroy();
      replyBody.destroy();
      upstream.destroy();
      socket.destroy();
    };
    outgoing.once("close", closeUpstream);
    incoming.once("error", closeUpstream);
    let reply: NodeHttp.IncomingMessage | undefined;
    const interrupted = () => reject(revoked ? 410 : 502);
    socket.once("close", () => {
      if (!reply?.complete) interrupted();
    });
    upstream.on("error", interrupted);

    body.on("error", () => {
      reject(413);
      closeUpstream();
    });
    replyBody.on("error", () => {
      reject(502);
      closeUpstream();
    });
    upstream.once("response", (message) => {
      reply = message;
      const status = message.statusCode ?? 502;
      if (
        (isAsset && status >= 300 && status < 400) ||
        (hosted !== undefined && isRedirect(status)) ||
        (incoming.method !== "HEAD" &&
          status !== 304 &&
          Number(message.headers["content-length"] ?? 0) > responseLimit)
      ) {
        reject(502);
        closeUpstream();
        return;
      }
      message.on("error", () => outgoing.destroy());
      const headers: Record<string, NodeHttp.OutgoingHttpHeader | undefined> = responseHeaders(
        message.headers,
        hosted,
      );
      if (
        isAsset &&
        /^(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/iu.test(
          message.headers["content-type"] ?? "",
        )
      ) {
        headers["content-security-policy"] = [
          ...(message.headersDistinct["content-security-policy"] ?? []),
          documentCsp,
        ];
      }
      outgoing.writeHead(status, headers);
      message.pipe(replyBody);
      replyBody.pipe(outgoing);
    });
    incoming.pipe(body);
    body.pipe(upstream);
  };

  const upgrade = (
    incoming: NodeHttp.IncomingMessage,
    client: NodeStream.Duplex,
    head: Buffer,
    hosted?: RelayHostedForwardingPolicy,
  ) => {
    client.on("error", () => client.destroy());
    const reject = (status: number) => endUpgrade(client, status, hosted);
    const invalid = validateIngress(incoming);
    if (invalid !== undefined) return reject(invalid);
    if (incoming.url?.startsWith(relayHookPrefix)) return reject(404);
    const state = admission();
    if (state !== "active") return reject(state === "retired" ? 410 : 404);
    if (
      incoming.url === RELAY_ADMISSION_PATH ||
      incoming.method !== "GET" ||
      incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
      Number(incoming.headers["content-length"] ?? 0) > 0 ||
      incoming.headers["transfer-encoding"] !== undefined ||
      head.length > BUFFER_BYTES
    ) {
      return reject(400);
    }
    const socket = take();
    if (socket === undefined) return reject(503);
    client.pause();
    const upstream = dialExchange(incoming, socket, {
      ...requestHeaders(incoming.headers, hosted),
      connection: "Upgrade",
      upgrade: "websocket",
    });
    client.once("close", () => socket.destroy());
    socket.once("close", () => {
      if (!client.writableEnded) client.destroy();
    });
    const failedHandshake = () => reject(revoked ? 410 : 502);
    upstream.on("error", failedHandshake);
    const cancelHandshakeTimeout = expire(HANDSHAKE_MS, () => socket.destroy(), socket);
    upstream.once("response", (reply) => {
      cancelHandshakeTimeout();
      // A rejected upgrade has no raw stream. Forward only its status and end-to-end headers.
      const status = reply.statusCode ?? 502;
      if (hosted !== undefined && isRedirect(status)) {
        reject(502);
        socket.destroy();
        return;
      }
      const headers = responseHeaders(reply.headers, hosted);
      delete headers["content-length"];
      writeUpgradeResponse(client, status, {
        ...headers,
        "content-length": 0,
        connection: "close",
      });
      client.end();
      reply.resume();
    });
    upstream.once("upgrade", (reply, upgraded, first) => {
      upstream.off("error", failedHandshake);
      cancelHandshakeTimeout();
      if (reply.statusCode !== 101 || reply.headers.upgrade?.toLowerCase() !== "websocket") {
        reject(502);
        socket.destroy();
        return;
      }
      const headers = responseHeaders(reply.headers, hosted);
      if (hosted !== undefined) {
        const selected = reply.headersDistinct["sec-websocket-protocol"];
        if (
          selected !== undefined &&
          (selected.length !== 1 || !hosted.applicationProtocols?.includes(selected[0] ?? ""))
        ) {
          reject(502);
          socket.destroy();
          return;
        }
        headers["sec-websocket-protocol"] = selected?.[0] ?? RELAY_HOSTED_WS_PROTOCOL;
      }
      delete headers["content-length"];
      writeUpgradeResponse(client, 101, {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
      });
      const outgoingBytes = limitedBytes(WEBSOCKET_BYTES);
      const incomingBytes = limitedBytes(WEBSOCKET_BYTES);
      const close = () => {
        outgoingBytes.destroy();
        incomingBytes.destroy();
        socket.destroy();
        client.destroy();
      };
      socket.setTimeout(WEBSOCKET_IDLE_MS, close);
      expire(WEBSOCKET_MS, close, socket);
      outgoingBytes.on("error", close);
      incomingBytes.on("error", close);
      socket.once("close", close);
      outgoingBytes.pipe(client);
      incomingBytes.pipe(upgraded);
      if (first.length > 0) outgoingBytes.write(first);
      if (head.length > 0) incomingBytes.write(head);
      upgraded.pipe(outgoingBytes);
      client.pipe(incomingBytes);
    });
    upstream.end();
  };

  const request = (
    incoming: NodeHttp.IncomingMessage,
    outgoing: NodeHttp.ServerResponse,
    hosted?: RelayHostedForwardingPolicy,
  ) => forwardHttp(incoming, outgoing, false, hosted);
  const checkContinue = (
    incoming: NodeHttp.IncomingMessage,
    outgoing: NodeHttp.ServerResponse,
    hosted?: RelayHostedForwardingPolicy,
  ) => forwardHttp(incoming, outgoing, true, hosted);

  return {
    tunnelServer,
    deliverHook,
    request,
    checkContinue,
    upgrade,
    ready: ready.promise,
    revoke: () => {
      revoked = true;
      for (const resume of pending) resume();
      for (const socket of connections) socket.destroy();
    },
  };
}

export function connectStaticRelayTunnel(options: {
  readonly relay: TlsCredentials & {
    readonly host: string;
    readonly port: number;
    readonly servername: string;
  };
  readonly relayFingerprint: string;
  readonly publicOrigin: string;
  readonly canonicalOrigin: string;
  readonly backend: NodeHttp.Server;
  readonly poolSize?: number;
  readonly onIdentityRejected?: () => void;
}) {
  const identity = {
    external: httpsOrigin(options.publicOrigin),
    canonical: httpsOrigin(options.canonicalOrigin),
  };
  const ready = registration(identity);
  const pin = validPin(options.relayFingerprint);
  const poolSize = positiveLimit(options.poolSize ?? 8, MAX_SLOTS);
  const backend = options.backend;
  if (backend.listening) throw new Error("The static relay backend must not have a listener");
  backend.maxRequestsPerSocket = 1;
  backend.maxHeadersCount = 0;
  const active = new Set<NodeTls.TLSSocket>();
  const usedSockets = new Set<NodeTls.TLSSocket>();
  let retry: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  let closed = false;

  const dial = () => {
    if (closed || active.size >= MAX_SLOTS || active.size - usedSockets.size >= poolSize) return;
    const connection = {
      ...options.relay,
      minVersion: "TLSv1.3" as const,
      ALPNProtocols: [PROTOCOL],
      rejectUnauthorized: true,
      highWaterMark: BUFFER_BYTES,
    };
    const socket = NodeTls.connect(connection);
    active.add(socket);
    const handshake = NodeTimers.setTimeout(() => socket.destroy(), HANDSHAKE_MS).unref();
    let authenticated = false;
    let used = false;
    let rejected = false;
    const rejectIdentity = () => {
      if (rejected) return;
      rejected = true;
      options.onIdentityRejected?.();
    };
    socket.on("error", (error: Error) => {
      const code: unknown = Reflect.get(error, "code");
      if (
        socket.authorizationError != null ||
        (typeof code === "string" &&
          /^ERR_SSL_.*(?:CERTIFICATE|UNKNOWN_CA|NO_APPLICATION_PROTOCOL)/u.test(code))
      )
        rejectIdentity();
      socket.destroy();
    });
    socket.once("secureConnect", () => {
      NodeTimers.clearTimeout(handshake);
      if (!isPinnedPeer(socket, pin)) {
        rejectIdentity();
        socket.destroy();
        return;
      }
      authenticated = true;
      authorities.set(socket, identity);
      socket.write(ready);
      backend.emit("connection", socket);
      // Node's HTTP parser can take over TLS reads. Adding the listener after handoff restores data events.
      socket.prependOnceListener("data", () => {
        used = true;
        usedSockets.add(socket);
        dial();
      });
    });
    socket.once("close", () => {
      NodeTimers.clearTimeout(handshake);
      active.delete(socket);
      usedSockets.delete(socket);
      if (closed) return;
      if (authenticated && used) {
        dial();
        return;
      }
      retry ??= NodeTimers.setTimeout(() => {
        retry = undefined;
        for (let slot = 0; slot < poolSize; slot += 1) dial();
      }, RETRY_MS).unref();
    });
  };

  for (let slot = 0; slot < poolSize; slot += 1) dial();
  return {
    close: () => {
      closed = true;
      NodeTimers.clearTimeout(retry);
      for (const socket of active) socket.destroy();
    },
  };
}
