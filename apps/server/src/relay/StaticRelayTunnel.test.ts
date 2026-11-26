// @effect-diagnostics nodeBuiltinImport:off -- The tests own the TLS listeners and certificate fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RELAY_ADMISSION_HEADER, RELAY_ADMISSION_PATH } from "@t3tools/contracts/relay";
import { requestUrls } from "../auth/McpOAuth.ts";
import { requestUrl } from "../requestUrl.ts";
import { openProofRequest, proofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";
import {
  connectStaticRelayTunnel,
  makeStaticRelayEdge,
} from "@t3tools/relay-core/RelayTunnelTransport";

const relayCredentials = {
  key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
};
const environmentCredentials = {
  key: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url)),
};
const relayFingerprint = new NodeCrypto.X509Certificate(relayCredentials.cert).fingerprint256;
const environmentFingerprint = new NodeCrypto.X509Certificate(environmentCredentials.cert)
  .fingerprint256;

const publicOrigin = "https://localhost";
const canonicalOrigin = "https://canonical.t3.test";
const websocketOptions = {
  ca: relayCredentials.cert,
  servername: "localhost",
  headers: { host: "localhost" },
  perMessageDeflate: false,
};

const serve = (
  backend: NodeHttp.Server,
  options?: {
    readonly admission?: () => "active" | "retired" | "unknown";
    readonly limits?: {
      readonly streams?: number;
      readonly requestBytes?: number;
      readonly responseBytes?: number;
    };
    readonly poolSize?: number;
    readonly conflictingBinding?: "peer-certificate" | "canonical-origin";
    readonly onSlotAvailable?: (available: number) => void;
  },
) =>
  Effect.gen(function* () {
    const edge = makeStaticRelayEdge({
      tunnelTls: { ...relayCredentials, ca: environmentCredentials.cert },
      environmentFingerprint:
        options?.conflictingBinding === "peer-certificate"
          ? relayFingerprint
          : environmentFingerprint,
      publicOrigin,
      canonicalOrigin,
      admission: options?.admission ?? (() => "active"),
      admissionBrowserOrigins: new Set(["https://app.t3.test"]),
      limits: options?.limits,
      ...(options?.onSlotAvailable === undefined
        ? {}
        : { onSlotAvailable: options.onSlotAvailable }),
    });
    const address = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<{ address: string; port: number }>((resolve, reject) => {
            edge.tunnelServer.once("error", reject);
            edge.tunnelServer.listen(0, "127.0.0.1", () => {
              const address = edge.tunnelServer.address();
              if (address === null || typeof address === "string") {
                reject(new Error("Expected TCP address"));
              } else {
                resolve(address);
              }
            });
          }),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              edge.revoke();
              edge.tunnelServer.close(() => resolve());
            }),
        ),
    );
    const disconnected = Promise.withResolvers<void>();
    const incompatible = options?.conflictingBinding !== undefined;
    if (incompatible) {
      edge.tunnelServer.once("connection", (socket) => {
        socket.once("close", () => disconnected.resolve());
      });
    }
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        connectStaticRelayTunnel({
          relay: {
            host: address.address,
            port: address.port,
            servername: "localhost",
            ca: relayCredentials.cert,
            ...environmentCredentials,
          },
          relayFingerprint,
          publicOrigin,
          canonicalOrigin:
            options?.conflictingBinding === "canonical-origin"
              ? "https://other.t3.test"
              : canonicalOrigin,
          backend,
          ...(options?.poolSize === undefined ? {} : { poolSize: options.poolSize }),
        }),
      ),
      (tunnel) => Effect.sync(() => tunnel.close()),
    );
    const publicUrl = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, edge.request)
        .on("checkContinue", edge.checkContinue)
        .on("upgrade", edge.upgrade),
    );
    yield* Effect.promise(() => (incompatible ? disconnected.promise : edge.ready));
    return { edge, publicUrl };
  });

it.live("binds the upstream authority to the authenticated outbound socket", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const scope = yield* Effect.scope;
    const handler = yield* NodeHttpServer.makeHandler(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        seen.push(request.url);
        return HttpServerResponse.jsonUnsafe({
          host: request.headers.host,
          external: Option.getOrUndefined(requestUrl(request))?.origin,
          oauth: requestUrls(request),
          forwarded: request.headers.forwarded,
          source: request.headers["x-forwarded-for"],
          private: request.headers["t3-relay-external-authority"],
          delivery: request.headers["x-t3-relay-delivery-id"],
          cookie: request.headers.cookie,
        });
      }),
      { scope },
    );
    const backend = NodeHttp.createServer(handler);
    let admission: "active" | "retired" = "active";
    const fixture = yield* serve(backend, { admission: () => admission });
    const result = yield* Effect.promise(() =>
      proofRequest(fixture.publicUrl, {
        path: "/oauth/mcp/authorize?code=fixture",
        headers: {
          host: "localhost",
          cookie: "fixture=session",
          forwarded: "host=untrusted.test",
          "x-forwarded-for": "192.0.2.10",
          "t3-relay-external-authority": "untrusted.test",
          "x-t3-relay-delivery-id": "untrusted",
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      host: "canonical.t3.test",
      external: "https://localhost",
      oauth: {
        issuer: "https://canonical.t3.test",
        resource: "https://canonical.t3.test/mcp",
      },
      cookie: "fixture=session",
    });
    const badAuthority = yield* Effect.promise(() =>
      proofRequest(fixture.publicUrl, { headers: { host: "untrusted.test" } }),
    );
    expect(badAuthority.status).toBe(421);
    const active = yield* Effect.promise(() =>
      proofRequest(fixture.publicUrl, {
        method: "HEAD",
        path: RELAY_ADMISSION_PATH,
        headers: { host: "localhost", origin: "https://app.t3.test" },
      }),
    );
    expect(active.status).toBe(204);
    expect(active.headers).toMatchObject({
      [RELAY_ADMISSION_HEADER.toLowerCase()]: "active",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://app.t3.test",
      "access-control-expose-headers": RELAY_ADMISSION_HEADER,
    });
    expect(active.headers["access-control-allow-credentials"]).toBeUndefined();
    admission = "retired";
    const retiredAdmission = yield* Effect.promise(() =>
      proofRequest(fixture.publicUrl, {
        method: "HEAD",
        path: RELAY_ADMISSION_PATH,
        headers: { host: "localhost", origin: "https://foreign.test" },
      }),
    );
    expect(retiredAdmission.status).toBe(410);
    expect(retiredAdmission.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBe("retired");
    expect(retiredAdmission.headers["access-control-allow-origin"]).toBeUndefined();

    const retired = yield* Effect.promise(() =>
      proofRequest(fixture.publicUrl, {
        headers: { host: "localhost", cookie: "fixture=session" },
      }),
    );
    expect(retired.status).toBe(410);
    expect(seen).toEqual(["/oauth/mcp/authorize?code=fixture"]);
    expect(backend.listening).toBe(false);
  }),
);

it.live("preserves late destination authentication headers within the response byte budget", () =>
  Effect.gen(function* () {
    const backend = NodeHttp.createServer((_request, response) => {
      response
        .writeHead(401, [
          "connection",
          "close, h",
          ...Array.from({ length: 2048 }, () => ["h", ""]).flat(),
          "www-authenticate",
          'Bearer realm="destination"',
          "set-cookie",
          "destination=session; Secure; HttpOnly; Path=/a,__Host-t3-relay=literal",
        ])
        .end();
    });
    const { publicUrl } = yield* serve(backend);
    const reply = yield* Effect.promise(() =>
      proofRequest(publicUrl, { headers: { host: "localhost" } }),
    );
    expect(reply.status).toBe(401);
    expect(reply.headers["www-authenticate"]).toBe('Bearer realm="destination"');
    expect(reply.headers["set-cookie"]).toEqual([
      "destination=session; Secure; HttpOnly; Path=/a,__Host-t3-relay=literal",
    ]);
    expect(reply.headers.h).toBeUndefined();
  }),
);

it.live.each(["peer-certificate", "canonical-origin"] as const)(
  "withholds credentials when the outbound %s does not match the enrolled binding",
  (conflictingBinding) =>
    Effect.gen(function* () {
      let forwarded = 0;
      const backend = NodeHttp.createServer((_request, response) => {
        forwarded += 1;
        response.end();
      });
      const { publicUrl } = yield* serve(backend, { conflictingBinding, poolSize: 1 });
      const unavailable = yield* Effect.promise(() =>
        proofRequest(publicUrl, {
          headers: { host: "localhost", cookie: "fixture=session" },
          path: "/api/auth/session",
        }),
      );
      expect(unavailable.status).toBe(503);
      expect(forwarded).toBe(0);
    }),
);

it.live("refuses a declared upload beyond the relay's request budget before forwarding", () =>
  Effect.gen(function* () {
    let forwarded = 0;
    const backend = NodeHttp.createServer((_request, response) => {
      forwarded += 1;
      response.end();
    });
    const { publicUrl } = yield* serve(backend, { limits: { requestBytes: 4 } });
    const refused = yield* Effect.promise(() =>
      proofRequest(publicUrl, {
        method: "POST",
        headers: { host: "localhost", "content-length": "5" },
        body: "12345",
      }),
    );
    expect(refused.status).toBe(413);
    expect(forwarded).toBe(0);
  }),
);

it.live.each([
  { reason: "request budget", status: 413 },
  { reason: "retirement", status: 410 },
] as const)("aborts a partial upload after $reason", ({ reason, status }) =>
  Effect.gen(function* () {
    const firstBytes = Promise.withResolvers<Buffer>();
    const bodyClosed = Promise.withResolvers<boolean>();
    const chunks: Buffer[] = [];
    const backend = NodeHttp.createServer((request) => {
      request.on("data", (part: Buffer) => chunks.push(part));
      request.once("data", firstBytes.resolve);
      request.once("close", () => bodyClosed.resolve(request.complete));
    });
    const { edge, publicUrl } = yield* serve(backend, {
      limits: { requestBytes: 4, streams: 1 },
      poolSize: 1,
    });
    const response = Promise.withResolvers<number | undefined>();
    const upload = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const request = openProofRequest(publicUrl, {
          method: "POST",
          headers: { host: "localhost" },
        });
        request.once("error", response.reject);
        request.once("response", (reply) => {
          reply.resume();
          response.resolve(reply.statusCode);
        });
        return request;
      }),
      (request) => Effect.sync(() => request.destroy()),
    );
    const prefix = Buffer.from([0x00, 0x80, 0xff, 0x01]);
    upload.write(prefix);
    expect(yield* Effect.promise(() => firstBytes.promise)).toEqual(prefix);
    const saturated = yield* Effect.promise(() =>
      proofRequest(publicUrl, { headers: { host: "localhost" } }),
    );
    expect(saturated.status).toBe(503);
    if (reason === "request budget") upload.end(Buffer.from([0x02]));
    else edge.revoke();
    expect(yield* Effect.promise(() => response.promise)).toBe(status);
    expect(yield* Effect.promise(() => bodyClosed.promise)).toBe(false);
    expect(Buffer.concat(chunks)).toEqual(prefix);
  }),
);

it.live("fills 64 shared HTTP and WebSocket slots with the default connector pool", () =>
  Effect.gen(function* () {
    const websocket = new NodeWS.WebSocketServer({ noServer: true, maxPayload: 4096 });
    const replacementReady = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const sockets = new Set<NodeHttp.IncomingMessage["socket"]>();
    let dispatched = 0;
    const backend = NodeHttp.createServer((_request, response) => {
      dispatched += 1;
      response.writeHead(200).write(Buffer.of(1));
    });
    backend.on("upgrade", (request, socket, head) => {
      dispatched += 1;
      websocket.handleUpgrade(request, socket, head, () => {});
    });
    backend.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0) drained.resolve();
      });
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { publicUrl } = yield* serve(backend, {
          onSlotAvailable: () => {
            if (dispatched === 64) replacementReady.resolve();
          },
        });
        const upgraded = Promise.withResolvers<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const client = new NodeWS.WebSocket(
              publicUrl.replace("https:", "wss:") + "/ws",
              websocketOptions,
            );
            client.once("error", upgraded.reject);
            client.once("open", upgraded.resolve);
            return client;
          }),
          (client) => Effect.sync(() => client.terminate()),
        );
        yield* Effect.promise(() => upgraded.promise);

        const start = () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const response = Promise.withResolvers<number | undefined>();
              const request = openProofRequest(publicUrl, { headers: { host: "localhost" } });
              request.on("error", response.reject);
              request.once("response", (reply) => {
                reply.on("error", response.reject);
                reply.resume();
                response.resolve(reply.statusCode);
              });
              request.end();
              return { request, response: response.promise };
            }),
            ({ request }) => Effect.sync(() => request.destroy()),
          );

        const first = yield* start();
        expect(yield* Effect.promise(() => first.response)).toBe(200);
        for (let slot = 3; slot <= 64; slot += 1) {
          const held = yield* start();
          expect(yield* Effect.promise(() => held.response), `Stream ${slot}`).toBe(200);
        }
        expect(dispatched).toBe(64);
        expect(sockets.size).toBe(64);
        const saturated = yield* Effect.promise(() =>
          proofRequest(publicUrl, { headers: { host: "localhost" } }),
        );
        expect(saturated.status).toBe(503);
        expect(dispatched).toBe(64);
        first.request.destroy();
        yield* Effect.promise(() => replacementReady.promise);
        const recovered = yield* start();
        expect(yield* Effect.promise(() => recovered.response)).toBe(200);
        expect(dispatched).toBe(65);
        expect(sockets.size).toBe(64);
      }),
    );
    yield* Effect.promise(() => drained.promise);
    expect(sockets.size).toBe(0);
  }),
);

it.live("waits for an authenticated socket to finish registration before dispatch", () =>
  Effect.gen(function* () {
    const edge = makeStaticRelayEdge({
      tunnelTls: { ...relayCredentials, ca: environmentCredentials.cert },
      environmentFingerprint,
      publicOrigin,
      canonicalOrigin,
      admission: () => "active",
      limits: { streams: 1 },
    });
    const port = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            edge.tunnelServer.listen(0, "127.0.0.1", () => {
              const address = edge.tunnelServer.address();
              if (address !== null && typeof address !== "string") resolve(address.port);
            });
          }),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              edge.revoke();
              edge.tunnelServer.close(() => resolve());
            }),
        ),
    );
    const authenticated = Promise.withResolvers<void>();
    edge.tunnelServer.once("secureConnection", () => authenticated.resolve());
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeTls.connect({
          ...environmentCredentials,
          host: "127.0.0.1",
          port,
          servername: "localhost",
          ca: relayCredentials.cert,
          ALPNProtocols: ["t3-relay-http1"],
        }),
      ),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    yield* Effect.promise(() => authenticated.promise);
    const queued = Promise.withResolvers<void>();
    const url = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (request, reply) => {
        edge.request(request, reply);
        queued.resolve();
      }),
    );
    const reply = proofRequest(url, { headers: { host: "localhost" } });
    yield* Effect.promise(() => queued.promise);
    socket.once("data", () =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"),
    );
    socket.write(
      NodeCrypto.createHash("sha256")
        .update(publicOrigin + "\n" + canonicalOrigin)
        .digest(),
    );
    const response = yield* Effect.promise(() => reply);
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
  }),
);

it.live("enforces the public asset policy on HTML while retaining upstream CSP", () =>
  Effect.gen(function* () {
    const stricterPolicy = "script-src 'none'";
    const framePolicy = "frame-ancestors 'none'";
    let requiredCsp: string | string[] | undefined;
    const backend = NodeHttp.createServer((request, response) => {
      requiredCsp = request.headers["sec-required-csp"];
      response
        .writeHead(200, [
          "content-type",
          "text/html; charset=utf-8",
          "content-security-policy",
          stricterPolicy,
          "content-security-policy",
          framePolicy,
        ])
        .end("<p>Signed document</p>");
    });
    const { publicUrl } = yield* serve(backend);
    const document = yield* Effect.promise(() =>
      proofRequest(publicUrl, {
        path: "/api/assets/signed/page.html?revision=1",
        headers: { host: "localhost", "sec-required-csp": "default-src https://foreign.test" },
      }),
    );
    expect(document.status).toBe(200);
    expect(document.body).toBe("<p>Signed document</p>");
    expect(document.headers["content-security-policy"]).toBe(
      `${stricterPolicy}, ${framePolicy}, default-src https://localhost/api/assets/; ` +
        "script-src https://localhost/api/assets/ 'unsafe-inline'; " +
        "style-src https://localhost/api/assets/ 'unsafe-inline'; " +
        "img-src https://localhost/api/assets/ data: blob:; " +
        "media-src https://localhost/api/assets/ data: blob:; " +
        "font-src https://localhost/api/assets/ data:; " +
        "frame-src https://localhost/api/assets/ blob:; " +
        "form-action https://localhost/api/assets/; object-src 'none'; base-uri 'none'",
    );
    expect(requiredCsp).toBeUndefined();
  }),
);

it.live(
  "refuses asset redirects before exposing their location and preserves OAuth redirects",
  () =>
    Effect.gen(function* () {
      const location = "https://foreign.test/redirect-target";
      const backend = NodeHttp.createServer((_request, response) => {
        response.writeHead(307, { location, "content-type": "text/html" }).end("redirect");
      });
      const { publicUrl } = yield* serve(backend);
      for (const path of ["/api/assets/signed/script.js", "/%61pi/%61ssets/signed/script.js"]) {
        const asset = yield* Effect.promise(() =>
          proofRequest(publicUrl, { path, headers: { host: "localhost" } }),
        );
        expect(asset.status).toBe(502);
        expect(asset.headers.location).toBeUndefined();
        expect(asset.body).toBe("");
      }
      const oauth = yield* Effect.promise(() =>
        proofRequest(publicUrl, {
          path: "/oauth/mcp/authorize?code=fixture",
          headers: { host: "localhost" },
        }),
      );
      expect(oauth.status).toBe(307);
      expect(oauth.headers.location).toBe(location);
      expect(oauth.headers["content-security-policy"]).toBeUndefined();
    }),
);

it.live("preserves partial media responses without changing their byte range", () =>
  Effect.gen(function* () {
    const backend = NodeHttp.createServer((request, response) => {
      if (request.headers.range !== "bytes=2-4") {
        response.writeHead(416).end();
        return;
      }
      response
        .writeHead(206, {
          "content-range": "bytes 2-4/6",
          "content-type": "application/octet-stream",
        })
        .end("cde");
    });
    const { publicUrl } = yield* serve(backend);
    const partial = yield* Effect.promise(() =>
      proofRequest(publicUrl, {
        path: "/api/assets/signed/media.mp4",
        headers: { host: "localhost", range: "bytes=2-4" },
      }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toBe("bytes 2-4/6");
    expect(partial.headers["content-security-policy"]).toBeUndefined();
    expect(partial.body).toBe("cde");
  }),
);

it.live("rejects an oversized declared download before sending its response", () =>
  Effect.gen(function* () {
    const backend = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-length": "5" }).end("12345");
    });
    const { publicUrl } = yield* serve(backend, { limits: { responseBytes: 4 } });
    const refused = yield* Effect.promise(() =>
      proofRequest(publicUrl, { headers: { host: "localhost" } }),
    );
    expect(refused.status).toBe(502);
    expect(refused.body).toBe("");
  }),
);

it.live("closes the existing bounded WebSocket when relay admission is revoked", () =>
  Effect.gen(function* () {
    const websocket = new NodeWS.WebSocketServer({ noServer: true, maxPayload: 4096 });
    const backend = NodeHttp.createServer();
    backend.on("upgrade", (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (peer) => {
        peer.on("message", (bytes, binary) => peer.send(bytes, { binary }));
      });
    });
    const { edge, publicUrl } = yield* serve(backend);
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () => new NodeWS.WebSocket(publicUrl.replace("https:", "wss:") + "/ws", websocketOptions),
      ),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    const echo = Promise.withResolvers<unknown>();
    const closed = Promise.withResolvers<number>();
    client.once("error", echo.reject);
    client.once("close", closed.resolve);
    client.once("open", () => client.send(Buffer.from([0x00, 0x80, 0xff])));
    client.once("message", echo.resolve);
    expect(yield* Effect.promise(() => echo.promise)).toEqual(Buffer.from([0x00, 0x80, 0xff]));
    edge.revoke();
    expect(yield* Effect.promise(() => closed.promise)).toBe(1006);
    const refused = yield* Effect.promise(
      () =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = openProofRequest(publicUrl, { headers: { host: "localhost" } });
          request.once("error", reject);
          request.once("response", (response) => {
            response.resume();
            resolve(response.statusCode);
          });
          request.end();
        }),
    );
    expect(refused).toBe(410);
  }),
);

it.live("reports tunnel TLS identity rejection before handing a socket to the backend", () =>
  Effect.gen(function* () {
    const rejected: boolean[] = [];
    for (const variant of ["ca", "hostname", "pin", "alpn"] as const) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const disconnected = Promise.withResolvers<void>();
          const server = NodeTls.createServer({
            ...relayCredentials,
            ALPNProtocols: variant === "alpn" ? [] : ["t3-relay-http1"],
          });
          server.once("connection", (socket) => socket.once("close", () => disconnected.resolve()));
          const port = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    const address = server.address();
                    if (address === null || typeof address === "string")
                      return reject(new Error("Expected TCP address"));
                    resolve(address.port);
                  });
                }),
            ),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          let notified = false;
          let backendConnections = 0;
          const backend = NodeHttp.createServer();
          backend.on("connection", () => backendConnections++);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              connectStaticRelayTunnel({
                relay: {
                  host: "127.0.0.1",
                  port,
                  servername: variant === "hostname" ? "wrong.example.test" : "localhost",
                  ca: variant === "ca" ? environmentCredentials.cert : relayCredentials.cert,
                  ...environmentCredentials,
                },
                relayFingerprint: variant === "pin" ? environmentFingerprint : relayFingerprint,
                publicOrigin,
                canonicalOrigin,
                backend,
                poolSize: 1,
                onIdentityRejected: () => {
                  notified = true;
                },
              }),
            ),
            (tunnel) => Effect.sync(() => tunnel.close()),
          );
          yield* Effect.promise(() => disconnected.promise);
          rejected.push(notified);
          expect(backendConnections).toBe(0);
        }),
      );
    }
    expect(rejected).toEqual([true, true, true, true]);
  }),
);
