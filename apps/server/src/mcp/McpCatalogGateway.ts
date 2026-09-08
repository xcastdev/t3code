import {
  McpCatalogSessionId,
  McpServerId,
  type ProviderInstanceId,
  type ResolvedMcpCatalogEntry,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectMcpProxyRegistry from "./ProjectMcpProxyRegistry.ts";
import type * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

/** The stable name exposed to a provider for one upstream MCP item. */
export const namespaceName = (logicalId: McpServerId, upstreamName: string): string =>
  `mcp_${String(logicalId).replaceAll("-", "")}__${upstreamName}`;

/** The stable URI exposed to a provider for one upstream resource. */
export const namespaceResourceUri = (logicalId: McpServerId, upstreamUri: string): string =>
  `t3-mcp://${String(logicalId)}/${Buffer.from(upstreamUri).toString("base64url")}`;

export type McpCatalogGatewayCollisionKind = "name" | "resource-uri";

export interface McpCatalogGatewayCollision {
  readonly kind: McpCatalogGatewayCollisionKind;
  readonly key: string;
  readonly logicalServerIds: ReadonlyArray<McpServerId>;
}

export class McpCatalogGatewayCollisionError extends Error {
  readonly _tag = "McpCatalogGatewayCollisionError";
  readonly collisions: ReadonlyArray<McpCatalogGatewayCollision>;

  constructor(collisions: ReadonlyArray<McpCatalogGatewayCollision>) {
    super(`MCP catalog gateway has ${collisions.length} collision(s).`);
    this.name = "McpCatalogGatewayCollisionError";
    this.collisions = collisions;
  }
}

export interface McpCatalogGatewayEntry extends ResolvedMcpCatalogEntry {
  readonly exposedName: string;
  readonly resourceUriPrefix: string;
}

/**
 * Turn a resolved catalog into the provider-facing identity map. Keeping this
 * pure makes collisions fail before a proxy session is replaced.
 */
export const aggregateCatalog = (
  entries: ReadonlyArray<ResolvedMcpCatalogEntry>,
): ReadonlyArray<McpCatalogGatewayEntry> => {
  const names = new Map<string, McpServerId[]>();
  const result = entries.map((entry) => {
    const exposedName = namespaceName(entry.logicalServerId, entry.name);
    names.set(exposedName, [...(names.get(exposedName) ?? []), entry.logicalServerId]);
    return {
      ...entry,
      exposedName,
      resourceUriPrefix: `t3-mcp://${String(entry.logicalServerId)}/`,
    };
  });
  const collisions = [...names.entries()]
    .filter(([, logicalServerIds]) => logicalServerIds.length > 1)
    .map(([key, logicalServerIds]) => ({
      kind: "name" as const,
      key,
      logicalServerIds,
    }));
  if (collisions.length > 0) throw new McpCatalogGatewayCollisionError(collisions);
  return result;
};

/** Rewrite an upstream item while retaining the owning catalog entry. */
export const namespaceItemName = (
  entry: Pick<McpCatalogGatewayEntry, "logicalServerId">,
  upstreamName: string,
): string => namespaceName(entry.logicalServerId, upstreamName);

/** Rewrite an upstream resource reference into the gateway URI namespace. */
export const namespaceItemResourceUri = (
  entry: Pick<McpCatalogGatewayEntry, "logicalServerId">,
  upstreamUri: string,
): string => namespaceResourceUri(entry.logicalServerId, upstreamUri);

export const aggregateResourceUris = (
  resources: ReadonlyArray<{
    readonly logicalServerId: McpServerId;
    readonly upstreamUri: string;
  }>,
): ReadonlyMap<string, { readonly logicalServerId: McpServerId; readonly upstreamUri: string }> => {
  const byUri = new Map<
    string,
    { readonly logicalServerId: McpServerId; readonly upstreamUri: string }
  >();
  const collisions = new Map<string, McpServerId[]>();
  for (const resource of resources) {
    const exposedUri = namespaceResourceUri(resource.logicalServerId, resource.upstreamUri);
    const previous = byUri.get(exposedUri);
    if (previous !== undefined) {
      collisions.set(exposedUri, [
        ...(collisions.get(exposedUri) ?? [previous.logicalServerId]),
        resource.logicalServerId,
      ]);
    } else {
      byUri.set(exposedUri, resource);
    }
  }
  if (collisions.size > 0) {
    throw new McpCatalogGatewayCollisionError(
      [...collisions].map(([key, logicalServerIds]) => ({
        kind: "resource-uri" as const,
        key,
        logicalServerIds,
      })),
    );
  }
  return byUri;
};

export interface RegisterCatalogSessionInput {
  readonly catalogSessionId: McpCatalogSessionId;
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly revision: number;
  readonly entries: ReadonlyArray<ResolvedMcpCatalogEntry>;
  readonly resolveSecret?: (serverId: McpServerId, credentialId: string) => string | undefined;
  readonly oauthStateLeases?: ReadonlyMap<
    McpServerId,
    ProjectMcpSecretStore.ProjectMcpOAuthStateLease
  >;
}

export interface McpCatalogGatewaySession {
  readonly catalogSessionId: McpCatalogSessionId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly revision: number;
  readonly entries: ReadonlyArray<McpCatalogGatewayEntry>;
  readonly endpoints: ReadonlyArray<ProjectMcpProxyRegistry.ProjectMcpProxyEndpoint>;
}

export interface McpCatalogGatewayShape {
  readonly registerCatalogSession: (
    input: RegisterCatalogSessionInput,
  ) => Effect.Effect<McpCatalogGatewaySession, McpCatalogGatewayCollisionError>;
  readonly applyCatalogRevision: (
    input: RegisterCatalogSessionInput,
  ) => Effect.Effect<McpCatalogGatewaySession, McpCatalogGatewayCollisionError>;
  readonly resolveCatalogSession: (
    catalogSessionId: McpCatalogSessionId,
  ) => Effect.Effect<McpCatalogGatewaySession | undefined>;
  readonly revokeRuntime: (providerSessionId: string) => Effect.Effect<void>;
  readonly disposeCatalogSession: (catalogSessionId: McpCatalogSessionId) => Effect.Effect<void>;
}

export class McpCatalogGateway extends Context.Service<McpCatalogGateway, McpCatalogGatewayShape>()(
  "t3/mcp/McpCatalogGateway",
) {}

const make = Effect.gen(function* () {
  const proxy = yield* ProjectMcpProxyRegistry.ProjectMcpProxyRegistry;
  const sessions = yield* Ref.make<ReadonlyMap<string, McpCatalogGatewaySession>>(new Map());

  const register = (input: RegisterCatalogSessionInput) =>
    Effect.gen(function* () {
      const entries = yield* Effect.try({
        try: () => aggregateCatalog(input.entries),
        catch: (error) =>
          error instanceof McpCatalogGatewayCollisionError
            ? error
            : new McpCatalogGatewayCollisionError([
                {
                  kind: "name",
                  key: "unknown",
                  logicalServerIds: [],
                },
              ]),
      });
      const endpoints = yield* proxy.registerSession({
        providerSessionId: input.providerSessionId,
        threadId: input.threadId,
        servers: entries.map((entry) => ({
          id: entry.logicalServerId,
          name: entry.exposedName,
          transport: entry.transport,
        })),
        ...(input.resolveSecret === undefined ? {} : { resolveSecret: input.resolveSecret }),
        ...(input.oauthStateLeases === undefined
          ? {}
          : { oauthStateLeases: input.oauthStateLeases }),
      });
      const session = Object.freeze({
        catalogSessionId: input.catalogSessionId,
        providerSessionId: input.providerSessionId,
        providerInstanceId: input.providerInstanceId,
        revision: input.revision,
        entries,
        endpoints,
      });
      yield* Ref.update(sessions, (current) =>
        new Map(current).set(String(input.catalogSessionId), session),
      );
      return session;
    });

  const revokeRuntime: McpCatalogGatewayShape["revokeRuntime"] = (providerSessionId) =>
    proxy
      .revokeProviderSession(providerSessionId)
      .pipe(
        Effect.andThen(
          Ref.update(
            sessions,
            (current) =>
              new Map(
                [...current].filter(
                  ([, session]) => session.providerSessionId !== providerSessionId,
                ),
              ),
          ),
        ),
      );

  const disposeCatalogSession: McpCatalogGatewayShape["disposeCatalogSession"] = (
    catalogSessionId,
  ) =>
    Ref.modify(sessions, (current) => {
      const session = current.get(String(catalogSessionId));
      return [
        session,
        new Map([...current].filter(([key]) => key !== String(catalogSessionId))),
      ] as const;
    }).pipe(
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.void
          : proxy.revokeProviderSession(session.providerSessionId),
      ),
    );

  return McpCatalogGateway.of({
    registerCatalogSession: register,
    applyCatalogRevision: register,
    resolveCatalogSession: (catalogSessionId) =>
      Ref.get(sessions).pipe(Effect.map((current) => current.get(String(catalogSessionId)))),
    revokeRuntime,
    disposeCatalogSession,
  });
});

export const layer = Layer.effect(McpCatalogGateway, make);

export const __testing = { make };
