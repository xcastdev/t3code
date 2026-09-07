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
import type { ProjectMcpOAuthStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const STATE_TTL_MS = 10 * 60 * 1000;
const RECORD_NAME = "project-mcp-oauth";

const oauthErrorResponse = (message: string): Response =>
  new Response(message, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });

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
  readonly clientMetadataUrl?: string;
}

export interface ProjectMcpOAuthConfig {
  readonly servers: ReadonlyArray<ProjectMcpOAuthServer>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly redirectOrigin?: string;
}

export type ProjectMcpOAuthAuthorizedHandler = (serverId: McpServerId) => void | Promise<void>;

export interface BeginProjectMcpOAuthInput {
  readonly serverId: McpServerId;
  readonly scope?: string;
  /** A live redacted catalog projection, supplied by the RPC boundary. */
  readonly server?: ProjectMcpOAuthServer;
  /** Trusted origin derived from the authenticated T3 HTTP request, never client input. */
  readonly redirectOrigin?: string;
}

export interface ProjectMcpOAuthShape {
  readonly status: (
    serverId: McpServerId,
  ) => Effect.Effect<ProjectMcpOAuthStatus, ProjectMcpOAuthError>;
  readonly providerFor: (
    serverId: McpServerId,
    server?: ProjectMcpOAuthServer,
  ) => Effect.Effect<OAuthClientProvider, ProjectMcpOAuthError>;
  readonly begin: (
    input: BeginProjectMcpOAuthInput,
  ) => Effect.Effect<ProjectMcpOAuthBeginResult, ProjectMcpOAuthError>;
  readonly completeCallback: (request: Request) => Effect.Effect<Response, ProjectMcpOAuthError>;
  readonly disconnect: (serverId: McpServerId) => Effect.Effect<void, ProjectMcpOAuthError>;
  /** Binds the immutable session snapshot used by a proxy-created provider. */
  readonly bindServer?: (server: ProjectMcpOAuthServer) => void;
  /** Installed by the proxy registry so a new grant invalidates cached upstream clients. */
  readonly setAuthorizedHandler?: (handler: ProjectMcpOAuthAuthorizedHandler | undefined) => void;
}

export class ProjectMcpOAuth extends Context.Service<ProjectMcpOAuth, ProjectMcpOAuthShape>()(
  "t3/mcp/ProjectMcpOAuth",
) {}

type StoredRecord = {
  readonly kind: typeof RECORD_NAME;
  readonly serverId: string;
  readonly resource: string;
  readonly issuer?: string;
  readonly redirectUrl?: string;
  readonly state?: string;
  readonly expiresAt?: number;
  readonly codeVerifier?: string;
  readonly client?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
  readonly generation?: number;
};

const canonicalResource = (resource: string): string => new URL(resource).toString();

const hasSameResource = (left: StoredRecord, right: Pick<StoredRecord, "resource">): boolean =>
  canonicalResource(left.resource) === canonicalResource(right.resource);

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
    const boundServers = new Map<McpServerId, ProjectMcpOAuthServer>();
    const pendingStates = new Map<string, McpServerId>();
    const generations = new Map<string, number>();
    const mutex = yield* Semaphore.make(1);
    let authorizedHandler: ProjectMcpOAuthAuthorizedHandler | undefined;
    const fetchFn = config.fetch ?? fetch;
    const now = config.now ?? Date.now;
    const defaultRedirect = config.redirectOrigin
      ? new URL("/oauth/project-mcp/callback", config.redirectOrigin).toString()
      : "http://127.0.0.1/oauth/project-mcp/callback";

    const serverFor = async (
      id: McpServerId,
      supplied?: ProjectMcpOAuthServer,
    ): Promise<ProjectMcpOAuthServer> => {
      if (supplied) return supplied;
      const configured = byId.get(id);
      if (configured) return configured;
      const bound = boundServers.get(id);
      if (bound) return bound;
      throw new Error("Unknown MCP server");
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
    const current = (id: McpServerId, server?: ProjectMcpOAuthServer) =>
      recordsFor(id).pipe(
        Effect.map(
          (records) =>
            (server === undefined
              ? records
              : records.filter(({ record }) => hasSameResource(record, server))
            ).at(-1)?.record,
        ),
      );
    const save = (id: McpServerId, record: StoredRecord) =>
      Effect.gen(function* () {
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* secrets.createAuxiliarySecret(id, JSON.stringify(record));
        for (const old of yield* recordsFor(id)) {
          if (old.record.generation !== record.generation && hasSameResource(old.record, record)) {
            yield* secrets.removeAuxiliarySecret(id, old.id);
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) => new ProjectMcpOAuthError({ operation: "write credentials", cause }),
        ),
      );
    const nextGeneration = (id: McpServerId) => {
      const next = (generations.get(id) ?? 0) + 1;
      generations.set(id, next);
      return next;
    };
    const saveIfCurrent = (
      id: McpServerId,
      server: ProjectMcpOAuthServer,
      generation: number,
      record: StoredRecord,
    ) =>
      mutex.withPermits(1)(
        current(id, server).pipe(
          Effect.flatMap((active) =>
            active?.generation === generation
              ? save(id, record).pipe(Effect.as(true))
              : Effect.succeed(false),
          ),
        ),
      );

    const providerFor: ProjectMcpOAuthShape["providerFor"] = (id, supplied) =>
      Effect.tryPromise({
        try: async () => {
          const server = await serverFor(id, supplied);
          const initial = await Effect.runPromise(current(id, server));
          const generation = initial?.generation ?? generations.get(id) ?? 0;
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
            ...(server.clientMetadataUrl === undefined
              ? {}
              : { clientMetadataUrl: server.clientMetadataUrl }),
            clientInformation: async (ctx) => {
              const record = await Effect.runPromise(current(id, server));
              return record?.client && (!ctx?.issuer || record.client.issuer === ctx.issuer)
                ? record.client
                : undefined;
            },
            tokens: async (ctx) => {
              const record = await Effect.runPromise(current(id, server));
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
                const saved = await Effect.runPromise(
                  saveIfCurrent(id, server, record.generation ?? generation, {
                    ...record,
                    tokens: next,
                    expiresAt: now(),
                  }),
                );
                return saved ? next : undefined;
              } catch {
                return undefined;
              }
            },
            saveClientInformation: async (client, ctx) => {
              const record = (await Effect.runPromise(current(id, server))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              await Effect.runPromise(
                saveIfCurrent(id, server, record.generation ?? generation, {
                  ...record,
                  client: ctx?.issuer ? { ...client, issuer: ctx.issuer } : client,
                }),
              );
            },
            saveTokens: async (tokens, ctx) => {
              const record = (await Effect.runPromise(current(id, server))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              if (record.issuer && ctx?.issuer && record.issuer !== ctx.issuer)
                throw new Error("issuer mismatch");
              await Effect.runPromise(
                saveIfCurrent(id, server, record.generation ?? generation, {
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
              const record = (await Effect.runPromise(current(id, server))) ?? {
                kind: RECORD_NAME,
                serverId: id,
                resource: server.resource,
              };
              await Effect.runPromise(
                saveIfCurrent(id, server, record.generation ?? generation, {
                  ...record,
                  codeVerifier,
                }),
              );
            },
            codeVerifier: async () => {
              const verifier = (await Effect.runPromise(current(id, server)))?.codeVerifier;
              if (!verifier) throw new Error("missing PKCE verifier");
              return verifier;
            },
            state: () => random(),
            saveDiscoveryState: async (discovery) => {
              const record = (await Effect.runPromise(current(id, server)))!;
              await Effect.runPromise(
                saveIfCurrent(id, server, record.generation ?? generation, {
                  ...record,
                  discovery,
                  ...(discovery.authorizationServerMetadata?.issuer
                    ? { issuer: discovery.authorizationServerMetadata.issuer }
                    : {}),
                }),
              );
            },
            discoveryState: async () => (await Effect.runPromise(current(id, server)))?.discovery,
            validateResourceURL: async (serverUrl, resource) => {
              if (!resource || new URL(resource).toString() !== new URL(serverUrl).toString())
                throw new Error("resource mismatch");
              return new URL(resource);
            },
            invalidateCredentials: async () => {
              await Effect.runPromise(
                saveIfCurrent(id, server, generation, {
                  kind: RECORD_NAME,
                  serverId: id,
                  resource: server.resource,
                  generation,
                }),
              );
            },
          };
          return provider;
        },
        catch: (cause) => new ProjectMcpOAuthError({ operation: "create provider", cause }),
      });

    const begin: ProjectMcpOAuthShape["begin"] = (input) =>
      Effect.gen(function* () {
        const server = yield* Effect.tryPromise({
          try: () => serverFor(input.serverId, input.server),
          catch: (cause) => new ProjectMcpOAuthError({ operation: "resolve server", cause }),
        });
        let providerServer = server;
        if (input.redirectOrigin !== undefined) {
          let redirectOrigin: URL;
          try {
            redirectOrigin = new URL(input.redirectOrigin);
          } catch (cause) {
            return yield* new ProjectMcpOAuthError({ operation: "resolve redirect", cause });
          }
          const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
          if (
            redirectOrigin.username !== "" ||
            redirectOrigin.password !== "" ||
            redirectOrigin.search !== "" ||
            redirectOrigin.hash !== "" ||
            (redirectOrigin.protocol !== "https:" &&
              !(redirectOrigin.protocol === "http:" && loopback.has(redirectOrigin.hostname)))
          ) {
            return yield* new ProjectMcpOAuthError({
              operation: "resolve redirect",
              cause: new Error("OAuth redirects require HTTPS or loopback HTTP."),
            });
          }
          providerServer = {
            ...server,
            redirectUrl: new URL("/oauth/project-mcp/callback", redirectOrigin.origin).toString(),
            ...(redirectOrigin.protocol === "https:"
              ? {
                  clientMetadataUrl: new URL(
                    "/oauth/project-mcp/client-metadata",
                    redirectOrigin.origin,
                  ).toString(),
                }
              : {}),
          };
        }
        const provider = yield* providerFor(input.serverId, providerServer);
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
          : server.clientMetadataUrl &&
              info.authorizationServerMetadata?.client_id_metadata_document_supported === true
            ? {
                client_id: server.clientMetadataUrl,
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
        const authorizationState = new URL(started.authorizationUrl).searchParams.get("state");
        if (!authorizationState) {
          return yield* new ProjectMcpOAuthError({
            operation: "begin",
            cause: new Error("Authorization server did not return state."),
          });
        }
        pendingStates.set(authorizationState, input.serverId);
        const generation = nextGeneration(input.serverId);
        yield* mutex.withPermits(1)(
          save(input.serverId, {
            kind: RECORD_NAME,
            serverId: input.serverId,
            resource: server.resource,
            redirectUrl: String(provider.redirectUrl),
            issuer,
            state: authorizationState,
            expiresAt: now() + STATE_TTL_MS,
            codeVerifier: started.codeVerifier,
            client: { ...client, issuer },
            discovery: info,
            generation,
          }),
        );
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
        if (!state || !code) return oauthErrorResponse("Invalid OAuth callback.");
        const pendingServerId = pendingStates.get(state);
        const serverIds = [
          ...new Set([
            ...config.servers.map(({ serverId }) => serverId),
            ...(yield* secrets
              .listServerIds()
              .pipe(
                Effect.mapError(
                  (cause) => new ProjectMcpOAuthError({ operation: "read server IDs", cause }),
                ),
              )),
          ]),
        ];
        const matches = yield* Effect.forEach(serverIds, (serverId) =>
          current(serverId).pipe(Effect.map((record) => ({ serverId, record }))),
        );
        const persistedFound = matches.find(({ record }) => record?.state === state);
        const pendingFound =
          pendingServerId === undefined
            ? undefined
            : matches.find(
                ({ serverId: candidateServerId, record }) =>
                  candidateServerId === pendingServerId && record?.state === state,
              );
        const found = persistedFound ?? pendingFound;
        const record = found?.record;
        if (!found || !record || (record.expiresAt ?? 0) < now())
          return oauthErrorResponse("Invalid OAuth state.");
        if (url.searchParams.get("iss") !== null && url.searchParams.get("iss") !== record.issuer)
          return oauthErrorResponse("Invalid OAuth issuer.");
        const callbackServer = yield* Effect.tryPromise({
          try: async () => {
            const configured = await serverFor(found.serverId).catch(() => undefined);
            const clientId = record.client?.client_id;
            const clientSecret = record.client?.client_secret;
            return {
              serverId: found.serverId,
              resource: record.resource,
              ...(configured?.authorizationServers === undefined
                ? {}
                : { authorizationServers: configured.authorizationServers }),
              ...(record.redirectUrl === undefined ? {} : { redirectUrl: record.redirectUrl }),
              ...(typeof clientId === "string" ? { clientId } : {}),
              ...(typeof clientSecret === "string" ? { clientSecret } : {}),
            } satisfies ProjectMcpOAuthServer;
          },
          catch: (cause) => new ProjectMcpOAuthError({ operation: "resolve callback", cause }),
        });
        const provider = yield* providerFor(found.serverId, {
          ...callbackServer,
          ...(record.redirectUrl === undefined ? {} : { redirectUrl: record.redirectUrl }),
        });
        yield* Effect.tryPromise({
          try: () =>
            auth(provider, {
              serverUrl: record.resource,
              authorizationCode: code,
              fetchFn,
              ...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss")! } : {}),
            }),
          catch: (cause) => new ProjectMcpOAuthError({ operation: "callback", cause }),
        });
        pendingStates.delete(state);
        const after = yield* current(found.serverId);
        if (after && after.generation === record.generation) {
          const { state: _state, codeVerifier: _codeVerifier, ...withoutVerifier } = after;
          yield* saveIfCurrent(
            found.serverId,
            callbackServer,
            record.generation ?? 0,
            withoutVerifier,
          );
        }
        if (authorizedHandler !== undefined) {
          yield* Effect.promise(async () => {
            await authorizedHandler!(found.serverId);
          }).pipe(Effect.ignore);
        }
        return new Response("OAuth authorization complete.", {
          headers: { "cache-control": "no-store" },
        });
      });

    const status: ProjectMcpOAuthShape["status"] = (id) =>
      current(id).pipe(
        Effect.map((record) => {
          if (record?.state !== undefined && (record.expiresAt ?? 0) >= now()) {
            return "authorization-pending" as const;
          }
          return record?.tokens === undefined ? "not-connected" : "connected";
        }),
        Effect.mapError((cause) => new ProjectMcpOAuthError({ operation: "read status", cause })),
      );

    return ProjectMcpOAuth.of({
      status,
      providerFor,
      begin,
      completeCallback,
      setAuthorizedHandler: (handler) => {
        authorizedHandler = handler;
      },
      bindServer: (server) => {
        boundServers.set(server.serverId, server);
      },
      disconnect: (id) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            nextGeneration(id);
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
        ),
    });
  });

export const layer = (config: ProjectMcpOAuthConfig) => Layer.effect(ProjectMcpOAuth, make(config));

export const __testing = { make };
