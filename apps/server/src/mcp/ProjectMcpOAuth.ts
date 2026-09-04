import {
  McpServerId,
  type ProjectMcpCredentialId,
  type ProjectMcpOAuthBeginResult,
} from "@t3tools/contracts";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  registerClient,
  resolveClientMetadata,
  startAuthorization,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const STATE_TTL_MS = 10 * 60 * 1000;
const RECORD_NAME = "project-mcp-oauth";

export class ProjectMcpOAuthError extends Schema.TaggedErrorClass<ProjectMcpOAuthError>()(
  "ProjectMcpOAuthError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ProjectMcpOAuthServer {
  readonly serverId: McpServerId;
  readonly resource: string;
  readonly authorizationServers?: ReadonlyArray<string>;
  readonly redirectUrl?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly clientMetadata?: OAuthClientMetadata;
}

export interface ProjectMcpOAuthConfig {
  readonly servers: ReadonlyArray<ProjectMcpOAuthServer>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly redirectOrigin?: string;
}

export interface BeginProjectMcpOAuthInput {
  readonly serverId: McpServerId;
  readonly scope?: string;
}

export interface ProjectMcpOAuthShape {
  readonly providerFor: (
    serverId: McpServerId,
  ) => Effect.Effect<OAuthClientProvider, ProjectMcpOAuthError>;
  readonly begin: (
    input: BeginProjectMcpOAuthInput,
  ) => Effect.Effect<ProjectMcpOAuthBeginResult, ProjectMcpOAuthError>;
  readonly completeCallback: (request: Request) => Effect.Effect<Response, ProjectMcpOAuthError>;
  readonly disconnect: (serverId: McpServerId) => Effect.Effect<void, ProjectMcpOAuthError>;
}

export class ProjectMcpOAuth extends Context.Service<ProjectMcpOAuth, ProjectMcpOAuthShape>()(
  "t3/mcp/ProjectMcpOAuth",
) {}

type StoredRecord = {
  readonly kind: typeof RECORD_NAME;
  readonly serverId: string;
  readonly resource: string;
  readonly issuer?: string;
  readonly state?: string;
  readonly expiresAt?: number;
  readonly codeVerifier?: string;
  readonly client?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
};

const decode = (value: string): StoredRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === RECORD_NAME &&
      typeof (parsed as { serverId?: unknown }).serverId === "string" &&
      typeof (parsed as { resource?: unknown }).resource === "string"
    ) {
      return parsed as StoredRecord;
    }
  } catch {}
  return undefined;
};

const random = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

const make = (config: ProjectMcpOAuthConfig) =>
  Effect.gen(function* () {
    const secrets = yield* ProjectMcpSecretStore.ProjectMcpSecretStore;
    const byId = new Map(config.servers.map((server) => [server.serverId, server]));
    const fetchFn = config.fetch ?? fetch;
    const now = config.now ?? Date.now;
    const defaultRedirect = config.redirectOrigin
      ? new URL("/oauth/project-mcp/callback", config.redirectOrigin).toString()
      : "http://127.0.0.1/oauth/project-mcp/callback";

    const serverFor = (id: McpServerId) => {
      const server = byId.get(id);
      if (!server) throw new Error("Unknown MCP server");
      return server;
    };
    const recordsFor = (id: McpServerId) =>
      Effect.gen(function* () {
        const records: Array<{ id: ProjectMcpCredentialId; record: StoredRecord }> = [];
        for (const credentialId of yield* secrets.listAuxiliarySecrets(id)) {
          const record = decode(yield* secrets.resolve(id, credentialId));
          if (record?.serverId === id) records.push({ id: credentialId, record });
        }
        return records;
      }).pipe(
        Effect.mapError(
          (cause) => new ProjectMcpOAuthError({ operation: "read credentials", cause }),
        ),
      );
    const current = (id: McpServerId) =>
      recordsFor(id).pipe(Effect.map((records) => records.at(-1)?.record));
    const save = (id: McpServerId, record: StoredRecord) =>
      Effect.gen(function* () {
        for (const old of yield* recordsFor(id)) yield* secrets.removeAuxiliarySecret(id, old.id);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* secrets.createAuxiliarySecret(id, JSON.stringify(record));
      }).pipe(
        Effect.mapError(
          (cause) => new ProjectMcpOAuthError({ operation: "write credentials", cause }),
        ),
      );

    const providerFor: ProjectMcpOAuthShape["providerFor"] = (id) =>
      Effect.try({
        try: () => {
          const server = serverFor(id);
          const provider: OAuthClientProvider = {
            get redirectUrl() {
              return server.redirectUrl ?? defaultRedirect;
            },
            get clientMetadata() {
              return resolveClientMetadata({
                redirectUrl: provider.redirectUrl,
                clientMetadata:
                  server.clientMetadata ??
                  ({
                    redirect_uris: [String(provider.redirectUrl)],
                    response_types: ["code"],
                    grant_types: ["authorization_code", "refresh_token"],
                    token_endpoint_auth_method: server.clientSecret ? "client_secret_post" : "none",
                  } satisfies OAuthClientMetadata),
              });
            },
            clientInformation: async (ctx) => {
              const record = await Effect.runPromise(current(id));
              return record?.client && (!ctx?.issuer || record.client.issuer === ctx.issuer)
                ? record.client
                : undefined;
            },
            tokens: async (ctx) => {
              const record = await Effect.runPromise(current(id));
              if (!record?.tokens || (ctx?.issuer && record.tokens.issuer !== ctx.issuer))
                return undefined;
              if (
                record.tokens.expires_in === undefined ||
                (record.expiresAt ?? 0) + record.tokens.expires_in * 1000 > now()
              )
                return record.tokens;
              if (!record.tokens.refresh_token || !record.client || !record.issuer)
                return record.tokens;
              try {
                const info = await discoverOAuthServerInfo(server.resource, { fetchFn });
                const { issuer: _clientIssuer, ...clientInformation } = record.client;
                const refreshed = await refreshAuthorization(record.issuer, {
                  ...(info.authorizationServerMetadata
                    ? { metadata: info.authorizationServerMetadata }
                    : {}),
                  clientInformation,
                  refreshToken: record.tokens.refresh_token,
                  resource: new URL(server.resource),
                  fetchFn,
                });
                const next = { ...refreshed, issuer: record.issuer };
                await Effect.runPromise(save(id, { ...record, tokens: next, expiresAt: now() }));
                return next;
              } catch {
                return undefined;
              }
            },
            saveClientInformation: async (client, ctx) => {
              const record = (await Effect.runPromise(current(id))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              await Effect.runPromise(
                save(id, {
                  ...record,
                  client: ctx?.issuer ? { ...client, issuer: ctx.issuer } : client,
                }),
              );
            },
            saveTokens: async (tokens, ctx) => {
              const record = (await Effect.runPromise(current(id))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              if (record.issuer && ctx?.issuer && record.issuer !== ctx.issuer)
                throw new Error("issuer mismatch");
              await Effect.runPromise(
                save(id, {
                  ...record,
                  ...((ctx?.issuer ?? record.issuer)
                    ? { issuer: ctx?.issuer ?? record.issuer }
                    : {}),
                  tokens,
                  expiresAt: now(),
                }),
              );
            },
            redirectToAuthorization: async () => undefined,
            saveCodeVerifier: async (codeVerifier) => {
              const record = (await Effect.runPromise(current(id))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              await Effect.runPromise(save(id, { ...record, codeVerifier }));
            },
            codeVerifier: async () => {
              const verifier = (await Effect.runPromise(current(id)))?.codeVerifier;
              if (!verifier) throw new Error("missing PKCE verifier");
              return verifier;
            },
            state: () => random(),
            saveDiscoveryState: async (discovery) => {
              const record = (await Effect.runPromise(current(id)))!;
              await Effect.runPromise(
                save(id, {
                  ...record,
                  discovery,
                  ...(discovery.authorizationServerMetadata?.issuer
                    ? { issuer: discovery.authorizationServerMetadata.issuer }
                    : {}),
                }),
              );
            },
            discoveryState: async () => (await Effect.runPromise(current(id)))?.discovery,
            validateResourceURL: async (serverUrl, resource) => {
              if (!resource || new URL(resource).toString() !== new URL(serverUrl).toString())
                throw new Error("resource mismatch");
              return new URL(resource);
            },
            invalidateCredentials: async () => {
              await Effect.runPromise(
                save(id, { kind: RECORD_NAME, serverId: id, resource: server.resource }),
              );
            },
          };
          return provider;
        },
        catch: (cause) => new ProjectMcpOAuthError({ operation: "create provider", cause }),
      });

    const begin: ProjectMcpOAuthShape["begin"] = (input) =>
      Effect.gen(function* () {
        const server = serverFor(input.serverId);
        const provider = yield* providerFor(input.serverId);
        const info = yield* Effect.tryPromise({
          try: () => discoverOAuthServerInfo(server.resource, { fetchFn }),
          catch: (cause) => new ProjectMcpOAuthError({ operation: "discover", cause }),
        });
        const issuer = info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl;
        if (server.authorizationServers && !server.authorizationServers.includes(issuer)) {
          return yield* new ProjectMcpOAuthError({
            operation: "discover",
            cause: new Error("issuer not allowed"),
          });
        }
        const requestedScope = input.scope ?? server.scopes?.join(" ");
        const client: OAuthClientInformationMixed = server.clientId
          ? {
              client_id: server.clientId,
              ...(server.clientSecret ? { client_secret: server.clientSecret } : {}),
              redirect_uris: [String(provider.redirectUrl)],
            }
          : yield* Effect.tryPromise({
              try: () =>
                registerClient(issuer, {
                  ...(info.authorizationServerMetadata
                    ? { metadata: info.authorizationServerMetadata }
                    : {}),
                  clientMetadata: provider.clientMetadata,
                  ...(requestedScope ? { scope: requestedScope } : {}),
                  fetchFn,
                }),
              catch: (cause) => new ProjectMcpOAuthError({ operation: "register client", cause }),
            });
        const started = yield* Effect.tryPromise({
          try: () =>
            startAuthorization(issuer, {
              ...(info.authorizationServerMetadata
                ? { metadata: info.authorizationServerMetadata }
                : {}),
              clientInformation: client,
              redirectUrl: provider.redirectUrl!,
              ...(requestedScope ? { scope: requestedScope } : {}),
              state: random(),
              resource: new URL(server.resource),
            }),
          catch: (cause) => new ProjectMcpOAuthError({ operation: "begin", cause }),
        });
        yield* save(input.serverId, {
          kind: RECORD_NAME,
          serverId: input.serverId,
          resource: server.resource,
          issuer,
          ...(new URL(started.authorizationUrl).searchParams.get("state")
            ? { state: new URL(started.authorizationUrl).searchParams.get("state")! }
            : {}),
          expiresAt: now() + STATE_TTL_MS,
          codeVerifier: started.codeVerifier,
          client: { ...client, issuer },
          discovery: info,
        });
        // @effect-diagnostics-next-line globalDateInEffect:off
        return {
          authorizationUrl: started.authorizationUrl.toString(),
          // @effect-diagnostics-next-line globalDateInEffect:off
          expiresAt: new Date(now() + STATE_TTL_MS).toISOString(),
        };
      }).pipe(
        Effect.catch((cause) =>
          Schema.is(ProjectMcpOAuthError)(cause)
            ? Effect.fail(cause)
            : Effect.fail(new ProjectMcpOAuthError({ operation: "begin", cause })),
        ),
      );

    const completeCallback: ProjectMcpOAuthShape["completeCallback"] = (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || !code) return new Response("Invalid OAuth callback.", { status: 400 });
        const matches = yield* Effect.forEach(config.servers, (server) =>
          current(server.serverId).pipe(Effect.map((record) => ({ server, record }))),
        );
        const found = matches.find(({ record }) => record?.state === state);
        if (!found?.record || (found.record.expiresAt ?? 0) < now())
          return new Response("Invalid OAuth state.", { status: 400 });
        if (
          url.searchParams.get("iss") !== null &&
          url.searchParams.get("iss") !== found.record.issuer
        )
          return new Response("Invalid OAuth issuer.", { status: 400 });
        const { state: _state, ...consumed } = found.record;
        yield* save(found.server.serverId, consumed);
        const provider = yield* providerFor(found.server.serverId);
        yield* Effect.tryPromise({
          try: () =>
            auth(provider, {
              serverUrl: found.server.resource,
              authorizationCode: code,
              fetchFn,
              ...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss")! } : {}),
            }),
          catch: (cause) => new ProjectMcpOAuthError({ operation: "callback", cause }),
        });
        const after = yield* current(found.server.serverId);
        if (after) {
          const { codeVerifier: _codeVerifier, ...withoutVerifier } = after;
          yield* save(found.server.serverId, withoutVerifier);
        }
        return new Response("OAuth authorization complete.", {
          headers: { "cache-control": "no-store" },
        });
      });

    return ProjectMcpOAuth.of({
      providerFor,
      begin,
      completeCallback,
      disconnect: (id) =>
        Effect.gen(function* () {
          for (const record of yield* recordsFor(id)) {
            yield* secrets
              .removeAuxiliarySecret(id, record.id)
              .pipe(
                Effect.mapError(
                  (cause) => new ProjectMcpOAuthError({ operation: "disconnect", cause }),
                ),
              );
          }
        }),
    });
  });

export const layer = (config: ProjectMcpOAuthConfig) => Layer.effect(ProjectMcpOAuth, make(config));
