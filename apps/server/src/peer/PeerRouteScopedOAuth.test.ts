// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build the fixture PKCE challenge at module load.
import * as NodeCrypto from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  AuthMcpApprovalRedirect,
  AuthMcpRegisteredClient,
  AuthMcpTokenResult,
  MCP_PEER_LINK_SOFTWARE_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { proofRequest, serveProofIngress } from "../relay/fixtures/p1bIngress.testkit.ts";
import { descriptorOf, servePeer, type ServedPeer } from "./PeerLinks.testkit.ts";

const redirectUri = "http://127.0.0.1/t3code-peer-link";
const verifier = "p".repeat(43);
const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpRegisteredClient));
const decodeApproval = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpApprovalRedirect));
const decodeToken = Schema.decodeUnknownSync(Schema.fromJsonString(AuthMcpTokenResult));

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.promise(() =>
    proofRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const postToken = (route: string, fields: Record<string, string>) =>
  Effect.promise(() =>
    proofRequest(route + "/oauth/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  );

const approveAndRedeem = (peer: ServedPeer, route: string) =>
  Effect.gen(function* () {
    const metadata = yield* Effect.promise(() =>
      proofRequest(route + "/.well-known/oauth-protected-resource/mcp"),
    );
    const resource = route + "/mcp";
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toMatchObject({ resource, authorization_servers: [route] });
    const issuerMetadata = yield* Effect.promise(() =>
      proofRequest(route + "/.well-known/oauth-authorization-server"),
    );
    expect(issuerMetadata.status).toBe(200);
    expect(JSON.parse(issuerMetadata.body)).toMatchObject({
      issuer: route,
      authorization_endpoint: route + "/oauth/mcp/authorize",
      registration_endpoint: route + "/oauth/mcp/register",
      token_endpoint: route + "/oauth/mcp/token",
      grant_types_supported: ["authorization_code"],
    });
    const registration = yield* postJson(route + "/oauth/mcp/register", {
      client_name: "P1b route reapproval",
      redirect_uris: [redirectUri],
      software_id: MCP_PEER_LINK_SOFTWARE_ID,
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = decodeRegistration(registration.body);
    const pairing = yield* peer.auth.issuePairingCredential();
    const approval = yield* postJson(route + "/oauth/mcp/decision", {
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
      },
      decision: { _tag: "pairing-code", access: "read-only", code: pairing.credential },
    });
    expect(approval.status).toBe(200);
    const callback = new URL(decodeApproval(approval.body).redirectTo);
    expect(callback.searchParams.get("iss")).toBe(route);
    const code = callback.searchParams.get("code");
    if (code === null) throw new Error("Expected an authorization code");
    const token = yield* postToken(route, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    });
    expect(token.status).toBe(200);
    return decodeToken(token.body);
  });

const initialize = (route: string, token: string) =>
  postJson(
    route + "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "p1b-route-reapproval", version: "1" },
      },
    },
    { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
  );

it.live("rejects failover token exchange and issues the same scope after reapproval", () =>
  Effect.gen(function* () {
    const http = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    const peer = yield* servePeer(
      descriptorOf("p1b-route-reapproval", "P1b route reapproval"),
      Layer.empty,
    ).pipe(Effect.provideContext(http));
    const direct = yield* serveProofIngress(peer.url);
    const failover = yield* serveProofIngress(peer.url);

    const issued = yield* approveAndRedeem(peer, direct.url);
    expect(issued.scope).toBe("orchestration:read");
    expect((yield* initialize(direct.url, issued.access_token)).status).toBe(200);
    expect((yield* initialize(failover.url, issued.access_token)).status).toBe(401);

    const exchange = yield* postToken(failover.url, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      resource: failover.url + "/mcp",
    });
    expect(exchange.status).toBe(400);
    expect(JSON.parse(exchange.body)).toMatchObject({ error: "unsupported_grant_type" });

    const sessions = yield* peer.auth.listSessions();
    expect(sessions).toHaveLength(1);
    yield* peer.auth.revokeSession(sessions[0]!.sessionId);
    expect((yield* initialize(direct.url, issued.access_token)).status).toBe(401);
    expect((yield* initialize(failover.url, issued.access_token)).status).toBe(401);

    const reapproved = yield* approveAndRedeem(peer, failover.url);
    expect(reapproved.scope).toBe(issued.scope);
    expect((yield* initialize(failover.url, reapproved.access_token)).status).toBe(200);
    expect((yield* initialize(failover.url, issued.access_token)).status).toBe(401);
  }),
);
