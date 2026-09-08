import {
  McpServerId,
  type ProjectMcpCredentialId,
  type ProjectMcpOAuthBeginResult,
  type ResolvedProjectMcpServer,
} from "@t3tools/contracts";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  registerClient,
  resolveClientMetadata,
  selectClientAuthMethod,
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
import * as DateTime from "effect/DateTime";
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
const isProjectMcpOAuthError = Schema.is(ProjectMcpOAuthError);

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

/** Resolves catalog registration credentials inside the owning environment. */
export const resolveServerBinding = Effect.fn("ProjectMcpOAuth.resolveServerBinding")(function* (
  server: Pick<ResolvedProjectMcpServer, "id" | "transport">,
  resolveSecret: (
    ...args: Parameters<ProjectMcpSecretStore.ProjectMcpSecretStoreShape["resolve"]>
  ) => Effect.Effect<string | undefined, ProjectMcpSecretStore.ProjectMcpSecretError>,
) {
  const { transport } = server;
  if (transport.type === "stdio" || transport.authorization.type !== "oauth") return undefined;
  const registration = transport.authorization.registration;
  const clientSecret =
    registration.type === "pre-registered" && registration.clientSecret !== undefined
      ? yield* resolveSecret(server.id, registration.clientSecret.id)
      : undefined;
  return {
    serverId: server.id,
    resource: transport.url,
    ...(registration.type === "pre-registered"
      ? {
          clientId: registration.clientId,
          ...(clientSecret === undefined ? {} : { clientSecret }),
        }
      : {}),
  } satisfies ProjectMcpOAuthServer;
});

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
    server?: ProjectMcpOAuthServer,
  ) => Effect.Effect<ProjectMcpOAuthStatus, ProjectMcpOAuthError>;
  readonly providerFor: (
    serverId: McpServerId,
    server?: ProjectMcpOAuthServer,
  ) => Effect.Effect<OAuthClientProvider, ProjectMcpOAuthError>;
  readonly begin: (
    input: BeginProjectMcpOAuthInput,
  ) => Effect.Effect<ProjectMcpOAuthBeginResult, ProjectMcpOAuthError>;
  readonly continuePending: (
    serverId: McpServerId,
    server?: ProjectMcpOAuthServer,
  ) => Effect.Effect<ProjectMcpOAuthBeginResult, ProjectMcpOAuthError>;
  readonly completeCallback: (request: Request) => Effect.Effect<Response, ProjectMcpOAuthError>;
  readonly disconnect: (serverId: McpServerId) => Effect.Effect<void, ProjectMcpOAuthError>;
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
  readonly tokensIssuedAt?: number;
  readonly codeVerifier?: string;
  readonly authorizationUrl?: string;
  readonly scope?: string;
  readonly client?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
  readonly generation?: string | number;
  readonly registration?: Pick<ProjectMcpOAuthServer, "clientId" | "clientSecret">;
};

const canonicalResource = (resource: string): string => new URL(resource).toString();

const hasSameResource = (left: StoredRecord, right: Pick<StoredRecord, "resource">): boolean =>
  canonicalResource(left.resource) === canonicalResource(right.resource);

const registrationFor = ({ clientId, clientSecret }: ProjectMcpOAuthServer) => ({
  ...(clientId === undefined ? {} : { clientId }),
  ...(clientSecret === undefined ? {} : { clientSecret }),
});

const matchesClientRegistration = (
  client: OAuthClientInformationMixed,
  server: ProjectMcpOAuthServer,
) =>
  server.clientId === undefined ||
  (client.client_id === server.clientId && client.client_secret === server.clientSecret);

const matchesServer = (record: StoredRecord, server: ProjectMcpOAuthServer): boolean => {
  const registration = record.registration;
  // Older grants did not record whether their client was automatic or explicit.
  // Require reconnect instead of assigning those credentials to a guessed owner.
  if (registration === undefined) return false;
  return (
    hasSameResource(record, server) &&
    registration.clientId === server.clientId &&
    registration.clientSecret === server.clientSecret &&
    (record.client === undefined || matchesClientRegistration(record.client, server)) &&
    (record.issuer === undefined ||
      server.authorizationServers === undefined ||
      server.authorizationServers.includes(record.issuer))
  );
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
    const pendingStates = new Map<string, McpServerId>();
    const generations = new Map<string, string | number>();
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
      const persisted = await Effect.runPromise(current(id));
      if (persisted) {
        return {
          serverId: id,
          resource: persisted.resource,
          ...(persisted.redirectUrl === undefined ? {} : { redirectUrl: persisted.redirectUrl }),
          ...persisted.registration,
        };
      }
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
    const currentUnlocked = (id: McpServerId, server?: ProjectMcpOAuthServer) =>
      recordsFor(id).pipe(
        Effect.map(
          (records) =>
            (server === undefined
              ? records
              : records.filter(({ record }) => matchesServer(record, server))
            ).at(-1)?.record,
        ),
      );
    const current = (id: McpServerId, server?: ProjectMcpOAuthServer) =>
      mutex.withPermits(1)(currentUnlocked(id, server));
    const save = (id: McpServerId, record: StoredRecord) =>
      Effect.gen(function* () {
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const replacementId = yield* secrets.createAuxiliarySecret(id, JSON.stringify(record));
        for (const old of yield* recordsFor(id)) {
          if (old.id !== replacementId && hasSameResource(old.record, record)) {
            yield* secrets.removeAuxiliarySecret(id, old.id);
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) => new ProjectMcpOAuthError({ operation: "write credentials", cause }),
        ),
      );
    const nextGeneration = (id: McpServerId) => {
      const next = random();
      generations.set(id, next);
      return next;
    };
    const updateIfCurrent = (
      id: McpServerId,
      server: ProjectMcpOAuthServer,
      generation: string | number,
      update: (record: StoredRecord) => StoredRecord | undefined,
    ) =>
      mutex.withPermits(1)(
        recordsFor(id).pipe(
          Effect.flatMap((records) => {
            const active = records.findLast(({ record }) => matchesServer(record, server))?.record;
            const isCurrent =
              active === undefined
                ? generation === 0 &&
                  !generations.has(id) &&
                  !records.some(({ record }) => hasSameResource(record, server))
                : (active.generation ?? 0) === generation;
            if (!isCurrent) return Effect.succeed(false);
            const record = update(
              active ?? { kind: RECORD_NAME, serverId: id, resource: server.resource },
            );
            return record === undefined
              ? Effect.succeed(false)
              : save(id, {
                  ...record,
                  generation: record.generation ?? generation,
                  registration: registrationFor(server),
                }).pipe(Effect.as(true));
          }),
        ),
      );

    const providerFor = (
      id: McpServerId,
      supplied?: ProjectMcpOAuthServer,
      authorization?: {
        readonly generation: string | number;
        readonly state: string;
        readonly onSaved: (generation: string) => void;
      },
    ) =>
      Effect.tryPromise({
        try: async () => {
          const server = await serverFor(id, supplied);
          const initial = await Effect.runPromise(current(id, server));
          const generation =
            authorization?.generation ?? initial?.generation ?? generations.get(id) ?? 0;
          const readRecord = async () => {
            const record = await Effect.runPromise(current(id, server));
            return (record?.generation ?? 0) === generation ? record : undefined;
          };
          const provider: OAuthClientProvider = {
            // SDK 2.0's default token helper treats an empty secret as absent.
            ...(server.clientSecret === "" && server.clientId !== undefined
              ? ({
                  addClientAuthentication: (headers, params, _url, metadata) => {
                    const clientId = server.clientId!;
                    const method = selectClientAuthMethod(
                      { client_id: clientId, client_secret: "" },
                      metadata?.token_endpoint_auth_methods_supported ?? [],
                    );
                    if (method === "client_secret_basic") {
                      headers.set("Authorization", `Basic ${btoa(`${clientId}:`)}`);
                    } else {
                      params.set("client_id", clientId);
                      if (method === "client_secret_post") params.set("client_secret", "");
                    }
                  },
                } satisfies Pick<OAuthClientProvider, "addClientAuthentication">)
              : {}),
            get redirectUrl() {
              return server.redirectUrl ?? initial?.redirectUrl ?? defaultRedirect;
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
                    token_endpoint_auth_method:
                      server.clientSecret !== undefined ? "client_secret_post" : "none",
                  } satisfies OAuthClientMetadata),
              });
            },
            ...(server.clientMetadataUrl === undefined
              ? {}
              : { clientMetadataUrl: server.clientMetadataUrl }),
            clientInformation: async (ctx) => {
              const record = await readRecord();
              if (
                record !== undefined &&
                record.client === undefined &&
                server.clientId !== undefined
              ) {
                return {
                  client_id: server.clientId,
                  ...(server.clientSecret === undefined
                    ? {}
                    : { client_secret: server.clientSecret }),
                  redirect_uris: [String(provider.redirectUrl)],
                };
              }
              return record?.client && (!ctx?.issuer || record.client.issuer === ctx.issuer)
                ? record.client
                : undefined;
            },
            tokens: async (ctx) => {
              const record = await readRecord();
              if (!record?.tokens || (ctx?.issuer && record.tokens.issuer !== ctx.issuer))
                return undefined;
              if (
                record.tokens.expires_in === undefined ||
                (record.tokensIssuedAt ??
                  (record.state === undefined ? record.expiresAt : undefined) ??
                  0) +
                  record.tokens.expires_in * 1000 >
                  now()
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
                  ...(provider.addClientAuthentication === undefined
                    ? {}
                    : { addClientAuthentication: provider.addClientAuthentication }),
                  refreshToken: record.tokens.refresh_token,
                  resource: new URL(server.resource),
                  fetchFn,
                });
                const next = { ...refreshed, issuer: record.issuer };
                const saved = await Effect.runPromise(
                  updateIfCurrent(id, server, generation, (active) => {
                    if (
                      active.tokens?.access_token !== record.tokens?.access_token ||
                      active.tokens?.refresh_token !== record.tokens?.refresh_token
                    )
                      return undefined;
                    return { ...active, tokens: next, tokensIssuedAt: now() };
                  }),
                );
                return saved ? next : undefined;
              } catch {
                return undefined;
              }
            },
            saveClientInformation: async (client, ctx) => {
              await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => {
                  if (!matchesClientRegistration(client, server))
                    throw new Error("OAuth client registration mismatch");
                  return {
                    ...record,
                    client: ctx?.issuer ? { ...client, issuer: ctx.issuer } : client,
                  };
                }),
              );
            },
            saveTokens: async (tokens, ctx) => {
              const completedGeneration = authorization === undefined ? undefined : random();
              const saved = await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => {
                  if (authorization !== undefined && record.state !== authorization.state)
                    return undefined;
                  if (record.issuer && ctx?.issuer && record.issuer !== ctx.issuer)
                    throw new Error("issuer mismatch");
                  const updated = {
                    ...record,
                    ...((ctx?.issuer ?? record.issuer)
                      ? { issuer: ctx?.issuer ?? record.issuer }
                      : {}),
                    tokens,
                    tokensIssuedAt: now(),
                  };
                  if (completedGeneration === undefined) return updated;
                  const {
                    state: _state,
                    codeVerifier: _codeVerifier,
                    authorizationUrl: _authorizationUrl,
                    scope: _scope,
                    expiresAt: _expiresAt,
                    ...completed
                  } = updated;
                  return { ...completed, generation: completedGeneration };
                }),
              );
              if (saved && completedGeneration !== undefined)
                authorization?.onSaved(completedGeneration);
            },
            redirectToAuthorization: async (authorizationUrl) => {
              const record = await readRecord();
              if (record === undefined) throw new Error("OAuth authorization state is unavailable");
              const state = authorizationUrl.searchParams.get("state");
              if (!state) throw new Error("OAuth authorization URL did not include state");
              const scope = authorizationUrl.searchParams.get("scope") ?? undefined;
              const saved = await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => ({
                  ...record,
                  state,
                  redirectUrl: String(provider.redirectUrl),
                  expiresAt: now() + STATE_TTL_MS,
                  authorizationUrl: authorizationUrl.toString(),
                  ...(scope === undefined ? {} : { scope }),
                })),
              );
              if (!saved) throw new Error("OAuth authorization state is stale");
            },
            saveCodeVerifier: async (codeVerifier) => {
              await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => ({
                  ...record,
                  codeVerifier,
                })),
              );
            },
            codeVerifier: async () => {
              const verifier = (await readRecord())?.codeVerifier;
              if (!verifier) throw new Error("missing PKCE verifier");
              return verifier;
            },
            state: () => random(),
            saveDiscoveryState: async (discovery) => {
              const saved = await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => ({
                  ...record,
                  discovery,
                  ...(discovery.authorizationServerMetadata?.issuer
                    ? { issuer: discovery.authorizationServerMetadata.issuer }
                    : {}),
                })),
              );
              if (!saved) throw new Error("OAuth authorization requires reconnect.");
            },
            discoveryState: async () => (await readRecord())?.discovery,
            validateResourceURL: async (serverUrl, resource) => {
              if (!resource || new URL(resource).toString() !== new URL(serverUrl).toString())
                throw new Error("resource mismatch");
              return new URL(resource);
            },
            invalidateCredentials: async (scope) => {
              await Effect.runPromise(
                updateIfCurrent(id, server, generation, (record) => {
                  if (scope === "all")
                    return {
                      kind: RECORD_NAME,
                      serverId: id,
                      resource: record.resource,
                      generation,
                    };
                  if (scope === "tokens") {
                    const { tokens: _tokens, tokensIssuedAt: _issued, ...retained } = record;
                    return retained;
                  }
                  if (scope === "verifier") {
                    const { codeVerifier: _verifier, ...retained } = record;
                    return retained;
                  }
                  if (scope === "discovery") {
                    const { discovery: _discovery, ...retained } = record;
                    return retained;
                  }
                  const {
                    client: _client,
                    tokens: _tokens,
                    tokensIssuedAt: _issued,
                    state: _state,
                    codeVerifier: _verifier,
                    authorizationUrl: _url,
                    scope: _scope,
                    expiresAt: _expiry,
                    ...retained
                  } = record;
                  return retained;
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
        const generation = yield* mutex.withPermits(1)(
          Effect.sync(() => nextGeneration(input.serverId)),
        );
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
              ...(server.clientSecret !== undefined ? { client_secret: server.clientSecret } : {}),
              redirect_uris: [String(provider.redirectUrl)],
            }
          : providerServer.clientMetadataUrl &&
              info.authorizationServerMetadata?.client_id_metadata_document_supported === true
            ? {
                client_id: providerServer.clientMetadataUrl,
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
        yield* mutex.withPermits(1)(
          Effect.suspend(() => {
            if (generations.get(input.serverId) !== generation) {
              return Effect.fail(
                new ProjectMcpOAuthError({
                  operation: "begin",
                  cause: new Error("OAuth authorization was superseded."),
                }),
              );
            }
            return save(input.serverId, {
              kind: RECORD_NAME,
              serverId: input.serverId,
              resource: server.resource,
              redirectUrl: String(provider.redirectUrl),
              registration: registrationFor(server),
              issuer,
              state: authorizationState,
              expiresAt: now() + STATE_TTL_MS,
              codeVerifier: started.codeVerifier,
              client: { ...client, issuer },
              discovery: info,
              generation,
              authorizationUrl: started.authorizationUrl.toString(),
              ...(started.authorizationUrl.searchParams.get("scope") === null
                ? {}
                : { scope: started.authorizationUrl.searchParams.get("scope")! }),
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => pendingStates.set(authorizationState, input.serverId)),
              ),
            );
          }),
        );
        return {
          authorizationUrl: started.authorizationUrl.toString(),
          // @effect-diagnostics-next-line globalDateInEffect:off
          expiresAt: new Date(now() + STATE_TTL_MS).toISOString(),
        };
      }).pipe(
        Effect.catch((cause) =>
          isProjectMcpOAuthError(cause)
            ? Effect.fail(cause)
            : Effect.fail(new ProjectMcpOAuthError({ operation: "begin", cause })),
        ),
      );

    const continuePending: ProjectMcpOAuthShape["continuePending"] = (id, server) =>
      current(id, server).pipe(
        Effect.flatMap((record) => {
          if (
            record?.authorizationUrl === undefined ||
            record.registration === undefined ||
            record.state === undefined ||
            record.expiresAt === undefined ||
            record.expiresAt < now()
          ) {
            return Effect.fail(
              new ProjectMcpOAuthError({
                operation: "continue authorization",
                cause: new Error("No pending OAuth authorization is available."),
              }),
            );
          }
          return Effect.succeed({
            authorizationUrl: record.authorizationUrl,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(record.expiresAt)),
          });
        }),
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
        if (
          !found ||
          !record ||
          record.registration === undefined ||
          (record.expiresAt ?? 0) < now()
        )
          return oauthErrorResponse("Invalid OAuth state.");
        if (url.searchParams.get("iss") !== null && url.searchParams.get("iss") !== record.issuer)
          return oauthErrorResponse("Invalid OAuth issuer.");
        const callbackServer = yield* Effect.tryPromise({
          try: async () => {
            const configured = await serverFor(found.serverId).catch(() => undefined);
            return {
              serverId: found.serverId,
              resource: record.resource,
              ...(configured?.authorizationServers === undefined
                ? {}
                : { authorizationServers: configured.authorizationServers }),
              ...(record.redirectUrl === undefined ? {} : { redirectUrl: record.redirectUrl }),
              ...record.registration,
            } satisfies ProjectMcpOAuthServer;
          },
          catch: (cause) => new ProjectMcpOAuthError({ operation: "resolve callback", cause }),
        });
        let completedGeneration: string | undefined;
        const provider = yield* providerFor(found.serverId, callbackServer, {
          generation: record.generation ?? 0,
          state,
          onSaved: (generation) => {
            completedGeneration = generation;
          },
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
        if (
          completedGeneration === undefined ||
          !after ||
          after.generation !== completedGeneration
        ) {
          return oauthErrorResponse("OAuth authorization was superseded.");
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

    const status: ProjectMcpOAuthShape["status"] = (id, server) =>
      current(id, server).pipe(
        Effect.map((record) => {
          if (record?.registration === undefined) return "not-connected" as const;
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
      continuePending,
      completeCallback,
      setAuthorizedHandler: (handler) => {
        authorizedHandler = handler;
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
