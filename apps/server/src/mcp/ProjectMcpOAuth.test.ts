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
const decodePendingRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      authorizationUrl: Schema.optional(Schema.String),
      scope: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
    }),
  ),
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

it.effect("does not return a grant bound to a replaced resource", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const replacementResource = "https://replacement.example.test/mcp";
    const prepared = yield* secrets.prepareCreate(serverId, {
      type: "streamable-http",
      url: resource,
      headers: [],
      authorization: { type: "oauth", registration: { type: "automatic" } },
    });
    yield* prepared.commit;
    const oauth = yield* ProjectMcpOAuth.ProjectMcpOAuth;
    const providerForOriginal = yield* oauth.providerFor(serverId, { serverId, resource });
    yield* Effect.promise(() =>
      Promise.resolve(
        providerForOriginal.saveTokens(
          { access_token: "original-resource-token", token_type: "Bearer" },
          { issuer: "https://issuer.example.test" },
        ),
      ),
    );

    const providerForReplacement = yield* oauth.providerFor(serverId, {
      serverId,
      resource: replacementResource,
    });

    assert.isUndefined(
      yield* Effect.promise(() => Promise.resolve(providerForReplacement.tokens())),
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        ProjectMcpOAuth.layer({ servers: [], fetch: fetchOAuthFixture }).pipe(
          Layer.provideMerge(secretLayer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("retires an older grant for the same resource after its replacement is durable", () =>
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
    const provider = yield* oauth.providerFor(serverId, { serverId, resource });
    yield* Effect.promise(async () => {
      await provider.saveTokens(
        { access_token: "first-token", token_type: "Bearer" },
        { issuer: "https://issuer.example.test" },
      );
    });
    yield* Effect.promise(async () => {
      await provider.saveTokens(
        { access_token: "replacement-token", token_type: "Bearer" },
        { issuer: "https://issuer.example.test" },
      );
    });

    assert.lengthOf(yield* secrets.listAuxiliarySecrets(serverId), 1);
  }).pipe(
    Effect.provide(
      Layer.merge(
        ProjectMcpOAuth.layer({ servers: [], fetch: fetchOAuthFixture }).pipe(
          Layer.provideMerge(secretLayer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("persists headless step-up authorization for callback recovery", () =>
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
    const initialCallbackUrl = new URL("https://t3.example.test/oauth/project-mcp/callback");
    initialCallbackUrl.searchParams.set(
      "state",
      new URL(started.authorizationUrl).searchParams.get("state")!,
    );
    initialCallbackUrl.searchParams.set("code", "initial-code");
    initialCallbackUrl.searchParams.set("iss", "https://issuer.example.test");
    assert.equal(
      (yield* oauth.completeCallback(new Request(initialCallbackUrl.toString()))).status,
      200,
    );

    const provider = yield* oauth.providerFor(serverId);
    yield* Effect.promise(async () => {
      await provider.saveCodeVerifier("v".repeat(48));
    });
    const stepUpAuthorizationUrl = new URL("https://issuer.example.test/authorize");
    stepUpAuthorizationUrl.searchParams.set("state", "step-up-state");
    stepUpAuthorizationUrl.searchParams.set("scope", "mcp:read mcp:write");
    yield* Effect.promise(async () => {
      await provider.redirectToAuthorization(stepUpAuthorizationUrl);
    });

    const pendingIds = yield* secrets.listAuxiliarySecrets(serverId);
    const pendingRecord = decodePendingRecord(yield* secrets.resolve(serverId, pendingIds.at(-1)!));
    assert.equal(pendingRecord.authorizationUrl, stepUpAuthorizationUrl.toString());
    assert.equal(pendingRecord.scope, "mcp:read mcp:write");
    assert.equal(pendingRecord.state, "step-up-state");
    const continued = yield* oauth.continuePending(serverId);
    assert.equal(continued.authorizationUrl, stepUpAuthorizationUrl.toString());
    assert.isTrue(continued.expiresAt.length > 0);

    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: fetchOAuthFixture,
    });
    const restartedContinuation = yield* restarted.continuePending(serverId);
    assert.equal(restartedContinuation.authorizationUrl, stepUpAuthorizationUrl.toString());
    assert.isTrue(restartedContinuation.expiresAt.length > 0);
    const stepUpCallbackUrl = new URL("https://t3.example.test/oauth/project-mcp/callback");
    stepUpCallbackUrl.searchParams.set("state", "step-up-state");
    stepUpCallbackUrl.searchParams.set("code", "step-up-code");
    stepUpCallbackUrl.searchParams.set("iss", "https://issuer.example.test");
    assert.equal(
      (yield* restarted.completeCallback(new Request(stepUpCallbackUrl.toString()))).status,
      200,
    );
    assert.equal(yield* restarted.status(serverId), "connected");

    const completedIds = yield* secrets.listAuxiliarySecrets(serverId);
    const completedRecord = decodePendingRecord(
      yield* secrets.resolve(serverId, completedIds.at(-1)!),
    );
    assert.isUndefined(completedRecord.authorizationUrl);
    assert.isUndefined(completedRecord.scope);
    assert.isUndefined(completedRecord.state);
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
