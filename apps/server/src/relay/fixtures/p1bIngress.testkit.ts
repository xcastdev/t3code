// @effect-diagnostics nodeBuiltinImport:off -- The TLS proof owns its sockets and certificates.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as Effect from "effect/Effect";

const serverCredentials = {
  key: NodeFS.readFileSync(new URL("../../peer/fixtures/localhost-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("../../peer/fixtures/localhost-cert.pem", import.meta.url)),
};
const ingressCredentials = {
  key: NodeFS.readFileSync(new URL("./p1b-ingress-client-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("./p1b-ingress-client-cert.pem", import.meta.url)),
};

export const serveOutboundProof = Effect.fn("p1b.serveOutboundProof")(function* (
  backend: NodeHttp.Server,
  maxStreams: number,
) {
  const relay = NodeTls.createServer({
    ...serverCredentials,
    ca: ingressCredentials.cert,
    requestCert: true,
    rejectUnauthorized: true,
  });
  const incoming = new Set<import("node:net").Socket>();
  relay.on("connection", (socket) => {
    incoming.add(socket);
    socket.once("close", () => incoming.delete(socket));
  });
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          relay.once("error", reject);
          relay.listen(0, "127.0.0.1", () => {
            relay.off("error", reject);
            resolve();
          });
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            relay.close(() => resolve());
            for (const socket of incoming) socket.destroy();
          }),
      ),
  );
  const address = relay.address();
  if (address === null || typeof address === "string") throw new Error("Expected a relay port");

  const active = new Map<NodeTls.TLSSocket, NodeTls.TLSSocket | undefined>();
  const pending = new Map<number, (socket: NodeTls.TLSSocket) => void>();
  relay.on("secureConnection", (socket) => {
    const accept = socket.remotePort === undefined ? undefined : pending.get(socket.remotePort);
    if (accept === undefined) socket.destroy();
    else accept(socket);
  });
  let revoked = false;
  const dial = async (): Promise<NodeTls.TLSSocket | "saturated" | "revoked"> => {
    if (revoked) return "revoked";
    if (active.size >= maxStreams) return "saturated";
    const outbound = NodeTls.connect({
      ...ingressCredentials,
      host: address.address,
      port: address.port,
      servername: "localhost",
      ca: serverCredentials.cert,
      rejectUnauthorized: true,
    });
    active.set(outbound, undefined);
    const handshake = Promise.withResolvers<NodeTls.TLSSocket>();
    let localPort: number | undefined;
    const accept = (socket: NodeTls.TLSSocket) => {
      active.set(outbound, socket);
      socket.once("close", () => active.delete(outbound));
      handshake.resolve(socket);
    };
    outbound.once("connect", () => {
      localPort = outbound.localPort;
      if (localPort !== undefined) pending.set(localPort, accept);
    });
    outbound.on("error", handshake.reject);
    outbound.once("close", () => {
      if (active.get(outbound) === undefined) active.delete(outbound);
      handshake.reject(new Error("Outbound TLS connection closed during admission"));
    });
    try {
      const socket = await handshake.promise.catch((error: unknown) => {
        if (revoked) return null;
        throw error;
      });
      if (revoked || socket === null) {
        outbound.destroy();
        socket?.destroy();
        return "revoked";
      }
      if (!outbound.authorized || !socket.authorized) {
        outbound.destroy();
        socket.destroy();
        throw new Error("Expected mutual TLS authentication");
      }
      // Install Node's HTTP parser on the outbound socket without binding a backend listener.
      backend.emit("connection", outbound);
      return socket;
    } finally {
      if (localPort !== undefined) pending.delete(localPort);
    }
  };
  return {
    dial,
    revoke: () => {
      revoked = true;
      for (const [outbound, socket] of active) {
        outbound.destroy();
        socket?.destroy();
      }
    },
  };
});

export const serveLoopback = (server: NodeHttp.Server | NodeHttps.Server) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ origin: string; destroyConnections: () => void }>((resolve, reject) => {
          const connections = new Set<import("node:net").Socket>();
          server.on("connection", (socket) => {
            connections.add(socket);
            socket.once("close", () => connections.delete(socket));
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Expected a TCP listener"));
              return;
            }
            const protocol = server instanceof NodeHttps.Server ? "https" : "http";
            resolve({
              origin: `${protocol}://127.0.0.1:${address.port}`,
              destroyConnections: () => {
                for (const socket of connections) socket.destroy();
              },
            });
          });
        }),
    ),
    ({ destroyConnections }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            destroyConnections();
          }),
      ),
  ).pipe(Effect.map(({ origin }) => origin));

const externalAuthorityHeader = "t3-proof-external-authority";
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const endToEndHeaders = (headers: NodeHttp.IncomingHttpHeaders) => {
  const connectionTokens = new Set(headers.connection?.toLowerCase().split(/\s*,\s*/u));
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHop.has(name) && !connectionTokens.has(name)),
  );
};

const unforwarded = (headers: NodeHttp.IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(endToEndHeaders(headers)).filter(
      ([name]) =>
        name !== "host" &&
        name !== "forwarded" &&
        !name.startsWith("x-forwarded-") &&
        name !== externalAuthorityHeader,
    ),
  );

const forward = (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  target: URL,
  headers: NodeHttp.OutgoingHttpHeaders,
  client: typeof NodeHttp.request = NodeHttp.request,
  options: NodeHttps.RequestOptions = {},
) => {
  const path = request.url;
  if (path === undefined || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    response.writeHead(400).end();
    return;
  }
  const upstream = client(
    target,
    { method: request.method, path, headers, agent: false, ...options },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, endToEndHeaders(reply.headers));
      reply.on("error", (error) => response.destroy(error));
      reply.pipe(response);
    },
  );
  response.on("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  upstream.on("error", () => {
    if (response.destroyed) return;
    if (response.headersSent) response.destroy();
    else response.writeHead(502).end();
  });
  request.pipe(upstream);
};

/** Disposable HTTP streaming proof with mTLS on the private hop. */
export const serveProofIngress = (
  upstream: string,
  canonicalOrigin?: string,
  observe?: (authority: string) => void,
) =>
  Effect.gen(function* () {
    let publicOrigin: URL;
    const privateUrl = yield* serveLoopback(
      NodeHttps.createServer(
        {
          ...serverCredentials,
          ca: ingressCredentials.cert,
          requestCert: true,
          rejectUnauthorized: true,
        },
        (request, response) => {
          const authority = request.headers[externalAuthorityHeader];
          if (authority !== publicOrigin.host) {
            response.writeHead(400).end();
            return;
          }
          observe?.(publicOrigin.origin);
          const canonical = canonicalOrigin === undefined ? publicOrigin : new URL(canonicalOrigin);
          forward(request, response, new URL(upstream), {
            ...unforwarded(request.headers),
            host: canonical.host,
            "x-forwarded-proto": "https",
          });
        },
      ),
    );
    const url = yield* serveLoopback(
      NodeHttps.createServer(serverCredentials, (request, response) => {
        forward(
          request,
          response,
          new URL(privateUrl),
          {
            ...unforwarded(request.headers),
            [externalAuthorityHeader]: publicOrigin.host,
          },
          NodeHttps.request,
          { ...ingressCredentials, ca: serverCredentials.cert },
        );
      }),
    );
    publicOrigin = new URL(url);
    return { url, privateUrl };
  });

export const openProofRequest = (url: string, options: NodeHttp.RequestOptions = {}) =>
  NodeHttps.request(url, {
    ...options,
    agent: false,
    ca: serverCredentials.cert,
    servername: "localhost",
  });

export const proofRequest = (
  url: string,
  options: NodeHttp.RequestOptions & { readonly body?: string } = {},
) =>
  new Promise<{ status: number | undefined; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = openProofRequest(url, options);
      request.on("error", reject);
      request.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        );
      });
      request.end(options.body);
    },
  );
