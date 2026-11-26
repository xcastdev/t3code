// @effect-diagnostics nodeBuiltinImport:off -- The integration fixtures own disposable SQLite state and TLS sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { SelfHostedRelayIssuePairingInput } from "@t3tools/contracts/selfHostedRelay";
import * as Forwarding from "@t3tools/relay-core/RelayForwarding";
import * as Runtime from "@t3tools/relay-core/RelayRuntime";
import {
  connectStaticRelayTunnel,
  makeStaticRelayEdge,
} from "@t3tools/relay-core/RelayTunnelTransport";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { openProofRequest, proofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";

const relayTls = {
  key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
};
const publisherTls = {
  key: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url)),
};
const otherPublisherTls = {
  key: NodeFS.readFileSync(new URL("./fixtures/relay-push-apns-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("./fixtures/relay-push-apns-cert.pem", import.meta.url)),
};
const relayFingerprint = new NodeCrypto.X509Certificate(relayTls.cert).fingerprint256;
const environmentFingerprint = new NodeCrypto.X509Certificate(publisherTls.cert).fingerprint256;

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const unbound = EnvironmentId.make("unbound");
const binding = (environmentId: EnvironmentId, publicOrigin: string) => ({
  environmentId,
  publicOrigin,
  canonicalOrigin: `https://${environmentId}.example.test`,
  environmentFingerprint,
  tunnelTls: { ...relayTls, ca: publisherTls.cert },
  listen: { host: "127.0.0.1", port: 0 },
});
const a = binding(environmentA, "https://localhost");
const b = {
  ...binding(environmentB, "https://localhost:8443"),
  environmentFingerprint: new NodeCrypto.X509Certificate(otherPublisherTls.cert).fingerprint256,
  tunnelTls: { ...relayTls, ca: otherPublisherTls.cert },
};
const layer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-forwarding-"))),
    (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  ).pipe(
    Effect.map((homeDirectory) =>
      Forwarding.layer([a, b]).pipe(
        Layer.provideMerge(Runtime.relayRuntimeLayer({ homeDirectory })),
      ),
    ),
  ),
);

const setup = Effect.fn("RelayForwardingTest.setup")(function* () {
  const relay = yield* Runtime.RelayRuntime;
  const forwarding = yield* Forwarding.RelayForwarding;
  const owner = yield* relay.bootstrapOwner();
  for (const environmentId of [environmentA, environmentB, unbound]) {
    yield* relay.enrollEnvironment(owner.credential, {
      version: 1,
      environmentId,
      name: environmentId,
    });
  }
  const pair = Effect.fn("RelayForwardingTest.pair")(function* (
    subject: SelfHostedRelayIssuePairingInput["subject"],
    permissions: SelfHostedRelayIssuePairingInput["scope"]["permissions"],
    environmentId: EnvironmentId,
  ) {
    const pairing = yield* relay.issuePairing(owner.credential, {
      version: 1,
      subject,
      scope: { permissions, environments: { kind: "selected", environmentIds: [environmentId] } },
      expiresAt: "2099-01-01T00:00:00Z",
    });
    return yield* relay.redeemPairing(pairing.credential);
  });
  const publisher = (environmentId: EnvironmentId) =>
    pair({ kind: "publisher", environmentId }, ["environment.tunnel"], environmentId);
  const client = (environmentId: EnvironmentId) =>
    pair({ kind: "client" }, ["forward"], environmentId);
  return { relay, forwarding, owner, publisher, client };
});

const connect = Effect.fn("RelayForwardingTest.connect")(function* (
  target: typeof a,
  port: number,
  backend: NodeHttp.Server,
  poolSize?: number,
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      connectStaticRelayTunnel({
        relay: {
          ...(target.environmentId === environmentB ? otherPublisherTls : publisherTls),
          ca: relayTls.cert,
          host: "127.0.0.1",
          port,
          servername: "localhost",
        },
        relayFingerprint,
        publicOrigin: target.publicOrigin,
        canonicalOrigin: target.canonicalOrigin,
        backend,
        ...(poolSize === undefined ? {} : { poolSize }),
      }),
    ),
    (tunnel) => Effect.sync(() => tunnel.close()),
  );
});

const ingress = Effect.fn("RelayForwardingTest.ingress")(function* (
  forwarding: Forwarding.RelayForwarding["Service"],
  target: typeof a,
  credential: () => string,
  signal?: AbortSignal,
) {
  const scope = yield* Effect.scope;
  const run = yield* Effect.context<never>().pipe(Effect.map(Effect.runPromiseWith));
  return yield* serveLoopback(
    NodeHttps.createServer(relayTls, (request, response) => {
      void run(
        forwarding
          .forward(credential(), target.environmentId, {
            kind: "http",
            request,
            response,
            ...(signal ? { signal } : {}),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                const status =
                  error._tag === "RelayAuthenticationError"
                    ? 401
                    : error._tag === "RelayAccessDeniedError"
                      ? 403
                      : 503;
                if (!response.destroyed) response.writeHead(status).end();
              }),
            ),
            Effect.forkIn(scope),
          ),
      );
    }),
  );
});

it.live("carries exact hook requests through the publisher tunnel without a client grant", () =>
  Effect.gen(function* () {
    const { forwarding, publisher, client } = yield* setup();
    const published = yield* publisher(environmentA);
    const lease = yield* forwarding.openPublisher(published.credential, environmentA);
    const received = Promise.withResolvers<{
      method: string | undefined;
      target: string | undefined;
      signature: string | undefined;
      body: Buffer;
    }>();
    const backend = NodeHttp.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.resolve({
          method: request.method,
          target: request.url,
          signature: request.headers["x-sender-signature"]?.toString(),
          body: Buffer.concat(chunks),
        });
        response.writeHead(429, { "retry-after": "17", "x-t3-hook-outcome": "rate_limited" }).end();
      });
    });
    yield* connect(a, lease.address.port, backend);
    yield* lease.ready;
    const target = "/api/relay-hooks/hook/%61b?x=%2f&x=+%20";
    const body = Buffer.from([0, 255, 13, 10]);
    const reply = yield* forwarding.deliverHook(environmentA, {
      method: "PATCH",
      rawTarget: target,
      headers: { "x-sender-signature": "sender-proof" },
      body,
    });
    expect(reply).toEqual({ status: 429, retryAfter: "17", outcome: "rate_limited" });
    expect(yield* Effect.promise(() => received.promise)).toEqual({
      method: "PATCH",
      target,
      signature: "sender-proof",
      body,
    });
    expect(
      (yield* Effect.flip(
        forwarding.deliverHook(environmentA, {
          method: "GET",
          rawTarget: "/api/status",
          headers: {},
          body: Buffer.alloc(0),
        }),
      ))._tag,
    ).toBe("RelayInputError");
    const forwarder = yield* client(environmentA);
    const interactive = yield* ingress(forwarding, a, () => forwarder.credential);
    const interactiveRequest = yield* Effect.promise(() =>
      proofRequest(interactive, {
        path: target,
        method: "PATCH",
        headers: { host: "localhost", "x-t3-self-hosted-hook-proof": "untrusted" },
      }),
    );
    expect(interactiveRequest.status).toBe(404);
  }).pipe(Effect.provide(layer)),
);

it.live("requires relay admission before the destination checks its own credentials", () =>
  Effect.gen(function* () {
    const { forwarding, publisher, client } = yield* setup();
    const publisherA = yield* publisher(environmentA);
    const publisherUnbound = yield* publisher(unbound);
    const clientA = yield* client(environmentA);
    const clientB = yield* client(environmentB);
    for (const [credential, environmentId] of [
      [publisherA.credential, environmentB],
      [publisherUnbound.credential, unbound],
      [clientA.credential, environmentA],
    ] as const) {
      expect((yield* Effect.flip(forwarding.openPublisher(credential, environmentId)))._tag).toBe(
        "RelayAccessDeniedError",
      );
    }

    const lease = yield* forwarding.openPublisher(publisherA.credential, environmentA);
    const seen: Array<unknown> = [];
    const backend = NodeHttp.createServer((request, response) => {
      const authorization = request.headers.authorization;
      seen.push([authorization, request.headers.cookie, request.url, request.headers.host]);
      response.writeHead(authorization === "Bearer destination" ? 200 : 401).end();
    });
    yield* connect(a, lease.address.port, backend);
    yield* lease.ready;
    let relayCredential = "invalid";
    const url = yield* ingress(forwarding, a, () => relayCredential);
    const request = (authorization: string) =>
      proofRequest(url, {
        path: "/api/assets/file?ticket=opaque%2Bvalue",
        headers: { host: "localhost", authorization, cookie: "destination=opaque" },
      });
    expect((yield* Effect.promise(() => request("Bearer destination"))).status).toBe(401);
    relayCredential = clientB.credential;
    expect((yield* Effect.promise(() => request("Bearer destination"))).status).toBe(403);
    relayCredential = publisherA.credential;
    expect((yield* Effect.promise(() => request("Bearer destination"))).status).toBe(403);
    expect(seen).toEqual([]);

    relayCredential = clientA.credential;
    expect((yield* Effect.promise(() => request("Bearer wrong"))).status).toBe(401);
    expect((yield* Effect.promise(() => request("Bearer destination"))).status).toBe(200);
    expect(seen).toEqual([
      [
        "Bearer wrong",
        "destination=opaque",
        "/api/assets/file?ticket=opaque%2Bvalue",
        "environment-a.example.test",
      ],
      [
        "Bearer destination",
        "destination=opaque",
        "/api/assets/file?ticket=opaque%2Bvalue",
        "environment-a.example.test",
      ],
    ]);
  }).pipe(Effect.provide(layer)),
);

it.live("skips disconnected queue entries and dispatches the next live waiter", () =>
  Effect.gen(function* () {
    for (const destroySocket of [false, true]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const queued = Promise.withResolvers<NodeHttp.ServerResponse>();
          const survivorQueued = Promise.withResolvers<void>();
          let doomed: NodeHttp.ServerResponse | undefined;
          const edge = makeStaticRelayEdge({
            ...a,
            admission: () => "active",
            onSlotAvailable: () => {
              const response = doomed;
              doomed = undefined;
              if (destroySocket) response?.socket?.destroy();
              else response?.destroy();
            },
          });
          const address = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<ReturnType<typeof edge.tunnelServer.address>>((resolve) => {
                  edge.tunnelServer.listen(0, "127.0.0.1", () =>
                    resolve(edge.tunnelServer.address()),
                  );
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
          if (!address || typeof address === "string") throw new Error("Expected TCP address");
          const url = yield* serveLoopback(
            NodeHttps.createServer(relayTls, (request, response) => {
              edge.request(request, response);
              if (request.url === "/doomed") queued.resolve(response);
              if (request.url === "/survivor") survivorQueued.resolve();
            }),
          );
          const cancelled = proofRequest(url, {
            path: "/doomed",
            headers: { host: "localhost" },
          }).then(
            () => false,
            () => true,
          );
          doomed = yield* Effect.promise(() => queued.promise);
          const survivor = proofRequest(url, { path: "/survivor", headers: { host: "localhost" } });
          yield* Effect.promise(() => survivorQueued.promise);
          const seen: Array<string | undefined> = [];
          yield* connect(
            a,
            address.port,
            NodeHttp.createServer((request, response) => {
              seen.push(request.url);
              response.end("ok");
            }),
            1,
          );
          expect(yield* Effect.promise(() => cancelled)).toBe(true);
          const result = yield* Effect.promise(() => survivor);
          expect(result.status).toBe(200);
          expect(result.body).toBe("ok");
          expect(seen).toEqual(["/survivor"]);
        }),
      );
    }
  }),
);

const streamingDestination = () => {
  const responses = new Map<
    string,
    {
      readonly response: NodeHttp.ServerResponse;
      readonly closed: Promise<void>;
    }
  >();
  const backend = NodeHttp.createServer((request, response) => {
    if (request.url === undefined) throw new Error("Expected request target");
    const closed = Promise.withResolvers<void>();
    responses.set(request.url, { response, closed: closed.promise });
    response.once("close", () => closed.resolve());
    response.writeHead(200).write("first");
  });
  const exchange = (path: string) => {
    const result = responses.get(path);
    if (!result) throw new Error(`Destination did not receive ${path}`);
    return result;
  };
  return { backend, exchange };
};

const openStream = Effect.fn("RelayForwardingTest.openStream")(function* (
  url: string,
  host: string,
  path: string,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const first = Promise.withResolvers<string>();
      const closed = Promise.withResolvers<{ complete: boolean; body: string }>();
      const request = openProofRequest(url, { path, headers: { host } });
      request.on("error", () => {
        first.resolve("");
        closed.resolve({ complete: false, body: "" });
      });
      request.once("response", (reply) => {
        let body = "";
        reply.setEncoding("utf8");
        reply.on("error", () => {});
        reply.on("data", (chunk: string) => {
          body += chunk;
          first.resolve(body);
        });
        reply.once("close", () => {
          first.resolve(body);
          closed.resolve({ complete: reply.complete, body });
        });
      });
      request.end();
      return { request, first: first.promise, closed: closed.promise };
    }),
    ({ request }) => Effect.sync(() => request.destroy()),
  );
  expect(yield* Effect.promise(() => client.first)).toBe("first");
  return client;
});

it.live(
  "revokes only the affected relay session's stream and treats client disconnect as local",
  () =>
    Effect.gen(function* () {
      const { relay, forwarding, owner, publisher, client } = yield* setup();
      const publisherA = yield* publisher(environmentA);
      const first = yield* client(environmentA);
      const second = yield* client(environmentA);
      const lease = yield* forwarding.openPublisher(publisherA.credential, environmentA);
      const destination = streamingDestination();
      yield* connect(a, lease.address.port, destination.backend);
      yield* lease.ready;
      const firstUrl = yield* ingress(forwarding, a, () => first.credential);
      const secondUrl = yield* ingress(forwarding, a, () => second.credential);

      const revoked = yield* openStream(firstUrl, "localhost", "/revoked");
      const healthy = yield* openStream(secondUrl, "localhost", "/healthy");
      yield* relay.revokeSession(owner.credential, first.sessionId);
      expect(yield* Effect.promise(() => revoked.closed)).toEqual({
        complete: false,
        body: "first",
      });
      yield* Effect.promise(() => destination.exchange("/revoked").closed);
      expect(lease.signal.aborted).toBe(false);

      const future = yield* Effect.promise(() =>
        proofRequest(firstUrl, { headers: { host: "localhost" } }),
      );
      expect(future.status).toBe(401);
      destination.exchange("/healthy").response.end("last");
      expect(yield* Effect.promise(() => healthy.closed)).toEqual({
        complete: true,
        body: "firstlast",
      });

      const disconnected = yield* openStream(secondUrl, "localhost", "/disconnected");
      disconnected.request.destroy();
      yield* Effect.promise(() => destination.exchange("/disconnected").closed);
      const replacement = yield* openStream(secondUrl, "localhost", "/replacement");
      destination.exchange("/replacement").response.end("last");
      expect(yield* Effect.promise(() => replacement.closed)).toEqual({
        complete: true,
        body: "firstlast",
      });
    }).pipe(Effect.provide(layer)),
);

it.live(
  "withdraws revoked publisher and environment leases while another environment streams",
  () =>
    Effect.gen(function* () {
      const { relay, forwarding, owner, publisher, client } = yield* setup();
      const publisherA = yield* publisher(environmentA);
      const publisherB = yield* publisher(environmentB);
      const nextPublisher = yield* publisher(environmentA);
      const clientA = yield* client(environmentA);
      const clientB = yield* client(environmentB);
      const leaseA = yield* forwarding.openPublisher(publisherA.credential, environmentA);
      const leaseB = yield* forwarding.openPublisher(publisherB.credential, environmentB);
      expect(
        yield* Effect.flip(forwarding.openPublisher(nextPublisher.credential, environmentA)),
      ).toMatchObject({ reason: "publisher-active" });

      const destinationA = streamingDestination();
      const destinationB = streamingDestination();
      yield* connect(a, leaseA.address.port, destinationA.backend);
      yield* connect(b, leaseB.address.port, destinationB.backend);
      yield* leaseA.ready;
      yield* leaseB.ready;
      const urlA = yield* ingress(forwarding, a, () => clientA.credential);
      const urlB = yield* ingress(forwarding, b, () => clientB.credential);

      const revokedPublisher = yield* openStream(urlA, "localhost", "/publisher");
      const healthy = yield* openStream(urlB, "localhost:8443", "/healthy");
      yield* relay.revokeSession(owner.credential, publisherA.sessionId);
      expect(leaseA.signal.aborted).toBe(true);
      expect((yield* Effect.promise(() => revokedPublisher.closed)).complete).toBe(false);
      yield* Effect.promise(() => destinationA.exchange("/publisher").closed);
      expect(
        (yield* Effect.flip(forwarding.openPublisher(publisherA.credential, environmentA)))._tag,
      ).toBe("RelayAuthenticationError");
      expect(
        (yield* Effect.promise(() => proofRequest(urlA, { headers: { host: "localhost" } })))
          .status,
      ).toBe(503);

      const replacement = yield* forwarding.openPublisher(nextPublisher.credential, environmentA);
      yield* connect(a, replacement.address.port, destinationA.backend);
      yield* replacement.ready;
      const revokedEnvironment = yield* openStream(urlA, "localhost", "/environment");
      yield* relay.revokeEnvironment(owner.credential, environmentA);
      expect(replacement.signal.aborted).toBe(true);
      expect((yield* Effect.promise(() => revokedEnvironment.closed)).complete).toBe(false);
      yield* Effect.promise(() => destinationA.exchange("/environment").closed);
      expect(
        (yield* Effect.promise(() => proofRequest(urlA, { headers: { host: "localhost" } })))
          .status,
      ).toBe(403);
      expect(
        (yield* Effect.flip(forwarding.openPublisher(nextPublisher.credential, environmentA)))._tag,
      ).toBe("RelayAuthenticationError");

      expect(leaseB.signal.aborted).toBe(false);
      destinationB.exchange("/healthy").response.end("last");
      expect(yield* Effect.promise(() => healthy.closed)).toEqual({
        complete: true,
        body: "firstlast",
      });
      const stillAvailable = yield* openStream(urlB, "localhost:8443", "/still-available");
      destinationB.exchange("/still-available").response.end("last");
      expect(yield* Effect.promise(() => stillAvailable.closed)).toEqual({
        complete: true,
        body: "firstlast",
      });
    }).pipe(Effect.provide(layer)),
);

it.live("discards an already cancelled call before it takes a tunnel slot", () =>
  Effect.gen(function* () {
    const { forwarding, publisher, client } = yield* setup();
    const publisherA = yield* publisher(environmentA);
    const clientA = yield* client(environmentA);
    const lease = yield* forwarding.openPublisher(publisherA.credential, environmentA);
    const seen: Array<string | undefined> = [];
    yield* connect(
      a,
      lease.address.port,
      NodeHttp.createServer((request, response) => {
        seen.push(request.url);
        response.end("ok");
      }),
    );
    yield* lease.ready;
    const cancelledUrl = yield* ingress(
      forwarding,
      a,
      () => clientA.credential,
      AbortSignal.abort(),
    );
    const cancelled = yield* Effect.promise(() =>
      proofRequest(cancelledUrl, { path: "/cancelled", headers: { host: "localhost" } }).then(
        () => false,
        () => true,
      ),
    );
    expect(cancelled).toBe(true);
    const url = yield* ingress(forwarding, a, () => clientA.credential);
    expect(
      (yield* Effect.promise(() =>
        proofRequest(url, { path: "/allowed", headers: { host: "localhost" } }),
      )).body,
    ).toBe("ok");
    expect(seen).toEqual(["/allowed"]);
  }).pipe(Effect.provide(layer)),
);

it.live(
  "preserves the destination WebSocket ticket and closes the upgrade on grant revocation",
  () =>
    Effect.gen(function* () {
      const { relay, forwarding, owner, publisher, client } = yield* setup();
      const publisherA = yield* publisher(environmentA);
      const clientA = yield* client(environmentA);
      const lease = yield* forwarding.openPublisher(publisherA.credential, environmentA);
      const backend = NodeHttp.createServer();
      const websocket = new NodeWS.WebSocketServer({ noServer: true });
      const target = Promise.withResolvers<string | undefined>();
      backend.on("upgrade", (request, socket, head) => {
        target.resolve(request.url);
        websocket.handleUpgrade(request, socket, head, (peer) => {
          peer.on("error", () => peer.terminate());
          peer.on("message", (bytes, isBinary) => peer.send(bytes, { binary: isBinary }));
        });
      });
      yield* connect(a, lease.address.port, backend);
      yield* lease.ready;
      const scope = yield* Effect.scope;
      const run = yield* Effect.context<never>().pipe(Effect.map(Effect.runPromiseWith));
      const url = yield* serveLoopback(
        NodeHttps.createServer(relayTls).on("upgrade", (request, socket, head) => {
          socket.pause();
          void run(
            forwarding
              .forward(clientA.credential, environmentA, {
                kind: "upgrade",
                request,
                socket,
                head,
              })
              .pipe(
                Effect.catch(() => Effect.sync(() => socket.destroy())),
                Effect.forkIn(scope),
              ),
          );
        }),
      );
      const echo = Promise.withResolvers<unknown>();
      const closed = Promise.withResolvers<number>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const options = {
            ca: relayTls.cert,
            servername: "localhost",
            headers: { host: "localhost" },
          };
          const socket = new NodeWS.WebSocket(
            url.replace("https:", "wss:") + "/ws?ticket=opaque%2Fvalue",
            options,
          );
          socket.once("open", () => socket.send(Buffer.of(1, 2)));
          socket.on("error", echo.reject);
          socket.once("message", echo.resolve);
          socket.once("close", closed.resolve);
          return socket;
        }),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      expect(yield* Effect.promise(() => echo.promise)).toEqual(Buffer.of(1, 2));
      expect(yield* Effect.promise(() => target.promise)).toBe("/ws?ticket=opaque%2Fvalue");
      yield* relay.revokeSession(owner.credential, clientA.sessionId);
      expect(yield* Effect.promise(() => closed.promise)).toBe(1006);
      expect(lease.signal.aborted).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.live("releases the publisher lease when its scope closes before a tunnel connects", () =>
  Effect.gen(function* () {
    const { forwarding, publisher, client } = yield* setup();
    const publisherA = yield* publisher(environmentA);
    const clientA = yield* client(environmentA);
    const closed = yield* Effect.scoped(
      forwarding.openPublisher(publisherA.credential, environmentA),
    );
    expect(closed.signal.aborted).toBe(true);
    expect(yield* Effect.flip(closed.ready)).toMatchObject({ reason: "closed" });

    const url = yield* ingress(forwarding, a, () => clientA.credential);
    const offline = yield* Effect.promise(() =>
      proofRequest(url, { headers: { host: "localhost" } }),
    );
    expect(offline.status).toBe(503);
    const replacement = yield* forwarding.openPublisher(publisherA.credential, environmentA);
    yield* connect(
      a,
      replacement.address.port,
      NodeHttp.createServer((_request, response) => response.end("ok")),
    );
    yield* replacement.ready;
    expect(
      (yield* Effect.promise(() => proofRequest(url, { headers: { host: "localhost" } }))).body,
    ).toBe("ok");
  }).pipe(Effect.provide(layer)),
);

it.effect("owns cancellation and interruption while relay admission is pending", () =>
  Effect.gen(function* () {
    const { relay } = yield* setup();
    for (const mode of [
      "caller-denied",
      "caller-offline",
      "interrupt",
      "ordinary-denied",
    ] as const) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const authorization = yield* Deferred.make<AbortSignal, Runtime.RelayAccessDeniedError>();
          const runtime = {
            ...relay,
            authorizeLive: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(authorization)),
              ),
          };
          yield* Effect.gen(function* () {
            const forwarding = yield* Forwarding.RelayForwarding;
            const socket = new NodeNet.Socket();
            const request = new NodeHttp.IncomingMessage(socket);
            const response = new NodeHttp.ServerResponse(request);
            response.assignSocket(socket);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                response.destroy();
                request.destroy();
                socket.destroy();
              }),
            );
            // @effect-diagnostics-next-line abortControllerInEffect:off -- The HTTP caller cancels independently of the forwarding fiber.
            const controller = new AbortController();
            const attempt = yield* forwarding
              .forward("credential", environmentA, {
                kind: "http",
                request,
                response,
                ...(mode.startsWith("caller") ? { signal: controller.signal } : {}),
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Effect.raceFirst(
              Deferred.await(entered),
              Fiber.join(attempt).pipe(
                Effect.flatMap((result) =>
                  Effect.die(
                    new Error(`Admission exited before entering: ${JSON.stringify(result)}`),
                  ),
                ),
              ),
            );
            if (mode === "interrupt") {
              yield* Fiber.interrupt(attempt);
              expect(response.destroyed).toBe(true);
              return;
            }
            if (mode.startsWith("caller")) {
              controller.abort();
              expect(response.destroyed).toBe(true);
            }
            if (mode === "caller-offline")
              yield* Deferred.succeed(authorization, yield* Effect.abortSignal);
            else yield* Deferred.fail(authorization, new Runtime.RelayAccessDeniedError());
            const result = yield* Fiber.join(attempt);
            expect(result._tag).toBe(mode === "ordinary-denied" ? "Failure" : "Success");
            if (mode === "ordinary-denied") expect(response.destroyed).toBe(false);
          }).pipe(
            Effect.provide(
              Layer.fresh(Forwarding.layer([a])).pipe(
                Layer.provide(Layer.succeed(Runtime.RelayRuntime, runtime)),
              ),
            ),
          );
        }),
      );
    }
  }).pipe(Effect.provide(layer)),
);
