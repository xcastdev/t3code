// @effect-diagnostics nodeBuiltinImport:off -- The fixture uses real TLS and isolated on-disk relay storage.
import * as NodeCrypto from "node:crypto";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import * as NodeStream from "node:stream";
import * as NodeVM from "node:vm";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RELAY_ADMISSION_HEADER, RELAY_ADMISSION_PATH } from "@t3tools/contracts/relay";
import type { SelfHostedRelayIssuePairingInput } from "@t3tools/contracts/selfHostedRelay";
import {
  RELAY_BROWSER_TICKETS_PATH,
  RELAY_HOSTED_SESSION_HEADER,
  RELAY_HOSTED_SESSION_PATH,
} from "@t3tools/contracts/selfHostedRelayHosted";
import {
  openRelayMediaDownload,
  RELAY_MEDIA_DOWNLOAD_HEADER,
  RELAY_MEDIA_RANGE_BYTES,
} from "@t3tools/shared/relayMediaDownload";
import { SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER } from "@t3tools/contracts/selfHostedRelayForwarding";
import { RelayForwarding } from "@t3tools/relay-core/RelayForwarding";
import * as Runtime from "@t3tools/relay-core/RelayRuntime";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { fetch } from "undici";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import { layerAssetRoute } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PluginPackageStore from "../plugins/PluginPackageStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { SourceControlDrivers } from "../sourceControl/builtInDrivers.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { openProofRequest, proofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";
import {
  initializeRelayHomeOriginRegistry,
  openRelayHomeOriginRegistry,
} from "./RelayOriginRegistry.ts";
import * as SelfHostedRelayApplication from "./SelfHostedRelayApplication.ts";
import * as SelfHostedRelayBrowserAdmission from "./SelfHostedRelayBrowserAdmission.ts";
import * as SelfHostedRelayConnector from "./SelfHostedRelayConnector.ts";
import { loadSelfHostedRelayForwardingConfig } from "./SelfHostedRelayForwardingConfig.ts";
import * as SelfHostedRelayIngress from "./SelfHostedRelayIngress.ts";

const host = "127.0.0.1";
const hostedOrigin = "https://hosted.example:8443";
const secondHostedOrigin = "https://second-hosted.example";
const environmentId = EnvironmentId.make("environment/test");
const otherEnvironment = EnvironmentId.make("other-environment");
const relayTls = {
  cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
  key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
};
const publisherTls = {
  cert: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url)),
  key: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url)),
};
const otherTls = {
  cert: NodeFS.readFileSync(new URL("./fixtures/relay-push-apns-cert.pem", import.meta.url)),
  key: NodeFS.readFileSync(new URL("./fixtures/relay-push-apns-key.pem", import.meta.url)),
};
const publisherPath = `/api/self-hosted-relay/v1/tunnel/publisher/${encodeURIComponent(environmentId)}`;
const fingerprint = (cert: Buffer) => new NodeCrypto.X509Certificate(cert).fingerprint256;

const fixture = Effect.fn("SelfHostedRelayIngressTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-adapter-" });
  const homeDirectory = `${directory}/relay`;
  const ports = yield* Effect.scoped(
    Effect.forEach(["ingress", "control", "tunnel", "otherTunnel"], () =>
      serveLoopback(NodeHttp.createServer()).pipe(
        Effect.map((origin) => Number(new URL(origin).port)),
      ),
    ),
  );
  const [ingressPort, controlPort, tunnelPort, otherTunnelPort] = ports as [
    number,
    number,
    number,
    number,
  ];
  const otherOrigin = `https://relay-push-test:${ingressPort}`;
  const ingress = `https://${host}:${ingressPort}`;
  const control = `https://${host}:${controlPort}`;
  const publicOrigin = `https://localhost:${ingressPort}`;
  const controlOrigin = `https://localhost:${controlPort}`;
  const canonicalOrigin = "https://destination.example";
  const forwardingConfigPath = `${directory}/forwarding.json`;
  yield* fs.writeFile(`${directory}/relay.pem`, relayTls.cert);
  yield* fs.writeFile(`${directory}/key.pem`, relayTls.key, { mode: 0o600 });
  yield* fs.writeFile(
    `${directory}/publisher.pem`,
    Buffer.concat([publisherTls.cert, otherTls.cert]),
  );
  yield* fs.writeFile(`${directory}/other.pem`, otherTls.cert);
  yield* fs.writeFile(`${directory}/other-key.pem`, otherTls.key, { mode: 0o600 });
  yield* fs.writeFileString(
    forwardingConfigPath,
    JSON.stringify({
      version: 1,
      ingress: {
        listen: { host, port: ingressPort },
        certificates: [
          { serverNames: ["localhost"], certPath: "relay.pem", keyPath: "key.pem" },
          { serverNames: ["relay-push-test"], certPath: "other.pem", keyPath: "other-key.pem" },
        ],
      },
      control: {
        listen: { host, port: controlPort },
        origin: controlOrigin,
        certPath: "relay.pem",
        keyPath: "key.pem",
      },
      bindings: [
        {
          environmentId,
          publicOrigin,
          canonicalOrigin,
          hostedClientOrigins: [hostedOrigin, secondHostedOrigin],
          environmentFingerprint: fingerprint(publisherTls.cert),
          tunnelListen: { host, port: tunnelPort },
          tunnelCaPath: "publisher.pem",
          tunnelCertPath: "relay.pem",
          tunnelKeyPath: "key.pem",
        },
        {
          environmentId: otherEnvironment,
          publicOrigin: otherOrigin,
          canonicalOrigin: "https://other-destination.example",
          hostedClientOrigins: [hostedOrigin],
          environmentFingerprint: fingerprint(otherTls.cert),
          tunnelListen: { host, port: otherTunnelPort },
          tunnelCaPath: "other.pem",
          tunnelCertPath: "relay.pem",
          tunnelKeyPath: "key.pem",
        },
      ],
    }),
  );
  const provision = () => {
    initializeRelayHomeOriginRegistry(homeDirectory);
    using registry = openRelayHomeOriginRegistry(homeDirectory);
    registry!.register(publicOrigin, environmentId);
    registry!.register("https://unconfigured.example", environmentId);
    registry!.register(otherOrigin, otherEnvironment);
  };
  const credentials = yield* Effect.gen(function* () {
    const relay = yield* Runtime.RelayRuntime;
    const owner = yield* relay.bootstrapOwner();
    for (const id of [environmentId, otherEnvironment]) {
      yield* relay.enrollEnvironment(owner.credential, { version: 1, environmentId: id, name: id });
    }
    const pair = Effect.fn("SelfHostedRelayIngressTest.pair")(function* (
      subject: SelfHostedRelayIssuePairingInput["subject"],
      permissions: SelfHostedRelayIssuePairingInput["scope"]["permissions"],
      selected: EnvironmentId,
    ) {
      const pairing = yield* relay.issuePairing(owner.credential, {
        version: 1,
        subject,
        scope: { permissions, environments: { kind: "selected", environmentIds: [selected] } },
        expiresAt: "2099-01-01T00:00:00Z",
      });
      return yield* relay.redeemPairing(pairing.credential);
    });
    const publisher = yield* pair(
      { kind: "publisher", environmentId },
      ["environment.tunnel"],
      environmentId,
    );
    const otherPublisher = yield* pair(
      { kind: "publisher", environmentId: otherEnvironment },
      ["environment.tunnel"],
      otherEnvironment,
    );
    const client = yield* pair({ kind: "client" }, ["forward"], environmentId);
    const otherClient = yield* pair({ kind: "client" }, ["forward"], otherEnvironment);
    const browserClient = yield* pair({ kind: "client" }, ["forward"], environmentId);
    return {
      owner: owner.credential,
      publisher: publisher.credential,
      otherPublisher: otherPublisher.credential,
      client: client.credential,
      otherClient: otherClient.credential,
      browserClient,
    };
  }).pipe(Effect.provide(Runtime.relayRuntimeLayer({ homeDirectory })));
  return {
    directory,
    homeDirectory,
    forwardingConfigPath,
    ingress,
    control,
    publicOrigin,
    controlOrigin,
    canonicalOrigin,
    tunnelPort,
    otherTunnelPort,
    otherOrigin,
    provision,
    ...credentials,
  };
});

it.live("requires a provisioned origin authority before binding HTTPS", () =>
  Effect.gen(function* () {
    const config = yield* fixture();
    const exit = yield* Effect.exit(
      Layer.build(
        SelfHostedRelayApplication.layer({
          homeDirectory: config.homeDirectory,
          port: 0,
          forwardingConfigPath: config.forwardingConfigPath,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(NodeFS.existsSync(`${config.homeDirectory}.origins`)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "serves offline admission and revokes the alias through the shared P3 management runtime",
  () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      config.provision();
      const app = yield* startApplication(config);
      const authority = new URL(config.publicOrigin).host;
      const probe = () =>
        proofRequest(config.ingress, {
          method: "HEAD",
          path: RELAY_ADMISSION_PATH,
          headers: { host: authority },
        });
      const active = yield* Effect.promise(probe);
      expect(active.status).toBe(204);
      expect(active.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBe("active");
      const offline = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          headers: { host: authority, "proxy-authorization": `Bearer ${config.client}` },
        }),
      );
      expect(offline.status).toBe(503);
      const revoked = yield* Effect.promise(() => revoke(app.management, config.owner));
      expect(revoked.status).toBe(204);
      const retired = yield* Effect.promise(probe);
      expect(retired.status).toBe(410);
      expect(retired.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBe("retired");
      using registry = openRelayHomeOriginRegistry(config.homeDirectory);
      expect(registry!.lookup("https://unconfigured.example").status).toBe("retired");
      expect(registry!.lookup(config.otherOrigin).status).toBe("active");
    }).pipe(Effect.provide(NodeServices.layer)),
);

const openRaw = Effect.fn("SelfHostedRelayIngressTest.openRaw")(function* (
  origin: string,
  tls: NodeTls.ConnectionOptions = {},
) {
  return yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          socket: NodeTls.TLSSocket;
          received: Promise<string>;
        }>((resolve, reject) => {
          const { hostname, port } = new URL(origin);
          const socket = NodeTls.connect({
            host,
            port: Number(port),
            servername: hostname,
            ca: relayTls.cert,
            ALPNProtocols: ["http/1.1"],
            ...tls,
          });
          let received = "";
          const closed = Promise.withResolvers<string>();
          socket.setEncoding("utf8").on("data", (text: string) => {
            received += text;
          });
          socket.once("close", () => closed.resolve(received));
          socket.on("error", reject);
          socket.once("secureConnect", () => resolve({ socket, received: closed.promise }));
        }),
    ),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );
});

const headerPadding = Array.from(
  { length: 2048 },
  (_, index) => `h${index.toString(36)}:\r\n`,
).join("");

const rawRequest = Effect.fn("SelfHostedRelayIngressTest.rawRequest")(function* (
  origin: string,
  request: string,
  tls?: NodeTls.ConnectionOptions,
) {
  const { socket, received } = yield* openRaw(origin, tls);
  socket.write(request);
  return yield* Effect.promise(() => received);
});

const startApplication = Effect.fn("SelfHostedRelayIngressTest.startApplication")(function* (
  config: { homeDirectory: string; forwardingConfigPath: string },
  useForwarding = true,
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  let management: string | undefined;
  let onReady = () => {};
  const logger = Logger.make(({ message }) => {
    const text = String(message);
    management ??= /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(text)?.[1];
    if (text === "Self-hosted relay publisher ready") onReady();
  });
  yield* Layer.buildWithScope(
    SelfHostedRelayApplication.layer({
      homeDirectory: config.homeDirectory,
      port: 0,
      ...(useForwarding ? { forwardingConfigPath: config.forwardingConfigPath } : {}),
    }).pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    scope,
  );
  if (management === undefined) throw new Error("Missing P3 management origin");
  return {
    management,
    scope,
    nextReady: () => {
      const ready = Promise.withResolvers<void>();
      onReady = ready.resolve;
      return ready.promise;
    },
  };
});

const startConnector = Effect.fn("SelfHostedRelayIngressTest.startConnector")(function* (
  config: Effect.Success<ReturnType<typeof fixture>>,
  app: Effect.Success<ReturnType<typeof startApplication>>,
  destination: NodeHttp.Server,
  other = false,
) {
  const id = other ? otherEnvironment : environmentId;
  const ready = app.nextReady();
  yield* SelfHostedRelayConnector.start(
    destination,
    {
      environmentId: id,
      publicOrigin: other ? config.otherOrigin : config.publicOrigin,
      canonicalOrigin: other ? "https://other-destination.example" : config.canonicalOrigin,
      controlOrigin: config.controlOrigin,
      controlCa: relayTls.cert,
      controlFingerprint: fingerprint(relayTls.cert),
      publisherCredential: other ? config.otherPublisher : config.publisher,
      relayFingerprint: fingerprint(relayTls.cert),
      relay: {
        ...(other ? otherTls : publisherTls),
        host,
        port: other ? config.otherTunnelPort : config.tunnelPort,
        servername: "localhost",
        ca: relayTls.cert,
      },
    },
    { host, environmentId: id },
  );
  yield* Effect.promise(() => ready);
});

const revoke = (management: string, credential: string) =>
  fetch(
    `${management}/api/self-hosted-relay/v1/environments/${encodeURIComponent(environmentId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential}` },
    },
  );

it.live("opens the publisher lease before readiness and releases it with the HTTPS layer", () =>
  Effect.gen(function* () {
    const config = yield* fixture();
    config.provision();
    const app = yield* startApplication(config);
    const authority = new URL(config.controlOrigin).host;
    const headers = {
      host: authority,
      authorization: `Bearer ${config.publisher}`,
      "content-length": "0",
      [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: fingerprint(publisherTls.cert),
    };
    const request = (overrides: NodeHttp.OutgoingHttpHeaders) =>
      proofRequest(config.control, {
        method: "POST",
        path: publisherPath,
        headers: { ...headers, ...overrides },
      });
    const denials: Array<[NodeHttp.OutgoingHttpHeaders, number]> = [
      [{ host: new URL(config.publicOrigin).host }, 421],
      [{ authorization: "Bearer invalid" }, 401],
      [{ authorization: `Bearer ${config.client}` }, 403],
      [{ expect: "100-continue" }, 400],
      [{ [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: fingerprint(otherTls.cert) }, 403],
      [
        {
          [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: [
            "invalid",
            fingerprint(publisherTls.cert),
          ],
        },
        403,
      ],
      [{ [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: "malformed" }, 403],
    ];
    for (const [overrides, status] of denials) {
      expect((yield* Effect.promise(() => request(overrides))).status).toBe(status);
    }
    expect(
      (yield* Effect.promise(() =>
        proofRequest(config.control, {
          headers: { host: authority },
          path: "/api/self-hosted-relay/v1/status",
        }),
      )).status,
    ).toBe(404);

    const controlHeaders = `POST ${publisherPath} HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Bearer ${config.publisher}\r\nContent-Length: 0\r\n`;
    expect(yield* rawRequest(config.controlOrigin, `${controlHeaders}\r\n`)).toContain(
      "HTTP/1.1 403",
    );
    expect(
      yield* rawRequest(
        config.controlOrigin,
        `${controlHeaders}Authorization: Bearer duplicate\r\n${SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER}: ${fingerprint(publisherTls.cert)}\r\n\r\n`,
      ),
    ).toContain("HTTP/1.1 400");

    expect(
      yield* rawRequest(
        config.controlOrigin,
        `${controlHeaders}${SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER}: ${fingerprint(publisherTls.cert)}\r\n${headerPadding}${SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER}: ${fingerprint(otherTls.cert)}\r\n\r\n`,
      ),
    ).toContain("HTTP/1.1 403");

    const wrongKey = yield* SelfHostedRelayConnector.start(
      NodeHttp.createServer(),
      {
        environmentId,
        publicOrigin: config.publicOrigin,
        canonicalOrigin: config.canonicalOrigin,
        controlOrigin: config.controlOrigin,
        controlCa: relayTls.cert,
        controlFingerprint: fingerprint(relayTls.cert),
        publisherCredential: config.publisher,
        relayFingerprint: fingerprint(relayTls.cert),
        relay: {
          ...otherTls,
          host,
          port: config.tunnelPort,
          servername: "localhost",
          ca: relayTls.cert,
        },
      },
      { host, environmentId },
    );
    expect((yield* Effect.flip(Fiber.join(wrongKey))).reason).toBe("control_status");

    const accepted = Promise.withResolvers<string>();
    const disconnected = Promise.withResolvers<void>();
    const control = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const upstream = openProofRequest(config.control, {
          method: "POST",
          path: publisherPath,
          headers,
        });
        upstream.on("error", accepted.reject);
        upstream.on("response", (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toBe("application/x-ndjson");
          let data = "";
          response.on("data", (frame: Buffer) => {
            data += frame.toString();
            if (data.includes("\n")) accepted.resolve(data);
          });
          response.on("error", () => {});
          response.once("close", () => disconnected.resolve());
        });
        upstream.end();
        return upstream;
      }),
      (upstream) => Effect.sync(() => upstream.destroy()),
    );
    expect(yield* Effect.promise(() => accepted.promise)).toBe(
      '{"version":1,"status":"accepted"}\n',
    );
    expect((yield* Effect.promise(() => request({}))).status).toBe(409);
    const partial = yield* openRaw(config.publicOrigin);
    partial.socket.write("GET / HTTP/1.1\r\n");
    yield* Scope.close(app.scope, Exit.void);
    yield* Effect.promise(() => partial.received);
    yield* Effect.promise(() => disconnected.promise);
    expect(control.destroyed).toBe(true);
    const result = yield* Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const socket = NodeTls.connect({ host, port: config.tunnelPort });
          socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? ""));
          socket.once("secureConnect", () => {
            socket.destroy();
            resolve("unexpected connection");
          });
        }),
    );
    expect(result).toBe("ECONNREFUSED");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "admits a Node client through real HTTPS and the production connector, and cancels only the revoked environment",
  () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      config.provision();
      const app = yield* startApplication(config);
      const upgraded = Promise.withResolvers<{
        path: string | undefined;
        head: string;
        credential: string | undefined;
      }>();
      const upstreamClosed = Promise.withResolvers<void>();
      const browserUpgraded = Promise.withResolvers<{
        cookie: string | undefined;
        url: string | undefined;
      }>();
      const browserClosed = Promise.withResolvers<void>();
      const forgedCookie = `__Host-t3-relay=${"A".repeat(43)}; Path=/; Secure; HttpOnly`;
      const uploadStarted = Promise.withResolvers<void>();
      const uploadClosed = Promise.withResolvers<void>();
      let uploadRequests = 0;
      const requestTarget = "/asset?ticket=opaque%2Bvalue";
      const seen: Array<unknown> = [];
      const destination = NodeHttp.createServer((request, response) => {
        if (request.url === "/direct") return response.writeHead(200).end("direct");
        if (request.url === "/upload") {
          uploadRequests++;
          request.once("data", () => uploadStarted.resolve());
          request.once("close", () => uploadClosed.resolve());
          return;
        }
        seen.push({
          url: request.url,
          host: request.headers.host,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          relay: request.headers["proxy-authorization"],
          forged: request.headers["x-forwarded-host"],
          origin: request.headers.origin,
        });
        if (request.url === "/browser-redirect") {
          return response
            .writeHead(307, {
              location: `${config.otherOrigin}/browser-redirect-target`,
              "set-cookie": [forgedCookie, "destination=redirect; Path=/"],
            })
            .end();
        }
        response
          .writeHead(request.headers.authorization === "Bearer destination" ? 200 : 401, {
            "set-cookie": "destination=fresh; Path=/",
          })
          .end("destination");
      });
      destination.on("upgrade", (request, socket, head) => {
        socket.on("error", () => {});
        if (request.url === "/browser-rejected-upgrade") {
          socket.end(
            `HTTP/1.1 401 Unauthorized\r\nSet-Cookie: ${forgedCookie}\r\nSet-Cookie: destination=rejected; Path=/\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        if (request.url?.startsWith("/browser-ws?")) {
          socket.once("close", () => browserClosed.resolve());
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: ${forgedCookie}\r\nSet-Cookie: destination=upgraded; Path=/\r\n\r\n`,
          );
          browserUpgraded.resolve({ cookie: request.headers.cookie, url: request.url });
          return;
        }
        socket.once("close", () => upstreamClosed.resolve());
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        let received = head.toString();
        const receive = () => {
          if (received.length >= "first-frame".length)
            upgraded.resolve({
              path: request.url,
              head: received,
              credential: request.headers["proxy-authorization"],
            });
        };
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          receive();
        });
        receive();
      });
      const direct = yield* serveLoopback(destination);
      yield* startConnector(config, app, destination);
      yield* startConnector(config, app, destination, true);

      const authority = new URL(config.publicOrigin).host;
      const headers = {
        host: authority,
        "proxy-authorization": `Bearer ${config.client}`,
        authorization: "Bearer destination",
        cookie: "destination=opaque",
        origin: config.publicOrigin,
        "x-forwarded-host": "untrusted.example",
      };
      const request = (overrides: NodeHttp.OutgoingHttpHeaders = {}) =>
        proofRequest(config.ingress, {
          path: requestTarget,
          headers: Object.fromEntries(
            Object.entries({ ...headers, ...overrides }).filter(([, value]) => value !== undefined),
          ),
        });
      const denials: Array<[NodeHttp.OutgoingHttpHeaders, number]> = [
        [{ host: "wrong.example" }, 421],
        [{ "proxy-authorization": undefined }, 401],
        [{ "proxy-authorization": "Bearer invalid" }, 401],
        [{ "proxy-authorization": `Bearer ${config.otherClient}` }, 403],
        [{ cookie: "destination=opaque; __Host-t3-relay=ambiguous" }, 400],
      ];
      for (const [overrides, status] of denials) {
        expect((yield* Effect.promise(() => request(overrides))).status).toBe(status);
      }
      const wrongSni = {
        servername: "unknown.test",
        checkServerIdentity: (_: string, cert: NodeTls.PeerCertificate) =>
          NodeTls.checkServerIdentity("localhost", cert),
      };
      for (const [target, status] of [
        [authority, 421],
        [authority.replace("localhost", "unknown.test"), 404],
      ] as const) {
        const response = yield* rawRequest(
          config.publicOrigin,
          `GET / HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
          wrongSni,
        );
        expect(response).toContain(`HTTP/1.1 ${status}`);
      }
      const base = `GET ${requestTarget} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer ${config.client}\r\n`;
      for (const [extra, status] of [
        [`Host: ${authority}\r\n`, 421],
        ["Proxy-Authorization: Bearer duplicate\r\n", 400],
        [`${headerPadding}Proxy-Authorization: Bearer duplicate\r\n`, 400],
      ] as const) {
        const response = yield* rawRequest(config.publicOrigin, `${base}${extra}\r\n`);
        expect(response).toContain(`HTTP/1.1 ${status}`);
      }
      const deniedUpload = yield* rawRequest(
        config.publicOrigin,
        `POST /upload HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer invalid\r\nContent-Length: 8\r\nExpect: 100-continue\r\n\r\n`,
      );
      expect(deniedUpload).toContain("HTTP/1.1 401");
      expect(deniedUpload).not.toContain("100 Continue");
      expect(seen).toEqual([]);
      expect(uploadRequests).toBe(0);

      expect((yield* Effect.promise(() => request({ authorization: undefined }))).status).toBe(401);
      const success = yield* Effect.promise(() => request());
      expect(success.status).toBe(200);
      expect(success.headers["set-cookie"]).toEqual(["destination=fresh; Path=/"]);
      expect(seen).toEqual(
        [undefined, "Bearer destination"].map((authorization) => ({
          url: requestTarget,
          host: "destination.example",
          authorization,
          cookie: "destination=opaque",
          relay: undefined,
          forged: undefined,
          origin: config.publicOrigin,
        })),
      );

      expect(
        yield* rawRequest(
          config.publicOrigin,
          `${base}${headerPadding}Authorization: Bearer destination\r\n\r\n`,
        ),
      ).toContain("HTTP/1.1 200");
      expect(seen.at(-1)).toMatchObject({ authorization: "Bearer destination", relay: undefined });

      const sessionPath = "/.well-known/t3/relay-browser/session";
      const mint = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          method: "POST",
          path: "/.well-known/t3/relay-browser/tickets",
          headers: {
            host: authority,
            "proxy-authorization": `Bearer ${config.browserClient.credential}`,
          },
        }),
      );
      expect(mint.status).toBe(201);
      const ticket = new URL(JSON.parse(mint.body).url).hash.slice(1);
      expect(
        yield* rawRequest(
          config.otherOrigin,
          `POST ${sessionPath} HTTP/1.1\r\nHost: ${new URL(config.otherOrigin).host}\r\nOrigin: ${config.otherOrigin}\r\nContent-Type: text/plain\r\nContent-Length: ${ticket.length}\r\n\r\n${ticket}`,
          { ca: otherTls.cert },
        ),
      ).toContain("HTTP/1.1 401");
      const redeem = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          method: "POST",
          path: sessionPath,
          headers: {
            host: authority,
            origin: config.publicOrigin,
            "content-length": ticket.length,
            "content-type": "text/plain",
          },
          body: ticket,
        }),
      );
      expect(redeem.status).toBe(204);
      const admission = redeem.headers["set-cookie"]?.[0]?.split(";", 1)[0];
      if (admission === undefined) throw new Error("Missing relay admission cookie");
      const browserHeaders = {
        host: authority,
        cookie: `destination=opaque; ${admission}; other=keep`,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin",
      };
      const browserRequest = (
        requestHeaders: NodeHttp.OutgoingHttpHeaders = {},
        path = requestTarget,
      ) =>
        proofRequest(config.ingress, {
          path,
          headers: { ...browserHeaders, ...requestHeaders },
        });
      const beforeBrowser = seen.length;
      const browserDenials: Array<[NodeHttp.OutgoingHttpHeaders, number]> = [
        [{ cookie: forgedCookie.split(";", 1)[0] }, 401],
        [{ cookie: [admission, admission] }, 400],
        [{ cookie: `${admission}, destination=opaque` }, 400],
        [{ "proxy-authorization": `Bearer ${config.client}` }, 400],
        [{ origin: config.otherOrigin }, 403],
        [{ "sec-fetch-site": "same-site" }, 403],
        [{ "sec-fetch-site": "cross-site" }, 403],
      ];
      for (const [overrides, status] of browserDenials) {
        expect((yield* Effect.promise(() => browserRequest(overrides))).status).toBe(status);
      }
      const duplicateOrigin = yield* rawRequest(
        config.publicOrigin,
        `GET / HTTP/1.1\r\nHost: ${authority}\r\nCookie: ${admission}\r\nOrigin: ${config.publicOrigin}\r\n${headerPadding}Origin: ${config.publicOrigin}\r\n\r\n`,
      );
      expect(duplicateOrigin).toContain("HTTP/1.1 400");
      const postWithoutOrigin = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          method: "POST",
          path: requestTarget,
          headers: {
            host: authority,
            cookie: browserHeaders.cookie,
            "sec-fetch-site": "same-origin",
          },
        }),
      );
      expect(postWithoutOrigin.status).toBe(403);
      expect(seen).toHaveLength(beforeBrowser);
      expect((yield* Effect.promise(() => browserRequest())).status).toBe(401);
      expect(seen.at(-1)).toMatchObject({
        cookie: "destination=opaque; other=keep",
        authorization: undefined,
      });
      expect(
        (yield* Effect.promise(() => browserRequest({ authorization: "Bearer destination" })))
          .status,
      ).toBe(200);

      const redirect = yield* Effect.promise(() => browserRequest({}, "/browser-redirect"));
      expect(redirect.status).toBe(307);
      expect(redirect.headers.location).toBe(`${config.otherOrigin}/browser-redirect-target`);
      expect(redirect.headers["set-cookie"]).toEqual(["destination=redirect; Path=/"]);
      expect(
        yield* rawRequest(
          config.otherOrigin,
          `GET /browser-redirect-target HTTP/1.1\r\nHost: ${new URL(config.otherOrigin).host}\r\nCookie: ${admission}\r\n\r\n`,
          { ca: otherTls.cert },
        ),
      ).toContain("HTTP/1.1 401");
      expect(seen).not.toContainEqual(expect.objectContaining({ url: "/browser-redirect-target" }));

      const wsRequest = (path: string, originHeaders: string) =>
        `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nCookie: ${browserHeaders.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${originHeaders}\r\n`;
      const sameOrigin = `Origin: ${config.publicOrigin}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: websocket\r\nSec-Fetch-Dest: empty\r\n`;
      for (const originHeaders of [
        "",
        `Origin: ${config.otherOrigin}\r\n`,
        sameOrigin.replace("same-origin", "same-site"),
      ]) {
        expect(
          yield* rawRequest(
            config.publicOrigin,
            wsRequest("/browser-rejected-upgrade", originHeaders),
          ),
        ).toContain("HTTP/1.1 403");
      }
      const rejectedUpgrade = yield* rawRequest(
        config.publicOrigin,
        wsRequest("/browser-rejected-upgrade", sameOrigin),
      );
      expect(rejectedUpgrade).toContain("HTTP/1.1 401");
      expect(rejectedUpgrade).toContain("destination=rejected; Path=/");
      expect(rejectedUpgrade).not.toContain("__Host-t3-relay");

      const browserSocket = yield* openRaw(config.publicOrigin);
      const browserResponse = Promise.withResolvers<void>();
      browserSocket.socket.once("data", () => browserResponse.resolve());
      browserSocket.socket.write(wsRequest("/browser-ws?ticket=destination-ws-ticket", sameOrigin));
      expect(yield* Effect.promise(() => browserUpgraded.promise)).toEqual({
        cookie: "destination=opaque; other=keep",
        url: "/browser-ws?ticket=destination-ws-ticket",
      });
      yield* Effect.promise(() => browserResponse.promise);
      const revoked = yield* Effect.promise(() =>
        fetch(
          `${app.management}/api/self-hosted-relay/v1/sessions/${encodeURIComponent(config.browserClient.sessionId)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${config.owner}` } },
        ),
      );
      expect(revoked.status).toBe(204);
      yield* Effect.promise(() => browserClosed.promise);
      const browserReply = yield* Effect.promise(() => browserSocket.received);
      expect(browserReply).toContain("HTTP/1.1 101");
      expect(browserReply).toContain("destination=upgraded; Path=/");
      expect(browserReply).not.toContain("__Host-t3-relay");
      const beforeRevoked = seen.length;
      expect((yield* Effect.promise(() => browserRequest())).status).toBe(401);
      expect(seen).toHaveLength(beforeRevoked);

      const upload = openProofRequest(config.ingress, {
        method: "POST",
        path: "/upload",
        headers: { ...headers, "content-length": "8", expect: "100-continue" },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => upload.destroy()));
      upload.on("error", () => {});
      upload.once("continue", () => upload.write("part"));
      upload.flushHeaders();
      yield* Effect.promise(() => uploadStarted.promise);
      upload.destroy();
      yield* Effect.promise(() => uploadClosed.promise);
      expect(uploadRequests).toBe(1);

      const pipeline = yield* rawRequest(
        config.publicOrigin,
        `${base}\r\nGET /pipeline-second HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer ${config.client}\r\n\r\n`,
      );
      expect(pipeline.match(/HTTP\/1\.1 /gu)?.length ?? 0).toBeLessThanOrEqual(1);

      const upgrade = yield* openRaw(config.publicOrigin);
      upgrade.socket.write(
        `GET /ws?ticket=ws-ticket HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer ${config.client}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nfirst-frame`,
      );
      expect(yield* Effect.promise(() => upgraded.promise)).toEqual({
        path: "/ws?ticket=ws-ticket",
        head: "first-frame",
        credential: undefined,
      });
      expect((yield* Effect.promise(() => revoke(app.management, config.owner))).status).toBe(204);
      yield* Effect.promise(() => upstreamClosed.promise);
      yield* Effect.promise(() => upgrade.received);
      expect((yield* Effect.promise(() => request())).status).toBe(410);
      expect(
        yield* rawRequest(
          config.otherOrigin,
          `GET ${requestTarget} HTTP/1.1\r\nHost: ${new URL(config.otherOrigin).host}\r\nProxy-Authorization: Bearer ${config.otherClient}\r\nAuthorization: Bearer destination\r\n\r\n`,
          { ca: otherTls.cert },
        ),
      ).toContain("HTTP/1.1 200");
      expect((yield* Effect.promise(() => fetch(`${direct}/direct`))).status).toBe(200);
      expect(seen).not.toContainEqual(expect.objectContaining({ url: "/pipeline-second" }));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("tombstones aliases on a loopback-only revoke and rejects a restored P3 publisher", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fixture();
    config.provision();
    const database = `${config.homeDirectory}/relay.sqlite`;
    const snapshot = `${config.directory}/before-revoke.sqlite`;
    yield* fs.copyFile(database, snapshot);
    const loopback = yield* startApplication(config, false);
    expect((yield* Effect.promise(() => revoke(loopback.management, config.owner))).status).toBe(
      204,
    );
    yield* Scope.close(loopback.scope, Exit.void);
    yield* fs.copyFile(snapshot, database);

    yield* startApplication(config);
    const retired = yield* Effect.promise(() =>
      proofRequest(config.ingress, {
        method: "HEAD",
        path: RELAY_ADMISSION_PATH,
        headers: { host: new URL(config.publicOrigin).host },
      }),
    );
    expect(retired.status).toBe(410);
    expect(
      (yield* Effect.promise(() =>
        proofRequest(config.control, {
          method: "POST",
          path: publisherPath,
          headers: {
            host: new URL(config.controlOrigin).host,
            authorization: `Bearer ${config.publisher}`,
            [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: fingerprint(publisherTls.cert),
          },
        }),
      )).status,
    ).toBe(403);
    using registry = openRelayHomeOriginRegistry(config.homeDirectory);
    expect(() => registry!.register(config.publicOrigin, environmentId)).toThrow();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails closed if the independent authority is replaced while serving", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fixture();
    config.provision();
    const app = yield* startApplication(config);
    const authority = `${config.homeDirectory}.origins/authority.sqlite`;
    const copy = `${config.directory}/replacement.sqlite`;
    yield* fs.copyFile(authority, copy);
    yield* fs.rename(copy, authority);
    const request = (method: string, path: string) =>
      proofRequest(config.ingress, {
        method,
        path,
        headers: { host: new URL(config.publicOrigin).host },
      });
    const probe = yield* Effect.promise(() => request("HEAD", RELAY_ADMISSION_PATH));
    expect(probe.status).toBe(503);
    expect(probe.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBeUndefined();
    expect((yield* Effect.promise(() => request("GET", "/"))).status).toBe(503);
    expect((yield* Effect.promise(() => revoke(app.management, config.owner))).status).toBe(503);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("mints and redeems browser admission locally on the exact HTTPS alias", () =>
  Effect.gen(function* () {
    const config = yield* fixture();
    config.provision();
    yield* startApplication(config);

    const sessionPath = "/.well-known/t3/relay-browser/session";
    const ticketsPath = "/.well-known/t3/relay-browser/tickets";
    const host = new URL(config.publicOrigin).host;
    const mint = (credential: string) =>
      proofRequest(config.ingress, {
        method: "POST",
        path: ticketsPath,
        headers: { host, "proxy-authorization": `Bearer ${credential}` },
      });
    expect((yield* Effect.promise(() => mint(config.otherClient))).status).toBe(403);
    expect((yield* Effect.promise(() => mint(config.publisher))).status).toBe(403);
    for (const metadata of [
      "sec-fetch-site",
      "sec-fetch-mode",
      "sec-fetch-dest",
      "sec-fetch-user",
    ]) {
      const denied = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          method: "POST",
          path: ticketsPath,
          headers: { host, "proxy-authorization": `Bearer ${config.client}`, [metadata]: "none" },
        }),
      );
      expect(denied.status).toBe(400);
    }
    for (const path of [
      `${sessionPath}?ticket=unused`,
      `/extra/..${sessionPath}`,
      sessionPath.replace(".well-known", "%2ewell-known"),
    ]) {
      const blocked = yield* Effect.promise(() =>
        proofRequest(config.ingress, {
          path,
          headers: { host, "proxy-authorization": `Bearer ${config.client}` },
        }),
      );
      expect(blocked.status).toBe(404);
    }
    const minted = yield* Effect.promise(() => mint(config.client));
    expect(minted.status).toBe(201);
    expect(minted.headers["cache-control"]).toBe("no-store");
    const url = new URL(JSON.parse(minted.body).url);
    expect(url.origin).toBe(config.publicOrigin);
    expect(url.pathname).toBe(sessionPath);
    expect(url.search).toBe("");

    const bootstrap = yield* Effect.promise(() =>
      proofRequest(config.ingress, { path: sessionPath, headers: { host } }),
    );
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers["referrer-policy"]).toBe("no-referrer");
    expect(bootstrap.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const redeem = (
      origin: string,
      headers: NodeHttp.OutgoingHttpHeaders = {},
      body = url.hash.slice(1),
    ) =>
      proofRequest(config.ingress, {
        method: "POST",
        path: sessionPath,
        headers: {
          host,
          origin,
          "sec-fetch-site": "same-origin",
          "content-length": body.length,
          "content-type": "text/plain",
          ...headers,
        },
        body,
      });
    expect((yield* Effect.promise(() => redeem(config.otherOrigin))).status).toBe(403);
    expect(
      (yield* Effect.promise(() => redeem(config.publicOrigin, { "sec-fetch-site": "same-site" })))
        .status,
    ).toBe(403);
    const redeemed = yield* Effect.promise(() => redeem(config.publicOrigin));
    expect(redeemed.status).toBe(204);
    expect(redeemed.headers.location).toBeUndefined();
    expect(redeemed.headers["set-cookie"]).toEqual([
      expect.stringMatching(
        /^__Host-t3-relay=[A-Za-z0-9_-]{43}; Max-Age=900; Path=\/; Secure; HttpOnly; SameSite=Strict$/u,
      ),
    ]);
    expect((yield* Effect.promise(() => redeem(config.publicOrigin))).status).toBe(401);

    const script = /<script>([\s\S]+)<\/script>/u.exec(bootstrap.body)?.[1];
    if (script === undefined) throw new Error("Missing bootstrap script");
    let current = url;
    const origin = url.origin;
    let posts = 0;
    const executeBootstrap = (send: (ticket: string) => Promise<{ status: number | undefined }>) =>
      NodeVM.runInNewContext(script, {
        location: {
          get hash() {
            return current.hash;
          },
          replace: (path: string) => {
            current = new URL(path, current);
          },
        },
        history: {
          replaceState: (_state: unknown, _title: string, path: string) => {
            current = new URL(path, current);
          },
        },
        document: { body: { textContent: "" } },
        fetch: (path: string, options: { method: string; body: string }) => {
          expect(current.hash).toBe("");
          expect(path).toBe(sessionPath);
          expect(options.method).toBe("POST");
          posts++;
          return send(options.body);
        },
      }) as Promise<void>;
    yield* Effect.promise(() =>
      executeBootstrap(() => Promise.reject(new Error("Network failure"))),
    );
    expect(posts).toBe(1);
    expect(current.origin).toBe(origin);
    expect(current.hash).toBe("");

    const fresh = yield* Effect.promise(() => mint(config.client));
    expect(fresh.status).toBe(201);
    const retry = new URL(JSON.parse(fresh.body).url);
    expect(new URL(retry.pathname + retry.search, retry).href).not.toBe(current.href);
    current = retry;
    yield* Effect.promise(() => executeBootstrap((ticket) => redeem(origin, {}, ticket)));
    expect(posts).toBe(2);
    expect(current.href).toBe(new URL("/", origin).href);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["mint", "redeem"] as const)(
  "interrupts %s authorization when the downstream HTTPS response closes",
  (operation) =>
    Effect.gen(function* () {
      const config = yield* fixture();
      const manifest = yield* loadSelfHostedRelayForwardingConfig(config.forwardingConfigPath);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<boolean>();
      const grant = yield* Effect.abortSignal;
      let block = false;
      const browser = yield* Layer.build(
        SelfHostedRelayBrowserAdmission.layer.pipe(
          Layer.provide(
            Layer.mock(Runtime.RelayRuntime)({
              authorizeLive: () =>
                Effect.suspend(() =>
                  block
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as(grant),
                        Effect.onExit((exit) =>
                          Deferred.succeed(completed, Exit.hasInterrupts(exit)),
                        ),
                      )
                    : Effect.succeed(grant),
                ),
            }),
          ),
        ),
      );
      yield* SelfHostedRelayIngress.start(
        manifest.ingress,
        manifest.bindings.map((binding) => ({ ...binding, admission: () => "active" })),
      ).pipe(Effect.provideContext(browser), Effect.provide(Layer.mock(RelayForwarding)({})));

      const { host: authority, port } = new URL(config.publicOrigin);
      const sessionPath = "/.well-known/t3/relay-browser/session";
      const ticketsPath = "/.well-known/t3/relay-browser/tickets";
      const mintRequest = `POST ${ticketsPath} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer ${config.client}\r\nContent-Length: 0\r\n\r\n`;
      let wireRequest = mintRequest;
      if (operation === "redeem") {
        const response = yield* Effect.promise(() =>
          proofRequest(config.ingress, {
            method: "POST",
            path: ticketsPath,
            headers: { host: authority, "proxy-authorization": `Bearer ${config.client}` },
          }),
        );
        expect(response.status).toBe(201);
        const ticket = new URL(JSON.parse(response.body).url).hash.slice(1);
        wireRequest = `POST ${sessionPath} HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${config.publicOrigin}\r\nContent-Type: text/plain\r\nContent-Length: ${ticket.length}\r\n\r\n${ticket}`;
      }

      const downstreamClosed = Promise.withResolvers<void>();
      const channel = NodeDiagnosticsChannel.channel("http.server.request.start");
      const observe = (event: unknown) => {
        const { request, response } = event as {
          request: NodeHttp.IncomingMessage;
          response: NodeHttp.ServerResponse;
        };
        if (request.socket.localPort === Number(port)) {
          response.once("close", () => downstreamClosed.resolve());
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => channel.subscribe(observe)),
        () => Effect.sync(() => channel.unsubscribe(observe)),
      );
      const { socket } = yield* openRaw(config.publicOrigin);
      block = true;
      socket.write(wireRequest);
      yield* Deferred.await(entered);
      socket.destroy();
      yield* Effect.promise(() => downstreamClosed.promise);
      const interruptedWhileBlocked = yield* Deferred.isDone(completed);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Deferred.await(completed)).toBe(true);
      expect(interruptedWhileBlocked).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const destinationAuth = Effect.fn("SelfHostedRelayIngressTest.destinationAuth")(function* () {
  const webSockets = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer({ noServer: true })),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => resolve());
          }),
      ),
  );
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const key = makeDpopKey();
  const pairing = yield* auth.createPairingLink({ scopes: ["orchestration:read"] });
  const { token } = yield* sessions.issue({
    method: "bearer-access-token",
    scopes: ["orchestration:read"],
    proofKeyThumbprint: key.thumbprint,
  });
  const session = yield* sessions.verify(token);
  const rpc = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
  const media = yield* auth.issueWebSocketTicket(session, { use: "media" });
  const scope = yield* Effect.scope;
  const handle = yield* NodeHttpServer.makeHandler(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url === "/destination-pair" && request.method === "POST") {
        const credential = yield* request.text;
        const result = yield* Effect.result(
          auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, {
            deviceType: "desktop",
          }),
        );
        return result._tag === "Failure"
          ? HttpServerResponse.empty({ status: 401 })
          : HttpServerResponse.jsonUnsafe(result.success);
      }
      const result = yield* Effect.result(auth.authenticateHttpRequest(request));
      if (result._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
      if (request.method === "POST") {
        const issued = yield* auth.issueWebSocketTicket(result.success, { use: "rpc" });
        return HttpServerResponse.jsonUnsafe({ ticket: Redacted.value(issued.ticket) });
      }
      return HttpServerResponse.jsonUnsafe({ scopes: result.success.scopes });
    }),
    { scope },
  );
  const upgrade = yield* NodeHttpServer.makeUpgradeHandler(
    Effect.succeed(webSockets),
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const result = yield* Effect.result(auth.authenticateWebSocketUpgrade(request, "rpc"));
      if (result._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      yield* writer.writeAll(yield* reader.pull);
      yield* Effect.ignore(reader.pull);
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped),
    { scope },
  );
  return {
    handle,
    upgrade,
    pairing: pairing.credential,
    token,
    key,
    rpc: Redacted.value(rpc.ticket),
    media: Redacted.value(media.ticket),
  };
});

it.live("admits hosted HTTP and WSS through P3 and the production connector", () =>
  Effect.gen(function* () {
    const config = yield* fixture();
    config.provision();
    const app = yield* startApplication(config);
    const mintPath = "/.well-known/t3/relay-browser/tickets";
    const redeemPath = "/.well-known/t3/relay-browser/hosted-session";
    const sessionHeader = "x-t3-relay-session";
    const authority = new URL(config.publicOrigin).host;
    const hostedHeaders = {
      host: authority,
      origin: hostedOrigin,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "empty",
    };
    const json = (value: unknown) => {
      const body = JSON.stringify(value);
      return {
        body,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      };
    };
    const mint = (clientOrigin: string, credential = config.browserClient.credential) => {
      const payload = json({ clientOrigin });
      return proofRequest(config.ingress, {
        path: mintPath,
        method: "POST",
        body: payload.body,
        headers: {
          host: authority,
          ...payload.headers,
          "proxy-authorization": `Bearer ${credential}`,
        },
      });
    };
    const redeem = (ticket: string, headers: NodeHttp.OutgoingHttpHeaders = {}) => {
      const payload = json({ ticket });
      return proofRequest(config.ingress, {
        path: redeemPath,
        method: "POST",
        body: payload.body,
        headers: { ...hostedHeaders, ...payload.headers, ...headers },
      });
    };
    const preflight = (path: string, method: string, requested: string) =>
      proofRequest(config.ingress, {
        path,
        method: "OPTIONS",
        headers: {
          ...hostedHeaders,
          "access-control-request-method": method,
          "access-control-request-headers": requested,
        },
      });
    const bootstrap = yield* Effect.promise(() => preflight(redeemPath, "POST", "content-type"));
    expect(bootstrap.status).toBe(204);
    expect(bootstrap.headers["access-control-allow-origin"]).toBe(hostedOrigin);
    expect(bootstrap.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(
      (yield* Effect.promise(() => preflight("/asset", "GET", "proxy-authorization"))).status,
    ).toBe(403);
    expect(
      (yield* Effect.promise(() =>
        preflight("/asset", "GET", "authorization,dpop,range,x-t3-relay-session"),
      )).status,
    ).toBe(204);
    expect((yield* Effect.promise(() => mint("https://unapproved.example"))).status).toBe(403);
    expect((yield* Effect.promise(() => mint(hostedOrigin, config.otherClient))).status).toBe(403);
    const minted = yield* Effect.promise(() => mint(hostedOrigin));
    expect(minted.status).toBe(201);
    const { ticket, expiresAt } = JSON.parse(minted.body);
    expect(/^[A-Za-z0-9_-]{43}$/u.test(ticket)).toBe(true);
    expect(expiresAt).toEqual(expect.any(Number));
    const wrongOrigin = yield* Effect.promise(() => redeem(ticket, { origin: secondHostedOrigin }));
    expect(wrongOrigin.status).toBe(401);
    expect(wrongOrigin.headers["access-control-allow-origin"]).toBe(secondHostedOrigin);
    const wrongAlias = JSON.stringify({ ticket });
    expect(
      yield* rawRequest(
        config.otherOrigin,
        `POST ${redeemPath} HTTP/1.1\r\nHost: ${new URL(config.otherOrigin).host}\r\nOrigin: ${hostedOrigin}\r\nContent-Type: application/json\r\nContent-Length: ${wrongAlias.length}\r\n\r\n${wrongAlias}`,
        { ca: otherTls.cert },
      ),
    ).toContain("HTTP/1.1 401");
    const redeemed = yield* Effect.promise(() =>
      redeem(ticket, { cookie: "__Host-t3-relay=ignored" }),
    );
    expect(redeemed.status).toBe(201);
    expect(redeemed.headers["set-cookie"]).toBeUndefined();
    const { session, expiresAt: sessionExpiry } = JSON.parse(redeemed.body);
    expect(/^[A-Za-z0-9_-]{43}$/u.test(session)).toBe(true);
    expect(sessionExpiry).toBeGreaterThan(expiresAt);
    expect((yield* Effect.promise(() => redeem(ticket))).status).toBe(401);
    expect(
      (yield* Effect.promise(() => redeem(ticket, { origin: `null, ${hostedOrigin}` }))).status,
    ).toBe(400);

    const authContext = yield* Layer.build(
      EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(
          ServerConfig.layerTest(config.directory, { prefix: "t3-hosted-relay-destination-" }),
        ),
        Layer.provide(NodePlatformCrypto.layer),
      ),
    );
    const auth = yield* destinationAuth().pipe(Effect.provideContext(authContext));
    const requests: Array<{
      target: string | undefined;
      method: string | undefined;
      headers: NodeHttp.IncomingHttpHeaders;
      body?: string;
    }> = [];
    const uploadStarted = Promise.withResolvers<void>();
    const uploadClosed = Promise.withResolvers<void>();
    let uploads = 0;
    const destination = NodeHttp.createServer((request, response) => {
      if (request.url === "/cancel-upload") {
        uploads++;
        request.once("data", () => uploadStarted.resolve());
        request.once("close", () => uploadClosed.resolve());
        return;
      }
      if (request.url === "/destination-pair" || request.url?.startsWith("/destination-auth?")) {
        return auth.handle(request, response);
      }
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.once("end", () => {
        requests.push({
          target: request.url,
          method: request.method,
          headers: request.headers,
          body,
        });
        response
          .writeHead(request.url === "/redirect" ? 307 : 206, {
            "set-cookie": ["destination=ambient; Path=/", "__Host-t3-relay=forged; Path=/"],
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
            "access-control-expose-headers": "x-private",
            "t3-relay-admission": "session-required",
            vary: "Accept-Encoding",
            ...(request.url === "/redirect"
              ? { location: "/trap" }
              : { "content-range": "bytes 0-2/6" }),
          })
          .end("abc");
      });
    });
    const accepted = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    destination.on("upgrade", (request, socket, head) => {
      if (request.url?.startsWith("/destination-auth-ws?"))
        return auth.upgrade(request, socket, head);
      requests.push({ target: request.url, method: request.method, headers: request.headers });
      socket.on("error", () => {});
      if (request.url === "/denied" || request.url === "/upgrade-redirect") {
        const status = request.url === "/denied" ? "401 Unauthorized" : "307 Temporary Redirect";
        socket.end(
          `HTTP/1.1 ${status}\r\nSet-Cookie: rejected=ambient\r\nAccess-Control-Allow-Origin: *\r\nLocation: /trap\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      const selection =
        request.url === "/selected"
          ? "app.v2"
          : request.url === "/reserved"
            ? "t3-relay.v1"
            : request.url === "/unoffered"
              ? "app.other"
              : undefined;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: upgraded=ambient\r\n${selection ? `Sec-WebSocket-Protocol: ${selection}\r\n` : ""}\r\n`,
      );
      if (request.url?.startsWith("/live?")) {
        socket.once("close", () => closed.resolve());
        accepted.resolve();
      } else socket.end();
    });
    const request = (path: string, overrides: NodeHttp.OutgoingHttpHeaders = {}, body?: string) =>
      proofRequest(config.ingress, {
        path,
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }),
        headers: Object.fromEntries(
          Object.entries({
            ...hostedHeaders,
            [sessionHeader]: session,
            cookie: "destination=ambient; __Host-t3-relay=ignored",
            authorization: "Bearer destination",
            dpop: "destination-proof",
            ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
            ...overrides,
          }).filter(([, value]) => value !== undefined),
        ),
      });
    const offline = yield* Effect.promise(() => request("/asset"));
    expect(offline.status).toBe(503);
    expect(offline.headers["access-control-allow-origin"]).toBe(hostedOrigin);
    yield* startConnector(config, app, destination);
    for (const [overrides, status] of [
      [{ origin: "null" }, 403],
      [{ origin: secondHostedOrigin }, 401],
      [{ "sec-fetch-mode": "no-cors" }, 403],
      [{ [sessionHeader]: [session, session] }, 400],
      [{ "proxy-authorization": `Bearer ${config.client}` }, 400],
      [
        {
          [sessionHeader]: undefined,
          cookie: undefined,
          "proxy-authorization": `Bearer ${config.client}`,
        },
        403,
      ],
    ] satisfies Array<[NodeHttp.OutgoingHttpHeaders, number]>) {
      expect((yield* Effect.promise(() => request("/asset", overrides))).status).toBe(status);
    }
    expect(requests).toEqual([]);
    const target = "/asset?raw=%2B%2f&raw=+";
    const success = yield* Effect.promise(() => request(target, { range: "bytes=0-2" }, "bytes"));
    expect(success.status).toBe(206);
    expect(success.body).toBe("abc");
    expect(success.headers["set-cookie"]).toBeUndefined();
    expect(success.headers["t3-relay-admission"]).toBeUndefined();
    expect(success.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(success.headers["access-control-allow-origin"]).toBe(hostedOrigin);
    expect(success.headers["access-control-expose-headers"]?.toLowerCase()).toContain(
      "content-range",
    );
    expect(success.headers.vary?.toLowerCase()).toContain("accept-encoding");
    expect(success.headers.vary?.toLowerCase()).toContain("origin");
    expect(requests[0]).toMatchObject({
      target,
      method: "POST",
      body: "bytes",
      headers: {
        host: "destination.example",
        authorization: "Bearer destination",
        dpop: "destination-proof",
        range: "bytes=0-2",
        origin: hostedOrigin,
      },
    });
    expect(requests[0]?.headers.cookie).toBeUndefined();
    expect(requests[0]?.headers[sessionHeader]).toBeUndefined();
    const redirect = yield* Effect.promise(() => request("/redirect", {}, "once"));
    expect(redirect.status).toBe(502);
    expect(redirect.headers.location).toBeUndefined();
    expect(redirect.headers["access-control-allow-origin"]).toBe(hostedOrigin);
    expect(requests.map(({ target }) => target)).toEqual([target, "/redirect"]);

    const lostSession = yield* Effect.promise(() =>
      request(target, { [sessionHeader]: "z".repeat(43) }),
    );
    expect(lostSession.status).toBe(401);
    expect(lostSession.headers["t3-relay-admission"]).toBe("session-required");
    expect(requests).toHaveLength(2);

    const upload = openProofRequest(config.ingress, {
      method: "POST",
      path: "/cancel-upload",
      headers: {
        ...hostedHeaders,
        [sessionHeader]: session,
        "content-length": "8",
        expect: "100-continue",
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => upload.destroy()));
    upload.on("error", () => {});
    upload.once("continue", () => upload.write("part"));
    upload.flushHeaders();
    yield* Effect.promise(() => uploadStarted.promise);
    upload.destroy();
    yield* Effect.promise(() => uploadClosed.promise);
    expect(uploads).toBe(1);

    const upgrade = (path: string, protocols: string, origin = hostedOrigin) =>
      `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${origin}\r\nSec-Fetch-Mode: websocket\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ambient=secret\r\nSec-WebSocket-Protocol: ${protocols}\r\n\r\n`;
    const protocols = `t3-relay.v1, t3-relay.${session}, app.v2`;
    for (const [offer, origin, status] of [
      [protocols, "null", 403],
      [`${protocols}, t3-relay.v1`, hostedOrigin, 400],
      ["t3-relay.v1, app.v2", hostedOrigin, 400],
    ] as const) {
      expect(yield* rawRequest(config.publicOrigin, upgrade("/ws", offer, origin))).toContain(
        `HTTP/1.1 ${status}`,
      );
    }
    expect(requests).toHaveLength(2);
    for (const [path, status, selection] of [
      ["/selected", 101, "app.v2"],
      ["/reserved", 502, undefined],
      ["/unoffered", 502, undefined],
      ["/denied", 401, undefined],
      ["/upgrade-redirect", 502, undefined],
    ] as const) {
      const response = yield* rawRequest(config.publicOrigin, upgrade(path, protocols));
      expect(response).toContain(`HTTP/1.1 ${status}`);
      expect(response.toLowerCase()).not.toContain("set-cookie");
      expect(response.toLowerCase()).not.toContain("location:");
      expect(response).toContain(`access-control-allow-origin: ${hostedOrigin}`);
      if (selection) expect(response).toContain(`sec-websocket-protocol: ${selection}`);
      expect(response.includes(session)).toBe(false);
      expect(requests.at(-1)?.headers["sec-websocket-protocol"]).toBe("app.v2");
      expect(requests.at(-1)?.headers.cookie).toBeUndefined();
    }
    const pairDestination = () =>
      request("/destination-pair", { authorization: undefined, dpop: undefined }, auth.pairing);
    const paired = yield* Effect.promise(pairDestination);
    expect(paired.status).toBe(200);
    const bearer = JSON.parse(paired.body).access_token;
    expect((yield* Effect.promise(pairDestination)).status).toBe(401);
    const bearerSession = yield* Effect.promise(() =>
      request("/destination-auth?bearer", { authorization: `Bearer ${bearer}`, dpop: undefined }),
    );
    expect(bearerSession.status).toBe(200);
    expect(JSON.parse(bearerSession.body)).toEqual({ scopes: ["orchestration:read"] });

    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const httpProof = auth.key.sign({
      method: "GET",
      url: `${config.publicOrigin}/destination-auth`,
      token: auth.token,
      iat,
    });
    const destinationRequest = () =>
      request("/destination-auth?path=raw%2Fvalue", {
        authorization: `DPoP ${auth.token}`,
        dpop: httpProof,
      });
    const authorized = yield* Effect.promise(destinationRequest);
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ scopes: ["orchestration:read"] });
    const destinationRejection = yield* Effect.promise(destinationRequest);
    expect(destinationRejection.status).toBe(401);
    expect(destinationRejection.headers["t3-relay-admission"]).toBeUndefined();

    const socketProof = auth.key.sign({
      method: "GET",
      url: `${config.publicOrigin}/destination-auth-ws`,
      token: auth.rpc,
      iat,
    });
    const socketPath = (ticket: string, proof?: string) =>
      `/destination-auth-ws?wsTicket=${encodeURIComponent(ticket)}${proof ? `&dpop=${encodeURIComponent(proof)}` : ""}`;
    const relayProtocols = ["t3-relay.v1", `t3-relay.${session}`];
    const socketOptions = {
      ca: relayTls.cert,
      servername: "localhost",
      origin: hostedOrigin,
      headers: { host: authority },
    };
    const connect = (path: string) =>
      Effect.promise(
        () =>
          new Promise<{ status: number; text?: string }>((resolve, reject) => {
            const socket = new NodeWS.WebSocket(
              `wss://${host}:${new URL(config.publicOrigin).port}${path}`,
              relayProtocols,
              socketOptions,
            );
            socket.once("error", reject);
            socket.once("unexpected-response", (_, response) => {
              response.resume();
              response.once("end", () => {
                resolve({ status: response.statusCode ?? 0 });
                socket.terminate();
              });
            });
            socket.once("open", () => socket.send("destination frame"));
            let text: string | undefined;
            socket.once("message", (message) => {
              text = message.toString();
              socket.close();
            });
            socket.once("close", () => {
              if (text === undefined)
                reject(new Error("Socket closed without a destination frame"));
              else resolve({ status: 101, text });
            });
          }),
      );
    expect(yield* connect(socketPath(auth.media))).toEqual({ status: 401 });
    expect(yield* connect(socketPath(auth.rpc))).toEqual({ status: 401 });
    expect(yield* connect(socketPath(auth.rpc, socketProof))).toEqual({
      status: 101,
      text: "destination frame",
    });
    expect(yield* connect(socketPath(auth.rpc, socketProof))).toEqual({ status: 401 });
    const freshTicket = yield* Effect.promise(() =>
      request(
        "/destination-auth?ticket",
        { authorization: `Bearer ${bearer}`, dpop: undefined },
        "",
      ),
    );
    expect(freshTicket.status).toBe(200);
    expect(yield* connect(socketPath(JSON.parse(freshTicket.body).ticket))).toEqual({
      status: 101,
      text: "destination frame",
    });

    const livePath = "/live?wsTicket=opaque%2Bticket&dpop=proof%2Fvalue";
    const live = yield* openRaw(config.publicOrigin);
    live.socket.write(upgrade(livePath, `t3-relay.v1, t3-relay.${session}`));
    yield* Effect.promise(() => accepted.promise);
    expect(requests.at(-1)?.target).toBe(livePath);
    expect(requests.at(-1)?.headers["sec-websocket-protocol"]).toBeUndefined();
    expect(
      (yield* Effect.promise(() =>
        fetch(
          `${app.management}/api/self-hosted-relay/v1/sessions/${encodeURIComponent(config.browserClient.sessionId)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${config.owner}` } },
        ),
      )).status,
    ).toBe(204);
    yield* Effect.promise(() => closed.promise);
    const liveResponse = yield* Effect.promise(() => live.received);
    expect(liveResponse).toContain("sec-websocket-protocol: t3-relay.v1");
    expect(liveResponse.includes(session)).toBe(false);
    expect((yield* Effect.promise(() => request("/asset"))).status).toBe(401);
    expect((yield* Effect.promise(() => revoke(app.management, config.owner))).status).toBe(204);
    const retired = yield* Effect.promise(() => request("/asset"));
    expect(retired.status).toBe(410);
    expect(retired.headers["access-control-allow-origin"]).toBe(hostedOrigin);
    expect((yield* Effect.promise(() => preflight("/asset", "GET", sessionHeader))).status).toBe(
      410,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("saves a signed file over 256 MiB through both bounded relay lanes", () =>
  Effect.gen(function* () {
    const config = yield* fixture();
    config.provision();
    const app = yield* startApplication(config);
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(config.directory);
    const file = `${root}/original clip.mp4`;
    const size = 256 * 1024 ** 2 + 41;
    const expectedDigest = NodeCrypto.createHash("sha256");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(file, { flag: "w" });
        const block = Buffer.alloc(1024 ** 2);
        let seed = 0x70a19c2;
        for (let offset = 0; offset < size; offset += block.length) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          block.fill(seed & 255);
          block.writeUInt32LE(seed);
          const chunk = block.subarray(0, Math.min(block.length, size - offset));
          expectedDigest.update(chunk);
          yield* output.writeAll(chunk);
        }
      }),
    );
    const destination = yield* Effect.gen(function* () {
      const grant = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId: ThreadId.make("download-thread"), path: file },
        workspaceRoot: root,
      });
      const scope = yield* Effect.scope;
      const router = yield* HttpRouter.toHttpEffect(layerAssetRoute);
      const handle = yield* NodeHttpServer.makeHandler(router, { scope });
      const requests: Array<{
        target: string | undefined;
        range: string | undefined;
        ifRange: string | undefined;
      }> = [];
      const backend = NodeHttp.createServer((request, response) => {
        requests.push({
          target: request.url,
          range: request.headers.range,
          ifRange: request.headersDistinct["if-range"]?.[0],
        });
        handle(request, response);
      });
      return { backend, target: grant.relativeUrl + "?raw=%2f+%20&raw=1", requests };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpPlatform.layer,
          WorkspacePaths.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(PluginPackageStore.PluginPackageStore)({
            paths: () => ({ packageDir: root, dataDir: root, configPath: root }),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(SourceControlDrivers, []),
          Digest.layerWebCrypto,
          Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
          Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
          AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(root, { prefix: "t3-signed-range-destination-" }),
          ),
          Layer.provide(NodePlatformCrypto.layer),
        ),
      ),
    );
    yield* startConnector(config, app, destination.backend);

    const authority = new URL(config.publicOrigin).host;
    const native = { host: authority, "proxy-authorization": `Bearer ${config.client}` };
    const hosted = yield* Effect.promise(async () => {
      const json = (body: object) => {
        const text = JSON.stringify(body);
        return {
          body: text,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
          },
        };
      };
      const ticket = json({ clientOrigin: hostedOrigin });
      const minted = await proofRequest(config.ingress, {
        path: RELAY_BROWSER_TICKETS_PATH,
        method: "POST",
        body: ticket.body,
        headers: {
          host: authority,
          ...ticket.headers,
          "proxy-authorization": `Bearer ${config.browserClient.credential}`,
        },
      });
      expect(minted.status).toBe(201);
      const redeem = json({ ticket: JSON.parse(minted.body).ticket });
      const browser = {
        host: authority,
        origin: hostedOrigin,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "empty",
      };
      const admitted = await proofRequest(config.ingress, {
        path: RELAY_HOSTED_SESSION_PATH,
        method: "POST",
        body: redeem.body,
        headers: { ...browser, ...redeem.headers },
      });
      expect(admitted.status).toBe(201);
      const preflight = await proofRequest(config.ingress, {
        path: destination.target,
        method: "OPTIONS",
        headers: {
          ...browser,
          "access-control-request-method": "GET",
          "access-control-request-headers": `range,if-range,${RELAY_HOSTED_SESSION_HEADER},${RELAY_MEDIA_DOWNLOAD_HEADER}`,
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(hostedOrigin);
      expect(preflight.headers["access-control-allow-headers"]).toContain(
        RELAY_MEDIA_DOWNLOAD_HEADER,
      );
      return {
        ...browser,
        [RELAY_HOSTED_SESSION_HEADER]: String(JSON.parse(admitted.body).session),
      };
    });
    yield* Effect.promise(async (signal) => {
      const request = (headers: NodeHttp.OutgoingHttpHeaders, signal: AbortSignal) =>
        new Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> }>(
          (resolve, reject) => {
            const wire = openProofRequest(config.ingress, {
              method: "GET",
              path: destination.target,
              headers,
              signal,
            });
            wire.once("error", reject);
            wire.once("response", (response) => {
              const headers = new Headers();
              for (const [name, values] of Object.entries(response.headersDistinct)) {
                for (const value of values ?? []) headers.append(name, value);
              }
              resolve({
                status: response.statusCode ?? 0,
                headers,
                body: NodeStream.Readable.toWeb(response, {
                  strategy: { highWaterMark: 0 },
                }) as ReadableStream<Uint8Array>,
              });
            });
            wire.end();
          },
        );

      const old = await request(native, signal);
      expect(old.status).toBe(502);
      await old.body.cancel();
      const firstRange = `bytes=0-${RELAY_MEDIA_RANGE_BYTES - 1}`;
      const conditional = await request(
        { ...native, range: firstRange, "if-range": '"stale"' },
        signal,
      );
      expect(conditional.status).toBe(502);
      await conditional.body.cancel();
      const playback = await request({ ...hosted, range: firstRange }, signal);
      expect(playback.status).toBe(206);
      expect(playback.headers.get("etag")).toBeNull();
      await playback.body.cancel();

      const sha256 = expectedDigest.digest("hex");
      for (const lane of [native, hosted]) {
        const previous = destination.requests.length;
        const download = await openRelayMediaDownload(
          async (headers, rangeSignal) => {
            const reply = await request({ ...lane, ...headers }, rangeSignal);
            expect(reply.status).toBe(206);
            expect(reply.headers.get("etag")).toContain(sha256);
            if (lane === hosted) {
              expect(reply.headers.get("access-control-allow-origin")).toBe(hostedOrigin);
              expect(reply.headers.get("access-control-expose-headers")?.split(", ")).toContain(
                "ETag",
              );
            }
            return reply;
          },
          { signal, maxBytes: size },
        );
        expect(download.length).toBe(size);
        expect(download.mimeType).toBe("video/mp4");
        const actualDigest = NodeCrypto.createHash("sha256");
        for await (const chunk of download.body) actualDigest.update(chunk);
        expect(actualDigest.digest("hex")).toBe(sha256);
        const exchanges = destination.requests.slice(previous);
        expect(exchanges).toHaveLength(33);
        expect(exchanges[0]?.ifRange).toBeUndefined();
        for (const [index, exchange] of exchanges.entries()) {
          const start = index * RELAY_MEDIA_RANGE_BYTES;
          const end = Math.min(size, start + RELAY_MEDIA_RANGE_BYTES) - 1;
          expect(exchange.target).toBe(destination.target);
          expect(exchange.range).toBe(`bytes=${start}-${end}`);
          if (index > 0) expect(exchange.ifRange).toContain(sha256);
        }

        const truncated = await openRelayMediaDownload(
          async (headers, rangeSignal) => {
            const reply = await request({ ...lane, ...headers }, rangeSignal);
            return {
              ...reply,
              body: reply.body.pipeThrough(
                new TransformStream({
                  transform(chunk, controller) {
                    controller.enqueue(chunk.subarray(1));
                  },
                }),
              ),
            };
          },
          { signal, maxBytes: size },
        );
        const drain = async (body: ReadableStream<Uint8Array>) => {
          await body.pipeTo(new WritableStream());
        };
        await expect(drain(truncated.body)).rejects.toThrow("requested file range");

        const spoofed = await openRelayMediaDownload(
          async (headers, rangeSignal) => {
            const reply = await request({ ...lane, ...headers }, rangeSignal);
            if (headers["if-range"] === undefined) return reply;
            if (reply.headers.get("content-length") !== "41") return reply;
            return {
              ...reply,
              body: reply.body.pipeThrough(
                new TransformStream({
                  transform(chunk, controller) {
                    const changed = Uint8Array.from(chunk);
                    changed[0] = changed[0]! ^ 1;
                    controller.enqueue(changed);
                  },
                }),
              ),
            };
          },
          { signal, maxBytes: size },
        );
        await expect(drain(spoofed.body)).rejects.toThrow("file changed");
      }

      for (const [index, lane] of [native, hosted].entries()) {
        const changed = await openRelayMediaDownload(
          async (headers, rangeSignal) => {
            if (headers["if-range"] !== undefined) {
              const handle = await NodeFS.promises.open(file, "r+");
              try {
                await handle.write(Uint8Array.of(index), 0, 1, 0);
                await handle.utimes(1, index + 1);
              } finally {
                await handle.close();
              }
            }
            const reply = await request({ ...lane, ...headers }, rangeSignal);
            expect(reply.status).toBe(headers["if-range"] === undefined ? 206 : 412);
            return reply;
          },
          { signal, maxBytes: size },
        );
        await expect(changed.body.pipeTo(new WritableStream())).rejects.toThrow("file changed");
      }
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
