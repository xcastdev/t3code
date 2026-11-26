// @effect-diagnostics nodeBuiltinImport:off -- These fixtures own their HTTPS and mTLS listeners.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as TestClock from "effect/testing/TestClock";

import { trustedStaticRelayCanonicalOrigin } from "@t3tools/relay-core/RelayTunnelTransport";
import { requestUrl } from "../requestUrl.ts";
import { ServerActivation } from "../serverActivation.ts";
import { serveLoopback } from "./fixtures/p1bIngress.testkit.ts";
import * as SelfHostedRelayConnector from "./SelfHostedRelayConnector.ts";
import type { SelfHostedRelayConnectorConfig } from "./SelfHostedRelayForwardingConfig.ts";

const relayCredentials = {
  key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
};
const environmentCredentials = {
  key: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url)),
  cert: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url)),
};
const fingerprint = new NodeCrypto.X509Certificate(relayCredentials.cert).fingerprint256;
const wrongFingerprint = new NodeCrypto.X509Certificate(environmentCredentials.cert).fingerprint256;
const environmentId = EnvironmentId.make("environment/test");
const host = "127.0.0.1";
const accepted = '{"version":1,"status":"accepted"}\n';
const ready = '{"version":1,"status":"ready"}\n';

function config(
  controlOrigin: string,
  overrides: Partial<SelfHostedRelayConnectorConfig> = {},
): SelfHostedRelayConnectorConfig {
  return {
    environmentId,
    publicOrigin: "https://alias.t3.test",
    canonicalOrigin: "https://canonical.t3.test",
    controlOrigin,
    controlCa: relayCredentials.cert,
    controlFingerprint: fingerprint,
    publisherCredential: "fixture-publisher",
    relayFingerprint: fingerprint,
    relay: {
      ...environmentCredentials,
      ca: relayCredentials.cert,
      host,
      port: 1,
      servername: "localhost",
    },
    ...overrides,
  };
}

it.live("sends zero HTTP requests when the control pin or hostname differs", () =>
  Effect.gen(function* () {
    let requests = 0;
    const origin = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (_request, response) => {
        requests++;
        response.writeHead(403).end();
      }),
    );
    const otherOrigin = yield* serveLoopback(
      NodeHttps.createServer(environmentCredentials, (_request, response) => {
        requests++;
        response.writeHead(403).end();
      }),
    );
    for (const options of [
      config(origin.replace(host, "localhost"), { controlFingerprint: wrongFingerprint }),
      config(otherOrigin.replace(host, "localhost"), {
        controlCa: environmentCredentials.cert,
        controlFingerprint: wrongFingerprint,
      }),
    ]) {
      const fiber = yield* SelfHostedRelayConnector.start(NodeHttp.createServer(), options, {
        host,
        environmentId,
      });
      const failure = yield* Effect.flip(Fiber.join(fiber));
      expect(failure.reason).toBe("control_tls");
    }
    expect(requests).toBe(0);
  }),
);

it.live("sends one empty publisher POST and never follows a control redirect", () =>
  Effect.gen(function* () {
    let redirected = 0;
    const destination = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (_request, response) => {
        redirected++;
        response.writeHead(500).end();
      }),
    );
    const observed = Promise.withResolvers<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
      publisherFingerprint: string | string[] | undefined;
      length: number;
    }>();
    const control = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (request, response) => {
        let length = 0;
        request.on("data", (chunk: Buffer) => {
          length += chunk.length;
        });
        request.once("end", () => {
          observed.resolve({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            publisherFingerprint: request.headers["x-t3-relay-publisher-fingerprint"],
            length,
          });
          response.writeHead(307, { location: destination.replace(host, "localhost") }).end();
        });
      }),
    );
    const fiber = yield* SelfHostedRelayConnector.start(
      NodeHttp.createServer(),
      config(control.replace(host, "localhost")),
      { host, environmentId },
    );
    expect((yield* Effect.flip(Fiber.join(fiber))).reason).toBe("control_status");
    expect(yield* Effect.promise(() => observed.promise)).toEqual({
      method: "POST",
      url: "/api/self-hosted-relay/v1/tunnel/publisher/environment%2Ftest",
      authorization: "Bearer fixture-publisher",
      publisherFingerprint: wrongFingerprint,
      length: 0,
    });
    expect(redirected).toBe(0);
  }),
);

it.live.each([
  ["an oversized line without a newline", " ".repeat(129)],
  ["a frame from another protocol version", '{"version":2,"status":"accepted"}\n'],
  ["ready before acceptance", ready],
])("terminates control on %s", ([, body]) =>
  Effect.gen(function* () {
    const origin = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(body);
      }),
    );
    const fiber = yield* SelfHostedRelayConnector.start(
      NodeHttp.createServer(),
      config(origin.replace(host, "localhost")),
      { host, environmentId },
    );
    expect((yield* Effect.flip(Fiber.join(fiber))).reason).toBe("control_protocol");
  }),
);

it.live("rejects mismatched initialized identity before opening control", () =>
  Effect.gen(function* () {
    let requests = 0;
    const origin = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (_request, response) => {
        requests++;
        response.writeHead(403).end();
      }),
    );
    const failure = yield* Effect.flip(
      SelfHostedRelayConnector.start(
        NodeHttp.createServer(),
        config(origin.replace(host, "localhost")),
        {
          host,
          environmentId: EnvironmentId.make("other"),
        },
      ),
    );
    expect(failure.reason).toBe("configuration");
    expect(requests).toBe(0);
  }),
);

it.live("closes a control stream that never reaches readiness by the startup deadline", () =>
  Effect.gen(function* () {
    const controlRequest = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const control = yield* serveLoopback(
      NodeHttps.createServer(relayCredentials, (_request, response) => {
        response.once("close", () => closed.resolve());
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(accepted);
        controlRequest.resolve();
      }),
    );
    yield* SelfHostedRelayConnector.start(
      NodeHttp.createServer(),
      config(control.replace(host, "localhost")),
      { host, environmentId },
    );
    yield* Effect.promise(() => controlRequest.promise);
    yield* TestClock.adjust("15 seconds");
    yield* Effect.promise(() => closed.promise);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.live(
  "runs HTTP and upgrades through the activated tunnel and closes the whole pool on control loss",
  () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const waitingForActivation = yield* Deferred.make<void>();
      const controlRequest = Promise.withResolvers<NodeHttp.ServerResponse>();
      let attempts = 0;
      const control = yield* serveLoopback(
        NodeHttps.createServer(relayCredentials, (_request, response) => {
          if (++attempts === 1) {
            controlRequest.resolve(response);
          } else {
            response.writeHead(403).end();
          }
        }),
      );
      const sockets = new Set<NodeTls.TLSSocket>();
      const pool = Promise.withResolvers<NodeTls.TLSSocket>();
      const tunnel = NodeTls.createServer({
        ...relayCredentials,
        ca: environmentCredentials.cert,
        requestCert: true,
        rejectUnauthorized: true,
        ALPNProtocols: ["t3-relay-http1"],
      });
      const tunnelPort = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              tunnel.once("error", reject);
              tunnel.listen(0, host, () => {
                const address = tunnel.address();
                if (address === null || typeof address === "string") {
                  reject(new Error("Expected a tunnel TCP port"));
                  return;
                }
                resolve(address.port);
              });
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                tunnel.close(() => resolve());
              }),
          ),
      );
      let registered = 0;
      tunnel.on("secureConnection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let received = 0;
        const onData = (chunk: Buffer) => {
          received += chunk.length;
          if (received < 32) return;
          socket.off("data", onData);
          if (++registered === 8) pool.resolve(socket);
        };
        socket.on("data", onData);
      });
      const forwarded = Promise.withResolvers<unknown>();
      const upgraded = Promise.withResolvers<string>();
      const scope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return HttpServerResponse.jsonUnsafe({
            external: Option.getOrUndefined(requestUrl(request))?.origin,
            authorization: request.headers.authorization,
          });
        }),
        { scope },
      );
      const server = NodeHttp.createServer((request, response) => {
        forwarded.resolve(trustedStaticRelayCanonicalOrigin(request.socket));
        handler(request, response);
      });
      server.on("upgrade", (_request, socket, head) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        upgraded.resolve(head.toString());
      });
      const settings = config(control.replace(host, "localhost"));
      const fiber = yield* SelfHostedRelayConnector.start(
        server,
        {
          ...settings,
          relay: { ...settings.relay, port: tunnelPort },
        },
        { host, environmentId },
      ).pipe(
        Effect.provideService(
          ServerActivation,
          Deferred.succeed(waitingForActivation, undefined).pipe(
            Effect.andThen(Deferred.await(activation)),
          ),
        ),
      );

      yield* Deferred.await(waitingForActivation);
      yield* Deferred.succeed(activation, undefined);
      const response = yield* Effect.promise(() => controlRequest.promise);
      expect(sockets.size).toBe(0);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(accepted.slice(0, 7));
      response.write(accepted.slice(7));
      const socket = yield* Effect.promise(() => pool.promise);
      response.write(ready);
      const reply = Promise.withResolvers<string>();
      let body = "";
      socket.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      socket.once("close", () => reply.resolve(body));
      socket.write(
        "GET / HTTP/1.1\r\nHost: canonical.t3.test\r\nAuthorization: Bearer destination\r\nConnection: close\r\n\r\n",
      );
      expect(yield* Effect.promise(() => forwarded.promise)).toBe(settings.canonicalOrigin);
      expect(yield* Effect.promise(() => reply.promise)).toContain(
        '{"external":"https://alias.t3.test","authorization":"Bearer destination"}',
      );
      const upgradeSocket = sockets.values().next().value;
      if (!upgradeSocket) throw new Error("Expected a spare tunnel connection");
      upgradeSocket.write(
        "GET /ws HTTP/1.1\r\nHost: canonical.t3.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nfirst-frame",
      );
      expect(yield* Effect.promise(() => upgraded.promise)).toBe("first-frame");
      response.destroy();
      // A spare connection dialed before the control loss can be accepted after it; it must close too.
      while (sockets.size > 0) {
        yield* Effect.promise(() =>
          Promise.all(
            Array.from(
              sockets,
              (active) => new Promise<void>((resolve) => active.once("close", () => resolve())),
            ),
          ),
        );
      }
      expect((yield* Effect.flip(Fiber.join(fiber))).reason).toBe("control_status");
      expect(attempts).toBe(2);
    }),
);
