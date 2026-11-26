// @effect-diagnostics nodeBuiltinImport:off -- The proof owns real HTTP and TLS listeners.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  AuthMcpApprovalRedirect,
  AuthMcpRegisteredClient,
  AuthMcpTokenResult,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { descriptorOf, servePeer } from "../peer/PeerLinks.testkit.ts";
import { canonicalRequestUrl, requestUrl } from "../requestUrl.ts";
import { proofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";
import {
  attachRelayProofEnvironment,
  parseRelayProofEnvironment,
} from "./RelayProofEnvironment.ts";
import * as SelfHostedRelayConnector from "./SelfHostedRelayConnector.ts";
import { makeStaticRelayEdge } from "@t3tools/relay-core/RelayTunnelTransport";

const config = {
  environmentId: "proof-environment",
  publicOrigin: "https://relay.test:8443",
  canonicalOrigin: "https://environment.test",
  relayHost: "127.0.0.1",
  relayPort: 2443,
  relayServername: "relay.test",
  relayFingerprint: Array.from({ length: 32 }, () => "AB").join(":"),
  caPath: "/proof/ca.pem",
  certPath: "/proof/client.pem",
  keyPath: "/proof/client-key.pem",
};

const send = (url: string, options: Parameters<typeof proofRequest>[1] = {}) =>
  Effect.promise((): ReturnType<typeof proofRequest> =>
    url.startsWith("https:")
      ? proofRequest(url, options)
      : new Promise((resolve, reject) => {
          const request = NodeHttp.request(url, { ...options, agent: false }, (response) => {
            response.setEncoding("utf8");
            let body = "";
            response.on("data", (chunk: string) => (body += chunk));
            response.once("error", reject);
            response.once("end", () =>
              resolve({ status: response.statusCode, headers: response.headers, body }),
            );
          });
          request.once("error", reject);
          request.end(options.body);
        }),
  );

const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpRegisteredClient));
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpApprovalRedirect));
const decodeToken = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpTokenResult));

it("requires an explicit pinned TLS configuration and a loopback origin server", () => {
  expect(parseRelayProofEnvironment(JSON.stringify(config), "127.0.0.1")).toEqual(config);
  expect(() => parseRelayProofEnvironment(JSON.stringify(config), "0.0.0.0")).toThrow();
  expect(() =>
    parseRelayProofEnvironment(JSON.stringify({ ...config, relayFingerprint: "" }), "::1"),
  ).toThrow();
  expect(() =>
    parseRelayProofEnvironment(
      JSON.stringify({ ...config, canonicalOrigin: "https://environment.test/mcp" }),
      "127.0.0.1",
    ),
  ).toThrow();
  expect(() =>
    parseRelayProofEnvironment(JSON.stringify({ ...config, relayPort: 0 }), "127.0.0.1"),
  ).toThrow();
});

it.live("keeps legacy TLS forwarding on a listener without a proof profile", () =>
  Effect.gen(function* () {
    const handler = yield* NodeHttpServer.makeHandler(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return HttpServerResponse.jsonUnsafe({
          external: Option.getOrThrow(requestUrl(request)).href,
          canonical: Option.getOrThrow(canonicalRequestUrl(request)).href,
        });
      }),
      { scope: yield* Effect.scope },
    );
    const url = yield* serveLoopback(NodeHttp.createServer(handler));
    const response = yield* send(url + "/mcp", {
      headers: { host: "legacy.terminator.test", "x-forwarded-proto": "https" },
    });
    expect(JSON.parse(response.body)).toEqual({
      external: "https://legacy.terminator.test/mcp",
      canonical: "https://legacy.terminator.test/mcp",
    });
  }),
);

it.live.each(["static proof", "production connector", "production connector without terminator"])(
  "%s pins OAuth and MCP identity across direct and relay requests",
  (profile) =>
    Effect.gen(function* () {
      const tls = {
        cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
        key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
      };
      const client = {
        cert: NodeFS.readFileSync(
          new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url),
        ),
        key: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url)),
      };
      const terminatorToken = NodeCrypto.randomBytes(32).toString("hex");
      let listenerUrl: string;
      const canonicalOrigin = yield* serveLoopback(
        NodeHttps.createServer(tls, (request, response) => {
          const upstreamRequest = NodeHttp.request(
            listenerUrl,
            {
              method: request.method,
              path: request.url,
              headers: { ...request.headers, "x-t3-proof-terminator-token": terminatorToken },
            },
            (upstream) => {
              response.writeHead(upstream.statusCode ?? 502, upstream.headers);
              upstream.pipe(response);
            },
          ).on("error", () => response.writeHead(502).end());
          request.pipe(upstreamRequest);
        }),
      );
      const publicOrigin = "https://localhost";
      const edge = makeStaticRelayEdge({
        tunnelTls: { ...tls, ca: client.cert },
        environmentFingerprint: new NodeCrypto.X509Certificate(client.cert).fingerprint256,
        publicOrigin,
        canonicalOrigin,
        admission: () => "active",
      });
      const relayPort = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              edge.tunnelServer.once("error", reject);
              edge.tunnelServer.listen(0, "127.0.0.1", () => {
                const address = edge.tunnelServer.address();
                if (address === null || typeof address === "string") {
                  reject(new Error("Expected a TCP listener"));
                } else {
                  resolve(address.port);
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
      const relayUrl = yield* serveLoopback(NodeHttps.createServer(tls, edge.request));
      const listener = NodeHttp.createServer();
      const files: Record<string, string> = {
        "/proof/config.json": JSON.stringify({
          ...config,
          publicOrigin,
          canonicalOrigin,
          relayPort,
          relayServername: "localhost",
          relayFingerprint: new NodeCrypto.X509Certificate(tls.cert).fingerprint256,
          directTerminatorTokenPath: "/proof/terminator-token",
        }),
        "/proof/id": config.environmentId,
        "/proof/terminator-token": terminatorToken,
        [config.caPath]: tls.cert.toString(),
        [config.certPath]: client.cert.toString(),
        [config.keyPath]: client.key.toString(),
      };
      const hasTerminator = profile !== "production connector without terminator";
      const connector = yield* Effect.gen(function* () {
        if (profile === "static proof") {
          yield* attachRelayProofEnvironment(listener, {
            host: "127.0.0.1",
            environmentIdPath: "/proof/id",
          }).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({
                env: { T3CODE_STATIC_RELAY_PROOF_CONFIG: "/proof/config.json" },
              }),
            ),
            Effect.provide(
              FileSystem.layerNoop({ readFileString: (path) => Effect.succeed(files[path]!) }),
            ),
          );
          return;
        }
        const control = yield* serveLoopback(
          NodeHttps.createServer(tls, (_request, response) => {
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            response.write('{"version":1,"status":"accepted"}\n');
            void edge.ready.then(() => {
              response.write('{"version":1,"status":"ready"}\n');
            });
          }),
        );
        const { environmentId } = descriptorOf(config.environmentId, "Proof");
        const fingerprint = new NodeCrypto.X509Certificate(tls.cert).fingerprint256;
        return yield* SelfHostedRelayConnector.start(
          listener,
          {
            environmentId,
            publicOrigin,
            canonicalOrigin,
            controlOrigin: control.replace("127.0.0.1", "localhost"),
            controlCa: tls.cert,
            controlFingerprint: fingerprint,
            publisherCredential: "fixture-publisher",
            relayFingerprint: fingerprint,
            relay: {
              ...client,
              ca: tls.cert,
              host: "127.0.0.1",
              port: relayPort,
              servername: "localhost",
            },
            ...(hasTerminator ? { directTerminatorToken: terminatorToken } : {}),
          },
          { host: "127.0.0.1", environmentId },
        );
      });
      const server = yield* Layer.build(
        NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 }),
      );
      const peer = yield* servePeer(descriptorOf(config.environmentId, "Proof"), Layer.empty, {
        before: (request) =>
          request.url.startsWith("/route-probe")
            ? HttpServerResponse.text(Option.getOrThrow(requestUrl(request)).href)
            : undefined,
      }).pipe(Effect.provideContext(server));
      listenerUrl = peer.url;
      yield* Effect.promise(() => edge.ready);

      const rawHeaders = {
        host: "untrusted.test",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "untrusted.test",
        forwarded: "proto=https;host=untrusted.test",
        "x-t3-proof-terminator-token": "0".repeat(64),
      };
      const routePath = "/route-probe?key=value";
      const rawRoute = yield* send(listenerUrl + routePath, { headers: rawHeaders });
      const metadataPath = "/.well-known/oauth-protected-resource/mcp";
      const issuerPath = "/.well-known/oauth-authorization-server";
      const rawMetadata = yield* send(listenerUrl + metadataPath, { headers: rawHeaders });
      expect(JSON.parse(rawMetadata.body)).toMatchObject({
        resource: canonicalOrigin + "/mcp",
        authorization_servers: [canonicalOrigin],
      });
      const rawIssuer = yield* send(listenerUrl + issuerPath, { headers: rawHeaders });
      expect(JSON.parse(rawIssuer.body)).toMatchObject({
        issuer: canonicalOrigin,
        token_endpoint: canonicalOrigin + "/oauth/mcp/token",
      });
      expect(rawRoute.body).toBe("http://untrusted.test" + routePath);
      const terminatedRoute = yield* send(canonicalOrigin + routePath, {
        headers: { ...rawHeaders, "x-forwarded-proto": "http" },
      });
      expect(terminatedRoute.body).toBe(
        (hasTerminator ? canonicalOrigin : "http://untrusted.test") + routePath,
      );
      const relayHeaders = { ...rawHeaders, host: "localhost" };
      const aliasRoute = yield* send(relayUrl + routePath, { headers: relayHeaders });
      expect(aliasRoute.body).toBe(publicOrigin + routePath);

      const resource = canonicalOrigin + "/mcp";
      const redirectUri = "http://127.0.0.1:43001/callback";
      const verifier = NodeCrypto.randomBytes(32).toString("base64url");
      const postOAuth = (path: string, body: object | URLSearchParams) => {
        const isForm = body instanceof URLSearchParams;
        return send(listenerUrl + "/oauth/mcp" + path, {
          method: "POST",
          headers: {
            ...rawHeaders,
            "content-type": isForm ? "application/x-www-form-urlencoded" : "application/json",
          },
          body: isForm ? body.toString() : JSON.stringify(body),
        });
      };
      const registration = yield* postOAuth("/register", { redirect_uris: [redirectUri] });
      expect(registration.status).toBe(201);
      const { client_id: clientId } = decodeRegistration(registration.body);
      const pairing = yield* peer.auth.issuePairingCredential();
      const decision = yield* postOAuth("/decision", {
        authorization: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          resource,
        },
        decision: { _tag: "pairing-code", access: "read-only", code: pairing.credential },
      });
      expect(decision.status).toBe(200);
      const approved = new URL(decodeDecision(decision.body).redirectTo);
      expect(approved.searchParams.get("iss")).toBe(canonicalOrigin);
      const code = approved.searchParams.get("code");
      if (code === null) throw new Error("Expected an OAuth authorization code");
      const token = yield* postOAuth(
        "/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          code,
          resource,
        }),
      );
      expect(token.status).toBe(200);
      const { access_token: accessToken } = decodeToken(token.body);
      const initialize = (origin: string, headers: NodeHttp.OutgoingHttpHeaders) =>
        send(origin + "/mcp", {
          method: "POST",
          headers: {
            ...headers,
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + accessToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "proof", version: "1" },
            },
          }),
        });
      for (const [origin, headers] of [
        [canonicalOrigin, {}],
        [relayUrl, relayHeaders],
      ] as const) {
        const metadata = yield* send(origin + metadataPath, { headers });
        expect(metadata.status).toBe(200);
        expect(JSON.parse(metadata.body)).toMatchObject({
          resource: canonicalOrigin + "/mcp",
          authorization_servers: [canonicalOrigin],
        });
        const session = yield* initialize(origin, headers);
        expect(session.status).toBe(200);
        expect(session.headers["mcp-session-id"]).toBeDefined();
      }
      if (connector !== undefined) {
        yield* Fiber.interrupt(connector);
        const offlineSession = yield* initialize(listenerUrl, rawHeaders);
        expect(offlineSession.status).toBe(200);
        expect(offlineSession.headers["mcp-session-id"]).toBeDefined();
      }
    }),
);
