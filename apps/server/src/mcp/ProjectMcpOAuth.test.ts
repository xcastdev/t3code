import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { auth, type FetchLike } from "@modelcontextprotocol/client";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { McpServerId, ProjectMcpCredentialId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectMcpOAuth from "./ProjectMcpOAuth.ts";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const serverId = McpServerId.make("oauth-test-server");
const resource = "https://mcp.example.test/rpc";

for (const clientSecret of ["leased-client-secret", undefined]) {
  it.effect(
    `resolves a pre-registered binding with cached secret ${clientSecret !== undefined}`,
    () =>
      Effect.gen(function* () {
        const credentialId = ProjectMcpCredentialId.make("018f6d7a-8b9c-7def-8123-456789abcdef");
        const resolved = yield* ProjectMcpOAuth.resolveServerBinding(
          {
            id: serverId,
            transport: {
              type: "streamable-http",
              url: resource,
              headers: [],
              authorization: {
                type: "oauth",
                registration: {
                  type: "pre-registered",
                  clientId: "registered-client",
                  clientSecret: { id: credentialId, name: "client secret" },
                },
              },
            },
          },
          (owner, credential) => {
            assert.equal(owner, serverId);
            assert.equal(credential, credentialId);
            return Effect.succeed(clientSecret);
          },
        );
        assert.deepEqual(resolved, {
          serverId,
          resource,
          clientId: "registered-client",
          ...(clientSecret === undefined ? {} : { clientSecret }),
        });
      }),
  );
}

it.effect("resolves automatic registration without reading a client secret", () =>
  Effect.gen(function* () {
    const resolved = yield* ProjectMcpOAuth.resolveServerBinding(
      {
        id: serverId,
        transport: {
          type: "legacy-sse",
          url: resource,
          headers: [],
          authorization: { type: "oauth", registration: { type: "automatic" } },
        },
      },
      () => Effect.die("Automatic registration must not resolve a client secret"),
    );
    assert.deepEqual(resolved, { serverId, resource });
  }),
);

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
const fetchRegistrationFixture: FetchLike = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/.well-known/oauth-authorization-server")) {
    return Response.json({
      issuer: "https://issuer.example.test",
      authorization_endpoint: "https://issuer.example.test/authorize",
      token_endpoint: "https://issuer.example.test/token",
      registration_endpoint: "https://issuer.example.test/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.endsWith("/register"))
    return Response.json({
      client_id: "dynamic-client",
      redirect_uris: ["http://127.0.0.1/oauth/project-mcp/callback"],
    });
  return fetchOAuthFixture(input, init);
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

const fixtureServer = {
  serverId,
  resource,
  clientId: "registered-client",
};
const encodeLegacyRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const formValue = (value: string) => new URLSearchParams({ value }).toString().slice(6);
const oversizedAuthorizationUrl = (state = "oversized-state") => {
  const url = new URL("https://issuer.example.test/authorize");
  url.searchParams.set("state", state);
  url.searchParams.set("padding", "x".repeat(4_096));
  assert.isTrue(url.toString().length > 4_096);
  return url;
};

it.effect("accepts loopback IPv6 and HTTPS browser callback origins", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    for (const [origin, expected] of [
      ["http://[::1]:43210", "http://[::1]:43210/oauth/project-mcp/callback"],
      ["http://127.0.0.1:43210", "http://127.0.0.1:43210/oauth/project-mcp/callback"],
      ["http://localhost:43210", "http://localhost:43210/oauth/project-mcp/callback"],
    ] as const) {
      const started = yield* oauth.begin({ serverId, redirectOrigin: origin });
      assert.equal(new URL(started.authorizationUrl).searchParams.get("redirect_uri"), expected);
    }

    const automatic = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: async (input, init) => {
        const response = await fetchOAuthFixture(input, init);
        if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            ...decodeObject(await response.json()),
            client_id_metadata_document_supported: true,
          });
        }
        return response;
      },
    });
    const started = yield* automatic.begin({
      serverId,
      server: { serverId, resource },
      redirectOrigin: "https://tunnel.example.test",
    });
    assert.equal(
      new URL(started.authorizationUrl).searchParams.get("redirect_uri"),
      "https://tunnel.example.test/oauth/project-mcp/callback",
    );
    assert.equal(
      new URL(started.authorizationUrl).searchParams.get("client_id"),
      "https://tunnel.example.test/oauth/project-mcp/client-metadata",
    );
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects unsafe browser callback origins before changing pending state", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const started = yield* oauth.begin({
      serverId,
      redirectOrigin: "https://correct.example.test",
    });
    for (const redirectOrigin of [
      "http://192.168.1.50:3773",
      "https://correct.example.test/callback",
      "https://user:pass@correct.example.test",
      "https://correct.example.test?unsafe=1",
      "not a URL",
    ]) {
      const error = yield* Effect.flip(oauth.begin({ serverId, redirectOrigin }));
      assert.equal(error.operation, "resolve redirect");
      assert.equal(
        (yield* oauth.continuePending(serverId)).authorizationUrl,
        started.authorizationUrl,
      );
    }
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects an unknown callback without scanning persisted OAuth records", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const persistedServerIds = [
      serverId,
      McpServerId.make("oauth-test-server-other-a"),
      McpServerId.make("oauth-test-server-other-b"),
    ];
    for (const persistedServerId of persistedServerIds) {
      const prepared = yield* secrets.prepareCreate(persistedServerId, {
        type: "streamable-http",
        url: `https://${persistedServerId}.example.test/rpc`,
        headers: [],
        authorization: { type: "oauth", registration: { type: "automatic" } },
      });
      yield* prepared.commit;
      yield* secrets.createAuxiliarySecret(
        persistedServerId,
        encodeLegacyRecord({
          kind: "project-mcp-oauth",
          serverId: persistedServerId,
          resource: `https://${persistedServerId}.example.test/rpc`,
          registration: {},
          state: "known-state",
          // @effect-diagnostics-next-line globalDateInEffect:off
          expiresAt: Date.now() + 60_000,
        }),
      );
    }

    let listServerIdsReads = 0;
    let auxiliaryReads = 0;
    let valueReads = 0;
    let tokenExchanges = 0;
    const countedSecrets: ProjectMcpSecretStore.ProjectMcpSecretStoreShape = {
      ...secrets,
      listServerIds: () =>
        Effect.gen(function* () {
          listServerIdsReads++;
          return yield* secrets.listServerIds();
        }),
      listAuxiliarySecrets: (id) =>
        Effect.gen(function* () {
          auxiliaryReads++;
          return yield* secrets.listAuxiliarySecrets(id);
        }),
      resolve: (id, credentialId) =>
        Effect.gen(function* () {
          valueReads++;
          return yield* secrets.resolve(id, credentialId);
        }),
    };
    const oauth = yield* ProjectMcpOAuth.__testing
      .make({
        servers: [fixtureServer],
        fetch: async (input, init) => {
          if (String(input).endsWith("/token")) tokenExchanges++;
          return fetchOAuthFixture(input, init);
        },
      })
      .pipe(Effect.provideService(ProjectMcpSecretStore.ProjectMcpSecretStore, countedSecrets));

    listServerIdsReads = 0;
    auxiliaryReads = 0;
    valueReads = 0;
    tokenExchanges = 0;
    const response = yield* oauth.completeCallback(
      new Request("https://t3.example.test/oauth/project-mcp/callback?state=unknown&code=unknown"),
    );

    assert.equal(response.status, 400);
    assert.equal(listServerIdsReads, 0);
    assert.equal(auxiliaryReads, 0);
    assert.equal(valueReads, 0);
    assert.equal(tokenExchanges, 0);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("uses the hydrated owner index for a valid restarted callback", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const otherServerId = McpServerId.make("oauth-test-server-restart-other");
    const otherPrepared = yield* secrets.prepareCreate(otherServerId, {
      type: "streamable-http",
      url: "https://oauth-test-server-restart-other.example.test/rpc",
      headers: [],
      authorization: { type: "oauth", registration: { type: "automatic" } },
    });
    yield* otherPrepared.commit;
    yield* secrets.createAuxiliarySecret(
      otherServerId,
      encodeLegacyRecord({
        kind: "project-mcp-oauth",
        serverId: otherServerId,
        resource: "https://oauth-test-server-restart-other.example.test/rpc",
        registration: {},
        state: "other-state",
        // @effect-diagnostics-next-line globalDateInEffect:off
        expiresAt: Date.now() + 60_000,
      }),
    );
    const started = yield* oauth.begin({ serverId });

    let listServerIdsReads = 0;
    let tokenExchanges = 0;
    const auxiliaryReadServerIds = new Set<McpServerId>();
    const countedSecrets: ProjectMcpSecretStore.ProjectMcpSecretStoreShape = {
      ...secrets,
      listServerIds: () =>
        Effect.gen(function* () {
          listServerIdsReads++;
          return yield* secrets.listServerIds();
        }),
      listAuxiliarySecrets: (id) =>
        Effect.gen(function* () {
          auxiliaryReadServerIds.add(id);
          return yield* secrets.listAuxiliarySecrets(id);
        }),
    };
    const restarted = yield* ProjectMcpOAuth.__testing
      .make({
        servers: [],
        fetch: async (input, init) => {
          if (String(input).endsWith("/token")) tokenExchanges++;
          return fetchOAuthFixture(input, init);
        },
      })
      .pipe(Effect.provideService(ProjectMcpSecretStore.ProjectMcpSecretStore, countedSecrets));

    listServerIdsReads = 0;
    auxiliaryReadServerIds.clear();
    tokenExchanges = 0;
    const response = yield* restarted.completeCallback(callbackRequest(started.authorizationUrl));

    assert.equal(response.status, 200);
    assert.equal(listServerIdsReads, 0);
    assert.deepEqual([...auxiliaryReadServerIds], [serverId]);
    assert.equal(tokenExchanges, 1);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("requires reconnect for legacy grants without a registration binding", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    yield* secrets.createAuxiliarySecret(
      serverId,
      encodeLegacyRecord({
        kind: "project-mcp-oauth",
        serverId,
        resource,
        issuer: "https://issuer.example.test",
        client: { client_id: "registered-client", issuer: "https://issuer.example.test" },
        tokens: {
          access_token: "legacy-token",
          token_type: "Bearer",
          issuer: "https://issuer.example.test",
        },
        generation: 1,
      }),
    );
    assert.equal(yield* oauth.status(serverId), "not-connected");
    for (const server of [fixtureServer, { serverId, resource }]) {
      const provider = yield* oauth.providerFor(serverId, server);
      assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
    }
    const started = yield* oauth.begin({ serverId });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    assert.equal(yield* oauth.status(serverId), "connected");
  }).pipe(Effect.provide(secretLayer)),
);
const prepareOAuth = Effect.fn(function* (
  config: Partial<ProjectMcpOAuth.ProjectMcpOAuthConfig> = {},
) {
  const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
  const prepared = yield* secrets.prepareCreate(serverId, {
    type: "streamable-http",
    url: resource,
    headers: [],
    authorization: { type: "oauth", registration: { type: "automatic" } },
  });
  yield* prepared.commit;
  return yield* ProjectMcpOAuth.__testing.make({
    servers: [fixtureServer],
    fetch: fetchOAuthFixture,
    ...config,
  });
});

for (const authorizationEndpoint of [
  "javascript:alert(1)",
  "data:text/html,hello",
  "file:///tmp/authorize",
] as const) {
  it.effect(`rejects an unsafe discovered authorization endpoint: ${authorizationEndpoint}`, () =>
    Effect.gen(function* () {
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const oauth = yield* prepareOAuth({
        fetch: async (input, init) => {
          const response = await fetchOAuthFixture(input, init);
          if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json({
              ...decodeObject(await response.json()),
              authorization_endpoint: authorizationEndpoint,
            });
          }
          return response;
        },
      });
      const error = yield* Effect.flip(oauth.begin({ serverId }));
      assert.instanceOf(error, ProjectMcpOAuth.ProjectMcpOAuthError);
      assert.isTrue(error.operation === "begin" || error.operation === "discover");
      assert.deepEqual(yield* secrets.listAuxiliarySecrets(serverId), []);
    }).pipe(Effect.provide(secretLayer)),
  );
}

it.effect("rejects an oversized discovered authorization endpoint before persisting", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const authorizationEndpoint = new URL("https://issuer.example.test/authorize");
    authorizationEndpoint.searchParams.set("padding", "x".repeat(4_096));
    assert.isTrue(authorizationEndpoint.toString().length > 4_096);
    const oauth = yield* prepareOAuth({
      fetch: async (input, init) => {
        const response = await fetchOAuthFixture(input, init);
        if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            ...decodeObject(await response.json()),
            authorization_endpoint: authorizationEndpoint.toString(),
          });
        }
        return response;
      },
    });
    const error = yield* Effect.flip(oauth.begin({ serverId }));
    assert.instanceOf(error, ProjectMcpOAuth.ProjectMcpOAuthError);
    assert.equal(error.operation, "begin");
    assert.deepEqual(yield* secrets.listAuxiliarySecrets(serverId), []);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects an unsafe OAuth step-up URL without persisting it", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const oauth = yield* prepareOAuth();
    const started = yield* oauth.begin({ serverId });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const provider = yield* oauth.providerFor(serverId);
    const result = yield* Effect.exit(
      Effect.promise(async () => {
        await provider.redirectToAuthorization(new URL("javascript:alert(1)?state=step-up"));
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    const ids = yield* secrets.listAuxiliarySecrets(serverId);
    const record = decodePendingRecord(yield* secrets.resolve(serverId, ids.at(-1)!));
    assert.isUndefined(record.authorizationUrl);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects an oversized OAuth step-up URL without persisting it", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const oauth = yield* prepareOAuth();
    const started = yield* oauth.begin({ serverId });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const provider = yield* oauth.providerFor(serverId);
    const idsBefore = yield* secrets.listAuxiliarySecrets(serverId);
    const before = decodePendingRecord(yield* secrets.resolve(serverId, idsBefore.at(-1)!));
    const result = yield* Effect.exit(
      Effect.promise(async () => {
        await provider.redirectToAuthorization(oversizedAuthorizationUrl("step-up-oversized"));
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    const idsAfter = yield* secrets.listAuxiliarySecrets(serverId);
    assert.deepEqual(idsAfter, idsBefore);
    const after = decodePendingRecord(yield* secrets.resolve(serverId, idsAfter.at(-1)!));
    assert.deepEqual(after, before);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects an unsafe authorization URL in legacy pending state", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    yield* prepareOAuth();
    yield* secrets.createAuxiliarySecret(
      serverId,
      encodeLegacyRecord({
        kind: "project-mcp-oauth",
        serverId,
        resource,
        registration: {},
        state: "unsafe-state",
        authorizationUrl: "data:text/html,hello",
        // @effect-diagnostics-next-line globalDateInEffect:off
        expiresAt: Date.now() + 60_000,
      }),
    );
    const oauth = yield* ProjectMcpOAuth.__testing.make({
      servers: [fixtureServer],
      fetch: fetchOAuthFixture,
    });
    const error = yield* Effect.flip(oauth.continuePending(serverId));
    assert.instanceOf(error, ProjectMcpOAuth.ProjectMcpOAuthError);
    assert.equal(error.operation, "continue authorization");
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("rejects an oversized authorization URL in legacy pending state", () =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    yield* prepareOAuth();
    const authorizationUrl = oversizedAuthorizationUrl().toString();
    assert.isTrue(authorizationUrl.length > 4_096);
    yield* secrets.createAuxiliarySecret(
      serverId,
      encodeLegacyRecord({
        kind: "project-mcp-oauth",
        serverId,
        resource,
        registration: {},
        state: "oversized-state",
        authorizationUrl,
        // @effect-diagnostics-next-line globalDateInEffect:off
        expiresAt: Date.now() + 60_000,
      }),
    );
    const pendingId = (yield* secrets.listAuxiliarySecrets(serverId)).at(-1)!;
    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [fixtureServer],
      fetch: fetchOAuthFixture,
    });
    const error = yield* Effect.flip(restarted.continuePending(serverId));
    assert.instanceOf(error, ProjectMcpOAuth.ProjectMcpOAuthError);
    assert.equal(error.operation, "continue authorization");
    const record = decodePendingRecord(yield* secrets.resolve(serverId, pendingId));
    assert.equal(record.authorizationUrl, authorizationUrl);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("retains bearer and refresh access through catalog removal for a live provider", () =>
  Effect.gen(function* () {
    let clock = 1_800_000_000_000;
    let exchanges = 0;
    const oauth = yield* prepareOAuth({
      now: () => clock,
      fetch: async (input, init) => {
        if (String(input).endsWith("/token")) {
          exchanges++;
          return Response.json({
            access_token: `grant-${exchanges}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-grant",
          });
        }
        return fetchOAuthFixture(input, init);
      },
    });
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const started = yield* oauth.begin({ serverId });
    const scope = yield* Scope.make();
    const stateLease = yield* secrets
      .acquireOAuthStateLease(serverId)
      .pipe(Effect.provideService(Scope.Scope, scope));
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );

    const provider = yield* oauth.providerFor(serverId, fixtureServer, stateLease);
    yield* secrets.removeServer(serverId);
    assert.equal((yield* Effect.promise(async () => provider.tokens()))?.access_token, "grant-1");
    clock += 3_600_001;
    assert.equal((yield* Effect.promise(async () => provider.tokens()))?.access_token, "grant-2");
    assert.equal(exchanges, 2);

    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(yield* secrets.listServerIds(), []);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("invalidates old OAuth providers immediately on explicit disconnect", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const started = yield* oauth.begin({ serverId });
    const scope = yield* Scope.make();
    const stateLease = yield* secrets
      .acquireOAuthStateLease(serverId)
      .pipe(Effect.provideService(Scope.Scope, scope));
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const oldProvider = yield* oauth.providerFor(serverId, fixtureServer, stateLease);

    yield* oauth.disconnect(serverId);
    assert.isUndefined(yield* Effect.promise(async () => oldProvider.tokens()));
    const staleWrite = yield* Effect.promise(async () => {
      try {
        await oldProvider.saveTokens({ access_token: "stale", token_type: "Bearer" });
        return false;
      } catch {
        return true;
      }
    });
    assert.isTrue(staleWrite);
    const reconnected = yield* oauth.providerFor(serverId, fixtureServer);
    assert.isUndefined(yield* Effect.promise(async () => reconnected.tokens()));
    yield* Scope.close(scope, Exit.void);
  }).pipe(Effect.provide(secretLayer)),
);

for (const method of ["client_secret_post", "client_secret_basic"] as const) {
  for (const [clientId, encodedClientId] of [
    ["registered-client", "registered-client"],
    ["client:segment", "client%3Asegment"],
    ["client +%&=", "client+%2B%25%26%3D"],
    ["客户端", "%E5%AE%A2%E6%88%B7%E7%AB%AF"],
  ] as const) {
    it.effect(
      `preserves an explicit empty client secret through authorization and refresh using ${method} for ${clientId}`,
      () =>
        Effect.gen(function* () {
          const server = { ...fixtureServer, clientId, clientSecret: "" };
          let exchanges = 0;
          let clock = 1_800_000_000_000;
          const fetchEmpty: FetchLike = async (input, init) => {
            if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
              const response = await fetchRegistrationFixture(input, init);
              return Response.json({
                ...decodeObject(await response.json()),
                token_endpoint_auth_methods_supported: [method],
              });
            }
            if (String(input).endsWith("/token")) {
              const body = new URLSearchParams(init?.body as string);
              if (method === "client_secret_post") {
                assert.equal(body.get("client_secret"), "");
                assert.equal(body.get("client_id"), clientId);
              } else
                assert.equal(
                  new Headers(init?.headers).get("authorization"),
                  `Basic ${btoa(`${encodedClientId}:`)}`,
                );
              exchanges++;
              return Response.json({
                access_token: `token-${exchanges}`,
                token_type: "Bearer",
                expires_in: 1,
                refresh_token: "refresh",
              });
            }
            return fetchRegistrationFixture(input, init);
          };
          const oauth = yield* prepareOAuth({
            servers: [server],
            fetch: fetchEmpty,
            now: () => clock,
          });
          const started = yield* oauth.begin({ serverId });
          assert.equal(yield* oauth.status(serverId, server), "authorization-pending");
          assert.equal(
            (yield* oauth.continuePending(serverId, server)).authorizationUrl,
            started.authorizationUrl,
          );
          const provider = yield* oauth.providerFor(serverId, server);
          assert.equal(provider.clientMetadata.token_endpoint_auth_method, "client_secret_post");
          assert.equal(
            (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
            200,
          );
          assert.equal(exchanges, 1);
          assert.equal(yield* oauth.status(serverId, server), "connected");
          clock += 2000;
          const connected = yield* oauth.providerFor(serverId, server);
          assert.equal(
            (yield* Effect.promise(async () => connected.tokens()))?.access_token,
            "token-2",
          );
          assert.equal(exchanges, 2);
        }).pipe(Effect.provide(secretLayer)),
    );
  }
}

for (const [clientId, clientSecret] of [
  ["client:segment", "secret+value"],
  ["客户端", "秘密 + value"],
] as const) {
  it.effect(
    `form-encodes nonempty pre-registered Basic credentials for ${clientId} through authorization and refresh`,
    () =>
      Effect.gen(function* () {
        const server = { ...fixtureServer, clientId, clientSecret };
        let exchanges = 0;
        let clock = 1_800_000_000_000;
        const fetchBasic: FetchLike = async (input, init) => {
          if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
            const response = await fetchRegistrationFixture(input, init);
            return Response.json({
              ...decodeObject(await response.json()),
              token_endpoint_auth_methods_supported: ["client_secret_basic"],
            });
          }
          if (String(input).endsWith("/token")) {
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              `Basic ${btoa(`${formValue(clientId)}:${formValue(clientSecret)}`)}`,
            );
            exchanges++;
            return Response.json({
              access_token: `token-${exchanges}`,
              token_type: "Bearer",
              expires_in: 1,
              refresh_token: "refresh",
            });
          }
          return fetchRegistrationFixture(input, init);
        };
        const oauth = yield* prepareOAuth({
          servers: [server],
          fetch: fetchBasic,
          now: () => clock,
        });
        const started = yield* oauth.begin({ serverId });
        assert.equal(
          (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
          200,
        );
        assert.equal(exchanges, 1);
        clock += 2000;
        const connected = yield* oauth.providerFor(serverId, server);
        assert.equal(
          (yield* Effect.promise(async () => connected.tokens()))?.access_token,
          "token-2",
        );
        assert.equal(exchanges, 2);
      }).pipe(Effect.provide(secretLayer)),
  );
}

it.effect(
  "form-encodes dynamically registered Basic credentials through authorization and refresh",
  () =>
    Effect.gen(function* () {
      const dynamicClientId = "dynamic:客户端";
      const dynamicClientSecret = "dynamic+秘密";
      let exchanges = 0;
      let clock = 1_800_000_000_000;
      const fetchDynamicBasic: FetchLike = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            issuer: "https://issuer.example.test",
            authorization_endpoint: "https://issuer.example.test/authorize",
            token_endpoint: "https://issuer.example.test/token",
            registration_endpoint: "https://issuer.example.test/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url.endsWith("/register"))
          return Response.json({
            client_id: dynamicClientId,
            client_secret: dynamicClientSecret,
            redirect_uris: ["http://127.0.0.1/oauth/project-mcp/callback"],
          });
        if (url.endsWith("/token")) {
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Basic ${btoa(`${formValue(dynamicClientId)}:${formValue(dynamicClientSecret)}`)}`,
          );
          exchanges++;
          return Response.json({
            access_token: `dynamic-token-${exchanges}`,
            token_type: "Bearer",
            expires_in: 1,
            refresh_token: "dynamic-refresh",
          });
        }
        return fetchOAuthFixture(input, init);
      };
      const oauth = yield* prepareOAuth({
        servers: [],
        fetch: fetchDynamicBasic,
        now: () => clock,
      });
      const automaticServer = { serverId, resource };
      const started = yield* oauth.begin({ serverId, server: automaticServer });
      assert.equal(
        (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
        200,
      );
      assert.equal(exchanges, 1);
      clock += 2000;
      const connected = yield* oauth.providerFor(serverId, automaticServer);
      assert.equal(
        (yield* Effect.promise(async () => connected.tokens()))?.access_token,
        "dynamic-token-2",
      );
      assert.equal(exchanges, 2);
    }).pipe(Effect.provide(secretLayer)),
);

const callbackRequest = (authorizationUrl: string) => {
  const authorization = new URL(authorizationUrl);
  const url = new URL(
    authorization.searchParams.get("redirect_uri") ?? "http://127.0.0.1/oauth/project-mcp/callback",
  );
  url.searchParams.set("state", authorization.searchParams.get("state")!);
  url.searchParams.set("code", "one-time-code");
  url.searchParams.set("iss", "https://issuer.example.test");
  return new Request(url.toString());
};

const callbackRequestAt = (authorizationUrl: string, callbackUrl: string) => {
  const url = new URL(callbackUrl);
  const authorization = new URL(authorizationUrl);
  url.searchParams.set("state", authorization.searchParams.get("state")!);
  url.searchParams.set("code", "one-time-code");
  url.searchParams.set("iss", "https://issuer.example.test");
  return new Request(url.toString());
};

it.effect("binds callback completion to the saved origin and path", () =>
  Effect.gen(function* () {
    let exchanges = 0;
    const oauth = yield* prepareOAuth({
      fetch: async (input, init) => {
        if (String(input).endsWith("/token")) exchanges++;
        return fetchOAuthFixture(input, init);
      },
    });
    const started = yield* oauth.begin({
      serverId,
      redirectOrigin: "https://correct.example.test",
    });
    const wrongCallbacks = [
      "https://different.example.test/oauth/project-mcp/callback",
      "https://correct.example.test/not-the-callback",
      "http://correct.example.test/oauth/project-mcp/callback",
    ];
    for (const callbackUrl of wrongCallbacks) {
      const response = yield* oauth.completeCallback(
        callbackRequestAt(started.authorizationUrl, callbackUrl),
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(exchanges, 0);
      assert.equal(yield* oauth.status(serverId), "authorization-pending");
      assert.equal(
        (yield* oauth.continuePending(serverId)).authorizationUrl,
        started.authorizationUrl,
      );
    }

    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: async (input, init) => {
        if (String(input).endsWith("/token")) exchanges++;
        return fetchOAuthFixture(input, init);
      },
    });
    const valid = yield* restarted.completeCallback(
      callbackRequestAt(
        started.authorizationUrl,
        "https://correct.example.test/oauth/project-mcp/callback?code=ignored&state=ignored",
      ),
    );
    assert.equal(valid.status, 200);
    assert.equal(exchanges, 1);
    assert.equal(yield* restarted.status(serverId), "connected");
  }).pipe(Effect.provide(secretLayer)),
);

for (const reader of ["status", "provider"] as const) {
  for (const replacement of ["tokens", "verifier"] as const) {
    it.effect(
      `coherent ${reader} reads serialize secret resolution with ${replacement} replacement`,
      () =>
        Effect.gen(function* () {
          yield* prepareOAuth();
          const store = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
          const listed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const writeStarted = Promise.withResolvers<void>();
          let gateRead = false;
          let readSuspended = false;
          let writerEnteredStore = false;
          const oauth = yield* ProjectMcpOAuth.__testing.make({ servers: [fixtureServer] }).pipe(
            Effect.provideService(ProjectMcpSecretStore.ProjectMcpSecretStore, {
              ...store,
              listAuxiliarySecrets: (id) =>
                Effect.gen(function* () {
                  if (readSuspended) writerEnteredStore = true;
                  const ids = yield* store.listAuxiliarySecrets(id);
                  if (gateRead) {
                    gateRead = false;
                    readSuspended = true;
                    yield* Deferred.succeed(listed, undefined);
                    yield* Deferred.await(release);
                  }
                  return ids;
                }),
            }),
          );
          const provider = yield* oauth.providerFor(serverId);
          yield* Effect.promise(async () => {
            await provider.saveTokens({ access_token: "first", token_type: "Bearer" });
            await provider.saveCodeVerifier("first-verifier");
          });
          gateRead = true;
          const read = yield* Effect.forkScoped(
            Effect.exit(
              Effect.gen(function* () {
                if (reader === "status") assert.equal(yield* oauth.status(serverId), "connected");
                else
                  assert.equal(
                    (yield* Effect.tryPromise(async () => provider.tokens()))?.access_token,
                    "first",
                  );
              }),
            ),
          );
          yield* Deferred.await(listed);
          const write = yield* Effect.forkScoped(
            Effect.promise(async () => {
              const saving =
                replacement === "tokens"
                  ? provider.saveTokens({ access_token: "replacement", token_type: "Bearer" })
                  : provider.saveCodeVerifier("replacement-verifier");
              writeStarted.resolve();
              return saving;
            }),
          );
          yield* Effect.promise(() => writeStarted.promise);
          // If the writer bypassed the read lock, finish revoking the listed IDs
          // before resolving them. With the lock, release the reader to admit it.
          if (writerEnteredStore) yield* Fiber.join(write);
          readSuspended = false;
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(read);
          yield* Fiber.join(write);
          assert.deepEqual(result, Exit.succeed(undefined));
          assert.equal(
            (yield* Effect.promise(async () => provider.tokens()))?.access_token,
            replacement === "tokens" ? "replacement" : "first",
          );
          assert.equal(
            yield* Effect.promise(async () => provider.codeVerifier()),
            replacement === "verifier" ? "replacement-verifier" : "first-verifier",
          );
          yield* oauth.disconnect(serverId);
          assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
        }).pipe(Effect.scoped, Effect.provide(secretLayer)),
    );
  }
}

it.effect("automatic registration uses the HTTPS origin client metadata document", () =>
  Effect.gen(function* () {
    let registrations = 0;
    const oauth = yield* prepareOAuth({
      fetch: async (input, init) => {
        if (String(input).endsWith("/register")) registrations++;
        const response = await fetchOAuthFixture(input, init);
        if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            ...decodeObject(await response.json()),
            client_id_metadata_document_supported: true,
          });
        }
        return response;
      },
    });
    const started = yield* oauth.begin({
      serverId,
      server: { serverId, resource },
      redirectOrigin: "https://remote.example.test",
    });
    const url = new URL(started.authorizationUrl);
    assert.equal(
      url.searchParams.get("client_id"),
      "https://remote.example.test/oauth/project-mcp/client-metadata",
    );
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://remote.example.test/oauth/project-mcp/callback",
    );
    assert.equal(registrations, 0);
  }).pipe(Effect.provide(secretLayer)),
);

const invalidationCases = [
  { scope: "tokens", removed: ["tokens", "tokensIssuedAt"] },
  { scope: "verifier", removed: ["codeVerifier"] },
  {
    scope: "client",
    removed: [
      "client",
      "tokens",
      "tokensIssuedAt",
      "state",
      "codeVerifier",
      "authorizationUrl",
      "scope",
      "expiresAt",
    ],
  },
  { scope: "discovery", removed: ["discovery"] },
  {
    scope: "all",
    removed: [
      "client",
      "tokens",
      "tokensIssuedAt",
      "state",
      "codeVerifier",
      "authorizationUrl",
      "scope",
      "expiresAt",
      "discovery",
      "issuer",
      "redirectUrl",
    ],
  },
] as const;

it.effect("credential read failures remain errors rather than disconnected status", () =>
  Effect.gen(function* () {
    yield* prepareOAuth();
    const store = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    let failReads = false;
    const oauth = yield* ProjectMcpOAuth.__testing.make({ servers: [fixtureServer] }).pipe(
      Effect.provideService(ProjectMcpSecretStore.ProjectMcpSecretStore, {
        ...store,
        resolve: (id, credential) =>
          failReads
            ? Effect.fail(
                new ProjectMcpSecretStore.ProjectMcpSecretStoreError({
                  operation: "read",
                  cause: new Error("fixture storage failure"),
                }),
              )
            : store.resolve(id, credential),
      }),
    );
    const provider = yield* oauth.providerFor(serverId);
    yield* Effect.promise(async () =>
      provider.saveTokens({ access_token: "token", token_type: "Bearer" }),
    );
    failReads = true;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(oauth.status(serverId))));
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(Effect.tryPromise(async () => provider.tokens()))),
    );
    failReads = false;
    assert.equal(yield* oauth.status(serverId), "connected");
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("invalidation cannot cross a replacement registration binding", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    yield* oauth.begin({ serverId });
    const previous = yield* oauth.providerFor(serverId);
    const replacement = { ...fixtureServer, clientId: "replacement-client" };
    const started = yield* oauth.begin({ serverId, server: replacement });
    const provider = yield* oauth.providerFor(serverId, replacement);
    const verifier = yield* Effect.promise(async () => provider.codeVerifier());
    for (const { scope } of invalidationCases) {
      yield* Effect.promise(async () => previous.invalidateCredentials!(scope));
      assert.equal(yield* Effect.promise(async () => provider.codeVerifier()), verifier);
      assert.equal(
        (yield* oauth.continuePending(serverId, replacement)).authorizationUrl,
        started.authorizationUrl,
      );
    }
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    assert.equal(yield* oauth.status(serverId, replacement), "connected");
    assert.equal(yield* oauth.status(serverId, fixtureServer), "not-connected");
  }).pipe(Effect.provide(secretLayer)),
);

for (const { scope, removed } of invalidationCases) {
  it.effect(`SDK ${scope} invalidation removes only its owned state`, () =>
    Effect.gen(function* () {
      const oauth = yield* prepareOAuth();
      const store = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      const started = yield* oauth.begin({
        serverId,
        scope: "mcp:read",
        redirectOrigin: "https://remote.example.test",
      });
      const provider = yield* oauth.providerFor(serverId);
      yield* Effect.promise(async () =>
        provider.saveTokens({ access_token: "old-token", token_type: "Bearer" }),
      );
      const beforeIds = yield* store.listAuxiliarySecrets(serverId);
      const before = decodeRecord(yield* store.resolve(serverId, beforeIds[0]!));
      yield* Effect.promise(async () => provider.invalidateCredentials!(scope));
      const afterIds = yield* store.listAuxiliarySecrets(serverId);
      const after = decodeRecord(yield* store.resolve(serverId, afterIds[0]!));
      for (const [key, value] of Object.entries(before)) {
        if ((removed as readonly string[]).includes(key)) assert.notProperty(after, key);
        else assert.deepEqual(after[key], value, `${scope} must preserve ${key}`);
      }
      assert.equal(after.generation, before.generation);
      assert.deepEqual(after.registration, { clientId: "registered-client" });
      if (scope === "tokens") {
        assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
        assert.equal(
          (yield* oauth.continuePending(serverId)).authorizationUrl,
          started.authorizationUrl,
        );
        assert.equal(
          (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
          200,
        );
      }
      if (scope === "discovery") {
        assert.isUndefined(yield* Effect.promise(async () => provider.discoveryState!()));
        assert.equal(
          (yield* Effect.promise(async () => provider.tokens()))?.access_token,
          "old-token",
        );
        assert.equal(
          yield* Effect.promise(() =>
            auth(provider, {
              serverUrl: resource,
              fetchFn: fetchOAuthFixture,
              forceReauthorization: true,
            }),
          ),
          "REDIRECT",
        );
        assert.isDefined(yield* Effect.promise(async () => provider.discoveryState!()));
      }
    }).pipe(Effect.provide(secretLayer)),
  );

  it.effect(`stale providers cannot invalidate ${scope} in a replacement generation`, () =>
    Effect.gen(function* () {
      const oauth = yield* prepareOAuth();
      yield* oauth.begin({ serverId });
      const stale = yield* oauth.providerFor(serverId);
      const started = yield* oauth.begin({ serverId });
      const active = yield* oauth.providerFor(serverId);
      const verifier = yield* Effect.promise(async () => active.codeVerifier());
      yield* Effect.promise(async () => stale.invalidateCredentials!(scope));
      assert.equal(yield* Effect.promise(async () => active.codeVerifier()), verifier);
      assert.equal(
        (yield* oauth.continuePending(serverId)).authorizationUrl,
        started.authorizationUrl,
      );
      assert.equal(
        (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
        200,
      );
    }).pipe(Effect.provide(secretLayer)),
  );
}

it.effect(
  "SDK authorization uses the configured pre-registered client without dynamic registration",
  () =>
    Effect.gen(function* () {
      let registrations = 0;
      const fetchRegistered: FetchLike = async (input, init) => {
        if (String(input).endsWith("/register")) registrations++;
        if (String(input).endsWith("/token")) {
          const body = new URLSearchParams(init?.body as string);
          assert.equal(body.get("client_id"), "registered-client");
          assert.equal(body.get("client_secret"), "fixture-secret");
        }
        return fetchRegistrationFixture(input, init);
      };
      const oauth = yield* prepareOAuth({ fetch: fetchRegistered });
      const runtime = yield* oauth.providerFor(serverId, {
        ...fixtureServer,
        clientSecret: "fixture-secret",
      });
      assert.equal(
        yield* Effect.promise(() =>
          auth(runtime, { serverUrl: resource, fetchFn: fetchRegistered }),
        ),
        "REDIRECT",
      );
      const pending = yield* oauth.continuePending(serverId);
      assert.equal(
        new URL(pending.authorizationUrl).searchParams.get("client_id"),
        "registered-client",
      );
      assert.equal(registrations, 0);
      assert.equal(
        (yield* oauth.completeCallback(callbackRequest(pending.authorizationUrl))).status,
        200,
      );
    }).pipe(Effect.provide(secretLayer)),
);

for (const previous of ["legacy", "different registration", "mismatched client"] as const) {
  it.effect(`SDK authorization cannot replace a ${previous} grant without explicit reconnect`, () =>
    Effect.gen(function* () {
      let registrations = 0;
      const fetchRegistered: FetchLike = async (input, init) => {
        if (String(input).endsWith("/register")) registrations++;
        return fetchRegistrationFixture(input, init);
      };
      yield* prepareOAuth({ fetch: fetchRegistered });
      const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
      yield* secrets.createAuxiliarySecret(
        serverId,
        encodeLegacyRecord({
          kind: "project-mcp-oauth",
          serverId,
          resource,
          ...(previous === "legacy"
            ? {}
            : {
                registration: {
                  clientId: previous === "mismatched client" ? "registered-client" : "other-client",
                },
              }),
          client: { client_id: "other-client", issuer: "https://issuer.example.test" },
          tokens: {
            access_token: "previous-token",
            token_type: "Bearer",
            issuer: "https://issuer.example.test",
          },
          generation: 1,
        }),
      );
      const ids = yield* secrets.listAuxiliarySecrets(serverId);
      const restarted = yield* ProjectMcpOAuth.__testing.make({
        servers: [],
        fetch: fetchRegistered,
      });
      const runtime = yield* restarted.providerFor(serverId, fixtureServer);
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => auth(runtime, { serverUrl: resource, fetchFn: fetchRegistered }),
          catch: (cause) =>
            new ProjectMcpOAuth.ProjectMcpOAuthError({ operation: "SDK authorization", cause }),
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(registrations, 0);
      assert.deepEqual(yield* secrets.listAuxiliarySecrets(serverId), ids);
      const next = yield* restarted.begin({ serverId, server: fixtureServer });
      assert.equal(
        (yield* restarted.completeCallback(callbackRequest(next.authorizationUrl))).status,
        200,
      );
    }).pipe(Effect.provide(secretLayer)),
  );
}

it.effect("rejects SDK attempts to save a client inconsistent with pre-registration", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    yield* oauth.begin({ serverId });
    const runtime = yield* oauth.providerFor(serverId);
    const result = yield* Effect.exit(
      Effect.tryPromise({
        try: async () => runtime.saveClientInformation!({ client_id: "wrong-client" }),
        catch: (cause) =>
          new ProjectMcpOAuth.ProjectMcpOAuthError({ operation: "SDK client update", cause }),
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.equal(
      (yield* Effect.promise(async () => runtime.clientInformation()))?.client_id,
      "registered-client",
    );
  }).pipe(Effect.provide(secretLayer)),
);

for (const action of ["disconnect", "reconnect"] as const) {
  it.effect(`an outstanding Connect cannot supersede a later ${action}`, () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let pauseDiscovery = true;
      const oauth = yield* prepareOAuth({
        fetch: async (input, init) => {
          if (pauseDiscovery && String(input).endsWith("/.well-known/oauth-protected-resource")) {
            pauseDiscovery = false;
            entered.resolve();
            await release.promise;
          }
          return fetchOAuthFixture(input, init);
        },
      });
      const first = yield* Effect.forkScoped(Effect.exit(oauth.begin({ serverId })));
      const next = yield* Effect.gen(function* () {
        yield* Effect.promise(() => entered.promise);
        if (action === "disconnect") {
          yield* oauth.disconnect(serverId);
          return undefined;
        }
        return yield* oauth.begin({ serverId });
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
      if (next === undefined) {
        assert.equal(yield* oauth.status(serverId), "not-connected");
      } else {
        assert.equal(
          (yield* oauth.continuePending(serverId)).authorizationUrl,
          next.authorizationUrl,
        );
        assert.equal(
          (yield* oauth.completeCallback(callbackRequest(next.authorizationUrl))).status,
          200,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(secretLayer)),
  );
}

it.effect("runtime step-up uses the saved remote callback after restart", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const started = yield* oauth.begin({ serverId, redirectOrigin: "https://t3.example.test" });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: fetchOAuthFixture,
    });
    const runtime = yield* restarted.providerFor(serverId, fixtureServer);
    assert.equal(
      yield* Effect.promise(() =>
        auth(runtime, {
          serverUrl: resource,
          scope: "mcp:read mcp:write",
          forceReauthorization: true,
          fetchFn: fetchOAuthFixture,
        }),
      ),
      "REDIRECT",
    );
    const continued = yield* restarted.continuePending(serverId, fixtureServer);
    assert.equal(
      new URL(continued.authorizationUrl).searchParams.get("redirect_uri"),
      "https://t3.example.test/oauth/project-mcp/callback",
    );
    assert.equal(
      (yield* restarted.completeCallback(callbackRequest(continued.authorizationUrl))).status,
      200,
    );
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("a completed callback keeps fresh tokens until their own expiry", () =>
  Effect.gen(function* () {
    let clock = 1_800_000_000_000;
    let refreshes = 0;
    const fetchTokens: FetchLike = async (input, init) => {
      if (!String(input).endsWith("/token")) return fetchOAuthFixture(input, init);
      const refresh =
        new URLSearchParams(init?.body as string).get("grant_type") === "refresh_token";
      if (refresh) refreshes++;
      return Response.json({
        access_token: refresh ? "refreshed-token" : "fresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-token",
      });
    };
    const oauth = yield* prepareOAuth({ fetch: fetchTokens, now: () => clock });
    const started = yield* oauth.begin({ serverId });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [],
      fetch: fetchTokens,
      now: () => clock,
    });
    const runtime = yield* restarted.providerFor(serverId, fixtureServer);
    clock += 3_599_000;
    assert.equal(
      (yield* Effect.promise(async () => runtime.tokens()))?.access_token,
      "fresh-token",
    );
    assert.equal(refreshes, 0);
    clock += 1_001;
    assert.equal(
      (yield* Effect.promise(async () => runtime.tokens()))?.access_token,
      "refreshed-token",
    );
    assert.equal(refreshes, 1);
    assert.equal(
      (yield* Effect.promise(async () => runtime.tokens()))?.access_token,
      "refreshed-token",
    );
    assert.equal(refreshes, 1);
  }).pipe(Effect.provide(secretLayer)),
);

for (const overlap of ["pending authorization", "completed authorization"] as const) {
  it.effect(`a refresh preserves a newer ${overlap}`, () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let clock = 1_800_000_000_000;
      let grants = 0;
      const oauth = yield* prepareOAuth({
        now: () => clock,
        fetch: async (input, init) => {
          if (!String(input).endsWith("/token")) return fetchOAuthFixture(input, init);
          const refresh =
            new URLSearchParams(init?.body as string).get("grant_type") === "refresh_token";
          if (refresh) {
            entered.resolve();
            await release.promise;
          } else {
            grants++;
          }
          return Response.json({
            access_token: refresh ? "refreshed-token" : `grant-${grants}`,
            token_type: "Bearer",
            expires_in: 1,
            refresh_token: refresh ? "rotated-refresh" : `refresh-${grants}`,
          });
        },
      });
      const started = yield* oauth.begin({ serverId });
      assert.equal(
        (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
        200,
      );
      const provider = yield* oauth.providerFor(serverId);
      clock += 2_000;
      const authorizationUrl =
        "https://issuer.example.test/authorize?state=step-up&scope=mcp%3Aread+mcp%3Awrite";
      const startStepUp = Effect.promise(async () => {
        await provider.saveCodeVerifier("v".repeat(48));
        await provider.redirectToAuthorization(new URL(authorizationUrl));
      });
      if (overlap === "completed authorization") yield* startStepUp;
      const refresh = yield* Effect.forkScoped(Effect.promise(async () => provider.tokens()));
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => entered.promise);
        if (overlap === "pending authorization") yield* startStepUp;
        else
          assert.equal(
            (yield* oauth.completeCallback(callbackRequest(authorizationUrl))).status,
            200,
          );
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
      yield* Fiber.join(refresh);
      if (overlap === "pending authorization") {
        assert.equal(yield* oauth.status(serverId), "authorization-pending");
        assert.equal((yield* oauth.continuePending(serverId)).authorizationUrl, authorizationUrl);
        assert.equal(
          (yield* oauth.completeCallback(callbackRequest(authorizationUrl))).status,
          200,
        );
      } else {
        assert.equal(yield* oauth.status(serverId), "connected");
        assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
        const active = yield* oauth.providerFor(serverId);
        assert.equal((yield* Effect.promise(async () => active.tokens()))?.access_token, "grant-2");
      }
    }).pipe(Effect.scoped, Effect.provide(secretLayer)),
  );
}

it.effect("an SDK-driven refresh cannot replace a completed callback grant", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let grants = 0;
    const fetchTokens: FetchLike = async (input, init) => {
      if (!String(input).endsWith("/token")) return fetchOAuthFixture(input, init);
      const refresh =
        new URLSearchParams(init?.body as string).get("grant_type") === "refresh_token";
      if (refresh) {
        entered.resolve();
        await release.promise;
      } else grants++;
      return Response.json({
        access_token: refresh ? "stale-sdk-refresh" : `grant-${grants}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `refresh-${grants}`,
      });
    };
    const oauth = yield* prepareOAuth({ fetch: fetchTokens });
    const started = yield* oauth.begin({ serverId });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const runtime = yield* oauth.providerFor(serverId);
    yield* Effect.promise(async () => {
      await runtime.saveCodeVerifier("v".repeat(48));
      await runtime.redirectToAuthorization(
        new URL("https://issuer.example.test/authorize?state=step-up"),
      );
    });
    const refresh = yield* Effect.forkScoped(
      Effect.promise(() =>
        auth(runtime, {
          serverUrl: resource,
          fetchFn: fetchTokens,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => entered.promise);
      assert.equal(
        (yield* oauth.completeCallback(
          callbackRequest("https://issuer.example.test/authorize?state=step-up"),
        )).status,
        200,
      );
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
    yield* Fiber.join(refresh);
    const active = yield* oauth.providerFor(serverId);
    assert.equal((yield* Effect.promise(async () => active.tokens()))?.access_token, "grant-2");
  }).pipe(Effect.scoped, Effect.provide(secretLayer)),
);

for (const [name, replacement] of [
  ["client ID", { clientId: "other-client", clientSecret: "original-secret" }],
  ["client secret", { clientId: "registered-client", clientSecret: "rotated-secret" }],
  ["registration mode", {}],
] as const) {
  it.effect(`does not reuse credentials after changing ${name}`, () =>
    Effect.gen(function* () {
      const oauth = yield* prepareOAuth();
      const original = { ...fixtureServer, clientSecret: "original-secret" };
      const started = yield* oauth.begin({ serverId, server: original });
      assert.equal(
        (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
        200,
      );
      const provider = yield* oauth.providerFor(serverId, { serverId, resource, ...replacement });
      assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
      assert.isUndefined(yield* Effect.promise(async () => provider.clientInformation()));
      const unchanged = yield* oauth.providerFor(serverId, original);
      assert.equal(
        (yield* Effect.promise(async () => unchanged.tokens()))?.access_token,
        "opaque-access-token",
      );
    }).pipe(Effect.provide(secretLayer)),
  );
}

it.effect("keeps automatic registration bound to automatic mode across restart", () =>
  Effect.gen(function* () {
    const fetchAutomatic: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: "https://issuer.example.test",
          authorization_endpoint: "https://issuer.example.test/authorize",
          token_endpoint: "https://issuer.example.test/token",
          registration_endpoint: "https://issuer.example.test/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/register"))
        return Response.json({
          client_id: "dynamic-client",
          redirect_uris: ["http://127.0.0.1/oauth/project-mcp/callback"],
        });
      return fetchOAuthFixture(input, init);
    };
    const oauth = yield* prepareOAuth({ fetch: fetchAutomatic });
    const started = yield* oauth.begin({ serverId, server: { serverId, resource } });
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(started.authorizationUrl))).status,
      200,
    );
    const restarted = yield* ProjectMcpOAuth.__testing.make({ servers: [], fetch: fetchAutomatic });
    const automatic = yield* restarted.providerFor(serverId, { serverId, resource });
    assert.equal(
      (yield* Effect.promise(async () => automatic.tokens()))?.access_token,
      "opaque-access-token",
    );
    const explicit = yield* restarted.providerFor(serverId, {
      serverId,
      resource,
      clientId: "dynamic-client",
    });
    assert.isUndefined(yield* Effect.promise(async () => explicit.tokens()));
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("an old provider cannot write credentials into a reconnected authorization", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    yield* oauth.begin({ serverId });
    const old = yield* oauth.providerFor(serverId);
    yield* oauth.disconnect(serverId);
    const next = yield* oauth.begin({ serverId });
    yield* Effect.promise(async () => {
      await old.saveTokens({ access_token: "stale-token", token_type: "Bearer" });
      await old.saveCodeVerifier("stale-verifier");
      assert.isDefined(old.saveClientInformation);
      await old.saveClientInformation!({ client_id: "stale-client" });
    });
    const active = yield* oauth.providerFor(serverId);
    assert.isUndefined(yield* Effect.promise(async () => active.tokens()));
    assert.equal(
      (yield* Effect.promise(async () => active.clientInformation()))?.client_id,
      "registered-client",
    );
    assert.equal(
      (yield* oauth.completeCallback(callbackRequest(next.authorizationUrl))).status,
      200,
    );
    assert.isUndefined(yield* Effect.promise(async () => old.tokens()));
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("disconnect preserves reconnect access until the catalog server is removed", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    yield* oauth.begin({ serverId });
    yield* oauth.disconnect(serverId);
    yield* Effect.scoped(secrets.acquireLease(serverId, []));
    assert.deepEqual(yield* secrets.listAuxiliarySecrets(serverId), []);
    assert.include(yield* secrets.listServerIds(), serverId);
    yield* secrets.removeServer(serverId);
    assert.notInclude(yield* secrets.listServerIds(), serverId);
  }).pipe(Effect.provide(secretLayer)),
);

it.effect("a callback finishing after reconnect cannot authorize the replacement grant", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oauth = yield* prepareOAuth({
      fetch: async (input, init) => {
        if (String(input).endsWith("/token")) {
          entered.resolve();
          await release.promise;
        }
        return fetchOAuthFixture(input, init);
      },
    });
    const started = yield* oauth.begin({ serverId });
    const callback = yield* Effect.forkScoped(
      oauth.completeCallback(callbackRequest(started.authorizationUrl)),
    );
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => entered.promise);
      yield* oauth.disconnect(serverId);
      yield* oauth.begin({ serverId });
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
    assert.equal((yield* Fiber.join(callback)).status, 400);
    const provider = yield* oauth.providerFor(serverId);
    assert.isUndefined(yield* Effect.promise(async () => provider.tokens()));
    assert.equal(yield* oauth.status(serverId), "authorization-pending");
  }).pipe(Effect.scoped, Effect.provide(secretLayer)),
);

it.effect("a restarted service does not reuse the previous authorization generation", () =>
  Effect.gen(function* () {
    const oauth = yield* prepareOAuth();
    yield* oauth.begin({ serverId });
    const restarted = yield* ProjectMcpOAuth.__testing.make({
      servers: [fixtureServer],
      fetch: fetchOAuthFixture,
    });
    const old = yield* restarted.providerFor(serverId);
    yield* restarted.begin({ serverId });
    yield* Effect.promise(async () =>
      old.saveTokens({ access_token: "stale-token", token_type: "Bearer" }),
    );
    const active = yield* restarted.providerFor(serverId);
    assert.isUndefined(yield* Effect.promise(async () => active.tokens()));
  }).pipe(Effect.provide(secretLayer)),
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
    const callbackUrl = new URL(
      new URL(superseding.authorizationUrl).searchParams.get("redirect_uri")!,
    );
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
    const initialCallbackUrl = new URL("http://127.0.0.1/oauth/project-mcp/callback");
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
    const stepUpCallbackUrl = new URL("http://127.0.0.1/oauth/project-mcp/callback");
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
