// @effect-diagnostics nodeBuiltinImport:off -- The relay must verify its own TLS socket before handing it to HTTP or WebSocket.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import WebSocket from "ws";
import * as Redacted from "effect/Redacted";

import type { DesktopRelayHeaders } from "@t3tools/contracts";
import {
  DESKTOP_RELAY_HTTP_LIMIT,
  DESKTOP_RELAY_SOCKET_LIMIT,
  parseRelayHttp,
  parseRelaySocket,
  relayTlsServerName,
} from "./DesktopRelayPolicy.ts";
import type { VerifiedRouteEnrollment } from "./VerifiedRoute.ts";

const connectTimeout = 15_000;
const idleTimeout = 90_000;
const responseBlocked =
  /^(?:connection|keep-alive|proxy-.*|transfer-encoding|upgrade|trailer|te|set-cookie2?|location|refresh|alt-svc|x-t3-relay-session|access-control-.*)$/i;
const unavailable = () => new Error("Desktop relay transport failed.");

export interface DesktopRelayTransport {
  readonly origins: readonly string[];
  getBinding(origin: string): VerifiedRouteEnrollment | undefined;
  request(
    input: NonNullable<ReturnType<typeof parseRelayHttp>>,
    signal: AbortSignal,
    body?: AsyncIterable<Uint8Array>,
    onDispatch?: () => void,
    responseLimit?: number,
  ): Promise<{
    status: number;
    statusText: string;
    headers: DesktopRelayHeaders;
    body: ReadableStream<Uint8Array> | null;
  }>;
  openSocket(
    input: NonNullable<ReturnType<typeof parseRelaySocket>>,
    signal: AbortSignal,
  ): Promise<WebSocket>;
}

export function makeDesktopRelayTransport(
  routes: readonly VerifiedRouteEnrollment[],
  credentials: ReadonlyMap<string, Redacted.Redacted<string>>,
): DesktopRelayTransport {
  const bindings = new Map(
    routes.filter((route) => route.transportRole === "relay").map((route) => [route.origin, route]),
  );
  const authority = (origin: string, probe = false) => {
    const binding = bindings.get(origin);
    const credential = probe ? undefined : credentials.get(origin);
    if (binding === undefined || (!probe && credential === undefined)) throw unavailable();
    return { binding, credential };
  };

  return {
    origins: [...bindings.keys()],
    getBinding: (origin) => bindings.get(origin),
    async request(input, signal, body, onDispatch, responseLimit = DESKTOP_RELAY_HTTP_LIMIT) {
      const verified = authority(input.origin, input.probe);
      const agent = await verifiedAgent(input, verified.binding, signal);
      return await new Promise((resolve, reject) => {
        try {
          signal.throwIfAborted();
          const req = NodeHttps.request(
            {
              hostname: input.hostname,
              port: input.port,
              path: input.target,
              method: input.method,
              agent,
              signal,
              timeout: idleTimeout,
              maxHeaderSize: 64 * 1024,
              headers: { ...input.headers, "Accept-Encoding": "identity" },
            },
            (res) => {
              const status = res.statusCode ?? 502;
              if (status >= 300 && status < 400 && status !== 304) {
                res.destroy();
                reject(unavailable());
                return;
              }
              const bodyless =
                input.method === "HEAD" || status === 204 || status === 205 || status === 304;
              const responseBody = bodyless ? null : boundedBody(res, responseLimit);
              if (bodyless) res.resume();
              const excluded = new Set(
                res.headers.connection?.split(",").map((name) => name.trim().toLowerCase()),
              );
              const headers: [string, string][] = [];
              for (const [name, values] of Object.entries(res.headersDistinct)) {
                if (responseBlocked.test(name) || excluded.has(name)) continue;
                for (const value of values ?? []) headers.push([name, value]);
              }
              resolve({ status, statusText: res.statusMessage ?? "", headers, body: responseBody });
            },
          );
          req.once("error", () => reject(unavailable()));
          req.once("upgrade", (_response, socket) => {
            socket.destroy();
            reject(unavailable());
          });
          req.once("timeout", () => req.destroy(unavailable()));
          setForwardingCredential(req, verified.credential);
          onDispatch?.();
          if (body === undefined) {
            req.end();
          } else {
            NodeStream.Readable.from(body, { objectMode: false, highWaterMark: 1 })
              .on("error", () => req.destroy(unavailable()))
              .pipe(req);
          }
        } catch {
          agent.destroy();
          reject(unavailable());
        }
      });
    },
    async openSocket(input, signal) {
      const verified = authority(input.origin);
      const agent = await verifiedAgent(input, verified.binding, signal);
      try {
        signal.throwIfAborted();
        const socket = new WebSocket(input.url.href, input.protocols, {
          agent,
          finishRequest: (req) => {
            setForwardingCredential(req, verified.credential);
            req.end();
          },
          handshakeTimeout: connectTimeout,
          followRedirects: false,
          perMessageDeflate: false,
          maxPayload: DESKTOP_RELAY_SOCKET_LIMIT,
          maxRedirects: 0,
        });
        const abort = () => socket.terminate();
        signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => {
          signal.removeEventListener("abort", abort);
          agent.destroy();
        });
        return socket;
      } catch {
        agent.destroy();
        throw unavailable();
      }
    },
  };
}

function setForwardingCredential(
  request: NodeHttp.ClientRequest,
  credential: Redacted.Redacted<string> | undefined,
) {
  if (credential !== undefined) {
    request.setHeader("Proxy-Authorization", `Bearer ${Redacted.value(credential)}`);
  }
}

type RelayAuthority = { readonly hostname: string; readonly port: number };

function verifiedAgent(
  target: RelayAuthority,
  enrollment: VerifiedRouteEnrollment,
  signal: AbortSignal,
): Promise<NodeHttps.Agent> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = NodeTls.connect({
      host: target.hostname,
      port: target.port,
      servername: relayTlsServerName(target.hostname),
      // Electron's Node TLS can use both the OS store and Node's default/extra certificates.
      ca: [
        ...new Set([
          ...NodeTls.getCACertificates("default"),
          ...NodeTls.getCACertificates("system"),
        ]),
      ],
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      checkServerIdentity: (_host, certificate) => {
        const invalidHost = NodeTls.checkServerIdentity(target.hostname, certificate);
        if (invalidHost !== undefined) return invalidHost;
        try {
          const key = new NodeCrypto.X509Certificate(certificate.raw).publicKey.export({
            format: "der",
            type: "spki",
          });
          const pin = NodeCrypto.createHash("sha256").update(key).digest("base64");
          return pin === enrollment.spkiSha256 ? undefined : unavailable();
        } catch {
          return unavailable();
        }
      },
    });
    const abort = () => socket.destroy(unavailable());
    const timeout = AbortSignal.timeout(connectTimeout);
    timeout.addEventListener("abort", abort, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => reject(unavailable()));
    socket.once("close", () => {
      timeout.removeEventListener("abort", abort);
      signal.removeEventListener("abort", abort);
      reject(unavailable());
    });
    socket.once("secureConnect", () => {
      timeout.removeEventListener("abort", abort);
      if (!socket.authorized || signal.aborted) {
        abort();
        return;
      }
      const agent = new NodeHttps.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
      let assigned = false;
      // Returning a socket here would let Node write before the verification callback.
      agent.createConnection = (_options, callback) => {
        if (assigned || socket.destroyed || signal.aborted) callback?.(unavailable(), socket);
        else {
          assigned = true;
          callback?.(null, socket);
        }
        return undefined;
      };
      resolve(agent);
    });
  });
}

function boundedBody(response: NodeHttp.IncomingMessage, limit: number) {
  const iterator = response[Symbol.asyncIterator]();
  let size = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await iterator.next();
          if (chunk.done) {
            controller.close();
            return;
          }
          const bytes = Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value);
          size += bytes.length;
          if (size > limit) throw unavailable();
          controller.enqueue(bytes);
        } catch {
          response.destroy();
          controller.error(unavailable());
        }
      },
      cancel() {
        response.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}
