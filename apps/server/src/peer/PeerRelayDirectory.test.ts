// @effect-diagnostics nodeBuiltinImport:off -- Exercise credential dispatch over a real HTTPS socket.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as RelayDirectory from "@t3tools/relay-core/RelayDirectory";
import { RelayRuntime, relayRuntimeLayer } from "@t3tools/relay-core/RelayRuntime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";

import { serveLoopback } from "../relay/fixtures/p1bIngress.testkit.ts";
import * as DirectoryHttp from "../relay/SelfHostedRelayDirectoryHttp.ts";
import * as PeerRelayDirectory from "./PeerRelayDirectory.ts";

const cert = NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url), "utf8");
const key = NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));
const spkiSha256 = NodeCrypto.createHash("sha256")
  .update(new NodeCrypto.X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
  .digest("base64url");
const session = `t3-session-1.relay.1.${"a".repeat(43)}`;
const directoryPath = "/api/self-hosted-relay/v1/directory";
const peer = {
  version: 1,
  relayId: "relay",
  environmentId: "peer-id",
  name: "Peer Name",
  addressHints: [
    { kind: "lan", httpBaseUrl: "http://192.168.0.10:4173/" },
    { kind: "relay", httpBaseUrl: "https://candidate.invalid" },
    { kind: "public", httpBaseUrl: "https://candidate.invalid/" },
  ],
};
const makeLookup =
  (origin: string, credentialPath: string) =>
  (selector: string, overrides: Record<string, unknown> = {}) =>
    PeerRelayDirectory.lookup(selector).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            T3CODE_PEER_RELAY_DIRECTORY: JSON.stringify({
              origin,
              caPem: cert,
              spkiSha256,
              credentialPath,
              ...overrides,
            }),
          },
        }),
      ),
    );

const fixture = Effect.fn("PeerRelayDirectoryTest.fixture")(function* (
  handler: NodeHttp.RequestListener,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "peer-directory-" });
  const credentialPath = `${directory}/credential`;
  yield* fs.writeFileString(credentialPath, `${session}\r\n`, { mode: 0o600 });
  const origin = yield* serveLoopback(NodeHttps.createServer({ cert, key }, handler));
  const lookup = makeLookup(origin, credentialPath);
  return { lookup, credentialPath };
});

it.live("prefers an exact ID and requires unambiguous case-sensitive labels", () =>
  Effect.gen(function* () {
    const observed: Array<object> = [];
    const { lookup } = yield* fixture((request, response) => {
      observed.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        proxyAuthorization: request.headers["proxy-authorization"],
        dpop: request.headers.dpop,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: 1,
          environments: [
            peer,
            { ...peer, environmentId: "another-id", name: "peer-id" },
            { ...peer, environmentId: "third-id", name: "Shared" },
            { ...peer, environmentId: "fourth-id", name: "Shared" },
          ],
        }),
      );
    });

    for (const selector of ["peer-id", "Peer Name"]) {
      expect(yield* lookup(selector)).toEqual({
        environment: peer,
        candidateOrigins: ["http://192.168.0.10:4173", "https://candidate.invalid"],
      });
    }
    expect(yield* Effect.flip(lookup("Shared"))).toMatchObject({ reason: "ambiguous" });
    expect(yield* Effect.flip(lookup("peer name"))).toMatchObject({ reason: "not-found" });
    expect(observed).toEqual(
      Array.from({ length: 4 }, () => ({
        method: "GET",
        url: directoryPath,
        authorization: `Bearer ${session}`,
        proxyAuthorization: undefined,
        dpop: undefined,
      })),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects unsafe configuration and TLS before sending the directory session", () =>
  Effect.gen(function* () {
    let requests = 0;
    const { lookup, credentialPath } = yield* fixture((_request, response) => {
      requests++;
      response.writeHead(204).end();
    });
    for (const overrides of [
      { origin: "http://localhost" },
      { origin: "https://localhost/path" },
      { caPem: "invalid" },
      { relayCredentialPath: credentialPath },
    ]) {
      expect(yield* Effect.flip(lookup("peer-id", overrides))).toMatchObject({
        reason: "invalid-config",
      });
    }
    expect(
      yield* Effect.flip(lookup("peer-id", { spkiSha256: Buffer.alloc(32).toString("base64url") })),
    ).toMatchObject({ reason: "unavailable" });
    expect(yield* Effect.flip(lookup("peer-id", { caPem: undefined }))).toMatchObject({
      reason: "unavailable",
    });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(credentialPath, "t3-pairing-code", { mode: 0o600 });
    expect(yield* Effect.flip(lookup("peer-id"))).toMatchObject({ reason: "invalid-config" });
    expect(requests).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects redirects, denied and oversized responses with sanitized errors", () =>
  Effect.gen(function* () {
    let requests = 0;
    const { lookup } = yield* fixture((_request, response) => {
      switch (++requests) {
        case 1:
          response.writeHead(302, { location: "/must-not-follow" }).end();
          break;
        case 2:
          response.writeHead(403).end(session);
          break;
        case 3:
          response.writeHead(200, { "content-type": "application/json" });
          response.write(" ".repeat(1024 * 1024));
          response.end("{}");
          break;
        case 4:
          response.writeHead(200).end(JSON.stringify({ version: 1, environments: [peer] }));
          break;
        case 5:
          response
            .writeHead(200, { "content-type": "text/plain" })
            .end(JSON.stringify({ version: 1, environments: [peer] }));
          break;
        case 6:
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({ version: 1, environments: [{ ...peer, relayId: "wrong-relay" }] }),
            );
          break;
        case 7:
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ version: 1, environments: [{ ...peer, name: "\ud800" }] }));
          break;
        default:
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ version: 1, environments: [peer, peer] }));
      }
    });
    for (const reason of [
      "unavailable",
      "denied",
      ...Array.from({ length: 6 }, () => "invalid-response"),
    ]) {
      const error = yield* Effect.flip(lookup("peer-id"));
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain(session);
      expect(error).not.toHaveProperty("cause");
    }
    expect(requests).toBe(8);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("applies P3 discovery scope and revocation through the directory HTTP route", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "peer-directory-p3-" });
    const credentialPath = `${directory}/credential`;
    const listener = NodeHttpServer.layerServer(() => NodeHttps.createServer({ cert, key }), {
      host: "127.0.0.1",
      port: 0,
    });
    const context = yield* Layer.build(
      HttpRouter.serve(DirectoryHttp.layer, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(RelayDirectory.layer),
        Layer.provideMerge(relayRuntimeLayer({ homeDirectory: `${directory}/relay` })),
        Layer.provideMerge(listener),
      ),
    );
    const relay = Context.get(context, RelayRuntime);
    const { address } = Context.get(context, HttpServer.HttpServer);
    const lookup = makeLookup(`https://${NetAddress.formatSocketAddress(address)}`, credentialPath);
    const owner = yield* relay.bootstrapOwner();
    const visible = EnvironmentId.make("visible");
    const hidden = EnvironmentId.make("hidden");
    for (const environmentId of [visible, hidden]) {
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId,
        name: "Shared",
      });
    }
    const pairing = yield* relay.issuePairing(owner.credential, {
      version: 1,
      subject: { kind: "client" },
      scope: {
        permissions: ["discovery.read"],
        environments: { kind: "selected", environmentIds: [visible] },
      },
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const reader = yield* relay.redeemPairing(pairing.credential);
    yield* fs.writeFileString(credentialPath, reader.credential, { mode: 0o600 });

    expect(yield* lookup("Shared")).toEqual({
      environment: {
        version: 1,
        relayId: owner.relayId,
        environmentId: visible,
        name: "Shared",
        addressHints: [],
      },
      candidateOrigins: [],
    });
    expect(yield* Effect.flip(lookup(hidden))).toMatchObject({ reason: "not-found" });
    yield* relay.revokeSession(owner.credential, reader.sessionId);
    expect(yield* Effect.flip(lookup("Shared"))).toMatchObject({ reason: "denied" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("closes an incomplete response when the lookup deadline expires", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const { lookup } = yield* fixture((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"version":1,');
      started.resolve();
    });
    const result = yield* lookup("peer-id").pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(result)).toMatchObject({ reason: "timed-out" });
    yield* Effect.promise(() => closed.promise);
  }).pipe(Effect.provide(Layer.merge(TestClock.layer(), NodeServices.layer))),
);
