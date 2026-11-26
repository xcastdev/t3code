// @effect-diagnostics nodeBuiltinImport:off -- The peer OAuth proof derives a PKCE challenge and TLS pin.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeFS from "node:fs";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthMcpApprovalRedirect,
  AuthMcpRegisteredClient,
  AuthMcpTokenResult,
  type EnvironmentId,
  MCP_PEER_LINK_SOFTWARE_ID,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { relayExternalOrigin } from "../requestUrl.ts";
import * as Forwarding from "@t3tools/relay-core/RelayForwarding";
import * as Runtime from "@t3tools/relay-core/RelayRuntime";
import { connectStaticRelayTunnel } from "@t3tools/relay-core/RelayTunnelTransport";
import {
  proofRequest,
  serveLoopback,
  serveProofIngress,
} from "../relay/fixtures/p1bIngress.testkit.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  servePeer,
  type ServedPeer,
} from "./PeerLinks.testkit.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerEnrollment from "./PeerEnrollment.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as PeerVerifiedTransport from "./PeerVerifiedTransport.ts";

const redirect = "http://127.0.0.1/t3code-peer-link";
const verifier = "p".repeat(43);
const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
const oauth = "/oauth/mcp";
const metadataPathForMcp = "/.well-known/oauth-protected-resource/mcp";
const protocolVersion = "2025-06-18";
const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpRegisteredClient));
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpApprovalRedirect));
const decodeToken = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpTokenResult));

const Probe = Schema.Struct({
  access: Schema.String,
  linked: Schema.Boolean,
  origin: Schema.String,
  modes: Schema.String,
});
const toolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Returns the destination's view of the peer grant.",
    success: Probe,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);
const tools = McpHttpServer.toolkitRegistration(
  toolkit,
  McpToolAccess.toLayer(toolkit, {
    probe: McpToolAccess.reads(() =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.map((scope) => {
          const modes = McpInvocationContext.clientModeCeiling(scope.client);
          return {
            access: scope.client?.access ?? "",
            linked: scope.client?.linked ?? false,
            origin: scope.origin ?? "",
            modes: `${modes.runtimeMode}/${modes.interactionMode}`,
          };
        }),
      ),
    ),
  }),
);

const serveDestination = (name: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    return yield* servePeer(descriptorOf(name, name), tools).pipe(Effect.provideContext(context));
  });

interface PeerRequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

const send = (url: string, options?: PeerRequestOptions) =>
  Effect.promise(() => proofRequest(url, options));

const senderFor = (client: HttpClient.HttpClient) =>
  Effect.fn("PeerRelayOAuthTest.send")(function* (url: string, options?: PeerRequestOptions) {
    let request =
      options?.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
    if (options?.body !== undefined) request = HttpClientRequest.bodyText(request, options.body);
    if (options?.headers !== undefined)
      request = HttpClientRequest.setHeaders(request, options.headers);
    const response = yield* client.execute(request);
    return { status: response.status, body: yield* response.text, headers: response.headers };
  }, Effect.orDie);

const verifiedSender = (canonicalOrigin: string, aliasOrigin: string) => {
  const ca = NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
  const spki = new NodeCrypto.X509Certificate(ca).publicKey.export({ type: "spki", format: "der" });
  const spkiSha256 = NodeCrypto.createHash("sha256").update(spki).digest("base64url");
  return senderFor(
    PeerVerifiedTransport.make({ canonicalOrigin, aliasOrigin, spkiSha256 }, { ca }),
  );
};

const postJson = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  request = send,
) =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const discovery = (route: string, path: string, request = send) =>
  request(route + path).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200);
      return JSON.parse(response.body);
    }),
  );

const register = (route: string) =>
  postJson(route + oauth + "/register", {
    client_name: "P1b peer proof",
    redirect_uris: [redirect],
    software_id: MCP_PEER_LINK_SOFTWARE_ID,
  }).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(201);
      return decodeRegistration(response.body).client_id;
    }),
  );

const authorization = (clientId: string, resource: string) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "p1b-state",
  resource,
});

const approve = (
  peer: ServedPeer,
  route: string,
  clientId: string,
  resource: string,
  request = send,
) =>
  Effect.gen(function* () {
    const pairing = yield* peer.auth.issuePairingCredential();
    const decision = yield* postJson(
      route + oauth + "/decision",
      {
        authorization: authorization(clientId, resource),
        decision: { _tag: "pairing-code", access: "read-only", code: pairing.credential },
      },
      {},
      request,
    );
    expect(decision.status).toBe(200);
    return new URL(decodeDecision(decision.body).redirectTo);
  });

const redeem = (route: string, clientId: string, code: string, resource: string, request = send) =>
  request(route + oauth + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    }).toString(),
  });

const mcp = (
  route: string,
  token: string,
  method: string,
  params?: unknown,
  sessionId?: string,
  request = send,
) =>
  postJson(
    route + "/mcp",
    { jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, params },
    {
      accept: "application/json, text/event-stream",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      ...(sessionId === undefined
        ? {}
        : { "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion }),
    },
    request,
  );

const initialize = (route: string, token: string, request = send) =>
  mcp(
    route,
    token,
    "initialize",
    {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "p1b-peer", version: "1" },
    },
    undefined,
    request,
  );

it.live(
  "discovers one canonical peer resource and keeps its read-only grant across TLS aliases",
  () =>
    Effect.gen(function* () {
      const peer = yield* serveDestination("environment-p1b-a");
      const otherPeer = yield* serveDestination("environment-p1b-b");
      const direct = yield* serveProofIngress(peer.url);
      const alias = yield* serveProofIngress(peer.url, direct.url);
      const differentBinding = yield* serveProofIngress(peer.url);
      const other = yield* serveProofIngress(otherPeer.url);
      const sendViaAlias = verifiedSender(direct.url, alias.url);
      const resource = direct.url + "/mcp";
      const metadataPath = metadataPathForMcp;

      for (const request of [send, sendViaAlias]) {
        expect(yield* discovery(direct.url, metadataPath, request)).toMatchObject({
          resource,
          authorization_servers: [direct.url],
        });
        expect(
          yield* discovery(direct.url, "/.well-known/oauth-authorization-server", request),
        ).toMatchObject({
          issuer: direct.url,
          authorization_endpoint: direct.url + oauth + "/authorize",
          token_endpoint: direct.url + oauth + "/token",
          registration_endpoint: direct.url + oauth + "/register",
        });
      }
      const unauthenticated = yield* initialize(direct.url, "", sendViaAlias);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers["www-authenticate"]).toContain(
        `resource_metadata="${direct.url}${metadataPath}"`,
      );

      const clientId = yield* register(direct.url);
      const query = new URLSearchParams(authorization(clientId, resource));
      const start = yield* Effect.promise(() =>
        proofRequest(`${direct.url}${oauth}/authorize?${query}`),
      );
      expect(start.status).toBe(302);
      expect(start.headers.location).toBe(`/connect-agent?${query}`);
      const fallback = yield* approve(peer, direct.url, clientId, resource, sendViaAlias);
      expect(fallback.origin + fallback.pathname).toBe(redirect);
      expect(fallback.searchParams.get("iss")).toBe(direct.url);
      expect(fallback.searchParams.get("state")).toBe("p1b-state");
      const code = fallback.searchParams.get("code")!;
      expect(code).toBeTruthy();
      const redeemed = yield* redeem(direct.url, clientId, code, resource, sendViaAlias);
      expect(redeemed.status).toBe(200);
      const issued = decodeToken(redeemed.body);
      expect(issued.scope).toBe("orchestration:read");

      const directSession = yield* initialize(direct.url, issued.access_token);
      expect(directSession.status).toBe(200);
      const aliasSession = yield* initialize(direct.url, issued.access_token, sendViaAlias);
      expect(aliasSession.status).toBe(200);
      expect((yield* initialize(differentBinding.url, issued.access_token)).status).toBe(401);
      const sessionId = aliasSession.headers["mcp-session-id"];
      if (typeof sessionId !== "string") throw new Error("Expected an MCP session ID");
      expect(
        (yield* mcp(
          direct.url,
          issued.access_token,
          "notifications/initialized",
          undefined,
          sessionId,
          sendViaAlias,
        )).status,
      ).toBe(202);
      const probed = yield* mcp(
        direct.url,
        issued.access_token,
        "tools/call",
        { name: "probe", arguments: {} },
        sessionId,
        sendViaAlias,
      );
      expect(probed.status).toBe(200);
      expect(probed.body).toContain(
        JSON.stringify({ access: "read-only", linked: true, origin: direct.url }).slice(0, -1),
      );

      expect((yield* initialize(other.url, issued.access_token)).status).toBe(401);
      const sessions = yield* peer.auth.listSessions();
      expect(sessions).toHaveLength(1);
      yield* peer.auth.revokeSession(sessions[0]!.sessionId);
      for (const request of [send, sendViaAlias]) {
        expect((yield* initialize(direct.url, issued.access_token, request)).status).toBe(401);
      }
    }),
);

it.live("checks the authorization resource independently at approval and code redemption", () =>
  Effect.gen(function* () {
    const peer = yield* serveDestination("environment-p1b-resource");
    const direct = yield* serveProofIngress(peer.url);
    const alias = yield* serveProofIngress(peer.url, direct.url);
    const differentBinding = yield* serveProofIngress(peer.url);
    const clientId = yield* register(direct.url);
    const resource = direct.url + "/mcp";
    const aliasResource = alias.url + "/mcp";

    const wrongApproval = yield* approve(peer, alias.url, clientId, aliasResource);
    expect(wrongApproval.searchParams.get("error")).toBe("invalid_target");
    expect(wrongApproval.searchParams.has("code")).toBe(false);

    const forWrongResource = yield* approve(peer, direct.url, clientId, resource);
    const wrongResource = yield* redeem(
      alias.url,
      clientId,
      forWrongResource.searchParams.get("code")!,
      aliasResource,
    );
    expect(wrongResource.status).toBe(400);
    expect(JSON.parse(wrongResource.body)).toMatchObject({ error: "invalid_grant" });

    const forWrongBinding = yield* approve(peer, direct.url, clientId, resource);
    const wrongBinding = yield* redeem(
      differentBinding.url,
      clientId,
      forWrongBinding.searchParams.get("code")!,
      differentBinding.url + "/mcp",
    );
    expect(wrongBinding.status).toBe(400);
    expect(JSON.parse(wrongBinding.body)).toMatchObject({ error: "invalid_grant" });

    const forAlias = yield* approve(peer, direct.url, clientId, resource);
    expect(
      (yield* redeem(alias.url, clientId, forAlias.searchParams.get("code")!, resource)).status,
    ).toBe(200);
  }),
);

const tls = {
  cert: NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
  key: NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url)),
};
const tunnelTls = {
  cert: NodeFS.readFileSync(
    new URL("../relay/fixtures/p1b-ingress-client-cert.pem", import.meta.url),
  ),
  key: NodeFS.readFileSync(
    new URL("../relay/fixtures/p1b-ingress-client-key.pem", import.meta.url),
  ),
};

const serveAdmittedAlias = Effect.fn("PeerRelayOAuthTest.serveAdmittedAlias")(function* (
  backend: NodeHttp.Server,
  canonicalOrigin: string,
  environmentId: EnvironmentId,
  homeDirectory: string,
) {
  const publicServer = NodeHttps.createServer(tls);
  const listenerOrigin = yield* serveLoopback(publicServer);
  const aliasOrigin = listenerOrigin.replace("127.0.0.1", "localhost");
  const context = yield* Layer.build(
    Forwarding.layer([
      {
        environmentId,
        publicOrigin: aliasOrigin,
        canonicalOrigin,
        environmentFingerprint: new NodeCrypto.X509Certificate(tunnelTls.cert).fingerprint256,
        tunnelTls: { ...tls, ca: tunnelTls.cert },
        listen: { host: "127.0.0.1", port: 0 },
      },
    ]).pipe(Layer.provideMerge(Runtime.relayRuntimeLayer({ homeDirectory }))),
  );
  const relay = Context.get(context, Runtime.RelayRuntime);
  const forwarding = Context.get(context, Forwarding.RelayForwarding);
  const owner = yield* relay.bootstrapOwner();
  yield* relay.enrollEnvironment(owner.credential, { version: 1, environmentId, name: "Peer" });
  const issue = Effect.fn("PeerRelayOAuthTest.issueRelaySession")(function* (
    kind: "client" | "publisher",
  ) {
    const pairing = yield* relay.issuePairing(owner.credential, {
      version: 1,
      subject: kind === "client" ? { kind } : { kind, environmentId },
      scope: {
        permissions: [kind === "client" ? "forward" : "environment.tunnel"],
        environments: { kind: "selected", environmentIds: [environmentId] },
      },
      expiresAt: "2099-01-01T00:00:00Z",
    });
    return yield* relay.redeemPairing(pairing.credential);
  });
  const publisher = yield* issue("publisher");
  const lease = yield* forwarding.openPublisher(publisher.credential, environmentId);
  const incoming = yield* Queue.unbounded<{
    request: NodeHttp.IncomingMessage;
    response: NodeHttp.ServerResponse;
  }>();
  publicServer.on("request", (request, response) => {
    Queue.offerUnsafe(incoming, { request, response });
  });
  yield* Effect.gen(function* () {
    const { request, response } = yield* Queue.take(incoming);
    const credential =
      request.headers["proxy-authorization"]?.match(/^Bearer ([^ ]+)$/u)?.[1] ?? "";
    yield* forwarding.forward(credential, environmentId, { kind: "http", request, response }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (!response.destroyed) {
            const status = error._tag === "RelayAuthenticationError" ? 401 : 503;
            response.writeHead(status).end();
          }
        }),
      ),
    );
  }).pipe(Effect.forever, Effect.forkScoped);
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      connectStaticRelayTunnel({
        relay: {
          ...tunnelTls,
          host: "127.0.0.1",
          port: lease.address.port,
          servername: "localhost",
          ca: tls.cert,
        },
        relayFingerprint: new NodeCrypto.X509Certificate(tls.cert).fingerprint256,
        publicOrigin: aliasOrigin,
        canonicalOrigin,
        backend,
      }),
    ),
    (tunnel) => Effect.sync(() => tunnel.close()),
  );
  yield* lease.ready;
  return {
    aliasOrigin,
    issueClient: () => issue("client"),
    revoke: (session: typeof publisher) => relay.revokeSession(owner.credential, session.sessionId),
  };
});

it.live("preserves canonical peer OAuth and MCP across independent P3 relay admission", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "peer-relay-oauth-" });
    const listener = NodeHttp.createServer();
    const backend = NodeHttp.createServer((request, response) => {
      listener.emit("request", request, response);
    });
    const server = yield* Layer.build(
      NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 }),
    );
    const destination = descriptorOf("environment-enrolled-peer", "Enrolled peer");
    const oauthRequests: Array<{ path: string; external: string | undefined }> = [];
    const mcpRequests: Array<{ session: string | undefined; external: string | undefined }> = [];
    let directAvailable = true;
    let directAuthority: string | undefined;
    let wrongAuthority: string | undefined;
    const misboundRequests: string[] = [];
    let wrongKeyRequests = 0;
    let leakedRelayHeaders = 0;
    let dropMutationResponse = false;
    let mutations = 0;
    const mutationTool = Toolkit.make(
      Tool.make("mutate", {
        description: "Records one destination mutation.",
        success: Probe,
        failure: OrchestratorMcpFailure,
        failureMode: "return",
        dependencies: [
          McpInvocationContext.McpInvocationContext,
          ThreadManagement.ThreadManagementService,
        ],
      }),
    );
    const mutationTools = McpHttpServer.toolkitRegistration(
      mutationTool,
      McpToolAccess.toLayer(mutationTool, {
        mutate: McpToolAccess.writes(
          () =>
            Effect.sync(() => {
              mutations++;
              return { access: "auto", linked: true, origin: "", modes: "" };
            }),
          { linkedCallers: "allowed" },
        ),
      }),
    ).pipe(Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})));
    const peer = yield* servePeer(destination, Layer.merge(tools, mutationTools), {
      before: (request) => {
        const external = relayExternalOrigin(request);
        const relayHeader = request.headers["proxy-authorization"];
        if (relayHeader !== undefined) leakedRelayHeaders++;
        if (
          external === undefined &&
          request.headers.host === directAuthority &&
          !directAvailable
        ) {
          return HttpServerResponse.empty({ status: 503 });
        }
        if (request.headers.host === wrongAuthority) misboundRequests.push(request.url);
        if (request.method === "POST" && request.url.startsWith(oauth)) {
          oauthRequests.push({ path: request.url, external });
        }
        if (request.url === "/mcp") {
          mcpRequests.push({ session: request.headers["mcp-session-id"], external });
        }
      },
      after: (request, response) => {
        if (request.url === oauth + "/decision" && response.status === 200) directAvailable = false;
        if (request.url === "/mcp" && dropMutationResponse && mutations === 1) {
          dropMutationResponse = false;
          return HttpServerResponse.empty({ status: 404 });
        }
        return response;
      },
    }).pipe(Effect.provideContext(server));
    const direct = yield* serveProofIngress(peer.url);
    directAuthority = new URL(direct.url).host;
    const relay = yield* serveAdmittedAlias(
      backend,
      direct.url,
      destination.environmentId,
      `${dir}/relay`,
    );
    const { aliasOrigin } = relay;
    const grant = yield* relay.issueClient();
    const relayCredentialPath = `${dir}/client.credential`;
    yield* fs.writeFileString(relayCredentialPath, grant.credential, { mode: 0o600 });
    const wrongAudience = yield* serveProofIngress(peer.url);
    wrongAuthority = new URL(wrongAudience.url).host;
    const wrongKey = yield* serveLoopback(
      NodeHttps.createServer(tls, (_request, response) => {
        wrongKeyRequests++;
        response.writeHead(503).end();
      }),
    );
    const cert = new NodeCrypto.X509Certificate(tls.cert);
    const spkiSha256 = NodeCrypto.createHash("sha256")
      .update(cert.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url");

    const config = ConfigProvider.fromEnv({
      env: {
        T3CODE_PEER_ENROLLMENTS: JSON.stringify([
          {
            environmentId: destination.environmentId,
            canonicalOrigin: direct.url,
            routes: [
              { origin: direct.url, spkiSha256 },
              {
                origin: wrongKey,
                spkiSha256: Buffer.alloc(32).toString("base64url"),
                relayCredentialPath,
              },
              { origin: wrongAudience.url, spkiSha256 },
              { origin: aliasOrigin, spkiSha256, relayCredentialPath },
            ].map((route) => ({ ...route, caPem: tls.cert.toString() })),
          },
        ]),
      },
    });
    const loadAliasSender = Effect.fn("PeerRelayOAuthTest.loadAliasSender")(function* () {
      const [enrollment] = yield* PeerEnrollment.load.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, config),
      );
      return senderFor(
        enrollment!.routes.find((route) => route.url === aliasOrigin)!.transport.httpClient,
      );
    });
    const context = yield* layerLinkingEnvironment(
      descriptorOf("environment-enrolling-peer", "Caller"),
    ).pipe(Layer.provide(ConfigProvider.layer(config)), Layer.build);
    const links = Context.get(context, PeerLinks.PeerLinks);
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    const pairing = yield* peer.auth.issuePairingCredential();
    yield* links.link({ url: direct.url, pairingCode: pairing.credential, access: "auto" });
    expect(oauthRequests).toEqual([
      { path: oauth + "/register", external: undefined },
      { path: oauth + "/decision", external: undefined },
      { path: oauth + "/token", external: aliasOrigin },
    ]);

    const call = (tool: string, readOnly = false) =>
      client.call({
        environmentId: destination.environmentId,
        tool,
        readOnly,
        arguments: {},
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        success: Probe,
      });
    directAvailable = true;
    expect(yield* call("probe", true)).toEqual({
      access: "auto",
      linked: true,
      origin: direct.url,
      modes: "approval-required/plan",
    });
    directAvailable = false;
    expect(yield* call("probe", true)).toEqual({
      access: "auto",
      linked: true,
      origin: aliasOrigin,
      modes: "approval-required/plan",
    });
    expect(mcpRequests.filter((request) => request.session === undefined)).toEqual([
      { session: undefined, external: undefined },
      { session: undefined, external: aliasOrigin },
    ]);

    expect((yield* links.list)[0]?.status).toBe("reachable");
    const token = (yield* links.resolve(destination.environmentId)).token;
    expect(wrongKeyRequests).toBe(0);
    expect(misboundRequests).toContain(metadataPathForMcp);
    expect(misboundRequests.every((path) => path.startsWith("/.well-known/"))).toBe(true);
    expect((yield* initialize(wrongAudience.url, token)).status).toBe(401);

    dropMutationResponse = true;
    const beforeMutation = mcpRequests.length;
    expect(yield* Effect.result(call("mutate"))).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("outcome is unknown") },
    });
    expect(mutations).toBe(1);
    expect(mcpRequests).toHaveLength(beforeMutation + 1);
    const sendViaAlias = yield* loadAliasSender();
    const onlyRelayGrant = yield* initialize(direct.url, "", sendViaAlias);
    expect(onlyRelayGrant.status).toBe(401);
    expect(onlyRelayGrant.headers["www-authenticate"]).toContain(direct.url);

    const beforeRelayDenial = mcpRequests.length;
    yield* relay.revoke(grant);
    const onlyDestinationGrant = yield* initialize(direct.url, token, sendViaAlias);
    expect(onlyDestinationGrant.status).toBe(401);
    expect(onlyDestinationGrant.headers["www-authenticate"]).toBeUndefined();
    expect(mcpRequests).toHaveLength(beforeRelayDenial);

    directAvailable = true;
    expect((yield* initialize(direct.url, token)).status).toBe(200);
    expect(yield* call("probe", true)).toMatchObject({ origin: direct.url });
    expect((yield* links.resolve(destination.environmentId)).token).toBe(token);

    const replacement = yield* relay.issueClient();
    yield* fs.writeFileString(relayCredentialPath, replacement.credential, { mode: 0o600 });
    const rotatedSender = yield* loadAliasSender();
    expect((yield* initialize(direct.url, token, rotatedSender)).status).toBe(200);
    expect(leakedRelayHeaders).toBe(0);

    const sessions = yield* peer.linkedSessions;
    expect(sessions).toHaveLength(1);
    yield* peer.auth.revokeSession(sessions[0]!.sessionId);
    for (const request of [send, rotatedSender]) {
      expect((yield* initialize(direct.url, token, request)).status).toBe(401);
    }
    expect(yield* Effect.result(call("probe", true))).toMatchObject({
      _tag: "Failure",
      failure: { code: "capability_denied" },
    });
    directAvailable = false;
    const aliasContext = yield* layerLinkingEnvironment(
      descriptorOf("alias-approved-caller", "Alias caller"),
    ).pipe(Layer.provide(ConfigProvider.layer(config)), Layer.build);
    const aliasLinks = Context.get(aliasContext, PeerLinks.PeerLinks);
    const aliasClient = Context.get(aliasContext, PeerMcpClient.PeerMcpClient);
    const aliasPairing = yield* peer.auth.issuePairingCredential();
    yield* aliasLinks.link({
      url: aliasOrigin,
      pairingCode: aliasPairing.credential,
      access: "auto",
    });
    directAvailable = true;
    expect(
      yield* aliasClient.call({
        environmentId: destination.environmentId,
        tool: "probe",
        readOnly: true,
        arguments: {},
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        success: Probe,
      }),
    ).toMatchObject({ origin: direct.url });
  }).pipe(Effect.provide(NodeServices.layer)),
);
