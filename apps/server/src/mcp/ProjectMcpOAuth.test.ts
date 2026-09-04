import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { McpServerId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectMcpOAuth from "./ProjectMcpOAuth.ts";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const serverId = McpServerId.make("oauth-test-server");
const resource = "https://mcp.example.test/rpc";
const fetchOAuthFixture: FetchLike = async (input: string | Request | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/.well-known/oauth-protected-resource")) {
    return Response.json({
      resource,
      authorization_servers: ["https://issuer.example.test"],
    });
  }
  if (url.endsWith("/.well-known/oauth-authorization-server")) {
    return Response.json({
      issuer: "https://issuer.example.test",
      authorization_endpoint: "https://issuer.example.test/authorize",
      token_endpoint: "https://issuer.example.test/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.endsWith("/token")) {
    const body = new URLSearchParams(init?.body as string);
    assert.isTrue((body.get("code_verifier")?.length ?? 0) > 40);
    return Response.json({
      access_token: "opaque-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }
  return new Response(null, { status: 404 });
};
const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const secretLayer = ProjectMcpSecretStore.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-mcp-oauth-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(cryptoLayer),
);
const decodePersistedRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ redirectUrl: Schema.optional(Schema.String) })),
);

it.effect("begins and completes an authorization-code flow with an in-process authority", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const prepared = yield* secrets.prepareCreate(serverId, {
      type: "streamable-http",
      url: resource,
      headers: [],
      authorization: { type: "oauth", registration: { type: "automatic" } },
    });
    yield* prepared.commit;
    const oauth = yield* ProjectMcpOAuth.ProjectMcpOAuth;
    const started = yield* oauth.begin({ serverId });
    const authorization = new URL(started.authorizationUrl);
    assert.equal(yield* oauth.status(serverId), "authorization-pending");
    assert.equal(authorization.searchParams.get("resource"), resource);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const persistedIds = yield* secrets.listAuxiliarySecrets(serverId);
    const persisted = decodePersistedRecord(yield* secrets.resolve(serverId, persistedIds[0]!));
    assert.equal(persisted.redirectUrl, "http://127.0.0.1/oauth/project-mcp/callback");
    const superseding = yield* oauth.begin({ serverId });
    const staleCallbackUrl = new URL("https://t3.example.test/oauth/project-mcp/callback");
    staleCallbackUrl.searchParams.set("state", authorization.searchParams.get("state")!);
    staleCallbackUrl.searchParams.set("code", "stale-code");
    const staleCallback = yield* oauth.completeCallback(new Request(staleCallbackUrl.toString()));
    assert.equal(staleCallback.status, 400);
    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: fetchOAuthFixture,
    });
    const callbackUrl = new URL("https://t3.example.test/oauth/project-mcp/callback");
    callbackUrl.searchParams.set(
      "state",
      new URL(superseding.authorizationUrl).searchParams.get("state")!,
    );
    callbackUrl.searchParams.set("code", "one-time-code");
    callbackUrl.searchParams.set("iss", "https://issuer.example.test");
    const callback = yield* restarted.completeCallback(new Request(callbackUrl.toString()));
    assert.equal(callback.status, 200);
    assert.equal(yield* oauth.status(serverId), "connected");
    const second = yield* restarted.completeCallback(new Request(callbackUrl.toString()));
    assert.equal(second.status, 400);
    yield* oauth.disconnect(serverId);
    assert.equal(yield* oauth.status(serverId), "not-connected");
  }).pipe(
    Effect.provide(
      Layer.merge(
        ProjectMcpOAuth.layer({
          servers: [
            {
              serverId,
              resource,
              authorizationServers: ["https://issuer.example.test"],
              clientId: "registered-client",
            },
          ],
          fetch: fetchOAuthFixture,
        }).pipe(Layer.provideMerge(secretLayer)),
        NodeServices.layer,
      ),
    ),
  ),
);
